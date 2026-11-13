import { describe, expect, it } from "vitest"
import { GRID, intersects, objectPins, type FlipAxis, type Point } from "@/schematic/geometry"
import { wirePins } from "@/schematic/migrate-wires"
import { flipSelection, turnedSelection } from "@/schematic/orient"
import { contactCheck, footprints, placementCheck, TURN_REACH, type PlacementScene } from "@/schematic/placement"
import { flippedAlone, flippedWithWires, TurnRun, turnedAlone, type Landed } from "@/schematic/rubber-band"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { inNormalForm, wiringOf } from "@/schematic/wire-edits"
import { pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { counter } from "../lib/wire-reference"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const part = (id: string, def: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def, x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
const resistor = (id: string, x: number, y: number, rotation?: 90) => part(id, "resistor", x, y, rotation)
let serial = 0
const seg = (a: Point, b: Point): WireSegment => ({ id: `s${++serial}`, a, b })
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic) => wiringOf(new WireGraph(), doc)
const sceneOf = (doc: Schematic): PlacementScene => ({ objects: doc.objects, routes: [], grid: GRID })
const partition = (doc: Schematic) => pinPartition(wireNets(doc.wires, wirePins(doc.objects)))
const newId = counter("tp")
const objectOf = (doc: Schematic, id: string) => doc.objects.find((o) => o.id === id)!
const chosen = (doc: Schematic, ids: ReadonlySet<string>) => doc.objects.filter((o) => ids.has(o.id))

const pressR = (doc: Schematic, ids: ReadonlySet<string>, presses: number, turn: 1 | -1 = 1): Landed => {
  const run = new TurnRun(doc, wiringFor(doc), ids)
  let landed: Landed = { doc, unlaid: [], at: { x: 0, y: 0 } }
  for (let k = 0; k < presses; k++) landed = run.turned(turn, newId)
  return landed
}

const mirrorOf = (doc: Schematic, ids: ReadonlySet<string>, axis: FlipAxis): Landed => flippedWithWires(doc, wiringFor(doc), ids, axis, newId)

const bodiesOverlap = (a: PlacedObject, b: PlacedObject) => {
  const fa = footprints(a, GRID)!
  const fb = footprints(b, GRID)!
  return fa.contour.some((p) => fb.contour.some((q) => intersects(p.box, q.box) && Math.min(p.box.x + p.box.w, q.box.x + q.box.w) - Math.max(p.box.x, q.box.x) > 1e-6 && Math.min(p.box.y + p.box.h, q.box.y + q.box.h) - Math.max(p.box.y, q.box.y) > 1e-6))
}

function expectStandsClear(doc: Schematic, ids: ReadonlySet<string>, what: string) {
  const turned = chosen(doc, ids)
  expect.soft(placementCheck(sceneOf(doc), turned)(0, 0), `${what}: no body on a body, no lead or pin on another part`).toBe(false)
  expect.soft(contactCheck(sceneOf(doc), turned)(0, 0), `${what}: no pin on another part's pin`).toBe(false)
}

function expectNearest(before: Schematic, inPlace: Schematic, after: Schematic, ids: ReadonlySet<string>, what: string) {
  const moved = chosen(inPlace, ids)
  const landed = chosen(after, ids)
  const shift = { x: (landed[0].x - moved[0].x) / GRID, y: (landed[0].y - moved[0].y) / GRID }
  expect.soft(
    landed.map((o, i) => [o.x - moved[i].x, o.y - moved[i].y, o.rotation ?? 0, !!o.mirror]),
    `${what}: every turned part shifted by the same whole cells, turned as in place`,
  ).toEqual(moved.map((o) => [c(shift.x), c(shift.y), o.rotation ?? 0, !!o.mirror]))
  const squared = shift.x ** 2 + shift.y ** 2
  expect.soft(squared, `${what}: moved, since in place it lands on another part`).toBeGreaterThan(0)
  const scene = sceneOf(inPlace)
  const bodies = placementCheck(scene, moved)
  const key = (p: Point) => `${p.x},${p.y}`
  const pinsOf = (objects: readonly PlacedObject[]) => objects.flatMap((o) => objectPins(o, GRID).map((p) => p.point))
  const kept = new Set(pinsOf(chosen(before, ids)).map(key))
  const foreign = new Set(pinsOf(inPlace.objects.filter((o) => !ids.has(o.id))).map(key).filter((k) => !kept.has(k)))
  const contacts = (dx: number, dy: number) => pinsOf(moved).some((p) => foreign.has(key({ x: p.x + dx, y: p.y + dy })))
  const nearer: [number, number][] = []
  for (let dx = -TURN_REACH; dx <= TURN_REACH; dx++)
    for (let dy = -TURN_REACH; dy <= TURN_REACH; dy++) if (dx * dx + dy * dy < squared && !bodies(c(dx), c(dy)) && !contacts(c(dx), c(dy))) nearer.push([dx, dy])
  expect.soft(nearer, `${what}: no free spot nearer than (${shift.x}, ${shift.y})`).toEqual([])
}

describe("a part turned or mirrored in place lands on the nearest free spot, as a drop does (the user, 2026-11-13: «если резисторы крайне близко стоят и я его поверну»)", () => {
  const user = () => docOf([resistor("R1", 0, 0), resistor("R2", 0, 1)])
  const R2 = new Set(["R2"])

  it("set up: R2 lies just under R1, both horizontal, and that is allowed", () => {
    const doc = user()
    expect.soft(placementCheck(sceneOf(doc), [objectOf(doc, "R2")])(0, 0), "R2 under R1 is a legal placement").toBe(false)
    const inPlace = turnedSelection(doc, R2, 2, GRID)
    expect.soft(bodiesOverlap(objectOf(inPlace, "R1"), objectOf(inPlace, "R2")), "turned upright where it stands, R2's body lies on R1's: the user's screenshot").toBe(true)
  })

  it("R pressed twice stands R2 upright beside R1, never on it, on the nearest free spot", () => {
    const doc = user()
    const landed = pressR(doc, R2, 2)
    expect.soft(landed.refused, "turned, not refused").toBeUndefined()
    expect.soft(objectOf(landed.doc, "R2").rotation, "upright").toBe(90)
    expect.soft(bodiesOverlap(objectOf(landed.doc, "R1"), objectOf(landed.doc, "R2")), "the bodies do not overlap").toBe(false)
    expectStandsClear(landed.doc, R2, "R R")
    expectNearest(doc, turnedSelection(doc, R2, 2, GRID), landed.doc, R2, "R R")
    expect.soft(objectOf(landed.doc, "R1"), "R1 stays where it was").toEqual(objectOf(doc, "R1"))
  })

  it("R once turns R2 onto its diagonal, clear of R1, on the nearest free spot (45°)", () => {
    const doc = user()
    const landed = pressR(doc, R2, 1)
    expect.soft(landed.refused, "turned, not refused").toBeUndefined()
    expect.soft(objectOf(landed.doc, "R2").rotation, "on its diagonal").toBe(45)
    expectStandsClear(landed.doc, R2, "R")
    expectNearest(doc, turnedSelection(doc, R2, 1, GRID), landed.doc, R2, "R")
  })

  it("⇧R twice turns it the other way, clear of R1, on the nearest free spot", () => {
    const doc = user()
    const landed = pressR(doc, R2, 2, -1)
    expect.soft(landed.refused, "turned, not refused").toBeUndefined()
    expect.soft(objectOf(landed.doc, "R2").rotation, "upright the other way").toBe(270)
    expectStandsClear(landed.doc, R2, "⇧R ⇧R")
    expectNearest(doc, turnedSelection(doc, R2, -2, GRID), landed.doc, R2, "⇧R ⇧R")
  })

  it("R then ⇧R gives the very part back, where it was", () => {
    const doc = user()
    const run = new TurnRun(doc, wiringFor(doc), R2)
    run.turned(1, newId)
    run.turned(1, newId)
    run.turned(-1, newId)
    expect.soft(objectOf(run.turned(-1, newId).doc, "R2"), "back home").toEqual(objectOf(doc, "R2"))
  })

  it("a part turned where there is room turns exactly where it stands, as before", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 0, 8)])
    for (const presses of [1, 2])
      expect.soft(objectOf(pressR(doc, R2, presses).doc, "R2"), `${presses} presses`).toEqual(objectOf(turnedSelection(doc, R2, presses, GRID), "R2"))
  })

  it("the wires into the turned part are routed again to its new place and the nets stay as they were", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 0, 1), resistor("R3", 10, 1)], [seg(at(4, 2), at(10, 2))])
    const before = partition(doc)
    const landed = pressR(doc, R2, 2)
    expect.soft(landed.refused, "turned").toBeUndefined()
    expectStandsClear(landed.doc, R2, "wired")
    expect.soft(partition(landed.doc), "the same nets").toEqual(before)
    const pin = objectPins(objectOf(landed.doc, "R2"), GRID).find((p) => p.pin.id === "2")!.point
    expect.soft(landed.doc.wires.some((s) => (s.a.x === pin.x && s.a.y === pin.y) || (s.b.x === pin.x && s.b.y === pin.y)), "a wire ends on R2's pin 2 where it is now").toBe(true)
  })

  it("X mirrors a part whose body would fall on its neighbour onto the nearest free spot", () => {
    const doc = docOf([resistor("R1", -1, 0, 90), part("SW1", "pushbutton", 0, 0, 90)])
    const SW1 = new Set(["SW1"])
    expect.soft(placementCheck(sceneOf(doc), [objectOf(doc, "SW1")])(0, 0), "set up: the button stands beside R1, allowed").toBe(false)
    const inPlace = flipSelection(doc, SW1, "horizontal", GRID)
    expect.soft(placementCheck(sceneOf(inPlace), [objectOf(inPlace, "SW1")])(0, 0), "set up: mirrored where it stands, its body falls on R1").toBe(true)
    const landed = mirrorOf(doc, SW1, "horizontal")
    expect.soft(landed.refused, "mirrored").toBeUndefined()
    expect.soft(objectOf(landed.doc, "SW1").mirror, "mirrored").toBe(true)
    expectStandsClear(landed.doc, SW1, "X")
    expectNearest(doc, inPlace, landed.doc, SW1, "X")
  })

  it("Y mirrors a part whose body would fall on its neighbour onto the nearest free spot", () => {
    const doc = docOf([part("SW1", "pushbutton", 0, 0), resistor("R1", 0, 1)])
    const SW1 = new Set(["SW1"])
    expect.soft(placementCheck(sceneOf(doc), [objectOf(doc, "SW1")])(0, 0), "set up: the button sits on R1's row, allowed").toBe(false)
    const inPlace = flipSelection(doc, SW1, "vertical", GRID)
    expect.soft(placementCheck(sceneOf(inPlace), [objectOf(inPlace, "SW1")])(0, 0), "set up: mirrored where it stands, its body falls on R1").toBe(true)
    const landed = mirrorOf(doc, SW1, "vertical")
    expect.soft(landed.refused, "mirrored").toBeUndefined()
    expectStandsClear(landed.doc, SW1, "Y")
    expectNearest(doc, inPlace, landed.doc, SW1, "Y")
  })

  it("a selection of several parts turns as one block onto the nearest spot where every part is clear, keeping its own shape", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 0, 1), resistor("R3", 4, 1)])
    const block = new Set(["R2", "R3"])
    const inPlace = turnedSelection(doc, block, 2, GRID)
    expect.soft(placementCheck(sceneOf(inPlace), chosen(inPlace, block))(0, 0), "set up: turned where it stands, the block lands on R1").toBe(true)
    const landed = pressR(doc, block, 2)
    expect.soft(landed.refused, "turned").toBeUndefined()
    expectStandsClear(landed.doc, block, "the block")
    expectNearest(doc, inPlace, landed.doc, block, "the block")
    const r2 = objectOf(landed.doc, "R2")
    const r3 = objectOf(landed.doc, "R3")
    const pins = (o: PlacedObject) => objectPins(o, GRID).map((p) => `${p.point.x},${p.point.y}`)
    expect.soft(pins(r2).filter((p) => pins(r3).includes(p)).length, "R2 and R3 still meet pin to pin").toBe(1)
  })

  it("a part butted pin to pin and turned end for end keeps its place and its contact: a pin may land where the part already touched", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 4, 0)])
    const landed = pressR(doc, R2, 4)
    expect.soft(landed.refused, "turned").toBeUndefined()
    expect.soft(objectOf(landed.doc, "R2"), "a half turn where it stands").toEqual(objectOf(turnedSelection(doc, R2, 4, GRID), "R2"))
    expect.soft(partition(landed.doc).find((net) => net.includes("R1:2")), "R1 still touches R2, now by R2's other end").toContain("R2:2")
  })

  it("the wires inside a turned block keep their drawn shape, turned and carried with the block to its free spot", () => {
    const wires = () => [seg(at(4, 2), at(5, 2)), seg(at(5, 2), at(5, 4)), seg(at(5, 4), at(6, 4))]
    const block = new Set(["R2", "R3"])
    const open = docOf([resistor("R2", 0, 1), resistor("R3", 6, 3)], wires())
    const doc = docOf([resistor("R1", 4, -1), resistor("R2", 0, 1), resistor("R3", 6, 3)], wires())
    expect.soft(placementCheck(sceneOf(doc), [objectOf(doc, "R1")])(0, 0), "set up: R1 stands clear of the block").toBe(false)
    const free = pressR(open, block, 2)
    const landed = pressR(doc, block, 2)
    expect.soft(landed.refused, "turned").toBeUndefined()
    expectStandsClear(landed.doc, block, "the wired block")
    const shift = { x: objectOf(landed.doc, "R2").x - objectOf(free.doc, "R2").x, y: objectOf(landed.doc, "R2").y - objectOf(free.doc, "R2").y }
    expect.soft(shift.x !== 0 || shift.y !== 0, "set up: the block had to move off R1").toBe(true)
    const shape = (ws: readonly WireSegment[], d: Point) => ws.map((s) => [s.a.x + d.x, s.a.y + d.y, s.b.x + d.x, s.b.y + d.y].join(",")).sort()
    expect.soft(shape(landed.doc.wires, { x: 0, y: 0 }), "the same wires, bend for bend, as the block turned in the open, moved by the landing").toEqual(shape(free.doc.wires, shift))
  })

  it("the wires inside a mirrored block keep their drawn shape, mirrored and carried with the block to its free spot", () => {
    const wires = () => [seg(at(4, 2), at(5, 2)), seg(at(5, 2), at(5, 4)), seg(at(5, 4), at(6, 4))]
    const block = new Set(["R2", "R3"])
    const open = docOf([resistor("R2", 0, 1), resistor("R3", 6, 3)], wires())
    const doc = docOf([resistor("R2", 0, 1), resistor("R3", 6, 3), resistor("R4", 6, 1)], wires())
    expect.soft(placementCheck(sceneOf(doc), [objectOf(doc, "R4")])(0, 0), "set up: R4 stands clear of the block").toBe(false)
    const free = flippedWithWires(open, wiringFor(open), block, "horizontal", newId)
    const landed = flippedWithWires(doc, wiringFor(doc), block, "horizontal", newId)
    expect.soft(landed.refused, "mirrored").toBeUndefined()
    expectStandsClear(landed.doc, block, "the mirrored block")
    const shift = { x: objectOf(landed.doc, "R2").x - objectOf(free.doc, "R2").x, y: objectOf(landed.doc, "R2").y - objectOf(free.doc, "R2").y }
    expect.soft(shift.x !== 0 || shift.y !== 0, "set up: the block had to move off R4").toBe(true)
    const shape = (ws: readonly WireSegment[], d: Point) => ws.map((s) => [s.a.x + d.x, s.a.y + d.y, s.b.x + d.x, s.b.y + d.y].join(",")).sort()
    expect.soft(shape(landed.doc.wires, { x: 0, y: 0 }), "the same wires, bend for bend, as the block mirrored in the open, moved by the landing").toEqual(shape(free.doc.wires, shift))
  })

  it("a part with no free spot within reach is not turned at all, and says why", () => {
    const rows: PlacedObject[] = []
    for (let y = -10; y <= 11; y++) for (let x = -12; x <= 12; x += 4) if (!(x === 0 && y === 1)) rows.push(resistor(`F${x},${y}`, x, y))
    const doc = docOf([...rows, resistor("R2", 0, 1)])
    expect.soft(TURN_REACH, "set up: the bank reaches further than a turn may move a part").toBeLessThan(8)
    expect.soft(placementCheck(sceneOf(doc), [objectOf(doc, "R2")])(0, 0), "set up: R2 sits in a packed bank of resistors, allowed").toBe(false)
    for (const [what, landed] of [
      ["R", pressR(doc, R2, 1)],
      ["R R", pressR(doc, R2, 2)],
      ["⇧R", pressR(doc, R2, 1, -1)],
      ["Alt+R", turnedAlone(doc, R2, 1)],
    ] as const) {
      expect.soft(landed.refused, `${what}: refused`).toBeDefined()
      expect.soft(landed.crowded, `${what}: refused for want of room`).toBe(true)
      expect.soft(objectOf(landed.doc, "R2"), `${what}: R2 left exactly as it was`).toEqual(objectOf(doc, "R2"))
    }
  })

  it("turned or mirrored alone (Alt), the wires do not follow but the part still lands on a free spot", () => {
    const doc = user()
    const turned = turnedAlone(doc, R2, 1)
    expect.soft(turned.refused, "turned").toBeUndefined()
    expectStandsClear(turned.doc, R2, "Alt+R")
    expectNearest(doc, turnedSelection(doc, R2, 1, GRID), turned.doc, R2, "Alt+R")
    const button = docOf([part("SW1", "pushbutton", 0, 0), resistor("R1", 0, 1)])
    const SW1 = new Set(["SW1"])
    const mirrored = flippedAlone(button, SW1, "vertical")
    expect.soft(mirrored.refused, "mirrored").toBeUndefined()
    expectStandsClear(mirrored.doc, SW1, "Alt+Y")
    expectNearest(button, flipSelection(button, SW1, "vertical", GRID), mirrored.doc, SW1, "Alt+Y")
  })
})
