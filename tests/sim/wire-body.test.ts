import { describe, expect, it } from "vitest"
import { checked } from "@/schematic/checker"
import { GRID, type Point } from "@/schematic/geometry"
import { freeSpot } from "@/schematic/placement"
import { PartDrag, SegmentDrag } from "@/schematic/rubber-band"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { pasteLanding } from "@/schematic/use-schematic"
import { drawEndAt, drawnTo, isRefusal, laysClear, pointerAt, previewOf, startDrawing } from "@/schematic/wire-draw"
import { inNormalForm, wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const resistor = (id: string, x: number, y: number): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id } })
let serial = 0
const seg = (a: Point, b: Point): WireSegment => ({ id: `s${++serial}`, a, b })
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic) => wiringOf(new WireGraph(), doc)
const sceneOf = (doc: Schematic) => ({ objects: doc.objects, routes: wiringFor(doc).routes, grid: GRID })
const throughBodies = (doc: Schematic) => checked(doc).filter((f) => f.kind === "wire-through-body").map((f) => f.text)
const ids = () => `n${++serial}`

describe("a wire never runs through a part's body (the user, 2026-11-11: «мы можем на компоненты наслаивать провода, вроде мы так не договаривались»; ГОСТ 2.701: lines do not pass through symbols)", () => {
  it("set up: none of the starting documents has a wire through a body", () => {
    expect(throughBodies(docOf([resistor("R2", 8, 0)], [seg(at(10, -3), at(10, -1))]))).toEqual([])
  })

  it("drawing across a resistor's body from bare field is refused, and nothing is laid", () => {
    const doc = docOf([resistor("R2", 8, 0)])
    const wiring = wiringFor(doc)
    const started = startDrawing(wiring, drawEndAt(wiring, at(10, -3)))
    if (isRefusal(started)) throw new Error(started.refused)
    const d = pointerAt(started, at(10, 4))
    expect.soft(previewOf(doc, wiring, d).refused?.refused, "the preview says why").toBe("body")
    expect.soft(isRefusal(drawnTo(doc, wiring, d, drawEndAt(wiring, at(10, 4)), ids)), "the click lays nothing").toBe(true)
  })

  it("drawing right up to the body, or past it, is allowed", () => {
    const doc = docOf([resistor("R2", 8, 0)])
    const wiring = wiringFor(doc)
    const started = startDrawing(wiring, drawEndAt(wiring, at(10, -3)))
    if (isRefusal(started)) throw new Error(started.refused)
    expect.soft(previewOf(doc, wiring, pointerAt(started, at(10, 0))).refused, "down to the cell above the body").toBeNull()
    expect.soft(previewOf(doc, wiring, pointerAt(started, at(14, -3))).refused, "alongside, clear of it").toBeNull()
  })

  it("a part added onto a wire that would cross its body lands where none does", () => {
    const doc = docOf([], [seg(at(10, -3), at(10, 4))])
    const r = resistor("R2", 8, 0)
    const spot = freeSpot(sceneOf(doc), [r])
    expect.soft(spot.x !== 0 || spot.y !== 0, "moved off the wire").toBe(true)
    expect.soft(throughBodies(docOf([{ ...r, x: r.x + spot.x, y: r.y + spot.y }], doc.wires)), "no wire through it").toEqual([])
  })

  it("a two-pin part dropped with both pins on one straight wire still goes in series there: the stretch under it is cut (design.md §5.3)", () => {
    const doc = docOf([], [seg(at(5, 1), at(15, 1))])
    expect(freeSpot(sceneOf(doc), [resistor("R2", 8, 0)])).toEqual({ x: 0, y: 0 })
  })

  it("a part whose one pin would land on a wire that then runs on into its body is moved", () => {
    const doc = docOf([], [seg(at(8, -3), at(8, 1)), seg(at(8, 1), at(11, 1))])
    expect.soft(throughBodies(docOf([resistor("R9", 20, 20)], doc.wires)), "set up").toEqual([])
    const spot = freeSpot(sceneOf(doc), [resistor("R2", 8, 0)])
    expect.soft(spot.x !== 0 || spot.y !== 0, "the wire from its left pin would run under its body").toBe(true)
  })

  it("a part dragged so that its body would cover a wire lands where it does not", () => {
    const doc = docOf([resistor("R2", 8, 0), resistor("R9", 30, 30)], [seg(at(14, -3), at(14, 4))])
    const landed = new PartDrag(doc, wiringFor(doc), { objects: new Set(["R2"]) }).landed(c(4), 0, ids)
    expect.soft(landed.at.x === c(4) && landed.at.y === 0, "not where the wire is").toBe(false)
    expect.soft(throughBodies(landed.doc), "no wire through a body").toEqual([])
  })

  it("a part dragged so that a wire it pulls would cross another part's body lands, or is laid, where none does", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R3", 12, 0), resistor("R2", 6, 3)], [seg(at(4, 1), at(12, 1))])
    expect.soft(throughBodies(doc), "set up").toEqual([])
    for (const [dx, dy] of [[0, 3], [0, 4], [1, 3], [-1, 3]]) {
      const landed = new PartDrag(doc, wiringFor(doc), { objects: new Set(["R1"]) }).landed(c(dx), c(dy), ids)
      expect.soft(throughBodies(landed.doc), `R1 dragged by (${dx}, ${dy})`).toEqual([])
    }
  })

  it("a wire's segment dragged across a part's body lands where it does not", () => {
    const doc = docOf([resistor("R2", 5, 2)], [seg(at(0, 6), at(14, 6))])
    const segment = doc.wires[0].id
    const landed = new SegmentDrag(doc, wiringFor(doc), segment).landed(0, c(-3), ids)
    expect.soft(throughBodies(landed.doc), "no wire through R2").toEqual([])
  })

  it("a pasted wire lands where it crosses no part's body", () => {
    const doc = docOf([resistor("R2", 8, 0)])
    const clip = { objects: [], wires: [seg(at(10, -3), at(10, 4))], parts: {} }
    const wiring = wiringFor(doc)
    const shifted = (p: Point) => clip.wires.map((s) => ({ a: { x: s.a.x + p.x, y: s.a.y + p.y }, b: { x: s.b.x + p.x, y: s.b.y + p.y } }))
    const landing = pasteLanding(sceneOf(doc), clip, { x: 0, y: 0 }, (_, p) => laysClear(wiring, shifted(p), doc))
    const placed = docOf(doc.objects, shifted(landing.at).map((s) => seg(s.a, s.b)))
    expect(throughBodies(placed)).toEqual([])
  })
})
