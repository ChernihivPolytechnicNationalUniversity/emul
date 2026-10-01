import { objectPins, objectRect, unionOf, type ObjectPin, type PlacedPin, type Rect } from "./geometry"
import { getDef } from "./registry"
import type { ComponentDef, PinKind, PlacedObject } from "./types"

const EPS = 0.01

const cellKey = (x: number, y: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) | 0

const straddles = (offset: number) => (offset < -0.5 + EPS ? -1 : offset > 0.5 - EPS ? 1 : 0)

const touching = (a: ObjectPin, b: ObjectPin) =>
  a.key !== b.key && Math.abs(a.point.x - b.point.x) < EPS && Math.abs(a.point.y - b.point.y) < EPS

export type Contacts = {
  groups: ReadonlyMap<string, string>
  kinds: ReadonlyMap<string, PinKind>
}

const NOTHING: Contacts = { groups: new Map(), kinds: new Map() }

export class ContactIndex {
  private grid = 0
  private placed = new Map<string, { object: PlacedObject; seen: number }>()
  private cells = new Map<number, ObjectPin[]>()
  private pairs = new Map<number, ObjectPin[]>()
  private straddling = new Map<string, ObjectPin[]>()
  private contacts: Contacts = NOTHING
  private visit = 0

  of(objects: readonly PlacedObject[], grid: number): Contacts {
    if (grid !== this.grid) {
      this.grid = grid
      this.forget()
    }
    const at = ++this.visit
    const fresh: PlacedObject[] = []
    let kept = 0
    for (const o of objects) {
      const known = this.placed.get(o.id)
      if (known?.seen === at) continue
      if (known && known.object === o) {
        known.seen = at
        kept++
        continue
      }
      fresh.push(o)
    }
    if (fresh.length === 0 && kept === this.placed.size) return this.contacts

    const dirty = new Set<number>()
    if (fresh.length * 2 >= objects.length) {
      this.forget()
      for (const o of objects) if (!this.placed.has(o.id)) this.put(o, at, dirty)
    } else {
      for (const o of fresh) {
        const known = this.placed.get(o.id)
        if (known?.seen === at) continue
        if (known) this.take(known.object, dirty)
        this.put(o, at, dirty)
      }
      if (kept + fresh.length !== this.placed.size) {
        for (const [id, placed] of this.placed) {
          if (placed.seen === at) continue
          this.take(placed.object, dirty)
          this.placed.delete(id)
        }
      }
    }
    for (const key of dirty) this.sweep(key)
    this.contacts = this.regroup()
    return this.contacts
  }

  private forget() {
    this.placed.clear()
    this.cells.clear()
    this.pairs.clear()
    this.straddling.clear()
  }

  private take(object: PlacedObject, dirty: Set<number>) {
    for (const pin of objectPins(object, this.grid)) {
      if (pin.pin.kind === "nc") continue
      const key = cellKey(Math.round(pin.point.x), Math.round(pin.point.y))
      const cell = this.cells.get(key)
      if (!cell) continue
      const at = cell.indexOf(pin)
      if (at >= 0) cell.splice(at, 1)
      if (cell.length === 0) this.cells.delete(key)
      dirty.add(key)
    }
    this.straddling.delete(object.id)
  }

  private put(object: PlacedObject, at: number, dirty: Set<number>) {
    let edges: ObjectPin[] | null = null
    for (const pin of objectPins(object, this.grid)) {
      if (pin.pin.kind === "nc") continue
      const cx = Math.round(pin.point.x)
      const cy = Math.round(pin.point.y)
      const key = cellKey(cx, cy)
      const cell = this.cells.get(key)
      if (cell) cell.push(pin)
      else this.cells.set(key, [pin])
      dirty.add(key)
      if (straddles(pin.point.x - cx) || straddles(pin.point.y - cy)) (edges ??= []).push(pin)
    }
    this.placed.set(object.id, { object, seen: at })
    if (edges) this.straddling.set(object.id, edges)
  }

  private sweep(key: number) {
    const cell = this.cells.get(key)
    if (!cell || cell.length < 2) {
      this.pairs.delete(key)
      return
    }
    let found: ObjectPin[] | null = null
    for (let i = 0; i < cell.length; i++) {
      for (let j = i + 1; j < cell.length; j++) {
        if (touching(cell[i], cell[j])) (found ??= []).push(cell[i], cell[j])
      }
    }
    if (found) this.pairs.set(key, found)
    else this.pairs.delete(key)
  }

  private acrossCells(): ObjectPin[] {
    const out: ObjectPin[] = []
    for (const edges of this.straddling.values()) {
      for (const a of edges) {
        const cx = Math.round(a.point.x)
        const cy = Math.round(a.point.y)
        const sx = straddles(a.point.x - cx)
        const sy = straddles(a.point.y - cy)
        for (let dx = sx < 0 ? -1 : 0; dx <= (sx > 0 ? 1 : 0); dx++) {
          for (let dy = sy < 0 ? -1 : 0; dy <= (sy > 0 ? 1 : 0); dy++) {
            if (dx === 0 && dy === 0) continue
            const other = this.cells.get(cellKey(cx + dx, cy + dy))
            if (other) for (const b of other) if (touching(a, b)) out.push(a, b)
          }
        }
      }
    }
    return out
  }

  private regroup(): Contacts {
    const parent = new Map<string, string>()
    const find = (k: string): string => {
      const p = parent.get(k)
      if (p === undefined || p === k) return k
      const root = find(p)
      parent.set(k, root)
      return root
    }
    const kinds = new Map<string, PinKind>()
    const union = (a: ObjectPin, b: ObjectPin) => {
      kinds.set(a.key, a.pin.kind)
      kinds.set(b.key, b.pin.kind)
      const ra = find(a.key)
      const rb = find(b.key)
      if (ra === rb) return
      if (ra < rb) parent.set(rb, ra)
      else parent.set(ra, rb)
    }
    for (const flat of this.pairs.values()) for (let i = 0; i < flat.length; i += 2) union(flat[i], flat[i + 1])
    const across = this.acrossCells()
    for (let i = 0; i < across.length; i += 2) union(across[i], across[i + 1])
    if (kinds.size === 0) return NOTHING
    const groups = new Map<string, string>()
    for (const key of kinds.keys()) groups.set(key, find(key))
    return this.unchanged(groups) ? this.contacts : { groups, kinds }
  }

  private unchanged(groups: ReadonlyMap<string, string>) {
    const before = this.contacts.groups
    if (before.size !== groups.size) return false
    for (const [key, root] of groups) if (before.get(key) !== root) return false
    return true
  }
}

const defaultContacts = new ContactIndex()

export function pinContacts(objects: readonly PlacedObject[], grid: number): Contacts {
  return defaultContacts.of(objects, grid)
}

export type ContactChange = { object: PlacedObject; pin: PlacedPin; contact: boolean; touching: readonly string[] }

type SpotPin = { object: PlacedObject; key: string; pin: PlacedPin; x: number; y: number }

const NO_CHANGES: ReadonlyMap<string, ContactChange> = new Map()

export class PointGrid<T extends { x: number; y: number }> {
  private readonly cells = new Map<number, T[]>()

  add(pins: readonly T[]) {
    for (const p of pins) {
      const key = cellKey(Math.round(p.x), Math.round(p.y))
      const cell = this.cells.get(key)
      if (cell) cell.push(p)
      else this.cells.set(key, [p])
    }
  }

  at(x: number, y: number): T[] {
    const cx = Math.round(x)
    const cy = Math.round(y)
    const sx = straddles(x - cx)
    const sy = straddles(y - cy)
    const found: T[] = []
    for (let dx = Math.min(sx, 0); dx <= Math.max(sx, 0); dx++) {
      for (let dy = Math.min(sy, 0); dy <= Math.max(sy, 0); dy++) {
        for (const p of this.cells.get(cellKey(cx + dx, cy + dy)) ?? []) if (Math.abs(p.x - x) < EPS && Math.abs(p.y - y) < EPS) found.push(p)
      }
    }
    return found
  }

  has(x: number, y: number) {
    return this.at(x, y).length > 0
  }
}

const touchesAnother = (grid: PointGrid<SpotPin>, p: SpotPin) => grid.at(p.x, p.y).some((q) => q.key !== p.key)

function spotPins(object: PlacedObject, grid: number): SpotPin[] {
  const pins: SpotPin[] = []
  for (const { key, pin, point } of objectPins(object, grid)) if (pin.kind !== "nc") pins.push({ object, key, pin, x: point.x, y: point.y })
  return pins
}

const overhangOf = new WeakMap<ComponentDef, number>()

function pinOverhangCells(def: ComponentDef | undefined): number {
  if (!def) return 0
  let overhang = overhangOf.get(def)
  if (overhang === undefined) {
    overhang = 0
    for (const pin of def.pins) overhang = Math.max(overhang, -pin.x, pin.x - def.width, -pin.y, pin.y - def.height)
    overhangOf.set(def, overhang)
  }
  return overhang
}

export function contactsAfterMove(
  objects: readonly PlacedObject[],
  moving: ReadonlySet<string>,
  grid: number,
  near: (area: Rect) => readonly PlacedObject[] = () => objects,
): (dx: number, dy: number) => ReadonlyMap<string, ContactChange> {
  const carried = objects.filter((o) => moving.has(o.id))
  const movingPins = carried.flatMap((o) => spotPins(o, grid))
  if (!movingPins.length) return () => NO_CHANGES
  const carriedGrid = new PointGrid<SpotPin>()
  carriedGrid.add(movingPins)
  const touchingEachOther = new Set(movingPins.filter((p) => touchesAnother(carriedGrid, p)).map((p) => p.key))
  let overhang = 0
  for (const def of new Set(objects.map((o) => getDef(o.def)))) overhang = Math.max(overhang, pinOverhangCells(def))
  const margin = (overhang + 1) * grid
  const areas = carried.map((o) => {
    const own = unionOf([objectRect(o, grid), ...objectPins(o, grid).map(({ point }) => ({ x: point.x, y: point.y, w: 0, h: 0 }))])
    return { x: own.x - margin, y: own.y - margin, w: own.w + margin * 2, h: own.h + margin * 2 }
  })

  const fixedGrid = new PointGrid<SpotPin>()
  const indexed = new Set<string>()
  const underMove = (dx: number, dy: number) => {
    for (const area of areas) {
      for (const o of near({ x: area.x + dx, y: area.y + dy, w: area.w, h: area.h })) {
        if (moving.has(o.id) || indexed.has(o.id)) continue
        indexed.add(o.id)
        fixedGrid.add(spotPins(o, grid))
      }
    }
    const met = new Map<string, { pin: SpotPin; touching: string[] }>()
    const meet = (p: SpotPin, other: SpotPin) => {
      const known = met.get(p.key)
      if (known) known.touching.push(other.key)
      else met.set(p.key, { pin: p, touching: [other.key] })
    }
    for (const p of movingPins) {
      for (const f of fixedGrid.at(p.x + dx, p.y + dy)) {
        meet(p, f)
        meet(f, p)
      }
    }
    return met
  }
  const touchesOwnSide = (p: SpotPin) => (moving.has(p.object.id) ? touchingEachOther.has(p.key) : touchesAnother(fixedGrid, p))
  const atRest = underMove(0, 0)

  return (dx, dy) => {
    if (!dx && !dy) return NO_CHANGES
    const met = underMove(dx, dy)
    let changes: Map<string, ContactChange> | null = null
    for (const { pin: p } of [...atRest.values(), ...met.values()]) {
      if (changes?.has(p.key) || touchesOwnSide(p)) continue
      const now = met.get(p.key)
      if (!!now !== atRest.has(p.key)) (changes ??= new Map()).set(p.key, { object: p.object, pin: p.pin, contact: !!now, touching: now?.touching ?? [] })
    }
    return changes ?? NO_CHANGES
  }
}
