import { describe, expect, it } from "vitest"
import { GRID, type Point } from "@/schematic/geometry"
import { SegmentDrag } from "@/schematic/rubber-band"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { inNormalForm, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const resistor = (id: string, x: number, y: number): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id } })
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic): Wiring => wiringOf(new WireGraph(), doc)
let serial = 0
const newId = () => `n${++serial}`
const cells = (doc: Schematic) => doc.wires.map((s) => [s.a.x / GRID, s.a.y / GRID, s.b.x / GRID, s.b.y / GRID].join(",")).sort()
const tee = () => docOf([], [
  { id: "a", a: at(8, 6), b: at(18, 6) },
  { id: "b", a: at(13, 6), b: at(13, 11) },
])
const stemOf = (doc: Schematic) => doc.wires.find((s) => s.a.x === s.b.x)!

describe("a selection of several wires is dragged as one body (the user, 2026-11-16, item 12)", () => {
  it("a whole T selected and pressed on its stem moves diagonally, every segment by the same offset", () => {
    const doc = tee()
    const selection = new Set(doc.wires.map((s) => s.id))
    const landed = new SegmentDrag(doc, wiringFor(doc), stemOf(doc).id, undefined, { selection }).landed(c(3), c(2), newId)
    expect.soft(landed.refused, "nothing refused").toBeUndefined()
    expect.soft(cells(landed.doc), "the T three cells right and two down, shape unchanged").toEqual(cells(docOf([], [
      { id: "a", a: at(11, 8), b: at(21, 8) },
      { id: "b", a: at(16, 8), b: at(16, 13) },
    ])))
  })

  it("the same T without the selection still slides its stem along its normal only (KiCad drag, design.md §6.3)", () => {
    const doc = tee()
    const landed = new SegmentDrag(doc, wiringFor(doc), stemOf(doc).id).landed(c(3), c(2), newId)
    const stem = stemOf(landed.doc)
    expect.soft(stem.a.y === at(13, 6).y || stem.b.y === at(13, 6).y, "the stem still starts on the bar's row").toBe(true)
  })

  it("a selected T hanging from a resistor's pin moves freely and the wire to the pin follows", () => {
    const doc = docOf([resistor("R1", 2, 5)], [
      { id: "lead", a: at(6, 6), b: at(8, 6) },
      { id: "a", a: at(8, 6), b: at(18, 6) },
      { id: "b", a: at(13, 6), b: at(13, 11) },
    ])
    const tSegments = doc.wires.filter((s) => s.a.x >= c(8) && s.b.x >= c(8))
    const selection = new Set(tSegments.map((s) => s.id))
    const landed = new SegmentDrag(doc, wiringFor(doc), stemOf(doc).id, undefined, { selection }).landed(c(3), c(2), newId)
    expect.soft(landed.refused, "nothing refused").toBeUndefined()
    const moved = landed.doc.wires.filter((s) => s.a.y === c(8) && s.b.y === c(8))
    expect.soft(moved.length > 0, "the bar is now two rows lower").toBe(true)
    const touchesPin = landed.doc.wires.some((s) => (s.a.x === c(6) && s.a.y === c(6)) || (s.b.x === c(6) && s.b.y === c(6)))
    expect.soft(touchesPin, "a wire still ends on R1's pin").toBe(true)
  })
})

describe("Alt-dragging a part onto a wire splices it in (the user, 2026-11-17: it was thrown back with «Nowhere clean to put it»)", () => {
  it("R1 with its own wires left behind, dropped with both pins on a straight wire, cuts the wire under its body and joins both pieces", async () => {
    const { PartDrag } = await import("@/schematic/rubber-band")
    const doc = docOf([resistor("R1", 2, 2)], [
      { id: "own", a: at(6, 3), b: at(9, 3) },
      { id: "line", a: at(10, 10), b: at(24, 10) },
    ])
    const landed = new PartDrag(doc, wiringFor(doc), { objects: new Set(["R1"]) }, { detach: true }).landed(c(12), c(7), newId)
    expect.soft(landed.refused, "nothing refused").toBeUndefined()
    const moved = landed.doc.objects.find((o) => o.id === "R1")!
    expect.soft([moved.x / GRID, moved.y / GRID], "R1 now at (14, 9)").toEqual([14, 9])
    expect.soft(cells(landed.doc), "the line cut under R1's body, the old wire left where it was").toEqual(cells(docOf([], [
      { id: "own", a: at(6, 3), b: at(9, 3) },
      { id: "l", a: at(10, 10), b: at(14, 10) },
      { id: "r", a: at(18, 10), b: at(24, 10) },
    ])))
  })
})
