import { objectRect, objectSize, orientPin, placedText, type Orientation, type Rect } from "@/schematic/geometry"
import type { ComponentDef, PlacedObject } from "@/schematic/types"
import type { FieldPalette } from "./field-palette"
import { selectionOutline } from "./selection-geometry"
import { KNOCKOUT_OPACITY, labelKnockout, labelOrigin, pinLabels, type Box, type PinLabel } from "./pin-label"

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

const key = (def: ComponentDef, { rotation, mirror }: Orientation, theme: string, scale: number) =>
  `${def.id}|${rotation}${mirror ? "m" : ""}|${theme}|${scale}`

function turnInto(context: CanvasRenderingContext2D, { rotation, mirror }: Orientation) {
  if (rotation) context.rotate((rotation * Math.PI) / 180)
  if (mirror) context.scale(-1, 1)
}

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

  get(def: ComponentDef, orientation: Orientation, grid: number, scale: number): Symbol | null {
    const palette = this.palette
    if (!palette) return null
    const id = key(def, orientation, palette.theme, scale)
    const cached = this.cache.get(id)
    if (cached) return cached
    const drawn = this.draw(def, orientation, grid, scale, palette)
    if (drawn) this.cache.set(id, drawn)
    return drawn
  }

  private draw(def: ComponentDef, orientation: Orientation, grid: number, scale: number, palette: FieldPalette): Symbol | null {
    const box = objectSize(def, orientation.rotation)
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
    turnInto(context, orientation)
    context.scale(scale, scale)
    context.translate(-unrotatedWidth / 2, -unrotatedHeight / 2)
    this.paintBody(context, def, grid, scale, palette)
    context.restore()

    context.save()
    context.scale(scale, scale)
    this.paintPinMarks(context, def, orientation, grid, palette)
    context.restore()

    return { image: canvas, originX: MARGIN_PX, originY: MARGIN_PX, scale, width, height }
  }

  private paintBody(context: CanvasRenderingContext2D, def: ComponentDef, grid: number, scale: number, palette: FieldPalette) {
    const { hollow } = selectionOutline(def)
    if (hollow) {
      const backdrop = new Path2D()
      backdrop.addPath(new Path2D(hollow), new DOMMatrix().scale(grid, grid))
      context.fillStyle = palette.text.inverse
      context.fill(backdrop)
    }
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

  private paintPinMarks(context: CanvasRenderingContext2D, def: ComponentDef, orientation: Orientation, grid: number, palette: FieldPalette) {
    const r = grid * PIN_MARK_CELLS
    for (const raw of def.pins) {
      const pin = orientPin(raw, def, orientation)
      context.fillStyle = palette.pinMark[pin.kind]
      context.fillRect(pin.x * grid - r, pin.y * grid - r, r * 2, r * 2)
    }
  }
}

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

export type SheetText = { boost: number; pinSize: number }

const UNSEEN = 0.001

const faded = (color: string, opacity: number) => `color-mix(in srgb, ${color} ${opacity * 100}%, transparent)`

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

  private fitting(def: ComponentDef, orientation: Orientation, grid: number, scale: number) {
    const box = objectSize(def, orientation.rotation)
    const world = { w: (box.w + LABEL_MARGIN_CELLS * 2) * grid, h: (box.h + LABEL_MARGIN_CELLS * 2) * grid }
    return Math.min(scale, MAX_SHEET_PX / world.w, MAX_SHEET_PX / world.h, Math.sqrt(MAX_SHEET_AREA / (world.w * world.h)))
  }

  get(def: ComponentDef, orientation: Orientation, grid: number, scale: number, text: SheetText): Symbol | null {
    const palette = this.palette
    if (!palette) return null
    if (scale !== this.drawnAt) {
      this.drawnAt = scale
      this.cache.clear()
    }
    const drawAt = this.fitting(def, orientation, grid, scale)
    const id = `${key(def, orientation, palette.theme, drawAt)}|${text.boost}|${text.pinSize}`
    const cached = this.cache.get(id)
    if (cached) return cached
    const drawn = this.draw(def, orientation, grid, drawAt, text, palette)
    if (drawn) this.cache.set(id, drawn)
    return drawn
  }

  private draw(def: ComponentDef, orientation: Orientation, grid: number, scale: number, text: SheetText, palette: FieldPalette): Symbol | null {
    const box = objectSize(def, orientation.rotation)
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
    const fontPx = text.pinSize * grid
    context.font = `${fontPx}px ${palette.text.mono}`
    const advance = context.measureText("0").width / fontPx
    const byId = new Map(def.pins.map((pin) => [pin.id, pin]))
    const labelled = pinLabels(def, orientation).flatMap((label) => {
      const raw = byId.get(label.id)
      return raw ? [{ label, pin: orientPin(raw, def, orientation) }] : []
    })
    const atLabel = (pin: { x: number; y: number }, label: PinLabel, paint: () => void) => {
      const origin = labelOrigin(label, text.pinSize)
      context.save()
      context.translate((pin.x + origin.x) * grid, (pin.y + origin.y) * grid)
      if (label.angle) context.rotate((label.angle * Math.PI) / 180)
      paint()
      context.restore()
    }
    for (const { label, pin } of labelled) {
      const ground = label.ground
      const color = ground === "field" ? palette.text.inverse : (palette.body[ground].fill ?? palette.text.inverse)
      const knockout = labelKnockout(label.text, label.anchor, text.pinSize, advance)
      const at = (box: Box) => [box.x * grid, box.y * grid, box.w * grid, box.h * grid] as const
      atLabel(pin, label, () => {
        context.fillStyle = faded(color, KNOCKOUT_OPACITY)
        context.fillRect(...at(knockout.solid))
        for (const [box, rising] of [[knockout.rise, true], [knockout.fall, false]] as const) {
          const [x, y, w, h] = at(box)
          const ramp = knockout.axis === "x" ? context.createLinearGradient(x, 0, x + w, 0) : context.createLinearGradient(0, y, 0, y + h)
          ramp.addColorStop(0, faded(color, rising ? UNSEEN : KNOCKOUT_OPACITY))
          ramp.addColorStop(1, faded(color, rising ? KNOCKOUT_OPACITY : UNSEEN))
          context.fillStyle = ramp
          context.fillRect(x, y, w, h)
        }
      })
    }
    for (const { label, pin } of labelled) {
      atLabel(pin, label, () => {
        context.fillStyle = pin.kind === "nc" ? palette.text.muted : palette.text.plain
        context.textAlign = TEXT_ANCHOR[label.anchor]
        context.fillText(label.text, 0, 0)
      })
    }
    context.restore()

    context.save()
    context.translate((box.w * grid * scale) / 2, (box.h * grid * scale) / 2)
    turnInto(context, orientation)
    context.scale(scale, scale)
    context.translate((-def.width * grid) / 2, (-def.height * grid) / 2)
    for (const shape of def.body) {
      if (shape.type !== "text" || !fixedText(shape.text)) continue
      const placed = placedText(shape.anchor ?? "middle", shape.rotate ?? 0, orientation)
      context.save()
      context.translate(shape.x * grid, shape.y * grid)
      if (orientation.mirror) context.scale(-1, 1)
      const turn = placed.angle - orientation.rotation
      if (turn) context.rotate((turn * Math.PI) / 180)
      context.font = `${(shape.size ?? BODY_TEXT_CELLS) * text.boost * grid}px ${palette.text.sans}`
      context.textAlign = TEXT_ANCHOR[placed.anchor]
      context.fillStyle = shape.inverse ? palette.text.inverse : shape.muted ? palette.text.muted : palette.text.plain
      context.fillText(shape.text, 0, 0)
      context.restore()
    }
    context.restore()

    return { image: canvas, originX: margin, originY: margin, scale, width, height }
  }
}
