import { objectPins, objectRect, orientationOf, orientationSlot, orientedPins, unionOf, type PlacedPin, type Rect } from "./geometry"
import { getDef } from "./registry"
import { pinKey, type ComponentDef, type PinKind, type PlacedObject } from "./types"

const EPS = 0.01
const ROUNDING = 1e-3
const REACH = EPS + ROUNDING
const BUCKET_CELLS = 16

const cellKey = (x: number, y: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) | 0

const straddles = (offset: number, by = EPS) => (offset < -0.5 + by ? -1 : offset > 0.5 - by ? 1 : 0)

export type Contacts = {
  groups: ReadonlyMap<string, string>
  kinds: ReadonlyMap<string, PinKind>
}

const NOTHING: Contacts = { groups: new Map(), kinds: new Map() }

type PinTable = {
  grid: number
  pins: readonly PlacedPin[]
  x: Float64Array
  y: Float64Array
  left: number
  top: number
  right: number
  bottom: number
  cells: Map<number, number[]>
  closePairs: readonly number[]
}

const nearby: number[] = []

function pinsNear(table: Pick<PinTable, "x" | "y" | "cells">, x: number, y: number): readonly number[] {
  nearby.length = 0
  const cx = Math.round(x)
  const cy = Math.round(y)
  const sx = straddles(x - cx, REACH)
  const sy = straddles(y - cy, REACH)
  for (let dx = Math.min(sx, 0); dx <= Math.max(sx, 0); dx++) {
    for (let dy = Math.min(sy, 0); dy <= Math.max(sy, 0); dy++) {
      const cell = table.cells.get(cellKey(cx + dx, cy + dy))
      if (cell) for (const i of cell) if (Math.abs(table.x[i] - x) < REACH && Math.abs(table.y[i] - y) < REACH) nearby.push(i)
    }
  }
  return nearby
}

function tableOf(pins: readonly PlacedPin[], grid: number): PinTable {
  const x = new Float64Array(pins.length)
  const y = new Float64Array(pins.length)
  const cells = new Map<number, number[]>()
  const closePairs: number[] = []
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (let i = 0; i < pins.length; i++) {
    x[i] = pins[i].x * grid
    y[i] = pins[i].y * grid
    left = Math.min(left, x[i])
    top = Math.min(top, y[i])
    right = Math.max(right, x[i])
    bottom = Math.max(bottom, y[i])
    for (const j of pinsNear({ x, y, cells }, x[i], y[i])) closePairs.push(j, i)
    const key = cellKey(Math.round(x[i]), Math.round(y[i]))
    const cell = cells.get(key)
    if (cell) cell.push(i)
    else cells.set(key, [i])
  }
  return { grid, pins, x, y, left, top, right, bottom, cells, closePairs }
}

const NO_PINS = tableOf([], 0)

const tablesOf = new WeakMap<ComponentDef, (PinTable | undefined)[]>()

function pinTable(def: ComponentDef, object: PlacedObject, grid: number): PinTable {
  const orientation = orientationOf(object)
  let tables = tablesOf.get(def)
  if (!tables) tablesOf.set(def, (tables = []))
  const slot = orientationSlot(orientation)
  const known = tables[slot]
  if (known?.grid === grid) return known
  return (tables[slot] = tableOf(orientedPins(def, orientation).filter((pin) => pin.kind !== "nc"), grid))
}

type Touch = { key: string; kind: PinKind }

type Placed = {
  object: PlacedObject
  seen: number
  table: PinTable
  left: number
  top: number
  right: number
  bottom: number
  buckets: number[]
  own: Touch[] | null
  links: Map<Placed, Touch[]> | null
  met: number
}

const coincide = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) < EPS && Math.abs(ay - by) < EPS

const overlaps = (a: Placed, b: Placed) =>
  a.left - EPS <= b.right && b.left - EPS <= a.right && a.top - EPS <= b.bottom && b.top - EPS <= a.bottom

const touchOf = ({ object, table }: Placed, index: number): Touch => ({ key: pinKey(object.id, table.pins[index].id), kind: table.pins[index].kind })

function ownTouches(placed: Placed): Touch[] | null {
  const { object, table } = placed
  let touches: Touch[] | null = null
  for (let k = 0; k < table.closePairs.length; k += 2) {
    const i = table.closePairs[k]
    const j = table.closePairs[k + 1]
    if (table.pins[i].id === table.pins[j].id) continue
    if (coincide(object.x + table.x[i], object.y + table.y[i], object.x + table.x[j], object.y + table.y[j])) (touches ??= []).push(touchOf(placed, i), touchOf(placed, j))
  }
  return touches
}

function touchesBetween(a: Placed, b: Placed): Touch[] | null {
  const [few, many] = a.table.pins.length <= b.table.pins.length ? [a, b] : [b, a]
  let touches: Touch[] | null = null
  for (let i = 0; i < few.table.pins.length; i++) {
    const x = few.object.x + few.table.x[i]
    const y = few.object.y + few.table.y[i]
    if (x < many.left - EPS || x > many.right + EPS || y < many.top - EPS || y > many.bottom + EPS) continue
    for (const j of pinsNear(many.table, x - many.object.x, y - many.object.y)) {
      if (!coincide(x, y, many.object.x + many.table.x[j], many.object.y + many.table.y[j])) continue
      const mine = touchOf(few, i)
      const theirs = touchOf(many, j)
      if (mine.key !== theirs.key) (touches ??= []).push(mine, theirs)
    }
  }
  return touches
}

const linksOf = (placed: Placed) => (placed.links ??= new Map())

export class ContactIndex {
  private readonly defOf: (id: string) => ComponentDef | undefined
  private grid = 0
  private bucket = 0
  private placed = new Map<string, Placed>()
  private buckets = new Map<number, Placed[]>()
  private linked = new Set<Placed>()
  private contacts: Contacts = NOTHING
  private visit = 0
  private stamp = 0
  private touched = false

  constructor(defOf: (id: string) => ComponentDef | undefined = getDef) {
    this.defOf = defOf
  }

  of(objects: readonly PlacedObject[], grid: number): Contacts {
    if (grid !== this.grid) {
      this.grid = grid
      this.bucket = BUCKET_CELLS * grid
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

    if (fresh.length * 2 >= objects.length) {
      this.forget()
      for (const o of objects) if (!this.placed.has(o.id)) this.put(o, at)
    } else {
      for (const o of fresh) {
        const known = this.placed.get(o.id)
        if (known?.seen === at) continue
        if (known) this.take(known)
        this.put(o, at)
      }
      if (kept + fresh.length !== this.placed.size) {
        for (const [id, placed] of this.placed) {
          if (placed.seen === at) continue
          this.take(placed)
          this.placed.delete(id)
        }
      }
    }
    if (this.touched) {
      this.touched = false
      this.contacts = this.regroup()
    }
    return this.contacts
  }

  private forget() {
    if (this.linked.size) this.touched = true
    this.placed.clear()
    this.buckets.clear()
    this.linked.clear()
  }

  private take(placed: Placed) {
    for (const key of placed.buckets) {
      const list = this.buckets.get(key)
      if (!list) continue
      const at = list.indexOf(placed)
      if (at >= 0) list.splice(at, 1)
      if (list.length === 0) this.buckets.delete(key)
    }
    if (placed.own) this.touched = true
    if (placed.links) {
      for (const other of placed.links.keys()) {
        other.links?.delete(placed)
        if (other.links?.size === 0) other.links = null
        if (!other.links && !other.own) this.linked.delete(other)
      }
      this.touched = true
    }
    this.linked.delete(placed)
  }

  private put(object: PlacedObject, at: number) {
    const def = this.defOf(object.def)
    const table = def ? pinTable(def, object, this.grid) : NO_PINS
    const placed: Placed = {
      object,
      seen: at,
      table,
      left: object.x + table.left,
      top: object.y + table.top,
      right: object.x + table.right,
      bottom: object.y + table.bottom,
      buckets: [],
      own: null,
      links: null,
      met: 0,
    }
    this.placed.set(object.id, placed)
    if (table.pins.length === 0) return
    const stamp = (placed.met = ++this.stamp)
    const x0 = Math.floor((placed.left - EPS) / this.bucket)
    const y0 = Math.floor((placed.top - EPS) / this.bucket)
    const columns = Math.floor((placed.right + EPS) / this.bucket) - x0
    const rows = Math.floor((placed.bottom + EPS) / this.bucket) - y0
    for (let column = 0; column <= columns; column++) {
      for (let row = 0; row <= rows; row++) {
        const key = cellKey(x0 + column, y0 + row)
        placed.buckets.push(key)
        const list = this.buckets.get(key)
        if (!list) {
          this.buckets.set(key, [placed])
          continue
        }
        for (const other of list) {
          if (other.met === stamp) continue
          other.met = stamp
          if (!overlaps(placed, other)) continue
          const touches = touchesBetween(placed, other)
          if (touches) this.link(placed, other, touches)
        }
        list.push(placed)
      }
    }
    placed.own = ownTouches(placed)
    if (placed.own) {
      this.linked.add(placed)
      this.touched = true
    }
  }

  private link(a: Placed, b: Placed, touches: Touch[]) {
    linksOf(a).set(b, touches)
    linksOf(b).set(a, touches)
    this.linked.add(a)
    this.linked.add(b)
    this.touched = true
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
    const union = (a: Touch, b: Touch) => {
      kinds.set(a.key, a.kind)
      kinds.set(b.key, b.kind)
      const ra = find(a.key)
      const rb = find(b.key)
      if (ra === rb) return
      if (ra < rb) parent.set(rb, ra)
      else parent.set(ra, rb)
    }
    const unite = (touches: readonly Touch[]) => {
      for (let i = 0; i < touches.length; i += 2) union(touches[i], touches[i + 1])
    }
    for (const placed of this.linked) {
      if (placed.own) unite(placed.own)
      if (placed.links) for (const touches of placed.links.values()) unite(touches)
    }
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
