import type { BodyShape } from "@/schematic/types"
import type { FieldPalette } from "./field-palette"

const SYMBOL_STROKE_PX = 2
const HAIRLINE_PX = 1

export const SOON_BADGE = { w: 2.7, h: 0.95, text: "soon", textSize: 0.5, icon: 0.62 } as const
export const SOON_BLUR_CELLS = 0.22
const SOON_PX_PER_CELL = 14

export const LUCIDE_CLOCK = { box: 24, circle: { cx: 12, cy: 12, r: 10 }, hands: "M12 6v6l4 2" } as const

type Text = Extract<BodyShape, { type: "text" }>
type Soon = Extract<BodyShape, { type: "soon" }>

export const textBoost = (shape: Text, boost: number, growth = 1) => (shape.printed ? Math.min(boost, growth) : boost)

export const textFont = (shape: Text, palette: FieldPalette) => (shape.mono ? palette.text.mono : palette.text.sans)

export const textColor = (shape: Text, palette: FieldPalette) => (shape.inverse ? palette.text.inverse : shape.muted ? palette.text.muted : palette.text.plain)

function scaledPath(d: string, grid: number) {
  const scaled = new Path2D()
  scaled.addPath(new Path2D(d), new DOMMatrix().scale(grid, grid))
  return scaled
}

function paintArt(context: CanvasRenderingContext2D, shape: Extract<BodyShape, { type: "art" }>, grid: number, scale: number, palette: FieldPalette) {
  const path = scaledPath(shape.d, grid)
  if (!shape.fill) {
    context.fillStyle = shape.muted ? palette.text.muted : palette.text.plain
    context.fill(path)
    return
  }
  const paint = palette.body[shape.fill]
  if (paint.fill) {
    context.fillStyle = paint.fill
    context.fill(path)
  }
  if (paint.stroke) {
    context.strokeStyle = paint.stroke
    context.lineWidth = HAIRLINE_PX / scale
    context.stroke(path)
  }
}

export function paintShape(context: CanvasRenderingContext2D, shape: BodyShape, grid: number, scale: number, palette: FieldPalette) {
  if (shape.type === "text") return
  if (shape.type === "soon") {
    paintSoon(context, shape, grid, scale, palette)
    return
  }
  if (shape.type === "art") {
    paintArt(context, shape, grid, scale, palette)
    return
  }
  const paint = palette.body[shape.fill ?? "none"]
  if (shape.type === "path") {
    const scaled = scaledPath(shape.d, grid)
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
    return
  }
  context.beginPath()
  if (shape.type === "rect") context.roundRect(shape.x * grid, shape.y * grid, shape.w * grid, shape.h * grid, (shape.rx ?? 0) * grid)
  else context.arc(shape.cx * grid, shape.cy * grid, shape.r * grid, 0, Math.PI * 2)
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

function paintPlainText(context: CanvasRenderingContext2D, shape: Text, grid: number, palette: FieldPalette) {
  context.save()
  context.translate(shape.x * grid, shape.y * grid)
  if (shape.rotate) context.rotate((shape.rotate * Math.PI) / 180)
  context.font = `${(shape.size ?? 0.4) * grid}px ${textFont(shape, palette)}`
  context.textAlign = shape.anchor === "start" ? "start" : shape.anchor === "end" ? "end" : "center"
  context.textBaseline = "middle"
  context.fillStyle = textColor(shape, palette)
  context.fillText(shape.text, 0, 0)
  context.restore()
}

function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    return canvas
  }
  return new OffscreenCanvas(width, height)
}

export type SoonImage = { canvas: HTMLCanvasElement | OffscreenCanvas; url: string | null }

const soonImages = new WeakMap<Soon, Map<string, SoonImage>>()

export function soonImage(shape: Soon, palette: FieldPalette): SoonImage | null {
  const byTheme = soonImages.get(shape) ?? new Map<string, SoonImage>()
  soonImages.set(shape, byTheme)
  const cached = byTheme.get(palette.theme)
  if (cached) return cached
  const width = Math.max(1, Math.ceil(shape.w * SOON_PX_PER_CELL))
  const height = Math.max(1, Math.ceil(shape.h * SOON_PX_PER_CELL))
  const sharp = makeCanvas(width, height)
  const sharpContext = sharp.getContext("2d") as CanvasRenderingContext2D | null
  const blurred = makeCanvas(width, height)
  const context = blurred.getContext("2d") as CanvasRenderingContext2D | null
  if (!sharpContext || !context) return null
  sharpContext.translate(-shape.x * SOON_PX_PER_CELL, -shape.y * SOON_PX_PER_CELL)
  for (const child of shape.body) {
    if (child.type === "text") paintPlainText(sharpContext, child, SOON_PX_PER_CELL, palette)
    else paintShape(sharpContext, child, SOON_PX_PER_CELL, 1, palette)
  }
  context.filter = `blur(${SOON_BLUR_CELLS * SOON_PX_PER_CELL}px)`
  context.drawImage(sharp, 0, 0)
  const url = "toDataURL" in blurred ? blurred.toDataURL() : null
  const image = { canvas: blurred, url }
  byTheme.set(palette.theme, image)
  return image
}

export function soonBadge(shape: Soon) {
  const x = shape.x + (shape.w - SOON_BADGE.w) / 2
  const y = shape.y + (shape.h - SOON_BADGE.h) / 2
  const textFrom = x + 0.22 + SOON_BADGE.icon + 0.12
  return { x, y, w: SOON_BADGE.w, h: SOON_BADGE.h, iconX: x + 0.22, iconY: y + (SOON_BADGE.h - SOON_BADGE.icon) / 2, textX: (textFrom + x + SOON_BADGE.w - 0.18) / 2, textY: y + SOON_BADGE.h / 2 }
}

function paintSoon(context: CanvasRenderingContext2D, shape: Soon, grid: number, scale: number, palette: FieldPalette) {
  const image = soonImage(shape, palette)
  if (image) context.drawImage(image.canvas, shape.x * grid, shape.y * grid, shape.w * grid, shape.h * grid)
  const badge = soonBadge(shape)
  context.beginPath()
  context.roundRect(badge.x * grid, badge.y * grid, badge.w * grid, badge.h * grid, (badge.h / 2) * grid)
  context.fillStyle = palette.text.inverse
  context.fill()
  context.strokeStyle = palette.body.board.stroke ?? palette.mutedStroke
  context.lineWidth = HAIRLINE_PX / scale
  context.stroke()
  const unit = (SOON_BADGE.icon * grid) / LUCIDE_CLOCK.box
  context.save()
  context.translate(badge.iconX * grid, badge.iconY * grid)
  context.scale(unit, unit)
  context.strokeStyle = palette.text.plain
  context.lineWidth = 2
  context.lineCap = "round"
  context.lineJoin = "round"
  context.beginPath()
  context.arc(LUCIDE_CLOCK.circle.cx, LUCIDE_CLOCK.circle.cy, LUCIDE_CLOCK.circle.r, 0, Math.PI * 2)
  context.stroke()
  context.stroke(new Path2D(LUCIDE_CLOCK.hands))
  context.restore()
}
