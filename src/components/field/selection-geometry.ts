import { objectSize } from "@/schematic/geometry"
import type { BodyShape, ComponentDef, PlacedObject } from "@/schematic/types"

export const SELECTION_BANDS = [
  { margin: 5, color: "var(--selection-feather)" },
  { margin: 3.5, color: "var(--selection)" },
] as const

export type Outline = { strokes: string; hollow: string }

const outlines = new WeakMap<ComponentDef, Outline>()

function circlePath(x: number, y: number, r: number) {
  return `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`
}

function rectPath({ x, y, w, h, rx }: Extract<BodyShape, { type: "rect" }>) {
  const r = Math.max(0, Math.min(rx ?? 0, w / 2, h / 2))
  if (!r) return `M${x} ${y}h${w}v${h}h${-w}Z`
  return `M${x + r} ${y}H${x + w - r}a${r} ${r} 0 0 1 ${r} ${r}V${y + h - r}a${r} ${r} 0 0 1 ${-r} ${r}H${x + r}a${r} ${r} 0 0 1 ${-r} ${-r}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}Z`
}

const isClosed = (subpath: string) => /[Zz]\s*$/.test(subpath)
const isHollow = (shape: BodyShape) => shape.type !== "text" && (!shape.fill || shape.fill === "none")

function subpaths(shape: BodyShape): string[] {
  if (shape.type === "text" || shape.fill === "grip") return []
  if (shape.type === "circle") return [circlePath(shape.cx, shape.cy, shape.r)]
  if (shape.type === "rect") return [rectPath(shape)]
  return shape.d.split(/(?=M)/).map((s) => s.trim()).filter(Boolean)
}

function junctionOutline(def: ComponentDef): Outline {
  return { strokes: def.pins.filter((pin) => pin.kind === "node").map((pin) => circlePath(pin.x, pin.y, 0.2)).join(" "), hollow: "" }
}

export function selectionOutline(def: ComponentDef): Outline {
  const cached = outlines.get(def)
  if (cached) return cached
  const housing = def.body.filter((shape) => shape.type !== "text" && shape.fill === "board")
  const shapes = housing.length ? housing : def.body
  const strokes = shapes.flatMap(subpaths)
  const hollow = shapes.filter(isHollow).flatMap(subpaths).filter(isClosed)
  const outline = strokes.length ? { strokes: strokes.join(" "), hollow: hollow.join(" ") } : junctionOutline(def)
  outlines.set(def, outline)
  return outline
}

export function placementOf(object: PlacedObject, def: ComponentDef, grid: number) {
  const rotation = object.rotation ?? 0
  const box = objectSize(def, rotation)
  const w = def.width * grid
  const h = def.height * grid
  const left = object.x + (box.w * grid - w) / 2
  const top = object.y + (box.h * grid - h) / 2
  return { left, top, w, h, rotation }
}
