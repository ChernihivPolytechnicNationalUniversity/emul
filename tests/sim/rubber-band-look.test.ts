import { describe, expect, it } from "vitest"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { examples } from "@/schematic/examples"
import { GRID, toPath, type Point } from "@/schematic/geometry"
import { PartDrag, SegmentDrag } from "@/schematic/rubber-band"
import type { PlacedObject, Schematic } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import { inNormalForm, wiringOf, type Wiring } from "@/schematic/wire-edits"
import type { DragFrame } from "@/schematic/wires/drag"
import { WireGraph } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { WireSheet } from "@/schematic/wires/sheet"
import { bandOf, bandRuns, type BandLook, type BandPiece } from "@/components/field/rubber-band-layer"
import { leadPatchPaths, turnedLeads, wireCasingPath, wireStrokePath, type WireRoute } from "@/components/field/wire-paths"
import { PinTurnLayer, WireLayer } from "@/components/field/WireLayer"
import { WireFlow } from "@/components/field/wire-flow"
import { random } from "../lib/wire-reference"

const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const by = (x: number, y: number) => [x * GRID, y * GRID] as const
const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
const ground = (id: string, x: number, y: number): PlacedObject => ({ id, def: "ground", x: x * GRID, y: y * GRID, props: { ref: id } })
let serial = 0
const wire = (a: Point, b: Point, color?: WireColorKey): WireSegment => ({ id: `doc${++serial}`, a, b, ...(color && { color }) })
const chain = (...pts: Point[]) => pts.slice(1).map((p, i) => wire(pts[i], p))
const piece = (a: Point, b: Point, color: WireColorKey = "red"): BandPiece => ({ a, b, color })
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic) => wiringOf(new WireGraph(), doc)
const lookOf = (wiring: Wiring): BandLook => ({ runOf: (segment) => wiring.runBySegment.get(segment), colorOfRun: () => "red", colorOfNet: () => "red", sheet: wiring.sheet })
const bends = (d: string) => (d.match(/Q/g) ?? []).length
const PX = 1

const strokes = (routes: readonly WireRoute[]) => routes.map((r) => wireStrokePath(r, GRID)).sort()
const casings = (routes: readonly WireRoute[]) => routes.map((r) => wireCasingPath(r, GRID)).sort()
const patches = (routes: readonly WireRoute[]) => routes.flatMap((r) => leadPatchPaths(r)).sort()
const fieldOf = (doc: Schematic) => wiringFor(doc).routes
const bandIn = (frame: DragFrame, wiring: Wiring) => bandOf(frame, lookOf(wiring)).wires

describe("the rubber band draws a wire mid-drag the way the field draws it after the drop: rounded bends, turns at pins, casings (the user, 2026-11-12: «при перемещении объектов провода на углах становятся квадратными»)", () => {
  it("a bend carried in the band is rounded with the field's own radius, the same path the field draws for that L", () => {
    const band = bandRuns([piece(at(5, 7), at(12, 7)), piece(at(12, 7), at(12, 4))], WireSheet.of([], []), new Set(), new Map())
    const field = fieldOf(docOf([], chain(at(5, 7), at(12, 7), at(12, 4))))
    expect.soft(strokes(band), "one path, the field's").toEqual(strokes(field))
    expect.soft(strokes(band).map(bends), "one rounded bend").toEqual([1])
    expect.soft(casings(band), "the casing bends with it").toEqual(casings(field))
  })

  it("the staircase in the user's picture keeps every bend rounded, not one square corner", () => {
    const pieces = [piece(at(1, 10), at(3, 10)), piece(at(3, 10), at(3, 9)), piece(at(3, 9), at(9, 9)), piece(at(9, 9), at(9, 8)), piece(at(9, 8), at(5, 8)), piece(at(5, 8), at(5, 4))]
    const band = bandRuns(pieces, WireSheet.of([], []), new Set(), new Map())
    expect.soft(band.length, "one run, not six pieces").toBe(1)
    expect.soft(strokes(band).map(bends), "five bends, five curves").toEqual([5])
    expect.soft(strokes(band), "the field's path for the same staircase").toEqual(strokes(fieldOf(docOf([], chain(at(1, 10), at(3, 10), at(3, 9), at(9, 9), at(9, 8), at(5, 8), at(5, 4))))))
  })

  it("pieces that run straight on are one line with no vertex in the path, as the field's normal form has it", () => {
    const band = bandRuns([piece(at(0, 0), at(3, 0)), piece(at(3, 0), at(6, 0))], WireSheet.of([], []), new Set(), new Map())
    expect.soft(strokes(band), "a single straight line").toEqual(strokes(fieldOf(docOf([], [wire(at(0, 0), at(6, 0))]))))
  })

  it("a corner that lands on another wire's end is a junction, not a bend: the band does not round through it", () => {
    const sheet = WireSheet.of([{ id: "stay", a: at(12, 7), b: at(16, 7) }], [])
    const band = bandRuns([piece(at(5, 7), at(12, 7)), piece(at(12, 7), at(12, 4))], sheet, new Set(), new Map())
    expect.soft(band.length, "two runs meeting at the junction").toBe(2)
    expect.soft(strokes(band).map(bends), "no curve at the junction").toEqual([0, 0])
  })

  it("a corner that lands on another wire's middle is a T, not a bend", () => {
    const sheet = WireSheet.of([{ id: "slant", a: at(8, 3), b: at(16, 11) }], [])
    const band = bandRuns([piece(at(5, 7), at(12, 7)), piece(at(12, 7), at(12, 3))], sheet, new Set(), new Map())
    expect.soft(band.length, "two runs meeting on the slant").toBe(2)
    expect.soft(strokes(band).map(bends), "no curve on the slant").toEqual([0, 0])
  })

  it("a piece lying on a wire the field still draws is not drawn again on top, so the field's own turn at the pin stays as it is", () => {
    const sheet = WireSheet.of([{ id: "stay", a: at(46, 8), b: at(46, 11) }], [])
    expect.soft(bandRuns([piece(at(46, 8), at(46, 11))], sheet, new Set(), new Map()), "nothing drawn twice").toEqual([])
    const longer = bandRuns([piece(at(46, 5), at(46, 11))], sheet, new Set(), new Map())
    expect.soft(longer.map((r) => r.pts), "only the part off the field").toEqual([[at(46, 5), at(46, 8)]])
  })

  it("in a blocked frame a piece along another wire stays drawn: that overlap is the conflict", () => {
    const sheet = WireSheet.of([{ id: "other", a: at(46, 8), b: at(46, 11) }], [])
    expect.soft(bandRuns([piece(at(46, 8), at(46, 11))], sheet, new Set(), new Map(), true).map((r) => r.pts), "kept").toEqual([[at(46, 8), at(46, 11)]])
  })

  it("a piece that passes over a pin is two wires at the pin, as the normal form splits it", () => {
    const sheet = WireSheet.of([], [{ key: "R1:1", at: at(45, 12) }])
    const band = bandRuns([piece(at(45, 11), at(45, 13))], sheet, new Set(), new Map())
    expect.soft(band.map((r) => r.pts), "split at the pin").toEqual([[at(45, 11), at(45, 12)], [at(45, 12), at(45, 13)]])
  })

  it("pieces that double back over each other are one wire, so the bend after them is still a bend and not a false junction", () => {
    const band = bandRuns([piece(at(41, 13), at(46, 13)), piece(at(46, 13), at(46, 18)), piece(at(46, 14), at(46, 13))], WireSheet.of([], []), new Set(), new Map())
    expect.soft(strokes(band), "the field's L").toEqual(strokes(fieldOf(docOf([], chain(at(41, 13), at(46, 13), at(46, 18))))))
  })

  it("two colours meeting at a corner are two wires, as on the field", () => {
    const band = bandRuns([piece(at(5, 7), at(12, 7), "red"), piece(at(12, 7), at(12, 4), "blue")], WireSheet.of([], []), new Set(), new Map())
    const field = fieldOf(docOf([], [wire(at(5, 7), at(12, 7), "red"), wire(at(12, 7), at(12, 4), "blue")]))
    expect.soft(strokes(band), "the field's two paths").toEqual(strokes(field))
  })

  it("a part dragged off a straight pin-to-pin wire: the Z in the band is the Z the field draws after the drop, both bends rounded (design.md §13.19 Q2)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 0)], [wire(at(4, 1), at(10, 1))])
    const wiring = wiringFor(doc)
    const drag = new PartDrag(doc, wiring, { objects: new Set(["R2"]) })
    const band = bandIn(drag.frame(...by(0, 2)), wiring)
    const field = fieldOf(drag.landed(...by(0, 2)).doc)
    expect.soft(strokes(band), "the dropped wire's path").toEqual(strokes(field))
    expect.soft(strokes(band).map(bends), "two rounded bends").toEqual([2])
    expect.soft(casings(band), "and its casing").toEqual(casings(field))
  })

  it("the user's picture: a wire that leaves a ground pin sideways keeps the turn at the pin rounded right at the pin, and every bend after it, while the resistor at its far end is dragged (design.md §13.3)", () => {
    const doc = docOf([ground("G", 0, 10), resistor("R1", 4, 0, 90)], chain(at(1, 10), at(3, 10), at(3, 9), at(9, 9), at(9, 8), at(5, 8), at(5, 4)))
    const wiring = wiringFor(doc)
    const still = fieldOf(doc)
    expect.soft(still.some((r) => r.leads), "the field turns at the ground pin").toBe(true)
    const drag = new PartDrag(doc, wiring, { objects: new Set(["R1"]) })
    const frame = drag.frame(...by(-2, -1))
    expect.soft(frame.blocked, "a clean offset").toBe(false)
    const band = bandIn(frame, wiring)
    const field = fieldOf(drag.landed(...by(-2, -1)).doc)
    expect.soft(band.some((r) => r.leads?.start || r.leads?.end), "the band turns at the pin as well").toBe(true)
    expect.soft(strokes(field), "every band path is one the field draws after the drop").toEqual(expect.arrayContaining(strokes(band)))
    expect.soft(patches(field), "the pin's own lead is hidden under the turn as on the field").toEqual(expect.arrayContaining(patches(band)))
    expect.soft(patches(band).length, "and there is a patch to hide it").toBeGreaterThan(0)
  })

  it("a dragged middle segment of a staircase: the band's path is the dropped wire's, every bend rounded", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 14, 6)], chain(at(4, 1), at(8, 1), at(8, 7), at(14, 7)))
    const wiring = wiringFor(doc)
    const middle = doc.wires.find((s) => s.a.x === s.b.x)!
    const drag = new SegmentDrag(doc, wiring, middle.id)
    const band = bandIn(drag.frame(...by(2, 0)), wiring)
    const field = fieldOf(drag.landed(...by(2, 0)).doc)
    expect.soft(band.length, "the band carries the wire").toBeGreaterThan(0)
    expect.soft(strokes(field), "every band path is one the field draws after the drop").toEqual(expect.arrayContaining(strokes(band)))
    expect.soft(strokes(band).reduce((n, d) => n + bends(d), 0), "two rounded bends").toBe(2)
  })

  it("a carried pin that lands with its wire turning at it gets the turn at the pin, from the pin's new place", () => {
    const doc = docOf([ground("G", 0, 10), resistor("R1", 4, 0, 90)], chain(at(1, 10), at(3, 10), at(3, 9), at(9, 9), at(9, 8), at(5, 8), at(5, 4)))
    const wiring = wiringFor(doc)
    const drag = new PartDrag(doc, wiring, { objects: new Set(["G"]) })
    const frame = drag.frame(...by(-1, 1))
    expect.soft(frame.blocked, "a clean offset").toBe(false)
    const band = bandIn(frame, wiring)
    const field = fieldOf(drag.landed(...by(-1, 1)).doc)
    expect.soft(band.some((r) => r.leads?.start || r.leads?.end), "the band turns at the carried pin").toBe(true)
    expect.soft(strokes(field), "every band path is one the field draws after the drop").toEqual(expect.arrayContaining(strokes(band)))
  })
})

describe("the field's own wire layer and the rubber band draw from one set of paths (so a drag cannot drift from the field again)", () => {
  const fieldHtml = (doc: Schematic) => {
    const w = wiringFor(doc)
    const html = renderToStaticMarkup(
      React.createElement(React.Fragment, null, React.createElement(PinTurnLayer, { corners: w.corners, scale: PX, grid: GRID }), React.createElement(WireLayer, {
        routes: w.routes,
        grid: GRID,
        scale: PX,
        selected: new Set<string>(),
        hoveredNet: null,
        colorOf: () => "black" as const,
        netOfWire: (id: string) => w.nets.netOfWire(id),
        dots: w.dots,
        dangling: w.dangling,
        corners: w.corners,
        flow: new WireFlow(),
        onWirePointerDown: () => {},
        onWirePointerEnter: () => {},
        onWirePointerLeave: () => {},
      })),
    )
    return { w, html }
  }
  const attrs = (html: string, test: RegExp, name: string) => [...html.matchAll(/<path [^>]*>/g)].map((m) => m[0]).filter((tag) => test.test(tag)).map((tag) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "")

  it("the field strokes, casings and pin-turn lead cuts of the user's ground wire are the shared paths", () => {
    const { w, html } = fieldHtml(docOf([ground("G", 0, 10), resistor("R1", 4, 0, 90)], chain(at(1, 10), at(3, 10), at(3, 9), at(9, 9), at(9, 8), at(5, 8), at(5, 4))))
    expect.soft(attrs(html, /data-base=/, "d").sort(), "strokes").toEqual(strokes(w.routes))
    expect.soft(attrs(html, /data-casing=/, "d").sort(), "casings").toEqual(casings(w.routes))
    const turning = w.routes.filter((r) => r.leads)
    expect.soft(turning.length, "the wire turns at the ground pin").toBe(1)
    expect.soft(turnedLeads(turning).map(({ from, to }) => toPath([from, to])).sort(), "the lead cut under the turn is the band's patch path").toEqual(patches(turning))
    expect.soft(attrs(html, /stroke="var\(--background\)"/, "d"), "the field paints no background patch: the part cuts its own lead").toEqual([])
  })
})

describe("on every example, a random drag's band is drawn as the field draws the drop (the user, 2026-11-12: so it never happens again)", () => {
  const SEEDS = Number(process.env.FUZZ_SEEDS ?? 3)
  const docs = examples.map((e) => ({ id: e.id, doc: inNormalForm(e.build(GRID)) }))

  it("every bend the band draws is rounded, and every band path is one the field draws after an unblocked drop at the same offset", () => {
    const found: string[] = []
    let compared = 0
    for (const { id, doc } of docs) {
      const parts = doc.objects.map((o) => o.id)
      if (!parts.length || !doc.wires.length) continue
      const wiring = wiringFor(doc)
      for (let seed = 1; seed <= SEEDS; seed++) {
        const rng = random(seed * 7919 + id.length * 131 + id.charCodeAt(0))
        const part = parts[rng.int(0, parts.length - 1)]
        const dx = rng.int(-4, 4) * GRID
        const dy = rng.int(-4, 4) * GRID
        const segment = doc.wires[rng.int(0, doc.wires.length - 1)]
        const off = rng.int(-3, 3) * GRID
        const drags: [string, { frame: (x: number, y: number) => DragFrame; landed: (x: number, y: number) => { doc: Schematic; at: Point; unlaid: readonly unknown[]; refused?: unknown } }, number, number][] = [
          [`${id} seed ${seed} part ${part} by (${dx / GRID},${dy / GRID})`, new PartDrag(doc, wiring, { objects: new Set([part]) }), dx, dy],
          [`${id} seed ${seed} segment ${segment.id} by ${off / GRID}`, new SegmentDrag(doc, wiring, segment.id), off, off],
        ]
        for (const [where, drag, x, y] of drags) {
          const frame = drag.frame(x, y)
          const band = bandIn(frame, wiring)
          for (const run of band) {
            const corners = run.pts.filter((p, i) => i > 0 && i < run.pts.length - 1 && (p.x - run.pts[i - 1].x) * (run.pts[i + 1].y - p.y) !== (p.y - run.pts[i - 1].y) * (run.pts[i + 1].x - p.x)).length
            const curves = bends(wireStrokePath(run, GRID)) - (run.leads?.start ? 1 : 0) - (run.leads?.end ? 1 : 0)
            if (curves !== corners) found.push(`${where}: ${corners} bends drawn with ${curves} curves`)
          }
          if (frame.blocked || !frame.pieces.length) continue
          const landed = drag.landed(x, y)
          const asked = drag instanceof SegmentDrag ? landed.at : { x, y }
          if (landed.refused || landed.unlaid.length || landed.at.x !== asked.x || landed.at.y !== asked.y || frame.reroutes.length || frame.joins.length) continue
          const field = new Set(strokes(fieldOf(landed.doc)))
          const missing = strokes(band).filter((d) => !field.has(d))
          compared++
          if (missing.length) found.push(`${where}: band path not on the field after the drop: ${missing[0].slice(0, 120)}`)
        }
      }
    }
    expect.soft(compared, "enough drops compared to mean something").toBeGreaterThan(20)
    expect(found, "drags whose band differs from the field").toEqual([])
  })
})
