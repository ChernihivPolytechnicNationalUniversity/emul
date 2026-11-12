import { describe, expect, it } from "vitest"
import { checked } from "@/schematic/checker"
import { GRID, objectRect, type Point } from "@/schematic/geometry"
import { junctionAt } from "@/schematic/junction-tool"
import { netChanges, NO_CHANGE } from "../lib/net-changes"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { pasteLanding, pastedInto } from "@/schematic/use-schematic"
import { freeSpot, wireCheck } from "@/schematic/placement"
import { drawEndAt, drawnTo, flipPosture, isRefusal, laysClear, pointerAt, previewOf, startDrawing, withCorner, withoutCorner, type DrawEnd, type Drawing } from "@/schematic/wire-draw"
import { clipOf, inNormalForm, placedObject, removed, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { PartDrag } from "@/schematic/rubber-band"
import { stamped, upgraded } from "@/schematic/migrate"
import { chainOf, inRect, segmentNearest } from "@/schematic/wire-select"
import { wirePins } from "@/schematic/migrate-wires"
import { danglingEnds, junctionsOf, pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { geometryOf, normalFormViolations, sortedPoints } from "../lib/wire-reference"
import { sourceCallback } from "../lib/source-callback"
import { getDef } from "@/schematic/registry"
import { snap } from "@/schematic/geometry"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
const ground = (id: string, x: number, y: number): PlacedObject => ({ id, def: "ground", x: c(x), y: c(y), props: { ref: id } })
const supply = (id: string, x: number, y: number, label: string): PlacedObject => ({ id, def: "supply", x: c(x), y: c(y), props: { ref: id, value: label } })
let serial = 0
const seg = (a: Point, b: Point, color?: WireSegment["color"]): WireSegment => ({ id: `s${++serial}`, a, b, ...(color && { color }) })
const path = (...pts: Point[]) => pts.slice(1).map((p, i) => seg(pts[i], p))
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic): Wiring => wiringOf(new WireGraph(), doc)
const viewOf = (doc: Schematic) => wireNets(doc.wires, wirePins(doc.objects))
const partition = (doc: Schematic) => pinPartition(viewOf(doc))
let fresh = 0
const newId = () => `d${++fresh}`

function drawing(doc: Schematic, from: Point): { wiring: Wiring; d: Drawing } {
  const wiring = wiringFor(doc)
  const started = startDrawing(wiring, drawEndAt(wiring, from))
  if (isRefusal(started)) throw new Error(`the drawing could not start at (${from.x / GRID}, ${from.y / GRID}): ${started.refused}`)
  return { wiring, d: started }
}

const towards = (d: Drawing, ...points: Point[]) => points.reduce(pointerAt, d)

function drawn(doc: Schematic, from: Point, target: Point, moves: Point[] = [target]): Schematic {
  const { wiring, d } = drawing(doc, from)
  const result = drawnTo(doc, wiring, towards(d, ...moves), drawEndAt(wiring, target), newId)
  if (isRefusal(result)) throw new Error(`refused: ${result.refused} at (${result.at.x / GRID}, ${result.at.y / GRID})`)
  return result
}

const field = (p: Point): DrawEnd => ({ kind: "field", at: p })

describe("drawing a wire: where it goes while the pointer moves (design.md §6.1)", () => {
  it("from a pin, the first leg runs along the pin's axis when the pointer lies ahead of it (Horizon, tool_draw_line_net.cpp:183–194: the posture from the starting pin's orientation)", () => {
    const doc = docOf([resistor("R1", 0, 0)])
    const { wiring, d } = drawing(doc, at(4, 1))
    expect.soft(previewOf(doc, wiring, pointerAt(d, at(8, 4))).points, "out of R1's right pin to the right, then down").toEqual([at(4, 1), at(8, 1), at(8, 4)])
    expect.soft(previewOf(doc, wiring, pointerAt(d, at(9, 1))).points, "level ahead: one straight leg").toEqual([at(4, 1), at(9, 1)])
  })

  it("from a pin, a pointer beside or behind it turns the wire at the pin itself, never out past the pin and back (design.md §6.1, §13.4: no detour the user did not draw)", () => {
    const doc = docOf([resistor("R1", 0, 0)])
    const { wiring, d } = drawing(doc, at(4, 1))
    expect.soft(previewOf(doc, wiring, pointerAt(d, at(4, 5))).points, "straight below the pin: straight down").toEqual([at(4, 1), at(4, 5)])
    expect.soft(previewOf(doc, wiring, pointerAt(d, at(2, 4))).points, "behind and below: down from the pin, then back").toEqual([at(4, 1), at(4, 4), at(2, 4)])
  })

  it("anywhere else the corner keeps the axis the pointer first moved along, and `/` flips it (KiCad, sch_line_wire_bus_tool.cpp computeBreakPoint and the posture action)", () => {
    const doc = docOf([resistor("R1", 0, 0)])
    const { wiring, d } = drawing(doc, at(10, 10))
    const down = towards(d, at(10, 12), at(14, 15))
    expect.soft(previewOf(doc, wiring, down).points, "moved down first: down, then across").toEqual([at(10, 10), at(10, 15), at(14, 15)])
    expect.soft(previewOf(doc, wiring, flipPosture(down)).points, "`/`: across, then down").toEqual([at(10, 10), at(14, 10), at(14, 15)])
    const across = towards(d, at(13, 10), at(14, 15))
    expect.soft(previewOf(doc, wiring, across).points, "moved across first: across, then down").toEqual([at(10, 10), at(14, 10), at(14, 15)])
  })

  it("a click on empty field fixes the corner and the next leg starts across the last one; Backspace takes the last click back (Altium Place Wire: Backspace removes the last vertex)", () => {
    const doc = docOf([resistor("R1", 0, 0)])
    const { wiring, d } = drawing(doc, at(10, 10))
    const first = pointerAt(d, at(14, 12))
    expect.soft(previewOf(doc, wiring, first).points, "the first L").toEqual([at(10, 10), at(14, 10), at(14, 12)])
    const clicked = withCorner(doc, wiring, first, at(14, 12))
    if (isRefusal(clicked)) throw new Error("a corner on empty field is never refused")
    expect.soft(previewOf(doc, wiring, pointerAt(clicked, at(16, 16))).points, "the next L leaves the corner across the last leg").toEqual([at(10, 10), at(14, 10), at(14, 12), at(16, 12), at(16, 16)])
    const back = withoutCorner(pointerAt(clicked, at(14, 12)))
    expect.soft(previewOf(doc, wiring, back).points, "Backspace: as before the click").toEqual(previewOf(doc, wiring, first).points)
  })

  it("over a target pin, when the plain L would cross a body, the preview takes a path round it and says so (design.md §6.1 completion)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 4), resistor("R9", 6, -2, 90)])
    const { wiring, d } = drawing(doc, at(4, 1))
    const target = drawEndAt(wiring, at(10, 5))
    const preview = previewOf(doc, wiring, pointerAt(d, at(10, 5)), target)
    const body = objectRect(doc.objects[2], GRID)
    const through = preview.points.slice(1).some((p, i) => {
      const q = preview.points[i]
      return Math.max(p.x, q.x) > body.x && Math.min(p.x, q.x) < body.x + body.w && Math.max(p.y, q.y) > body.y && Math.min(p.y, q.y) < body.y + body.h
    })
    expect.soft(preview.routed, "the router's path, not the plain L").toBe(true)
    expect.soft(through, "it does not cross R9").toBe(false)
    expect.soft(preview.points.at(-1), "and still ends on R2's pin").toEqual(at(10, 5))
  })
})

describe("drawing a wire: where it can start and how it ends (design.md §6.1, §6.4)", () => {
  it("finished on a pin it auto-terminates: the wire is committed and the two pins are one net (Altium: a click on a hotspot ends the wire; KiCad IsTerminalPoint)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 4)])
    const after = drawn(doc, at(4, 1), at(10, 5))
    expect.soft(geometryOf(after.wires), "out of R1 along its axis, then down onto R2's pin").toEqual(geometryOf(path(at(4, 1), at(10, 1), at(10, 5))))
    expect.soft(partition(after), "one net").toEqual([["R1:2", "R2:1"]])
    expect.soft(danglingEnds(viewOf(after)), "no open end").toEqual([])
    expect.soft(normalFormViolations(after.wires, wirePins(after.objects)), "normal form").toEqual([])
  })

  it("finished on a wire's interior it splits the wire there and the T gets its dot (IEC 61082-1 T-connection; KiCad AddJunction on a 3-exit point; junctions.md 2)", () => {
    const doc = docOf([resistor("R2", 0, 0), resistor("R3", 12, 0), resistor("R1", 7, 4, 90)], [seg(at(4, 1), at(12, 1))])
    const after = drawn(doc, at(8, 4), at(8, 1))
    expect.soft(sortedPoints(junctionsOf(viewOf(after))), "the dot at the T").toEqual([at(8, 1)])
    expect.soft(partition(after), "three pins on one net").toEqual([["R1:1", "R2:2", "R3:1"]])
  })

  it("finished on a dangling end of its own net it continues that wire: collinear, one straight wire, no dot (junctions.md 29)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 0)], [seg(at(4, 1), at(6, 1))])
    const after = drawn(doc, at(10, 1), at(6, 1))
    expect.soft(geometryOf(after.wires), "one wire from R1 to R2").toEqual(geometryOf([seg(at(4, 1), at(10, 1))]))
    expect.soft(junctionsOf(viewOf(after)), "no dot").toEqual([])
  })

  it("Enter or a double-click on empty field finishes it there, the end left dangling (design.md §6.1; KiCad's finish action)", () => {
    const doc = docOf([resistor("R1", 0, 0)])
    const { wiring, d } = drawing(doc, at(4, 1))
    const after = drawnTo(doc, wiring, pointerAt(d, at(8, 3)), field(at(8, 3)), newId)
    if (isRefusal(after)) throw new Error(after.refused)
    expect.soft(geometryOf(after.wires), "out and down").toEqual(geometryOf(path(at(4, 1), at(8, 1), at(8, 3))))
    expect.soft(danglingEnds(viewOf(after)), "the end hangs where it was finished").toEqual([at(8, 3)])
  })

  it("started on empty field with the wire tool (W) it hangs at its start (design.md §6.1; KiCad W)", () => {
    const doc = docOf([resistor("R1", 0, 0)])
    const after = drawn(doc, at(8, 3), at(4, 1))
    expect.soft(geometryOf(after.wires), "across first, the way the pointer moved, then up onto the pin").toEqual(geometryOf(path(at(8, 3), at(4, 3), at(4, 1))))
    expect.soft(danglingEnds(viewOf(after)), "the start hangs").toEqual([at(8, 3)])
  })

  it("started on a dangling end it continues the wire: straight on, one wire (KiCad auto_start_wires on a dangling end)", () => {
    const doc = docOf([resistor("R1", 0, 0)], [seg(at(4, 1), at(6, 1))])
    const wiring = wiringFor(doc)
    expect.soft(drawEndAt(wiring, at(6, 1)).kind, "the end is an end").toBe("end")
    const { d } = drawing(doc, at(6, 1))
    const after = drawnTo(doc, wiring, pointerAt(d, at(9, 1)), field(at(9, 1)), newId)
    if (isRefusal(after)) throw new Error(after.refused)
    expect.soft(geometryOf(after.wires), "one wire").toEqual(geometryOf([seg(at(4, 1), at(9, 1))]))
  })

  it("started on a wire it is a branch: the wire splits where it starts and the T gets its dot (design.md §6.4; KiCad starts a wire on a wire and splits on commit)", () => {
    const doc = docOf([resistor("R2", 0, 0), resistor("R3", 12, 0), resistor("R1", 7, 4, 90)], [seg(at(4, 1), at(12, 1))])
    const wiring = wiringFor(doc)
    expect.soft(drawEndAt(wiring, at(8, 1)).kind, "a point on a wire").toBe("wire")
    const after = drawn(doc, at(8, 1), at(8, 4))
    expect.soft(sortedPoints(junctionsOf(viewOf(after))), "the dot where it started").toEqual([at(8, 1)])
    expect.soft(partition(after), "three pins on one net").toEqual([["R1:1", "R2:2", "R3:1"]])
  })

  it("started on a wire and drawn along it to R1's pin and on to R3, it is one wire with the dot on R1's pin, its start point gone (junctions.md 22)", () => {
    const doc = docOf([resistor("R2", 0, 0), resistor("R1", 7, 1, 90), resistor("R3", 12, 0)], [seg(at(4, 1), at(8, 1))])
    const after = drawn(doc, at(6, 1), at(12, 1))
    expect.soft(geometryOf(after.wires), "the spine and the new wire, split only at R1's pin").toEqual(geometryOf([seg(at(4, 1), at(8, 1)), seg(at(8, 1), at(12, 1))]))
    expect.soft(junctionsOf(viewOf(after)), "the dot on R1's pin").toEqual([at(8, 1)])
    expect.soft(partition(after), "one net").toEqual([["R1:1", "R2:2", "R3:1"]])
  })

  it("the same, turned off halfway between R2 and R1, splits the spine where it leaves (junctions.md 23)", () => {
    const doc = docOf([resistor("R2", 0, 0), resistor("R1", 7, 1, 90)], [seg(at(4, 1), at(8, 1))])
    const { wiring, d } = drawing(doc, at(5, 1))
    const after = drawnTo(doc, wiring, towards(d, at(7, 1), at(6, 4)), field(at(6, 4)), newId)
    if (isRefusal(after)) throw new Error(after.refused)
    expect.soft(geometryOf(after.wires), "the spine split at the leaving point").toEqual(geometryOf([seg(at(4, 1), at(6, 1)), seg(at(6, 1), at(8, 1)), seg(at(6, 1), at(6, 4))]))
    expect.soft(junctionsOf(viewOf(after)), "the dot at the leaving point").toEqual([at(6, 1)])
  })

  it("a wire crossing another net's wire is a crossing, never a connection (ГОСТ 2.721-74 item 5; IEC 61082-1 Fig. 30)", () => {
    const doc = docOf([resistor("A", -4, 2), resistor("B", 10, 2), resistor("R1", 3, -4, 90)], [seg(at(0, 3), at(10, 3))])
    const after = drawn(doc, at(4, 0), at(4, 6), [at(4, 6)])
    expect.soft(junctionsOf(viewOf(after)), "no dot at the crossing").toEqual([])
    expect.soft(partition(after), "two nets").toEqual([["A:2", "B:1"]])
  })
})

describe("drawing a wire: connections are made by ends (design.md §6.7; junctions.md principle 3)", () => {
  function foreignStub() {
    return docOf([resistor("A", 0, 0), resistor("R4", 6, 4, 90)], [seg(at(4, 1), at(10, 1))])
  }

  it("a wire that would lie along another net's wire is refused while drawing: the preview says why and the click does nothing (junctions.md 9; KiCad joins silent overlaps, Altium's documented trap)", () => {
    const doc = foreignStub()
    const { wiring, d } = drawing(doc, at(7, 4))
    const moved = pointerAt(d, at(12, 1))
    const preview = previewOf(doc, wiring, moved)
    expect.soft(preview.points, "up out of R4's pin, then along the stub").toEqual([at(7, 4), at(7, 1), at(12, 1)])
    expect.soft(preview.refused?.refused, "along a wire of another net").toBe("along")
    expect.soft(isRefusal(withCorner(doc, wiring, moved, at(12, 1))), "the corner click is refused").toBe(true)
    expect.soft(isRefusal(drawnTo(doc, wiring, moved, field(at(12, 1)), newId)), "finishing there is refused").toBe(true)
  })

  it("a wire that would pass over another net's pin without ending there is refused; ended on that pin it joins (junctions.md 10, 12; ГОСТ 2.721-74 item 6 note 3; Altium: a wire across a pin connects it)", () => {
    const doc = docOf(
      [resistor("R2", 0, 0), ground("G1", 3, 2), resistor("R1", 7, 1, 90), supply("V1", 7, -3, "VCC"), resistor("R3", 12, 0)],
      [seg(at(4, 1), at(4, 2)), seg(at(8, -1), at(8, 1))],
    )
    const { wiring, d } = drawing(doc, at(4, 1))
    const across = previewOf(doc, wiring, pointerAt(d, at(12, 1)), drawEndAt(wiring, at(12, 1)))
    expect.soft(across.refused?.refused, "over R1's pin").toBe("over")
    expect.soft(across.refused?.at, "named where").toEqual(at(8, 1))
    const onPin = previewOf(doc, wiring, pointerAt(d, at(8, 1)), drawEndAt(wiring, at(8, 1)))
    expect.soft(onPin.refused, "ending on R1's pin is allowed").toBeNull()
    const after = drawn(doc, at(4, 1), at(8, 1))
    const change = netChanges(wiringFor(doc).circuit.nets, wiringFor(after).circuit.nets)
    expect.soft(change.joined.length, "one join").toBe(1)
  })

  it("a wire of another net drawn along the spine is refused (junctions.md 24)", () => {
    const doc = docOf([resistor("R2", 0, 0), resistor("R1", 7, 1, 90), resistor("R3", 12, 0), resistor("R5", 5, 4, 90)], [seg(at(4, 1), at(8, 1))])
    const { wiring, d } = drawing(doc, at(6, 4))
    const preview = previewOf(doc, wiring, towards(d, at(6, 3), at(12, 1)), drawEndAt(wiring, at(12, 1)))
    expect.soft(preview.refused?.refused, "up onto the spine and along it").toBe("along")
  })

  it("a corner of the drawn wire never lands on another net's pin or wire end (ГОСТ 2.721-74 item 5 note: no bend on another line; design.md §6.7)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R7", 8, 0)])
    const { wiring, d } = drawing(doc, at(4, 1))
    const preview = previewOf(doc, wiring, pointerAt(d, at(8, 4)))
    expect.soft(preview.points, "out, then down: the corner on R7's pin").toEqual([at(4, 1), at(8, 1), at(8, 4)])
    expect.soft(preview.refused?.refused, "a corner on a foreign pin").toBe("corner")
  })

  it("a crossing cannot be reached: a wire may neither start nor end on one (design.md §6.4; junctions.md 28)", () => {
    const doc = docOf([resistor("A", -4, 4), resistor("B", 10, 4), resistor("C", 4, -4, 90), resistor("D", 4, 10, 90), resistor("R1", 12, 10)], [seg(at(0, 5), at(10, 5)), seg(at(5, 0), at(5, 10))])
    const wiring = wiringFor(doc)
    expect.soft(drawEndAt(wiring, at(5, 5)).kind, "the point is a crossing").toBe("crossing")
    expect.soft(isRefusal(startDrawing(wiring, drawEndAt(wiring, at(5, 5)))), "no wire starts there").toBe(true)
    const { d } = drawing(doc, at(12, 11))
    const preview = previewOf(doc, wiring, pointerAt(d, at(5, 5)), drawEndAt(wiring, at(5, 5)))
    expect.soft(preview.refused, "no wire ends there").not.toBeNull()
  })

  it("two dangling ends of different nets drawn together join (junctions.md 16)", () => {
    const doc = docOf(
      [resistor("A", 0, 0), ground("G1", 3, 2), resistor("B", 14, 0), supply("V1", 13, -3, "VCC")],
      [seg(at(4, 1), at(4, 2)), seg(at(4, 1), at(6, 1)), seg(at(14, -1), at(14, 1)), seg(at(14, 1), at(10, 1))],
    )
    const { wiring, d } = drawing(doc, at(6, 1))
    const preview = previewOf(doc, wiring, pointerAt(d, at(10, 1)), drawEndAt(wiring, at(10, 1)))
    expect.soft(preview.refused, "allowed").toBeNull()
    const after = drawn(doc, at(6, 1), at(10, 1))
    expect.soft(netChanges(wiringFor(doc).circuit.nets, wiringFor(after).circuit.nets).joined.length, "one join").toBe(1)
  })
})

describe("the junction tool, the only way to join a crossing (design.md §6.4; OrCAD's junction on crossing wires; EasyEDA's junction flag; IEC 61082 / IEEE 315 discourage four-way joins)", () => {
  function crossing() {
    return docOf(
      [resistor("A", -4, 4), resistor("B", 10, 4), resistor("C", 4, -4, 90), resistor("D", 4, 10, 90)],
      [seg(at(0, 5), at(10, 5)), seg(at(5, 0), at(5, 10))],
    )
  }

  it("on a crossing it splits both wires there: four ends, a dot, the two nets one (junctions.md 32)", () => {
    const doc = crossing()
    const wiring = wiringFor(doc)
    const after = junctionAt(doc, wiring, at(5, 5), newId)
    if ("refused" in after) throw new Error(after.refused)
    expect.soft(after.wires.length, "four ends").toBe(4)
    expect.soft(junctionsOf(viewOf(after)), "a dot").toEqual([at(5, 5)])
    expect.soft(partition(after), "one net").toEqual([["A:2", "B:1", "C:2", "D:1"]])
    expect.soft(normalFormViolations(after.wires, wirePins(after.objects)), "normal form").toEqual([])
  })

  it("anywhere but a crossing it is refused and the document is left as it was (EasyEDA: a junction flag only where wires cross)", () => {
    const doc = crossing()
    const wiring = wiringFor(doc)
    for (const p of [at(2, 5), at(20, 20), at(0, 5)]) {
      const result = junctionAt(doc, wiring, p, newId)
      expect.soft("refused" in result && result.refused, `at (${p.x / GRID}, ${p.y / GRID})`).toBe("no-crossing")
    }
  })
})

describe("selecting wires (design.md §6.2)", () => {
  function bent() {
    return docOf([resistor("R1", 0, 0), resistor("R2", 12, 6)], [seg(at(4, 1), at(8, 1), "red"), seg(at(8, 1), at(8, 7), "blue"), seg(at(8, 7), at(12, 7), "blue")])
  }

  it("a click picks the segment under the pointer, not its whole run (KiCad, Altium: a click selects one wire segment)", () => {
    const doc = bent()
    const wiring = wiringFor(doc)
    const middle = doc.wires.find((s) => s.a.x === s.b.x)!
    const run = wiring.runBySegment.get(middle.id)!
    expect.soft(segmentNearest(run, { x: c(8) + 3, y: c(4) }), "the upright piece").toBe(middle.id)
  })

  it("a double-click picks the run: every segment up to the next pins, branches or dangling ends, across a change of colour (design.md §6.2)", () => {
    const doc = bent()
    const wiring = wiringFor(doc)
    expect.soft([...chainOf(wiring, doc.wires[0].id)].sort(), "the red piece and the two blue ones").toEqual(doc.wires.map((s) => s.id).sort())
  })

  it("a run stops at a branch (design.md §6.2)", () => {
    const doc = docOf([resistor("R2", 0, 0), resistor("R3", 12, 0), resistor("R1", 7, 4, 90)], [seg(at(4, 1), at(12, 1)), seg(at(8, 4), at(8, 1))])
    const wiring = wiringFor(doc)
    const left = doc.wires.find((s) => Math.min(s.a.x, s.b.x) === c(4))!
    expect.soft(chainOf(wiring, left.id), "only the piece from R2's pin to the T").toEqual([left.id])
  })

  it("the marquee picks the segments wholly inside it as well as the parts; a part's wires are not picked with it (KiCad: a window selects enclosed wires)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 12, 0)], [seg(at(4, 1), at(8, 1)), seg(at(8, 1), at(8, 5)), seg(at(8, 5), at(12, 5)), seg(at(12, 5), at(12, 1))])
    const picked = inRect(doc, { x: c(-1), y: c(-1), w: c(10), h: c(4) })
    expect.soft(picked.objects, "R1").toEqual(["R1"])
    expect.soft(picked.wires, "the first piece only: the second leaves the box").toEqual([doc.wires[0].id])
  })
})

describe("deleting wires (design.md §6.5)", () => {
  it("the segment between two dots deleted: both dots become bends, the net splits in two (junctions.md 30)", () => {
    const doc = docOf(
      [resistor("R1", 0, 0), resistor("R2", 2, 4, 90), resistor("R3", 16, 0), resistor("R4", 9, 4, 90)],
      [seg(at(4, 1), at(16, 1)), seg(at(3, 4), at(3, 3)), seg(at(3, 3), at(6, 3)), seg(at(6, 3), at(6, 1)), seg(at(10, 4), at(10, 1))],
    )
    const before = wiringFor(doc)
    expect.soft(sortedPoints(junctionsOf(before.view)), "two dots").toEqual([at(6, 1), at(10, 1)])
    const between = doc.wires.find((s) => s.a.y === c(1) && s.b.y === c(1) && Math.min(s.a.x, s.b.x) === c(6))!
    const after = removed(doc, new Set(), new Set([between.id]), newId)
    expect.soft(junctionsOf(viewOf(after)), "no dot left").toEqual([])
    const change = netChanges(before.circuit.nets, wiringFor(after).circuit.nets)
    expect.soft(change.split.length, "one net split").toBe(1)
  })

  it("a run deleted takes the whole chain between its pins and branches, and its dot goes with it (design.md §6.5)", () => {
    const doc = docOf([resistor("R2", 0, 0), resistor("R3", 12, 0), resistor("R1", 7, 4, 90)], [seg(at(4, 1), at(12, 1)), seg(at(8, 4), at(8, 3), "red"), seg(at(8, 3), at(8, 1), "blue")])
    const wiring = wiringFor(doc)
    const branch = doc.wires.find((s) => s.color === "red")!
    const after = removed(doc, new Set(), new Set(chainOf(wiring, branch.id)), newId)
    expect.soft(geometryOf(after.wires), "the spine, whole again").toEqual(geometryOf([seg(at(4, 1), at(12, 1))]))
    expect.soft(junctionsOf(viewOf(after)), "no dot").toEqual([])
  })
})

describe("the join oracle the tests read (tests/lib/net-changes.ts)", () => {
  it("the same partition derived again is no change", () => {
    expect.soft(netChanges([["A:1", "B:1"]], [["A:1", "B:1"]]), "the same groups").toEqual(NO_CHANGE)
  })

  it("three nets made one are one join of three", () => {
    const change = netChanges([["G1:GND", "R1:1"], ["R2:2", "V1:V"], ["R3:1", "R3:2"]], [["G1:GND", "R1:1", "R2:2", "R3:1", "R3:2", "V1:V"]])
    expect.soft(change.joined.map((j) => j.from.length), "one join of three").toEqual([3])
  })
})

describe("copying and pasting with wires (design.md §6.6)", () => {
  it("a part copied with half of a branch in the selection brings no half-wires; the original is untouched (junctions.md 18; KiCad copies the segments in the selection)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 12, 0), resistor("R3", 7, 4, 90)], [seg(at(4, 1), at(12, 1)), seg(at(8, 4), at(8, 1))])
    const inside = inRect(doc, { x: c(-1), y: c(-1), w: c(10), h: c(4) })
    const clip = clipOf(doc, new Set(inside.objects), wiringFor(doc), new Set(inside.wires))!
    expect.soft(clip.objects.map((o) => o.id), "R1").toEqual(["R1"])
    expect.soft(geometryOf(clip.wires), "the piece wholly inside, from R1 to the T, and nothing beyond").toEqual(geometryOf([seg(at(4, 1), at(8, 1))]))
  })

  it("pasted wires keep their shape, and an end landing on a wire connects there by the ordinary rule (design.md §6.6)", () => {
    const doc = docOf([resistor("R2", 0, 10), resistor("R3", 12, 10)], [seg(at(4, 11), at(12, 11))])
    const clip = { objects: [resistor("R1", 7, 4, 90)], wires: [seg(at(8, 8), at(8, 9))], parts: {} }
    const after = pastedInto(doc, clip, 0, c(2), (old) => `${old}'`, newId)
    expect.soft(geometryOf(after.wires.filter((s) => s.a.x === s.b.x)), "the pasted wire two cells lower, its end on the spine").toEqual(geometryOf([seg(at(8, 10), at(8, 11))]))
    expect.soft(junctionsOf(viewOf(after)), "the spine split where it landed").toEqual([at(8, 11)])
    expect.soft(partition(after), "the pasted resistor's pin on the spine's net").toEqual([["R1':2", "R2:2", "R3:1"]])
  })
})

describe("found by phase 4's review (Codex)", () => {
  it("a wire is not ended on an outer socket that another net's wire passes: it would join that wire, and the slip that moves it aside is phase 6's (design.md §13.9; Codex 2)", () => {
    const doc = docOf(
      [{ id: "B", def: "nucleo-f429zi", x: 0, y: 0 }, resistor("A", -8, 16), resistor("D", -4, 13), resistor("E", 0, 9)],
      [seg(at(-4, 17), at(6, 17)), seg(at(0, 10), at(0, 14))],
    )
    const wiring = wiringFor(doc)
    const target = drawEndAt(wiring, at(5, 17))
    expect.soft(target.kind, "the outer socket").toBe("pin")
    const { d } = drawing(doc, at(0, 14))
    const preview = previewOf(doc, wiring, pointerAt(d, at(5, 17)), target)
    expect.soft(preview.refused?.refused, "refused, named").toBe("socket")
    expect.soft(isRefusal(drawnTo(doc, wiring, pointerAt(d, at(5, 17)), target, newId)), "and not committed").toBe(true)
  })

  it("a paste lands its wires clear of other nets: a pasted wire never lies along another net's wire or over its pins (design.md §6.6, §6.7; Codex 3)", () => {
    const doc = docOf([resistor("A", 0, 0), resistor("B", 10, 0), resistor("C", 20, 0), resistor("D", 30, 0)], [seg(at(4, 1), at(10, 1)), seg(at(24, 1), at(30, 1))])
    const wiring = wiringFor(doc)
    const clip = { objects: [resistor("P", -6, 0), resistor("Q", 40, 0)], wires: [seg(at(-2, 1), at(40, 1))], parts: {} }
    const scene = { objects: doc.objects, routes: wiring.routes, grid: GRID }
    const shifted = (c: typeof clip, p: Point) => c.wires.map((s) => ({ a: { x: s.a.x + p.x, y: s.a.y + p.y }, b: { x: s.b.x + p.x, y: s.b.y + p.y } }))
    const landing = pasteLanding(scene, clip, { x: 0, y: 0 }, (c, p) => laysClear(wiring, shifted(c, p)))
    expect.soft(landing.clear, "a clean place found").toBe(true)
    const after = pastedInto(doc, landing.clip, landing.at.x, landing.at.y, (old) => `copy${old}`, newId)
    expect.soft(netChanges(wiringFor(doc).circuit.nets, wiringFor(after).circuit.nets).joined, "no net joined").toEqual([])
  })
})

describe("found by phase 4's review (Claude)", () => {
  it("a pasted net whose end lands on an existing wire is a join (design.md §6.7; Claude 3)", () => {
    const doc = docOf([resistor("R8", 0, 4), resistor("R9", 8, 4)], [seg(at(4, 5), at(8, 5))])
    const clip = { objects: [resistor("R1", 0, 0), resistor("R2", 8, 0)], wires: [seg(at(4, 1), at(8, 1)), seg(at(6, 1), at(6, 4))], parts: {} }
    const idOf = (old: string) => `${old}'`
    const after = pastedInto(doc, clip, 0, c(1), idOf, newId)
    expect.soft(partition(after).find((g) => g.includes("R8:2")), "the pasted net and R8–R9 one net").toEqual(expect.arrayContaining(["R1':2", "R2':1", "R8:2", "R9:1"]))
  })

  it("over a target pin, the completion goes round the target part's own body when the plain L runs through it (design.md §6.1; Claude 7)", () => {
    const doc = docOf([resistor("R1", 0, 4), resistor("R2", 10, 4)])
    const { wiring, d } = drawing(doc, at(4, 5))
    const target = drawEndAt(wiring, at(14, 5))
    const preview = previewOf(doc, wiring, pointerAt(d, at(14, 5)), target)
    expect.soft(preview.routed, "the router's path").toBe(true)
    expect.soft(preview.refused, "not refused over R2's other pin").toBeNull()
  })

  it("a wire passing over a bare pin of another net, or over the end of another net's stub, is refused (design.md §6.7; Claude 8)", () => {
    const pinOnly = docOf([resistor("R1", 0, 0), resistor("R7", 7, 1, 90), resistor("R3", 12, 0)])
    const a = drawing(pinOnly, at(4, 1))
    expect.soft(previewOf(pinOnly, a.wiring, pointerAt(a.d, at(12, 1)), drawEndAt(a.wiring, at(12, 1))).refused?.refused, "over R7's bare pin").toBe("over")
    const stub = docOf([resistor("R1", 0, 0), resistor("R7", 7, 4, 90), resistor("R3", 12, 0)], [seg(at(8, 4), at(8, 1))])
    const b = drawing(stub, at(4, 1))
    expect.soft(previewOf(stub, b.wiring, pointerAt(b.d, at(12, 1)), drawEndAt(b.wiring, at(12, 1))).refused?.refused, "over the end of R7's stub").toBe("over")
  })

  it("a drawn wire may pass a free board socket without joining it: the jumper rule (design.md §4.5; junctions.md 33)", () => {
    const doc = docOf([{ id: "B", def: "nucleo-f429zi", x: 0, y: 0 }, resistor("A", -8, 16), resistor("Z", 8, 16)])
    const wiring = wiringFor(doc)
    const { d } = drawing(doc, at(-4, 17))
    const preview = previewOf(doc, wiring, pointerAt(d, at(8, 17)), drawEndAt(wiring, at(8, 17)))
    expect.soft(preview.refused, "passing the sockets is allowed").toBeNull()
    const after = drawnTo(doc, wiring, pointerAt(d, at(8, 17)), drawEndAt(wiring, at(8, 17)), newId)
    if (isRefusal(after)) throw new Error(after.refused)
    expect.soft(partition(after), "only A and Z joined").toEqual([["A:2", "Z:1"]])
  })

  it("Backspace restores the posture of the drawing before the click, a `/` included (design.md §6.1; Claude 8)", () => {
    const doc = docOf([resistor("R1", 0, 0)])
    const { wiring, d } = drawing(doc, at(10, 10))
    const flipped = flipPosture(pointerAt(d, at(14, 12)))
    const before = previewOf(doc, wiring, pointerAt(flipped, at(16, 16))).points
    const clicked = withCorner(doc, wiring, pointerAt(flipped, at(14, 12)), at(14, 12))
    if (isRefusal(clicked)) throw new Error("refused")
    expect.soft(previewOf(doc, wiring, pointerAt(withoutCorner(clicked), at(16, 16))).points, "as before the click, flipped").toEqual(before)
  })

  it("the posture from a pin follows the pin's axis whichever way the pointer moved first (Horizon; Claude 8)", () => {
    const doc = docOf([resistor("R1", 0, 0)])
    const { wiring, d } = drawing(doc, at(4, 1))
    expect.soft(previewOf(doc, wiring, towards(d, at(4, 3), at(8, 4))).points, "moved down first, still out along the pin").toEqual([at(4, 1), at(8, 1), at(8, 4)])
  })

  it("a run stops at a pin where exactly two wires end (design.md §6.2; Claude 8)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 8, 0), resistor("R3", 3, 3, 90)], [seg(at(4, 1), at(8, 1))])
    const through = docOf([...doc.objects], [seg(at(4, 3), at(4, 1)), seg(at(4, 1), at(8, 1))])
    const wiring = wiringFor(through)
    const upright = through.wires.find((s) => s.a.x === s.b.x)!
    expect.soft(chainOf(wiring, upright.id), "only the piece up to R1's pin").toEqual([upright.id])
  })

  it("the junction tool is refused on a crossing that sits on a board socket (design.md §6.4; Claude 8)", () => {
    const doc = docOf([{ id: "B", def: "nucleo-f429zi", x: 0, y: 0 }, resistor("A", -8, 16), resistor("Z", 8, 16), resistor("V", 4, 8, 90), resistor("W", 4, 20, 90)], [seg(at(-4, 17), at(8, 17)), seg(at(5, 12), at(5, 20))])
    const result = junctionAt(doc, wiringFor(doc), at(5, 17), newId)
    expect.soft("refused" in result && result.refused, "a socket under the crossing").toBe("no-crossing")
  })
})

describe("found by the verification of phase 4's fixes (Codex)", () => {
  it("a one-part paste whose wire's free end lands on an existing wire is a join (design.md §6.7)", () => {
    const doc = docOf([resistor("A", 0, 4), resistor("B", 8, 4)], [seg(at(4, 5), at(8, 5))])
    const clip = { objects: [resistor("P", 0, 0)], wires: [seg(at(4, 1), at(6, 1)), seg(at(6, 1), at(6, 4))], parts: {} }
    const idOf = (old: string) => `copy${old}`
    const after = pastedInto(doc, clip, 0, c(1), idOf, newId)
    expect.soft(partition(after).find((g) => g.includes("A:2")), "the pasted P on A–B's net").toEqual(expect.arrayContaining(["A:2", "B:1", "copyP:2"]))
  })

  it("Backspace after a flipped posture from a pin restores both the flip and the axis (design.md §6.1)", () => {
    const doc = docOf([resistor("A", 0, 0)])
    const { wiring, d } = drawing(doc, at(4, 1))
    const flipped = flipPosture(pointerAt(d, at(8, 4)))
    const clicked = withCorner(doc, wiring, flipped, at(8, 4))
    if (isRefusal(clicked)) throw new Error("refused")
    expect.soft(previewOf(doc, wiring, pointerAt(withoutCorner(clicked), at(10, 5))).points, "down from the pin first, as flipped").toEqual([at(4, 1), at(4, 5), at(10, 5)])
  })
})

describe("splice: a two-pin part dropped with both pins on one wire goes into it in series (design.md §5.3; junctions.md 26; Altium Components Cut Wires; KiCad cuts the wire between a dropped two-pin part's pins; Qucs-S)", () => {
  const line = () => docOf([resistor("R1", 0, 0), resistor("R2", 16, 0), resistor("R3", 6, 4)], [seg(at(4, 1), at(16, 1))])
  const covers = (doc: Schematic, from: Point, to: Point) =>
    doc.wires.some((s) => s.a.y === from.y && s.b.y === from.y && Math.min(s.a.x, s.b.x) <= from.x && Math.max(s.a.x, s.b.x) >= to.x) ||
    doc.wires.filter((s) => s.a.y === from.y && s.b.y === from.y && Math.min(s.a.x, s.b.x) < to.x && Math.max(s.a.x, s.b.x) > from.x).reduce((sum, s) => sum + Math.min(to.x, Math.max(s.a.x, s.b.x)) - Math.max(from.x, Math.min(s.a.x, s.b.x)), 0) >= to.x - from.x
  const dropped = (doc: Schematic, id: string, dx: number, dy: number, detach = false) => new PartDrag(doc, wiringFor(doc), { objects: new Set([id]) }, { detach }).landed(c(dx), c(dy), newId)

  it("dragged onto the R1–R2 wire, R3 cuts it under its body: the halves end on its pins, R3 is in series, no dot at either pin (junctions.md 26)", () => {
    const landed = dropped(line(), "R3", 0, -4)
    expect.soft(landed.at, "R3 lands where it was let go").toEqual({ x: 0, y: c(-4) })
    expect.soft(geometryOf(landed.doc.wires), "the wire cut between (6, 1) and (10, 1)").toEqual(geometryOf([seg(at(4, 1), at(6, 1)), seg(at(10, 1), at(16, 1))]))
    expect.soft(partition(landed.doc), "R1–R3–R2 in series").toEqual([
      ["R1:2", "R3:1"],
      ["R2:1", "R3:2"],
    ])
    expect.soft(junctionsOf(viewOf(landed.doc)), "a pin and one end: no dot").toEqual([])
    expect.soft(normalFormViolations(landed.doc.wires, wirePins(landed.doc.objects)), "normal form").toEqual([])
  })

  it("every two-terminal symbol splices the same way: capacitor, inductor, diode, LED, Zener (design.md §5.3: a two-terminal part)", () => {
    for (const def of ["capacitor", "inductor", "diode", "led", "zener"]) {
      const doc = docOf([resistor("R1", 0, 0), resistor("R2", 16, 0), { id: "X3", def, x: c(6), y: c(4), props: { ref: "X3" } }], [seg(at(4, 1), at(16, 1))])
      const landed = dropped(doc, "X3", 0, -4)
      expect.soft(geometryOf(landed.doc.wires), `${def}: cut under its body`).toEqual(geometryOf([seg(at(4, 1), at(6, 1)), seg(at(10, 1), at(16, 1))]))
      expect.soft(partition(landed.doc), `${def}: in series`).toEqual([
        ["R1:2", "X3:1"],
        ["R2:1", "X3:2"],
      ])
    }
  })

  it("a vertical wire is cut the same way, whichever way the segment was drawn", () => {
    for (const reversed of [false, true]) {
      const wire = reversed ? seg(at(1, 16), at(1, 4)) : seg(at(1, 4), at(1, 16))
      const doc = docOf([resistor("R1", 0, 0, 90), resistor("R2", 0, 16, 90), resistor("R3", 6, 6, 90)], [wire])
      const landed = dropped(doc, "R3", -6, 0)
      expect.soft(geometryOf(landed.doc.wires), `${reversed ? "drawn upwards" : "drawn downwards"}: cut between (1, 6) and (1, 10)`).toEqual(geometryOf([seg(at(1, 4), at(1, 6)), seg(at(1, 10), at(1, 16))]))
      expect.soft(partition(landed.doc), "in series").toEqual([
        ["R1:2", "R3:1"],
        ["R2:1", "R3:2"],
      ])
    }
  })

  it("pins landing on the wire's own two ends take the whole wire: the part replaces it, butted to both neighbours; with one pin on an end one half is left", () => {
    const whole = dropped(docOf([resistor("R1", 0, 0), resistor("R2", 8, 0), resistor("R3", 4, 4)], [seg(at(4, 1), at(8, 1))]), "R3", 0, -4)
    expect.soft(whole.doc.wires, "no wire left").toEqual([])
    expect.soft(partition(whole.doc), "R1–R3–R2 butted").toEqual([
      ["R1:2", "R3:1"],
      ["R2:1", "R3:2"],
    ])
    const half = dropped(docOf([resistor("R1", 0, 0), resistor("R2", 12, 0), resistor("R3", 4, 4)], [seg(at(4, 1), at(12, 1))]), "R3", 0, -4)
    expect.soft(geometryOf(half.doc.wires), "the half from (8, 1) to R2").toEqual(geometryOf([seg(at(8, 1), at(12, 1))]))
    expect.soft(partition(half.doc), "in series").toEqual([
      ["R1:2", "R3:1"],
      ["R2:1", "R3:2"],
    ])
    expect.soft(normalFormViolations(half.doc.wires, wirePins(half.doc.objects)), "normal form").toEqual([])
  })

  it("added from the palette onto the wire, the part splices the same way (design.md §5.3: when a two-terminal part is released)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 16, 0)], [seg(at(4, 1), at(16, 1))])
    const added = placedObject(doc, resistor("R3", 6, 0), newId)
    expect.soft(geometryOf(added.wires), "cut under R3").toEqual(geometryOf([seg(at(4, 1), at(6, 1)), seg(at(10, 1), at(16, 1))]))
    expect.soft(partition(added), "in series").toEqual([
      ["R1:2", "R3:1"],
      ["R2:1", "R3:2"],
    ])
  })

  it("Alt suppresses the splice, so a drop that leaves the whole wire under the body is refused", () => {
    const before = line()
    const landed = dropped(before, "R3", 0, -4, true)
    expect.soft(covers(landed.doc, at(4, 1), at(16, 1)), "the wire still runs from R1 to R2").toBe(true)
    expect.soft(landed.refused?.some((c) => c.reason === "body"), "the body crossing is named").toBe(true)
    expect.soft(landed.doc, "the entire document stays as it was").toBe(before)
    expect.soft(partition(landed.doc), "R3 stays off the wire").toEqual([["R1:2", "R2:1"]])
  })

  it("an armed palette click preserves Alt while the definition loads and still normalises pins", () => {
    for (const altKey of [true, false]) {
      let doc = docOf([resistor("R1", 0, 0), resistor("R2", 16, 0)], [seg(at(4, 1), at(16, 1))])
      const add = sourceCallback<(def: string, center: Point) => PlacedObject>("src/schematic/use-schematic.ts", "add", {
        doc, getDef, snap, grid: GRID, crypto: { randomUUID: () => "R3" }, placedObject, wireCheck, freeSpot,
        setDoc: (fn: (d: Schematic) => Schematic) => { doc = fn(doc) },
        nextRef: () => "R3", setSelectedObjects: () => {}, setSelectedWires: () => {},
      })
      let loaded = () => {}
      const click = sourceCallback<(e: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean }, def: string) => void>("src/components/field/DotField.tsx", "placeArmed", {
        toWorld: (x: number, y: number) => ({ x, y }), onArmedChange: () => {},
        afterDefs: (_ids: string[], fn: () => void) => { loaded = fn },
        sch: { add, selectObject: () => {} }, placed: () => {}, cannotLoad: () => {}, lastPress: { current: null },
      })
      const event = { clientX: c(8), clientY: c(1), shiftKey: false, altKey }
      click(event, "resistor")
      event.altKey = !altKey
      loaded()
      expect.soft(doc.wires.reduce((sum, s) => sum + Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y), 0), `Alt ${altKey}: continuous or spliced length`).toBeNear(c(altKey ? 12 : 8), 1e-6)
      expect.soft(normalFormViolations(doc.wires, wirePins(doc.objects)), `Alt ${altKey}: split at every pin`).toEqual([])
      expect.soft(checked(doc).filter((f) => f.kind === "wire-through-body"), `Alt ${altKey}: no wire left under R3 (the user, 2026-11-11)`).toEqual([])
      expect.soft(partition(doc), `Alt ${altKey}: the intended connectivity — with Alt, kept whole and so put beside the wire`).toEqual(altKey ? [["R1:2", "R2:1"]] : [["R1:2", "R3:1"], ["R2:1", "R3:2"]])
    }
  })

  it("with one pin on the wire the part just connects there: the wire is split at the pin, a dot, nothing cut (design.md §5.3; junctions.md 25)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 16, 0), resistor("R3", 5, 4, 90)], [seg(at(4, 1), at(16, 1))])
    const landed = dropped(doc, "R3", 0, -3)
    expect.soft(covers(landed.doc, at(4, 1), at(16, 1)), "nothing cut").toBe(true)
    expect.soft(sortedPoints(junctionsOf(viewOf(landed.doc))), "a dot at R3's pin").toEqual([at(6, 1)])
    expect.soft(partition(landed.doc), "one net").toEqual([["R1:2", "R2:1", "R3:1"]])
  })

  it("a part with three pins is not spliced, and since the wire would then run on under its body, it lands where no wire does (design.md §5.3: a two-terminal part; the user, 2026-11-11: no wire through a body)", () => {
    const doc = docOf([resistor("R1", 8, -8, 90), resistor("R2", 8, 8, 90), { id: "Q1", def: "npn", x: c(12), y: c(-6), props: { ref: "Q1" } }], [seg(at(9, -4), at(9, 8))])
    const landed = dropped(doc, "Q1", -6, 5)
    expect.soft(landed.at.x === c(-6) && landed.at.y === c(5), "not over the wire, where collector and emitter would sit on it").toBe(false)
    expect.soft(checked(landed.doc).filter((f) => f.kind === "wire-through-body"), "no wire through Q1").toEqual([])
    expect.soft(covers(landed.doc, at(9, -4), at(9, 8)), "the wire whole").toBe(true)
  })

  it("a wire with a branch between the two pins is not cut, so the part lands where the branch is not left under its body (taken by default, findings.md phase 5; the user, 2026-11-11)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 16, 0), resistor("R4", 7, 6, 90), resistor("R3", 6, -6)], [seg(at(4, 1), at(16, 1)), seg(at(8, 1), at(8, 6))])
    const landed = dropped(doc, "R3", 0, 6)
    expect.soft(landed.at.x === 0 && landed.at.y === c(6), "not over the branch point").toBe(false)
    expect.soft(checked(landed.doc).filter((f) => f.kind === "wire-through-body"), "no wire through R3").toEqual([])
    expect.soft(covers(landed.doc, at(4, 1), at(16, 1)), "the spine stays whole").toBe(true)
    expect.soft(partition(landed.doc).find((g) => g.includes("R4:1")), "R4 still on the spine").toEqual(expect.arrayContaining(["R1:2", "R2:1", "R4:1"]))
  })

  it("the halves keep their colour, and a cut inside one colour leaves the boundary where it was", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 16, 0), resistor("R3", 6, 4)], [seg(at(4, 1), at(12, 1), "red"), seg(at(12, 1), at(16, 1), "blue")])
    expect(geometryOf(dropped(doc, "R3", 0, -4).doc.wires)).toEqual(geometryOf([seg(at(4, 1), at(6, 1), "red"), seg(at(10, 1), at(12, 1), "red"), seg(at(12, 1), at(16, 1), "blue")]))
  })

  it("both pins on one straight run across a change of colour, nothing else meeting it between them: cut, each half keeping its colour (taken by default, findings 5.2: a run crosses a change of colour, design.md §6.2; N4 keeps the boundary)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 16, 0), resistor("R3", 10, 4)], [seg(at(4, 1), at(12, 1), "red"), seg(at(12, 1), at(16, 1), "blue")])
    const landed = dropped(doc, "R3", 0, -4)
    expect.soft(geometryOf(landed.doc.wires), "cut between (10, 1) and (14, 1)").toEqual(geometryOf([seg(at(4, 1), at(10, 1), "red"), seg(at(14, 1), at(16, 1), "blue")]))
  })

  it("an old document with a part's two pins on one wire opens with its circuit unchanged: a splice is a drop, never a load (phase 5: no existing schematic changes circuit when loaded; design.md §13.11)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 16, 0), resistor("R3", 6, 0)], [seg(at(4, 1), at(16, 1))])
    const reopened = upgraded(JSON.parse(JSON.stringify(stamped(doc)))).doc
    expect.soft(partition(reopened), "R3 shorted as drawn").toEqual(partition(doc))
    expect.soft(covers(reopened, at(4, 1), at(16, 1)), "the wire whole").toBe(true)
  })
})

