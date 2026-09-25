import { objectRect, objectSize, routeBox, type Rect, type RoutedWire } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import { cssColor, paintField } from "./field-paint"
import { readFieldPalette } from "./field-palette"
import { fixedText, type SymbolRaster, type TextRaster } from "./symbol-raster"

const MAX_PIXELS = 2
const MAX_SIDE_PX = 8192
const MAX_SYMBOL_PX = 4000
const MARGIN_CELLS = 2

type ExportImage = {
  host: Element
  theme: string
  objects: readonly PlacedObject[]
  routes: readonly RoutedWire[]
  grid: number
  colorOf: (wireId: string) => WireColorKey
  symbols: SymbolRaster
  texts: TextRaster
}

const ALIGN = { start: "left", middle: "center", end: "right" } as const

function paintLabels(context: CanvasRenderingContext2D, host: Element, objects: readonly PlacedObject[], view: Rect, grid: number, pixels: number) {
  const colors = {
    foreground: cssColor(host, "var(--foreground)"),
    muted: cssColor(host, "var(--muted-foreground)"),
    background: cssColor(host, "var(--background)"),
  }
  const family = getComputedStyle(host).fontFamily
  context.textBaseline = "middle"
  for (const object of objects) {
    const def = getDef(object.def)
    if (!def) continue
    const props: Record<string, string> = { ...def.defaults, ...object.props }
    if (def.derive) Object.assign(props, def.derive(props))
    const rotation = object.rotation ?? 0
    const box = objectSize(def, rotation)
    const cx = object.x + (box.w * grid) / 2
    const cy = object.y + (box.h * grid) / 2
    const turn = (rotation * Math.PI) / 180
    for (const shape of def.body) {
      if (shape.type !== "text" || fixedText(shape.text)) continue
      const text = shape.text.replace(/\{(\w+)\}/g, (_, k: string) => props[k] ?? "")
      if (!text) continue
      const dx = shape.x * grid - (def.width * grid) / 2
      const dy = shape.y * grid - (def.height * grid) / 2
      const x = cx + dx * Math.cos(turn) - dy * Math.sin(turn)
      const y = cy + dx * Math.sin(turn) + dy * Math.cos(turn)
      context.save()
      context.translate((x - view.x) * pixels, (y - view.y) * pixels)
      context.rotate(((shape.rotate ?? 0) * Math.PI) / 180)
      context.font = `${(shape.size ?? 0.4) * grid * pixels}px ${family}`
      context.textAlign = ALIGN[shape.anchor ?? "middle"]
      context.fillStyle = shape.inverse ? colors.background : shape.muted ? colors.muted : colors.foreground
      context.fillText(text, 0, 0)
      context.restore()
    }
  }
}

function bounds(objects: readonly PlacedObject[], routes: readonly RoutedWire[], grid: number): Rect | null {
  const boxes = [...objects.map((o) => objectRect(o, grid)), ...routes.map(routeBox)]
  if (!boxes.length) return null
  const x = Math.min(...boxes.map((r) => r.x)) - MARGIN_CELLS * grid
  const y = Math.min(...boxes.map((r) => r.y)) - MARGIN_CELLS * grid
  const w = Math.max(...boxes.map((r) => r.x + r.w)) + MARGIN_CELLS * grid - x
  const h = Math.max(...boxes.map((r) => r.y + r.h)) + MARGIN_CELLS * grid - y
  return { x, y, w, h }
}

export async function exportPng({ host, theme, objects, routes, grid, colorOf, symbols, texts }: ExportImage): Promise<Blob | null> {
  const view = bounds(objects, routes, grid)
  if (!view) return null
  await document.fonts?.ready
  const largest = Math.max(...objects.map((o) => Math.max(objectRect(o, grid).w, objectRect(o, grid).h)), 1)
  const pixels = Math.min(MAX_PIXELS, MAX_SIDE_PX / view.w, MAX_SIDE_PX / view.h, MAX_SYMBOL_PX / largest)
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(view.w * pixels))
  canvas.height = Math.max(1, Math.round(view.h * pixels))
  const context = canvas.getContext("2d")
  if (!context) return null

  context.fillStyle = cssColor(host, "var(--background)")
  context.fillRect(0, 0, canvas.width, canvas.height)
  paintField(context, host, { objects, routes, view, grid, pixels, device: pixels, theme, colorOf, raster: symbols })

  texts.setPalette(readFieldPalette(host, theme))
  for (const object of objects) {
    const def = getDef(object.def)
    const sheet = def && texts.get(def, object.rotation ?? 0, grid, pixels, 1)
    if (!sheet) continue
    const stretch = pixels / sheet.scale
    const rect = objectRect(object, grid)
    context.drawImage(
      sheet.image,
      (rect.x - view.x) * pixels - sheet.originX * stretch,
      (rect.y - view.y) * pixels - sheet.originY * stretch,
      sheet.width * stretch,
      sheet.height * stretch,
    )
  }
  paintLabels(context, host, objects, view, grid, pixels)
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
}
