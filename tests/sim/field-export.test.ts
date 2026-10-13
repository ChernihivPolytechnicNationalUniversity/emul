import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { exportPng } from "@/components/field/export-image"
import { printedNameLayout, printedNames } from "@/components/field/printed-names"
import { SymbolRaster, TextRaster } from "@/components/field/symbol-raster"
import { bodyBounds } from "@/schematic/body"
import { examples } from "@/schematic/examples"
import { orientationOf, type Point } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"

const GRID = 24

type Recording = { texts: string[]; closedPaths: number }

let canvases: Recording[] = []

function recordingContext(recording: Recording): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { font: "", lineWidth: 1 }
  return new Proxy(state, {
    get(target, key) {
      if (key === "fillText") return (text: string) => recording.texts.push(text)
      if (key === "closePath") return () => recording.closedPaths++
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

function fakeCanvas(width = 1, height = 1) {
  const recording: Recording = { texts: [], closedPaths: 0 }
  canvases.push(recording)
  const context = recordingContext(recording)
  return { width, height, getContext: () => context, toBlob: (done: (blob: Blob | null) => void) => done(null) }
}

beforeEach(() => {
  canvases = []
  vi.stubGlobal("Path2D", class { addPath() {} })
  vi.stubGlobal("DOMMatrix", class { scale() { return this } })
  vi.stubGlobal("OffscreenCanvas", class { constructor(width: number, height: number) { return fakeCanvas(width, height) } })
  vi.stubGlobal("document", { documentElement: { classList: { contains: () => false } }, createElement: () => fakeCanvas() })
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "", fontFamily: "sans-serif" }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

let exported = 0

async function painted(objects: readonly PlacedObject[]): Promise<Recording> {
  canvases = []
  await exportPng({
    host: {} as Element,
    theme: `export-${exported++}`,
    objects,
    routes: [],
    grid: GRID,
    colorOf: () => "black",
    symbols: new SymbolRaster(),
    texts: new TextRaster(),
    textScale: 1,
  })
  return { texts: canvases.flatMap((c) => c.texts), closedPaths: canvases.reduce((sum, c) => sum + c.closedPaths, 0) }
}

function missingFrom(painting: readonly string[], expected: readonly string[]) {
  const left = new Map<string, number>()
  for (const text of painting) left.set(text, (left.get(text) ?? 0) + 1)
  const missing: string[] = []
  for (const text of expected) {
    const count = left.get(text) ?? 0
    if (count) left.set(text, count - 1)
    else missing.push(text)
  }
  return missing.sort()
}

describe("the PNG export leaves out the names a docked 7\" LCD covers, as the field does (review, 2026-10-13)", () => {
  const doc = examples.find((e) => e.id === "open746-lcd")!.build(GRID)
  const board = getDef("open746i-c")!
  const boardObject = doc.objects.find((o) => o.def === "open746i-c")!
  const lcdObject = doc.objects.find((o) => o.def === "lcd7-f")!
  const lcdBody = bodyBounds(getDef("lcd7-f")!)
  const underLcd = (p: Point) => p.x > lcdObject.x / GRID + lcdBody.x && p.x < lcdObject.x / GRID + lcdBody.x + lcdBody.w && p.y > lcdObject.y / GRID + lcdBody.y && p.y < lcdObject.y / GRID + lcdBody.y + lcdBody.h
  const namesUnderLcd = printedNameLayout(board, orientationOf(boardObject))
    .filter((name) => underLcd({ x: boardObject.x / GRID + name.x, y: boardObject.y / GRID + name.y }))
    .map((name) => name.shape.text)
    .sort()

  it("P15's forty names are the ones under the LCD's tail", () => {
    expect(namesUnderLcd).toHaveLength(board.pins.filter((p) => p.connector === "P15").length)
  })

  it("the board alone paints every name it prints, P15's included", async () => {
    const alone = await painted([boardObject])
    expect.soft(missingFrom(alone.texts, printedNames(board).map((n) => n.shape.text)), "names left out").toEqual([])
  })

  it("docked, the forty and their plates are left out, and every other name is still painted", async () => {
    const alone = await painted([boardObject])
    const lcd = await painted([lcdObject])
    const docked = await painted([boardObject, lcdObject])
    const apart = [...alone.texts, ...lcd.texts]
    expect.soft(missingFrom(docked.texts, apart), "left out of the docked export").toEqual(namesUnderLcd)
    expect.soft(missingFrom(apart, docked.texts), "painted only when docked").toEqual([])
    expect.soft(alone.closedPaths + lcd.closedPaths - docked.closedPaths, "plates left out with them").toBe(namesUnderLcd.length)
  })

  it("a board placed over the LCD keeps them: they are printed on the topmost body", async () => {
    const alone = await painted([boardObject])
    const lcd = await painted([lcdObject])
    const over = await painted([lcdObject, boardObject])
    const apart = [...alone.texts, ...lcd.texts]
    expect.soft(missingFrom(over.texts, apart), "left out").toEqual([])
    expect.soft(missingFrom(apart, over.texts), "added").toEqual([])
    expect.soft(over.closedPaths, "plates").toBe(alone.closedPaths + lcd.closedPaths)
  })
})
