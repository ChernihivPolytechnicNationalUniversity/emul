import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { exportPng } from "@/components/field/export-image"
import { paintField } from "@/components/field/field-paint"
import { SymbolRaster, TextRaster } from "@/components/field/symbol-raster"
import { casingTrim, casingWidth, WIRE_PX, wireCornerRadius } from "@/components/field/wire-style"
import { GRID, toPath, trimRouteEnds, type Point, type RoutedWire } from "@/schematic/geometry"
import { runPath, turnsAtPins } from "@/schematic/wire-look"
import { segmentNearest } from "@/schematic/wire-select"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"

const R = wireCornerRadius(GRID)
const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })

type Bend = { from: Point; corner: Point; to: Point }

function bendsOf(d: string): Bend[] {
  const tokens = d.match(/[MLQ]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []
  const out: Bend[] = []
  let last: Point = { x: NaN, y: NaN }
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i++]
    const take = (): Point => ({ x: Number(tokens[i++]), y: Number(tokens[i++]) })
    if (command === "Q") {
      const corner = take()
      const to = take()
      out.push({ from: last, corner, to })
      last = to
    } else last = take()
  }
  return out
}

const along = (from: Point, to: Point, by: number): Point => {
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  return { x: from.x + ((to.x - from.x) / length) * by, y: from.y + ((to.y - from.y) / length) * by }
}

function expectBend(d: string, corner: Point, before: Point, after: Point, tangent: number, what: string) {
  const bends = bendsOf(d)
  expect.soft(bends.length, `${what}: one rounded bend`).toBe(1)
  const bend = bends[0]
  if (!bend) return
  expect.soft(bend.corner, `${what}: the curve's control point is the corner`).toEqual(corner)
  const from = along(corner, before, tangent)
  const to = along(corner, after, tangent)
  expect.soft(bend.from.x, `${what}: it leaves the first leg ${tangent.toFixed(3)} px before the corner, x`).toBeNear(from.x, 1e-6)
  expect.soft(bend.from.y, `${what}: … y`).toBeNear(from.y, 1e-6)
  expect.soft(bend.to.x, `${what}: and joins the second ${tangent.toFixed(3)} px after it, x`).toBeNear(to.x, 1e-6)
  expect.soft(bend.to.y, `${what}: … y`).toBeNear(to.y, 1e-6)
}

describe("rounded bends at any angle: the arc tangent to both legs at the radius of §8, its tangent length capped at half the shorter leg (design.md §6.11 rule 11, §8, §0 item 2)", () => {
  it("a right angle keeps today's 0.3 cell: tangent length = R (guard)", () => {
    const pts = [at(0, 0), at(2, 0), at(2, 2)]
    expectBend(toPath(pts, R), at(2, 0), at(0, 0), at(2, 2), R, "90°")
  })

  it("an orthogonal leg into a 45° leg turns by 45°: tangent length R·tan(22.5°)", () => {
    const pts = [at(0, 0), at(2, 0), at(4, 2)]
    expectBend(toPath(pts, R), at(2, 0), at(0, 0), at(4, 2), R * Math.tan(Math.PI / 8), "45°")
  })

  it("at an arbitrary angle, atan(1/2): tangent length R·tan(θ/2) = R·(√5 − 2)", () => {
    const pts = [at(0, 0), at(2, 0), at(4, 1)]
    expectBend(toPath(pts, R), at(2, 0), at(0, 0), at(4, 1), R * (Math.sqrt(5) - 2), "atan(1/2)")
  })

  it("a sharp turn of 135° wants R·tan(67.5°) = 17.4 px and is capped at half the shorter leg, 17.0 px", () => {
    const pts = [at(0, 0), at(2, 0), at(1, 1)]
    const half = Math.hypot(GRID, GRID) / 2
    expect.soft(R * Math.tan((3 * Math.PI) / 8), "set up: the uncapped tangent is longer than half the leg").toBeGreaterThan(half)
    expectBend(toPath(pts, R), at(2, 0), at(0, 0), at(1, 1), half, "135°")
  })

  it("the wire layer's and the painter's path, runPath, draws a diagonal run as its straight segment and rounds its bends the same way", () => {
    expect.soft(runPath([at(0, 0), at(3, 1)], R), "one diagonal: one straight line").toBe(`M0 0 L${3 * GRID} ${GRID}`)
    expectBend(runPath([at(0, 0), at(2, 0), at(4, 2)], R), at(2, 0), at(0, 0), at(4, 2), R * Math.tan(Math.PI / 8), "runPath, 45°")
  })
})

describe("the canvas painter and the PNG export draw the same diagonal path, and the selection plate lies along it (design.md §6.11 rule 11: «the canvas painter and the PNG export alike»)", () => {
  let paths: string[] = []
  const recording = () =>
    new Proxy({ lineWidth: 1 } as Record<string | symbol, unknown>, {
      get: (target, key) => (key in target ? target[key] : key === "measureText" ? () => ({ width: 0 }) : () => {}),
      set: (target, key, value) => ((target[key] = value), true),
    }) as unknown as CanvasRenderingContext2D
  beforeEach(() => {
    paths = []
    vi.stubGlobal("Path2D", class { constructor(d?: string) { if (typeof d === "string") paths.push(d) } addPath() {} })
    vi.stubGlobal("DOMMatrix", class { scale() { return this } })
    const canvas = (width = 1, height = 1) => ({ width, height, getContext: () => recording(), toBlob: (done: (blob: Blob | null) => void) => done(null) })
    vi.stubGlobal("OffscreenCanvas", class { constructor(width: number, height: number) { return canvas(width, height) } })
    vi.stubGlobal("document", { documentElement: { classList: { contains: () => false } }, createElement: () => canvas() })
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "", fontFamily: "sans-serif" }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  const route = (): RoutedWire => ({ id: "x", pts: [at(1, 1), at(3, 1), at(5, 3)], owner: [0, 0, 0] })

  it("exported, the wire is stroked along the rounded diagonal path", async () => {
    const r = route()
    await exportPng({ host: {} as Element, theme: "diagonal-export", objects: [], routes: [r], grid: GRID, colorOf: () => "black", symbols: new SymbolRaster(), texts: new TextRaster(), textScale: 1 })
    const stroked = paths.filter((d) => d.includes("Q"))
    expect.soft(stroked.length, "the wire's path and its casing's").toBeGreaterThanOrEqual(1)
    expectBend(runPath(r.pts, R), at(3, 1), at(1, 1), at(5, 3), R * Math.tan(Math.PI / 8), "the path the painter is given")
    expect.soft(paths, "the painter strokes exactly that path").toContain(runPath(r.pts, R))
  })

  it("selected on the field's canvas, the plate is stroked along the same path", () => {
    const r = route()
    paintField(recording(), {} as Element, { objects: [], routes: [r], view: { x: 0, y: 0, w: 400, h: 400 }, grid: GRID, pixels: 1, device: 1, theme: "diagonal-field", colorOf: () => "black", raster: new SymbolRaster(), selection: { objects: new Set(), wires: new Set(["x"]) } })
    expectBend(runPath(r.pts, R), at(3, 1), at(1, 1), at(5, 3), R * Math.tan(Math.PI / 8), "the plate's path")
    expect.soft(paths, "the plate and the wire share it").toContain(runPath(r.pts, R))
  })
})

describe("the casing gap at the crossing's angle (design.md §6.11 rule 11, §8 and §13.1 «оставляем Gap железно»)", () => {
  it("the upper wire's casing runs along the whole diagonal through the crossing, wider than the wire, so the crossed wire is cut at the crossing's angle (guard)", () => {
    const pts = [at(0, 0), at(4, 4)]
    const casing = toPath(trimRouteEnds(pts, casingTrim(GRID)), R)
    const [x0, y0, x1, y1] = (casing.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    const a = { x: x0, y: y0 }
    const b = { x: x1, y: y1 }
    const crossing = at(2, 2)
    expect.soft((b.x - a.x) * (crossing.y - a.y) - (b.y - a.y) * (crossing.x - a.x), "the crossing lies on the casing's line").toBeNear(0, 1e-6)
    expect.soft(crossing.x > a.x && crossing.x < b.x, "and between its ends").toBe(true)
    expect.soft(casingWidth(WIRE_PX) - WIRE_PX, "the casing is wider than the wire: a gap of 3 px either side").toBe(6)
  })
})

describe("a press on a diagonal hits it at the usual reach: the segment nearest the press by true distance, not by its box (design.md §6.11 rule 11)", () => {
  it("a press inside the box of a run's diagonal but beside its other segment takes that other segment", () => {
    const level: WireSegment = { id: "level", a: at(0, 4), b: at(8, 4) }
    const slant: WireSegment = { id: "slant", a: at(8, 4), b: at(4, 0) }
    const run = { id: "run", segments: [level, slant], points: [at(0, 4), at(8, 4), at(4, 0)] }
    expect.soft(segmentNearest(run, { x: 5 * GRID, y: 3.8 * GRID }), "4.8 px from the level wire, 47 px from the slant").toBe("level")
    expect.soft(segmentNearest(run, { x: 6.1 * GRID, y: 2 * GRID }), "1.7 px from the slant").toBe("slant")
  })
})

describe("a turn at a pin at any angle (phase7-standards-tests.md design hole 2, taken A in findings 7.2: the arc replaces R·tan(θ/2) of the lead; §8)", () => {
  const pin: WirePin = { key: "VT1:B", at: at(0, 0), out: { x: 1, y: 0 } }
  const runOf = (b: Point) => ({ id: "x", segments: [{ id: "x", a: pin.at, b }], points: [pin.at, b] })

  it("a diagonal leaving a pin at atan(1/2) bends at the pin: R·(√5 − 2) of the lead and of the wire", () => {
    const run = runOf(at(2, 1))
    const leads = turnsAtPins([run], [pin]).leads.get("x")
    const tangent = R * (Math.sqrt(5) - 2)
    expect.soft(leads?.start?.x, "the lead's share, x").toBeNear(-tangent, 1e-9)
    expect.soft(leads?.start?.y, "… y").toBeNear(0, 1e-9)
    if (leads) expectBend(runPath(run.points, R, leads), pin.at, { x: -GRID, y: 0 }, at(2, 1), tangent, "at the pin")
  })

  it("a wire leaving straight along the pin's lead does not turn there", () => {
    expect(turnsAtPins([runOf(at(3, 0))], [pin]).leads.size).toBe(0)
  })
})
