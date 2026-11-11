import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { exportPng } from "@/components/field/export-image"
import { printedNameLayout, printedNames } from "@/components/field/printed-names"
import { SymbolRaster, TextRaster } from "@/components/field/symbol-raster"
import { bodyBounds } from "@/schematic/body"
import { examples } from "@/schematic/examples"
import { objectPins, orientationOf, type Point } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import { wireMarks } from "@/components/field/wire-marks"

const GRID = 24

type Recording = { texts: string[]; closedPaths: number; arcs: number }

let canvases: Recording[] = []

function recordingContext(recording: Recording): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { font: "", lineWidth: 1 }
  let pathArcs = 0
  return new Proxy(state, {
    get(target, key) {
      if (key === "fillText") return (text: string) => recording.texts.push(text)
      if (key === "closePath") return () => recording.closedPaths++
      if (key === "beginPath") return () => { pathArcs = 0 }
      if (key === "arc") return () => { pathArcs++; recording.arcs++ }
      if (key === "clip") return () => { recording.arcs -= pathArcs; pathArcs = 0 }
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
  const recording: Recording = { texts: [], closedPaths: 0, arcs: 0 }
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
  return { texts: canvases.flatMap((c) => c.texts), closedPaths: canvases.reduce((sum, c) => sum + c.closedPaths, 0), arcs: canvases.reduce((sum, c) => sum + c.arcs, 0) }
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

describe("the PNG export paints the wiring's marks through the field's own painter (findings 3.R5; verification)", () => {
  it("a T's dot and a dangling end reach the exported picture", async () => {
    const r1: PlacedObject = { id: "R1", def: "resistor", x: 0, y: 0, props: { ref: "R1" } }
    const r2: PlacedObject = { id: "R2", def: "resistor", x: 12 * GRID, y: 0, props: { ref: "R2" } }
    const pin = (o: PlacedObject, id: string) => objectPins(o, GRID).find((p) => p.pin.id === id)!.point
    const a = pin(r1, "2")
    const b = pin(r2, "1")
    const mid = { x: (a.x + b.x) / 2, y: a.y }
    const doc: Schematic = { objects: [r1, r2], wires: [{ id: "l", a, b: mid }, { id: "r", a: mid, b }, { id: "s", a: mid, b: { x: mid.x, y: mid.y + 3 * GRID } }], parts: {} }
    const w = wiringOf(new WireGraph(), doc)
    canvases = []
    await exportPng({ host: {} as Element, theme: `export-${exported++}`, objects: doc.objects, routes: w.routes, grid: GRID, colorOf: () => "black", symbols: new SymbolRaster(), texts: new TextRaster(), textScale: 1, marks: wireMarks(w.routes, w.dots, w.dangling, w.corners, () => "black", true) })
    expect.soft(canvases.reduce((sum, c) => sum + c.arcs, 0), "the dot and the open end, no white ring round the dot (the user, 2026-11-11)").toBe(2)
  })
})
