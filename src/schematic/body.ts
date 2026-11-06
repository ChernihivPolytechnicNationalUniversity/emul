import type { BodyShape, ComponentDef, PartDef, PinDef, Point } from "./types"

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
  if (shape.type === "soon") return [{ x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y + shape.h }]
  return pathPoints(shape.d)
}

const OUTLINE_TOLERANCE = 0.005

function ellipsePoints(center: Point, rx: number, ry: number, angle: number, start: number, span: number): Point[] {
  const step = 2 * Math.acos(Math.max(-1, 1 - OUTLINE_TOLERANCE / Math.max(rx, ry, OUTLINE_TOLERANCE)))
  const count = Math.max(4, Math.ceil(Math.abs(span) / step / 4) * 4)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return Array.from({ length: count + 1 }, (_, i) => {
    const t = start + span * i / count
    const x = rx * Math.cos(t)
    const y = ry * Math.sin(t)
    return { x: center.x + cos * x - sin * y, y: center.y + sin * x + cos * y }
  })
}

function arcPoints(from: Point, to: Point, radiusX: number, radiusY: number, degrees: number, large: number, sweep: number): Point[] {
  let rx = Math.abs(radiusX)
  let ry = Math.abs(radiusY)
  if (!rx || !ry || from.x === to.x && from.y === to.y) return [to]
  const angle = degrees * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = (from.x - to.x) / 2
  const dy = (from.y - to.y) / 2
  const x = cos * dx + sin * dy
  const y = -sin * dx + cos * dy
  const scale = Math.max(1, Math.hypot(x / rx, y / ry))
  rx *= scale
  ry *= scale
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * ry) ** 2 - (rx * y) ** 2 - (ry * x) ** 2) / ((rx * y) ** 2 + (ry * x) ** 2))
  const cx = factor * rx * y / ry
  const cy = -factor * ry * x / rx
  const center = { x: cos * cx - sin * cy + (from.x + to.x) / 2, y: sin * cx + cos * cy + (from.y + to.y) / 2 }
  const start = Math.atan2((y - cy) / ry, (x - cx) / rx)
  let span = Math.atan2((-y - cy) / ry, (-x - cx) / rx) - start
  if (sweep && span < 0) span += 2 * Math.PI
  if (!sweep && span > 0) span -= 2 * Math.PI
  return [...ellipsePoints(center, rx, ry, angle, start, span), to]
}

function curvePoints(points: readonly Point[]): Point[] {
  const a = points[0]
  const b = points[points.length - 1]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length2 = dx * dx + dy * dy
  const flat = points.slice(1, -1).every((p) => {
    const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= OUTLINE_TOLERANCE
  })
  if (flat) return [a, b]
  const left = [a]
  const right = [b]
  let row = [...points]
  while (row.length > 1) {
    row = row.slice(1).map((p, i) => ({ x: (row[i].x + p.x) / 2, y: (row[i].y + p.y) / 2 }))
    left.push(row[0])
    right.push(row[row.length - 1])
  }
  return [...curvePoints(left), ...curvePoints(right.reverse())]
}

function pathOutline(d: string): Point[] {
  const tokens = d.match(COMMAND) ?? []
  const points: Point[] = []
  let at = { x: 0, y: 0 }
  let start = at
  let control = at
  let previous = ""
  let command = "M"
  let i = 0
  const number = () => Number(tokens[i++])
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) command = tokens[i++]
    const upper = command.toUpperCase()
    const base = command !== upper ? at : { x: 0, y: 0 }
    const point = () => ({ x: base.x + number(), y: base.y + number() })
    const reflected = () => ({ x: 2 * at.x - control.x, y: 2 * at.y - control.y })
    if (upper === "Z") at = start
    else if (upper === "H") at = { x: base.x + number(), y: at.y }
    else if (upper === "V") at = { x: at.x, y: base.y + number() }
    else if (upper === "A") {
      const rx = number()
      const ry = number()
      const angle = number()
      const large = number()
      const sweep = number()
      const end = point()
      points.push(...arcPoints(at, end, rx, ry, angle, large, sweep))
      at = end
    } else if (upper === "C" || upper === "S") {
      const first = upper === "C" ? point() : previous === "C" || previous === "S" ? reflected() : at
      const second = point()
      const end = point()
      points.push(...curvePoints([at, first, second, end]))
      control = second
      at = end
    } else if (upper === "Q" || upper === "T") {
      const first = upper === "Q" ? point() : previous === "Q" || previous === "T" ? reflected() : at
      const end = point()
      points.push(...curvePoints([at, first, end]))
      control = first
      at = end
    } else at = point()
    points.push(at)
    if (upper === "M") {
      start = at
      command = command === "m" ? "l" : "L"
    }
    previous = upper
  }
  return points
}

function outlinePoints(shape: BodyShape): Point[] {
  if (shape.type === "text") return []
  if (shape.type === "circle") return ellipsePoints({ x: shape.cx, y: shape.cy }, shape.r, shape.r, 0, 0, 2 * Math.PI)
  if (shape.type === "path" || shape.type === "art") return pathOutline(shape.d)
  return rectCorners(shape)
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

export type Lead = readonly [pin: Point, body: Point]

type Subpath = { points: Point[]; straight: boolean }

const STRAIGHT = new Set(["M", "L", "H", "V"])

function subpathsOf(d: string): Subpath[] {
  const tokens = d.match(COMMAND) ?? []
  const subpaths: Subpath[] = []
  let current: Subpath | null = null
  let at = { x: 0, y: 0 }
  let start = at
  let command = "M"
  let i = 0
  const number = () => Number(tokens[i++])
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) command = tokens[i++]
    const upper = command.toUpperCase()
    const base = command !== upper ? at : { x: 0, y: 0 }
    if (upper === "Z") {
      if (current) current.straight = false
      at = start
      continue
    }
    if (upper === "M") {
      at = { x: base.x + number(), y: base.y + number() }
      start = at
      current = { points: [at], straight: true }
      subpaths.push(current)
      command = command === "m" ? "l" : "L"
      continue
    }
    if (!current) subpaths.push((current = { points: [at], straight: true }))
    if (!STRAIGHT.has(upper)) current.straight = false
    if (upper === "H") at = { x: base.x + number(), y: at.y }
    else if (upper === "V") at = { x: at.x, y: base.y + number() }
    else if (upper === "A") {
      i += 5
      at = { x: base.x + number(), y: base.y + number() }
    } else {
      const pairs = PAIRS[upper] ?? 1
      for (let k = 0; k < pairs; k++) at = { x: base.x + number(), y: base.y + number() }
    }
    current.points.push(at)
  }
  return subpaths
}

const EPS = 1e-6

const samePoint = (a: Point, b: Point) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS

const collinear = (a: Point, b: Point, c: Point) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < EPS && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) > 0

function leadFrom(points: readonly Point[]): { lead: Lead; rest: Point[] } {
  let end = 1
  while (end + 1 < points.length && collinear(points[end - 1], points[end], points[end + 1])) end++
  return { lead: [points[0], points[end]], rest: points.slice(end) }
}

function leadsOf(subpath: Subpath, pins: readonly PinDef[]): Lead[] {
  const { points } = subpath
  const onPin = (p: Point) => pins.some((pin) => samePoint(pin, p))
  if (!subpath.straight || points.length < 2) return []
  const leads: Lead[] = []
  let body = points
  if (onPin(body[0])) {
    const first = leadFrom(body)
    leads.push(first.lead)
    body = first.rest
  }
  if (body.length >= 2 && onPin(body[body.length - 1])) leads.push(leadFrom([...body].reverse()).lead)
  return leads
}

function onLeadPastItsBody(p: Point, [pin, body]: Lead) {
  if (samePoint(p, body)) return false
  const cross = (body.x - pin.x) * (p.y - pin.y) - (body.y - pin.y) * (p.x - pin.x)
  if (Math.abs(cross) > EPS) return false
  const along = (p.x - pin.x) * (body.x - pin.x) + (p.y - pin.y) * (body.y - pin.y)
  return along >= -EPS && along <= (body.x - pin.x) ** 2 + (body.y - pin.y) ** 2 + EPS
}

function shapeExtent(shape: BodyShape, pins: readonly PinDef[]): { leads: Lead[]; points: Point[] } {
  if (shape.type !== "path") return { leads: [], points: outlinePoints(shape) }
  const leads = subpathsOf(shape.d).flatMap((subpath) => leadsOf(subpath, pins))
  return { leads, points: outlinePoints(shape).filter((p) => !leads.some((lead) => onLeadPastItsBody(p, lead))) }
}

const PART_REACH = 0.5
const SWITCH_THROW = 0.4
const THINNEST_BODY = 0.4

function partExtent(part: PartDef): Point[] {
  if ("w" in part && "h" in part && typeof part.w === "number" && typeof part.h === "number") return rectCorners({ x: part.x, y: part.y, w: part.w, h: part.h })
  if ("span" in part && typeof part.span === "number") return rectCorners({ x: part.x, y: part.y - SWITCH_THROW, w: part.span, h: 2 * SWITCH_THROW })
  return rectCorners({ x: part.x - PART_REACH, y: part.y - PART_REACH, w: 2 * PART_REACH, h: 2 * PART_REACH })
}

function atLeastThick(r: Rect): Rect {
  const w = Math.max(r.w, THINNEST_BODY)
  const h = Math.max(r.h, THINNEST_BODY)
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h }
}

export type BodyAndLeads = { box: Rect; hull: readonly Point[]; leads: readonly Lead[] }

function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const turn = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (list: readonly Point[]) => {
    const out: Point[] = []
    for (const p of list) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= EPS) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }
  return [...half(sorted), ...half([...sorted].reverse())]
}

const rectCorners = (r: Rect): Point[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
]

const bodies = new WeakMap<ComponentDef, BodyAndLeads>()

export function bodyAndLeads(def: ComponentDef): BodyAndLeads {
  const cached = bodies.get(def)
  if (cached) return cached
  const leads: Lead[] = []
  const points: Point[] = []
  for (const shape of def.body) {
    const extent = shapeExtent(shape, def.pins)
    leads.push(...extent.leads)
    points.push(...extent.points)
  }
  for (const pin of def.pins) if (!leads.some(([at]) => samePoint(at, pin))) points.push({ x: pin.x, y: pin.y })
  for (const part of def.parts) points.push(...partExtent(part))
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const box = points.length ? atLeastThick({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }) : bodyBounds(def)
  const hull = convexHull(points)
  const found = { box, hull: hull.length >= 3 && box.w > THINNEST_BODY && box.h > THINNEST_BODY ? hull : rectCorners(box), leads }
  bodies.set(def, found)
  return found
}
