import { describe, expect, it } from "vitest"
import { GRID, objectPins } from "@/schematic/geometry"
import { footprint } from "@/schematic/placement"
import { wirePins } from "@/schematic/migrate-wires"
import { netChanges } from "../lib/net-changes"
import { flippedWithWires, PartDrag, SegmentDrag, TurnRun } from "@/schematic/rubber-band"
import { inNormalForm, wiringOf } from "@/schematic/wire-edits"
import { rotateSelection } from "@/schematic/orient"
import type { PlacedObject, Point, Schematic } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import { type DragConflict, type DragFrame, type DragMove, normalOffset, planDrag } from "@/schematic/wires/drag"
import { turnedSelection } from "@/schematic/orient"
import { danglingEnds, junctionsOf, pinPartition, type WireNets, WireGraph, wireNets } from "@/schematic/wires/graph"
import { commitEdit, normalise } from "@/schematic/wires/normal-form"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"
import { columnCode, rowCode, WireSheet } from "@/schematic/wires/sheet"
import { canonical } from "../lib/pin-partition"
import { counter, geometryOf, normalFormViolations, paintOf, random, referencePartition, sortedPoints } from "../lib/wire-reference"

const c = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
let serial = 0
const w = (a: Point, b: Point, color?: WireColorKey): WireSegment => (color ? { id: `w${++serial}`, a, b, color } : { id: `w${++serial}`, a, b })
const path = (...pts: Point[]) => pts.slice(1).map((p, i) => w(pts[i], p))
const sign = (v: number) => Math.sign(v) + 0
const cells = (x: number, y: number) => c(x, y)

type Sheet = { pins: readonly WirePin[]; headings: ReadonlyMap<string, Point>; wires: readonly WireSegment[] }

type Part = readonly [string, Point, Point]

function sheetOf(parts: readonly Part[], wires: readonly WireSegment[], extra: readonly WirePin[] = []): Sheet {
  const pins: WirePin[] = [...extra]
  const headings = new Map<string, Point>()
  for (const [ref, a, b] of parts) {
    pins.push({ key: `${ref}:1`, at: a }, { key: `${ref}:2`, at: b })
    headings.set(`${ref}:1`, { x: sign(a.x - b.x), y: sign(a.y - b.y) })
    headings.set(`${ref}:2`, { x: sign(b.x - a.x), y: sign(b.y - a.y) })
  }
  return { pins, headings, wires: normalise(wires, pins, undefined, counter("n")) }
}

const part = (ref: string, a: Point, b: Point): Part => [ref, a, b]

type Dragged = { wires: readonly WireSegment[]; pins: readonly WirePin[]; blocked: boolean; frame: DragFrame }

const keysOf = (sheet: Sheet, refs: readonly string[]) => sheet.pins.filter((p) => refs.includes(p.key.slice(0, p.key.indexOf(":")))).map((p) => p.key)

function planOf(sheet: Sheet, carried: { parts?: readonly string[]; wires?: readonly string[] }, nets: WireNets = new WireGraph().of(sheet.wires, sheet.pins)) {
  return planDrag(WireSheet.of(sheet.wires, sheet.pins), nets, { pins: keysOf(sheet, carried.parts ?? []), wires: carried.wires, heading: (key) => sheet.headings.get(key) })
}

function drag(sheet: Sheet, carried: { parts?: readonly string[]; wires?: readonly string[] }, move: Point | DragMove): Dragged {
  const plan = planOf(sheet, carried)
  const frame = plan.frame(move)
  const done = plan.commit(move, counter("d"))
  if (!done) return { wires: sheet.wires, pins: sheet.pins, blocked: true, frame }
  const moved = new Map(done.pins.map((p) => [p.key, p]))
  const pinsAfter = sheet.pins.map((p) => moved.get(p.key) ?? p)
  return { wires: commitEdit(sheet.wires, pinsAfter, done.edit, counter("e")).wires, pins: pinsAfter, blocked: false, frame }
}

const stack = (x: number) => sheetOf([part("R2", c(x - 4, 2), c(x, 2)), part("R1", c(x - 4, 6), c(x, 6)), part("R3", c(x - 4, 10), c(x, 10))], path(c(x, 2), c(x, 6), c(x, 10)))

describe("the rubber band on junctions.md's drag scenarios (design.md §6.3)", () => {
  it("6: R1 dragged one cell left, the branch on its pin stays and a one-cell wire joins the pin to the dot", () => {
    const sheet = stack(5)
    const { wires, pins, blocked } = drag(sheet, { parts: ["R1"] }, cells(-1, 0))
    expect.soft(blocked, "the drop is clean").toBe(false)
    expect.soft(geometryOf(wires), "the spine put, a short wire to the moved pin").toEqual(geometryOf([...path(c(5, 2), c(5, 6), c(5, 10)), w(c(4, 6), c(5, 6))]))
    expect.soft(junctionsOf(wireNets(wires, pins)), "the dot stays on the spine").toEqual([c(5, 6)])
    expect.soft(normalFormViolations(wires, pins), "normal form").toEqual([])
  })

  it("6, dragged down as well: the short wire meets the spine lower, and the dot moves to where it meets it", () => {
    const sheet = stack(5)
    const { wires, pins } = drag(sheet, { parts: ["R1"] }, cells(-1, 1))
    expect.soft(geometryOf(wires), "the spine put, the short wire one cell lower").toEqual(geometryOf([...path(c(5, 2), c(5, 7), c(5, 10)), w(c(4, 7), c(5, 7))]))
    expect.soft(junctionsOf(wireNets(wires, pins)), "the dot where the short wire meets the spine").toEqual([c(5, 7)])
  })

  it("7: R1 dragged one cell right, a wire back over its own lead is not allowed, so the branch moves with the pin and R2's and R3's wires leave their pins along their axes", () => {
    const sheet = stack(4)
    const { wires, pins, blocked } = drag(sheet, { parts: ["R1"] }, cells(1, 0))
    expect.soft(blocked, "the drop is clean").toBe(false)
    expect.soft(geometryOf(wires), "the spine one cell right, an L from R2 and from R3").toEqual(geometryOf(path(c(4, 2), c(5, 2), c(5, 6), c(5, 10), c(4, 10))))
    expect.soft(junctionsOf(wireNets(wires, pins)), "the dot on R1's pin").toEqual([c(5, 6)])
    expect.soft(normalFormViolations(wires, pins), "normal form").toEqual([])
  })

  it("8: R1 dragged left and back, as two drags or within one, leaves exactly the starting geometry", () => {
    const sheet = stack(5)
    const there = drag(sheet, { parts: ["R1"] }, cells(-1, 0))
    const back = drag({ ...sheet, pins: there.pins, wires: there.wires }, { parts: ["R1"] }, cells(1, 0))
    expect.soft(geometryOf(back.wires), "two drags").toEqual(geometryOf(sheet.wires))
    const plan = planOf(sheet, { parts: ["R1"] })
    expect.soft(plan.frame(cells(-1, 0)).pieces.length, "the way out draws the short wire").toBe(1)
    const home = plan.frame(cells(0, 0))
    expect.soft({ pieces: home.pieces.length, replaced: home.replaced.size }, "back at the start, one drag draws nothing").toEqual({ pieces: 0, replaced: 0 })
    expect.soft(plan.commit(cells(0, 0))?.edit, "and commits nothing").toEqual({})
  })

  it("11: a jog that would pass over a foreign pin moves outward until it clears it", () => {
    const sheet = sheetOf([part("R2", c(7, 3), c(7, 7)), part("R4", c(5, 8), c(5, 12)), part("R1", c(0, 3), c(4, 3))], [w(c(4, 3), c(7, 3))])
    const { wires, pins, blocked, frame } = drag(sheet, { parts: ["R1"] }, cells(0, 5))
    expect.soft(blocked, "the drop is clean").toBe(false)
    expect.soft(frame.reroutes, "a clean place was found without re-routing").toEqual([])
    expect.soft(geometryOf(wires), "the jog at the moving end, clear of R4's pin").toEqual(geometryOf(path(c(7, 3), c(4, 3), c(4, 8))))
    expect.soft(pinPartition(wireNets(wires, pins)), "R4 untouched").toEqual(pinPartition(wireNets(sheet.wires, sheet.pins)))
  })

  it("11: an offset that would slide a stretched wire over a foreign pin is blocked", () => {
    const sheet = sheetOf([part("R1", c(0, 0), c(4, 0)), part("R2", c(8, 4), c(8, 8)), part("X", c(6, 2), c(6, -2))], path(c(4, 0), c(8, 0), c(8, 4)))
    const frame = planOf(sheet, { parts: ["R1"] }).frame(cells(0, 2))
    expect.soft(frame.blocked, "the corner slides down to (8, 2) and the wire to it passes X's pin at (6, 2)").toBe(true)
    expect.soft(frame.conflicts.map((k) => k.at), "named where").toContainEqual(c(6, 2))
    expect.soft(planOf(sheet, { parts: ["R1"] }).commit(cells(0, 2)), "nothing is committed").toBeNull()
    expect.soft(planOf(sheet, { parts: ["R1"] }).frame(cells(0, 1)).blocked, "one cell less is clean").toBe(false)
  })

  it("17: R pressed twice on R1 with a branch on its pin turns from the wiring before the first press: a short wire to the spine, the dot moves there", () => {
    const resistor = (id: string, y: number): PlacedObject => ({ id, def: "resistor", x: 0, y: y * GRID, props: { ref: id } })
    const objects = [resistor("R2", 1), resistor("R1", 5), resistor("R3", 9)]
    const doc: Schematic = { objects, wires: [], parts: {} }
    const pinsOf = (o: readonly PlacedObject[]) => o.flatMap((obj) => objectPins(obj, GRID).map((p): WirePin => ({ key: p.key, at: p.point })))
    const sideOf = (o: readonly PlacedObject[]) => new Map(o.flatMap((obj) => objectPins(obj, GRID).map((p) => [p.key, headingOf(p.pin.side)] as const)))
    const pins = pinsOf(objects)
    const sides = sideOf(objects)
    const wires = normalise(path(c(4, 2), c(4, 6), c(4, 10)), pins, undefined, counter("n"))
    const once = rotateSelection(doc, new Set(["R1"]), 1, GRID).objects
    const twice = rotateSelection({ ...doc, objects: once }, new Set(["R1"]), 1, GRID).objects
    const turnTo = (o: readonly PlacedObject[]): DragMove => {
      const at = new Map(pinsOf(o).map((p) => [p.key, p.at]))
      const side = sideOf(o)
      return { pin: (key, from) => at.get(key) ?? from, point: (p) => p, heading: (key, h) => side.get(key) ?? h }
    }
    const sheet: Sheet = { pins, headings: sides, wires }
    const plan = planOf(sheet, { parts: ["R1"] })
    const diagonal = plan.frame(turnTo(once))
    expect.soft(diagonal.blocked, "the 45° stop is clean").toBe(false)
    const turned = plan.frame(turnTo(twice))
    const single = planOf(sheet, { parts: ["R1"] }).frame(turnTo(twice))
    expect.soft(turned.pieces, "the second press draws exactly what a single right-angle turn draws").toEqual(single.pieces)
    expect.soft(turned.pieces.filter((p) => p.kind === "jog"), "no jog from the diagonal stop").toEqual([])
    const done = plan.commit(turnTo(twice), counter("d"))!
    const moved = new Map(done.pins.map((p) => [p.key, p]))
    const pinsAfter = pins.map((p) => moved.get(p.key) ?? p)
    const after = commitEdit(wires, pinsAfter, done.edit, counter("e")).wires
    expect.soft(geometryOf(after), "the spine put, a short wire from R1's lower pin").toEqual(geometryOf([...path(c(4, 2), c(4, 8), c(4, 10)), w(c(2, 8), c(4, 8))]))
    expect.soft(junctionsOf(wireNets(after, pinsAfter)), "the dot where it meets the spine").toEqual([c(4, 8)])
  })

  it("27: two butted pins pulled apart gain a straight wire between them, no dot", () => {
    const sheet = sheetOf([part("R1", c(0, 5), c(4, 5)), part("R2", c(4, 5), c(8, 5))], [])
    const { wires, pins, blocked } = drag(sheet, { parts: ["R2"] }, cells(2, 0))
    expect.soft(blocked, "the drop is clean").toBe(false)
    expect.soft(geometryOf(wires), "a wire from R1's pin to R2's").toEqual(geometryOf([w(c(4, 5), c(6, 5))]))
    expect.soft(junctionsOf(wireNets(wires, pins)), "no dot").toEqual([])
    expect.soft(pinPartition(wireNets(wires, pins)), "still one net").toEqual([["R1:2", "R2:1"]])
  })

  it("27, pulled apart on a slant: an L that leaves the staying pin along its axis", () => {
    const sheet = sheetOf([part("R1", c(0, 5), c(4, 5)), part("R2", c(4, 5), c(8, 5))], [])
    const { wires } = drag(sheet, { parts: ["R2"] }, cells(2, 2))
    expect.soft(geometryOf(wires), "out of R1 to the right, then down to R2").toEqual(geometryOf(path(c(4, 5), c(6, 5), c(6, 7))))
  })

  it("31: a wire with a branch on it dragged sideways, the branch stretches and the ends at fixed pins leave along the pins' axes", () => {
    const sheet = sheetOf([part("R2", c(0, 2), c(4, 2)), part("R1", c(0, 10), c(4, 10)), part("R3", c(6, 6), c(10, 6))], [...path(c(4, 2), c(4, 6), c(4, 10)), w(c(4, 6), c(6, 6))])
    const spine = sheet.wires.filter((s) => s.a.x === c(4, 0).x && s.b.x === c(4, 0).x)
    const offset = normalOffset(spine[0], { x: 1.2 * GRID, y: -2.7 * GRID })
    expect.soft(offset, "a segment moves only along its normal").toEqual(c(1, 0))
    const { wires, pins, blocked } = drag(sheet, { wires: spine.map((s) => s.id) }, offset)
    expect.soft(blocked, "the drop is clean").toBe(false)
    expect.soft(geometryOf(wires), "the spine a cell right").toEqual(geometryOf([...path(c(4, 2), c(5, 2), c(5, 6), c(5, 10), c(4, 10)), w(c(5, 6), c(6, 6))]))
    expect.soft(sortedPoints(junctionsOf(wireNets(wires, pins))), "the dot moved with the spine").toEqual([c(5, 6)])
    expect.soft(pinPartition(wireNets(wires, pins)), "one net").toEqual(referencePartition(wires, pins))
  })
})

function headingOf(side: string): Point {
  const x = side.includes("left") ? -1 : side.includes("right") ? 1 : 0
  const y = side.includes("top") ? -1 : side.includes("bottom") ? 1 : 0
  return { x, y }
}

describe("LibrePCB's cases and KiCad's dog-leg (design.md §6.3 rules 3 and 4)", () => {
  it("a pin-to-pin wire that leaves the staying pin sideways gains an L when the other part is pulled out along that pin's axis", () => {
    const sheet = sheetOf([part("R1", c(0, 4), c(4, 4)), part("R2", c(8, 4), c(8, 8))], [w(c(4, 4), c(8, 4))])
    const { wires, frame } = drag(sheet, { parts: ["R1"] }, cells(0, -2))
    expect.soft(geometryOf(wires), "up out of R2's pin, then across to R1").toEqual(geometryOf(path(c(8, 4), c(8, 2), c(4, 2))))
    expect.soft(frame.pieces.filter((p) => p.kind === "jog").length, "the new piece is the jog itself").toBe(1)
  })

  it("KiCad's dog-leg: a straight pin-to-pin wire keeps leaving the staying pin along its axis for one grid step, jogs, and runs on to the moving pin", () => {
    const sheet = sheetOf([part("R1", c(0, 0), c(4, 0)), part("R2", c(10, 0), c(14, 0))], [w(c(4, 0), c(10, 0))])
    const at = (dx: number, dy: number) => geometryOf(drag(sheet, { parts: ["R2"] }, cells(dx, dy)).wires)
    expect.soft(at(0, 2), "down two").toEqual(geometryOf(path(c(4, 0), c(5, 0), c(5, 2), c(10, 2))))
    expect.soft(at(-3, 2), "and closer").toEqual(geometryOf(path(c(4, 0), c(5, 0), c(5, 2), c(7, 2))))
    expect.soft(at(-5, 2), "one grid step away: an L, the jog at the moving pin").toEqual(geometryOf(path(c(4, 0), c(5, 0), c(5, 2))))
    expect.soft(at(-6, 2), "level with the staying pin: straight down from it").toEqual(geometryOf([w(c(4, 0), c(4, 2))]))
    expect.soft(at(3, 0), "along the wire: it only stretches").toEqual(geometryOf([w(c(4, 0), c(13, 0))]))
  })

  it("pin–bend–pin: an L keeps its shape, the bend sliding along the far segment", () => {
    const sheet = sheetOf([part("R1", c(0, 0), c(4, 0)), part("R2", c(8, 4), c(8, 8))], path(c(4, 0), c(8, 0), c(8, 4)))
    expect.soft(geometryOf(drag(sheet, { parts: ["R1"] }, cells(-1, 2)).wires), "the bend slid down two, the near leg longer by one").toEqual(geometryOf(path(c(3, 2), c(8, 2), c(8, 4))))
  })

  it("pin–vertex–pin on one line (LibrePCB's netpoint, here a colour boundary): the vertex moves and a bend is added where it was", () => {
    const sheet = sheetOf([part("R1", c(0, 0), c(4, 0)), part("R2", c(12, 0), c(16, 0))], [w(c(4, 0), c(8, 0), "red"), w(c(8, 0), c(12, 0), "blue")])
    const { wires } = drag(sheet, { parts: ["R1"] }, cells(0, 2))
    expect.soft(geometryOf(wires), "the vertex two down, a bend at its old place").toEqual(geometryOf([w(c(4, 2), c(8, 2), "red"), w(c(8, 2), c(8, 0), "blue"), w(c(8, 0), c(12, 0), "blue")]))
  })

  it("a long collinear run moves only its nearest vertex", () => {
    const sheet = sheetOf([part("R1", c(0, 0), c(2, 0)), part("R5", c(14, 0), c(18, 0))], [w(c(2, 0), c(5, 0), "red"), w(c(5, 0), c(8, 0), "blue"), w(c(8, 0), c(11, 0), "red"), w(c(11, 0), c(14, 0), "blue")])
    const { wires } = drag(sheet, { parts: ["R1"] }, cells(0, -1))
    expect.soft(geometryOf(wires), "the first vertex up a cell; the rest of the run where it was").toEqual(
      geometryOf([w(c(2, -1), c(5, -1), "red"), w(c(5, -1), c(5, 0), "blue"), w(c(5, 0), c(8, 0), "blue"), w(c(8, 0), c(11, 0), "red"), w(c(11, 0), c(14, 0), "blue")]),
    )
  })

  it("a dragged segment whose neighbour runs on along its line to a fixed pin gets the dog-leg at that pin (§6.3, dragging a segment)", () => {
    const sheet = sheetOf([part("A", c(-4, 0), c(0, 0)), part("B", c(12, 0), c(16, 0))], [w(c(0, 0), c(6, 0), "red"), w(c(6, 0), c(12, 0))])
    const middle = sheet.wires.find((s) => s.color === undefined)!
    const { wires } = drag(sheet, { wires: [middle.id] }, normalOffset(middle, c(0, 2)))
    expect.soft(geometryOf(wires), "out of A one step, down, along; at B a wire straight down").toEqual(
      geometryOf([w(c(0, 0), c(1, 0), "red"), w(c(1, 0), c(1, 2), "red"), w(c(1, 2), c(6, 2), "red"), w(c(6, 2), c(12, 2)), w(c(12, 0), c(12, 2))]),
    )
  })

  it("a segment whose far end is dangling simply translates", () => {
    const sheet = sheetOf([part("R1", c(0, 0), c(4, 0))], [w(c(4, 0), c(8, 0))])
    expect.soft(geometryOf(drag(sheet, { parts: ["R1"] }, cells(1, 3)).wires), "the stub keeps its length").toEqual(geometryOf([w(c(5, 3), c(9, 3))]))
  })
})

describe("jogs never touch another net (rule 5)", () => {
  it("a bundle of parallel wires dragged together gets its dog-legs staggered a grid step apart, every net kept apart", () => {
    const rows = [0, 1, 2, 3]
    const parts = rows.flatMap((y) => [part(`L${y}`, c(0, y), c(4, y)), part(`F${y}`, c(10, y), c(14, y))])
    const sheet = sheetOf(parts, rows.map((y) => w(c(4, y), c(10, y))))
    for (const down of [1, 2, 3]) {
      const { wires, pins, blocked, frame } = drag(sheet, { parts: rows.map((y) => `L${y}`) }, cells(0, down))
      expect.soft(blocked, `down ${down}: clean`).toBe(false)
      expect.soft(frame.reroutes, `down ${down}: every jog found a place`).toEqual([])
      expect.soft(pinPartition(wireNets(wires, pins)), `down ${down}: every net apart`).toEqual(pinPartition(wireNets(sheet.wires, sheet.pins)))
      expect.soft(normalFormViolations(wires, pins), `down ${down}: normal form`).toEqual([])
      const jogs = frame.pieces.filter((p) => p.kind === "jog").map((p) => p.a.x / GRID).sort((a, b) => a - b)
      expect.soft(jogs, `down ${down}: one jog per wire, each a grid step further out than the one below it`).toEqual([6, 7, 8, 9])
    }
  })

  it("a jog with no clean place is re-routed on release by a lattice search that touches no other net", () => {
    const blockers: WirePin[] = [4, 5, 6, 7, 8, 9, 10].map((x) => ({ key: `X${x}:1`, at: c(x, 1) }))
    const sheet = sheetOf([part("R1", c(0, 0), c(4, 0)), part("R2", c(10, 0), c(14, 0))], [w(c(4, 0), c(10, 0))], blockers)
    const { wires, pins, blocked, frame } = drag(sheet, { parts: ["R2"] }, cells(0, 2))
    expect.soft(frame.blocked, "the offset itself is not blocked").toBe(false)
    expect.soft(frame.reroutes.length, "one wire to re-route").toBe(1)
    expect.soft(blocked, "the route was found").toBe(false)
    expect.soft(pinPartition(wireNets(wires, pins)), "no blocker joined").toEqual([["R1:2", "R2:1"]])
    expect.soft(normalFormViolations(wires, pins), "normal form").toEqual([])
    const leaving = wires.find((s) => samePlace(s.a, c(4, 0)) || samePlace(s.b, c(4, 0)))!
    const arriving = wires.find((s) => samePlace(s.a, c(10, 2)) || samePlace(s.b, c(10, 2)))!
    expect.soft({ segments: wires.length, leaves: leaving.a.y === leaving.b.y, arrives: arriving.a.y === arriving.b.y }, "two bends between the blockers, out of R1 and into R2 along their axes").toEqual({ segments: 3, leaves: true, arrives: true })
  })

  it("a jog with nowhere to go at all blocks the drop rather than join a net", () => {
    const walls: WirePin[] = [c(9.5, 3), c(10, 2.5), c(10, 3.5)].map((at, i) => ({ key: `X${i}:1`, at }))
    const sheet = sheetOf([part("R1", c(0, 0), c(4, 0)), part("R2", c(10, 0), c(14, 0))], [w(c(4, 0), c(10, 0))], walls)
    const plan = planOf(sheet, { parts: ["R2"] })
    expect.soft(plan.frame(cells(0, 3)).reroutes.length, "every jog would touch a wall, so a re-route is needed").toBe(1)
    expect.soft(plan.commit(cells(0, 3)), "and none exists, so nothing is committed").toBeNull()
  })
})

describe("rule 5's last resort and the landing (design.md §6.3, §6.7)", () => {
  it("a jog with no clean place re-routes the wire's private run up to its first pin or branch, not just the jogged piece", () => {
    const blockers: WirePin[] = [8, 9, 10, 11, 12].map((x) => ({ key: `X${x}:1`, at: c(x, -1) }))
    const sheet = sheetOf([part("R1", c(0, 0), c(4, 0)), part("R2", c(12, 4), c(12, 8))], [w(c(4, 0), c(8, 0), "red"), w(c(8, 0), c(12, 0), "blue"), w(c(12, 0), c(12, 4), "blue")], blockers)
    const corner = sheet.wires.find((s) => s.a.x === c(12, 0).x && s.b.x === c(12, 0).x)!
    const { wires, pins, blocked, frame } = drag(sheet, { parts: ["R1"] }, cells(0, -2))
    expect.soft(frame.reroutes.map((r) => r.run.map((s) => s.id)), "the run goes on round the corner to R2's pin").toEqual([[corner.id]])
    expect.soft(blocked, "a route was found").toBe(false)
    expect.soft(wires.some((s) => s.id === corner.id && samePlace(s.a, corner.a) && samePlace(s.b, corner.b)), "the piece round the corner was laid again").toBe(false)
    expect.soft(pinPartition(wireNets(wires, pins)), "no blocker joined").toEqual([["R1:2", "R2:1"]])
    expect.soft(normalFormViolations(wires, pins), "normal form").toEqual([])
  })

  it("a blocked release lands on the nearest offset that is clean, the shorter drag first", () => {
    const sheet = sheetOf([part("R1", c(0, 0), c(4, 0)), part("R2", c(8, 4), c(8, 8)), part("X", c(6, 2), c(6, -2))], path(c(4, 0), c(8, 0), c(8, 4)))
    const plan = planOf(sheet, { parts: ["R1"] })
    expect.soft(plan.lands(cells(0, 2)), "two cells down slides the wire over X's pin").toBe(false)
    expect.soft(plan.nearestClean(cells(0, 2)), "one cell down is the nearest clean offset").toEqual(cells(0, 1))
    expect.soft(plan.nearestClean(cells(0, 1)), "a clean offset is its own landing").toEqual(cells(0, 1))
  })
})

describe("far ends that are not pins", () => {
  it("a wire ending on a T slides the T along its bus", () => {
    const sheet = sheetOf([part("A", c(-4, 0), c(0, 0)), part("B", c(12, 0), c(16, 0)), part("R1", c(6, 4), c(6, 8))], [w(c(0, 0), c(12, 0)), w(c(6, 4), c(6, 0))])
    const { wires, pins } = drag(sheet, { parts: ["R1"] }, cells(2, 1))
    expect.soft(geometryOf(wires), "the stem two cells right and one longer, the T with it").toEqual(geometryOf([w(c(0, 0), c(8, 0)), w(c(8, 0), c(12, 0)), w(c(8, 5), c(8, 0))]))
    expect.soft(junctionsOf(wireNets(wires, pins)), "the dot moved with the T").toEqual([c(8, 0)])
  })

  it("a wire between two carried parts moves with them, its bend taking both axes", () => {
    const sheet = sheetOf([part("R1", c(0, 0), c(4, 0)), part("R2", c(8, 4), c(8, 8))], path(c(4, 0), c(8, 0), c(8, 4)))
    const { wires, frame } = drag(sheet, { parts: ["R1", "R2"] }, cells(3, 2))
    expect.soft(geometryOf(wires), "the whole wire translated").toEqual(geometryOf(path(c(7, 2), c(11, 2), c(11, 6))))
    expect.soft(frame.pieces.filter((p) => p.kind === "jog"), "and no jog").toEqual([])
  })
})

describe("what the drag commits", () => {
  it("a moved wire landing along its own net keeps the colour of the wire that was there first (findings.md 1.18)", () => {
    const sheet = sheetOf([part("A", c(-4, 0), c(0, 0)), part("B", c(10, 0), c(14, 0)), part("R1", c(-2, 3), c(2, 3))], [w(c(0, 0), c(10, 0), "red"), ...path(c(2, 3), c(6, 3), c(6, 0)).map((s) => ({ ...s, color: "blue" as const }))])
    const { wires, pins, blocked } = drag(sheet, { parts: ["R1"] }, cells(0, -3))
    expect.soft(blocked, "the drop is clean").toBe(false)
    expect.soft(paintOf(wires)["h0:6"], "the stretch where the blue wire landed on the red one stays red").toBe("red")
    expect.soft(normalFormViolations(wires, pins), "normal form").toEqual([])
  })

  it("a pin dropped on another net's wire joins the two, the frame knowing it for the release's audit; a pin dropped on a crossing of two is blocked", () => {
    const sheet = sheetOf([part("A", c(0, 4), c(0, 8)), part("B", c(10, 4), c(10, 8)), part("C", c(5, -2), c(5, 2)), part("D", c(5, 8), c(5, 12)), part("R1", c(-6, 0), c(-2, 0))], [w(c(0, 4), c(10, 4)), w(c(5, 2), c(5, 8))])
    const before = wireNets(sheet.wires, sheet.pins)
    const onWire = planOf(sheet, { parts: ["R1"] }).frame(cells(4, 4))
    expect.soft(onWire.blocked, "R1's right pin on the A–B wire").toBe(false)
    expect.soft(onWire.joins, "the join, known to the frame").toEqual([[before.netOfPin("A:1")!, before.netOfPin("R1:2") ?? "pin:R1:2"].sort()])
    const onCrossing = planOf(sheet, { parts: ["R1"] }).frame(cells(7, 4))
    expect.soft(onCrossing.blocked, "R1's right pin on the crossing").toBe(true)
  })

  it("a frame touches only what the drag carries and the wires incident to it", () => {
    const sheet = stack(5)
    const extra = Array.from({ length: 200 }, (_, i) => w(c(20 + (i % 10) * 3, 20 + Math.floor(i / 10) * 2), c(21 + (i % 10) * 3, 20 + Math.floor(i / 10) * 2)))
    const big: Sheet = { ...sheet, wires: [...sheet.wires, ...extra] }
    const frame = planOf(big, { parts: ["R1"] }).frame(cells(1, 0))
    expect.soft([...frame.replaced].sort(), "the two spine wires and nothing else").toEqual(sheet.wires.map((s) => s.id).sort())
  })
})

describe("the sheet index the drag reads (src/schematic/wires/sheet.ts)", () => {
  it("answers what lies along a line, through a point, at a point and on a line as a brute force does, before and after deltas", () => {
    const rng = random(4242)
    const at = () => c(rng.int(0, 12) / 2, rng.int(0, 12) / 2)
    const segmentAt = (id: string): WireSegment => {
      const a = at()
      const run = rng.int(1, 6) * (GRID / 2) * (rng.chance(0.5) ? 1 : -1)
      return { id, a, b: rng.chance(0.5) ? { x: a.x + run, y: a.y } : { x: a.x, y: a.y + run } }
    }
    let wires = Array.from({ length: 60 }, (_, i) => segmentAt(`s${i}`))
    let pins: WirePin[] = Array.from({ length: 20 }, (_, i) => ({ key: `P${i}:1`, at: at(), socket: i % 5 === 0 }))
    const sheet = WireSheet.of(wires, pins)
    const ids = (list: readonly WireSegment[]) => list.map((s) => s.id).sort()
    const flat = (s: WireSegment) => s.a.y === s.b.y
    const lo = (s: WireSegment) => Math.min(flat(s) ? s.a.x : s.a.y, flat(s) ? s.b.x : s.b.y)
    const hi = (s: WireSegment) => Math.max(flat(s) ? s.a.x : s.a.y, flat(s) ? s.b.x : s.b.y)
    const agree = (when: string) => {
      for (let q = 0; q < 40; q++) {
        const p = at()
        const [from, to] = [rng.int(-2, 14) * (GRID / 2), rng.int(-2, 14) * (GRID / 2)].sort((m, n) => m - n)
        const row = wires.filter((s) => flat(s) && s.a.y === p.y && hi(s) >= from && lo(s) <= to)
        expect.soft(ids(sheet.along(rowCode(p.y), from, to)), `${when}: along a row`).toEqual(ids(row))
        const column = wires.filter((s) => !flat(s) && s.a.x === p.x && hi(s) >= from && lo(s) <= to)
        expect.soft(ids(sheet.along(columnCode(p.x), from, to)), `${when}: along a column`).toEqual(ids(column))
        expect.soft(ids(sheet.through(p)), `${when}: through a point`).toEqual(ids(wires.filter((s) => contains(s, p))))
        expect.soft(ids([...sheet.endsAt(p)]), `${when}: ends at a point`).toEqual(ids(wires.filter((s) => samePlace(s.a, p) || samePlace(s.b, p))))
        expect.soft(sheet.pinsAt(p).map((x) => x.key).sort(), `${when}: pins at a point`).toEqual(pins.filter((x) => samePlace(x.at, p)).map((x) => x.key).sort())
        const marks = sheet.marks(rowCode(p.y), from, to).map((m) => (m.segment ? `${m.segment.id}@${m.at.x}` : `${m.pin!.key}@${m.at.x}`)).sort()
        const want = [
          ...wires.flatMap((s) => [s.a, s.b].filter((e) => e.y === p.y && e.x >= from && e.x <= to).map((e) => `${s.id}@${e.x}`)),
          ...pins.filter((x) => x.at.y === p.y && x.at.x >= from && x.at.x <= to).map((x) => `${x.key}@${x.at.x}`),
        ].sort()
        expect.soft(marks, `${when}: conductor ends on a row`).toEqual(want)
      }
    }
    agree("built")
    for (let step = 0; step < 6; step++) {
      const removed = wires.filter(() => rng.chance(0.2))
      const added = Array.from({ length: rng.int(0, 8) }, (_, i) => segmentAt(`t${step}-${i}`))
      const movedPins = pins.filter(() => rng.chance(0.2))
      const placed = movedPins.map((x) => ({ ...x, at: at() }))
      sheet.apply({ removed, added, pinsRemoved: movedPins, pinsAdded: placed })
      wires = [...wires.filter((s) => !removed.includes(s)), ...added]
      pins = [...pins.filter((x) => !movedPins.includes(x)), ...placed]
      agree(`after delta ${step}`)
    }
    expect.soft(sheet.size, "every wire held once").toBe(wires.length)
  })
})

type Case = { sheet: Sheet; parts: string[] }

function randomCase(seed: number): Case {
  const rng = random(seed)
  const parts: Part[] = []
  for (let i = rng.int(3, 6); i > 0; i--) {
    const length = rng.int(2, 4)
    const across = rng.chance(0.5)
    const butt = parts.length > 0 && rng.chance(0.3)
    const a = butt ? rng.pick(parts)[rng.chance(0.5) ? 1 : 2] : c(rng.int(0, 14), rng.int(0, 14))
    const b = across ? { x: a.x + length * GRID, y: a.y } : { x: a.x, y: a.y + length * GRID }
    parts.push(part(`P${parts.length}`, a, b))
  }
  const ends = parts.flatMap(([, a, b]) => [a, b])
  const raw: WireSegment[] = []
  const lPath = (from: Point, to: Point) => (rng.chance(0.5) ? path(from, { x: to.x, y: from.y }, to) : path(from, { x: from.x, y: to.y }, to)).filter((s) => s.a.x !== s.b.x || s.a.y !== s.b.y)
  for (let i = rng.int(2, 7); i > 0; i--) {
    const from = rng.pick(ends)
    const kind = rng.int(0, 3)
    if (kind === 0) raw.push(...lPath(from, rng.pick(ends)))
    else if (kind === 1 && raw.length) {
      const on = rng.pick(raw)
      const t = rng.int(0, 4) / 4
      const at = { x: Math.round((on.a.x + (on.b.x - on.a.x) * t) / GRID) * GRID, y: Math.round((on.a.y + (on.b.y - on.a.y) * t) / GRID) * GRID }
      raw.push(...lPath(from, at))
    } else if (kind === 2) {
      const step = rng.int(1, 3) * GRID * (rng.chance(0.5) ? 1 : -1)
      raw.push(w(from, rng.chance(0.5) ? { x: from.x + step, y: from.y } : { x: from.x, y: from.y + step }))
    } else {
      const to = rng.pick(ends)
      const middle = c(rng.int(0, 16), 0).x
      raw.push(...path(from, { x: middle, y: from.y }, { x: middle, y: to.y }, to).filter((s) => s.a.x !== s.b.x || s.a.y !== s.b.y))
    }
  }
  return { sheet: sheetOf(parts, raw), parts: parts.map(([ref]) => ref) }
}

const contains = (s: WireSegment, p: Point) =>
  s.a.y === s.b.y ? p.y === s.a.y && p.x >= Math.min(s.a.x, s.b.x) && p.x <= Math.max(s.a.x, s.b.x) : p.x === s.a.x && p.y >= Math.min(s.a.y, s.b.y) && p.y <= Math.max(s.a.y, s.b.y)

const samePlace = (p: Point, q: Point) => p.x === q.x && p.y === q.y

function overlap(s: { a: Point; b: Point }, t: { a: Point; b: Point }): number {
  const flat = (u: { a: Point; b: Point }) => u.a.y === u.b.y
  if (flat(s) !== flat(t) || (flat(s) ? s.a.y !== t.a.y : s.a.x !== t.a.x)) return 0
  const k = (p: Point) => (flat(s) ? p.x : p.y)
  return Math.min(Math.max(k(s.a), k(s.b)), Math.max(k(t.a), k(t.b))) - Math.max(Math.min(k(s.a), k(s.b)), Math.min(k(t.a), k(t.b)))
}

const inside = (s: { a: Point; b: Point }, p: Point) => contains({ id: "", ...s }, p) && !samePlace(s.a, p) && !samePlace(s.b, p)

function realContact(k: DragConflict, sheet: Sheet, frame: DragFrame): boolean {
  const before = wireNets(sheet.wires, sheet.pins)
  const netOfPin = (key: string) => before.netOfPin(key) ?? `pin:${key}`
  const conductors = [
    ...sheet.wires.filter((s) => !frame.replaced.has(s.id)).map((s) => ({ a: s.a, b: s.b, net: before.netOfSegment(s.id)! })),
    ...frame.pieces.map((p) => ({ a: p.a, b: p.b, net: p.net })),
  ]
  const pins = sheet.pins.map((p) => ({ at: frame.pins.get(p.key) ?? p.at, net: netOfPin(p.key), socket: !!p.socket }))
  const piece = frame.pieces.find((p) => p.id === k.piece)
  const at = k.at
  const touchedBy = (net: string) => conductors.some((s) => s.net === net && contains({ id: "", ...s }, at)) || pins.some((p) => p.net === net && samePlace(p.at, at))
  if (k.reason === "crossing") return touchedBy(k.nets[0]) && touchedBy(k.nets[1])
  if (k.reason === "pin") return pins.some((p) => p.net === k.nets[0] && samePlace(p.at, at)) && touchedBy(k.nets[1])
  if (!piece) return false
  if (k.reason === "along") return conductors.some((s) => s.net === k.nets[1] && overlap(piece, s) > 0)
  if (k.reason === "over") return inside(piece, at) && (conductors.some((s) => s.net === k.nets[1] && (samePlace(s.a, at) || samePlace(s.b, at))) || pins.some((p) => p.net === k.nets[1] && !p.socket && samePlace(p.at, at)))
  return (samePlace(piece.a, at) || samePlace(piece.b, at)) && touchedBy(k.nets[1])
}

function expectedAfter(sheet: Sheet, frame: DragFrame): { blocked: boolean; partition: string[][] } {
  const before = wireNets(sheet.wires, sheet.pins)
  const netOf = (key: string) => before.netOfPin(key) ?? `pin:${key}`
  const parent = new Map<string, string>()
  const find = (n: string): string => {
    const up = parent.get(n)
    if (!up || up === n) return n
    const root = find(up)
    parent.set(n, root)
    return root
  }
  let blocked = false
  for (const [key, at] of frame.pins) {
    const own = netOf(key)
    const others = new Set<string>()
    for (const s of sheet.wires) if (!frame.replaced.has(s.id) && contains(s, at)) others.add(before.netOfSegment(s.id)!)
    for (const p of sheet.pins) if (!frame.pins.has(p.key) && p.at.x === at.x && p.at.y === at.y) others.add(netOf(p.key))
    others.delete(own)
    if (others.size >= 2) blocked = true
    for (const other of others) parent.set(find(other), find(own))
  }
  const groups = new Map<string, string[]>()
  for (const p of sheet.pins) {
    const root = find(netOf(p.key))
    groups.set(root, [...(groups.get(root) ?? []), p.key])
  }
  return { blocked, partition: canonical(groups.values()) }
}

describe("random drags on random documents against the brute-force reference", () => {
  it("every committed drag is orthogonal and in normal form and joins or splits no net unless a carried pin lands on a conductor, what a frame draws is what its release commits, a drag back restores the circuit, and every conflict that blocks an offset is a real contact with another net", () => {
    const tally = { clean: 0, rerouted: 0, routeless: 0, blockedOnCrossing: 0, blocked: 0 }
    for (let seed = 1; seed <= 400; seed++) {
      const { sheet, parts } = randomCase(seed)
      const rng = random(seed * 7919)
      for (let attempt = 0; attempt < 3; attempt++) {
        const carried = [rng.pick(parts), ...(rng.chance(0.3) ? [rng.pick(parts)] : [])]
        const offset = cells(rng.int(-3, 3), rng.int(-3, 3))
        const where = `seed ${seed}, ${carried.join("+")} by (${offset.x / GRID}, ${offset.y / GRID})`
        const plan = planOf(sheet, { parts: carried })
        const frame = plan.frame(offset)
        for (const p of frame.pieces) expect.soft((p.a.x === p.b.x) !== (p.a.y === p.b.y), `${where}: ${p.id} is horizontal or vertical`).toBe(true)
        const oracle = expectedAfter(sheet, frame)
        const stationary = sheet.wires.filter((s) => !frame.replaced.has(s.id))
        if (frame.blocked) {
          const unreal = frame.conflicts.filter((k) => !realContact(k, sheet, frame))
          expect.soft(unreal, `${where}: every conflict that blocks the offset is a real contact with another net`).toEqual([])
          if (oracle.blocked) tally.blockedOnCrossing++
          else tally.blocked++
          continue
        }
        expect.soft(oracle.blocked, `${where}: a pin on a crossing is blocked`).toBe(false)
        const done = plan.commit(offset, counter("d"))
        if (!done) {
          tally.routeless++
          continue
        }
        const moved = new Map(done.pins.map((p) => [p.key, p]))
        const pins = sheet.pins.map((p) => moved.get(p.key) ?? p)
        const result = commitEdit(sheet.wires, pins, done.edit, counter("e")).wires
        expect.soft(normalFormViolations(result, pins), `${where}: normal form`).toEqual([])
        expect.soft(canonical(pinPartition(wireNets(result, pins))), `${where}: the graph agrees with the brute force`).toEqual(canonical(referencePartition(result, pins)))
        expect.soft(canonical(referencePartition(result, pins)), `${where}: no net joined or split but where a carried pin landed`).toEqual(oracle.partition)
        if (frame.reroutes.length) tally.rerouted++
        else {
          tally.clean++
          const drawn = normalise([...stationary, ...frame.pieces.map((p) => ({ id: p.id, a: p.a, b: p.b, ...(p.color ? { color: p.color } : {}) }))], pins, undefined, counter("g"))
          expect.soft(geometryOf(drawn), `${where}: what the frame draws is what the release commits`).toEqual(geometryOf(result))
        }
        const back = planDrag(WireSheet.of(result, pins), wireNets(result, pins), { pins: keysOf(sheet, carried), heading: (key) => sheet.headings.get(key) }).commit(cells(-offset.x / GRID, -offset.y / GRID), counter("b"))
        if (!back || done.joins.length) continue
        const home = new Map(back.pins.map((p) => [p.key, p]))
        const pinsHome = pins.map((p) => home.get(p.key) ?? p)
        const returned = commitEdit(result, pinsHome, back.edit, counter("r")).wires
        expect.soft(canonical(referencePartition(returned, pinsHome)), `${where}: dragged back, the circuit it started from`).toEqual(canonical(referencePartition(sheet.wires, sheet.pins)))
      }
    }
    expect.soft(tally.clean, `most drags land clean: ${JSON.stringify(tally)}`).toBeGreaterThan(700)
  })
})

describe("the rubber band wired to the document: dragging parts and segments (design.md §6.3, §13.19)", () => {
  const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
  const by = (x: number, y: number) => [x * GRID, y * GRID] as const
  const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
  const ground = (id: string, x: number, y: number): PlacedObject => ({ id, def: "ground", x: x * GRID, y: y * GRID, props: { ref: id } })
  const supply = (id: string, x: number, y: number, label: string): PlacedObject => ({ id, def: "supply", x: x * GRID, y: y * GRID, props: { ref: id, value: label } })
  let n = 0
  const wire = (a: Point, b: Point, color?: WireColorKey): WireSegment => ({ id: `doc${++n}`, a, b, ...(color && { color }) })
  const chain = (...pts: Point[]) => pts.slice(1).map((p, i) => wire(pts[i], p))
  const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
  const wiringFor = (doc: Schematic) => wiringOf(new WireGraph(), doc)
  const viewOf = (doc: Schematic) => wireNets(doc.wires, wirePins(doc.objects))
  const nets = (doc: Schematic) => pinPartition(viewOf(doc))
  const placeOf = (doc: Schematic, id: string) => {
    const o = doc.objects.find((p) => p.id === id)!
    return { x: o.x / GRID, y: o.y / GRID, rotation: o.rotation ?? 0, mirror: !!o.mirror }
  }
  const ids = counter("p")
  const carried = (...objects: string[]) => ({ objects: new Set(objects) })

  it("a part dragged keeps its wire attached and orthogonal: a straight pin-to-pin wire becomes a Z that leaves each pin along its axis (design.md §13.19 Q2; KiCad orthoLineDrag; Altium Drag Orthogonal)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 0)], [wire(at(4, 1), at(10, 1))])
    const landed = new PartDrag(doc, wiringFor(doc), carried("R2")).landed(...by(0, 2), ids)
    expect.soft(placeOf(landed.doc, "R2"), "R2 where it was dropped").toEqual({ x: 10, y: 2, rotation: 0, mirror: false })
    expect.soft(geometryOf(landed.doc.wires), "out of R1 one step, down, on into R2").toEqual(geometryOf(chain(at(4, 1), at(5, 1), at(5, 3), at(10, 3))))
    expect.soft(nets(landed.doc), "still one net").toEqual([["R1:2", "R2:1"]])
    expect.soft(normalFormViolations(landed.doc.wires, wirePins(landed.doc.objects)), "normal form").toEqual([])
  })

  it("a wire whose far end hangs free travels whole with the part, bends and all (design.md §13.19 Q6; KiCad orthoLineDrag: nothing attached, the wire translates)", () => {
    const doc = docOf([resistor("R1", 0, 0)], chain(at(4, 1), at(7, 1), at(7, 3)))
    const landed = new PartDrag(doc, wiringFor(doc), carried("R1")).landed(...by(2, 2), ids)
    expect.soft(geometryOf(landed.doc.wires), "the whole hanging wire moved by the same offset").toEqual(geometryOf(chain(at(6, 3), at(9, 3), at(9, 5))))
  })

  it("a wire the re-route cannot lay clean does not cancel the drop: the part lands where it was dropped, the wire is left unlaid, marked and named, and no net merges (design.md §13.19 Q9, §6.7; KiCad, Altium and OrCAD never refuse a drop)", () => {
    const fence = [wire(at(9.5, 5), at(7, 5)), wire(at(10, 4.5), at(10, 2.5)), wire(at(10, 5.5), at(10, 8))]
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 0)], [wire(at(4, 1), at(10, 1)), ...fence])
    const drag = new PartDrag(doc, wiringFor(doc), carried("R2"))
    expect.soft(drag.blocked(...by(0, 4)), "the offset itself is not blocked").toBe(false)
    const landed = drag.landed(...by(0, 4), ids)
    expect.soft(landed.at, "dropped where it was let go").toEqual(at(0, 4))
    expect.soft(placeOf(landed.doc, "R2"), "R2 moved").toEqual({ x: 10, y: 4, rotation: 0, mirror: false })
    expect.soft(landed.unlaid.map((u) => [u.pin, u.kept]), "R2's wire named as not laid, and kept where it was").toEqual([["R2:1", true]])
    expect.soft(geometryOf(landed.doc.wires), "the wire where it was, the fence untouched").toEqual(geometryOf([wire(at(4, 1), at(10, 1)), ...fence]))
    expect.soft(nets(landed.doc), "no net joined to the fence, and R2's pin left open rather than wired through it").toEqual([])
    expect.soft(normalFormViolations(landed.doc.wires, wirePins(landed.doc.objects)), "normal form").toEqual([])
  })

  it("an offset that puts a pin on a crossing is blocked, and the drop lands on the nearest clean offset (junctions.md 28; design.md §6.7)", () => {
    const doc = docOf(
      [resistor("A", -4, 4), resistor("B", 10, 4), resistor("C", 4, -4, 90), resistor("D", 4, 10, 90), resistor("R1", 14, 10)],
      [wire(at(0, 5), at(10, 5)), wire(at(5, 0), at(5, 10))],
    )
    const drag = new PartDrag(doc, wiringFor(doc), carried("R1"))
    expect.soft(drag.blocked(...by(-13, -6)), "R1's right pin on the crossing").toBe(true)
    const landed = drag.landed(...by(-13, -6), ids)
    expect.soft(landed.at, "somewhere else").not.toEqual(at(-13, -6))
    expect.soft(drag.blocked(landed.at.x, landed.at.y), "a clean offset").toBe(false)
    expect.soft(nets(landed.doc).some((g) => g.includes("A:2") && g.includes("C:2")), "the crossing's nets kept apart").toBe(false)
  })

  it("Alt held at the start detaches: the part moves alone and its old pin points become dangling ends (KiCad M, LTspice F7; design.md §6.3)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 0)], [wire(at(4, 1), at(10, 1))])
    const landed = new PartDrag(doc, wiringFor(doc), carried("R2"), { detach: true }).landed(...by(0, 3), ids)
    expect.soft(geometryOf(landed.doc.wires), "the wire where it was").toEqual(geometryOf([wire(at(4, 1), at(10, 1))]))
    expect.soft(danglingEnds(viewOf(landed.doc)), "its end hangs where R2's pin was").toEqual([at(10, 1)])
    expect.soft(nets(landed.doc), "R2 off the net").toEqual([])
  })

  it("a part dropped with one pin on a wire splits it there and the pin joins, with a dot (junctions.md 25); a lone pin joining a net is no merge of nets", () => {
    const doc = docOf([resistor("R2", 0, 0), resistor("R3", 12, 0), resistor("R4", 20, 20, 90)], [wire(at(4, 1), at(12, 1))])
    const before = wiringFor(doc)
    const landed = new PartDrag(doc, before, carried("R4")).landed(...by(-13, -19), ids)
    expect.soft(junctionsOf(viewOf(landed.doc)), "the dot under R4's pin").toEqual([at(8, 1)])
    expect.soft(nets(landed.doc), "R4 on the net").toEqual([["R2:2", "R3:1", "R4:1"]])
    expect.soft(netChanges(before.circuit.nets, wiringFor(landed.doc).circuit.nets).joined, "no two nets joined").toEqual([])
  })

  it("dragging a segment moves it along its normal and its neighbours stretch (design.md §6.3, dragging a segment; LibrePCB, KiCad)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 4)], chain(at(4, 1), at(7, 1), at(7, 5), at(10, 5)))
    const middle = doc.wires.find((s) => s.a.x === s.b.x)!
    const landed = new SegmentDrag(doc, wiringFor(doc), middle.id).landed(...by(1.2, 5))
    expect.soft(geometryOf(landed.doc.wires), "the upright piece one cell right").toEqual(geometryOf(chain(at(4, 1), at(8, 1), at(8, 5), at(10, 5))))
  })

  it("two dangling ends of different nets brought together by a dragged segment join, the frame knowing it before the release (junctions.md 16)", () => {
    const doc = docOf(
      [resistor("A", 0, 0), ground("G1", 3, 2), resistor("B", 14, 3), supply("V1", 13, 0, "VCC")],
      [wire(at(4, 1), at(4, 2)), wire(at(4, 1), at(6, 1)), wire(at(6, 1), at(6, 4)), wire(at(14, 2), at(14, 4)), wire(at(14, 4), at(8, 4))],
    )
    const before = wiringFor(doc)
    const upright = doc.wires.find((s) => s.a.x === at(6, 0).x && s.b.x === at(6, 0).x)!
    const drag = new SegmentDrag(doc, before, upright.id)
    expect.soft(drag.frame(...by(2, 0)).joins.length, "the join known before the release").toBe(1)
    const landed = drag.landed(...by(2, 0))
    expect.soft(netChanges(before.circuit.nets, wiringFor(landed.doc).circuit.nets).joined.length, "one join").toBe(1)
  })
})

describe("Alt on a wire detaches the segment under the pointer: it moves alone, any way, and leaves what it touched (design.md §6.3; KiCad M, OrCAD Alt, Altium Ctrl+drag)", () => {
  const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
  const by = (x: number, y: number) => [x * GRID, y * GRID] as const
  const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
  let n = 0
  const wire = (a: Point, b: Point): WireSegment => ({ id: `alt${++n}`, a, b })
  const chain = (...pts: Point[]) => pts.slice(1).map((p, i) => wire(pts[i], p))
  const docOf = (objects: PlacedObject[], wires: WireSegment[]): Schematic => inNormalForm({ objects, wires, parts: {} })
  const wiringFor = (doc: Schematic) => wiringOf(new WireGraph(), doc)
  const viewOf = (doc: Schematic) => wireNets(doc.wires, wirePins(doc.objects))
  const nets = (doc: Schematic) => pinPartition(viewOf(doc))
  const normal = (doc: Schematic) => normalFormViolations(doc.wires, wirePins(doc.objects))
  const tee = () => docOf([resistor("R1", 19, 2, 90), resistor("R2", 19, 14, 90)], [...chain(at(20, 6), at(20, 10), at(20, 14)), wire(at(12, 10), at(20, 10))])
  const branchOf = (doc: Schematic) => doc.wires.find((s) => s.a.y === at(0, 10).y && s.b.y === at(0, 10).y)!
  const altDrag = (doc: Schematic, segment: string) => new SegmentDrag(doc, wiringFor(doc), segment, undefined, { detach: true })
  const spine = [wire(at(20, 6), at(20, 14))]

  it("the user's wire, an open end teeing into an upright, Alt-dragged three cells left: it lands there, the upright closes up with no dot, and the circuit is the one it was", () => {
    const doc = tee()
    const landed = altDrag(doc, branchOf(doc).id).landed(...by(-3, 0.2), counter("l"))
    expect.soft(landed.at, "dropped where it was let go").toEqual(at(-3, 0))
    expect.soft(geometryOf(landed.doc.wires), "the wire three cells left, the upright whole").toEqual(geometryOf([...spine, wire(at(9, 10), at(17, 10))]))
    expect.soft(junctionsOf(viewOf(landed.doc)), "no dot left where it teed in").toEqual([])
    expect.soft(danglingEnds(viewOf(landed.doc)), "both its ends open").toEqual([at(9, 10), at(17, 10)])
    expect.soft(nets(landed.doc), "R1 and R2 still on one net").toEqual([["R1:2", "R2:1"]])
    expect.soft(normal(landed.doc), "normal form").toEqual([])
  })

  it("Alt-dragged three cells right, across the upright it left: a crossing with no dot, not a four-way joint, as the band drew it", () => {
    const doc = tee()
    const drag = altDrag(doc, branchOf(doc).id)
    const frame = drag.frame(...by(3, 0))
    const landed = drag.landed(...by(3, 0), counter("r"))
    expect.soft(geometryOf(landed.doc.wires), "the wire across the upright, the upright whole").toEqual(geometryOf([...spine, wire(at(15, 10), at(23, 10))]))
    expect.soft(junctionsOf(viewOf(landed.doc)), "no dot on the crossing").toEqual([])
    expect.soft(danglingEnds(viewOf(landed.doc)), "both its ends open").toEqual([at(15, 10), at(23, 10)])
    expect.soft(geometryOf(frame.pieces.map((p, i) => ({ id: `f${i}`, a: p.a, b: p.b }))), "the band draws exactly what the release commits").toEqual(geometryOf(landed.doc.wires))
    expect.soft(frame.blocked, "a clean offset").toBe(false)
    expect.soft(normal(landed.doc), "normal form").toEqual([])
  })

  it("Alt-dragged down or diagonally it goes where the pointer went; plain, the same press moves it only across itself, so left and right do nothing (design.md §6.3: a plain segment drag moves along its normal)", () => {
    const doc = tee()
    const id = branchOf(doc).id
    const plain = new SegmentDrag(doc, wiringFor(doc), id)
    expect.soft(plain.landed(...by(-3, 0)).doc, "plain, left: nothing moves").toBe(doc)
    expect.soft(plain.landed(...by(3, 0)).doc, "plain, right: nothing moves").toBe(doc)
    const down = altDrag(doc, id).landed(...by(0, 2), counter("d"))
    expect.soft(geometryOf(down.doc.wires), "Alt, down: its end lands on the upright two cells lower, as a plain drag puts it").toEqual(geometryOf(new SegmentDrag(doc, wiringFor(doc), id).landed(...by(0, 2), counter("p")).doc.wires))
    expect.soft(junctionsOf(viewOf(down.doc)), "the dot where it meets the upright now").toEqual([at(20, 12)])
    const slant = altDrag(doc, id).landed(...by(-3, 2), counter("s"))
    expect.soft(geometryOf(slant.doc.wires), "Alt, left and down: both at once").toEqual(geometryOf([...spine, wire(at(9, 12), at(17, 12))]))
  })

  it("only the segment under the pointer goes, as Alt moves a part alone: its neighbours stay where they were and hang open where it left them (design.md §6.3; the user, 2026-11-12)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 4)], chain(at(4, 1), at(7, 1), at(7, 5), at(10, 5)))
    const upright = doc.wires.find((s) => s.a.x === s.b.x)!
    expect.soft(new SegmentDrag(doc, wiringFor(doc), upright.id).landed(...by(-4, 3)).doc.wires.length, "plain, the same press keeps the wire whole").toBe(3)
    const drag = altDrag(doc, upright.id)
    expect.soft([...drag.touched], "the band lifts that segment and nothing else").toEqual([upright.id])
    const landed = drag.landed(...by(-4, 3), counter("u"))
    expect.soft(geometryOf(landed.doc.wires), "the upright moved alone, both legs where they were").toEqual(geometryOf([wire(at(4, 1), at(7, 1)), wire(at(3, 4), at(3, 8)), wire(at(7, 5), at(10, 5))]))
    expect.soft(sortedPoints(danglingEnds(viewOf(landed.doc))), "the legs open where it left them, its own ends open where it landed").toEqual(sortedPoints([at(3, 4), at(3, 8), at(7, 1), at(7, 5)]))
    expect.soft(nets(landed.doc), "R1 and R2 parted").toEqual([])
    expect.soft(normal(landed.doc), "normal form").toEqual([])
  })

  it("a run between two pins Alt-dragged off them translates whole, with no wire grown back to either pin", () => {
    const doc = docOf([resistor("R1", 10, 10), resistor("R2", 20, 10)], [wire(at(14, 11), at(20, 11))])
    const landed = altDrag(doc, doc.wires[0].id).landed(...by(0, 3), counter("t"))
    expect.soft(geometryOf(landed.doc.wires), "the wire alone, three cells down").toEqual(geometryOf([wire(at(14, 14), at(20, 14))]))
    expect.soft(nets(landed.doc), "both pins open").toEqual([])
  })

  it("its ends join what they are dropped on, as a drawn wire's do, and the frame knows it before the release (design.md §6.7: connections are made by ends)", () => {
    const doc = docOf(
      [resistor("R1", 19, 2, 90), resistor("R2", 19, 14, 90), resistor("R3", 9, 20, 90), resistor("R6", 2, 15)],
      [...chain(at(20, 6), at(20, 10), at(20, 14)), wire(at(10, 10), at(20, 10)), ...chain(at(10, 11), at(10, 16), at(10, 20)), wire(at(6, 16), at(10, 16))],
    )
    const before = wiringFor(doc)
    const drag = new SegmentDrag(doc, before, branchOf(doc).id, undefined, { detach: true })
    expect.soft(drag.frame(...by(0, 2)).joins.length, "the join known before the release").toBe(1)
    const landed = drag.landed(...by(0, 2), counter("j"))
    expect.soft(nets(landed.doc), "R3 and R6 joined to R1 and R2 through the dropped wire's ends").toEqual([["R1:2", "R2:1", "R3:1", "R6:2"]])
    expect.soft(netChanges(before.circuit.nets, wiringFor(landed.doc).circuit.nets).joined.length, "one join").toBe(1)
    expect.soft(normal(landed.doc), "normal form").toEqual([])
  })

  it("dropped along another net's wire it is refused there and lands on the nearest clean offset, joining nothing (design.md §6.7)", () => {
    const other = wire(at(6, 13), at(14, 13))
    const doc = docOf([resistor("R1", 19, 2, 90), resistor("R2", 19, 14, 90), resistor("R4", 2, 12)], [...chain(at(20, 6), at(20, 10), at(20, 14)), wire(at(12, 10), at(20, 10)), other])
    const drag = altDrag(doc, branchOf(doc).id)
    expect.soft(drag.frame(...by(-4, 3)).blocked, "along R4's wire: blocked").toBe(true)
    const landed = drag.landed(...by(-4, 3), counter("b"))
    expect.soft(landed.refused, "a drop, not a refusal").toBeUndefined()
    expect.soft(landed.at, "somewhere else").not.toEqual(at(-4, 3))
    expect.soft(drag.frame(landed.at.x, landed.at.y).blocked, "a clean offset").toBe(false)
    expect.soft(Math.abs(landed.at.x - at(-4, 3).x) + Math.abs(landed.at.y - at(-4, 3).y), "a cell away").toBe(GRID)
    expect.soft(nets(landed.doc), "R4 kept apart from R1 and R2").toEqual([["R1:2", "R2:1"]])
    expect.soft(normal(landed.doc), "normal form").toEqual([])
  })

  it("the wire it left closes up only where nothing else holds the point: two colours keep their joint, a corner stays a corner, and a socket keeps both wires ending on it (design.md §4.5)", () => {
    const coloured = docOf([resistor("R1", 19, 2, 90), resistor("R2", 19, 14, 90)], [wire(at(20, 6), at(20, 10)), { ...wire(at(20, 10), at(20, 14)), color: "red" }, wire(at(12, 10), at(20, 10))])
    const left = altDrag(coloured, branchOf(coloured).id).landed(...by(-3, 0), counter("c"))
    expect.soft(geometryOf(left.doc.wires), "the upright still in two colours, joined where the colour changes").toEqual(geometryOf([wire(at(20, 6), at(20, 10)), { ...wire(at(20, 10), at(20, 14)), color: "red" }, wire(at(9, 10), at(17, 10))]))
    const corner = docOf([resistor("R1", 19, 2, 90), resistor("R7", 26, 9)], [...chain(at(20, 6), at(20, 10), at(26, 10)), wire(at(12, 10), at(20, 10))])
    const cornerLeft = altDrag(corner, corner.wires.find((s) => s.a.y === s.b.y && Math.min(s.a.x, s.b.x) === at(12, 0).x)!.id).landed(...by(-3, 0), counter("o"))
    expect.soft(geometryOf(cornerLeft.doc.wires), "a corner stays a corner").toEqual(geometryOf([...chain(at(20, 6), at(20, 10), at(26, 10)), wire(at(9, 10), at(17, 10))]))
    expect.soft(normal(cornerLeft.doc), "normal form").toEqual([])
    const socket: WirePin = { key: "J1:1", at: c(20, 10), socket: true }
    const pins: WirePin[] = [socket, { key: "R1:1", at: c(20, 6) }, { key: "R2:1", at: c(20, 14) }]
    const wires = normalise([...path(c(20, 6), c(20, 10), c(20, 14)), w(c(12, 10), c(20, 10))], pins, undefined, counter("n"))
    const branch = wires.find((s) => s.a.y === s.b.y)!
    const plan = planDrag(WireSheet.of(wires, pins), new WireGraph().of(wires, pins), { pins: [], wires: [branch.id], detach: true })
    const done = plan.commit(c(-3, 0), counter("k"))!
    const after = commitEdit(wires, pins, done.edit, counter("m")).wires
    expect.soft(geometryOf(after), "both halves still end on the socket").toEqual(geometryOf([...path(c(20, 6), c(20, 10), c(20, 14)), w(c(9, 10), c(17, 10))]))
    expect.soft(canonical(pinPartition(wireNets(after, pins))), "the socket still on R1's and R2's net").toEqual(canonical([["J1:1", "R1:1", "R2:1"]]))
  })

  it("dropped through a part's body it is refused there too (design.md §13.27)", () => {
    const doc = docOf([resistor("R1", 19, 2, 90), resistor("R2", 19, 14, 90), resistor("R5", 10, 16)], [...chain(at(20, 6), at(20, 10), at(20, 14)), wire(at(12, 10), at(20, 10))])
    const drag = altDrag(doc, branchOf(doc).id)
    expect.soft(drag.frame(...by(0, 7)).blocked, "over R5's body: blocked").toBe(true)
  })
})

describe("turning and mirroring with wires (design.md §6.6, §13.17, §13.19 Q14)", () => {
  const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
  const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
  const led = (id: string, x: number, y: number): PlacedObject => ({ id, def: "led", x: x * GRID, y: y * GRID, props: { ref: id } })
  const npn = (id: string, x: number, y: number): PlacedObject => ({ id, def: "npn", x: x * GRID, y: y * GRID, props: { ref: id } })
  const ground = (id: string, x: number, y: number): PlacedObject => ({ id, def: "ground", x: x * GRID, y: y * GRID, props: { ref: id } })
  const supply = (id: string, x: number, y: number): PlacedObject => ({ id, def: "supply", x: x * GRID, y: y * GRID, props: { ref: id, value: "+5V" } })
  let n = 0
  const wire = (a: Point, b: Point): WireSegment => ({ id: `t${++n}`, a, b })
  const chain = (...pts: Point[]) => pts.slice(1).map((p, i) => wire(pts[i], p))
  const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
  const wiringFor = (doc: Schematic) => wiringOf(new WireGraph(), doc)
  const viewOf = (doc: Schematic) => wireNets(doc.wires, wirePins(doc.objects))
  const nets = (doc: Schematic) => pinPartition(viewOf(doc))
  const placeOf = (doc: Schematic, id: string) => {
    const o = doc.objects.find((p) => p.id === id)!
    return { x: o.x / GRID, y: o.y / GRID, rotation: o.rotation ?? 0 }
  }
  const ids = counter("t")

  it("a selection turns as one body about its middle: the parts swing round it, the wire between them turns with them and nothing is rubber-banded inside (design.md §13.19 Q14; KiCad and Altium turn a selection as a group)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 6, 0)], [wire(at(4, 1), at(6, 1))])
    const run = new TurnRun(doc, wiringFor(doc), new Set(["R1", "R2"]))
    run.turned(1, ids)
    const done = run.turned(1, ids)
    expect.soft([placeOf(done.doc, "R1"), placeOf(done.doc, "R2")], "R1 above R2, both standing").toEqual([
      { x: 4, y: -4, rotation: 90 },
      { x: 4, y: 2, rotation: 90 },
    ])
    expect.soft(geometryOf(done.doc.wires), "the wire between them turned with them").toEqual(geometryOf([wire(at(5, 0), at(5, 2))]))
  })

  it("a run of R presses is one turn: R then Shift+R gives back the drawing it started from, wires and all (design.md §6.6)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 0), resistor("R3", 0, 6)], [wire(at(4, 1), at(10, 1)), ...chain(at(0, 1), at(-2, 1), at(-2, 7), at(0, 7))])
    const run = new TurnRun(doc, wiringFor(doc), new Set(["R1"]))
    run.turned(1, ids)
    const back = run.turned(-1, ids)
    expect.soft(geometryOf(back.doc.wires), "the wires as they were").toEqual(geometryOf(doc.wires))
    expect.soft(placeOf(back.doc, "R1"), "R1 as it was").toEqual(placeOf(doc, "R1"))
  })

  it("R pressed twice on a part with a branch on its pin leaves the wiring of a single right-angle turn: a short wire to the spine, no jog from the diagonal stop (junctions.md 17)", () => {
    const doc = docOf([resistor("R2", 0, 1), resistor("R1", 0, 5), resistor("R3", 0, 9)], chain(at(4, 2), at(4, 6), at(4, 10)))
    const run = new TurnRun(doc, wiringFor(doc), new Set(["R1"]))
    run.turned(1, ids)
    const done = run.turned(1, ids)
    expect.soft(geometryOf(done.doc.wires), "the spine put, a short wire from R1's lower pin").toEqual(geometryOf([...chain(at(4, 2), at(4, 8), at(4, 10)), wire(at(2, 8), at(4, 8))]))
    expect.soft(junctionsOf(viewOf(done.doc)), "the dot where it meets the spine").toEqual([at(4, 8)])
  })

  it("an LED mirrored keeps its circuit: each wire follows its own pin, no pin lands on the other's wire end (design.md §13.17; ГОСТ 2.702: a mirrored symbol is the same element)", () => {
    const doc = docOf([led("D1", 0, 0), supply("V1", -5, -3), ground("G1", 7, 2)], [...chain(at(-4, -1), at(-4, 1), at(0, 1)), ...chain(at(4, 1), at(8, 1), at(8, 2))])
    const before = nets(doc)
    const done = flippedWithWires(doc, wiringFor(doc), new Set(["D1"]), "horizontal", ids)
    expect.soft(done.doc.objects.find((o) => o.id === "D1")?.mirror, "mirrored").toBe(true)
    expect.soft(nets(done.doc), "the anode still on the rail, the cathode still on ground").toEqual(before)
    expect.soft(danglingEnds(viewOf(done.doc)), "no stub left hanging where a wire was laid again (Codex 11, runBeyond)").toEqual([])
    const body = footprint(done.doc.objects.find((o) => o.id === "D1")!, GRID)!.box
    expect.soft(done.doc.wires.filter((s) => Math.max(s.a.x, s.b.x) > body.x && Math.min(s.a.x, s.b.x) < body.x + body.w && Math.max(s.a.y, s.b.y) > body.y && Math.min(s.a.y, s.b.y) < body.y + body.h).length, "no wire through the LED's body (Claude 8, solid)").toBe(0)
    expect.soft(normalFormViolations(done.doc.wires, wirePins(done.doc.objects)), "normal form").toEqual([])
  })

  it("a transistor mirrored keeps its circuit: base, collector and emitter each keep their wire (design.md §13.17)", () => {
    const doc = docOf(
      [npn("Q1", 0, 0), resistor("R1", -8, 1), resistor("R2", 2, -6, 90), ground("G1", 2, 6)],
      [wire(at(-4, 2), at(0, 2)), wire(at(3, -2), at(3, 0)), wire(at(3, 4), at(3, 6))],
    )
    const before = nets(doc)
    const done = flippedWithWires(doc, wiringFor(doc), new Set(["Q1"]), "horizontal", ids)
    expect.soft(nets(done.doc), "the same three nets").toEqual(before)
    expect.soft(normalFormViolations(done.doc.wires, wirePins(done.doc.objects)), "normal form").toEqual([])
  })
})

describe("a run of presses in the store (found on the field, 2026-11-05)", () => {
  it("the second press of a run turns from the drawing before the first even after the store's graph has taken the first press", () => {
    const doc = inNormalForm({ objects: [{ id: "D1", def: "diode", x: 0, y: 0, props: { ref: "D1" } }], wires: [], parts: {} })
    const graph = new WireGraph()
    const run = new TurnRun(doc, wiringOf(graph, doc), new Set(["D1"]))
    const first = run.turned(-1)
    wiringOf(graph, first.doc)
    const second = run.turned(-1)
    expect.soft(second.refused, "not refused").toBeUndefined()
    expect.soft(second.doc.objects[0].rotation, "two 45° steps back from where it started").toBe(270)
  })
})

describe("a module plugged into a header (found on the field, 2026-11-05)", () => {
  it("lifted off, it unplugs like the real header: no wire grows from the sockets and no two of its nets join; put back, the circuit is the one it started with", async () => {
    const { examples } = await import("@/schematic/examples")
    const doc = examples.find((e) => e.id === "open746-lcd")!.build(GRID)
    const lcd = doc.objects.find((o) => o.def === "lcd7-f")!
    const before = wiringOf(new WireGraph(), doc)
    const away = new PartDrag(doc, before, { objects: new Set([lcd.id]) }).landed(0, 60 * GRID)
    const lifted = wiringOf(new WireGraph(), away.doc)
    expect.soft(away.doc.wires.length, "no wire grown").toBe(doc.wires.length)
    expect.soft(netChanges(before.circuit.nets, lifted.circuit.nets).joined, "no net joined").toEqual([])
    expect.soft(lifted.circuit.nets.some((g) => g.some((k) => k.startsWith(`${lcd.id}:`))), "the LCD on no net").toBe(false)
    const back = new PartDrag(away.doc, lifted, { objects: new Set([lcd.id]) }).landed(0, -60 * GRID)
    expect.soft(pinPartition(wireNets(back.doc.wires, wirePins(back.doc.objects))), "plugged back: the circuit it started with").toEqual(pinPartition(wireNets(doc.wires, wirePins(doc.objects))))
  })
})

describe("a far drop with nowhere clean near it (found on the field, 2026-11-05)", () => {
  it("refuses a crowded chip drop when the fallback re-route would lay a wire through a body", async () => {
    const { stressDocuments } = await import("../../scripts/lib/stress")
    const [doc] = stressDocuments([16])
    const snapshot = structuredClone(doc)
    const chip = doc.objects.find((o) => o.def === "stm32f746ig")!
    const before = wiringOf(new WireGraph(), doc)
    const offset = { x: 13 * GRID, y: 7 * GRID }
    const drag = new PartDrag(doc, before, { objects: new Set([chip.id]) })
    expect(drag.blocked(offset.x, offset.y)).toBe(true)
    const landed = drag.landed(offset.x, offset.y)
    expect(landed.refused?.some((c) => c.reason === "body")).toBe(true)
    expect(landed.doc).toBe(doc)
    expect(landed.at).toEqual({ x: 0, y: 0 })
    expect(doc).toEqual(snapshot)
    expect(normalFormViolations(doc.wires, wirePins(doc.objects))).toEqual([])
    expect(wiringOf(new WireGraph(), landed.doc).circuit.nets).toEqual(before.circuit.nets)
  })
})

describe("a mirrored chip's wires go round it (found on the morning sheet, 2026-11-05)", () => {
  it("no wire of a 555 mirrored in place runs through its body when a way round exists, and its circuit is kept (ГОСТ 2.701-84: lines do not pass through symbols; design.md §5.1)", () => {
    const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
    let n = 0
    const wire = (a: Point, b: Point): WireSegment => ({ id: `c${++n}`, a, b })
    const chain = (...pts: Point[]) => pts.slice(1).map((p, i) => wire(pts[i], p))
    const part = (id: string, def: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def, x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
    const doc = inNormalForm({
      objects: [part("U1", "ne555", 0, 0), part("V1", "supply", 6, -6), part("G1", "ground", 3, 11), part("R1", "resistor", 12, 4), part("R2", "resistor", -4, -1, 90)],
      wires: [wire(at(7, -4), at(7, 1)), ...chain(at(4, 1), at(4, -1), at(7, -1)), wire(at(4, 9), at(4, 11)), wire(at(9, 5), at(12, 5)), ...chain(at(1, 5), at(-1, 5), at(-1, 7), at(1, 7)), wire(at(1, 3), at(-3, 3))],
      parts: {},
    })
    const done = flippedWithWires(doc, wiringOf(new WireGraph(), doc), new Set(["U1"]), "horizontal", counter("f"))
    const body = footprint(done.doc.objects.find((o) => o.id === "U1")!, GRID)!.box
    const through = done.doc.wires.filter((s) => Math.max(s.a.x, s.b.x) > body.x && Math.min(s.a.x, s.b.x) < body.x + body.w && Math.max(s.a.y, s.b.y) > body.y && Math.min(s.a.y, s.b.y) < body.y + body.h)
    expect.soft(through.map((s) => [s.a.x / GRID, s.a.y / GRID, s.b.x / GRID, s.b.y / GRID]), "no piece through the 555's drawn body").toEqual([])
    expect.soft(pinPartition(wireNets(done.doc.wires, wirePins(done.doc.objects))), "the same nets").toEqual(pinPartition(wireNets(doc.wires, wirePins(doc.objects))))
    expect.soft(normalFormViolations(done.doc.wires, wirePins(done.doc.objects)), "normal form").toEqual([])
  })
})

describe("nothing joins that a landing pin does not explain (review of phase 4, Codex 1)", () => {
  it("the bridge's R4 dragged far and the 74HC595 turned join no two nets through a generated corner (design.md §6.7)", async () => {
    const { examples } = await import("@/schematic/examples")
    const { unexplainedJoins } = await import("../lib/explained-joins")
    const bridge = examples.find((e) => e.id === "bridge")!.build(GRID)
    const r4 = bridge.objects.find((o) => o.props?.ref === "R4")!
    const dragged = new PartDrag(bridge, wiringOf(new WireGraph(), bridge), { objects: new Set([r4.id]) }).landed(-10 * GRID, -12 * GRID, counter("b"))
    expect.soft(unexplainedJoins(bridge, dragged.doc, new Set([r4.id])), "R4 dragged").toEqual([])
    const shift = examples.find((e) => e.id === "nucleo-74hc595")!.build(GRID)
    const u2 = shift.objects.find((o) => o.props?.ref === "U2")!
    const turned = new TurnRun(shift, wiringOf(new WireGraph(), shift), new Set([u2.id])).turned(1, counter("u"))
    expect.soft(unexplainedJoins(shift, turned.doc, new Set([u2.id])), "U2 turned").toEqual([])
    expect.soft(normalFormViolations(turned.doc.wires, wirePins(turned.doc.objects)), "normal form").toEqual([])
  })

  it("random drags, turns and mirrors on four examples join no nets but where a carried pin lands on a conductor, and stay in normal form", async () => {
    const { examples } = await import("@/schematic/examples")
    const { unexplainedJoins } = await import("../lib/explained-joins")
    const rng = random(4044)
    for (const id of ["bridge", "power-supply", "metronome", "nucleo-74hc595"]) {
      const doc = examples.find((e) => e.id === id)!.build(GRID)
      const wiring = wiringOf(new WireGraph(), doc)
      for (let k = 0; k < 40; k++) {
        const one = doc.objects[Math.floor(rng.next() * doc.objects.length)]
        const ids = new Set([one.id])
        const kind = Math.floor(rng.next() * 3)
        const step = () => (Math.floor(rng.next() * 13) - 6) * GRID
        const result = kind === 0 ? new PartDrag(doc, wiring, { objects: ids }).landed(step(), step(), counter("r")) : kind === 1 ? new TurnRun(doc, wiring, ids).turned(rng.next() < 0.5 ? 1 : -1, counter("t")) : flippedWithWires(doc, wiring, ids, rng.next() < 0.5 ? "horizontal" : "vertical", counter("f"))
        const what = `${id}: ${["drag", "turn", "mirror"][kind]} of ${one.props?.ref ?? one.def}`
        expect.soft(unexplainedJoins(doc, result.doc, ids), what).toEqual([])
        expect.soft(normalFormViolations(result.doc.wires, wirePins(result.doc.objects)), `${what}: normal form`).toEqual([])
      }
    }
  })
})

describe("found by phase 4's review (Codex)", () => {
  const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
  const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
  let n = 0
  const wire = (a: Point, b: Point): WireSegment => ({ id: `cx${++n}`, a, b })
  const chain = (...pts: Point[]) => pts.slice(1).map((p, i) => wire(pts[i], p))
  const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
  const nets = (doc: Schematic) => pinPartition(wireNets(doc.wires, wirePins(doc.objects)))

  it("two carried parts whose pins touched stay joined when a turn parts those pins: a wire grows between them (Codex 4)", () => {
    const doc = docOf([resistor("A", 0, 0), resistor("B", 4, 0)])
    const turned = new TurnRun(doc, wiringOf(new WireGraph(), doc), new Set(["A", "B"])).turned(1, counter("s"))
    expect.soft(nets(turned.doc), "still one net").toEqual([["A:2", "B:1"]])
    expect.soft(normalFormViolations(turned.doc.wires, wirePins(turned.doc.objects)), "normal form").toEqual([])
  })

  it("a drag whose document moved on under it draws nothing and commits nothing rather than read an out-of-date graph (Codex 6)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 0)], [wire(at(4, 1), at(10, 1))])
    const graph = new WireGraph()
    const drag = new PartDrag(doc, wiringOf(graph, doc), { objects: new Set(["R2"]) })
    const recoloured = { ...doc, wires: doc.wires.map((s) => ({ ...s, color: "red" as const })) }
    wiringOf(graph, recoloured)
    expect.soft(() => drag.frame(0, 2 * GRID), "no throw").not.toThrow()
    expect.soft(drag.frame(0, 2 * GRID).pieces, "nothing drawn").toEqual([])
    expect.soft(drag.landed(0, 2 * GRID).refused, "nothing committed").toBeDefined()
  })

  it("Alt-dragging two wired parts moves the parts alone: the wire between them stays and hangs from where their pins were (design.md §6.3; Codex 7)", () => {
    const doc = docOf([resistor("A", 0, 0), resistor("B", 10, 0), resistor("C", 30, 0)], [wire(at(4, 1), at(10, 1))])
    const landed = new PartDrag(doc, wiringOf(new WireGraph(), doc), { objects: new Set(["A", "B"]) }, { detach: true }).landed(0, 3 * GRID, counter("a"))
    expect.soft(geometryOf(landed.doc.wires), "the wire where it was").toEqual(geometryOf([wire(at(4, 1), at(10, 1))]))
    expect.soft(nets(landed.doc), "the parts off it").toEqual([])
  })

  it("the band's reach names every wire a drag may redraw, so the zoomed-out canvas can leave them to the band (Codex 9)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 8, 4, 90)], chain(at(4, 1), at(9, 1), at(9, 4)))
    const drag = new PartDrag(doc, wiringOf(new WireGraph(), doc), { objects: new Set(["R1"]) })
    expect.soft([...drag.touched].sort(), "both pieces of the L: the one from R1 and the one its bend slides along").toEqual(doc.wires.map((s) => s.id).sort())
    expect.soft([...drag.frame(0, 2 * GRID).replaced].sort(), "and the frame does replace both").toEqual(doc.wires.map((s) => s.id).sort())
  })

  it("a wire hanging free from a dragged part's pin travels whole while the same pin's net goes on to a part that stays (Codex 11, hangingRuns)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 0)], [wire(at(4, 1), at(10, 1)), ...chain(at(4, 1), at(4, -2), at(6, -2))])
    const landed = new PartDrag(doc, wiringOf(new WireGraph(), doc), { objects: new Set(["R1"]) }).landed(2 * GRID, 2 * GRID, counter("h"))
    expect.soft(geometryOf(landed.doc.wires), "the bent stub moved by the drag, whole").toEqual(expect.arrayContaining(geometryOf(chain(at(6, 3), at(6, 0), at(8, 0)))))
    expect.soft(nets(landed.doc), "R1 and R2 still joined").toEqual([["R1:2", "R2:1"]])
    expect.soft(normalFormViolations(landed.doc.wires, wirePins(landed.doc.objects)), "normal form").toEqual([])
  })

  it("a wire that cannot be laid and cannot stay where it was without touching a carried pin of another net refuses the drop rather than join or delete (Codex 11, clearInPlace)", () => {
    const fence = [wire(at(9.5, 5), at(7, 5)), wire(at(10, 4.5), at(10, 2.5)), wire(at(10, 5.5), at(10, 8))]
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 0), resistor("R5", 6, -7, 90)], [wire(at(4, 1), at(10, 1)), ...fence])
    const landed = new PartDrag(doc, wiringOf(new WireGraph(), doc), { objects: new Set(["R2", "R5"]) }).landed(0, 4 * GRID, counter("k"))
    expect.soft(landed.refused, "refused").toBeDefined()
    expect.soft(landed.doc, "nothing changed").toBe(doc)
  })
})

describe("found by phase 4's review (Claude)", () => {
  it("the bridge's R3 mirrored keeps both its wires or is refused: a mirror never deletes a wire (design.md §13.17; Claude 4)", async () => {
    const { examples } = await import("@/schematic/examples")
    const { unexplainedJoins } = await import("../lib/explained-joins")
    const bridge = examples.find((e) => e.id === "bridge")!.build(GRID)
    const r3 = bridge.objects.find((o) => o.props?.ref === "R3")!
    const done = flippedWithWires(bridge, wiringOf(new WireGraph(), bridge), new Set([r3.id]), "horizontal", counter("m"))
    const pinsOfR3 = wirePins(done.doc.objects).filter((p) => p.key.startsWith(`${r3.id}:`))
    const wired = pinsOfR3.filter((p) => done.doc.wires.some((s) => (s.a.x === p.at.x && s.a.y === p.at.y) || (s.b.x === p.at.x && s.b.y === p.at.y)))
    const open = done.unlaid.filter((u) => u.kept).length
    expect.soft(done.refused !== undefined || wired.length + open === pinsOfR3.length, "refused, or every pin wired or its wire kept where it was").toBe(true)
    expect.soft(unexplainedJoins(bridge, done.doc, new Set([r3.id])), "and nothing joined").toEqual([])
  })
})

describe("a turned chip's wires go round it (found on the morning sheet after the review fixes)", () => {
  it("no wire of a 555 turned by R runs through its drawn body when a way round exists, and its circuit is kept (ГОСТ 2.701-84; design.md §5.1)", async () => {
    const { unexplainedJoins } = await import("../lib/explained-joins")
    const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
    let n = 0
    const wire = (a: Point, b: Point): WireSegment => ({ id: `q${++n}`, a, b })
    const chain = (...pts: Point[]) => pts.slice(1).map((p, i) => wire(pts[i], p))
    const part = (id: string, def: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def, x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
    const doc = inNormalForm({
      objects: [part("U1", "ne555", 0, 0), part("V1", "supply", 6, -6), part("G1", "ground", 3, 11), part("R1", "resistor", 12, 4), part("R2", "resistor", -4, -1, 90)],
      wires: [wire(at(7, -4), at(7, 1)), ...chain(at(4, 1), at(4, -1), at(7, -1)), wire(at(4, 9), at(4, 11)), wire(at(9, 5), at(12, 5)), ...chain(at(1, 5), at(-1, 5), at(-1, 7), at(1, 7)), wire(at(1, 3), at(-3, 3))],
      parts: {},
    })
    const done = new TurnRun(doc, wiringOf(new WireGraph(), doc), new Set(["U1"])).turned(1, counter("g"))
    expect.soft(done.refused, "turned").toBeUndefined()
    const body = footprint(done.doc.objects.find((o) => o.id === "U1")!, GRID)!.box
    const through = done.doc.wires.filter((s) => Math.max(s.a.x, s.b.x) > body.x && Math.min(s.a.x, s.b.x) < body.x + body.w && Math.max(s.a.y, s.b.y) > body.y && Math.min(s.a.y, s.b.y) < body.y + body.h)
    expect.soft(through.map((s) => [s.a.x / GRID, s.a.y / GRID, s.b.x / GRID, s.b.y / GRID]), "no piece through the 555's drawn body").toEqual([])
    expect.soft(unexplainedJoins(doc, done.doc, new Set(["U1"])), "nothing joined").toEqual([])
  })
})

describe("found by the verification of phase 4's fixes (Codex)", () => {
  it("a far drop whose blocked wires cannot all be laid is still taken where it was dropped, the wires that could not follow kept where they were and named (design.md §13.19 Q9)", async () => {
    const { examples } = await import("@/schematic/examples")
    const { unexplainedJoins } = await import("../lib/explained-joins")
    const doc = examples.find((e) => e.id === "battery-life")!.build(GRID)
    const bt1 = doc.objects.find((o) => o.props?.ref === "BT1")!
    const landed = new PartDrag(doc, wiringOf(new WireGraph(), doc), { objects: new Set([bt1.id]) }).landed(-2 * GRID, -12 * GRID, counter("v"))
    expect.soft(landed.refused, "not refused").toBeUndefined()
    expect.soft(landed.at, "where it was dropped").toEqual({ x: -2 * GRID, y: -12 * GRID })
    expect.soft(landed.unlaid.length > 0 && landed.unlaid.every((u) => u.kept), "some wires left where they were, each named").toBe(true)
    expect.soft(unexplainedJoins(doc, landed.doc, new Set([bt1.id])), "nothing joined").toEqual([])
  })

  it("on the zoomed-out canvas the marks of the runs the band redraws leave the static picture: no ghost dot where a dragged branch was", async () => {
    const { wireMarks, marksBesideTheBand } = await import("@/components/field/wire-marks")
    const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
    const marks = wireMarks([], [at(4, 1)], [at(6, -2)], [], () => "black", true)
    const band = new Set([`${at(4, 1).x},${at(4, 1).y}`, `${at(6, -2).x},${at(6, -2).y}`])
    expect.soft(marksBesideTheBand(marks, band).dots, "the old dot gone").toEqual([])
    expect.soft(marksBesideTheBand(marks, new Set()).dots.length, "kept without a band").toBe(1)
  })
})

describe("the user's checks on the running app (2026-11-05 morning)", () => {
  const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
  const part = (id: string, def: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def, x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
  let n = 0
  const wire = (a: Point, b: Point): WireSegment => ({ id: `u${++n}`, a, b })
  const chain = (...pts: Point[]) => pts.slice(1).map((p, i) => wire(pts[i], p))
  const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
  const wiringFor = (doc: Schematic) => wiringOf(new WireGraph(), doc)
  const nets = (doc: Schematic) => pinPartition(wireNets(doc.wires, wirePins(doc.objects)))
  const segmentsOf = (doc: Schematic) => doc.wires.map((s) => [s.a.x / GRID, s.a.y / GRID, s.b.x / GRID, s.b.y / GRID])

  it("a wire dragged sideways does not land the end it keeps on a pin onto another part's pin: nothing joins (design.md §6.7)", () => {
    const doc = docOf([part("R1", "resistor", 0, 0), part("R2", "resistor", 0, 2)], [wire(at(4, 1), at(10, 1))])
    const landed = new SegmentDrag(doc, wiringFor(doc), doc.wires[0].id).landed(0, 2 * GRID)
    expect.soft(nets(landed.doc), "R1 and R2 kept apart").toEqual([])
    expect.soft(normalFormViolations(landed.doc.wires, wirePins(landed.doc.objects)), "normal form").toEqual([])
  })

  it("a wire attached to nothing moves freely, along as well as across itself", () => {
    const doc = docOf([part("R9", "resistor", 20, 20)], [wire(at(6, 2), at(6, 10))])
    const landed = new SegmentDrag(doc, wiringFor(doc), doc.wires[0].id).landed(2 * GRID, -3 * GRID)
    expect.soft(segmentsOf(landed.doc), "the whole wire two right and three up").toEqual([[8, -1, 8, 7]])
  })

  it("a diode turned by 45° carries the wire hanging from its pin by translation: no slant pieces, no dots, the same shape (the user's picture 9)", () => {
    const tail = chain(at(4, 1), at(12, 1), at(12, -3), at(18, -3), at(18, 5), at(26, 5), at(26, 3))
    const doc = docOf([part("D1", "diode", 0, 0)], tail)
    const done = new TurnRun(doc, wiringFor(doc), new Set(["D1"])).turned(-1, counter("h"))
    const view = wireNets(done.doc.wires, wirePins(done.doc.objects))
    expect.soft(done.refused, "turned").toBeUndefined()
    expect.soft(junctionsOf(view), "no dots").toEqual([])
    expect.soft(done.doc.wires.length, "the same seven pieces").toBe(doc.wires.length)
    expect.soft(normalFormViolations(done.doc.wires, wirePins(done.doc.objects)), "normal form, every piece orthogonal").toEqual([])
    expect.soft(nets(done.doc), "the wire still on D1's pin").toEqual([])
    expect.soft(danglingEnds(view).length, "one open end, the tail's").toBe(1)
  })

  it("two resistors joined by an L stopped at 45°: the wire between them is pulled by the rubber band, not turned into a staircase", () => {
    const doc = docOf([part("R1", "resistor", 0, 0), part("R2", "resistor", 9, 4, 90)], chain(at(4, 1), at(10, 1), at(10, 4)))
    const half = new TurnRun(doc, wiringFor(doc), new Set(["R1", "R2"])).turned(1, counter("l"))
    expect.soft(geometryOf(half.doc.wires), "one corner, on whole cells").toEqual(geometryOf(chain(at(7, 2), at(9, 2), at(9, 8))))
  })

  it("two wired resistors stopped at 45° keep their wire orthogonal and joined; two presses give the right-angle turn (design.md §6.6)", () => {
    const doc = docOf([part("R1", "resistor", 0, 0), part("R2", "resistor", 6, 0)], [wire(at(4, 1), at(6, 1))])
    const run = new TurnRun(doc, wiringFor(doc), new Set(["R1", "R2"]))
    const half = run.turned(1, counter("q"))
    expect.soft(half.refused, "the 45° stop is taken").toBeUndefined()
    expect.soft(normalFormViolations(half.doc.wires, wirePins(half.doc.objects)), "orthogonal at the stop").toEqual([])
    expect.soft(nets(half.doc), "still one net at the stop").toEqual([["R1:2", "R2:1"]])
    const whole = run.turned(1, counter("q"))
    expect.soft(geometryOf(whole.doc.wires), "the wire turned with them").toEqual(geometryOf([wire(at(5, 0), at(5, 2))]))
  })

  it("R on selected wires alone turns them a quarter about their middle", () => {
    const doc = docOf([part("R9", "resistor", 20, 20)], [wire(at(2, 4), at(10, 4))])
    const done = new TurnRun(doc, wiringFor(doc), new Set(), undefined, new Set([doc.wires[0].id])).turned(1, counter("w"))
    expect.soft(segmentsOf(done.doc), "upright through the old middle").toEqual([[6, 0, 6, 8]])
  })

  it("R or a mirror on one piece of a wire attached to nothing turns the whole wire, the way a drag moves it whole: an L stays an L", () => {
    const doc = docOf([part("R9", "resistor", 20, 20)], chain(at(2, 4), at(9, 4), at(9, 10)))
    const turnedL = [[8, 4, 8, 11], [8, 11, 2, 11]]
    const both = new TurnRun(doc, wiringFor(doc), new Set(), undefined, new Set(doc.wires.map((w) => w.id))).turned(1, counter("l"))
    expect.soft(segmentsOf(both.doc), "both pieces selected").toEqual(turnedL)
    for (const piece of doc.wires) {
      const one = new TurnRun(doc, wiringFor(doc), new Set(), undefined, new Set([piece.id])).turned(1, counter("m"))
      expect.soft(segmentsOf(one.doc), `only ${piece.id} selected`).toEqual(turnedL)
    }
    const mirrored = flippedWithWires(doc, wiringFor(doc), new Set(), "horizontal", counter("f"), undefined, new Set([doc.wires[1].id]))
    expect.soft(geometryOf(mirrored.doc.wires), "mirrored whole: the L opens the other way").toEqual(geometryOf(chain(at(9, 4), at(2, 4), at(2, 10))))
  })

  it("the 74HC595 turned four times in a row never joins two nets and never refuses (the user's picture 3)", async () => {
    const { examples } = await import("@/schematic/examples")
    const { unexplainedJoins } = await import("../lib/explained-joins")
    const doc = examples.find((e) => e.id === "nucleo-74hc595")!.build(GRID)
    const u2 = doc.objects.find((o) => o.props?.ref === "U2")!
    const run = new TurnRun(doc, wiringFor(doc), new Set([u2.id]))
    for (const turn of [-1, -1, -1, 1] as const) {
      const landed = run.turned(turn, counter("s"))
      expect.soft(landed.refused, `turned ${turn}`).toBeUndefined()
      expect.soft(unexplainedJoins(doc, landed.doc, new Set([u2.id])), `turned ${turn}: nothing joined`).toEqual([])
      expect.soft(normalFormViolations(landed.doc.wires, wirePins(landed.doc.objects)), `turned ${turn}: normal form`).toEqual([])
    }
  })

  it("the fallback for a chip the rubber band cannot turn keeps the far ends where they are and lays the conflicting wires again; a wire that cannot be is cut back, never joined", async () => {
    const { examples } = await import("@/schematic/examples")
    const { unexplainedJoins } = await import("../lib/explained-joins")
    const doc = examples.find((e) => e.id === "nucleo-74hc595")!.build(GRID)
    const u2 = doc.objects.find((o) => o.props?.ref === "U2")!
    const wiring = wiringFor(doc)
    const pins = wirePins(doc.objects).filter((p) => p.key.startsWith(`${u2.id}:`))
    const turned = turnedSelection(doc, new Set([u2.id]), 2, GRID)
    const after = new Map(wirePins(turned.objects).map((p) => [p.key, p] as const))
    const plan = planDrag(wiring.sheet, wiring.view, { pins: pins.map((p) => p.key), heading: (key) => wiring.sheet.pin(key)?.out, keepFarEnds: true })
    const commit = plan.commit({ pin: (key, p) => after.get(key)?.at ?? p, point: (p) => p, heading: (key, h) => after.get(key)?.out ?? h }, counter("x"), { keepUnlaid: true })
    expect.soft(commit, "laid").not.toBeNull()
    if (!commit) return
    const result = inNormalForm({ ...doc, objects: turned.objects, wires: [...commitEdit(doc.wires, wirePins(turned.objects), commit.edit, counter("y")).wires] })
    expect.soft(unexplainedJoins(doc, result, new Set([u2.id])), "nothing joined").toEqual([])
  })
})
