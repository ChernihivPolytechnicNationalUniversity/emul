import { OverlayMap } from "./wires/overlay-map"
import { intersects, objectRect, type Rect } from "./geometry"
import type { PlacedObject } from "./types"

export const BUCKET_CELLS = 32

const BUCKET_SPAN = 1 << 21
const BUCKET_BIAS = 1 << 20
const LAST_VISIT = 0x7fffffff

const bucketKey = (cx: number, cy: number) => (cx + BUCKET_BIAS) * BUCKET_SPAN + (cy + BUCKET_BIAS)

export class SpatialIndex {
  private readonly bucket: number
  private readonly objects: readonly PlacedObject[]
  private readonly rects: Rect[]
  private readonly cells: ReadonlyMap<number, readonly number[]>
  private readonly rectOf: ((object: PlacedObject) => Rect) | undefined
  private readonly returnedOn: Int32Array
  private visits = 0

  constructor(objects: readonly PlacedObject[], grid: number, previous?: SpatialIndex, changedIndices?: readonly number[], rectOf?: (object: PlacedObject) => Rect) {
    this.rectOf = rectOf
    const bounds = rectOf ?? ((object: PlacedObject) => objectRect(object, grid))
    this.bucket = BUCKET_CELLS * grid
    this.objects = objects
    this.returnedOn = new Int32Array(objects.length)
    if (previous && previous.objects.length === objects.length && previous.bucket === this.bucket && previous.rectOf === rectOf) {
      this.rects = previous.rects.slice()
      const changed = new Map<number, number[]>()
      const cell = (key: number) => {
        let list = changed.get(key)
        if (!list) changed.set(key, list = [...previous.cells.get(key) ?? []])
        return list
      }
      for (const i of changedIndices ?? objects.keys()) {
        if (objects[i] === previous.objects[i]) continue
        for (const key of this.keys(this.rects[i])) { const list = cell(key); const at = list.indexOf(i); if (at >= 0) list.splice(at, 1) }
        this.rects[i] = bounds(objects[i])
        for (const key of this.keys(this.rects[i])) {
          const list = cell(key)
          let at = 0
          while (at < list.length && list[at] < i) at++
          list.splice(at, 0, i)
        }
      }
      this.cells = new OverlayMap(previous.cells, changed, new Set())
    } else {
      this.rects = objects.map(bounds)
      const cells = new Map<number, number[]>()
      for (let i = 0; i < objects.length; i++) for (const key of this.keys(this.rects[i])) {
        const list = cells.get(key)
        if (list) list.push(i)
        else cells.set(key, [i])
      }
      this.cells = cells
    }
  }

  query(rect: Rect): readonly PlacedObject[] {
    const candidates: PlacedObject[] = []
    this.sweep(rect, (i) => void candidates.push(this.objects[i]))
    return candidates
  }

  overlaps(rect: Rect): boolean {
    let found = false
    this.sweep(rect, (i) => {
      found ||= intersects(this.rects[i], rect)
      return found
    })
    return found
  }

  private sweep(rect: Rect, visit: (index: number) => boolean | void) {
    const columns = Math.floor((rect.x + rect.w) / this.bucket) - Math.floor(rect.x / this.bucket) + 1
    const rows = Math.floor((rect.y + rect.h) / this.bucket) - Math.floor(rect.y / this.bucket) + 1
    if (columns * rows > this.objects.length * 8) {
      for (let i = 0; i < this.objects.length; i++) {
        const r = this.rects[i]
        if (Math.floor(r.x / this.bucket) > Math.floor((rect.x + rect.w) / this.bucket) || Math.floor(rect.x / this.bucket) > Math.floor((r.x + r.w) / this.bucket) || Math.floor(r.y / this.bucket) > Math.floor((rect.y + rect.h) / this.bucket) || Math.floor(rect.y / this.bucket) > Math.floor((r.y + r.h) / this.bucket)) continue
        if (visit(i)) return
      }
      return
    }
    const at = this.nextVisit()
    const x1 = Math.floor((rect.x + rect.w) / this.bucket)
    const y1 = Math.floor((rect.y + rect.h) / this.bucket)
    for (let cx = Math.floor(rect.x / this.bucket); cx <= x1; cx++) {
      for (let cy = Math.floor(rect.y / this.bucket); cy <= y1; cy++) {
        const list = this.cells.get(bucketKey(cx, cy))
        if (!list) continue
        for (const i of list) {
          if (this.returnedOn[i] === at) continue
          this.returnedOn[i] = at
          if (visit(i)) return
        }
      }
    }
  }

  private keys(rect: Rect): number[] {
    const keys: number[] = []
    for (let cx = Math.floor(rect.x / this.bucket); cx <= Math.floor((rect.x + rect.w) / this.bucket); cx++)
      for (let cy = Math.floor(rect.y / this.bucket); cy <= Math.floor((rect.y + rect.h) / this.bucket); cy++) keys.push(bucketKey(cx, cy))
    return keys
  }

  private nextVisit(): number {
    if (this.visits === LAST_VISIT) {
      this.returnedOn.fill(0)
      this.visits = 0
    }
    return ++this.visits
  }
}

export class BoxIndex<T> {
  private readonly bucket: number
  private readonly items: readonly T[]
  private readonly cells = new Map<number, number[]>()
  private readonly visitedOn: Int32Array
  private visits = 0

  constructor(items: readonly T[], boxOf: (item: T) => Rect, bucket: number) {
    this.bucket = bucket
    this.items = items
    this.visitedOn = new Int32Array(items.length)
    for (let i = 0; i < items.length; i++) {
      const r = boxOf(items[i])
      for (let cx = Math.floor(r.x / bucket); cx <= Math.floor((r.x + r.w) / bucket); cx++) {
        for (let cy = Math.floor(r.y / bucket); cy <= Math.floor((r.y + r.h) / bucket); cy++) {
          const key = bucketKey(cx, cy)
          const list = this.cells.get(key)
          if (list) list.push(i)
          else this.cells.set(key, [i])
        }
      }
    }
  }

  some(rect: Rect, test: (item: T) => boolean): boolean {
    if (this.visits === LAST_VISIT) {
      this.visitedOn.fill(0)
      this.visits = 0
    }
    const at = ++this.visits
    for (let cx = Math.floor(rect.x / this.bucket); cx <= Math.floor((rect.x + rect.w) / this.bucket); cx++) {
      for (let cy = Math.floor(rect.y / this.bucket); cy <= Math.floor((rect.y + rect.h) / this.bucket); cy++) {
        const list = this.cells.get(bucketKey(cx, cy))
        if (!list) continue
        for (const i of list) {
          if (this.visitedOn[i] === at) continue
          this.visitedOn[i] = at
          if (test(this.items[i])) return true
        }
      }
    }
    return false
  }
}

