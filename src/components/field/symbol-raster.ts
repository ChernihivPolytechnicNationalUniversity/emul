import { objectSize, rotatePin } from "@/schematic/geometry"
import type { ComponentDef, Rotation } from "@/schematic/types"
import type { FieldPalette } from "./field-palette"

/** Stroke width of symbol paths, in screen pixels, matching the DOM layer's non-scaling stroke. */
const SYMBOL_STROKE_PX = 2
const HAIRLINE_PX = 1
const PIN_MARK_CELLS = 0.16
/** Grown by this much on every side so a stroke on the outline is not clipped. */
const MARGIN_PX = 4

export type Symbol = {
  image: CanvasImageSource
  /** Where the object's world origin sits inside the image, in image pixels. */
  originX: number
  originY: number
  /** Image pixels per world pixel. */
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

/**
 * One rasterised picture per `(definition, rotation, theme, zoom bucket)`, blitted once per
 * instance. A schematic is a few dozen definitions in thousands of copies, so the cache is tiny
 * and every copy after the first is a `drawImage`. FIELD.md §11.
 *
 * Only what the canvas band draws is in here: body shapes and pin marks. Labels are already off
 * at these zooms, which is what lets per-instance props stay out of the key.
 */
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
    if (width > 4096 || height > 4096) return null

    const canvas = makeCanvas(width, height)
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | null
    if (!context) return null

    context.translate(MARGIN_PX, MARGIN_PX)
    context.save()
    // The symbol is drawn unrotated and turned about its own centre, exactly as the DOM svg is.
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
