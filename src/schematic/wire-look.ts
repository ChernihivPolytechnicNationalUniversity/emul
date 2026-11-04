import type { Run } from "./circuit"
import { GRID, toPath, type Point } from "./geometry"
import { pointKey, type WirePin } from "./wires/segment"

const LEAD_CELLS = 0.3

export type Leads = { start?: Point; end?: Point }

export type PinCorner = { at: Point; a: Point; b: Point }

export function turnsAtPins(runs: readonly Run[], pins: readonly WirePin[]): { leads: Map<string, Leads>; corners: PinCorner[] } {
  const pinsAt = new Map<string, WirePin[]>()
  for (const p of pins) {
    const key = pointKey(p.at)
    const list = pinsAt.get(key)
    if (list) list.push(p)
    else pinsAt.set(key, [p])
  }
  const endsAt = new Map<string, number>()
  for (const run of runs) for (const s of run.segments) for (const p of [s.a, s.b]) endsAt.set(pointKey(p), (endsAt.get(pointKey(p)) ?? 0) + 1)
  const inward = (pin: WirePin): Point => ({ x: pin.at.x - pin.out!.x * LEAD_CELLS * GRID, y: pin.at.y - pin.out!.y * LEAD_CELLS * GRID })
  const leadAt = (at: Point, next: Point): Point | undefined => {
    const key = pointKey(at)
    const here = pinsAt.get(key)
    if (here?.length !== 1 || endsAt.get(key) !== 1) return undefined
    const pin = here[0]
    if (!pin.out) return undefined
    const d = { x: Math.sign(next.x - at.x), y: Math.sign(next.y - at.y) }
    if (d.x * pin.out.x + d.y * pin.out.y !== 0) return undefined
    return inward(pin)
  }
  const leads = new Map<string, Leads>()
  for (const run of runs) {
    const pts = run.points
    if (pts.length < 2) continue
    const start = leadAt(pts[0], pts[1])
    const end = leadAt(pts[pts.length - 1], pts[pts.length - 2])
    if (start || end) leads.set(run.id, { ...(start && { start }), ...(end && { end }) })
  }
  const corners: PinCorner[] = []
  for (const [key, here] of pinsAt) {
    if (here.length !== 2 || endsAt.has(key)) continue
    const [p, q] = here
    if (!p.out || !q.out || p.out.x * q.out.x + p.out.y * q.out.y !== 0) continue
    corners.push({ at: p.at, a: inward(p), b: inward(q) })
  }
  return { leads, corners }
}

const towards = (from: Point, to: Point, by: number): Point => {
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
