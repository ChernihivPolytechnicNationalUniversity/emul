import { wirePins } from "./freeze"
import { GRID, objectRect, objectSize, orientationOf, orientationSlot, orientedPins, type Point, type Rect } from "./geometry"
import { getDef, getDefsVersion, getLibraryVersion } from "./registry"
import { SpatialIndex } from "./spatial"
import type { ComponentDef, PlacedObject } from "./types"
import { OverlayMap } from "./wires/overlay-map"
import { pointKey, type WirePin, type WireSegment } from "./wires/segment"

const cachedPins = new WeakMap<PlacedObject, { def: ComponentDef | undefined; pins: readonly WirePin[] }>()

export function pinsOf(objects: readonly PlacedObject[]): WirePin[] {
  const out: WirePin[] = []
  for (const o of objects) {
    out.push(...pinsForObject(o))
  }
  return out
}

export function pinsForObject(o: PlacedObject): readonly WirePin[] {
  const def = getDef(o.def)
  let cached = cachedPins.get(o)
  if (!cached || cached.def !== def) cachedPins.set(o, (cached = { def, pins: def ? wirePins([o]) : [] }))
  return cached.pins
}

const duplicatePins = new WeakMap<ComponentDef, ReadonlySet<string>>()

function duplicatesOf(object: PlacedObject): ReadonlySet<string> {
  const def = getDef(object.def)
  if (!def) return new Set()
  const cached = duplicatePins.get(def)
  if (cached) return cached
  const points = new Map<string, string[]>()
  for (const pin of def.pins) {
    const key = `${pin.x},${pin.y}`
    const group = points.get(key)
    if (group) group.push(pin.id)
    else points.set(key, [pin.id])
  }
  const duplicates = new Set([...points.values()].filter((list) => list.length > 1).flat())
  duplicatePins.set(def, duplicates)
  return duplicates
}

const pinMaps = new WeakMap<PlacedObject, { pins: readonly WirePin[]; at: Map<string, WirePin[]>; keys: Map<string, WirePin> }>()

function mapsOf(o: PlacedObject) {
  const pins = pinsForObject(o)
  const cached = pinMaps.get(o)
  if (cached?.pins === pins) return cached
  const at = new Map<string, WirePin[]>()
  const keys = new Map<string, WirePin>()
  for (const p of pins) {
    keys.set(p.key, p)
    const key = pointKey(p.at)
    const list = at.get(key)
    if (list) list.push(p)
    else at.set(key, [p])
  }
  const result = { pins, at, keys }
  pinMaps.set(o, result)
  return result
}

const pinExtents = new WeakMap<ComponentDef, Map<number, Rect>>()
const pinBoxes = new WeakMap<PlacedObject, { def: ComponentDef | undefined; box: Rect }>()

function pinBounds(object: PlacedObject): Rect {
  const def = getDef(object.def)
  const cached = pinBoxes.get(object)
  if (cached && cached.def === def) return cached.box
  let box = objectRect(object, GRID)
  if (def) {
    const orientation = orientationOf(object)
    const slot = orientationSlot(orientation)
    let variants = pinExtents.get(def)
    if (!variants) pinExtents.set(def, variants = new Map())
    let relative = variants.get(slot)
    if (!relative) {
      const size = objectSize(def, orientation.rotation)
      let x = 0
      let y = 0
      let right = size.w
      let bottom = size.h
      for (const pin of orientedPins(def, orientation)) {
        x = Math.min(x, pin.x)
        y = Math.min(y, pin.y)
        right = Math.max(right, pin.x)
        bottom = Math.max(bottom, pin.y)
      }
      relative = { x: x * GRID, y: y * GRID, w: (right - x) * GRID, h: (bottom - y) * GRID }
      variants.set(slot, relative)
    }
    box = { x: object.x + relative.x, y: object.y + relative.y, w: relative.w, h: relative.h }
  }
  pinBoxes.set(object, { def, box })
  return box
}

const meets = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
const translations = new WeakMap<readonly PlacedObject[], { from: WeakRef<readonly PlacedObject[]>; fromWires: WeakRef<readonly WireSegment[]>; wires: WeakRef<readonly WireSegment[]>; x: number; y: number }>()

export function translatedObjects(before: readonly PlacedObject[], after: PlacedObject[], x: number, y: number, fromWires: readonly WireSegment[], wires: readonly WireSegment[]): PlacedObject[] {
  translations.set(after, { from: new WeakRef(before), fromWires: new WeakRef(fromWires), wires: new WeakRef(wires), x, y })
  return editedObjects(before, after)
}

export const translationOf = (objects: readonly PlacedObject[], wires: readonly WireSegment[]) => {
  const shift = translations.get(objects)
  const from = shift?.from.deref()
  const fromWires = shift?.fromWires.deref()
  return shift && from && fromWires && shift.wires.deref() === wires ? { from, fromWires, x: shift.x, y: shift.y } : undefined
}

const parents = new WeakMap<readonly PlacedObject[], WeakRef<readonly PlacedObject[]>>()
const objectEdits = new WeakMap<readonly PlacedObject[], { from: WeakRef<readonly PlacedObject[]>; ids: readonly string[] }>()

export function editedObjects(before: readonly PlacedObject[], after: PlacedObject[], ids?: Iterable<string>): PlacedObject[] {
  if (before !== after) {
    parents.set(after, new WeakRef(before))
    if (ids) objectEdits.set(after, { from: new WeakRef(before), ids: [...new Set(ids)] })
  }
  return after
}

const indices = new WeakMap<readonly PlacedObject[], { version: string; index: DocumentPins }>()

type PinEnds = { wires: readonly WireSegment[]; counts: Map<string, number>; offset: Point }

export type PinState = {
  wires: readonly WireSegment[]
  byOwner: ReadonlyMap<string, readonly WirePin[]>
  ends: PinEnds
  readonly pins: readonly WirePin[]
}

function pinState(wires: readonly WireSegment[], byOwner: PinState["byOwner"], ends: PinEnds, initial?: readonly WirePin[]): PinState {
  let pins = initial
  return { wires, byOwner, ends, get pins() { return pins ??= [...byOwner.values()].flat() } }
}

export class DocumentPins {
  readonly version = `${getDefsVersion()}:${getLibraryVersion()}`
  readonly objects: ReadonlyMap<string, PlacedObject>
  readonly spatial: SpatialIndex
  private readonly pinSpatial: SpatialIndex
  private readonly positions: ReadonlyMap<string, number>
  private changedFrom: WeakRef<DocumentPins> | undefined
  private changedObjects: { before: PlacedObject[]; after: PlacedObject[] } | undefined
  pinDelta: { added: WirePin[]; removed: WirePin[] } | undefined
  private activeCache: PinState | undefined
  private allPins: readonly WirePin[] | undefined

  readonly source: readonly PlacedObject[]

  constructor(source: readonly PlacedObject[], previous?: DocumentPins) {
    this.source = source
    const edit = objectEdits.get(source)
    if (previous && edit?.from.deref() === previous.source && source.length === previous.source.length) {
      const changed = new Map<string, PlacedObject>()
      const indices: number[] = []
      for (const id of edit.ids) {
        const at = previous.positions.get(id)
        if (at === undefined || source[at].id !== id) continue
        changed.set(id, source[at])
        indices.push(at)
      }
      this.objects = new OverlayMap(previous.objects, changed, new Set())
      this.positions = previous.positions
      this.spatial = new SpatialIndex(source, GRID, previous.spatial, indices)
      this.pinSpatial = new SpatialIndex(source, GRID, previous.pinSpatial, indices, pinBounds)
    } else {
      this.objects = new Map(source.map((o) => [o.id, o]))
      this.positions = new Map(source.map((o, i) => [o.id, i]))
      this.spatial = new SpatialIndex(source, GRID, previous?.spatial)
      this.pinSpatial = new SpatialIndex(source, GRID, previous?.pinSpatial, undefined, pinBounds)
    }
  }

  get all(): readonly WirePin[] {
    return (this.allPins ??= pinsOf(this.source))
  }

  rank(object: PlacedObject): number { return this.positions.get(object.id) ?? -1 }

  pin(key: string): WirePin | undefined {
    const object = this.objects.get(key.slice(0, key.indexOf(":")))
    return object && mapsOf(object).keys.get(key)
  }

  within(box: Rect): WirePin[] {
    return this.pinSpatial.query(box).flatMap((o) => meets(pinBounds(o), box) ? pinsForObject(o).filter((p) => p.at.x >= box.x && p.at.x <= box.x + box.w && p.at.y >= box.y && p.at.y <= box.y + box.h) : [])
  }

  at(point: Point): WirePin[] {
    return this.pinSpatial.query({ ...point, w: 0, h: 0 }).flatMap((o) => meets(pinBounds(o), { ...point, w: 0, h: 0 }) ? mapsOf(o).at.get(pointKey(point)) ?? [] : [])
  }

  touching(object: PlacedObject): readonly PlacedObject[] {
    const box = pinBounds(object)
    return this.pinSpatial.query(box).filter((o) => o.id !== object.id && meets(pinBounds(o), box))
  }

  active(wires: readonly WireSegment[], previous?: DocumentPins, delta?: { added: readonly WireSegment[]; removed: readonly WireSegment[] }, previousState?: PinState, previousWires?: readonly WireSegment[]): PinState {
    this.pinDelta = undefined
    if (this.activeCache?.wires === wires) {
      const cached = this.activeCache
      return cached.ends.wires === wires ? cached : this.activeCache = pinState(wires, cached.byOwner, this.endsOf(wires), cached.pins)
    }
    if (previous && previous.version !== this.version) { previous = undefined; previousState = undefined; previousWires = undefined; delta = undefined }
    const shift = translationOf(this.source, wires)
    if (shift && shift.from === previous?.source && shift.fromWires === previousWires && previousState && previousWires) {
      const pins = previousState.pins.map((p) => ({ ...p, at: { x: p.at.x + shift.x, y: p.at.y + shift.y } }))
      let ends = previousState.ends
      if (!ends || ends.wires !== previousWires) ends = this.endsOf(wires)
      else { ends.wires = wires; ends.offset = { x: ends.offset.x + shift.x, y: ends.offset.y + shift.y } }
      return this.activeCache = pinState(wires, this.grouped(pins), ends, pins)
    }
    if (previous?.activeCache && previous.activeCache === previousState && previous.activeCache.wires === previousWires) {
      const changes = this.changes(previous)
      const changed = new Set([...changes.before, ...changes.after].map((o) => o.id))
      if (changed.size < this.source.length / 2) {
        const affected = new Set(changed)
        for (const id of changed) {
          const before = previous.objects.get(id)
          const after = this.objects.get(id)
          if (before) for (const o of previous.touching(before)) affected.add(o.id)
          if (after) for (const o of this.touching(after)) affected.add(o.id)
        }
        let wireChanges: readonly WireSegment[] = []
        if (wires !== previous.activeCache.wires) {
          if (delta) wireChanges = [...delta.added, ...delta.removed]
          else {
            const beforeWires = new Map(previous.activeCache.wires.map((s) => [s.id, s]))
            const afterWires = new Map(wires.map((s) => [s.id, s]))
            wireChanges = [...previous.activeCache.wires, ...wires].filter((s) => beforeWires.get(s.id) !== afterWires.get(s.id))
          }
        }
        for (const s of wireChanges) for (const end of [s.a, s.b]) for (const p of [...previous.at(end), ...this.at(end)]) affected.add(p.key.slice(0, p.key.indexOf(":")))
        const removed = [...affected].flatMap((id) => previous.activeCache!.byOwner.get(id) ?? [])
        const touched = new Set([...changes.before, ...changes.after].flatMap((o) => pinsForObject(o).map((p) => pointKey(p.at))))
        for (const s of wireChanges) { touched.add(pointKey(s.a)); touched.add(pointKey(s.b)) }
        let ends = previous.activeCache.ends
        if (wires !== previous.activeCache.wires) {
          if (delta && ends.wires === previous.activeCache.wires) {
            for (const [list, amount] of [[delta.removed, -1], [delta.added, 1]] as const) for (const s of list) for (const end of [s.a, s.b]) {
              const key = pointKey({ x: end.x - ends.offset.x, y: end.y - ends.offset.y })
              const count = (ends.counts.get(key) ?? 0) + amount
              if (count) ends.counts.set(key, count)
              else ends.counts.delete(key)
            }
            ends.wires = wires
          } else ends = this.endsOf(wires)
        }
        const added: WirePin[] = []
        for (const id of affected) {
          const o = this.objects.get(id)
          if (!o) continue
          const moved = changed.has(id)
          const nearby = moved ? this.touching(o) : []
          if (moved && !nearby.length && !wires.length && !duplicatesOf(o).size) continue
          if (!moved) for (const p of previous.activeCache.byOwner.get(id) ?? []) if (!touched.has(pointKey(p.at))) added.push(p)
          const points = moved ? new Set(pinsOf(nearby).map((p) => pointKey(p.at))) : undefined
          for (const p of pinsForObject(o)) {
            const key = pointKey(p.at)
            if (!moved && !touched.has(key)) continue
            if (ends.counts.get(pointKey({ x: p.at.x - ends.offset.x, y: p.at.y - ends.offset.y })) || duplicatesOf(o).has(p.key.slice(p.key.indexOf(":") + 1)) || (points ? points.has(key) : this.at(p.at).length > 1)) added.push(p)
          }
        }
        const removedPins = new Set(removed)
        const pinsAdded = added.filter((p) => !removedPins.delete(p))
        this.pinDelta = { added: pinsAdded, removed: [...removedPins] }
        const byOwner = new OverlayMap(previous.activeCache.byOwner, this.grouped(added), affected)
        return this.activeCache = pinState(wires, byOwner, ends)
      }
    }
    const active = new Map<string, WirePin>()
    for (const o of this.source) {
      const nearby = this.touching(o)
      if (!nearby.length && !duplicatesOf(o).size) continue
      const points = new Set(pinsOf(nearby).map((p) => pointKey(p.at)))
      for (const p of pinsForObject(o)) if (points.has(pointKey(p.at)) || duplicatesOf(o).has(p.key.slice(p.key.indexOf(":") + 1))) active.set(p.key, p)
    }
    for (const s of wires) for (const end of [s.a, s.b]) for (const p of this.at(end)) active.set(p.key, p)
    const pins = [...active.values()]
    return this.activeCache = pinState(wires, this.grouped(pins), this.endsOf(wires), pins)
  }
  changes(previous: DocumentPins): { before: PlacedObject[]; after: PlacedObject[] } {
    if (this.changedFrom?.deref() === previous && this.changedObjects) return this.changedObjects
    const before: PlacedObject[] = []
    const after: PlacedObject[] = []
    const edit = objectEdits.get(this.source)
    if (edit?.from.deref() === previous.source) {
      for (const id of edit.ids) {
        const a = previous.objects.get(id)
        const b = this.objects.get(id)
        if (a !== b) { if (a) before.push(a); if (b) after.push(b) }
      }
      this.changedFrom = new WeakRef(previous)
      return this.changedObjects = { before, after }
    }
    for (const [id, o] of this.objects) if (previous.objects.get(id) !== o) after.push(o)
    for (const [id, o] of previous.objects) if (this.objects.get(id) !== o) before.push(o)
    this.changedFrom = new WeakRef(previous)
    return this.changedObjects = { before, after }
  }

  private grouped(pins: readonly WirePin[]): Map<string, WirePin[]> {
    const map = new Map<string, WirePin[]>()
    for (const p of pins) {
      const id = p.key.slice(0, p.key.indexOf(":"))
      const list = map.get(id)
      if (list) list.push(p)
      else map.set(id, [p])
    }
    return map
  }

  private endsOf(wires: readonly WireSegment[]): { wires: readonly WireSegment[]; counts: Map<string, number>; offset: Point } {
    const ends = new Map<string, number>()
    for (const s of wires) for (const end of [s.a, s.b]) {
      const key = pointKey(end)
      ends.set(key, (ends.get(key) ?? 0) + 1)
    }
    return { wires, counts: ends, offset: { x: 0, y: 0 } }
  }
}

export function documentPins(objects: readonly PlacedObject[]): DocumentPins {
  const version = `${getDefsVersion()}:${getLibraryVersion()}`
  const cached = indices.get(objects)
  if (cached?.version === version) return cached.index
  const before = parents.get(objects)?.deref()
  const previous = before && indices.get(before)
  const index = new DocumentPins(objects, previous && previous.version === version ? previous.index : undefined)
  indices.set(objects, { version, index })
  return index
}
