import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { soonImage, textBoost } from "@/components/field/body-paint"
import { SoonShape } from "@/components/field/ComponentView"
import type { FieldPalette } from "@/components/field/field-palette"
import { sheetTexts, TextRaster } from "@/components/field/symbol-raster"
import { UPRIGHT } from "@/schematic/geometry"
import { printedGrowth } from "@/schematic/printed-text"
import { getDef } from "@/schematic/registry"
import type { BodyShape } from "@/schematic/types"

const GRID = 24
const HAIRLINE_PX = 1
const SYMBOL_STROKE_PX = 2
const PIN_LABEL_CELLS = 0.3
const TEXT_SIZES = [0.5, 0.75, 1, 1.5, 2]

type Soon = Extract<BodyShape, { type: "soon" }>
type Drawn = { text: string; font: string }
type Recording = { strokes: number[]; drawn: Drawn[] }

const board = getDef("open746i-c")!
const soons = board.body.filter((s): s is Soon => s.type === "soon")

function recordingContext(recording: Recording): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { font: "", lineWidth: 1 }
  return new Proxy(state, {
    get(target, key) {
      if (key === "stroke") return () => recording.strokes.push(target.lineWidth as number)
      if (key === "fillText") return (text: string) => recording.drawn.push({ text, font: target.font as string })
      if (key === "measureText") return (text: string) => ({ width: text.length * 6 })
      if (key === "createLinearGradient") return () => ({ addColorStop() {} })
      if (key in target) return target[key]
      return () => {}
    },
    set(target, key, value) {
      target[key] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

let canvases: Recording[] = []

function fakeCanvas(width = 1, height = 1) {
  const recording: Recording = { strokes: [], drawn: [] }
  canvases.push(recording)
  const context = recordingContext(recording)
  return { width, height, getContext: () => context, toDataURL: () => "data:image/png;base64," }
}

const palette = (theme: string): FieldPalette => ({
  theme,
  body: {
    board: { fill: "white", stroke: "grey" },
    zone: { fill: "lightgrey", stroke: "grey" },
    chip: { fill: "black", stroke: "black" },
    connector: { fill: "silver", stroke: "grey" },
    foreground: { fill: "black", stroke: "black" },
    none: { fill: null, stroke: "grey" },
    grip: { fill: null, stroke: null },
  },
  pinMark: { power: "red", gnd: "black", analog: "orange", digital: "black", node: "black", nc: "grey" },
  symbolStroke: "black",
  mutedStroke: "grey",
  text: { plain: "black", muted: "grey", inverse: "white", mono: "monospace", sans: "sans-serif" },
})

beforeEach(() => {
  canvases = []
  vi.stubGlobal("Path2D", class { addPath() {} })
  vi.stubGlobal("DOMMatrix", class { scale() { return this } })
  vi.stubGlobal("OffscreenCanvas", class { constructor(width: number, height: number) { return fakeCanvas(width, height) } })
  vi.stubGlobal("document", { documentElement: { classList: { contains: () => false } }, createElement: () => fakeCanvas() })
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const fontPx = (font: string) => Number(/^([\d.]+)px/.exec(font)?.[1])

describe("a soon image strokes its outlines one canvas pixel wide, as the field does (review: 0.071 px)", () => {
  it.each(soons.map((s) => [s.label, s] as const))("%s", (_, soon) => {
    expect(soonImage(soon, palette(`hairline-${soon.label}`)), "drawn").not.toBeNull()
    const sharp = canvases[0]
    expect(sharp.strokes.length, "strokes something").toBeGreaterThan(0)
    for (const width of sharp.strokes) expect([HAIRLINE_PX, SYMBOL_STROKE_PX]).toContain(width)
    expect(sharp.strokes).toContain(HAIRLINE_PX)
  })
})

describe("the soon badge's word is one size in the DOM and on the text sheet, at every text size (review: it jumped at 75 %)", () => {
  const soon = soons[0]
  const domPx = (boost: number) => {
    const html = renderToStaticMarkup(React.createElement(SoonShape, { shape: soon, g: (v: number) => v * GRID, labels: true, boost, sheeted: false, orientation: UPRIGHT }))
    const word = /<text[^>]*font-size="([\d.]+)"[^>]*>soon<\/text>/.exec(html)
    expect(word, "the DOM draws the word").not.toBeNull()
    return Number(word![1])
  }
  const sheetPx = (boost: number) => {
    const raster = new TextRaster()
    raster.setPalette(palette(`sheet-${boost}`))
    canvases = []
    expect(raster.get(board, UPRIGHT, GRID, 1, { boost, pinSize: PIN_LABEL_CELLS }), "the sheet is drawn").not.toBeNull()
    const words = canvases.flatMap((c) => c.drawn).filter((d) => d.text === "soon")
    expect(words).toHaveLength(soons.length)
    return fontPx(words[0].font)
  }

  it.each(TEXT_SIZES)("at %s × text size", (boost) => {
    expect(domPx(boost)).toBeCloseTo(sheetPx(boost), 6)
  })

  it("and that size follows the text size down, never past the badge's own size", () => {
    const word = sheetTexts(board).find((t) => t.text === "soon")!
    for (const boost of TEXT_SIZES) expect(domPx(boost)).toBeCloseTo((word.size ?? 0.4) * textBoost(word, boost, printedGrowth(board).get(word)) * GRID, 6)
    expect(domPx(0.75)).toBeLessThan(domPx(1))
    expect(domPx(2)).toBe(domPx(1))
  })
})
