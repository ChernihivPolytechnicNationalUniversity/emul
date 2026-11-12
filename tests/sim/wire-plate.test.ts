import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SelectionLayer } from "@/components/field/SelectionLayer"
import { WireLayer } from "@/components/field/WireLayer"
import { WireFlow } from "@/components/field/wire-flow"
import { paintField } from "@/components/field/field-paint"
import { SymbolRaster } from "@/components/field/symbol-raster"
import { plateOf, segmentShares, sharePath, type WirePlate } from "@/components/field/wire-plate"
import { casingTrim, wireCornerRadius } from "@/components/field/wire-style"
import type { Run } from "@/schematic/circuit"
import { examples } from "@/schematic/examples"
import { GRID, toPath, trimRouteEnds, type Point, type RoutedWire } from "@/schematic/geometry"
import { runPath, type Leads } from "@/schematic/wire-look"
import { wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import { arcLengthOf, flatten, pointAt, worstGapAlong, type Flat } from "../lib/drawn-path"

const RADIUS = wireCornerRadius(GRID)
const TRIM = casingTrim(GRID)
const ON_THE_PATH = 0.01
const c = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const lead = (pin: Point, outward: Point): Point => {
  const length = Math.hypot(outward.x, outward.y)
  return { x: pin.x - (outward.x / length) * 0.3 * GRID, y: pin.y - (outward.y / length) * 0.3 * GRID }
}

type Shape = { name: string; pts: Point[]; leads?: Leads }

const SHAPES: Shape[] = [
  { name: "an L, one 90° bend", pts: [c(0, 0), c(4, 0), c(4, 3)] },
  { name: "the user's wire: across, down two cells, across to C1's + pin", pts: [c(8, 7), c(12, 7), c(12, 10), c(14, 10)] },
  { name: "a Z", pts: [c(0, 0), c(2, 0), c(2, 2), c(5, 2)] },
  { name: "a U whose middle is shorter than two corner radii", pts: [c(0, 0), c(0, 2), c(0.5, 2), c(0.5, 0)] },
  { name: "a staircase of five bends", pts: [c(0, 0), c(1, 0), c(1, 1), c(2, 1), c(2, 2), c(3, 2), c(3, 3)] },
  { name: "45° bends", pts: [c(0, 0), c(2, 0), c(4, 2), c(4, 4)] },
  { name: "bends at an angle that is no multiple of 45°", pts: [c(0, 0), c(3, 1), c(3, 4), c(0, 5)] },
  { name: "a straight joint inside a run", pts: [c(0, 0), c(2, 0), c(4, 0), c(4, 2)] },
  { name: "a closed loop", pts: [c(0, 0), c(2, 0), c(2, 2), c(0, 2), c(0, 0)] },
  { name: "a wire turning right at a pin at its start", pts: [c(0, 0), c(0, -2), c(3, -2)], leads: { start: lead(c(0, 0), { x: 1, y: 0 }) } },
  { name: "a wire turning at pins at both ends", pts: [c(0, 0), c(0, 2), c(4, 2), c(4, 0)], leads: { start: lead(c(0, 0), { x: 1, y: 0 }), end: lead(c(4, 0), { x: -1, y: 0 }) } },
  { name: "a wire leaving a 45° pin sideways", pts: [c(0, 0), c(3, 0), c(3, 2)], leads: { start: lead(c(0, 0), { x: 1, y: 1 }) } },
  { name: "a pin turn on a half-cell first segment", pts: [c(0, 0), c(0, 0.5), c(3, 0.5)], leads: { start: lead(c(0, 0), { x: 1, y: 0 }) } },
]

const runOf = (pts: readonly Point[]): Run => ({ id: "s0", segments: pts.slice(1).map((b, i) => ({ id: `s${i}`, a: pts[i], b })), points: pts })
const routeOf = (shape: Shape): RoutedWire => ({ id: "s0", pts: shape.pts, owner: [], ...(shape.leads && { leads: shape.leads }) })

function boundaries(path: Flat, pts: readonly Point[]): number[] {
  return [0, ...pts.slice(1, -1).map((vertex) => arcLengthOf(path, vertex)), path.length]
}

function subsets(n: number): boolean[][] {
  const out: boolean[][] = []
  for (let mask = 1; mask < (1 << n) - 1; mask++) out.push(Array.from({ length: n }, (_, i) => !!(mask & (1 << i))))
  return out
}

function chains(picked: readonly boolean[]): [number, number][] {
  const out: [number, number][] = []
  picked.forEach((on, i) => {
    if (!on) return
    const open = out.at(-1)
    if (open && open[1] === i - 1) open[1] = i
    else out.push([i, i])
  })
  return out
}

function stretchFits(piece: string, path: Flat, from: number, to: number) {
  const part = flatten(piece)
  const start = pointAt(path, from)
  return {
    gap: worstGapAlong(part, path, from),
    length: part.length - (to - from),
    start: Math.hypot(part.points[0].x - start.x, part.points[0].y - start.y),
  }
}

describe("a selected wire's plate is its drawn path (design.md §13.26, the user's picture of 2026-11-12)", () => {
  for (const shape of SHAPES) {
    describe(shape.name, () => {
      const run = runOf(shape.pts)
      const route = routeOf(shape)
      const drawn = runPath(shape.pts, RADIUS, shape.leads)
      const trimmed = trimRouteEnds(shape.pts, TRIM)
      const casing = toPath(trimmed, RADIUS)
      const drawnFlat = flatten(drawn)
      const casingFlat = flatten(casing)
      const all = new Set(run.segments.map((s) => s.id))

      it("selected whole, the plate is the wire's own path string and its tint casing the wire's casing", () => {
        const plates = plateOf(run, route, all, RADIUS, TRIM)
        expect.soft(plates.map((p) => ({ d: p.d, casing: p.casing, whole: p.whole, start: p.start, end: p.end })), "one plate: the drawn path, end to end").toEqual([{ d: drawn, casing, whole: true, start: true, end: true }])
      })

      it("cut into one share per segment at the middle of every bend, the shares put together are the drawn path, start to end", () => {
        const shares = segmentShares(drawn, shape.pts)
        expect.soft(shares?.length, "one share per segment").toBe(run.segments.length)
        if (!shares) return
        const joined = stretchFits(sharePath(shares), drawnFlat, 0, drawnFlat.length)
        expect.soft(joined.gap, "the joined shares never leave the drawn path").toBeLessThan(ON_THE_PATH)
        expect.soft(joined.length, "and are exactly as long").toBeNear(0, ON_THE_PATH)
        const cuts = boundaries(drawnFlat, shape.pts)
        let at = 0
        shares.forEach((share, i) => {
          const fit = stretchFits(sharePath([share]), drawnFlat, at, cuts[i + 1])
          expect.soft(fit.gap, `share ${i} follows the drawn path`).toBeLessThan(ON_THE_PATH)
          expect.soft(fit.length, `share ${i} ends where the bend after it is halfway round`).toBeNear(0, ON_THE_PATH)
          at += flatten(sharePath([share])).length
        })
      })

      it("selected in part, every piece of plate is the drawn path between the middles of the bends that bound it, never a straight line to a corner and never past an unselected segment", () => {
        const plateCuts = boundaries(drawnFlat, shape.pts)
        const casingCuts = boundaries(casingFlat, trimmed)
        const last = run.segments.length - 1
        for (const picked of subsets(run.segments.length)) {
          const selected = new Set(run.segments.filter((_, i) => picked[i]).map((s) => s.id))
          const plates = plateOf(run, route, selected, RADIUS, TRIM)
          const want = chains(picked)
          const label = picked.map((on) => (on ? "■" : "□")).join("")
          expect.soft(plates.map((p) => [p.key, p.whole, p.start, p.end]), `${label}: one plate per run of selected segments`).toEqual(want.map(([first, end]) => [`s${first}`, false, first === 0, end === last]))
          plates.forEach((plate: WirePlate, k) => {
            const [first, end] = want[k] ?? [0, 0]
            const band = stretchFits(plate.d, drawnFlat, plateCuts[first], plateCuts[end + 1])
            expect.soft(band.gap, `${label} plate ${k}: on the drawn path all along`).toBeLessThan(ON_THE_PATH)
            expect.soft(band.start, `${label} plate ${k}: starts where its first segment's share starts`).toBeLessThan(ON_THE_PATH)
            expect.soft(band.length, `${label} plate ${k}: as long as its segments' shares, so no gap and no overshoot`).toBeNear(0, ON_THE_PATH)
            const tint = stretchFits(plate.casing, casingFlat, casingCuts[first], casingCuts[end + 1])
            expect.soft(tint.gap, `${label} plate ${k}: its tint casing is on the casing path`).toBeLessThan(ON_THE_PATH)
            expect.soft(tint.length, `${label} plate ${k}: and covers its share of it exactly`).toBeNear(0, ON_THE_PATH)
          })
        }
      })
    })
  }

  it("at a bend the plate passes where the wire does, not through the corner point the segments meet at", () => {
    const shape = SHAPES[1]
    const run = runOf(shape.pts)
    const selected = new Set(["s0", "s1"])
    const [plate] = plateOf(run, routeOf(shape), selected, RADIUS, TRIM)
    const flat = flatten(plate.d)
    const corner = shape.pts[1]
    const nearest = Math.min(...flat.points.map((p) => Math.hypot(p.x - corner.x, p.y - corner.y)))
    const drawnNearest = Math.min(...flatten(runPath(shape.pts, RADIUS)).points.map((p) => Math.hypot(p.x - corner.x, p.y - corner.y)))
    expect.soft(nearest, "the plate keeps the wire's distance from the corner point").toBeNear(drawnNearest, ON_THE_PATH)
    expect.soft(nearest, "which is a rounded bend's, not zero").toBeGreaterThan(RADIUS / 4)
  })
})

describe("every run of every example can be plated in part (no wire falls back to a whole plate)", () => {
  it("each run's drawn path and casing cut into exactly one share per segment, and a plate on its first segment alone stays on the drawn path", () => {
    const failures: string[] = []
    let runs = 0
    for (const example of examples) {
      const doc = example.build(GRID)
      const wiring = wiringOf(new WireGraph(), doc)
      const routes = new Map(wiring.routes.map((r) => [r.id, r]))
      for (const run of wiring.runs) {
        const route = routes.get(run.id)!
        runs++
        const drawn = runPath(route.pts, RADIUS, route.leads)
        const trimmed = trimRouteEnds(route.pts, TRIM)
        const where = `${example.id} ${run.id}`
        if (segmentShares(drawn, route.pts)?.length !== run.segments.length) failures.push(`${where}: drawn path not cut per segment`)
        if (segmentShares(toPath(trimmed, RADIUS), trimmed)?.length !== run.segments.length) failures.push(`${where}: casing not cut per segment`)
        if (run.segments.length < 2) continue
        const [plate] = plateOf(run, route, new Set([run.segments[0].id]), RADIUS, TRIM)
        const path = flatten(drawn)
        const fit = stretchFits(plate.d, path, 0, arcLengthOf(path, route.pts[1]))
        if (plate.whole || fit.gap > ON_THE_PATH || Math.abs(fit.length) > ON_THE_PATH) failures.push(`${where}: first segment's plate ${JSON.stringify(fit)}`)
      }
    }
    expect.soft(runs, "the examples have wires to check").toBeGreaterThan(100)
    expect.soft(failures, "no run whose plate cannot follow its path").toEqual([])
  })
})

type Stroke = { d: string; style: unknown; width: unknown; cap: unknown }

function recorder() {
  const strokes: Stroke[] = []
  const state: Record<string | symbol, unknown> = { lineWidth: 1 }
  let current: string[] = []
  const context = new Proxy(state, {
    get(target, key) {
      if (key === "stroke") return (path?: { d: string }) => strokes.push({ d: path ? path.d : current.join(" "), style: target.strokeStyle, width: target.lineWidth, cap: target.lineCap })
      if (key === "beginPath") return () => { current = [] }
      if (key === "moveTo") return (x: number, y: number) => current.push(`M${x} ${y}`)
      if (key === "lineTo") return (x: number, y: number) => current.push(`L${x} ${y}`)
      if (key in target) return target[key]
      return () => {}
    },
    set(target, key, value) {
      target[key] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { context, strokes }
}

describe("the canvas band paints the same plate as the SVG", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "Path2D",
      class {
        d: string
        constructor(d = "") {
          this.d = d
        }
      },
    )
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (key: string) => key.slice(2), fontFamily: "sans-serif" }))
  })
  afterEach(() => vi.unstubAllGlobals())

  const shape = SHAPES[9]
  const run = runOf(shape.pts)
  const route = routeOf(shape)
  const paint = (plates: readonly WirePlate[]) => {
    const recording = recorder()
    const raster = new SymbolRaster()
    vi.spyOn(raster, "get").mockReturnValue(null)
    paintField(recording.context, {} as Element, { objects: [], routes: [route], view: { x: -500, y: -500, w: 1000, h: 1000 }, grid: GRID, pixels: 1, device: 1, theme: "test", colorOf: () => "black", raster, selection: { objects: new Set(), wires: new Set([run.id]), plates }, marks: { dots: [], open: [], corners: [] } })
    return recording.strokes
  }

  it("a whole wire: both bands are its drawn path, round-capped, its casing is tinted, and so is the patch over the lead it turns on", () => {
    const plates = plateOf(run, route, new Set(run.segments.map((s) => s.id)), RADIUS, TRIM)
    const strokes = paint(plates)
    const bands = strokes.filter((s) => s.style === "selection-tint" || s.style === "selection-tint-feather").filter((s) => s.d === plates[0].d)
    expect.soft(bands.map((s) => [s.style, s.cap]), "feather then core, along the drawn path").toEqual([["selection-tint-feather", "round"], ["selection-tint", "round"]])
    expect.soft(strokes.filter((s) => s.d === toPath(trimRouteEnds(shape.pts, TRIM), RADIUS)).map((s) => s.style), "the casing in the plate's tint, not the background").toEqual(["selection-tint"])
    const patch = strokes.find((s) => s.d.startsWith(`M${shape.leads!.start!.x} ${shape.leads!.start!.y} L`))
    expect.soft(patch?.style, "the patch hiding the lead under the turn is tinted too, so no white square cuts the plate").toBe("selection-tint")
  })

  it("part of a wire: the bands are the selected stretch of the drawn path, butt-capped, and only that stretch of casing is tinted", () => {
    const plates = plateOf(run, route, new Set(["s1"]), RADIUS, TRIM)
    const strokes = paint(plates)
    expect.soft(strokes.filter((s) => s.d === plates[0].d).map((s) => [s.style, s.cap]), "feather then core, the stretch alone").toEqual([["selection-tint-feather", "butt"], ["selection-tint", "butt"]])
    expect.soft(strokes.filter((s) => s.d === toPath(trimRouteEnds(shape.pts, TRIM), RADIUS)).map((s) => s.style), "the whole casing stays the background").toEqual(["background"])
    expect.soft(strokes.filter((s) => s.d === plates[0].casing).map((s) => s.style), "the selected stretch's casing is tinted").toEqual(["selection-tint"])
    const patch = strokes.find((s) => s.d.startsWith(`M${shape.leads!.start!.x} ${shape.leads!.start!.y} L`))
    expect.soft(patch?.style, "the lead patch of an end with no plate stays the background").toBe("background")
  })
})

describe("the SVG layers draw the same plate and tint as the canvas", () => {
  const shape = SHAPES[9]
  const run = runOf(shape.pts)
  const route = routeOf(shape)
  const render = (plates: readonly WirePlate[]) => {
    const html = renderToStaticMarkup(
      React.createElement(React.Fragment, null,
        React.createElement(SelectionLayer, { objects: [], wires: plates, selectedObjects: new Set<string>(), grid: GRID }),
        React.createElement(WireLayer, {
          routes: [route],
          grid: GRID,
          scale: 1,
          selected: new Set([run.id]),
          plates,
          hoveredNet: null,
          colorOf: () => "black" as const,
          netOfWire: () => "net",
          dots: [],
          dangling: [],
          corners: [],
          flow: new WireFlow(),
          onWirePointerDown: () => {},
          onWirePointerEnter: () => {},
          onWirePointerLeave: () => {},
        }),
      ),
    )
    const svg = new Markup(html)
    return {
      bands: svg.paths("data-slot=\"selection\"").map((p) => [p.attr("d"), p.attr("stroke-linecap"), p.has("data-whole")]),
      casings: svg.paths("data-slot=\"wires\"").filter((p) => p.has("data-casing")).map((p) => [p.attr("d"), p.attr("stroke")]),
      patch: svg.paths("data-slot=\"pin-turns\"").find((p) => !p.has("data-corner"))?.attr("stroke"),
    }
  }

  it("a whole wire: two bands along its drawn path, round-capped, a tinted casing and a tinted patch over the lead it turns on", () => {
    const plates = plateOf(run, route, new Set(run.segments.map((s) => s.id)), RADIUS, TRIM)
    const drawn = render(plates)
    expect.soft(drawn.bands, "feather and core, the drawn path, whole").toEqual([[plates[0].d, "round", true], [plates[0].d, "round", true]])
    expect.soft(drawn.casings, "one casing, the plate's tint").toEqual([[toPath(trimRouteEnds(shape.pts, TRIM), RADIUS), "var(--selection-tint)"]])
    expect.soft(drawn.patch, "no white patch inside the plate where the wire turns at the pin").toBe("var(--selection-tint)")
  })

  it("part of a wire: two bands along the selected stretch, butt-capped, the casing the background with the stretch tinted over it, the lead patch of the unplated end the background", () => {
    const plates = plateOf(run, route, new Set(["s1"]), RADIUS, TRIM)
    const drawn = render(plates)
    expect.soft(drawn.bands, "feather and core, the stretch alone").toEqual([[plates[0].d, "butt", false], [plates[0].d, "butt", false]])
    expect.soft(drawn.casings, "the run's casing, then its selected stretch in the plate's tint").toEqual([[toPath(trimRouteEnds(shape.pts, TRIM), RADIUS), "var(--background)"], [plates[0].casing, "var(--selection-tint)"]])
    expect.soft(drawn.patch, "the patch at the end the plate does not reach").toBe("var(--background)")
  })
})

class Markup {
  private readonly html: string
  constructor(html: string) {
    this.html = html
  }

  paths(slot: string) {
    const start = this.html.indexOf(slot)
    if (start < 0) return []
    const end = this.html.indexOf("</svg>", start)
    return [...this.html.slice(start, end).matchAll(/<path\b([^>]*)>/g)].map(([, attributes]) => ({
      attr: (name: string) => attributes.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1],
      has: (name: string) => new RegExp(`\\s${name}(=|\\s|$)`).test(attributes),
    }))
  }
}

