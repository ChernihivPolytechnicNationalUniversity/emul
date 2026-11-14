import { describe, expect, it } from "vitest"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { bendsOf, chained, dragConflictMarks, refusedStretches, trimmedAtBends, type Stretch } from "@/schematic/conflict-marks"
import { GRID, type Point } from "@/schematic/geometry"
import { placementCheck, placementClashes } from "@/schematic/placement"
import { PartDrag } from "@/schematic/rubber-band"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { drawEndAt, isRefusal, pointerAt, previewOf, startDrawing, type DrawRefusal } from "@/schematic/wire-draw"
import { inNormalForm, wiringOf } from "@/schematic/wire-edits"
import type { DragConflict, DragFrame, DragPiece } from "@/schematic/wires/drag"
import { WireGraph } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { carriedCover } from "@/components/field/body-mask"
import { bandGlow, bandOf, runsNear } from "@/components/field/rubber-band-layer"
import { PendingWireLayer } from "@/components/field/WireLayer"

const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const by = (x: number, y: number) => [x * GRID, y * GRID] as const
const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
const ground = (id: string, x: number, y: number): PlacedObject => ({ id, def: "ground", x: x * GRID, y: y * GRID, props: { ref: id } })
const wire = (id: string, a: Point, b: Point, color?: WireSegment["color"]): WireSegment => ({ id, a, b, ...(color && { color }) })
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic) => wiringOf(new WireGraph(), doc)
const piece = (id: string, a: Point, b: Point): DragPiece => ({ id, a, b, kind: "moved", net: "n1" })
const frameOf = (pieces: DragPiece[], conflicts: DragConflict[], pins: (readonly [string, Point])[] = [], blocked = conflicts.length > 0): DragFrame => ({ pieces, replaced: new Set(), pins: new Map(pins), blocked, conflicts, reroutes: [], joins: [] })
const conflict = (reason: DragConflict["reason"], where: Point, rest: Partial<DragConflict> = {}): DragConflict => ({ at: where, reason, nets: ["n1", "n2"], ...rest })
const sorted = (stretches: readonly Stretch[]) => stretches.map((s) => s.map((p) => [p.x / GRID, p.y / GRID])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
const refusal = (refused: DrawRefusal["refused"], where: Point, leg?: number): DrawRefusal => ({ refused, at: where, nets: [], ...(leg !== undefined && { leg }) })

describe("a blocked drag marks the piece or the part that is in conflict, not the whole band (the user, 2026-11-12: «выделять конкретно тот сегмент, где запрет»)", () => {
  const p = piece("p", at(2, 5), at(8, 5))
  const q = piece("q", at(8, 5), at(8, 9))
  const r = piece("r", at(8, 9), at(12, 9))

  it("a piece along another net's wire, over its pin or through a body is marked end to end, and the pieces beside it are not", () => {
    for (const reason of ["along", "over", "body"] as const) {
      const marks = dragConflictMarks(frameOf([p, q, r], [conflict(reason, at(9, 9), { piece: "r" })]))
      expect.soft(sorted(marks.stretches), `${reason}: only r`).toEqual([[[8, 9], [12, 9]]])
      expect.soft([...marks.parts], `${reason}: no part`).toEqual([])
    }
  })

  it("a carried body landing on a standing wire marks the part, since the wire under it is not in the band", () => {
    const marks = dragConflictMarks(frameOf([p, q], [conflict("body", at(20, 20), { piece: "standing", part: "R2" })]))
    expect.soft([...marks.parts], "the part").toEqual(["R2"])
    expect.soft(marks.stretches, "no piece").toEqual([])
  })

  it("a body conflict on a band piece marks the piece and not the part named beside it", () => {
    const marks = dragConflictMarks(frameOf([p, q], [conflict("body", at(20, 20), { piece: "q", part: "R2" })]))
    expect.soft(sorted(marks.stretches), "q").toEqual([[[8, 5], [8, 9]]])
    expect.soft([...marks.parts], "not the part").toEqual([])
  })

  it("an end on another net marks the cell of the piece next to that end, whichever end it is, and a shorter piece whole", () => {
    expect.soft(sorted(dragConflictMarks(frameOf([p, q], [conflict("end", at(2, 5), { piece: "p" })])).stretches), "from a").toEqual([[[2, 5], [3, 5]]])
    expect.soft(sorted(dragConflictMarks(frameOf([p, q], [conflict("end", at(8, 5), { piece: "p" })])).stretches), "from b").toEqual([[[8, 5], [7, 5]]])
    const short = piece("s", at(4, 4), at(4, 4.5))
    expect.soft(sorted(dragConflictMarks(frameOf([short], [conflict("end", at(4, 4), { piece: "s" })])).stretches), "half a cell: all of it").toEqual([[[4, 4], [4, 4.5]]])
    expect.soft(dragConflictMarks(frameOf([p], [conflict("end", at(5, 5), { piece: "p" })]), new Set()).stretches, "a point that is not its end marks nothing of it, and the fallback marks the band").toEqual([[p.a, p.b]])
  })

  it("an end conflict on a piece already marked whole adds nothing", () => {
    const marks = dragConflictMarks(frameOf([p, q], [conflict("along", at(3, 5), { piece: "p" }), conflict("end", at(2, 5), { piece: "p" })]))
    expect.soft(sorted(marks.stretches), "p once, whole").toEqual([[[2, 5], [8, 5]]])
  })

  it("the same conflict reported twice is one mark", () => {
    const marks = dragConflictMarks(frameOf([p, q], [conflict("along", at(3, 5), { piece: "p" }), conflict("over", at(4, 5), { piece: "p" })]))
    expect.soft(marks.stretches.length, "one").toBe(1)
  })

  it("a carried pin on another net marks the part that carries it", () => {
    const marks = dragConflictMarks(frameOf([p], [conflict("pin", at(2, 5), { pin: "R7:2" })]))
    expect.soft([...marks.parts], "R7").toEqual(["R7"])
    expect.soft(marks.stretches, "no piece").toEqual([])
  })

  it("a crossing marks a cell of every piece ending there and every part with a pin there, and nothing elsewhere", () => {
    const marks = dragConflictMarks(frameOf([p, q, r], [conflict("crossing", at(8, 5))], [["R1:1", at(8, 5)], ["R2:1", at(12, 9)]]))
    expect.soft(sorted(marks.stretches), "a cell of p and of q at (8, 5)").toEqual([[[8, 5], [7, 5]], [[8, 5], [8, 6]]])
    expect.soft([...marks.parts], "R1 only").toEqual(["R1"])
  })

  it("parts that collide are marked and add no piece", () => {
    const marks = dragConflictMarks(frameOf([p], [], [], true), new Set(["R3", "R4"]))
    expect.soft([...marks.parts].sort(), "both").toEqual(["R3", "R4"])
    expect.soft(marks.stretches, "no piece").toEqual([])
  })

  it("a blocked frame whose conflicts name nothing it can draw marks the whole band, so a refusal is never silent; a clean frame marks nothing", () => {
    expect.soft(sorted(dragConflictMarks(frameOf([p, q], [conflict("along", at(3, 5), { piece: "gone" })])).stretches), "the band").toEqual([[[2, 5], [8, 5]], [[8, 5], [8, 9]]])
    expect.soft(dragConflictMarks(frameOf([p, q], [], [], false)), "clean").toEqual({ stretches: [], parts: new Set() })
  })

  it("the reach of an end mark is the grid it is given", () => {
    expect.soft(sorted(dragConflictMarks(frameOf([p], [conflict("end", at(2, 5), { piece: "p" })]), undefined, 2 * GRID).stretches), "two cells").toEqual([[[2, 5], [4, 5]]])
  })
})

describe("on a real drag: which piece glows and which part", () => {
  it("a part dragged so its free wire lies along another net's wire: only that wire glows, not the wire to R1 (the second screenshot)", () => {
    const doc = docOf([resistor("R1", 10, 10), resistor("R2", 20, 10), resistor("R5", 32, 14)], [wire("w1", at(14, 11), at(20, 11)), wire("w3", at(24, 11), at(28, 11)), wire("w2", at(25, 15), at(32, 15), "blue")])
    const wiring = wiringFor(doc)
    const drag = new PartDrag(doc, wiring, { objects: new Set(["R2"]) })
    const frame = drag.frame(...by(0, 4))
    expect.soft(frame.blocked, "blocked").toBe(true)
    const marks = dragConflictMarks(frame)
    expect.soft(sorted(marks.stretches), "the free wire, moved down to lie on w2").toEqual([[[24, 15], [28, 15]]])
    expect.soft([...marks.parts], "R2 itself is clear").toEqual([])
    const look = { runOf: (s: string) => wiring.runBySegment.get(s), colorOfRun: () => "black" as const, colorOfNet: () => "black" as const, sheet: wiring.sheet }
    expect.soft(bandGlow(frame, bandOf(frame, look).wires, GRID).length, "one glowing path in the band").toBe(1)
    const clean = drag.frame(...by(0, -3))
    expect.soft([clean.blocked, bandGlow(clean, bandOf(clean, look).wires, GRID)], "a clean offset glows nowhere").toEqual([false, []])
  })

  it("a part dragged with its body onto a standing wire: the part glows (the third screenshot)", () => {
    const doc = docOf([resistor("R1", 10, 10), resistor("R2", 20, 10), resistor("R6", 21, 19, 90)], [wire("w1", at(14, 11), at(20, 11)), wire("w4", at(22, 13), at(22, 19), "blue")])
    const drag = new PartDrag(doc, wiringFor(doc), { objects: new Set(["R2"]) })
    const frame = drag.frame(...by(0, 5))
    expect.soft(frame.blocked, "blocked").toBe(true)
    const marks = dragConflictMarks(frame)
    expect.soft([...marks.parts], "R2").toEqual(["R2"])
    expect.soft(marks.stretches, "no band piece").toEqual([])
  })

  it("a part dropped on another part: placementClashes names the one that collides, and agrees with placementCheck (the first screenshot)", () => {
    const objects = [resistor("R1", 10, 10), resistor("R2", 20, 10), resistor("R3", 14, 16, 90)]
    const scene = { objects, routes: [], grid: GRID }
    const r2 = objects.filter((o) => o.id === "R2")
    const both = objects.filter((o) => o.id !== "R3")
    expect.soft([...placementClashes(scene, r2)(...by(-7, 7))], "R2 on R3").toEqual(["R2"])
    expect.soft([...placementClashes(scene, r2)(...by(0, -4))], "clear").toEqual([])
    expect.soft([...placementClashes(scene, both)(...by(-7, 7))], "of R1 and R2, only R2 lands on R3").toEqual(["R2"])
    expect.soft([...placementClashes(scene, both)(...by(-6, 6))], "R1 lands on nothing; R2 on R3").toEqual(["R2"])
    const check = placementCheck(scene, both)
    const clashes = placementClashes(scene, both)
    for (let dx = -10; dx <= 2; dx++) for (let dy = -2; dy <= 10; dy++) expect.soft(clashes(...by(dx, dy)).size > 0, `(${dx}, ${dy})`).toBe(check(...by(dx, dy)))
  })

  it("asked twice at one offset, placementClashes answers from the last call; at another offset it asks again", () => {
    const objects = [resistor("R2", 20, 10), resistor("R3", 14, 16, 90)]
    const clashes = placementClashes({ objects, routes: [], grid: GRID }, objects.slice(0, 1))
    const first = clashes(...by(-7, 7))
    expect.soft(clashes(...by(-7, 7)), "the same set").toBe(first)
    expect.soft(clashes(...by(0, 0)).size, "clear at home").toBe(0)
    expect.soft(clashes(...by(-7, 7)).size, "and on R3 again").toBe(1)
  })
})

function drawn(doc: Schematic, from: Point, ...moves: Point[]) {
  const wiring = wiringFor(doc)
  const started = startDrawing(wiring, drawEndAt(wiring, from))
  if (isRefusal(started)) throw new Error(`refused at the start: ${started.refused}`)
  const d = moves.reduce(pointerAt, started)
  return previewOf(doc, wiring, d)
}

describe("a refused wire marks the stretch where the refusal is, not the whole wire (the user, 2026-11-12: a red wire reads as a power wire)", () => {
  const path = [at(0, 0), at(6, 0), at(6, 4), at(10, 4)]

  it("a leg refusal marks that leg", () => {
    for (const leg of [0, 1, 2]) expect.soft(refusedStretches(path, refusal("body", at(50, 50), leg)), `leg ${leg}`).toEqual([[path[leg], path[leg + 1]]])
  })

  it("a refusal at a corner marks a cell either side of the bend", () => {
    expect.soft(sorted(refusedStretches(path, refusal("corner", at(6, 0)))), "the elbow").toEqual([[[5, 0], [6, 0], [6, 1]]])
  })

  it("a refusal at an end marks the last cell before it", () => {
    expect.soft(sorted(refusedStretches(path, refusal("crossing", at(10, 4)))), "the end").toEqual([[[9, 4], [10, 4]]])
    expect.soft(sorted(refusedStretches(path, refusal("socket", at(0, 0)))), "the start").toEqual([[[0, 0], [1, 0]]])
  })

  it("a refusal inside a leg marks a cell either way along it", () => {
    expect.soft(sorted(refusedStretches(path, refusal("socket", at(6, 2)))), "mid-leg").toEqual([[[6, 1], [6, 2], [6, 3]]])
  })

  it("a cell longer than the leg stops at its vertex", () => {
    const short = [at(0, 0), at(0.5, 0), at(0.5, 3)]
    expect.soft(sorted(refusedStretches(short, refusal("corner", at(0.5, 0)))), "half a cell back").toEqual([[[0, 0], [0.5, 0], [0.5, 1]]])
  })

  it("a refusal it cannot place on the path marks the whole wire, never nothing", () => {
    expect.soft(refusedStretches(path, refusal("corner", at(3, 3))), "off the path").toEqual([path])
    expect.soft(refusedStretches(path, refusal("along", at(3, 0), 7)), "a leg past the end").toEqual([path])
    expect.soft(refusedStretches(path, refusal("along", at(3, 0), -1)), "a negative leg").toEqual([path])
  })

  it("no refusal, nothing to lay, or no leg yet: nothing marked", () => {
    expect.soft(refusedStretches(path, null), "allowed").toEqual([])
    expect.soft(refusedStretches(path, refusal("nothing", at(0, 0))), "nothing").toEqual([])
    expect.soft(refusedStretches([at(1, 1)], refusal("crossing", at(1, 1))), "a point").toEqual([])
  })

  it("the user's picture: an L past a ground whose lying leg runs along its top bar marks that leg only", () => {
    const preview = drawn(docOf([ground("G1", 10, 10)]), at(7, 7), at(7, 11), at(15, 11))
    expect.soft(preview.refused?.refused, "through the ground's body").toBe("body")
    expect.soft(preview.points, "the L").toEqual([at(7, 7), at(7, 11), at(15, 11)])
    expect.soft(refusedStretches(preview.points, preview.refused), "the lying leg").toEqual([[at(7, 11), at(15, 11)]])
  })

  it("a first leg along another net's wire marks the first leg, the second stays plain", () => {
    const preview = drawn(docOf([], [wire("other", at(9, 7), at(12, 7))]), at(7, 7), at(15, 7), at(15, 11))
    expect.soft(preview.refused?.refused, "along").toBe("along")
    expect.soft(refusedStretches(preview.points, preview.refused), "the first leg").toEqual([[at(7, 7), at(15, 7)]])
  })

  it("a bend on another net's pin marks the elbow", () => {
    const preview = drawn(docOf([resistor("R9", 14, 3, 90)]), at(7, 7), at(15, 7), at(15, 11))
    expect.soft(preview.refused?.refused, "the corner on R9's pin").toBe("corner")
    expect.soft(sorted(refusedStretches(preview.points, preview.refused)), "a cell either side of (15, 7)").toEqual([[[14, 7], [15, 7], [15, 8]]])
  })
})

describe("the glow is drawn under exactly the marked stretches, joined where they meet and stopping where the wire's own bend starts", () => {
  it("stretches that meet end to end are one line, either way round; three meeting at a point are not joined there", () => {
    expect.soft(chained([[at(0, 0), at(4, 0)], [at(4, 4), at(4, 0)]]), "an L").toEqual([[at(0, 0), at(4, 0), at(4, 4)]])
    expect.soft(chained([[at(4, 0), at(4, 4)], [at(4, 0), at(0, 0)]]), "joined at the first one's start").toEqual([[at(0, 0), at(4, 0), at(4, 4)]])
    const tee = chained([[at(0, 0), at(4, 0)], [at(4, 0), at(8, 0)], [at(4, 0), at(4, 4)]])
    expect.soft(tee.length, "a T stays three lines").toBe(3)
    expect.soft(chained([[at(0, 0), at(4, 0)], [at(0, 0), at(4, 0)], [at(4, 0), at(0, 0)]]), "the same stretch thrice is one").toEqual([[at(0, 0), at(4, 0)]])
    expect.soft(chained([[at(1, 1), at(1, 1)]]), "a stretch of no length draws nothing").toEqual([])
  })

  it("an end on the wire's bend is pulled back by the corner radius, or half the stretch if that is shorter; other ends stay", () => {
    const bend = (p: Point) => p.x === at(4, 0).x && p.y === 0
    expect.soft(trimmedAtBends([at(0, 0), at(4, 0)], bend, 6), "the bend end").toEqual([at(0, 0), { x: at(4, 0).x - 6, y: 0 }])
    expect.soft(trimmedAtBends([at(4, 0), at(0, 0)], bend, 6), "either way round").toEqual([{ x: at(4, 0).x - 6, y: 0 }, at(0, 0)])
    expect.soft(trimmedAtBends([at(3.75, 0), at(4, 0)], bend, 6), "a quarter cell: halfway").toEqual([at(3.75, 0), { x: at(3.875, 0).x, y: 0 }])
    expect.soft(trimmedAtBends([at(0, 0), at(2, 0)], bend, 6), "no bend at either end").toEqual([at(0, 0), at(2, 0)])
    const both = (p: Point) => p.y === 0
    expect.soft(trimmedAtBends([at(0, 0), at(4, 0)], both, 6), "both ends").toEqual([{ x: 6, y: 0 }, { x: at(4, 0).x - 6, y: 0 }])
    expect.soft(trimmedAtBends([{ x: 0, y: 0 }, { x: 6, y: 0 }], both, 6), "a quarter cell bent at both ends: each end halfway, measured on the untrimmed stretch").toEqual([{ x: 3, y: 0 }, { x: 3, y: 0 }])
  })

  it("a bend is an inner vertex where the line turns; ends and straight-through vertices are not", () => {
    const isBend = bendsOf([[at(0, 0), at(2, 0), at(4, 0), at(4, 3)]])
    expect.soft([at(0, 0), at(2, 0), at(4, 0), at(4, 3)].map(isBend), "only (4, 0)").toEqual([false, false, true, false])
  })
})

describe("the pending wire keeps its own colour and glows under the refused stretch only, beneath the parts, its casing cut there", () => {
  const html = (part: "route" | "glow", conflict?: readonly Stretch[]) =>
    renderToStaticMarkup(
      React.createElement(PendingWireLayer, {
        pending: { points: [at(7, 7), at(7, 11), at(15, 11)], corners: [], color: "blue", refused: !!conflict, landing: false, conflict },
        grid: GRID,
        scale: 2,
        part,
      }),
    )
  const lying = [[at(7, 11), at(15, 11)]]

  it("refused: one glow under the lying leg, drawn in the glow layer and sized for this zoom", () => {
    const glow = html("glow", lying)
    expect.soft(glow, "the glow group").toContain('data-slot="pending-wire-glow"')
    expect.soft(glow.match(/stroke="var\(--conflict\)"/g)?.length, "one glowing path").toBe(1)
    expect.soft(glow, "the glow sized for this zoom").toContain("--conflict-px:0.5px")
  })

  it("refused: the route keeps its blue dashes, no red, no glow of its own, and its casing is cut where the glow is so nothing white sits over it", () => {
    const route = html("route", lying)
    expect.soft(route, "the wire's colour").toContain("var(--wire-blue)")
    expect.soft(route, "no red").not.toContain("--destructive")
    expect.soft(route, "the glow is not in the route").not.toContain("var(--conflict)")
    expect.soft(route, "the casing under a cut").toContain('mask="url(#pending-wire-glow-cut)"')
    expect.soft(route.match(/stroke="black"/g)?.length, "one cut, along the glow").toBe(1)
  })

  it("allowed: no glow, no cut", () => {
    expect.soft(html("glow"), "nothing in the glow layer").toBe("")
    expect.soft(html("route"), "plain casing").not.toContain("glow-cut")
  })
})

describe("casings keep off the carried parts: their shapes and boxes, and the standing wires near them", () => {
  it("each carried part has one box that holds every shape of it, grown by half the mask's edge", () => {
    const parts = [resistor("R1", 10, 10), resistor("R2", 20, 10, 90)]
    const { shapes, boxes } = carriedCover(parts, GRID)
    expect.soft(boxes.length, "one per part").toBe(2)
    const inside = (p: Point) => boxes.some((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h)
    expect.soft([...shapes.bodies.flat(), ...shapes.leads.flat(), ...shapes.texts.flatMap((r) => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }])].every(inside), "every shape inside").toBe(true)
    expect.soft(boxes[0].x, "R1's box starts half an edge left of its pin").toBeNear(at(10, 0).x - 0.075 * GRID, 1e-9)
    expect.soft(shapes.bodies.length, "both bodies").toBe(2)
  })

  it("only the runs with a segment in the box are near it", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 20, 0)], [wire("a", at(4, 1), at(10, 1)), wire("b", at(10, 1), at(10, 6)), wire("c", at(24, 1), at(30, 1))])
    const wiring = wiringFor(doc)
    const near = runsNear(doc.wires, (s) => wiring.runBySegment.get(s), GRID)
    const runOf = (id: string) => wiring.runBySegment.get(id)!.id
    expect.soft([...near({ x: at(9, 3).x, y: at(9, 3).y, w: 2 * GRID, h: GRID })], "the run through (10, 3)").toEqual([runOf("b")])
    expect.soft([...near({ x: at(26, 0).x, y: at(26, 0).y, w: GRID, h: 2 * GRID })], "the other run").toEqual([runOf("c")])
    expect.soft([...near({ x: at(15, 10).x, y: at(15, 10).y, w: GRID, h: GRID })], "nothing there").toEqual([])
  })
})
