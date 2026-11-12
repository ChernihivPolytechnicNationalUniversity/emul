import { readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"
import { openedFile, projectFile, readProjectFile } from "@/project/project-store"
import { builder, connect, connections, legacyOf, rewire } from "@/schematic/builder"
import { examples, lab1Board } from "@/schematic/examples"
import { GRID, objectIndex, objectPins, type Point } from "@/schematic/geometry"
import { getDef, withLibrary } from "@/schematic/registry"
import type { HdlNetlist } from "emul-shared/hdl"
import counter from "./hdl/counter.json"
import { legacyUpgraded, SCHEMATIC_VERSION, upgraded, versionOf } from "@/schematic/migrate"
import { wiresAsSegments, wirePins } from "@/schematic/migrate-wires"
import { laidAgain } from "@/schematic/freeze"
import { Conductors } from "@/schematic/wires/conductors"
import type { HdlModule, LegacySchematic, LegacyWire, PlacedObject, Schematic } from "@/schematic/types"
import { junctionsOf, wireNets } from "@/schematic/wires/graph"
import { runsOf } from "@/schematic/circuit"
import { bodiesOf, closedBodies, crossedBody, staysThrough } from "@/schematic/body-crossing"
import { buildNetlist, GROUND, type Netlist } from "@/sim/netlist"
import { SimLoop } from "@/sim/loop"
import { legacyCircuit } from "../lib/legacy-circuit"
import { joiningContactsOfNcPads, legacyPinPartition, netsJoinedThroughNcPads, pinPartition } from "../lib/pin-partition"
import { emulFiles, partitionDocuments, readFixture } from "../lib/partition-documents"
import { normalFormViolations } from "../lib/wire-reference"

const c = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const ROOT = join(import.meta.dirname, "..", "data")
const documents = await partitionDocuments()

function netlistShape(net: Netlist, hubs: ReadonlySet<string> = new Set()): string[] {
  const members = new Map<number, string[]>()
  for (const [key, node] of net.pinNet) if (!hubs.has(key.slice(0, key.indexOf(":")))) members.set(node, [...(members.get(node) ?? []), key])
  const name = (key: string) => {
    const node = net.pinNet.get(key)
    if (node === undefined) return `${key}?`
    if (node === GROUND) return "ground"
    return [...(members.get(node) ?? [])].sort().join("+")
  }
  return net.elements.map((el) => `${el.id} ${el.kind} ${el.keys.map(name).join(" | ")}`).sort()
}

async function legacyFile(path: string): Promise<LegacySchematic> {
  const { Zstd } = await import("@hpcc-js/wasm-zstd")
  const raw = new Uint8Array(readFileSync(join(ROOT, path)))
  const bytes = raw[0] === 0x28 ? (await Zstd.load()).decompress(raw) : raw
  return (JSON.parse(new TextDecoder().decode(bytes)) as { schematic: LegacySchematic }).schematic
}

describe("every example, case and saved file keeps its circuit through the freeze (design.md §10 items 2–4)", () => {
  it("each opens in normal form with exactly the pin partition phase 0 froze, with no register of exceptions", () => {
    for (const { name, doc } of documents) {
      const fixture = readFixture(name)
      if (!fixture) continue
      expect.soft(normalFormViolations(doc.wires, wirePins(doc.objects)), `${name}: normal form`).toEqual([])
      expect.soft(pinPartition(doc), `${name}: the frozen circuit, NC pads' contacts joined (design.md §1.2)`).toEqual(joiningContactsOfNcPads(fixture.nets, doc.objects))
      expect.soft(netsJoinedThroughNcPads(fixture.nets, doc.objects), `${name}: no two of the frozen nets joined through a pad marked not connected (findings 3.L2)`).toEqual([])
      expect.soft(doc.objects.some((o) => o.def === "junction"), `${name}: no junction parts left`).toBe(false)
    }
  })

  it.each(examples.map((e) => [e.id, e] as const))("%s hands the solver the netlist its old wires did", (_, example) => {
    const built = example.build(GRID)
    const doc: Schematic = { ...built }
    const legacy = legacyOf(built)
    const hubs = new Set(legacy.objects.filter((o) => o.def === "junction").map((o) => o.id))
    expect.soft(netlistShape(buildNetlist(doc)), `${example.id}: the solver's elements on the same nets`).toEqual(netlistShape(buildNetlist(legacyCircuit(legacy)), hubs))
  })

  it("the power supply, the system exam, the bridge and the op-amp amplifier simulate to the same readings, reading by reading", () => {
    for (const id of ["power-supply", "system-exam", "bridge", "opamp-amplifier"]) {
      const built = examples.find((e) => e.id === id)!.build(GRID)
      const run = (input: Parameters<SimLoop["setDoc"]>[0]) => {
        const loop = new SimLoop()
        loop.setDoc(input)
        loop.setParts(built.parts)
        loop.setRunning(true)
        let clock = 0
        loop.advance(clock)
        for (let i = 0; i < 40; i++) loop.advance((clock += 25))
        return loop.snapshot()!
      }
      const a = run(legacyCircuit(legacyOf(built)))
      const b = run({ ...built })
      expect.soft(a.readings.filter((r) => Math.abs(r.voltage) > 1e-3).length, `${id}: readings to compare`).toBeGreaterThan(3)
      expect.soft(b.readings.map((r) => `${r.object}:${r.element}`), `${id}: the same readings in the same order`).toEqual(a.readings.map((r) => `${r.object}:${r.element}`))
      a.readings.forEach((r, i) => {
        const same = b.readings[i]
        expect.soft(same?.voltage ?? NaN, `${id} ${r.object} element ${r.element}, reading ${i}: voltage`).toBeNear(r.voltage, Math.max(1e-9, Math.abs(r.voltage) * 1e-9))
        expect.soft(same?.current ?? NaN, `${id} ${r.object} element ${r.element}, reading ${i}: current`).toBeNear(r.current, Math.max(1e-12, Math.abs(r.current) * 1e-9))
      })
    }
  })

  it("only the documents with a wire laid again say so, each naming that wire, and keep their circuits; phase 0's register of five is gone now that every document agrees (design.md §10 item 4)", async () => {
    const relaid: string[] = []
    for (const e of examples) {
      const { notes } = wiresAsSegments(legacyOf(e.build(GRID)))
      expect.soft(notes.every((n) => n.includes("laid again")), `${e.id}: ${JSON.stringify(notes)}`).toBe(true)
      if (notes.length) relaid.push(e.id)
    }
    for (const file of emulFiles()) {
      const read = await readProjectFile(new Blob([readFileSync(file)]))
      if (read?.notes.some((n) => / ran over another net's wire or pin where it was drawn; it is laid again /.test(n))) relaid.push(relative(ROOT, file).split(sep).join("--"))
    }
    expect.soft(relaid, "the documents whose freeze lays a wire again, from the files").toEqual([
      "before-the-segments--bend-on-foreign-wire.emul",
      "before-the-segments--board-open746-bend-on-p3-7.emul",
      "before-the-segments--corridor-different-nets.emul",
      "before-the-segments--nc-pads-bridging-two-nets.emul",
      "before-the-segments--off-grid-near-contact.emul",
      "before-the-segments--random-0237.emul",
      "before-the-segments--user-bend-on-foreign-pin.emul",
      "emul-1.42.0--resistor-bridge.emul",
    ])
    for (const name of relaid) {
      const doc = documents.find((d) => d.name === name)?.doc
      const fixture = readFixture(name)
      expect.soft(doc && fixture && pinPartition(doc), `${name}: the circuit phase 0 froze`).toEqual(doc && fixture && joiningContactsOfNcPads(fixture.nets, doc.objects))
    }
  })
})

describe("a wire at a diagonal pin (design.md §13.14's slide of the old router's 45° stubs, superseded by §13.22: an old file freezes through the phase 6 router)", () => {
  const frozenOf = (doc: LegacySchematic) => wiresAsSegments(doc).routes
  const between = (doc: LegacySchematic, a: string, b: string): LegacyWire => {
    const ref = (r: string) => {
      const [def, cell] = r.split("@")
      const [x, y] = (cell ?? "").split(",").map(Number)
      return doc.objects.find((o) => (cell ? o.def === def && o.x === x * GRID && o.y === y * GRID : o.props?.ref === r))!.id
    }
    const [ao, ap] = a.split(".")
    const [bo, bp] = b.split(".")
    return doc.wires.find((w) => (w.from.object === ref(ao) && w.from.pin === ap && w.to.object === ref(bo) && w.to.pin === bp) || (w.to.object === ref(ao) && w.to.pin === ap && w.from.object === ref(bo) && w.from.pin === bp))!
  }
  const cells = (pts: readonly Point[] | undefined) => (pts ?? []).map((p) => [p.x / GRID, p.y / GRID])

  it("the power supply frozen through the router reads as a schematic: the four corner wires exactly, the diamond's corners exact contacts, dots only at those corners and the T's on the rails, no wire through a body, no run past its ends (design.md §13.22; plan.md acceptance 5)", () => {
    const legacy = legacyOf(examples.find((e) => e.id === "power-supply")!.build(GRID))
    const { doc, routes } = wiresAsSegments(legacy)
    expect.soft(cells(routes.get(between(legacy, "D1.2", "C1.1").id)), "the top corner, from C1's + pin along the rail and down onto the corner").toEqual([[27, 2], [17, 2], [17, 3]])
    expect.soft(cells(routes.get(between(legacy, "T1.S1", "D1.1").id)), "the left corner, up a row and in from the left").toEqual([[14, 6], [14, 5], [8, 5]])
    expect.soft(cells(routes.get(between(legacy, "T1.S2", "D2.1").id)), "the right corner, through the bends the example draws under the bridge").toEqual([[20, 6], [24, 6], [24, 16], [8, 16], [8, 7]])
    expect.soft(cells(routes.get(between(legacy, "D3.1", "ground@16,13.GND").id)), "the bottom corner, straight down to ground").toEqual([[17, 9], [17, 13]])
    for (const pts of routes.values()) for (let i = 1; i < pts.length; i++) expect.soft(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y, `orthogonal: ${JSON.stringify(cells(pts))}`).toBe(true)
    const pinAt = (ref: string, pin: string) => objectPins(doc.objects.find((o) => o.props?.ref === ref)!, GRID).find((p) => p.pin.id === pin)!.point
    const corners = [["D1", "1", "D3", "2"], ["D1", "2", "D2", "2"], ["D2", "1", "D4", "2"], ["D3", "1", "D4", "1"]] as const
    expect.soft(corners.map(([a, pa, b, pb]) => [cells([pinAt(a, pa)]), cells([pinAt(b, pb)])]), "the diamond's four corners: two diode pins on one point each").toEqual([[[[14, 6]], [[14, 6]]], [[[17, 3]], [[17, 3]]], [[[20, 6]], [[20, 6]]], [[[17, 9]], [[17, 9]]]])
    const dots = junctionsOf(wireNets(doc.wires, wirePins(doc.objects))).map((p) => `${p.x / GRID},${p.y / GRID}`).sort()
    expect.soft(dots, "dots at the four corners, where a wire meets two diode pins (design.md §3.2: three conductors), and at the T's on the + rail (C1 +, R1's top) and the − rail (C1 −, R1's bottom, the ground pin both − wires reach), nowhere else").toEqual(["14,6", "17,13", "17,3", "17,9", "20,6", "27,2", "27,6", "31,2", "31,6"])
    expect.soft(doc.wires.filter((s) => crossedBody(s, bodiesOf(doc.objects))).map((s) => cells([s.a, s.b])), "no wire through a body").toEqual([])
    const underTheBridge = c(24, 16)
    const pastItsEnds = runsOf(doc.wires, wirePins(doc.objects))
      .filter((r) => !r.points.some((p) => p.x === underTheBridge.x && p.y === underTheBridge.y))
      .filter((r) => {
        const [a, b] = [r.points[0], r.points[r.points.length - 1]]
        return r.points.some((p) => p.x < Math.min(a.x, b.x) || p.x > Math.max(a.x, b.x) || p.y < Math.min(a.y, b.y) || p.y > Math.max(a.y, b.y))
      })
    expect.soft(pastItsEnds.map((r) => cells(r.points)), "no run but the one through the example's own bends goes past either of its ends").toEqual([])
  })

  it("the resistor bridge: the loops round its side corners become the one-cell wires to R3", () => {
    const doc = legacyOf(examples.find((e) => e.id === "bridge")!.build(GRID))
    const routes = frozenOf(doc)
    expect.soft(cells(routes.get(between(doc, "R1.1", "R3.1").id)), "left").toEqual([[14, 6], [15, 6]])
    expect.soft(cells(routes.get(between(doc, "R3.2", "R7.2").id)), "right").toEqual([[19, 6], [20, 6]])
  })

  it("the two 1.42.0 files freeze to the corners their examples do", async () => {
    for (const [file, example] of [
      ["emul-1.42.0/power-supply.emul", "power-supply"],
      ["emul-1.42.0/resistor-bridge.emul", "bridge"],
    ] as const) {
      const read = await readProjectFile(new Blob([readFileSync(join(ROOT, file))]))
      const mine = { ...examples.find((e) => e.id === example)!.build(GRID) }
      const corner = (d: Schematic) =>
        junctionsOf(wireNets(d.wires, wirePins(d.objects)))
          .map((p) => `${p.x},${p.y}`)
          .sort()
      expect.soft(corner(read!.doc), `${file}: the same dots`).toEqual(corner(mine))
    }
  })

  const diagonalBeside = (dx: number, dy: number, rotation: 45 | 135 | 225 | 315 = 45) => {
    const r1: PlacedObject = { id: "R1", def: "resistor", x: 0, y: 0, rotation, props: { ref: "R1" } }
    const pin = objectPins(r1, GRID).find((p) => p.pin.id === "2")!
    const r2: PlacedObject = { id: "R2", def: "resistor", x: pin.point.x + dx * GRID, y: pin.point.y + dy * GRID, props: { ref: "R2" } }
    return { r1, r2, pin: pin.point }
  }

  it("a slide or a step that would touch another net is never kept: the wire goes the next clean way, and the circuit stays", () => {
    const { r1, r2 } = diagonalBeside(5, 3)
    const doc: LegacySchematic = { objects: [r1, r2], wires: [{ id: "w", from: { object: "R1", pin: "2" }, to: { object: "R2", pin: "1" } }], parts: {} }
    const free = wiresAsSegments(doc)
    expect.soft(pinPartition(free.doc), "joined").toEqual([["R1.2", "R2.1"]])
    const route = free.routes.get("w")!
    for (let i = 1; i < route.length; i++) expect.soft(route[i].x === route[i - 1].x || route[i].y === route[i - 1].y, "orthogonal").toBe(true)
    const blocker: PlacedObject = { id: "G", def: "ground", x: route[1].x - GRID, y: route[1].y, props: { ref: "G" } }
    const fenced = wiresAsSegments({ ...doc, objects: [...doc.objects, blocker] })
    expect.soft(legacyPinPartition({ ...doc, objects: [...doc.objects, blocker] }, GRID), "before: the ground on nothing").toEqual([["R1.2", "R2.1"]])
    expect.soft(pinPartition(fenced.doc), "after: still on nothing").toEqual([["R1.2", "R2.1"]])
  })
})

describe("wires that ran over another net are laid again (design.md §10 item 4)", () => {
  const two = (bendA: [number, number][], bendB: [number, number][]): LegacySchematic => ({
    objects: [
      { id: "A1", def: "resistor", x: 0, y: 0, props: { ref: "A1" } },
      { id: "A2", def: "resistor", x: c(20, 0).x, y: 0, props: { ref: "A2" } },
      { id: "B1", def: "resistor", x: 0, y: c(0, 6).y, props: { ref: "B1" } },
      { id: "B2", def: "resistor", x: c(20, 0).x, y: c(0, 6).y, props: { ref: "B2" } },
    ],
    wires: [
      { id: "a", from: { object: "A1", pin: "2" }, to: { object: "A2", pin: "1" }, points: bendA.map(([x, y]) => c(x, y)) },
      { id: "b", from: { object: "B1", pin: "2" }, to: { object: "B2", pin: "1" }, points: bendB.map(([x, y]) => c(x, y)) },
    ],
    parts: {},
  })

  it("a wire walled in by another net is sought a way round in growing windows, up to 96 cells beyond its ends (findings 3.L11)", () => {
    const wall = (half: number) => {
      const conductors = new Conductors()
      for (let k = -half; k < half; k++) conductors.lay(k + half, "other", [c(5, k / 2), c(5, (k + 1) / 2)])
      return conductors
    }
    const lay = { wire: { id: "w", from: { object: "A", pin: "1" }, to: { object: "B", pin: "1" } }, own: new Set(["mine"]), from: c(0, 0), to: c(10, 0), fromObject: "A", toObject: "B", candidates: [[c(0, 0), c(10, 0)]] }
    const extent = { x: c(-150, 0).x, y: c(0, -150).y, w: c(310, 0).x, h: c(0, 300).y }
    const round = laidAgain(lay, new Map(), [], wall(16), extent)?.path
    expect.soft(round && Math.max(...round.map((p) => Math.abs(p.y))) > c(0, 8).y, `round the 8-cell wall: ${JSON.stringify(round)}`).toBe(true)
    expect.soft(laidAgain(lay, new Map(), [], wall(200), extent), "a wall of 100 cells either way is beyond the search: the wire stays and is named").toBeNull()
  })

  it("the half-cell last resort goes round a part's body and its leads in a wider window before it takes the body in a narrow one (design.md §13.22 q2, §13.27; phase 6 review A, question 3)", () => {
    const standing: PlacedObject = { id: "R3", def: "resistor", x: c(4, -1).x, y: c(4, -1).y, rotation: 90, props: { ref: "R3" } }
    const fence = new Conductors()
    for (const p of objectPins(standing, GRID)) fence.addFixed({ at: p.point, net: `R3.${p.pin.id}`, socket: false })
    for (let k = 1; k <= 16; k++) for (const y of [-1 - k / 2, 3 + k / 2]) fence.addFixed({ at: c(5, y), net: "fence", socket: false })
    const lay = { wire: { id: "w", from: { object: "A", pin: "1" }, to: { object: "B", pin: "1" } }, own: new Set(["mine"]), from: c(0, 1), to: c(10, 1), fromObject: "A", toObject: "B", candidates: [] }
    const extent = { x: c(-150, 0).x, y: c(0, -150).y, w: c(310, 0).x, h: c(0, 300).y }
    const objects = [standing]
    const again = laidAgain(lay, objectIndex(objects), objects, fence, extent, closedBodies(objects))
    const path = again?.path ?? []
    const body = bodiesOf(objects)[0]
    expect.soft(again?.strict, `laid clear of every body: ${JSON.stringify(path.map((p) => [p.x / GRID, p.y / GRID]))}`).toBe(true)
    expect.soft(path.some((p, i) => i > 0 && staysThrough({ a: path[i - 1], b: p }, body)), "never through R3's body or along its leads, though the six-cell window has no other way").toBe(false)
    expect.soft(Math.max(...path.map((p) => Math.abs(p.y - c(0, 1).y))) >= c(0, 9).y, "round the fence's end, nine cells out").toBe(true)
  })

  it("the half-cell last resort passes a header socket only along its row: down a corridor through the column in the six-cell window it goes round in a wider one (design.md §4.5, §13.22 q6)", () => {
    const header = new Conductors()
    for (let y = -8; y <= 8; y++) header.addFixed({ at: c(5, y), net: `CN.${y}`, socket: true, along: { x: -1, y: 0 } })
    for (let k = -20; k <= 20; k++) for (const x of [4.5, 5.5]) header.addFixed({ at: c(x, k / 2), net: "corridor", socket: false })
    for (let k = -4; k <= 24; k++) for (const y of [-10, 10]) if (k / 2 < 4.5 || k / 2 > 5.5) header.addFixed({ at: c(k / 2, y), net: "corridor", socket: false })
    const lay = { wire: { id: "w", from: { object: "A", pin: "1" }, to: { object: "B", pin: "1" } }, own: new Set(["mine"]), from: c(5, -12), to: c(5, 12), fromObject: "A", toObject: "B", candidates: [] }
    const extent = { x: c(-150, 0).x, y: c(0, -150).y, w: c(310, 0).x, h: c(0, 300).y }
    const path = laidAgain(lay, new Map(), [], header, extent)?.path ?? []
    const downTheColumn = path.some((p, i) => i > 0 && p.x === c(5, 0).x && path[i - 1].x === c(5, 0).x && Math.min(p.y, path[i - 1].y) < c(0, 8).y && Math.max(p.y, path[i - 1].y) > c(0, -8).y)
    expect.soft(path.length > 1, "laid").toBe(true)
    expect.soft(downTheColumn, `never down the socket column x = 5: ${JSON.stringify(path.map((p) => [p.x / GRID, p.y / GRID]))}`).toBe(false)
  })

  it("a wire only a body lets keep its circuit takes it, and the note names the body (phase 6 review A, question 3: «forbid both there and let such wires … be named»)", () => {
    const doc: LegacySchematic = {
      objects: [
        { id: "R1", def: "resistor", x: 0, y: 0, props: { ref: "R1" } },
        { id: "R2", def: "resistor", x: c(10, 0).x, y: 0, props: { ref: "R2" } },
        { id: "R3", def: "resistor", x: c(9, -1).x, y: c(9, -1).y, rotation: 90, props: { ref: "R3" } },
      ],
      wires: [{ id: "w", from: { object: "R1", pin: "2" }, to: { object: "R2", pin: "1" } }],
      parts: {},
    }
    const { doc: after, notes } = wiresAsSegments(doc)
    expect.soft(pinPartition(after), "R2's pin 1 stands inside R3's body; the circuit stays").toEqual([["R1.2", "R2.1"]])
    expect.soft(notes, "the note says what the wire crosses").toEqual(["The wire between R1 2 and R2 1 ran over another net's wire or pin where it was drawn; it is laid again so the circuit stays as it was, though only across R3's body: check it."])
  })

  it("two nets drawn along one corridor: the first keeps its route, the second is laid apart and named", () => {
    const doc = two([[8, 3], [16, 3]], [[8, 3], [16, 3]])
    expect.soft(legacyPinPartition(doc, GRID), "before: two nets").toEqual([["A1.2", "A2.1"], ["B1.2", "B2.1"]])
    const { doc: after, notes, routes } = wiresAsSegments(doc)
    expect.soft(pinPartition(after), "after: still two").toEqual([["A1.2", "A2.1"], ["B1.2", "B2.1"]])
    expect.soft(routes.get("a")!.some((p) => p.y === c(0, 3).y), "the first still runs down the corridor").toBe(true)
    expect.soft(notes, "the second is named").toEqual(["The wire between B1 2 and B2 1 ran over another net's wire or pin where it was drawn; it is laid again so the circuit stays as it was."])
  })

  it("a wire passing a socket another wire ends on moves off it, and the wire ending there keeps its route (design.md §13.9 in the upgrade)", async () => {
    const before = await legacyFile("../data/pin-partition/../emul-1.28.0/lab2-rgb-pwm.emul").catch(() => null)
    expect.soft(before === null || versionOf(before) <= 2, "a 1.28.0 file").toBe(true)
    const board: PlacedObject = { id: "U1", def: "nucleo-f429zi", x: 0, y: 0, props: { ref: "U1" } }
    const inner = objectPins(board, GRID).find((p) => p.pin.id === "CN8-6")!.point
    const outer = objectPins(board, GRID).find((p) => p.pin.id === "CN8-5")!.point
    const r1: PlacedObject = { id: "R1", def: "resistor", x: outer.x - c(12, 0).x, y: outer.y - GRID, props: { ref: "R1" } }
    const r4: PlacedObject = { id: "R4", def: "resistor", x: inner.x - c(18, 0).x, y: inner.y - GRID, props: { ref: "R4" } }
    const doc: LegacySchematic = {
      objects: [board, r1, r4],
      wires: [
        { id: "passing", from: { object: "U1", pin: "CN8-6" }, to: { object: "R4", pin: "2" } },
        { id: "ending", from: { object: "U1", pin: "CN8-5" }, to: { object: "R1", pin: "2" } },
      ],
      parts: {},
    }
    const was = legacyPinPartition(doc, GRID)
    const { doc: after } = wiresAsSegments(doc)
    expect.soft(pinPartition(after), "the two nets stay two").toEqual(was)
  })

  it("a wire that finds no clean way in file order is laid first on the next pass, until every wire is clean", () => {
    const doc = lab1Board.build(GRID)
    const u = doc.objects.find((o) => o.def === "open746i-c")!
    const strips = getDef("open746i-c")!.pins.filter((p) => /^P(18|19)-\d+$/.test(p.id) && /^P[A-I]\d+$/.test(p.label ?? ""))
    const load = builder(GRID)
    strips.slice(0, 23).forEach((p, i) => {
      const sw = load.place("switch", 90 + (i % 14) * 6, 4 + Math.floor(i / 14) * 6)
      load.wire(u, p.id, sw, "1")
      load.wire(sw, "2", u, "P18-36")
    })
    doc.objects.push(...load.doc.objects)
    connect(doc, ...connections(load.doc))
    const legacy = legacyOf(doc)
    const frozen = wiresAsSegments(legacy)
    expect.soft(frozen.faithful, "the circuit kept").toBe(true)
    expect.soft(frozen.notes.filter((n) => !n.includes("laid again")), "no wire left over another net").toEqual([])
    expect.soft(pinPartition(frozen.doc), "the same circuit").toEqual(legacyPinPartition(legacy, GRID))
  })

  it("pins an old file joined only through a pin that is no longer there get a wire of their own, said in the notes", () => {
    const doc: LegacySchematic = {
      objects: [
        { id: "R1", def: "resistor", x: 0, y: 0, props: { ref: "R1" } },
        { id: "R2", def: "resistor", x: 0, y: c(0, 6).y, props: { ref: "R2" } },
        { id: "U1", def: "resistor", x: c(12, 0).x, y: 0, props: { ref: "U1" } },
      ],
      wires: [
        { id: "a", from: { object: "R1", pin: "2" }, to: { object: "U1", pin: "gone" } },
        { id: "b", from: { object: "R2", pin: "2" }, to: { object: "U1", pin: "gone" } },
      ],
      parts: {},
    }
    expect.soft(legacyPinPartition(doc, GRID), "before: R1 and R2 through U1's missing pin").toEqual([["R1.2", "R2.2"]])
    const { doc: after, notes } = wiresAsSegments(doc)
    expect.soft(pinPartition(after), "after: joined by a wire of their own").toEqual([["R1.2", "R2.2"]])
    expect.soft(notes, "said").toEqual(["R1 2 was joined to R2 2 through U1 gone, which is not in the file any more; a wire joins them directly now."])
    const direct = wiresAsSegments({ ...doc, wires: [...doc.wires, { id: "c", from: { object: "R1", pin: "2" }, to: { object: "R2", pin: "2" } }] })
    expect.soft(direct.notes, "joined by a wire of their own already: nothing added, nothing to say (findings 3.L15)").toEqual([])
    expect.soft(direct.doc.wires.every((w) => w.id === "c" || w.id.startsWith("c~")), "only that wire").toBe(true)
  })

  it("a junction no wire reaches goes without moving a wire that ran over it (findings 3.R10)", () => {
    const r1: PlacedObject = { id: "R1", def: "resistor", x: 0, y: 0, props: { ref: "R1" } }
    const r2: PlacedObject = { id: "R2", def: "resistor", x: c(12, 0).x, y: 0, props: { ref: "R2" } }
    const a = objectPins(r1, GRID).find((p) => p.pin.id === "2")!.point
    const at = { x: a.x + c(3, 0).x, y: a.y }
    const hub: PlacedObject = { id: "J", def: "junction", x: at.x - GRID, y: at.y - GRID }
    const doc: LegacySchematic = { objects: [r1, r2, hub], wires: [{ id: "w", from: { object: "R1", pin: "2" }, to: { object: "R2", pin: "1" }, points: [at] }], parts: {} }
    const without = wiresAsSegments({ ...doc, objects: [r1, r2] }).routes.get("w") ?? []
    expect.soft(without.some((p, i, list) => i > 0 && list[i - 1].y === at.y && p.y === at.y && Math.min(list[i - 1].x, p.x) <= at.x && at.x <= Math.max(list[i - 1].x, p.x)), "with no junction there, the router lays the wire through the junction's point").toBe(true)
    const withHub = wiresAsSegments(doc)
    expect.soft(withHub.notes, "nothing to say").toEqual([])
    expect.soft(withHub.routes.get("w"), "the wire where the router lays it with no junction there, not laid again").toEqual(without)
  })

  it("a file whose NC pads touch, wired, keeps its circuit with nothing to say about it (findings 3.R12)", async () => {
    const read = await readProjectFile(new Blob([readFileSync(join(ROOT, "before-the-segments", "nc-coinciding-pads-wired.emul"))]))
    expect.soft(read!.notes.filter((n) => !n.includes("laid again")), "no circuit lost").toEqual([])
  })

  it("junction parts go: their wires end where the junction stood, and the point is a dot", () => {
    const tap = documents.find((d) => d.name === "case--junction-tap")!.doc
    expect.soft(tap.objects.some((o) => o.def === "junction"), "no junction part").toBe(false)
    expect.soft(junctionsOf(wireNets(tap.wires, wirePins(tap.objects))).length, "one dot where it stood").toBe(1)
  })
})

describe("the version (design.md §10)", () => {
  it("a file before the segments is upgraded once and stamped; one stamped now is left alone", () => {
    const legacy = legacyOf(examples.find((e) => e.id === "bridge")!.build(GRID))
    const first = upgraded({ ...legacy, version: 3 } as LegacySchematic)
    expect.soft(versionOf(first.doc), "stamped").toBe(SCHEMATIC_VERSION)
    expect.soft(upgraded(first.doc).doc, "not upgraded again").toBe(first.doc)
    expect.soft(legacyUpgraded({ ...legacy, version: 3 } as LegacySchematic).doc.wires, "no legacy step left to run on a version 3 file").toBe(legacy.wires)
  })

  it("a document drawn in segments but saved without a stamp is taken as this version, its wires kept as drawn", () => {
    const doc: Schematic = { ...examples.find((e) => e.id === "bridge")!.build(GRID) }
    const unstamped = JSON.parse(JSON.stringify(doc)) as Schematic
    expect.soft(versionOf(unstamped), "this version").toBe(SCHEMATIC_VERSION)
    expect.soft(upgraded(unstamped).doc.wires, "the wires as drawn").toEqual(doc.wires)
    expect.soft(versionOf({ objects: [], wires: [], parts: {} }), "an empty unstamped document is the oldest").toBe(1)
  })
})

describe("documents drawn in code go through the same freeze (design.md §10)", () => {
  const pinAt = (o: PlacedObject, pin: string) => objectPins(o, GRID).find((p) => p.pin.id === pin)!.point

  it("the builder refuses wiring it cannot lay without changing the circuit, and names the wire", () => {
    const { doc, place, wire } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 0, 10)
    const fenced = pinAt(r1, "2")
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const g = place("ground", 0, 0)
      const at = pinAt(g, "GND")
      g.x += fenced.x + (dx * GRID) / 2 - at.x
      g.y += fenced.y + (dy * GRID) / 2 - at.y
    }
    wire(r1, "2", r2, "1")
    expect.soft(() => doc.wires, "refused, naming the wire").toThrow(/R1 2 and R2 1 could not be laid clear of another net/)
  })

  it("a wire changed after the first read is frozen again: its bends and colour show (findings 3.R9)", () => {
    const { doc, place, wire } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 0, 10)
    wire(r1, "2", r2, "2")
    const first = doc.wires
    rewire(doc, (w) => ({ ...w, color: "blue", points: [{ x: 10 * GRID, y: GRID }, { x: 10 * GRID, y: 11 * GRID }] }))
    const second = doc.wires
    expect.soft(second, "a new freeze").not.toBe(first)
    expect.soft(second.every((s) => s.color === "blue"), "blue").toBe(true)
    expect.soft(second.some((s) => s.a.x === 10 * GRID && s.b.x === 10 * GRID), "through the bends").toBe(true)
  })

  it("a part moved, turned or mirrored after the first read is wired again to where its pins are now (findings 3.L15)", () => {
    const { doc, place, wire } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 0, 10)
    wire(r1, "2", r2, "2")
    const endsOnPin = () => {
      const pin = objectPins(doc.objects[1], GRID).find((p) => p.pin.id === "2")!.point
      return doc.wires.some((s) => (s.a.x === pin.x && s.a.y === pin.y) || (s.b.x === pin.x && s.b.y === pin.y))
    }
    expect.soft(endsOnPin(), "drawn").toBe(true)
    doc.objects[1] = { ...doc.objects[1], x: doc.objects[1].x + 3 * GRID }
    expect.soft(endsOnPin(), "moved").toBe(true)
    doc.objects[1] = { ...doc.objects[1], rotation: 90 }
    expect.soft(endsOnPin(), "turned").toBe(true)
    doc.objects[1] = { ...doc.objects[1], mirror: true }
    expect.soft(endsOnPin(), "mirrored").toBe(true)
  })

  it("the builder refuses a part placed off the grid rather than move it under its own wires (verification V5)", () => {
    const { doc, place, wire } = builder(GRID)
    const r1 = place("resistor", 0.25, 0)
    const r2 = place("resistor", 10, 0)
    wire(r1, "2", r2, "1")
    expect.soft(() => doc.wires, "refused, naming the part").toThrow(/no wire can end on their pins: R1/)
  })

  it("an HDL module renamed after the first read is wired again to where its pins now stand (verification V6)", () => {
    const named = (name: string): HdlModule => ({ id: "hdl:cnt", name, files: [], netlist: counter as unknown as HdlNetlist, built: "b1" })
    const { doc, place, wire } = builder(GRID)
    doc.library = [named("cnt")]
    const u = withLibrary(doc.library, () => place("hdl:cnt", 0, 0))
    const g = place("ground", 0, 12)
    wire(u, "GND", g, "GND")
    const endsOnGnd = () =>
      withLibrary(doc.library, () => {
        const pin = objectPins(doc.objects[0], GRID).find((p) => p.pin.id === "GND")!.point
        return doc.wires.some((s) => (s.a.x === pin.x && s.a.y === pin.y) || (s.b.x === pin.x && s.b.y === pin.y))
      })
    expect.soft(endsOnGnd(), "drawn").toBe(true)
    doc.library = [named("a_module_name_that_is_long_enough_to_change_the_symbol_width")]
    expect.soft(endsOnGnd(), "renamed: still on the pin").toBe(true)
  })

  it("a wire to a junction made with node() ends on its point, which is a dot", () => {
    const { doc, place, wire, node } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 0, 6)
    const r3 = place("resistor", 0, 12)
    const hub = node(10, 7)
    for (const r of [r1, r2, r3]) wire(r, "2", hub, "J")
    expect.soft(doc.objects.some((o) => o.def === "junction"), "no junction part in the document").toBe(false)
    expect.soft(junctionsOf(wireNets(doc.wires, wirePins(doc.objects))), "one dot, where the node stands").toEqual([{ x: 10 * GRID, y: 7 * GRID }])
    expect.soft(pinPartition(doc), "the three pins on one net").toEqual([["R1.2", "R2.2", "R3.2"]])
  })
})

describe("every old file still opens, and the same way in every tab (findings 3.L5, 3.L14)", () => {
  const open = async (name: string) => (await readProjectFile(new Blob([readFileSync(join(ROOT, "before-the-segments", `${name}.emul`))])))!

  it("a part whose pin sat on a pad marked not connected that another net's wire uses moves off it, says so and keeps its circuit (findings 3.L2)", async () => {
    const read = await open("nc-touched-and-wired")
    const r1 = read.doc.objects.find((o) => o.id === "R1")!
    expect.soft(read.notes, "said").toEqual([expect.stringMatching(/^R1 moved 1 cell: its pin 1 sat on U1 CN8-1, a pad marked not connected that joins it to another net/)])
    const net = buildNetlist(read.doc).pinNet
    expect.soft(net.get("R1:1"), "R1 1 left out of R2's net, as it was").not.toBe(net.get("R2:1"))
    const board = read.doc.objects.find((o) => o.id === "U1")!
    expect.soft(objectPins(r1, GRID).some((p) => objectPins(board, GRID).some((q) => q.point.x === p.point.x && q.point.y === p.point.y)), "on no pad of the board").toBe(false)
  })

  it("a part moved off such a pad keeps the contact its other pin made, by a wire (findings 3.L2)", () => {
    const board: PlacedObject = { id: "U1", def: "nucleo-f429zi", x: 0, y: 0, props: { ref: "U1" } }
    const pad = objectPins(board, GRID).find((p) => p.pin.id === "CN8-1")!.point
    const probe: PlacedObject = { id: "R1", def: "resistor", x: 0, y: 0, props: { ref: "R1" } }
    const one = objectPins(probe, GRID).find((p) => p.pin.id === "1")!.point
    const r1: PlacedObject = { ...probe, x: pad.x - one.x, y: pad.y - one.y }
    const two = objectPins(r1, GRID).find((p) => p.pin.id === "2")!.point
    const groundProbe: PlacedObject = { id: "G1", def: "ground", x: 0, y: 0 }
    const gnd = objectPins(groundProbe, GRID)[0].point
    const ground: PlacedObject = { ...groundProbe, x: two.x - gnd.x, y: two.y - gnd.y }
    const r2: PlacedObject = { id: "R2", def: "resistor", x: pad.x - 20 * GRID, y: pad.y + 6 * GRID, props: { ref: "R2" } }
    const old = { objects: [board, r1, ground, r2], wires: [{ id: "w", from: { object: "U1", pin: "CN8-1" }, to: { object: "R2", pin: "1" } }], parts: {}, version: 3 } as unknown as LegacySchematic
    const { doc, notes } = upgraded(old)
    const net = buildNetlist(doc).pinNet
    expect.soft(net.get("R1:2"), "R1 2 still on the ground it touched").toBe(net.get(`G1:${objectPins(groundProbe, GRID)[0].pin.id}`))
    expect.soft(net.get("R1:1"), "and off R2's net").not.toBe(net.get("R2:1"))
    expect.soft(notes.some((n) => n.includes("R1 2") && n.endsWith("touched where they stood before; a wire joins them now.")), `told: ${JSON.stringify(notes)}`).toBe(true)
  })

  it("a part saved off the grid moves onto it, the least it can, says so and keeps its circuit", async () => {
    const read = await open("part-off-the-lattice")
    const r1 = read.doc.objects.find((o) => o.id === "R1")!
    expect.soft([r1.x, r1.y], "back a quarter of a cell, onto the grid").toEqual([0, 0])
    expect.soft(read.notes, "said").toEqual(["R1 moved a quarter of a cell: it stood off the grid, where no wire can end on its pins."])
    expect.soft(normalFormViolations(read.doc.wires, wirePins(read.doc.objects)), "normal").toEqual([])
  })

  it("wires whose ids clash with the pieces the freeze names, or with each other, open with every id distinct and nothing to say", async () => {
    for (const name of ["wire-ids-with-a-tilde", "duplicate-wire-ids"]) {
      const read = await open(name)
      const ids = read.doc.wires.map((s) => s.id)
      expect.soft(new Set(ids).size, `${name}: distinct ids`).toBe(ids.length)
      expect.soft(read.notes, `${name}: no wire laid again, none lost`).toEqual([])
    }
  })

  it("a file this version cannot read says why; one stamped now but out of normal form opens in it", async () => {
    const r = (id: string, x: number): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: 0, props: { ref: id } })
    const offLattice: Schematic = { objects: [r("R1", 0)], wires: [{ id: "d", a: { x: 0, y: 0 }, b: { x: GRID, y: 5 } }], parts: {} }
    const refused = await openedFile(await projectFile("off-lattice", offLattice), "off-lattice.emul")
    expect.soft("failure" in refused && refused.failure, "the reason, with the wire").toMatch(/^off-lattice\.emul could not be brought up to this version of εmul: .*\bd\b/)
    const slant = { id: "d", a: { x: 0, y: 0 }, b: { x: 2 * GRID, y: GRID } }
    const diagonal = await openedFile(await projectFile("diagonal", { objects: [r("R1", 4)], wires: [slant], parts: {} }), "diagonal.emul")
    expect.soft("doc" in diagonal && { wires: diagonal.doc.wires, notes: diagonal.notes }, "a diagonal between lattice points opens as drawn, nothing to say (design.md §6.11 rules 3 and 13)").toEqual({ wires: [slant], notes: [] })
    expect.soft(await openedFile(new Blob(["not a project"]), "notes.txt"), "not a project").toEqual({ failure: "notes.txt: not an .emul project or a zipped STM32 project." })
    const overlapping: Schematic = { objects: [], wires: [{ id: "a", a: { x: 0, y: 0 }, b: { x: 4 * GRID, y: 0 } }, { id: "b", a: { x: 2 * GRID, y: 0 }, b: { x: 6 * GRID, y: 0 } }], parts: {} }
    const opened = await openedFile(await projectFile("overlapping", overlapping), "overlapping.emul")
    expect.soft("doc" in opened && opened.doc.wires.map((s) => [s.a.x, s.b.x]), "one wire").toEqual([[0, 6 * GRID]])
  })

  it("two tabs freezing the same old document write the same segments under the same ids", () => {
    for (const id of ["power-supply", "bridge", "opamp-amplifier"]) {
      const legacy = { ...legacyOf(examples.find((e) => e.id === id)!.build(GRID)), version: 2 } as LegacySchematic
      const once = upgraded(JSON.parse(JSON.stringify(legacy)))
      const again = upgraded(JSON.parse(JSON.stringify(legacy)))
      expect.soft(again.doc.wires, `${id}: the same segments`).toEqual(once.doc.wires)
      expect.soft(again.doc.objects, `${id}: the same parts`).toEqual(once.doc.objects)
    }
    const oscillator = (id: string, x: number, rotation?: 180): PlacedObject => ({ id, def: "oscillator", x: x * GRID, y: 0, props: { ref: id }, ...(rotation && { rotation }) })
    const touching = { objects: [oscillator("G1", 0), oscillator("G2", 4, 180)], wires: [], parts: {}, version: 2 } as unknown as LegacySchematic
    const first = upgraded(JSON.parse(JSON.stringify(touching)))
    expect.soft(first.notes.some((n) => n.includes("a wire joins them now")), "the lattice step adds a wire here").toBe(true)
    expect.soft(upgraded(JSON.parse(JSON.stringify(touching))).doc.wires, "and names it the same in both tabs").toEqual(first.doc.wires)
  })
})
