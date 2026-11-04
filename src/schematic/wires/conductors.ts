import { GRID } from "../grid"
import type { Point } from "../types"
import { Foreign, type Box } from "./clear-path"
import { contains } from "./segment"

const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y

export type Fixed = { at: Point; net: string; socket: boolean }

export type Clash = { wires: Set<number>; points: boolean }

const BUCKET = 8 * GRID

export class Conductors {
  private readonly segments = new Map<number, { laid: number; net: string; a: Point; b: Point }[]>()
  private readonly fixed = new Map<number, Fixed[]>()
  private readonly byLaid = new Map<number, { a: Point; b: Point; net: string }[]>()

  private static bucket(x: number, y: number) {
    return Math.floor(x / BUCKET) * 100_003 + Math.floor(y / BUCKET)
  }

  private static spanned(a: Point, b: Point): number[] {
    const out: number[] = []
    const x0 = Math.floor(Math.min(a.x, b.x) / BUCKET)
    const x1 = Math.floor(Math.max(a.x, b.x) / BUCKET)
    const y0 = Math.floor(Math.min(a.y, b.y) / BUCKET)
    const y1 = Math.floor(Math.max(a.y, b.y) / BUCKET)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(x * 100_003 + y)
    return out
  }

  addFixed(point: Fixed) {
    const b = Conductors.bucket(point.at.x, point.at.y)
    const list = this.fixed.get(b)
    if (list) list.push(point)
    else this.fixed.set(b, [point])
  }

  lay(laid: number, net: string, pts: readonly Point[]) {
    const own: { a: Point; b: Point; net: string }[] = []
    for (let i = 1; i < pts.length; i++) {
      const s = { laid, net, a: pts[i - 1], b: pts[i] }
      own.push(s)
      for (const b of Conductors.spanned(s.a, s.b)) {
        const list = this.segments.get(b)
        if (list) list.push(s)
        else this.segments.set(b, [s])
      }
    }
    this.byLaid.set(laid, own)
  }

  lift(laid: number) {
    for (const s of this.byLaid.get(laid) ?? []) for (const b of Conductors.spanned(s.a, s.b)) this.segments.set(b, (this.segments.get(b) ?? []).filter((t) => t.laid !== laid))
    this.byLaid.delete(laid)
  }

  clashes(own: ReadonlySet<string>, pts: readonly Point[]): Clash {
    const wires = new Set<number>()
    let points = false
    for (let i = 1; i < pts.length; i++) {
      const s = { id: "", a: pts[i - 1], b: pts[i] }
      for (const b of Conductors.spanned(s.a, s.b)) {
        for (const t of this.segments.get(b) ?? []) {
          if (own.has(t.net) || wires.has(t.laid)) continue
          const u = { id: "", a: t.a, b: t.b }
          if (contains(s, t.a) || contains(s, t.b) || contains(u, s.a) || contains(u, s.b)) wires.add(t.laid)
        }
        for (const f of this.fixed.get(b) ?? []) {
          if (own.has(f.net) || !contains(s, f.at)) continue
          if (!f.socket || same(f.at, s.a) || same(f.at, s.b)) points = true
        }
      }
    }
    return { wires, points }
  }

  foreign(own: ReadonlySet<string>, around: Box, bodies: readonly Box[]): Foreign {
    const lattice = new Foreign(around)
    const within = (p: Point) => p.x >= around.x && p.x <= around.x + around.w && p.y >= around.y && p.y <= around.y + around.h
    for (const list of this.fixed.values())
      for (const f of list) if (!own.has(f.net) && within(f.at)) lattice.pin(f.at, f.socket)
    for (const laid of this.byLaid.values())
      for (const s of laid) {
        if (own.has(s.net)) continue
        lattice.end(s.a)
        lattice.end(s.b)
        const horizontal = s.a.y === s.b.y
        const lo = horizontal ? Math.max(Math.min(s.a.x, s.b.x), around.x) : Math.max(Math.min(s.a.y, s.b.y), around.y)
        const hi = horizontal ? Math.min(Math.max(s.a.x, s.b.x), around.x + around.w) : Math.min(Math.max(s.a.y, s.b.y), around.y + around.h)
        const fixed = horizontal ? s.a.y : s.a.x
        if (horizontal ? fixed < around.y || fixed > around.y + around.h : fixed < around.x || fixed > around.x + around.w) continue
        for (let v = Math.ceil(lo / (GRID / 2)) * (GRID / 2); v <= hi; v += GRID / 2) lattice.run(horizontal ? { x: v, y: fixed } : { x: fixed, y: v }, horizontal)
      }
    for (const body of bodies) lattice.body(body)
    return lattice
  }
}

export const clearOf = (conductors: Conductors, own: ReadonlySet<string>, pts: readonly Point[] | null): pts is Point[] => {
  if (!pts?.length) return false
  const clash = conductors.clashes(own, pts)
  return !clash.points && !clash.wires.size
}
