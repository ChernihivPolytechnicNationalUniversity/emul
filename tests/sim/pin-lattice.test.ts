import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ComponentView } from "@/components/field/ComponentView"
import { fieldDetail } from "@/components/field/detail"
import type { FieldPalette } from "@/components/field/field-palette"
import { SelectionLayer } from "@/components/field/SelectionLayer"
import { SymbolRaster } from "@/components/field/symbol-raster"
import { readProjectFile } from "@/project/project-store"
import { builder } from "@/schematic/builder"
import { MODULE_PAD } from "@/schematic/components/open746i-c-art"
import { examples } from "@/schematic/examples"
import { blocksOf } from "@/schematic/printed-text"
import { allowedRotations, bodyCentre, diagonalSquare, DIR, drawnBody, framePoint, GRID, isDiagonal, objectPins, objectRect, objectSize, orientPin, stretchedLeads, type Orientation, type Point, type Turn } from "@/schematic/geometry"
import { migrated, SCHEMATIC_VERSION, upgraded } from "@/schematic/migrate"
import { buildNets } from "@/schematic/nets"
import { rotateSelection } from "@/schematic/orient"
import { footprint, placementCheck, type PlacementScene } from "@/schematic/placement"
import { getDef, registry } from "@/schematic/registry"
import type { ComponentDef, PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { SimStore } from "@/sim/sim-store"

vi.mock("@/sim/sim-store", async (original) => ({
  ...(await original<typeof import("@/sim/sim-store")>()),
  useObjectSim: () => ({ live: false, parts: {} }),
  useObjectReadings: () => [],
}))

const ROOT = join(import.meta.dirname, "..", "..")
const c = (v: number) => v * GRID
const whole = (v: number) => Math.abs(v - Math.round(v)) < 1e-9
const half = (v: number) => whole(v * 2)
const orientationsOf = (def: ComponentDef): Orientation[] => allowedRotations(def).flatMap((rotation) => [{ rotation, mirror: false }, { rotation, mirror: true }])
const diagonalOrientations: Orientation[] = ([45, 135, 225, 315] as Rotation[]).flatMap((rotation) => [{ rotation, mirror: false }, { rotation, mirror: true }])
const placedAs = (def: string, o: Orientation, x = 0, y = 0, ref?: string): PlacedObject => ({ id: ref ?? def, def, x: c(x), y: c(y), ...(o.rotation && { rotation: o.rotation }), ...(o.mirror && { mirror: true }), ...(ref && { props: { ref } }) })
const scene = (objects: PlacedObject[]): PlacementScene => ({ objects, wires: [], routes: [], grid: GRID })
const at = (o: PlacedObject, pin: string) => objectPins(o, GRID).find((p) => p.pin.id === pin)!.point
const cells = (p: Point) => ({ x: p.x / GRID, y: p.y / GRID })
const leadEnds = (path: string) => [...path.matchAll(/L(-?[\d.e-]+) (-?[\d.e-]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
const diagonalParts = registry.filter((def) => diagonalSquare(def) !== null)

const STANDS_ON_A_DIAGONAL = ["ac-source", "ammeter", "battery", "capacitor", "capacitor-polarized", "crystal", "dc-source", "diode", "inductor", "led", "polyfuse", "pulse-source", "pushbutton", "resistor", "switch", "voltmeter", "zener"]
const HALF_CELL_BOARDS = ["open746i-c", "weact-blackpill-f401cc", "weact-blackpill-f401ce", "weact-blackpill-f411"]

describe("every pin on the lattice, in every orientation a part allows (design.md §4.2, P1)", () => {
  it("every pin of every symbol lies on a whole cell; a board's sockets may lie on half cells, still the lattice a wire connects on", () => {
    const off: string[] = []
    for (const def of registry)
      for (const o of orientationsOf(def))
        for (const pin of def.pins) {
          const p = orientPin(pin, def, o)
          const onIt = def.pinsAreSockets ? half(p.x) && half(p.y) : whole(p.x) && whole(p.y)
          if (!onIt) off.push(`${def.id} ${o.rotation}${o.mirror ? "m" : ""} ${pin.id} (${p.x}, ${p.y})`)
        }
    expect.soft(off.slice(0, 20), "pins off the lattice").toEqual([])
  })

  it("only the Black Pills' SWD header and the Open746I-C's three test pads use the half cell", () => {
    const halfCell = registry.filter((def) => def.pins.some((pin) => !whole(pin.x) || !whole(pin.y))).map((def) => def.id)
    expect.soft(halfCell.sort(), "definitions with a pin on a half cell").toEqual(HALF_CELL_BOARDS)
    const board = getDef("open746i-c")!
    const pads = board.pins.filter((pin) => !whole(pin.x) || !whole(pin.y)).map((pin) => `${pin.id} (${pin.x}, ${pin.y})`)
    expect.soft(pads, "the Open746I-C's test pads, snapped").toEqual(["VBAT (18.5, 12.5)", "VREF+ (19.5, 12.5)", "BOOT0 (15, 33.5)"])
  })

  it("the six symbols that broke it keep their pins on whole cells now: the oscillator's OUT, the chips' GND and VM, the 0.91-inch OLED's box", () => {
    const pin = (def: string, id: string) => getDef(def)!.pins.find((p) => p.id === id)!
    expect.soft([pin("oscillator", "OUT").x, pin("oscillator", "OUT").y], "oscillator OUT").toEqual([4, 2])
    for (const chip of ["tp4056", "mt3608", "lp2985"]) expect.soft(pin(chip, "GND").x, `${chip} GND`).toBe(5)
    expect.soft([pin("dw03", "GND").y, pin("dw03", "VM").y], "dw03 GND and VM").toEqual([4, 4])
    expect.soft(getDef("oled-ssd1306-i2c-32")!.height, "the 0.91-inch OLED's box, whole cells so a turned pin stays on one").toBe(6)
    const lead = getDef("oscillator")!.body.find((s) => s.type === "path" && s.d.includes("H4"))
    expect.soft(lead?.type === "path" && lead.d.includes("M3.5 2 H4"), "the oscillator's OUT lead drawn to the pin").toBe(true)
  })

  it("the Open746I-C's drawing moves with its pads: BOOT0's pad dot is drawn under its pin, and the POWER JMP block is centred on its four pins", () => {
    const board = getDef("open746i-c")!
    const pin = (id: string) => board.pins.find((p) => p.id === id)!
    const dots = board.body.flatMap((s) => (s.type === "art" ? s.d.split(/(?=M)/) : [])).flatMap((sub) => {
      const m = /^M([-\d.]+) ([-\d.]+)A([\d.]+) \3 0 1 0 /.exec(sub)
      return m ? [{ x: Number(m[1]) + Number(m[3]), y: Number(m[2]) }] : []
    })
    const nearest = (p: Point) => Math.min(...dots.map((d) => Math.hypot(d.x - p.x, d.y - p.y)))
    expect.soft(nearest(pin("BOOT0")), "a pad dot under BOOT0, cells").toBeLessThan(1e-6)
    expect.soft(Math.hypot(MODULE_PAD.boot0.x - 4.7, MODULE_PAD.boot0.y - 70.5), "the module's left pads moved from the photo by no more than a quarter cell each way, mm").toBeLessThanOrEqual((Math.SQRT2 * 2.54) / 4)
    const block = blocksOf(board.body).find((b) => b.fill === "connector" && b.box.x < pin("VBAT").x && b.box.x + b.box.w > pin("VREF+").x && b.box.y < pin("VBAT").y && b.box.y + b.box.h > pin("VBAT").y)
    expect.soft(block, "the POWER JMP block").toBeDefined()
    if (!block) return
    expect.soft(block.box.x + block.box.w / 2, "its middle between VBAT and VREF+").toBeNear((pin("VBAT").x + pin("VREF+").x) / 2, 1e-6)
    expect.soft(block.box.y + block.box.h / 2, "its middle between the rail row and the pin row").toBeNear(pin("VBAT").y - 0.5, 1e-6)
  })
})

describe("the 3 × 3 diagonal (design.md §4.3)", () => {
  it("exactly the 17 two-terminal parts whose 4-cell span rounds cleanly stand on a diagonal; the buzzers, the serial terminal and every multi-pin part turn in right angles", () => {
    expect.soft(diagonalParts.map((def) => def.id).sort(), "parts that stand on a diagonal").toEqual(STANDS_ON_A_DIAGONAL)
    for (const id of ["buzzer-tmb12a05", "serial-terminal", "npn", "oscillator", "open746i-c", "potentiometer"]) expect.soft(allowedRotations(getDef(id)!), `${id} turns in right angles`).toEqual([0, 90, 180, 270])
    for (const def of diagonalParts) expect.soft(allowedRotations(def), def.id).toEqual([0, 45, 90, 135, 180, 225, 270, 315])
  })

  it("on a diagonal such a part's box is a 3 × 3 square and its pins are opposite corners of it, facing out of the square", () => {
    for (const def of diagonalParts)
      for (const o of diagonalOrientations) {
        const name = `${def.id} ${o.rotation}${o.mirror ? "m" : ""}`
        expect.soft(objectSize(def, o.rotation), `${name}: the box`).toEqual({ w: 3, h: 3 })
        const [a, b] = def.pins.map((pin) => orientPin(pin, def, o))
        for (const p of [a, b]) {
          expect.soft([0, 3].includes(p.x) && [0, 3].includes(p.y), `${name} ${p.id}: on a corner (${p.x}, ${p.y})`).toBe(true)
          expect.soft([DIR[p.side].x * (p.x - 1.5) > 0, DIR[p.side].y * (p.y - 1.5) > 0], `${name} ${p.id}: faces out of the square`).toEqual([true, true])
        }
        expect.soft([a.x + b.x, a.y + b.y], `${name}: opposite corners`).toEqual([3, 3])
      }
  })

  it("the drawing turns about the middle of its pins, the middle of the square, and each lead runs on by (3√2 − 4)/2 ≈ 0.121 cell to its corner", () => {
    const reach = (3 * Math.SQRT2 - 4) / 2
    for (const def of diagonalParts)
      for (const o of diagonalOrientations) {
        const name = `${def.id} ${o.rotation}${o.mirror ? "m" : ""}`
        const [a, b] = def.pins
        const middle = framePoint(def, o, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
        expect.soft(middle.x, `${name}: middle of the pins, x`).toBeNear(1.5, 1e-9)
        expect.soft(middle.y, `${name}: middle of the pins, y`).toBeNear(1.5, 1e-9)
        const stretch = stretchedLeads(def, o)
        expect.soft(drawnBody(def, o).some((s) => s.type === "path" && s.d === stretch), `${name}: the stretch is drawn with the body`).toBe(true)
        for (const pin of def.pins) {
          const end = { x: pin.x + DIR[pin.side].x * reach, y: pin.y + DIR[pin.side].y * reach }
          const corner = orientPin(pin, def, o)
          const drawn = framePoint(def, o, end)
          expect.soft(Math.hypot(drawn.x - corner.x, drawn.y - corner.y), `${name} ${pin.id}: the stretched lead ends on the pin`).toBeLessThan(1e-9)
          expect.soft(leadEnds(stretch).some((p) => Math.hypot(p.x - end.x, p.y - end.y) < 1e-9), `${name} ${pin.id}: the drawn stretch reaches that far`).toBe(true)
        }
      }
    for (const def of diagonalParts) for (const rotation of [0, 90, 180, 270] as Rotation[]) expect.soft(stretchedLeads(def, { rotation, mirror: false }), `${def.id} ${rotation}: no stretch on a right angle`).toBe("")
  })

  it("the meters, whose pins sit off the middle of their box, still put the middle of their pins in the middle of the square", () => {
    for (const id of ["voltmeter", "ammeter"]) {
      const def = getDef(id)!
      const o = { rotation: 45 as Rotation, mirror: false }
      expect.soft(bodyCentre(def, o).x !== 1.5 || bodyCentre(def, o).y !== 1.5, `${id}: its drawing is not centred on the square`).toBe(true)
      expect.soft(def.pins.map((pin) => orientPin(pin, def, o)).map((p) => [p.x, p.y]), `${id}: pins on the corners`).toEqual([[0, 0], [3, 3]])
    }
  })

  it("a part's footprint on its diagonal stays inside its square, so parts on squares that only touch never overlap", () => {
    for (const def of diagonalParts)
      for (const o of diagonalOrientations) {
        const object = placedAs(def.id, o, 4, 4)
        const box = objectRect(object, GRID)
        for (const p of footprint(object, GRID)!.corners) expect.soft(p.x >= box.x - 1e-6 && p.x <= box.x + box.w + 1e-6 && p.y >= box.y - 1e-6 && p.y <= box.y + box.h + 1e-6, `${def.id} ${o.rotation}${o.mirror ? "m" : ""}: footprint corner (${p.x / GRID}, ${p.y / GRID}) inside the square`).toBe(true)
      }
  })
})

const diamond = (): PlacedObject[] => [
  placedAs("diode", { rotation: 315, mirror: false }, 0, 0, "D1"),
  placedAs("diode", { rotation: 225, mirror: false }, 3, 0, "D2"),
  placedAs("diode", { rotation: 225, mirror: false }, 0, 3, "D3"),
  placedAs("diode", { rotation: 315, mirror: false }, 3, 3, "D4"),
]

describe("a diode bridge built by hand (design.md §4.3, junctions.md 20)", () => {
  it("four diodes on 3 × 3 diagonals make a diamond whose corners are exact contacts, each joining one anode to one cathode, or the two cathodes and the two anodes at the rails", () => {
    const [d1, d2, d3, d4] = diamond()
    const corner = (p: Point) => `(${p.x / GRID}, ${p.y / GRID})`
    expect.soft([at(d1, "1"), at(d3, "2")].map(corner), "L: D1's anode on D3's cathode").toEqual(["(0, 3)", "(0, 3)"])
    expect.soft([at(d1, "2"), at(d2, "2")].map(corner), "T: the two cathodes, the + rail").toEqual(["(3, 0)", "(3, 0)"])
    expect.soft([at(d2, "1"), at(d4, "2")].map(corner), "R: D2's anode on D4's cathode").toEqual(["(6, 3)", "(6, 3)"])
    expect.soft([at(d3, "1"), at(d4, "1")].map(corner), "B: the two anodes, the − rail").toEqual(["(3, 6)", "(3, 6)"])
    const nets = buildNets(diamond(), [], GRID)
    const same = (a: string, b: string) => nets.netOfPin(a) !== undefined && nets.netOfPin(a) === nets.netOfPin(b)
    expect.soft([same("D1:1", "D3:2"), same("D1:2", "D2:2"), same("D2:1", "D4:2"), same("D3:1", "D4:1")], "every corner a contact").toEqual([true, true, true, true])
    expect.soft(same("D1:1", "D1:2"), "no corner shorts a diode").toBe(false)
  })

  it("placement lets each diode of the diamond stand where it is, and refuses a fifth on top of one", () => {
    const parts = diamond()
    for (const d of parts) expect.soft(placementCheck(scene(parts), [d])(0, 0), `${d.props?.ref} in the diamond`).toBe(false)
    const fifth = placedAs("diode", { rotation: 315, mirror: false }, 0, 0, "D5")
    expect.soft(placementCheck(scene([...parts, fifth]), [fifth])(0, 0), "a fifth diode on D1").toBe(true)
  })

  it("dragged in from beside the diamond, the fourth diode is let down on its corner", () => {
    const [d1, d2, d3, d4] = diamond()
    const away = { ...d4, x: d4.x + c(5), y: d4.y + c(2) }
    const check = placementCheck(scene([d1, d2, d3, away]), [away])
    expect.soft(check(-c(5), -c(2)), "dropped on its corner").toBe(false)
  })
})

describe("LEDs butt pin to pin at 0°, 90° and on the diagonal (design.md §12)", () => {
  const pairs: [string, PlacedObject, PlacedObject][] = [
    ["0°", placedAs("led", { rotation: 0, mirror: false }, 0, 0, "LED1"), placedAs("led", { rotation: 0, mirror: false }, 4, 0, "LED2")],
    ["90°", placedAs("led", { rotation: 90, mirror: false }, 0, 0, "LED1"), placedAs("led", { rotation: 90, mirror: false }, 0, 4, "LED2")],
    ["45°", placedAs("led", { rotation: 45, mirror: false }, 0, 0, "LED1"), placedAs("led", { rotation: 45, mirror: false }, 3, 3, "LED2")],
    ["315°", placedAs("led", { rotation: 315, mirror: false }, 0, 3, "LED1"), placedAs("led", { rotation: 315, mirror: false }, 3, 0, "LED2")],
  ]
  it.each(pairs)("at %s the cathode lands exactly on the next anode, placement allows it and the two meet", (_, a, b) => {
    expect.soft(at(a, "2"), "LED1's cathode on LED2's anode").toEqual(at(b, "1"))
    expect.soft(placementCheck(scene([a, b]), [b])(0, 0), "placement").toBe(false)
    const nets = buildNets([a, b], [], GRID)
    expect.soft(nets.netOfPin("LED1:2") !== undefined && nets.netOfPin("LED1:2") === nets.netOfPin("LED2:1"), "in contact").toBe(true)
  })
})

describe("R turns to the next orientation the part allows (design.md §4.3, §6.6)", () => {
  const press = (o: PlacedObject, turn: Turn, times = 1) => {
    let doc: Schematic = { objects: [o], wires: [], parts: {} }
    for (let i = 0; i < times; i++) doc = rotateSelection(doc, new Set([o.id]), turn, GRID)
    return doc.objects[0]
  }

  it("R turns a two-pin part through 45° and a multi-pin part through 90°; Shift+R turns them back", () => {
    expect.soft(press(placedAs("resistor", { rotation: 0, mirror: false }), 1).rotation, "a resistor").toBe(45)
    expect.soft(press(placedAs("npn", { rotation: 0, mirror: false }), 1).rotation, "a transistor").toBe(90)
    expect.soft(press(placedAs("resistor", { rotation: 0, mirror: false }), -1).rotation, "Shift+R on a resistor").toBe(315)
    expect.soft(press(placedAs("npn", { rotation: 0, mirror: false }), -1).rotation, "Shift+R on a transistor").toBe(270)
  })

  it("a run of presses is one turn: two presses on a two-pin part leave it where one right-angle turn would, R then Shift+R gives the very part back, and a full turn never drifts", () => {
    for (const def of registry) {
      const steps = allowedRotations(def).length
      for (const start of [0, 90, 180, 270] as Rotation[]) {
        const part = placedAs(def.id, { rotation: start, mirror: false }, 10, 10)
        const back = press(press(part, 1), -1)
        expect.soft([back.x, back.y, back.rotation ?? 0], `${def.id} ${start}: R then Shift+R`).toEqual([part.x, part.y, start])
        const around = press(part, 1, steps)
        expect.soft([around.x, around.y, around.rotation ?? 0], `${def.id} ${start}: a full turn`).toEqual([part.x, part.y, start])
        const right = press(part, 1, steps / 4)
        const box = objectSize(def, start)
        const turned = objectSize(def, right.rotation ?? 0)
        const middle = (o: PlacedObject, size: { w: number; h: number }) => ({ x: o.x / GRID + Math.floor(size.w / 2), y: o.y / GRID + Math.floor(size.h / 2) })
        expect.soft(middle(right, turned), `${def.id} ${start}: one right angle turns about the same cell`).toEqual(middle(part, box))
      }
    }
  })

  it("a part on its diagonal sits half a cell right of and below the middle it turned about", () => {
    const upright = placedAs("resistor", { rotation: 0, mirror: false }, 10, 10)
    const diagonal = press(upright, 1)
    const middleOfPins = (o: PlacedObject) => {
      const [a, b] = objectPins(o, GRID).map((p) => cells(p.point))
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }
    expect.soft(middleOfPins(diagonal), "the square's middle").toEqual({ x: middleOfPins(upright).x + 0.5, y: middleOfPins(upright).y + 0.5 })
  })
})

const OLD = join(ROOT, "tests", "data", "emul-1.42.0")

async function rawOld(file: string): Promise<Schematic> {
  const { Zstd } = await import("@hpcc-js/wasm-zstd")
  const bytes = (await Zstd.load()).decompress(new Uint8Array(readFileSync(join(OLD, file))))
  return (JSON.parse(new TextDecoder().decode(bytes)) as { schematic: Schematic }).schematic
}

async function opened(file: string) {
  const read = await readProjectFile(new Blob([readFileSync(join(OLD, file))]))
  if (!read) throw new Error(`${file} does not read`)
  return read
}

const refOf = (doc: Schematic, id: string) => doc.objects.find((o) => o.id === id)?.props?.ref

describe("an old file's diagonal parts move onto the lattice without changing the circuit (design.md §10 item 1; the user, 2026-11-04: old projects must keep working)", () => {
  it("an old power supply's bridge closes: every diode moves under a cell, the four corners meet pin to pin and the four wires between them go", async () => {
    const before = await rawOld("power-supply.emul")
    const { doc, notes } = await opened("power-supply.emul")
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
    const run = (d: Schematic) => {
      const loop = new SimLoop()
      loop.setDoc(d)
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
    const nets = buildNets(doc.objects, doc.wires, GRID)
    expect.soft(doc.objects.flatMap((o) => objectPins(o, GRID)).filter((p) => nets.netOfPin(p.key) !== undefined).map((p) => p.key), "pins in contact").toEqual([])
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
    expect.soft(notes, "the note").toEqual(["Q1 stood at 45°, where only a two-pin part can stand now: turned to 0°."])
  })

  it("a file without diagonal parts comes through untouched, and an upgraded file is not upgraded again", () => {
    const plain = examples.find((e) => e.id === "battery-life")!.build(GRID)
    expect.soft(upgraded({ ...plain, version: 2 } as Schematic).doc.objects, "nothing to move").toBe(plain.objects)
    const { doc } = upgraded({ ...diamondOld(), version: 2 } as Schematic)
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

function diamondOld(): Schematic {
  const { doc, place } = builder(GRID)
  for (const [x, y, rotation] of [[0, 0, 315], [5, 0, 45], [0, 3, 45], [5, 3, 315]] as [number, number, Rotation][]) place("led", x, y, { value: "red" }, rotation)
  return doc
}

const palette: FieldPalette = {
  theme: "lattice",
  body: {
    board: { fill: "white", stroke: "grey" },
    zone: { fill: "lightgrey", stroke: "grey" },
    chip: { fill: "black", stroke: "black" },
    connector: { fill: "silver", stroke: "grey" },
    foreground: { fill: "black", stroke: "black" },
    none: { fill: null, stroke: "grey" },
    grip: { fill: null, stroke: null },
  },
  pinMark: { power: "red", gnd: "black", analog: "orange", digital: "black", node: "black", nc: "grey" },
  symbolStroke: "black",
  mutedStroke: "grey",
  text: { plain: "black", muted: "grey", inverse: "white", mono: "monospace", sans: "sans-serif" },
}

type Matrix = [number, number, number, number, number, number]
const times = (m: Matrix, n: Matrix): Matrix => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
const apply = (m: Matrix, p: Point): Point => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] })
type Stroke = { parts: { d: string; scale: number }[]; m: Matrix }

function tracingCanvas(strokes: Stroke[], marks: Point[]) {
  let m: Matrix = [1, 0, 0, 1, 0, 0]
  const stack: Matrix[] = []
  const state: Record<string | symbol, unknown> = {
    save: () => stack.push(m),
    restore: () => (m = stack.pop() ?? m),
    translate: (x: number, y: number) => (m = times(m, [1, 0, 0, 1, x, y])),
    rotate: (a: number) => (m = times(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0])),
    scale: (x: number, y: number) => (m = times(m, [x, 0, 0, y, 0, 0])),
    stroke: (path?: { parts: Stroke["parts"] }) => path && strokes.push({ parts: path.parts, m }),
    fillRect: (x: number, y: number, w: number, h: number) => marks.push(apply(m, { x: x + w / 2, y: y + h / 2 })),
  }
  const context = new Proxy(state, {
    get: (target, key) => (key in target ? target[key] : () => {}),
    set: (target, key, value) => ((target[key] = value), true),
  })
  return { width: 1, height: 1, getContext: () => context }
}

describe("the stretched leads are drawn to the pins: the symbol on the field, on its canvas raster and under the selection plate", () => {
  let strokes: Stroke[] = []
  let marks: Point[] = []
  beforeEach(() => {
    strokes = []
    marks = []
    vi.stubGlobal(
      "Path2D",
      class {
        parts: Stroke["parts"]
        constructor(d?: string) {
          this.parts = d ? [{ d, scale: 1 }] : []
        }
        addPath(path: { parts: Stroke["parts"] }, matrix?: { k: number }) {
          for (const part of path.parts) this.parts.push({ d: part.d, scale: part.scale * (matrix?.k ?? 1) })
        }
      },
    )
    vi.stubGlobal(
      "DOMMatrix",
      class {
        k = 1
        scale(by: number) {
          this.k *= by
          return this
        }
      },
    )
    vi.stubGlobal("OffscreenCanvas", class { constructor() { return tracingCanvas(strokes, marks) } })
  })
  afterEach(() => vi.unstubAllGlobals())

  const cases = diagonalParts.flatMap((def) => diagonalOrientations.map((o) => [`${def.id} ${o.rotation}${o.mirror ? "m" : ""}`, def, o] as const))
  const noop = () => {}

  it.each(cases)("%s: the DOM symbol's stretched leads end on its pins", (_, def, o) => {
    const object = placedAs(def.id, o, 7, 5)
    const html = renderToStaticMarkup(
      React.createElement(ComponentView, { object, grid: GRID, detail: fieldDetail(GRID, 1, 1), sheeted: false, selected: false, parts: {}, sim: new SimStore(), onBodyPointerDown: noop, onBodyPointerMove: noop, onBodyPointerUp: noop, onBodyContextMenu: noop, onPartChange: noop }),
    )
    const style = /style="left:([-\d.e]+)px;top:([-\d.e]+)px;width:([-\d.e]+)px;height:([-\d.e]+)px;transform:rotate\((\d+)deg\)( scaleX\(-1\))?"/.exec(html)
    expect.soft(style, "the symbol is placed and turned").not.toBeNull()
    if (!style) return
    const [left, top, w, h, turn] = style.slice(1, 6).map(Number)
    const stretch = stretchedLeads(def, o)
    expect.soft(html.includes(`d="${stretch}"`), "the stretch is in the symbol").toBe(true)
    const a = (turn * Math.PI) / 180
    const onField = (p: Point) => {
      const x = (style[6] ? -1 : 1) * (p.x * GRID - w / 2)
      const y = p.y * GRID - h / 2
      return { x: left + w / 2 + x * Math.cos(a) - y * Math.sin(a), y: top + h / 2 + x * Math.sin(a) + y * Math.cos(a) }
    }
    const pins = objectPins(object, GRID).map((p) => p.point)
    for (const end of leadEnds(stretch).map(onField)) expect.soft(Math.min(...pins.map((p) => Math.hypot(p.x - end.x, p.y - end.y))), "a lead end on a pin, px").toBeLessThan(1e-6)
  })

  it.each(cases)("%s: the canvas symbol's stretched leads end on its pin marks", (_, def, o) => {
    const raster = new SymbolRaster()
    raster.setPalette(palette)
    expect.soft(raster.get(def, o, GRID, 1), "drawn").not.toBeNull()
    const stretch = stretchedLeads(def, o)
    const drawn = strokes.find((s) => s.parts.some((p) => p.d === stretch))
    expect.soft(drawn, "the stretch is stroked").toBeDefined()
    if (!drawn) return
    const part = drawn.parts.find((p) => p.d === stretch)!
    const ends = leadEnds(stretch).map((p) => apply(drawn.m, { x: p.x * part.scale, y: p.y * part.scale }))
    expect.soft(marks.length, "a mark per pin").toBe(def.pins.length)
    for (const end of ends) expect.soft(Math.min(...marks.map((p) => Math.hypot(p.x - end.x, p.y - end.y))), "a lead end on a pin mark, px").toBeLessThan(1e-6)
  })

  it.each(cases)("%s: the selection plate outlines the stretched leads up to the pins", (_, def, o) => {
    const object = placedAs(def.id, o, 7, 5)
    const html = renderToStaticMarkup(React.createElement(SelectionLayer, { objects: [object], routes: [], selectedObjects: new Set([object.id]), selectedWires: new Set(), grid: GRID }))
    const stretch = stretchedLeads(def, o)
    const plate = /<path d="([^"]*)" transform="translate\(([-\d.e]+) ([-\d.e]+)\) rotate\((\d+) ([-\d.e]+) ([-\d.e]+)\)( translate\(([-\d.e]+) 0\) scale\(-1 1\))? scale\((\d+)\)"/.exec(html)
    expect.soft(plate, "a plate").not.toBeNull()
    if (!plate) return
    expect.soft(plate[1].endsWith(stretch), "the plate outlines the stretch").toBe(true)
    const [left, top, turn, cx, cy] = plate.slice(2, 7).map(Number)
    const width = plate[8] ? Number(plate[8]) : 0
    const a = (turn * Math.PI) / 180
    const onField = (p: Point) => {
      const x = plate[7] ? width - p.x * GRID : p.x * GRID
      const y = p.y * GRID
      return { x: left + cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), y: top + cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a) }
    }
    const pins = objectPins(object, GRID).map((p) => p.point)
    for (const end of leadEnds(stretch).map(onField)) expect.soft(Math.min(...pins.map((p) => Math.hypot(p.x - end.x, p.y - end.y))), "a plate lead end on a pin, px").toBeLessThan(1e-6)
  })
})

describe("a pin name the field does not draw is no obstacle", () => {
  it("at a corner of the diamond a wire leaving one diode runs past the hidden name of the other diode's pin there", () => {
    const parts = diamond()
    const doc: Schematic = { objects: parts, wires: [], parts: {} }
    for (const d of doc.objects) expect.soft(placementCheck(scene(doc.objects), [d])(0, 0), `${d.props?.ref}`).toBe(false)
    const supply = placedAs("ac-source", { rotation: 0, mirror: false }, -8, 1, "G1")
    const wired: PlacementScene = { objects: [...parts, supply], wires: [{ id: "w", from: { object: "G1", pin: "+" }, to: { object: "D1", pin: "1" } }], routes: [], grid: GRID }
    expect.soft(placementCheck(wired, [parts[2]])(0, 0), "D3, whose cathode's name D1's wire passes at L").toBe(false)
    expect.soft(placementCheck(wired, [parts[0]])(0, 0), "D1, whose wire leaves over D3's hidden name").toBe(false)
  })

  it("a name the field does draw still blocks: a lone part's pin name under another part's body is refused", () => {
    const q = placedAs("crystal", { rotation: 0, mirror: false }, 0, 0, "Y1")
    const g = placedAs("oscillator", { rotation: 0, mirror: false }, 0, 2, "G1")
    expect.soft(placementCheck(scene([q, g]), [g])(0, 0), "the oscillator's names on the crystal's value").toBe(true)
  })
})

describe("the diagonal parts in the examples are on the lattice", () => {
  it("every pin of every example lies on the half-cell lattice, and every diagonal part's pins on whole cells", () => {
    for (const example of examples) {
      const doc = example.build(GRID)
      for (const o of doc.objects) {
        const diagonal = isDiagonal(o.rotation ?? 0)
        for (const { key, point } of objectPins(o, GRID)) {
          const p = cells(point)
          expect.soft(diagonal ? whole(p.x) && whole(p.y) : half(p.x) && half(p.y), `${example.id} ${refOf(doc, o.id) ?? o.def} ${key.split(":")[1]} at (${p.x}, ${p.y})`).toBe(true)
        }
      }
    }
  })
})
