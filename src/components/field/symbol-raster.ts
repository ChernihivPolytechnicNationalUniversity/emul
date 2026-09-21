import { DIR, objectRect, objectSize, rotatePin, type Direction, type Rect } from "@/schematic/geometry"
import type { ComponentDef, PlacedObject, Rotation } from "@/schematic/types"
import type { FieldPalette } from "./field-palette"

const SYMBOL_STROKE_PX = 2
const HAIRLINE_PX = 1
const PIN_MARK_CELLS = 0.16
const MARGIN_PX = 4
const MAX_SYMBOL_PX = 4096

export const MAX_CANVAS_PX = 16384

export const deviceScale = () => Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1)

const BUCKETS = [0.03125, 0.0625, 0.125, 0.25, 0.5, 1]

export const rasterBucket = (scale: number) => BUCKETS.find((b) => b >= scale) ?? BUCKETS[BUCKETS.length - 1]

export const labelCanvasFits = (view: Rect, scale: number) =>
  view.w * scale * deviceScale() <= MAX_CANVAS_PX && view.h * scale * deviceScale() <= MAX_CANVAS_PX

export type Symbol = {
  image: CanvasImageSource
  originX: number
  originY: number
  scale: number
  width: number
  height: number
}

const key = (def: ComponentDef, rotation: Rotation, theme: string, scale: number) =>
  `${def.id}|${rotation}|${theme}|${scale}`

function makeCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height)
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  return canvas
}

export class SymbolRaster {
  private cache = new Map<string, Symbol>()
  private palette: FieldPalette | null = null

  setPalette(palette: FieldPalette) {
    if (this.palette?.theme === palette.theme) return
    this.palette = palette
    this.cache.clear()
  }

  clear() {
    this.cache.clear()
  }

  get size() {
    return this.cache.size
  }

  get(def: ComponentDef, rotation: Rotation, grid: number, scale: number): Symbol | null {
    const palette = this.palette
    if (!palette) return null
    const id = key(def, rotation, palette.theme, scale)
    const cached = this.cache.get(id)
    if (cached) return cached
    const drawn = this.draw(def, rotation, grid, scale, palette)
    if (drawn) this.cache.set(id, drawn)
    return drawn
  }

  private draw(def: ComponentDef, rotation: Rotation, grid: number, scale: number, palette: FieldPalette): Symbol | null {
    const box = objectSize(def, rotation)
    const worldWidth = box.w * grid
    const worldHeight = box.h * grid
    const width = Math.max(1, Math.ceil(worldWidth * scale) + MARGIN_PX * 2)
    const height = Math.max(1, Math.ceil(worldHeight * scale) + MARGIN_PX * 2)
    if (width > MAX_SYMBOL_PX || height > MAX_SYMBOL_PX) return null

    const canvas = makeCanvas(width, height)
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | null
    if (!context) return null

    context.translate(MARGIN_PX, MARGIN_PX)
    context.save()
    const unrotatedWidth = def.width * grid
    const unrotatedHeight = def.height * grid
    context.translate((worldWidth * scale) / 2, (worldHeight * scale) / 2)
    if (rotation) context.rotate((rotation * Math.PI) / 180)
    context.scale(scale, scale)
    context.translate(-unrotatedWidth / 2, -unrotatedHeight / 2)
    this.paintBody(context, def, grid, scale, palette)
    context.restore()

    context.save()
    context.scale(scale, scale)
    this.paintPinMarks(context, def, rotation, grid, palette)
    context.restore()

    return { image: canvas, originX: MARGIN_PX, originY: MARGIN_PX, scale, width, height }
  }

  private paintBody(context: CanvasRenderingContext2D, def: ComponentDef, grid: number, scale: number, palette: FieldPalette) {
    for (const shape of def.body) {
      if (shape.type === "text") continue
      const paint = palette.body[shape.fill ?? "none"]
      if (shape.type === "path") {
        const path = new Path2D(shape.d)
        const scaled = new Path2D()
        scaled.addPath(path, new DOMMatrix().scale(grid, grid))
        if (shape.fill && paint.fill) {
          context.fillStyle = paint.fill
          context.fill(scaled)
        }
        const stroke = shape.muted ? palette.mutedStroke : palette.symbolStroke
        if (stroke) {
          context.strokeStyle = stroke
          context.lineWidth = SYMBOL_STROKE_PX / scale
          context.lineCap = "round"
          context.lineJoin = "round"
          context.stroke(scaled)
        }
        continue
      }
      context.beginPath()
      if (shape.type === "rect") {
        const radius = (shape.rx ?? 0) * grid
        context.roundRect(shape.x * grid, shape.y * grid, shape.w * grid, shape.h * grid, radius)
      } else {
        context.arc(shape.cx * grid, shape.cy * grid, shape.r * grid, 0, Math.PI * 2)
      }
      if (paint.fill) {
        context.fillStyle = paint.fill
        context.fill()
      }
      if (paint.stroke) {
        context.strokeStyle = paint.stroke
        context.lineWidth = HAIRLINE_PX / scale
        context.stroke()
      }
    }
  }

  private paintPinMarks(context: CanvasRenderingContext2D, def: ComponentDef, rotation: Rotation, grid: number, palette: FieldPalette) {
    const r = grid * PIN_MARK_CELLS
    for (const raw of def.pins) {
      const pin = rotatePin(raw, def, rotation)
      context.fillStyle = palette.pinMark[pin.kind]
      context.fillRect(pin.x * grid - r, pin.y * grid - r, r * 2, r * 2)
    }
  }
}

const LABEL_OFFSET_CELLS = 0.45
const LABEL_CELLS = 0.3
const LABEL_MARGIN_CELLS = 6
const MAX_SHEET_PX = 8192
const MAX_SHEET_AREA = 8e6

export function labelArea(objects: readonly PlacedObject[], grid: number): Rect | null {
  if (objects.length === 0) return null
  const margin = LABEL_MARGIN_CELLS * grid
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const object of objects) {
    const rect = objectRect(object, grid)
    minX = Math.min(minX, rect.x - margin)
    minY = Math.min(minY, rect.y - margin)
    maxX = Math.max(maxX, rect.x + rect.w + margin)
    maxY = Math.max(maxY, rect.y + rect.h + margin)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

const BODY_TEXT_CELLS = 0.4

export const fixedText = (text: string) => !text.includes("{")

const TEXT_ANCHOR: Record<"start" | "middle" | "end", CanvasTextAlign> = { start: "start", middle: "center", end: "end" }

const ALIGN: Record<Direction, CanvasTextAlign> = {
  left: "right",
  right: "left",
  top: "center",
  bottom: "center",
  "top-left": "right",
  "bottom-left": "right",
  "top-right": "left",
  "bottom-right": "left",
}

export class TextRaster {
  private cache = new Map<string, Symbol>()
  private palette: FieldPalette | null = null
  private drawnAt = 0

  setPalette(palette: FieldPalette) {
    if (this.palette?.theme === palette.theme) return
    this.palette = palette
    this.cache.clear()
  }

  forgetFonts() {
    this.cache.clear()
  }

  get size() {
    return this.cache.size
  }

  private fitting(def: ComponentDef, rotation: Rotation, grid: number, scale: number) {
    const box = objectSize(def, rotation)
    const world = { w: (box.w + LABEL_MARGIN_CELLS * 2) * grid, h: (box.h + LABEL_MARGIN_CELLS * 2) * grid }
    return Math.min(scale, MAX_SHEET_PX / world.w, MAX_SHEET_PX / world.h, Math.sqrt(MAX_SHEET_AREA / (world.w * world.h)))
  }

  get(def: ComponentDef, rotation: Rotation, grid: number, scale: number, boost: number): Symbol | null {
    const palette = this.palette
    if (!palette) return null
    if (scale !== this.drawnAt) {
      this.drawnAt = scale
      this.cache.clear()
    }
    const drawAt = this.fitting(def, rotation, grid, scale)
    const id = `${key(def, rotation, palette.theme, drawAt)}|${boost}`
    const cached = this.cache.get(id)
    if (cached) return cached
    const drawn = this.draw(def, rotation, grid, drawAt, boost, palette)
    if (drawn) this.cache.set(id, drawn)
    return drawn
  }

  private draw(def: ComponentDef, rotation: Rotation, grid: number, scale: number, boost: number, palette: FieldPalette): Symbol | null {
    const box = objectSize(def, rotation)
    const margin = LABEL_MARGIN_CELLS * grid * scale
    const width = Math.max(1, Math.ceil(box.w * grid * scale + margin * 2))
    const height = Math.max(1, Math.ceil(box.h * grid * scale + margin * 2))

    const canvas = makeCanvas(width, height)
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | null
    if (!context) return null

    context.translate(margin, margin)
    context.textBaseline = "middle"

    context.save()
    context.scale(scale, scale)
    context.font = `${LABEL_CELLS * boost * grid}px ${palette.text.mono}`
    for (const raw of def.pins) {
      if (!raw.label) continue
      const pin = rotatePin(raw, def, rotation)
      const dir = DIR[pin.labelAt]
      context.fillStyle = pin.kind === "nc" ? palette.text.muted : palette.text.plain
      context.textAlign = ALIGN[pin.labelAt]
      context.fillText(pin.label, (pin.x + dir.x * LABEL_OFFSET_CELLS) * grid, (pin.y + dir.y * LABEL_OFFSET_CELLS) * grid)
    }
    context.restore()

    context.save()
    context.translate((box.w * grid * scale) / 2, (box.h * grid * scale) / 2)
    if (rotation) context.rotate((rotation * Math.PI) / 180)
    context.scale(scale, scale)
    context.translate((-def.width * grid) / 2, (-def.height * grid) / 2)
    for (const shape of def.body) {
      if (shape.type !== "text" || !fixedText(shape.text)) continue
      const x = shape.x * grid
      const y = shape.y * grid
      context.save()
      context.translate(x, y)
      const turn = (shape.rotate ?? 0) - rotation
      if (turn) context.rotate((turn * Math.PI) / 180)
      context.font = `${(shape.size ?? BODY_TEXT_CELLS) * boost * grid}px ${palette.text.sans}`
      context.textAlign = TEXT_ANCHOR[shape.anchor ?? "middle"]
      context.fillStyle = shape.inverse ? palette.text.inverse : shape.muted ? palette.text.muted : palette.text.plain
      context.fillText(shape.text, 0, 0)
      context.restore()
    }
    context.restore()

    return { image: canvas, originX: margin, originY: margin, scale, width, height }
  }
}
