import type { BodyShape, ComponentDef, PinDef, Point } from "./types"

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
  if (shape.type !== "path") return { leads: [], points: shapePoints(shape) }
  const leads = subpathsOf(shape.d).flatMap((subpath) => leadsOf(subpath, pins))
  return { leads, points: pathPoints(shape.d).filter((p) => !leads.some((lead) => onLeadPastItsBody(p, lead))) }
}

export type BodyAndLeads = { box: Rect; leads: readonly Lead[] }

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
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const box = points.length ? { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } : bodyBounds(def)
  const found = { box, leads }
  bodies.set(def, found)
  return found
}
