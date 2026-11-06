import type { Run } from "./circuit"
import { GRID, toPath, type Point } from "./geometry"
import { exactPointCode, type PointCode, type WirePin } from "./wires/segment"

const LEAD_CELLS = 0.3

export type Leads = { start?: Point; end?: Point }

export type PinCorner = { at: Point; a: Point; b: Point }

export type TurnPins = { leads: Map<string, { start?: string; end?: string }>; corners: (readonly [string, string])[] }

export const leadEnd = (pin: WirePin): Point => ({ x: pin.at.x - pin.out!.x * LEAD_CELLS * GRID, y: pin.at.y - pin.out!.y * LEAD_CELLS * GRID })

export function turnsAtPins(runs: readonly Run[], pins: readonly WirePin[]): { leads: Map<string, Leads>; corners: PinCorner[]; pins: TurnPins } {
  const pinsAt = new Map<PointCode, WirePin[]>()
  for (const p of pins) {
    const key = exactPointCode(p.at)
    const list = pinsAt.get(key)
    if (list) list.push(p)
    else pinsAt.set(key, [p])
  }
  const endsAt = new Map<PointCode, number>()
  const count = (p: Point) => {
    const code = exactPointCode(p)
    endsAt.set(code, (endsAt.get(code) ?? 0) + 1)
  }
  for (const run of runs) for (const s of run.segments) { count(s.a); count(s.b) }
  const leadAt = (at: Point, next: Point): WirePin | undefined => {
    const key = exactPointCode(at)
    const here = pinsAt.get(key)
    if (here?.length !== 1 || endsAt.get(key) !== 1) return undefined
    const pin = here[0]
    if (!pin.out || pin.socket) return undefined
    const d = { x: Math.sign(next.x - at.x), y: Math.sign(next.y - at.y) }
    if (d.x * pin.out.x + d.y * pin.out.y !== 0) return undefined
    return pin
  }
  const leads = new Map<string, Leads>()
  const turned: TurnPins = { leads: new Map(), corners: [] }
  for (const run of runs) {
    const pts = run.points
    if (pts.length < 2) continue
    const start = leadAt(pts[0], pts[1])
    const end = leadAt(pts[pts.length - 1], pts[pts.length - 2])
    if (!start && !end) continue
    leads.set(run.id, { ...(start && { start: leadEnd(start) }), ...(end && { end: leadEnd(end) }) })
    turned.leads.set(run.id, { ...(start && { start: start.key }), ...(end && { end: end.key }) })
  }
  const corners: PinCorner[] = []
  for (const [key, here] of pinsAt) {
    if (here.length !== 2 || endsAt.has(key)) continue
    const [p, q] = here[0].key < here[1].key ? here : [here[1], here[0]]
    if (!p.out || !q.out || p.socket || q.socket || p.out.x * q.out.x + p.out.y * q.out.y !== 0) continue
    corners.push({ at: p.at, a: leadEnd(p), b: leadEnd(q) })
    turned.corners.push([p.key, q.key])
  }
  return { leads, corners, pins: turned }
}

export const towards = (from: Point, to: Point, by: number): Point => {
  const len = Math.hypot(to.x - from.x, to.y - from.y)
  return len ? { x: from.x + ((to.x - from.x) / len) * by, y: from.y + ((to.y - from.y) / len) * by } : from
}

export function runPath(pts: readonly Point[], radius: number, leads?: Leads): string {
  if (pts.length < 2 || !leads || (!leads.start && !leads.end)) return toPath([...pts], radius)
  const core = [...pts]
  let head = ""
  let tail = ""
  if (leads.start) {
    const r = Math.min(radius, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) / 2)
    const p1 = towards(pts[0], pts[1], r)
    head = `M${leads.start.x} ${leads.start.y} Q${pts[0].x} ${pts[0].y} ${p1.x} ${p1.y}`
    core[0] = p1
  }
  if (leads.end) {
    const n = pts.length
    const r = Math.min(radius, Math.hypot(pts[n - 1].x - pts[n - 2].x, pts[n - 1].y - pts[n - 2].y) / 2)
    const pn = towards(pts[n - 1], pts[n - 2], r)
    tail = ` Q${pts[n - 1].x} ${pts[n - 1].y} ${leads.end.x} ${leads.end.y}`
    core[n - 1] = pn
  }
  const body = toPath(core, radius)
  return head ? `${head} ${body.replace(/^M/, "L")}${tail}` : `${body}${tail}`
}
