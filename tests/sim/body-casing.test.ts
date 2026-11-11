import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bodyMaskShapes, BODY_EDGE_CELLS } from "@/components/field/body-mask"
import { exportPng } from "@/components/field/export-image"
import { paintField } from "@/components/field/field-paint"
import { SymbolRaster, TextRaster } from "@/components/field/symbol-raster"
import { GRID, type Point, type RoutedWire } from "@/schematic/geometry"
import type { PlacedObject } from "@/schematic/types"

type Polygon = Point[]
type Clip = { rule: CanvasFillRule; polygons: Polygon[] }
type Stroke = { style: unknown; clips: Clip[] }

function recorder() {
  const strokes: Stroke[] = []
  const state: Record<string | symbol, unknown> = {}
  let polygons: Polygon[] = []
  let clips: Clip[] = []
  const saved: { state: typeof state; clips: Clip[] }[] = []
  const context = new Proxy(state, {
    get(target, key) {
      if (key === "save") return () => saved.push({ state: { ...state }, clips: [...clips] })
      if (key === "restore") return () => { const prior = saved.pop()!; Object.assign(state, prior.state); clips = prior.clips }
      if (key === "beginPath") return () => { polygons = [] }
      if (key === "moveTo") return (x: number, y: number) => polygons.push([{ x, y }])
      if (key === "lineTo") return (x: number, y: number) => polygons.at(-1)!.push({ x, y })
      if (key === "rect") return (x: number, y: number, w: number, h: number) => polygons.push([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }])
      if (key === "arc") return (x: number, y: number, radius: number, start: number, end: number) => {
        if (!polygons.length) polygons.push([])
        for (let i = 0; i <= 32; i++) {
          const angle = start + (end - start) * i / 32
          polygons.at(-1)!.push({ x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius })
        }
      }
      if (key === "clip") return (rule: CanvasFillRule) => clips.push({ rule, polygons: structuredClone(polygons) })
      if (key === "stroke") return () => strokes.push({ style: state.strokeStyle, clips: [...clips] })
      if (key === "measureText") return (text: string) => ({ width: text.length * 6 })
      if (key in target) return target[key]
      return () => {}
    },
    set(target, key, value) { target[key] = value; return true },
  }) as unknown as CanvasRenderingContext2D
  return { context, strokes }
}

function inside(p: Point, polygon: Polygon) {
  let result = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) result = !result
  }
  return result
}

const visible = (stroke: Stroke, point: Point) => stroke.clips.every((clip) => clip.polygons.filter((polygon) => inside(point, polygon)).length % 2 === 1)
const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const part: PlacedObject = { id: "part", def: "resistor", ...at(0, 0), props: { ref: "R1", value: "10k" } }
const routes: RoutedWire[] = [{ id: "h", pts: [at(-4, 1), at(8, 1)], owner: [] }, { id: "v", pts: [at(2, -4), at(2, 5)], owner: [] }]

beforeEach(() => {
  vi.stubGlobal("Path2D", class {})
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (key: string) => key === "--background" ? "paper" : "ink", fontFamily: "sans-serif" }))
})
afterEach(() => vi.unstubAllGlobals())

function assertMasked(strokes: Stroke[], objects: PlacedObject[]) {
  const casings = strokes.filter((s) => s.style === "paper")
  expect(casings).toHaveLength(2)
  expect(casings.every((s) => s.clips.length && s.clips.every((c) => c.rule === "evenodd"))).toBe(true)
  const shapes = bodyMaskShapes(objects, GRID)
  const points = [
    ...shapes.bodies.map((body) => ({ x: body.reduce((sum, p) => sum + p.x, 0) / body.length, y: body.reduce((sum, p) => sum + p.y, 0) / body.length })),
    ...shapes.leads.flatMap(([a, b]) => {
      const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      return [middle, { x: middle.x - (b.y - a.y) / length * BODY_EDGE_CELLS * GRID * 0.4, y: middle.y + (b.x - a.x) / length * BODY_EDGE_CELLS * GRID * 0.4 }]
    }),
    ...shapes.texts.map((r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })),
  ]
  for (const point of points) expect(casings.every((s) => !visible(s, point)), JSON.stringify(point)).toBe(true)
  expect(casings.every((s) => visible(s, at(-3, -3)))).toBe(true)
  expect(strokes.filter((s) => s.style === "ink").every((s) => s.clips.length === 0)).toBe(true)
}

describe("canvas crossing casings use the SVG body mask", () => {
  it("clips casing strokes off bodies, 0.15-cell leads and field boxes", () => {
    const recording = recorder()
    const raster = new SymbolRaster()
    vi.spyOn(raster, "get").mockReturnValue(null)
    paintField(recording.context, {} as Element, { objects: [part], routes, view: { x: -300, y: -300, w: 1000, h: 1000 }, grid: GRID, pixels: 0.5, device: 1, theme: "test", colorOf: () => "black", raster })
    assertMasked(recording.strokes, [part])
  })

  it("overlapping masks do not reopen a hole for the casing", () => {
    const objects = [part, { ...part, id: "overlapping", x: GRID / 2 }]
    const recording = recorder()
    const raster = new SymbolRaster()
    vi.spyOn(raster, "get").mockReturnValue(null)
    paintField(recording.context, {} as Element, { objects, routes, view: { x: -300, y: -300, w: 1000, h: 1000 }, grid: GRID, pixels: 1, device: 1, theme: "test", colorOf: () => "black", raster })
    assertMasked(recording.strokes, objects)
  })

  it("boards leave their bodies, leads and names passable for casings", () => {
    const recording = recorder()
    const raster = new SymbolRaster()
    vi.spyOn(raster, "get").mockReturnValue(null)
    paintField(recording.context, {} as Element, { objects: [{ id: "board", def: "nucleo-f429zi", x: 0, y: 0 }], routes, view: { x: -300, y: -300, w: 1000, h: 1000 }, grid: GRID, pixels: 1, device: 1, theme: "test", colorOf: () => "black", raster })
    expect(recording.strokes.filter((s) => s.style === "paper").every((s) => visible(s, at(2, 1)))).toBe(true)
  })

  it("PNG export draws its casings under the same evenodd clips", async () => {
    const recording = recorder()
    vi.stubGlobal("document", { documentElement: { classList: { contains: () => false } }, createElement: () => ({ width: 1, height: 1, getContext: () => recording.context, toBlob: (done: (blob: null) => void) => done(null) }) })
    const symbols = new SymbolRaster()
    const texts = new TextRaster()
    vi.spyOn(symbols, "get").mockReturnValue(null)
    vi.spyOn(texts, "get").mockReturnValue(null)
    await exportPng({ host: {} as Element, theme: "test", objects: [part], routes, grid: GRID, colorOf: () => "black", symbols, texts, textScale: 1 })
    assertMasked(recording.strokes, [part])
  })
})
