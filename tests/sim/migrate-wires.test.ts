import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readProjectFile } from "@/project/project-store"
import { builder, connect, connections, legacyOf } from "@/schematic/builder"
import { examples, lab1Board } from "@/schematic/examples"
import { GRID, objectPins, type Point } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { legacyUpgraded, SCHEMATIC_VERSION, upgraded, versionOf } from "@/schematic/migrate"
import { frozenCandidates, wiresAsSegments, wirePins } from "@/schematic/migrate-wires"
import type { LegacySchematic, LegacyWire, PlacedObject, Schematic } from "@/schematic/types"
import { junctionsOf, wireNets } from "@/schematic/wires/graph"
import { buildNetlist, GROUND, type Netlist } from "@/sim/netlist"
import { SimLoop } from "@/sim/loop"
import { legacyCircuit } from "../lib/legacy-circuit"
import { joiningContactsOfNcPads, legacyPinPartition, pinPartition } from "../lib/pin-partition"
import { partitionDocuments, readFixture } from "../lib/partition-documents"
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
      expect.soft(doc.objects.some((o) => o.def === "junction"), `${name}: no junction parts left`).toBe(false)
    }
  })

  it.each(examples.map((e) => [e.id, e] as const))("%s hands the solver the netlist its old wires did", (_, example) => {
    const built = example.build(GRID)
    const doc: Schematic = { ...built }
    const legacy = legacyOf(built)
    const hubs = new Set(legacy.objects.filter((o) => o.def === "junction").map((o) => o.id))
    expect(netlistShape(buildNetlist(doc))).toEqual(netlistShape(buildNetlist(legacyCircuit(legacy)), hubs))
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

  it("only the documents whose wires ran over another net say so, and each names the wire it laid again", () => {
    const relaid: string[] = []
    for (const e of examples) {
      const { notes } = wiresAsSegments(legacyOf(e.build(GRID)))
      expect.soft(notes.every((n) => n.includes("laid again")), `${e.id}: ${JSON.stringify(notes)}`).toBe(true)
      if (notes.length) relaid.push(e.id)
    }
    expect.soft(relaid.sort(), "the four examples of phase 0's register").toEqual(["charge-boost-chips", "nucleo-serial", "open746-touch", "system-exam"])
  })
})

describe("a wire at a diagonal pin: the first straight piece slides onto the pin (design.md §13.14)", () => {
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

  it("the power supply's four corners: every wire leaves its corner at a right angle, the rest of it where it was", () => {
    const doc = legacyOf(examples.find((e) => e.id === "power-supply")!.build(GRID))
    const routes = frozenOf(doc)
    expect.soft(cells(routes.get(between(doc, "D1.2", "C1.1").id)), "the top corner, straight up to the rail").toEqual([[17, 3], [17, 1], [27, 1], [27, 2]])
    expect.soft(cells(routes.get(between(doc, "T1.S1", "D1.1").id)), "the left corner, in from the left on its own row").toEqual([[8, 5], [11, 5], [11, 6], [14, 6]])
    expect.soft(cells(routes.get(between(doc, "T1.S2", "D2.1").id)).slice(-2), "the right corner, out to the right on its own row").toEqual([[24, 6], [20, 6]])
    expect.soft(cells(routes.get(between(doc, "D3.1", "ground@16,13.GND").id)), "the bottom corner, straight down to ground").toEqual([[17, 9], [17, 13]])
    for (const pts of routes.values()) for (let i = 1; i < pts.length; i++) expect.soft(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y, `orthogonal: ${JSON.stringify(cells(pts))}`).toBe(true)
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

  it("where the piece after the stub ends at the far pin, nothing can slide: the stub becomes a one-cell step", () => {
    const route = [c(0, 0), c(1, 1), c(5, 1)]
    expect.soft(frozenCandidates(route, []).map(cells), "only the step").toEqual([[[0, 0], [0, 1], [5, 1]]])
  })

  it("a slide that would run through a body takes the step instead", () => {
    const route = [c(0, 0), c(1, 1), c(1, 6), c(6, 6)]
    const body = { x: -GRID / 2, y: 2 * GRID, w: GRID, h: 2 * GRID }
    expect.soft(frozenCandidates(route, []).map(cells)[0], "free: the slide").toEqual([[0, 0], [0, 6], [6, 6]])
    expect.soft(frozenCandidates(route, [body]).map(cells), "a body on the slid piece: the step").toEqual([[[0, 0], [1, 0], [1, 6], [6, 6]]])
  })

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
    expect(() => doc.wires).toThrow(/R1 2 and R2 1 could not be laid clear of another net/)
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
