import { describe, expect, it } from "vitest"
import { GRID, type Point } from "@/schematic/geometry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { backAlong, cutBack, drawEndAt, drawnTo, isRefusal, pointerAt, previewOf, startDrawing, withCorner, type DrawEnd, type Drawing } from "@/schematic/wire-draw"
import { inNormalForm, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { wirePins } from "@/schematic/migrate-wires"
import { danglingEnds, junctionsOf, pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { geometryOf, normalFormViolations, sortedPoints } from "../lib/wire-reference"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const resistor = (id: string, x: number, y: number): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id } })
let serial = 0
const seg = (a: Point, b: Point, color?: WireSegment["color"]): WireSegment => ({ id: `s${++serial}`, a, b, ...(color && { color }) })
const path = (...pts: Point[]) => pts.slice(1).map((p, i) => seg(pts[i], p))
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const viewOf = (doc: Schematic) => wireNets(doc.wires, wirePins(doc.objects))
let fresh = 0
const newId = () => `n${++fresh}`
const field = (p: Point): DrawEnd => ({ kind: "field", at: p })

function drawing(doc: Schematic, from: Point): { wiring: Wiring; d: Drawing } {
  const wiring = wiringOf(new WireGraph(), doc)
  const started = startDrawing(wiring, drawEndAt(wiring, from))
  if (isRefusal(started)) throw new Error(`the drawing could not start at (${from.x / GRID}, ${from.y / GRID}): ${started.refused}`)
  return { wiring, d: started }
}

const towards = (d: Drawing, ...points: Point[]) => points.reduce(pointerAt, d)

function committed(doc: Schematic, wiring: Wiring, d: Drawing, target: DrawEnd): Schematic {
  const result = drawnTo(doc, wiring, d, target, newId)
  if (isRefusal(result)) throw new Error(`refused: ${result.refused} at (${result.at.x / GRID}, ${result.at.y / GRID})`)
  return result
}

const hookedOnR1 = () => docOf([resistor("R1", 0, 0)], path(at(4, 1), at(10, 1), at(10, 5)))

describe("shortening a wire from its open end by drawing back along it, as Zip retracts a path (the user, 2026-11-11)", () => {
  it("a move back along the wire cuts it there while the press is held: nothing is drawn beyond the cut", () => {
    const doc = hookedOnR1()
    const { wiring, d } = drawing(doc, at(10, 5))
    const held = pointerAt(d, at(10, 3))
    expect.soft(previewOf(doc, wiring, held).points, "the pending wire is the cut point alone").toEqual([at(10, 3)])
    const cut = cutBack(wiring, held)
    expect.soft(cut && geometryOf(cut.removed), "the leg the end is on is taken off").toEqual(geometryOf([seg(at(10, 1), at(10, 5))]))
    expect.soft(cut?.kept && geometryOf([cut.kept]), "and what is left of it stays").toEqual(geometryOf([seg(at(10, 1), at(10, 3))]))
  })

  it("released there, the wire ends at the cut, its end open, in normal form", () => {
    const doc = hookedOnR1()
    const { wiring, d } = drawing(doc, at(10, 5))
    const after = committed(doc, wiring, towards(d, at(10, 4), at(10, 3)), drawEndAt(wiring, at(10, 3)))
    expect.soft(geometryOf(after.wires), "two cells shorter").toEqual(geometryOf(path(at(4, 1), at(10, 1), at(10, 3))))
    expect.soft(danglingEnds(viewOf(after)), "the end hangs at the cut").toEqual([at(10, 3)])
    expect.soft(normalFormViolations(after.wires, wirePins(after.objects)), "normal form").toEqual([])
  })

  it("Enter or a double click at the cut commits the same as a release there", () => {
    const doc = hookedOnR1()
    const { wiring, d } = drawing(doc, at(10, 5))
    const after = committed(doc, wiring, pointerAt(d, at(10, 3)), field(at(10, 3)))
    expect.soft(geometryOf(after.wires), "two cells shorter").toEqual(geometryOf(path(at(4, 1), at(10, 1), at(10, 3))))
  })

  it("back past a bend, cell by cell, the bend goes with it", () => {
    const doc = hookedOnR1()
    const { wiring, d } = drawing(doc, at(10, 5))
    const back = towards(d, at(10, 4), at(10, 3), at(10, 2), at(10, 1), at(9, 1), at(8, 1))
    expect.soft(previewOf(doc, wiring, back).points, "nothing drawn beyond the cut").toEqual([at(8, 1)])
    const after = committed(doc, wiring, back, drawEndAt(wiring, at(8, 1)))
    expect.soft(geometryOf(after.wires), "one straight wire out of R1").toEqual(geometryOf([seg(at(4, 1), at(8, 1))]))
    expect.soft(danglingEnds(viewOf(after)), "its end where the pointer was").toEqual([at(8, 1)])
  })

  it("while held, the cut shown is exactly what the release commits", () => {
    const doc = hookedOnR1()
    const { wiring, d } = drawing(doc, at(10, 5))
    const back = towards(d, at(10, 3), at(10, 1), at(8, 1))
    const cut = cutBack(wiring, back)!
    const removed = new Set(cut.removed.map((s) => s.id))
    const shown = [...doc.wires.filter((s) => !removed.has(s.id)), ...(cut.kept ? [cut.kept] : [])]
    expect.soft(geometryOf(shown), "the field during the gesture").toEqual(geometryOf(committed(doc, wiring, back, drawEndAt(wiring, at(8, 1))).wires))
  })

  it("back and then away: the wire carries on from the cut in the new direction", () => {
    const doc = hookedOnR1()
    const { wiring, d } = drawing(doc, at(10, 5))
    const turned = towards(d, at(10, 4), at(10, 3), at(11, 3), at(12, 3))
    expect.soft(previewOf(doc, wiring, turned).points, "the pending wire leaves from the cut").toEqual([at(10, 3), at(12, 3)])
    const after = committed(doc, wiring, turned, field(at(12, 3)))
    expect.soft(geometryOf(after.wires), "the stub below the cut is gone, the new leg leaves from it").toEqual(geometryOf(path(at(4, 1), at(10, 1), at(10, 3), at(12, 3))))
    expect.soft(danglingEnds(viewOf(after)), "one open end, where the pointer finished").toEqual([at(12, 3)])
  })

  it("forward again over the cut gives the wire back: at the open end nothing is cut, and past it the wire extends", () => {
    const doc = hookedOnR1()
    const { wiring, d } = drawing(doc, at(10, 5))
    const restored = towards(d, at(10, 3), at(10, 4), at(10, 5))
    expect.soft(cutBack(wiring, restored), "nothing cut").toBeNull()
    expect.soft(previewOf(doc, wiring, restored).points, "the pending wire is the open end alone").toEqual([at(10, 5)])
    const after = committed(doc, wiring, towards(restored, at(10, 6), at(10, 7)), field(at(10, 7)))
    expect.soft(geometryOf(after.wires), "two cells longer, straight on").toEqual(geometryOf(path(at(4, 1), at(10, 1), at(10, 7))))
  })

  it("all the way back to R1's pin, the wire is gone and the pin is free", () => {
    const doc = hookedOnR1()
    const { wiring, d } = drawing(doc, at(10, 5))
    const gone = towards(d, at(10, 3), at(10, 1), at(7, 1), at(4, 1))
    const cut = cutBack(wiring, gone)
    expect.soft(cut && geometryOf(cut.removed), "every leg taken off").toEqual(geometryOf(doc.wires))
    expect.soft(cut?.kept, "nothing left").toBeNull()
    const after = committed(doc, wiring, gone, drawEndAt(wiring, at(4, 1)))
    expect.soft(after.wires, "no wire").toEqual([])
  })

  it("back to the branch it hangs from: the branch is gone, the dot with it, and the spine is one wire again", () => {
    const doc = docOf([resistor("R2", 0, 0), resistor("R3", 12, 0)], [seg(at(4, 1), at(12, 1)), seg(at(8, 1), at(8, 4))])
    expect.soft(sortedPoints(junctionsOf(viewOf(doc))), "a dot at the branch before").toEqual([at(8, 1)])
    const { wiring, d } = drawing(doc, at(8, 4))
    const after = committed(doc, wiring, towards(d, at(8, 3), at(8, 2), at(8, 1)), drawEndAt(wiring, at(8, 1)))
    expect.soft(geometryOf(after.wires), "the spine alone, whole").toEqual(geometryOf([seg(at(4, 1), at(12, 1))]))
    expect.soft(junctionsOf(viewOf(after)), "no dot").toEqual([])
    expect.soft(pinPartition(viewOf(after)), "R2 and R3 still one net").toEqual([["R2:2", "R3:1"]])
  })

  it("the cut stops at the end of the wire: past the branch point the pointer is off it, and the spine is never eaten", () => {
    const doc = docOf([resistor("R2", 0, 0), resistor("R3", 12, 0)], [seg(at(4, 1), at(12, 1)), seg(at(8, 1), at(8, 4))])
    const { wiring, d } = drawing(doc, at(8, 4))
    const past = towards(d, at(8, 3), at(8, 2), at(8, 1), at(10, 1))
    const cut = cutBack(wiring, past)
    expect.soft(cut && geometryOf(cut.removed), "only the branch is taken off").toEqual(geometryOf([seg(at(8, 1), at(8, 4))]))
    const after = committed(doc, wiring, past, field(at(10, 1)))
    expect.soft(geometryOf(after.wires), "the spine whole").toEqual(geometryOf([seg(at(4, 1), at(12, 1))]))
    expect.soft(pinPartition(viewOf(after)), "R2 and R3 still one net").toEqual([["R2:2", "R3:1"]])
  })

  it("the end never stops on another net's wire crossing this one: refused there, fine a cell either side (design.md §6.7)", () => {
    const crossing = seg(at(7, 3), at(13, 3))
    const doc = docOf([resistor("R1", 0, 0)], [...path(at(4, 1), at(10, 1), at(10, 5)), crossing])
    const { wiring, d } = drawing(doc, at(10, 5))
    const onIt = pointerAt(d, at(10, 3))
    expect.soft(previewOf(doc, wiring, onIt).refused?.refused, "the preview is refused on the crossing").toBe("crossing")
    expect.soft(isRefusal(drawnTo(doc, wiring, onIt, drawEndAt(wiring, at(10, 3)), newId)), "and the release is refused").toBe(true)
    expect.soft(isRefusal(drawnTo(doc, wiring, onIt, field(at(10, 3)), newId)), "and Enter there too").toBe(true)
    const below = pointerAt(d, at(10, 4))
    expect.soft(previewOf(doc, wiring, below).refused, "a cell before it is fine").toBeNull()
    const beyond = committed(doc, wiring, towards(d, at(10, 4), at(10, 3), at(10, 2)), drawEndAt(wiring, at(10, 2)))
    expect.soft(geometryOf(beyond.wires), "and a cell past it the wire is cut clear of the crossing, which stays whole").toEqual(geometryOf([...path(at(4, 1), at(10, 1), at(10, 2)), crossing]))
    expect.soft(sortedPoints(danglingEnds(viewOf(beyond))), "nothing joined: the crossing's two open ends and the cut one").toEqual(sortedPoints([at(7, 3), at(13, 3), at(10, 2)]))
    expect.soft(junctionsOf(viewOf(beyond)), "no dot").toEqual([])
  })

  it("once a corner is fixed, the wire behind it is not cut back any more", () => {
    const doc = hookedOnR1()
    const { wiring, d } = drawing(doc, at(10, 5))
    const cornered = withCorner(doc, wiring, pointerAt(d, at(13, 5)), at(13, 5))
    if (isRefusal(cornered)) throw new Error(cornered.refused)
    const back = pointerAt(cornered, at(10, 3))
    expect.soft(cutBack(wiring, back), "nothing cut").toBeNull()
    expect.soft(previewOf(doc, wiring, back).points[0], "the pending wire still starts at the open end").toEqual(at(10, 5))
  })

  it("a wire started on a pin or on a wire's interior is never cut back: only an open end retracts", () => {
    const doc = hookedOnR1()
    const fromPin = drawing(doc, at(4, 1))
    expect.soft(cutBack(fromPin.wiring, pointerAt(fromPin.d, at(7, 1))), "from R1's pin").toBeNull()
    const fromWire = drawing(doc, at(7, 1))
    expect.soft(cutBack(fromWire.wiring, pointerAt(fromWire.d, at(9, 1))), "from the wire's interior").toBeNull()
  })

  it("a coloured wire keeps its colour on the piece that is left", () => {
    const doc = docOf([resistor("R1", 0, 0)], [seg(at(4, 1), at(10, 1), "red"), seg(at(10, 1), at(10, 5), "red")])
    const { wiring, d } = drawing(doc, at(10, 5))
    const after = committed(doc, wiring, pointerAt(d, at(10, 3)), field(at(10, 3)))
    expect.soft(geometryOf(after.wires), "red to the cut").toEqual(geometryOf([seg(at(4, 1), at(10, 1), "red"), seg(at(10, 1), at(10, 3), "red")]))
  })
})

describe("the pointer counts as on the wire it is drawing back along within the wire's reach (the user, 2026-11-11)", () => {
  it("near the wire it lands on the nearest lattice point of the wire; farther off it is not on the wire", () => {
    const doc = hookedOnR1()
    const { d } = drawing(doc, at(10, 5))
    expect.soft(backAlong(d, { x: c(10) + 5, y: c(3) + 7 }, 10), "beside the upright leg").toEqual(at(10, 3))
    expect.soft(backAlong(d, { x: c(7) + 8, y: c(1) - 4 }, 10), "above the level leg").toEqual(at(7, 1))
    expect.soft(backAlong(d, { x: c(10) + 11, y: c(3) }, 10), "out of reach").toBeNull()
    expect.soft(backAlong(d, { x: c(10), y: c(5) + 9 }, 10), "just past the open end, within reach of it").toEqual(at(10, 5))
    expect.soft(backAlong(d, { x: c(10), y: c(5) + 11 }, 10), "farther past the open end: drawing on, not back").toBeNull()
  })

  it("no reach while a corner is fixed, and none for a wire not started from an open end", () => {
    const doc = hookedOnR1()
    const { wiring, d } = drawing(doc, at(10, 5))
    const cornered = withCorner(doc, wiring, pointerAt(d, at(13, 5)), at(13, 5))
    if (isRefusal(cornered)) throw new Error(cornered.refused)
    expect.soft(backAlong(cornered, at(10, 3), 10), "a corner fixed").toBeNull()
    expect.soft(backAlong(drawing(doc, at(4, 1)).d, at(7, 1), 10), "started on R1's pin").toBeNull()
  })
})
