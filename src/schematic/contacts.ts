import { objectPins, type ObjectPin } from "./geometry"
import type { PinKind, PlacedObject } from "./types"

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
