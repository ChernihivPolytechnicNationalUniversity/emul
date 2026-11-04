import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseProject, readProjectFile } from "@/project/project-store"
import { setLibrary } from "@/schematic/registry"
import { builder, legacyOf } from "@/schematic/builder"
import { examples } from "@/schematic/examples"
import { GRID, objectPins, objectRect, type Orientation, type Point } from "@/schematic/geometry"
import { legacyUpgraded, migrated, SCHEMATIC_VERSION, upgraded } from "@/schematic/migrate"
import { legacyNets as buildNets } from "@/schematic/nets"
import { placementCheck } from "@/schematic/placement"
import { getDef } from "@/schematic/registry"
import type { HdlModule, LegacySchematic, PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { pasteLanding, pastedInto, type Clip } from "@/schematic/use-schematic"
import { pinsOf } from "@/schematic/wire-edits"
import { pinPartition as graphPartition, wireNets } from "@/schematic/wires/graph"
import { legacyCircuit } from "../lib/legacy-circuit"
import { SimLoop } from "@/sim/loop"

const ROOT = join(import.meta.dirname, "..", "..")
const c = (v: number) => v * GRID
const whole = (v: number) => Math.abs(v - Math.round(v)) < 1e-9
const placedAs = (def: string, o: Orientation, x = 0, y = 0, ref?: string): PlacedObject => ({ id: ref ?? def, def, x: c(x), y: c(y), ...(o.rotation && { rotation: o.rotation }), ...(o.mirror && { mirror: true }), ...(ref && { props: { ref } }) })
const at = (o: PlacedObject, pin: string) => objectPins(o, GRID).find((p) => p.pin.id === pin)!.point
const old = (objects: PlacedObject[], wires: LegacySchematic["wires"] = []): LegacySchematic => ({ objects, wires, parts: {}, version: 2 }) as LegacySchematic
const upright = (rotation: Rotation): Orientation => ({ rotation, mirror: false })

const connectedNow = (doc: Schematic): string[][] => graphPartition(wireNets(doc.wires, pinsOf(doc.objects))).map((g) => [...g].sort()).sort()

function connected(doc: LegacySchematic): string[][] {
  const nets = buildNets(doc.objects, doc.wires, GRID)
  const groups = new Map<string, string[]>()
  for (const o of doc.objects)
    for (const { key } of objectPins(o, GRID)) {
      const net = nets.netOfPin(key)
      if (net !== undefined) groups.set(net, [...(groups.get(net) ?? []), key])
    }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort()).sort()
}

const groundOn = (id: string, p: Point): PlacedObject => ({ id, def: "ground", x: p.x - GRID, y: p.y })

const DRAWN_BEFORE: Record<string, { height?: number; pins?: Record<string, Point> }> = {
  oscillator: { pins: { OUT: { x: 4, y: 1.5 } } },
  tp4056: { pins: { GND: { x: 4.5, y: 8 } } },
  dw03: { pins: { GND: { x: 1, y: 3.5 }, VM: { x: 7, y: 3.5 } } },
  mt3608: { pins: { GND: { x: 4.5, y: 6 } } },
  lp2985: { pins: { GND: { x: 4.5, y: 6 } } },
  "oled-ssd1306-i2c-32": { height: 5.6 },
}

function before(o: PlacedObject, pinId: string): Point {
  const def = getDef(o.def)!
  const was = DRAWN_BEFORE[def.id] ?? {}
  const height = was.height ?? def.height
  const pin = { ...def.pins.find((p) => p.id === pinId)!, ...was.pins?.[pinId] }
  const turn = ((o.rotation ?? 0) * Math.PI) / 180
  const exact = (v: number) => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v)
  const [cos, sin] = [exact(Math.cos(turn)), exact(Math.sin(turn))]
  const box = { w: def.width * Math.abs(cos) + height * Math.abs(sin), h: def.width * Math.abs(sin) + height * Math.abs(cos) }
  const v = { x: (o.mirror ? -1 : 1) * (pin.x - def.width / 2), y: pin.y - height / 2 }
  return { x: o.x + (v.x * cos - v.y * sin + box.w / 2) * GRID, y: o.y + (v.x * sin + v.y * cos + box.h / 2) * GRID }
}

const INVERTER: HdlModule = { id: "hdl:inv", name: "inv", files: [], built: "inv", netlist: { top: "inv", language: "verilog", nets: 3, ports: [{ name: "a", dir: "input", bits: [1], offset: 0, upto: false }, { name: "y", dir: "output", bits: [2], offset: 0, upto: false }], cells: [["$_NOT_", 1, 2]], init: [] } as never }

const WITH_ENABLE: HdlModule = { ...INVERTER, built: "inv-en", netlist: { ...INVERTER.netlist!, nets: 4, ports: [...INVERTER.netlist!.ports, { name: "en", dir: "input", bits: [3], offset: 0, upto: false }] } as never }

const touchingAny = (doc: LegacySchematic, id: string) => connected(doc).filter((g) => g.some((k) => k.startsWith(`${id}:`)))

const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const OLD = join(ROOT, "tests", "data", "emul-1.42.0")

async function rawOld(file: string): Promise<LegacySchematic> {
  const { Zstd } = await import("@hpcc-js/wasm-zstd")
  const bytes = (await Zstd.load()).decompress(new Uint8Array(readFileSync(join(OLD, file))))
  return (JSON.parse(new TextDecoder().decode(bytes)) as { schematic: LegacySchematic }).schematic
}

async function opened(file: string) {
  const read = await readProjectFile(new Blob([readFileSync(join(OLD, file))]))
  if (!read) throw new Error(`${file} does not read`)
  return read
}

const refOf = (doc: Pick<Schematic, "objects">, id: string) => doc.objects.find((o) => o.id === id)?.props?.ref

describe("an old file's diagonal parts move onto the lattice without changing the circuit (design.md §10 item 1; the user, 2026-11-04: old projects must keep working)", () => {
  it("an old power supply's bridge closes: every diode moves under a cell, the four corners meet pin to pin and the four wires between them go", async () => {
    const before = await rawOld("power-supply.emul")
    const { doc, notes } = legacyUpgraded(before)
    const diodes = doc.objects.filter((o) => o.def === "diode")
    const was = new Map(before.objects.map((o) => [o.id, o]))
    for (const d of diodes) {
      const old = was.get(d.id)!
      const def = getDef(d.def)!
      const middleBefore = { x: old.x / GRID + (def.width + def.height) * Math.SQRT1_2 / 2, y: old.y / GRID + (def.width + def.height) * Math.SQRT1_2 / 2 }
      const middleNow = { x: d.x / GRID + 1.5, y: d.y / GRID + 1.5 }
      expect.soft(Math.hypot(middleNow.x - middleBefore.x, middleNow.y - middleBefore.y), `${d.props?.ref} moved under a cell`).toBeLessThan(1)
    }
    const [d1, d2, d3, d4] = ["D1", "D2", "D3", "D4"].map((ref) => doc.objects.find((o) => o.props?.ref === ref)!)
    expect.soft([at(d1, "1"), at(d1, "2"), at(d2, "1"), at(d3, "1")], "the corners").toEqual([at(d3, "2"), at(d2, "2"), at(d4, "2"), at(d4, "1")])
    const gone = before.wires.filter((w) => !doc.wires.some((x) => x.id === w.id)).map((w) => `${refOf(before, w.from.object)}.${w.from.pin}–${refOf(before, w.to.object)}.${w.to.pin}`)
    expect.soft(gone.sort(), "the wires between pins that now meet").toEqual(["D1.1–D3.2", "D1.2–D2.2", "D2.1–D4.2", "D3.1–D4.1"])
    expect.soft(notes.some((n) => n.includes("D1, D2, D3 and D4 now meet pin to pin")), "the upgrade says so").toBe(true)
  })

  it("the old power supply rectifies the same after the upgrade: every reading equal, simulated side by side", async () => {
    const before = await rawOld("power-supply.emul")
    const { doc } = await opened("power-supply.emul")
    const run = (d: Schematic | LegacySchematic) => {
      const loop = new SimLoop()
      loop.setDoc((d.wires as object[]).some((w) => "from" in w) ? legacyCircuit(d as LegacySchematic) : (d as Schematic))
      loop.setRunning(true)
      let clock = 0
      loop.advance(clock)
      for (let i = 0; i < 40; i++) loop.advance((clock += 25))
      return loop.snapshot()!
    }
    const a = run(before)
    const b = run(doc)
    const readings = a.readings.filter((r) => Math.abs(r.voltage) > 1e-3)
    expect.soft(readings.length, "readings to compare").toBeGreaterThan(5)
    for (const r of readings) {
      const same = b.readings.find((x) => x.object === r.object && x.element === r.element)
      expect.soft(same?.voltage ?? NaN, `${refOf(before, r.object)} element ${r.element}: voltage`).toBeNearRel(r.voltage, 1e-6)
    }
  })

  it("parts an old file left almost touching are not joined by the upgrade: each takes the nearest spot that keeps the circuit", async () => {
    const { doc } = await opened("led-diamond.emul")
    expect.soft(connectedNow(doc), "pins in contact").toEqual([])
    const before = await rawOld("led-diamond.emul")
    for (const o of doc.objects) {
      const old = before.objects.find((x) => x.id === o.id)!
      const middleBefore = (old.x + c(6 * Math.SQRT1_2 / 2)) / GRID
      expect.soft(Math.abs(o.x / GRID + 1.5 - middleBefore), `${o.props?.ref} moved less than a cell and a half`).toBeLessThan(1.5)
    }
  })

  it("a multi-pin part an old file left on a diagonal turns back to a right angle, keeps its wires and is named in the notes", async () => {
    const { doc, notes } = await opened("npn-on-a-diagonal.emul")
    const q1 = doc.objects.find((o) => o.def === "npn")!
    expect.soft(q1.rotation ?? 0, "Q1 on a right angle").toBe(0)
    for (const { point } of objectPins(q1, GRID)) expect.soft([whole(point.x / GRID), whole(point.y / GRID)], "its pins on whole cells").toEqual([true, true])
    expect.soft(notes, "the note").toEqual(["Q1 stood at 45°, which it cannot take now: turned to 0°."])
  })

  it("a multi-pin part turns in place even where a cell's shift would set its pin on the pin it is wired to", () => {
    const q = placedAs("npn", { rotation: 45, mirror: false }, 4, 4, "Q1")
    const inPlace = migrated(q)
    const base = at(inPlace, "B")
    const r = { ...placedAs("resistor", { rotation: 0, mirror: false }, 0, 0, "R1") }
    const pin2 = at(r, "2")
    const resistor = { ...r, x: r.x + base.x - GRID - pin2.x, y: r.y + base.y - pin2.y }
    const old = { objects: [q, resistor], wires: [{ id: "w", from: { object: "R1", pin: "2" }, to: { object: "Q1", pin: "B" } }], parts: {}, version: 2 } as LegacySchematic
    const { doc } = legacyUpgraded(old)
    const turned = doc.objects.find((o) => o.id === "Q1")!
    expect.soft([turned.x, turned.y, turned.rotation ?? 0], "Q1 turned where it stood").toEqual([inPlace.x, inPlace.y, inPlace.rotation ?? 0])
    expect.soft(doc.wires.map((w) => w.id), "its wire kept").toEqual(["w"])
  })

  it("a file without diagonal parts comes through untouched, and an upgraded file is not upgraded again", () => {
    const plain = legacyOf(examples.find((e) => e.id === "battery-life")!.build(GRID))
    expect.soft(legacyUpgraded({ ...plain, version: 2 } as LegacySchematic).doc.objects, "nothing to move").toBe(plain.objects)
    const { doc } = upgraded({ ...diamondOld(), version: 2 } as LegacySchematic)
    expect.soft(upgraded(doc).doc, "already at this version").toBe(doc)
    expect.soft((doc as Schematic & { version?: number }).version, "stamped").toBe(SCHEMATIC_VERSION)
  })

  it("a part on a diagonal it may not stand on, pasted from an older εmul, lands on a right angle", () => {
    const q = placedAs("npn", { rotation: 135, mirror: false }, 4, 4, "Q1")
    expect.soft(migrated(q).rotation, "turned back to 90°").toBe(90)
    const r = placedAs("resistor", { rotation: 135, mirror: false }, 4, 4, "R1")
    expect.soft(migrated(r), "a resistor may stand there").toBe(r)
  })
})

function diamondOld(): LegacySchematic {
  const { doc, place } = builder(GRID)
  for (const [x, y, rotation] of [[0, 0, 315], [5, 0, 45], [0, 3, 45], [5, 3, 315]] as [number, number, Rotation][]) place("led", x, y, { value: "red" }, rotation)
  return legacyOf(doc)
}


describe("the upgrade keeps every old circuit, whatever moved onto the lattice (phase 2 review)", () => {
  const changed: [string, string[]][] = [["oscillator", ["OUT"]], ["tp4056", ["GND"]], ["dw03", ["GND", "VM"]], ["mt3608", ["GND"]], ["lp2985", ["GND"]], ["oled-ssd1306-i2c-32", ["GND", "VCC", "SCL", "SDA"]]]

  it("a symbol whose pins moved onto the grid meets no pin it did not meet: a resistor waiting where a moved pin now lands, at every right angle, stays apart", () => {
    let cases = 0
    for (const [def, pins] of changed)
      for (const rotation of [0, 90, 180, 270] as Rotation[])
        for (const pin of pins) {
          const part = placedAs(def, upright(rotation), 0, 0, "U1")
          const lands = at(part, pin)
          const was = before(part, pin)
          if (Math.hypot(was.x - lands.x, was.y - lands.y) < 0.5) continue
          const resistor: PlacedObject = { id: "R1", def: "resistor", x: lands.x, y: lands.y - GRID, props: { ref: "R1" } }
          if (at(resistor, "1").x !== lands.x || at(resistor, "1").y !== lands.y) continue
          const { doc, notes } = legacyUpgraded(old([part, resistor]))
          cases++
          expect.soft(connected(doc), `${def} ${rotation}° ${pin}: nothing joined`).toEqual([])
          expect.soft(notes.length > 0, `${def} ${rotation}° ${pin}: the move is told`).toBe(true)
        }
    expect.soft(cases, "cases").toBeGreaterThan(20)
  })

  it("two oscillators whose OUTs touched before meet still: a wire joins them now", () => {
    const a = placedAs("oscillator", upright(0), 0, 0, "G1")
    const b = placedAs("oscillator", upright(180), 4, 0, "G2")
    const { doc, notes } = legacyUpgraded(old([a, b]))
    expect.soft(connected(doc), "G1's OUT with G2's").toEqual([["G1:OUT", "G2:OUT"]])
    expect.soft(notes.some((n) => n.includes("touched where they stood before")), "told").toBe(true)
  })

  it("parts on their diagonals that do not interact at first never meet each other on different nets", () => {
    const a = placedAs("resistor", upright(45), 0, 0, "A")
    const b = placedAs("resistor", upright(45), 4, 5, "B")
    const grounds = ([[0, 0], [0, 1], [1, 0], [1, 1], [5, 6], [4, 6], [5, 5]] as const).map(([x, y], i) => groundOn(`G${i}`, { x: c(x), y: c(y) }))
    const { doc } = legacyUpgraded(old([a, b, ...grounds]))
    expect.soft(connected(doc).filter((g) => g.some((k) => k.startsWith("A:") || k.startsWith("B:"))), "A and B join nothing").toEqual([])
  })

  it("a part whose sixteen nearest squares all touch another net goes farther, joins nothing and says so", () => {
    const r = placedAs("resistor", upright(45), 0, 0, "R1")
    const grounds: PlacedObject[] = []
    for (let x = -1; x <= 2; x++) for (let y = -1; y <= 2; y++) grounds.push(groundOn(`G${x}${y}`, { x: c(x), y: c(y) }))
    const { doc, notes } = legacyUpgraded(old([r, ...grounds]))
    expect.soft(connected(doc).filter((g) => g.some((k) => k.startsWith("R1:"))), "R1 joins nothing").toEqual([])
    expect.soft(notes.some((n) => n.includes("R1")), "the note names R1").toBe(true)
  })

  it("a contact an old file made between two diagonal parts survives when one of them turns: a wire joins them", () => {
    const crystal = placedAs("crystal", upright(45), 0, 0, "Y1")
    const pot = placedAs("potentiometer", upright(45), 0, 0, "RV1")
    const { doc } = legacyUpgraded(old([crystal, pot]))
    expect.soft(connected(doc), "both ends still on the pot's ends").toEqual([["RV1:1", "Y1:1"], ["RV1:2", "Y1:2"]])
  })

  it("two diodes an old file stacked head to tail on one diagonal stay stacked, their contacts kept without a wire", () => {
    const d1 = placedAs("diode", upright(45), 2, 2, "D1")
    const d2 = placedAs("diode", upright(225), 2, 2, "D2")
    const { doc, notes } = legacyUpgraded(old([d1, d2]))
    expect.soft(connected(doc), "anode on cathode both ways, as before").toEqual([["D1:1", "D2:2"], ["D1:2", "D2:1"]])
    expect.soft(doc.wires, "no wire needed").toEqual([])
    expect.soft(notes, "nothing to tell").toEqual([])
  })

  it("a contact an old file made between a diagonal pin and an ordinary one, off the grid, survives", () => {
    const q = placedAs("npn", upright(45), 0, 0, "Q1")
    const def = getDef("npn")!
    const box = (def.width + def.height) * Math.SQRT1_2
    const base = def.pins.find((p) => p.id === "B")!
    const turned = { x: (base.x - def.width / 2) * Math.SQRT1_2 - (base.y - def.height / 2) * Math.SQRT1_2, y: (base.x - def.width / 2) * Math.SQRT1_2 + (base.y - def.height / 2) * Math.SQRT1_2 }
    const b = { x: (box / 2 + turned.x) * GRID, y: (box / 2 + turned.y) * GRID }
    const resistor: PlacedObject = { id: "R1", def: "resistor", x: b.x - 4 * GRID, y: b.y - GRID, props: { ref: "R1" } }
    const { doc } = legacyUpgraded(old([q, resistor]))
    expect.soft(connected(doc), "Q1's base still on R1's pin 2").toEqual([["Q1:B", "R1:2"]])
  })

  it("a wire from an NC pad to a pin that now meets it stays, since touching would not join them", () => {
    const board: PlacedObject = { id: "U1", def: "netduino-plus-2", x: 0, y: 0, props: { ref: "U1" } }
    const pad = at(board, "NC")
    const r1 = placedAs("resistor", upright(45), pad.x / GRID - 1, pad.y / GRID - 1, "R1")
    const wire = { id: "w", from: { object: "R1", pin: "1" }, to: { object: "U1", pin: "NC" } }
    const { doc } = legacyUpgraded(old([board, r1], [wire]))
    const moved = doc.objects.find((o) => o.id === "R1")!
    expect.soft(at(moved, "1"), "R1's pin 1 now on the NC pad").toEqual(pad)
    expect.soft(doc.wires.map((w) => w.id), "the wire to the NC pad stays").toEqual(["w"])
    expect.soft(connected(doc), "R1 on the pad by its wire, as before").toEqual([["R1:1", "U1:NC"]])
  })

  it("a long chain of diagonal parts, one cluster too big to try every way, still joins nothing new", () => {
    const parts = Array.from({ length: 40 }, (_, i) => placedAs("resistor", upright(45), 3 * i, 3 * i, `R${i + 1}`))
    const { doc } = legacyUpgraded(old(parts))
    expect.soft(connected(doc), "no contacts").toEqual([])
    for (const o of doc.objects) for (const { point } of objectPins(o, GRID)) expect.soft([whole(point.x / GRID), whole(point.y / GRID)], `${o.props?.ref} on the grid`).toEqual([true, true])
  })
})

describe("a paste from an older εmul turns a part off a diagonal before it looks for room (phase 2 review)", () => {
  it("the part lands where the room was found and nowhere it would be refused", () => {
    const resistor = placedAs("resistor", upright(0), -1, 4, "R9")
    const doc: Schematic = { objects: [resistor], wires: [], parts: {} }
    const clip: Clip = { objects: [placedAs("npn", upright(45), 0, 0, "Q1")], wires: [], parts: {} }
    const { clip: landing, at: spot } = pasteLanding({ objects: doc.objects, routes: [], grid: GRID }, clip, { x: GRID, y: GRID })
    expect.soft(landing.objects[0].rotation ?? 0, "turned before anything else").toBe(0)
    const pasted = pastedInto(doc, landing, spot.x, spot.y, () => "Q2", () => "w")
    const q = pasted.objects.find((o) => o.id === "Q2")!
    expect.soft([q.x, q.y, q.rotation ?? 0], "where the room was found").toEqual([landing.objects[0].x + spot.x, landing.objects[0].y + spot.y, 0])
    expect.soft(placementCheck({ objects: pasted.objects, routes: [], grid: GRID }, [q])(0, 0), "not refused where it landed").toBe(false)
    expect.soft(objectRect(q, GRID).w, "a right-angle box").toBe(objectRect({ ...q, rotation: undefined }, GRID).w)
  })
})

describe("an old file's HDL parts are known while it is upgraded, though the field has not loaded its library yet (phase 2 review)", () => {
  const file = (objects: PlacedObject[]) => JSON.stringify({ objects, wires: [], parts: {}, library: [INVERTER], version: 2 })

  it("a diagonal part next to an HDL part does not land its pin on the HDL part's input", () => {
    setLibrary([])
    const { doc } = parseProject(file([{ id: "U1", def: "hdl:inv", x: 0, y: 0, props: { ref: "U1" } }, { id: "R1", def: "resistor", x: c(-3), y: c(-3), rotation: 45, props: { ref: "R1" } }]))!
    setLibrary([INVERTER])
    expect.soft(connectedNow(doc), "R1 touches nothing of U1").toEqual([])
    setLibrary([])
  })

  it("an HDL part saved on a diagonal turns to a right angle, and its pins are there once the field loads the library", () => {
    setLibrary([])
    const { doc, notes } = parseProject(file([{ id: "U1", def: "hdl:inv", x: 0, y: 0, rotation: 45, props: { ref: "U1" } }, { id: "R1", def: "resistor", x: c(9), y: 0, rotation: 45, props: { ref: "R1" } }]))!
    const u1 = doc.objects.find((o) => o.id === "U1")!
    expect.soft((u1.rotation ?? 0) % 90, "U1 on a right angle").toBe(0)
    expect.soft(notes.some((n) => n.startsWith("U1 stood at 45°")), "and named").toBe(true)
    setLibrary([INVERTER])
    expect.soft(objectPins(u1, GRID).map((p) => p.pin.id).sort(), "U1's pins on the field").toEqual(["GND", "VCC", "a", "y"])
    setLibrary([])
  })
})

describe("the upgrade's finer rules (phase 2 review)", () => {
  it("a wire between two pins that already met, on parts the upgrade does not move, is left alone", () => {
    const a = placedAs("resistor", upright(0), 0, 0, "R1")
    const b = placedAs("resistor", upright(0), 4, 0, "R2")
    const wire = { id: "w", from: { object: "R1", pin: "2" }, to: { object: "R2", pin: "1" } }
    const { doc } = legacyUpgraded(old([a, b, placedAs("led", upright(45), 10, 10, "LED1")], [wire]))
    expect.soft(doc.wires.map((w) => w.id), "the wire stays").toEqual(["w"])
  })

  it("a meter an old file left on its diagonal takes the square nearest the old middle of its pins, though its pins sit off its box's middle", () => {
    for (const rotation of [45, 135, 225, 315] as Rotation[])
      for (const mirror of [false, true])
      for (const [x, y] of [[5, 5], [5, 6], [6, 5], [6, 6], [7, 4]]) {
        const meter = { ...placedAs("voltmeter", { rotation, mirror }, x, y, "PV1") }
        const { doc } = legacyUpgraded(old([meter]))
        const moved = doc.objects[0]
        const [plus, minus] = [before(meter, "+"), before(meter, "-")]
        const middle = { x: (plus.x + minus.x) / 2 / GRID, y: (plus.y + minus.y) / 2 / GRID }
        expect.soft([moved.x / GRID, moved.y / GRID], `${rotation}${mirror ? "m" : ""} at (${x}, ${y}): the square round the old middle`).toEqual([Math.round(middle.x - 1.5), Math.round(middle.y - 1.5)])
      }
  })

  it("a multi-pin part whose turn back would touch another net turns forward instead", () => {
    const q = placedAs("npn", upright(45), 4, 4, "Q1")
    const back = migrated(q)
    const emitter = at(back, "E")
    const ground = groundOn("GND", emitter)
    const { doc, notes } = legacyUpgraded(old([q, ground]))
    const turned = doc.objects.find((o) => o.id === "Q1")!
    expect.soft(turned.rotation ?? 0, "turned forward to 90°").toBe(90)
    expect.soft(connected(doc), "the emitter left off the ground").toEqual([])
    expect.soft(notes, "named").toEqual(["Q1 stood at 45°, which it cannot take now: turned to 90°."])
  })

  it("a part with no clean square in the 64 nearest goes as far as it must, onto a spot clear of every part, keeps the circuit and says how far", () => {
    const r = placedAs("resistor", upright(45), 0, 0, "R1")
    const grounds: PlacedObject[] = []
    for (let x = -5; x <= 7; x++) for (let y = -5; y <= 7; y++) grounds.push(groundOn(`G${x}_${y}`, { x: c(x), y: c(y) }))
    const { doc, notes } = legacyUpgraded(old([r, ...grounds]))
    const moved = doc.objects.find((o) => o.id === "R1")!
    expect.soft(touchingAny(doc, "R1"), "R1's ends on no ground").toEqual([])
    expect.soft(grounds.filter((g) => overlap(objectRect(g, GRID), objectRect(moved, GRID))).map((g) => g.id), "on no ground's body").toEqual([])
    const away = Number(/^R1 moved (\d+) cells onto the grid/.exec(notes.join(" "))?.[1])
    expect.soft(away, "said how far: past the ring of grounds").toBeGreaterThan(4)
    expect.soft(notes.some((n) => n.includes("could not be kept")), "nothing left unkept").toBe(false)
  })

  it("old pins chained closer than the old tolerance stay one net, however the file orders them", () => {
    const four = (step: number) =>
      [0, 3, 1, 2].map((k): PlacedObject => ({ id: `R${k}`, def: "resistor", x: k * step, y: 0, rotation: 45, props: { ref: `R${k}` } }))
    expect.soft(connected(legacyUpgraded(old(four(0.006))).doc), "0.006 px apart: both ends of all four joined, as before").toEqual([
      ["R0:1", "R1:1", "R2:1", "R3:1"],
      ["R0:2", "R1:2", "R2:2", "R3:2"],
    ])
    expect.soft(connected(legacyUpgraded(old(four(0.0099))).doc), "0.0099 px apart: joined").toEqual([
      ["R0:1", "R1:1", "R2:1", "R3:1"],
      ["R0:2", "R1:2", "R2:2", "R3:2"],
    ])
    expect.soft(connected(legacyUpgraded(old(four(0.0101))).doc), "0.0101 px apart: never touched, still apart").toEqual([])
  })

  it("a pin now on the grid meets no old pin within the old tolerance of it", () => {
    const resistorAt = (x: number): PlacedObject => ({ id: "R", def: "resistor", x, y: c(1), props: { ref: "R" } })
    const oscillator = placedAs("oscillator", upright(0), 0, 0, "A")
    for (const off of [0.006, 0.0099]) {
      const { doc, notes } = legacyUpgraded(old([oscillator, resistorAt(c(4) + off)]))
      expect.soft(connected(doc), `${off} px off the grid: OUT keeps off R`).toEqual([])
      expect.soft(notes, `${off} px: A moves and says so`).toEqual(["A moved 1 cell: its pins, now on the grid, would have touched another net's where it stood."])
    }
    const { doc, notes } = legacyUpgraded(old([oscillator, resistorAt(c(4) + 0.0101)]))
    expect.soft(connected(doc), "0.0101 px off: apart").toEqual([])
    expect.soft(notes, "0.0101 px off: A stays where it stood").toEqual([])
  })

  it("the search takes back an earlier part's square when a later part has nowhere else to go", () => {
    const a = placedAs("resistor", upright(45), 0, 0, "A")
    const b = placedAs("resistor", upright(45), 2, 2, "B")
    const grounds: PlacedObject[] = []
    for (let x = -1; x <= 6; x++) for (let y = -1; y <= 6; y++) if (!(x === 1 && y === 1) && !(x === 4 && y === 4)) grounds.push(groundOn(`G${x}_${y}`, { x: c(x), y: c(y) }))
    const { doc, notes } = legacyUpgraded(old([a, b, ...grounds]))
    expect.soft([...touchingAny(doc, "A"), ...touchingAny(doc, "B")], "A and B on no ground").toEqual([])
    for (const [id, was] of [["A", a], ["B", b]] as const) {
      const now = doc.objects.find((o) => o.id === id)!
      expect.soft(Math.max(Math.abs(now.x - was.x), Math.abs(now.y - was.y)) / GRID, `${id} within the 64 nearest squares`).toBeLessThanOrEqual(4)
    }
    expect.soft(notes.some((n) => n.includes("could not be kept")), "nothing left unkept").toBe(false)
  })

  it("two parts after one square: the one with a near second choice yields it to the one without", () => {
    const def = getDef("resistor")!
    const half = ((def.width + def.height) * Math.SQRT1_2) / 2
    const centredAt = (id: string, mx: number, my: number): PlacedObject => ({ id, def: "resistor", x: (mx - half) * GRID, y: (my - half) * GRID, rotation: 45, props: { ref: id } })
    const { doc } = legacyUpgraded(old([centredAt("A", 11.9, 11.5), centredAt("B", 11.5, 11.5)]))
    const square = (id: string) => [doc.objects.find((o) => o.id === id)!.x / GRID, doc.objects.find((o) => o.id === id)!.y / GRID]
    expect.soft(square("B"), "B keeps the square round its old middle").toEqual([10, 10])
    expect.soft(square("A"), "A takes its second, a cell to the right").toEqual([11, 10])
    expect.soft(connected(doc), "and they do not meet").toEqual([])
  })
})

describe("a part whose definition arrives after its pins were first asked for gets its pins (phase 2 review)", () => {
  it("an HDL part asked before its library is loaded has no pins, and all of them once it is", () => {
    setLibrary([])
    const u1: PlacedObject = { id: "U1", def: "hdl:inv", x: 0, y: 0, props: { ref: "U1" } }
    expect.soft(objectPins(u1, GRID), "unknown, no pins").toEqual([])
    setLibrary([INVERTER])
    expect.soft(objectPins(u1, GRID).map((p) => p.pin.id).sort(), "known, all of them").toEqual(["GND", "VCC", "a", "y"])
    setLibrary([])
  })

  it("an HDL part whose module is rebuilt with another port shows the new port, standing where it stood", () => {
    const u1: PlacedObject = { id: "U1", def: "hdl:inv", x: 0, y: 0, props: { ref: "U1" } }
    setLibrary([INVERTER])
    expect.soft(objectPins(u1, GRID).map((p) => p.pin.id).sort(), "the inverter's pins").toEqual(["GND", "VCC", "a", "y"])
    setLibrary([WITH_ENABLE])
    expect.soft(objectPins(u1, GRID).map((p) => p.pin.id).sort(), "the rebuilt module's pins").toEqual(["GND", "VCC", "a", "en", "y"])
    setLibrary([])
  })
})
