import type { BodyShape, ComponentDef, Point } from "./types"

type Rect = { x: number; y: number; w: number; h: number }

const COMMAND = /[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g
const PAIRS: Record<string, number> = { M: 1, L: 1, T: 1, C: 3, S: 2, Q: 2 }

function pathPoints(d: string): Point[] {
  const tokens = d.match(COMMAND) ?? []
  const points: Point[] = []
  let at = { x: 0, y: 0 }
  let start = at
  let command = "M"
  let i = 0
  const number = () => Number(tokens[i++])
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) command = tokens[i++]
    const upper = command.toUpperCase()
    const relative = command !== upper
    const base = relative ? at : { x: 0, y: 0 }
    if (upper === "Z") {
      at = start
      continue
    }
    if (upper === "H") at = { x: base.x + number(), y: at.y }
    else if (upper === "V") at = { x: at.x, y: base.y + number() }
    else if (upper === "A") {
      const rx = number()
      const ry = number()
      i += 3
      at = { x: base.x + number(), y: base.y + number() }
      points.push({ x: at.x - rx, y: at.y - ry }, { x: at.x + rx, y: at.y + ry })
    } else {
      for (let k = 0; k < (PAIRS[upper] ?? 1); k++) {
        const p = { x: base.x + number(), y: base.y + number() }
        points.push(p)
        at = p
      }
    }
    points.push(at)
    if (upper === "M") {
      start = at
      command = relative ? "l" : "L"
    }
  }
  return points
}

function shapePoints(shape: BodyShape): Point[] {
  if (shape.type === "text") return []
  if (shape.type === "rect") return [{ x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y + shape.h }]
  if (shape.type === "circle") return [{ x: shape.cx - shape.r, y: shape.cy - shape.r }, { x: shape.cx + shape.r, y: shape.cy + shape.r }]
  return pathPoints(shape.d)
}

const bounds = new WeakMap<ComponentDef, Rect>()

export function bodyBounds(def: ComponentDef): Rect {
  const cached = bounds.get(def)
  if (cached) return cached
  const points = [...def.body.flatMap(shapePoints), ...def.pins.map((pin) => ({ x: pin.x, y: pin.y }))]
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const rect = points.length
    ? { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    : { x: 0, y: 0, w: def.width, h: def.height }
  bounds.set(def, rect)
  return rect
}
