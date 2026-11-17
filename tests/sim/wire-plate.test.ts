import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SelectionLayer } from "@/components/field/SelectionLayer"
import { WireLayer } from "@/components/field/WireLayer"
import { WireFlow } from "@/components/field/wire-flow"
import { paintField } from "@/components/field/field-paint"
import { SymbolRaster } from "@/components/field/symbol-raster"
import { notchPath, PLATE_REACH, plateOf, segmentShares, sharePath, type WirePlate } from "@/components/field/wire-plate"
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
      const drawnFlat = flatten(drawn)
      const all = new Set(run.segments.map((s) => s.id))
      const first = shape.pts[0]
      const last = shape.pts[shape.pts.length - 1]

      it("selected whole, the plate is the wire's own path string, with no round end where the wire meets anything", () => {
        const plates = plateOf(run, route, all, RADIUS)
        expect.soft(plates.map((p) => ({ d: p.d, whole: p.whole, caps: p.caps })), "one plate: the drawn path, end to end, flush at both ends").toEqual([{ d: drawn, whole: true, caps: [] }])
      })

      it("selected whole with both ends open, the plate is rounded only at the ends that are open and do not turn at a pin", () => {
        const plates = plateOf(run, route, all, RADIUS, () => true)
        const want = [...(shape.leads?.start ? [] : [first]), ...(shape.leads?.end ? [] : [last])]
        expect.soft(plates.map((p) => p.caps), "a round end at each open end").toEqual([want])
        const isFirst = (p: Point) => p.x === first.x && p.y === first.y
        const one = plateOf(run, route, all, RADIUS, isFirst)
        expect.soft(one.map((p) => p.caps), "only the end that is open").toEqual([[...(shape.leads?.start ? [] : [first]), ...(!shape.leads?.end && isFirst(last) ? [last] : [])]])
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
        const final = run.segments.length - 1
        for (const picked of subsets(run.segments.length)) {
          const selected = new Set(run.segments.filter((_, i) => picked[i]).map((s) => s.id))
          const plates = plateOf(run, route, selected, RADIUS, () => true)
          const want = chains(picked)
          const label = picked.map((on) => (on ? "■" : "□")).join("")
          const capsOf = (from: number, to: number) => [...(from === 0 && !shape.leads?.start ? [first] : []), ...(to === final && !shape.leads?.end ? [last] : [])]
          expect.soft(plates.map((p) => [p.key, p.whole, p.caps]), `${label}: one plate per run of selected segments, round only at the wire's own open ends`).toEqual(want.map(([from, to]) => [`s${from}`, false, capsOf(from, to)]))
          plates.forEach((plate: WirePlate, k) => {
            const [from, to] = want[k] ?? [0, 0]
            const band = stretchFits(plate.d, drawnFlat, plateCuts[from], plateCuts[to + 1])
            expect.soft(band.gap, `${label} plate ${k}: on the drawn path all along`).toBeLessThan(ON_THE_PATH)
            expect.soft(band.start, `${label} plate ${k}: starts where its first segment's share starts`).toBeLessThan(ON_THE_PATH)
            expect.soft(band.length, `${label} plate ${k}: as long as its segments' shares, so no gap and no overshoot`).toBeNear(0, ON_THE_PATH)
          })
        }
      })
    })
  }

  it("at a bend the plate passes where the wire does, not through the corner point the segments meet at", () => {
    const shape = SHAPES[1]
    const run = runOf(shape.pts)
    const selected = new Set(["s0", "s1"])
    const [plate] = plateOf(run, routeOf(shape), selected, RADIUS)
    const flat = flatten(plate.d)
    const corner = shape.pts[1]
    const nearest = Math.min(...flat.points.map((p) => Math.hypot(p.x - corner.x, p.y - corner.y)))
    const drawnNearest = Math.min(...flatten(runPath(shape.pts, RADIUS)).points.map((p) => Math.hypot(p.x - corner.x, p.y - corner.y)))
    expect.soft(nearest, "the plate keeps the wire's distance from the corner point").toBeNear(drawnNearest, ON_THE_PATH)
    expect.soft(nearest, "which is a rounded bend's, not zero").toBeGreaterThan(RADIUS / 4)
  })
})

describe("every run of every example can be plated in part (no wire falls back to a whole plate)", () => {
  it("each run's drawn path cuts into exactly one share per segment, and a plate on its first segment alone stays on the drawn path", () => {
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
        const where = `${example.id} ${run.id}`
        if (segmentShares(drawn, route.pts)?.length !== run.segments.length) failures.push(`${where}: drawn path not cut per segment`)
        if (run.segments.length < 2) continue
        const [plate] = plateOf(run, route, new Set([run.segments[0].id]), RADIUS)
        const path = flatten(drawn)
        const fit = stretchFits(plate.d, path, 0, arcLengthOf(path, route.pts[1]))
        if (plate.whole || fit.gap > ON_THE_PATH || Math.abs(fit.length) > ON_THE_PATH) failures.push(`${where}: first segment's plate ${JSON.stringify(fit)}`)
      }
    }
    expect.soft(runs, "the examples have wires to check").toBeGreaterThan(100)
    expect.soft(failures, "no run whose plate cannot follow its path").toEqual([])
  })
})

type Stroke = { d: string; style: unknown; width: unknown; cap: unknown; op: unknown }

function recorder() {
  const strokes: Stroke[] = []
  const state: Record<string | symbol, unknown> = { lineWidth: 1, globalCompositeOperation: "source-over" }
  const saved: Record<string | symbol, unknown>[] = []
  let current: string[] = []
  const context = new Proxy(state, {
    get(target, key) {
      if (key === "stroke") return (path?: { d: string }) => strokes.push({ d: path ? path.d : current.join(" "), style: target.strokeStyle, width: target.lineWidth, cap: target.lineCap, op: target.globalCompositeOperation })
      if (key === "beginPath") return () => { current = [] }
      if (key === "moveTo") return (x: number, y: number) => current.push(`M${x} ${y}`)
      if (key === "lineTo") return (x: number, y: number) => current.push(`L${x} ${y}`)
      if (key === "save") return () => saved.push({ ...target })
      if (key === "restore") return () => {
        const prior = saved.pop()
        if (!prior) return
        for (const name of Reflect.ownKeys(target)) delete target[name]
        Object.assign(target, prior)
      }
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

describe("the canvas band paints the same plate as the SVG, and its crossing gaps only cut", () => {
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
  const casing = toPath(trimRouteEnds(shape.pts, TRIM), RADIUS)
  const painted = (stroke: Stroke) => stroke.op !== "destination-out"
  const patchOf = (strokes: readonly Stroke[]) => strokes.find((s) => s.d.startsWith(`M${shape.leads!.start!.x} ${shape.leads!.start!.y} L`))

  it("a whole wire: both bands are its drawn path, flush at its ends; its casing and the patch over the lead it turns on only cut, nothing is painted in the background or a tint over the plate", () => {
    const plates = plateOf(run, route, new Set(run.segments.map((s) => s.id)), RADIUS)
    const strokes = paint(plates)
    const bands = strokes.filter((s) => s.style === "selection" || s.style === "selection-feather").filter((s) => s.d === plates[0].d)
    expect.soft(bands.map((s) => [s.style, s.cap]), "feather then core, along the drawn path, butt-ended").toEqual([["selection-feather", "butt"], ["selection", "butt"]])
    expect.soft(strokes.filter((s) => s.d === casing).map((s) => s.op), "the casing is a cut, never a paint").toEqual(["destination-out"])
    expect.soft(patchOf(strokes)?.op, "the lead under the turn is cut out of the symbols, not painted over").toBe("destination-out")
    expect.soft(strokes.filter((s) => painted(s) && (s.style === "background" || String(s.style).startsWith("selection-tint"))).length, "no stroke paints the background or a plate-imitating tint").toBe(0)
  })

  it("part of a wire: the bands are the selected stretch of the drawn path, butt-capped, and the casing still only cuts", () => {
    const plates = plateOf(run, route, new Set(["s1"]), RADIUS)
    const strokes = paint(plates)
    expect.soft(strokes.filter((s) => s.d === plates[0].d).map((s) => [s.style, s.cap]), "feather then core, the stretch alone").toEqual([["selection-feather", "butt"], ["selection", "butt"]])
    expect.soft(strokes.filter((s) => s.d === casing).map((s) => s.op), "the whole casing is a cut").toEqual(["destination-out"])
    expect.soft(patchOf(strokes)?.op, "the lead patch is a cut").toBe("destination-out")
    expect.soft(strokes.filter((s) => painted(s) && (s.style === "background" || String(s.style).startsWith("selection-tint"))).length, "nothing painted in the background").toBe(0)
  })

  it("wire bodies are painted, not cut, and with the wire's width", () => {
    const strokes = paint(plateOf(run, route, new Set(run.segments.map((s) => s.id)), RADIUS))
    const body = strokes.filter((s) => s.d === runPath(shape.pts, RADIUS, shape.leads) && painted(s) && s.style !== "selection" && s.style !== "selection-feather")
    expect.soft(body.length, "the wire's body, then its turn redrawn over the cut lead").toBeGreaterThanOrEqual(1)
  })
})

describe("the SVG layers draw the same plate as the canvas, and the crossing gap is a mask", () => {
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
    const wires = html.slice(html.indexOf('data-slot="wires"'))
    return {
      bands: svg.paths("data-slot=\"selection\"").filter((p) => !p.has("data-cap")).map((p) => [p.attr("d"), p.attr("stroke-linecap"), p.has("data-whole")]),
      caps: svg.paths("data-slot=\"selection\"").filter((p) => p.has("data-cap")).map((p) => [p.attr("d"), p.attr("stroke-linecap")]),
      casings: svg.paths("data-slot=\"wires\"").filter((p) => p.has("data-casing")).map((p) => [p.attr("d"), p.attr("stroke")]),
      casingsInDefs: [...wires.slice(0, wires.indexOf("</defs>")).matchAll(/data-casing/g)].length,
      painted: svg.paths("data-slot=\"wires\"").map((p) => p.attr("stroke")).filter((stroke) => stroke === "var(--background)" || stroke?.startsWith("var(--selection")),
    }
  }

  it("a whole wire meeting things at both ends: two bands along its drawn path, flush at both ends, no round end; its casing is mask geometry, nothing painted", () => {
    const plates = plateOf(run, route, new Set(run.segments.map((s) => s.id)), RADIUS)
    const drawn = render(plates)
    expect.soft(drawn.bands, "feather and core, the drawn path, whole, butt").toEqual([[plates[0].d, "butt", true], [plates[0].d, "butt", true]])
    expect.soft(drawn.caps, "no round end where the wire meets a pin or another wire").toEqual([])
    expect.soft(drawn.casings, "one casing, black: it is drawn into a mask").toEqual([[toPath(trimRouteEnds(shape.pts, TRIM), RADIUS), "black"]])
    expect.soft(drawn.casingsInDefs, "and it lives in the defs, so it paints nothing").toBe(1)
    expect.soft(drawn.painted, "no stroke in the background or a tint").toEqual([])
  })

  it("a whole wire with an open end: a round end there only, as a zero-length round-capped stroke on the end point", () => {
    const end = shape.pts[shape.pts.length - 1]
    const plates = plateOf(run, route, new Set(run.segments.map((s) => s.id)), RADIUS, (p) => p.x === end.x && p.y === end.y)
    const drawn = render(plates)
    expect.soft(drawn.bands.map(([, cap]) => cap), "the bands stay butt").toEqual(["butt", "butt"])
    expect.soft(drawn.caps, "one round end per band, on the open end").toEqual([[`M${end.x} ${end.y}l0 0`, "round"], [`M${end.x} ${end.y}l0 0`, "round"]])
  })

  it("part of a wire: two bands along the selected stretch, butt-capped, and the casing is still only mask geometry", () => {
    const plates = plateOf(run, route, new Set(["s1"]), RADIUS)
    const drawn = render(plates)
    expect.soft(drawn.bands, "feather and core, the stretch alone").toEqual([[plates[0].d, "butt", false], [plates[0].d, "butt", false]])
    expect.soft(drawn.casings, "the run's casing, black, in the defs").toEqual([[toPath(trimRouteEnds(shape.pts, TRIM), RADIUS), "black"]])
    expect.soft(drawn.painted, "nothing painted in the background").toEqual([])
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


describe("a selected slanted wire's plate ends flush on the conductor it meets (the user, 2026-11-16: the band of a 45° wire sticks out past its end onto the wire it lands on)", () => {
  const pts = [c(8, 12), c(12, 8)]
  const run = runOf(pts)
  const route: RoutedWire = { id: "s0", pts, owner: [] }
  const all = new Set(run.segments.map((s) => s.id))
  const inside = (polygon: readonly Point[], p: Point) => {
    let result = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i]
      const b = polygon[j]
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) result = !result
    }
    return result
  }
  const keeps = (d: string, p: Point) => {
    const squares = [...d.matchAll(/M(-?[\d.e+]+) (-?[\d.e+]+) H(-?[\d.e+]+) V(-?[\d.e+]+) H(-?[\d.e+]+) Z/g)].map((m) => {
      const [x0, y0, x1, y1] = m.slice(1, 5).map(Number)
      return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
    })
    return squares.filter((square) => inside(square, p)).length % 2 === 1
  }

  it("meeting things at both ends, both ends are notched along the axes through the end point; open, an end is rounded and not notched", () => {
    const [closed] = plateOf(run, route, all, RADIUS)
    expect.soft(closed.notches, "a notch at each end, facing out of the wire").toEqual([{ at: pts[0], out: { x: -1, y: 1 } }, { at: pts[1], out: { x: 1, y: -1 } }])
    expect.soft(closed.caps, "no round end").toEqual([])
    const [open] = plateOf(run, route, all, RADIUS, (p) => p.x === pts[1].x && p.y === pts[1].y)
    expect.soft(open.notches.map((n) => n.at), "the open end is not notched").toEqual([pts[0]])
    expect.soft(open.caps, "it is rounded").toEqual([pts[1]])
  })

  it("the notch clips away every band pixel past the horizontal and the vertical line through the end, and none behind it", () => {
    const [plate] = plateOf(run, route, all, RADIUS)
    const d = notchPath(plate.notches, PLATE_REACH, { x: -1e4, y: -1e4, w: 2e4, h: 2e4 })
    const end = pts[0]
    const half = PLATE_REACH - 1
    const across = { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    const corner = { x: end.x + across.x * half, y: end.y + across.y * half }
    expect.soft(corner.y > end.y, "the band's butt corner would lie below the horizontal wire through the end").toBe(true)
    expect.soft(keeps(d, corner), "it is clipped").toBe(false)
    expect.soft(keeps(d, { x: end.x - 1, y: end.y + 2 }), "so is anything just below the wire").toBe(false)
    expect.soft(keeps(d, { x: end.x + 4, y: end.y - 4 }), "the band behind the end stays").toBe(true)
    expect.soft(keeps(d, { x: end.x + 1, y: end.y - 0.5 }), "right up to the end point").toBe(true)
    expect.soft(keeps(d, { x: end.x + 3 * GRID, y: end.y - 3 * GRID }), "and all along the wire").toBe(true)
  })

  it("ending on a horizontal wire, the slanted end is clipped flush along that wire only: nothing below it, no square step beside the end (the user, 2026-11-17)", () => {
    const [plate] = plateOf(run, route, all, RADIUS, undefined, (p) => (p.x === pts[0].x && p.y === pts[0].y ? "x" : "y"))
    const d = notchPath(plate.notches, PLATE_REACH, { x: -1e4, y: -1e4, w: 2e4, h: 2e4 })
    const end = pts[0]
    const half = PLATE_REACH - 1
    expect.soft(plate.notches[0].across, "the start meets a horizontal conductor").toBe("x")
    expect.soft(keeps(d, { x: end.x + Math.SQRT1_2 * half, y: end.y + Math.SQRT1_2 * half }), "the butt corner below the wire is clipped").toBe(false)
    expect.soft(keeps(d, { x: end.x - 1, y: end.y + 2 }), "so is anything just below the wire").toBe(false)
    expect.soft(keeps(d, { x: end.x - Math.SQRT1_2 * half + 0.5, y: end.y - Math.SQRT1_2 * half + 0.5 }), "the other butt corner, above the wire, stays: no rectangular bite").toBe(true)
    expect.soft(keeps(d, { x: end.x + 4, y: end.y - 4 }), "the band behind the end stays").toBe(true)
  })

  it("the SVG band carries the clip, and an upright wire's band does not", () => {
    const html = (plates: readonly WirePlate[]) => renderToStaticMarkup(React.createElement(SelectionLayer, { objects: [], wires: plates, selectedObjects: new Set<string>(), grid: GRID }))
    const slanted = html(plateOf(run, route, all, RADIUS))
    const clip = slanted.match(/<clipPath id="([^"]+)"/)?.[1]
    expect.soft(clip, "one clip path").toBeDefined()
    expect.soft(slanted.match(new RegExp(`clip-path="url\\(#${clip}\\)"`, "g"))?.length, "on both bands").toBe(2)
    const upright = [c(0, 0), c(4, 0)]
    const flat = html(plateOf(runOf(upright), { id: "s0", pts: upright, owner: [] }, new Set(["s0"]), RADIUS))
    expect.soft(flat, "no clip on an upright wire").not.toContain("clip-path")
  })
})

describe("a crossing gap is a cut in the wire beneath, never a paint (the user, 2026-11-16: «какого хуя там просто залитый бекграунд»)", () => {
  const wire = (id: string, a: Point, b: Point): RoutedWire => ({ id, pts: [a, b], owner: [] })
  const render = (routes: readonly RoutedWire[], netOf: (id: string) => string) =>
    renderToStaticMarkup(
      React.createElement(WireLayer, {
        routes,
        grid: GRID,
        scale: 1,
        selected: new Set<string>(),
        hoveredNet: null,
        colorOf: () => "black" as const,
        netOfWire: netOf,
        dots: [],
        dangling: [],
        corners: [],
        flow: new WireFlow(),
        onWirePointerDown: () => {},
        onWirePointerEnter: () => {},
        onWirePointerLeave: () => {},
      }),
    )
  const masksOf = (html: string) => [...html.matchAll(/<mask id="([^"]+)"[^>]*>(.*?)<\/mask>/g)].map(([, id, body]) => ({ id, uses: [...body.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]) }))
  const netGroups = (html: string) => [...html.matchAll(/data-net="([^"]+)"[^>]*><g( mask="url\(#([^"]+)\)")?>/g)].map(([, net, , mask]) => ({ net, mask }))

  it("two nets crossing: the net painted first is masked by the later net's casings, the later one by nothing", () => {
    const html = render([wire("h", c(0, 2), c(6, 2)), wire("v", c(3, 0), c(3, 5))], (id) => id)
    const groups = netGroups(html)
    expect.soft(groups.map((g) => g.net), "both nets, in paint order").toEqual(["h", "v"])
    expect.soft(groups[1].mask, "the upper wire is whole").toBeUndefined()
    const mask = masksOf(html).find((m) => m.id === groups[0].mask)
    expect.soft(mask?.uses.length, "the lower wire is masked by one net's casings").toBe(1)
    const cut = html.match(new RegExp(`<g id="${mask?.uses[0]}">(.*?)</g>`))?.[1] ?? ""
    expect.soft(cut, "which are the upper wire's").toContain('data-wire="v"')
    expect.soft(cut, "drawn black into the mask").toContain('stroke="black"')
    expect.soft(cut.match(/stroke-width="([\d.]+)"/)?.[1], "as wide as the casing always was: the wire plus a 3 px gap either side").toBe("8")
  })

  it("wires of one net never cut each other", () => {
    const html = render([wire("h", c(0, 2), c(6, 2)), wire("v", c(3, 0), c(3, 5))], () => "one")
    expect.soft(netGroups(html).map((g) => g.mask), "one net, no mask").toEqual([undefined])
  })

  it("a net far from every later net is not masked at all, so the cost follows the crossings, not the nets", () => {
    const html = render([wire("a", c(0, 0), c(4, 0)), wire("b", c(40, 40), c(44, 40)), wire("c", c(2, -2), c(2, 2))], (id) => id)
    const groups = netGroups(html)
    expect.soft(groups.map((g) => [g.net, !!g.mask]), "only the net a later one crosses").toEqual([["a", true], ["b", false], ["c", false]])
    const mask = masksOf(html).find((m) => m.id === groups[0].mask)
    expect.soft(mask?.uses.length, "and only by the net near it").toBe(1)
  })

  it("nothing in the wire layer is stroked in the background colour or a tint, and a bounded mask region follows each wire", () => {
    const html = render([wire("h", c(0, 2), c(6, 2)), wire("v", c(3, 0), c(3, 5))], (id) => id)
    expect.soft(html, "no background stroke").not.toMatch(/stroke="var\(--(background|selection-tint)\)"/)
    expect.soft(html, "no mask spans the whole plane by its region").not.toMatch(/<mask[^>]*width="2e\+?7"/)
    expect.soft(html.match(/data-extent=""/g)?.length, "each wire gives its group a box a mask can follow, so a straight wire still has height").toBe(2)
  })
})
