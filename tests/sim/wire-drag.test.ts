import { describe, expect, it } from "vitest"
import { GRID, objectPins } from "@/schematic/geometry"
import { rotateSelection } from "@/schematic/orient"
import type { PlacedObject, Point, Schematic } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import { type DragConflict, type DragFrame, type DragMove, normalOffset, planDrag } from "@/schematic/wires/drag"
import { junctionsOf, pinPartition, type WireNets, WireGraph, wireNets } from "@/schematic/wires/graph"
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

  it("a pin dropped on another net's wire joins the two, named; a pin dropped on a crossing of two is blocked", () => {
    const sheet = sheetOf([part("A", c(0, 4), c(0, 8)), part("B", c(10, 4), c(10, 8)), part("C", c(5, -2), c(5, 2)), part("D", c(5, 8), c(5, 12)), part("R1", c(-6, 0), c(-2, 0))], [w(c(0, 4), c(10, 4)), w(c(5, 2), c(5, 8))])
    const before = wireNets(sheet.wires, sheet.pins)
    const onWire = planOf(sheet, { parts: ["R1"] }).frame(cells(4, 4))
    expect.soft(onWire.blocked, "R1's right pin on the A–B wire").toBe(false)
    expect.soft(onWire.joins, "the join is named").toEqual([[before.netOfPin("A:1")!, before.netOfPin("R1:2") ?? "pin:R1:2"].sort()])
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
