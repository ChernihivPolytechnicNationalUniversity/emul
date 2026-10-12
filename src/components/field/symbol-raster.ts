import { objectRect, objectSize, orientPin, placedText, type Orientation, type Point, type Rect } from "@/schematic/geometry"
import type { BodyShape, ComponentDef, PlacedObject } from "@/schematic/types"
import { paintShape, SOON_BADGE, soonBadge, textBoost, textColor, textFont } from "./body-paint"
import type { FieldPalette } from "./field-palette"
import { selectionOutline } from "./selection-geometry"
import { boxCorners, KNOCKOUT_OPACITY, labelKnockout, labelOrigin, OVERBAR_WEIGHT_EM, overbarSpan, pinLabels, type Box, type LabelGround, type LabelKnockout, type PinLabel } from "./pin-label"
import { printedNames } from "./printed-names"
import { grownAt, printedGrowth } from "@/schematic/printed-text"

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
    for (const shape of def.body) paintShape(context, shape, grid, scale, palette)
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

type BodyText = Extract<BodyShape, { type: "text" }>

const sheetTextCache = new WeakMap<ComponentDef, readonly BodyText[]>()

export const soonBadgeText = (shape: Extract<BodyShape, { type: "soon" }>): BodyText => {
  const badge = soonBadge(shape)
  return { type: "text", x: badge.textX, y: badge.textY, text: SOON_BADGE.text, size: SOON_BADGE.textSize, printed: true }
}

export function sheetTexts(def: ComponentDef): readonly BodyText[] {
  const cached = sheetTextCache.get(def)
  if (cached) return cached
  const texts = def.body.flatMap((shape): BodyText[] => (shape.type === "text" && fixedText(shape.text) ? [shape] : shape.type === "soon" ? [soonBadgeText(shape)] : []))
  sheetTextCache.set(def, texts)
  return texts
}

const TEXT_ANCHOR: Record<"start" | "middle" | "end", CanvasTextAlign> = { start: "start", middle: "center", end: "end" }

export type SheetText = { boost: number; pinSize: number }

const NOTHING_HIDDEN: ReadonlySet<BodyText> = new Set()

const UNSEEN = 0.001

const faded = (color: string, opacity: number) => `color-mix(in srgb, ${color} ${opacity * 100}%, transparent)`

const groundColor = (ground: LabelGround, palette: FieldPalette) => (ground === "field" ? palette.text.inverse : (palette.body[ground].fill ?? palette.text.inverse))

function paintKnockout(context: CanvasRenderingContext2D, knockout: LabelKnockout, color: string, grid: number) {
  const at = (box: Box) => [box.x * grid, box.y * grid, box.w * grid, box.h * grid] as const
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

  private fitting(def: ComponentDef, orientation: Orientation, grid: number, scale: number) {
    const box = objectSize(def, orientation.rotation)
    const world = { w: (box.w + LABEL_MARGIN_CELLS * 2) * grid, h: (box.h + LABEL_MARGIN_CELLS * 2) * grid }
    return Math.min(scale, MAX_SHEET_PX / world.w, MAX_SHEET_PX / world.h, Math.sqrt(MAX_SHEET_AREA / (world.w * world.h)))
  }

  get(def: ComponentDef, orientation: Orientation, grid: number, scale: number, text: SheetText, hidden = NOTHING_HIDDEN): Symbol | null {
    const palette = this.palette
    if (!palette) return null
    if (scale !== this.drawnAt) {
      this.drawnAt = scale
      this.cache.clear()
    }
    const drawAt = this.fitting(def, orientation, grid, scale)
    if (hidden.size) return this.draw(def, orientation, grid, drawAt, text, palette, hidden)
    const id = `${key(def, orientation, palette.theme, drawAt)}|${text.boost}|${text.pinSize}`
    const cached = this.cache.get(id)
    if (cached) return cached
    const drawn = this.draw(def, orientation, grid, drawAt, text, palette)
    if (drawn) this.cache.set(id, drawn)
    return drawn
  }

  private draw(def: ComponentDef, orientation: Orientation, grid: number, scale: number, text: SheetText, palette: FieldPalette, hidden = NOTHING_HIDDEN): Symbol | null {
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
      const knockout = labelKnockout(label.text, label.anchor, text.pinSize, advance)
      atLabel(pin, label, () => paintKnockout(context, knockout, groundColor(label.ground, palette), grid))
    }
    for (const { label, pin } of labelled) {
      atLabel(pin, label, () => {
        context.fillStyle = pin.kind === "nc" ? palette.text.muted : palette.text.plain
        context.textAlign = TEXT_ANCHOR[label.anchor]
        context.fillText(label.text, 0, 0)
        if (!pin.inverted) return
        const [from, to] = overbarSpan(label.text, label.anchor, text.pinSize, advance)
        context.strokeStyle = context.fillStyle
        context.lineWidth = OVERBAR_WEIGHT_EM * text.pinSize * grid
        context.beginPath()
        context.moveTo(from.x * grid, from.y * grid)
        context.lineTo(to.x * grid, to.y * grid)
        context.stroke()
      })
    }
    context.restore()

    context.save()
    context.translate((box.w * grid * scale) / 2, (box.h * grid * scale) / 2)
    turnInto(context, orientation)
    context.scale(scale, scale)
    context.translate((-def.width * grid) / 2, (-def.height * grid) / 2)
    const upright = (shape: BodyText, factor: number) => {
      const placed = placedText(shape.anchor ?? "middle", shape.rotate ?? 0, orientation)
      const at = grownAt(shape, factor)
      context.translate(at.x * grid, at.y * grid)
      if (orientation.mirror) context.scale(-1, 1)
      const turn = placed.angle - orientation.rotation
      if (turn) context.rotate((turn * Math.PI) / 180)
      return placed
    }
    const growth = printedGrowth(def)
    const plates = new Map<LabelGround, Point[][]>()
    for (const { shape, ground } of printedNames(def)) {
      if (hidden.has(shape)) continue
      const placed = placedText(shape.anchor ?? "middle", shape.rotate ?? 0, orientation)
      const turn = ((placed.angle - orientation.rotation) * Math.PI) / 180
      const factor = textBoost(shape, text.boost, growth.get(shape))
      const { solid } = labelKnockout(shape.text, placed.anchor, (shape.size ?? BODY_TEXT_CELLS) * factor, advance)
      const at = grownAt(shape, factor)
      const onSheet = ({ x, y }: Point): Point => {
        const turned = { x: x * Math.cos(turn) - y * Math.sin(turn), y: x * Math.sin(turn) + y * Math.cos(turn) }
        return { x: at.x * grid + (orientation.mirror ? -turned.x : turned.x) * grid, y: at.y * grid + turned.y * grid }
      }
      const quad = boxCorners(solid, onSheet)
      plates.set(ground, [...(plates.get(ground) ?? []), quad])
    }
    for (const [ground, quads] of plates) {
      context.beginPath()
      for (const quad of quads) {
        context.moveTo(quad[0].x, quad[0].y)
        for (const corner of quad.slice(1)) context.lineTo(corner.x, corner.y)
        context.closePath()
      }
      context.fillStyle = faded(groundColor(ground, palette), KNOCKOUT_OPACITY)
      context.fill()
    }
    for (const shape of sheetTexts(def)) {
      if (hidden.has(shape)) continue
      context.save()
      const factor = textBoost(shape, text.boost, growth.get(shape))
      const placed = upright(shape, factor)
      context.font = `${(shape.size ?? BODY_TEXT_CELLS) * factor * grid}px ${textFont(shape, palette)}`
      context.textAlign = TEXT_ANCHOR[placed.anchor]
      context.fillStyle = textColor(shape, palette)
      context.fillText(shape.text, 0, 0)
      context.restore()
    }
    context.restore()

    return { image: canvas, originX: margin, originY: margin, scale, width, height }
  }
}
