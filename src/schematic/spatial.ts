import { objectRect, type Rect } from "./geometry"
import type { PlacedObject } from "./types"

export const BUCKET_CELLS = 32

const BUCKET_SPAN = 1 << 21
const BUCKET_BIAS = 1 << 20
const LAST_VISIT = 0x7fffffff

const bucketKey = (cx: number, cy: number) => (cx + BUCKET_BIAS) * BUCKET_SPAN + (cy + BUCKET_BIAS)

export class SpatialIndex {
  private readonly bucket: number
  private readonly objects: readonly PlacedObject[]
  private readonly cells = new Map<number, number[]>()
  private readonly returnedOn: Int32Array
  private visits = 0

  constructor(objects: readonly PlacedObject[], grid: number) {
    this.bucket = BUCKET_CELLS * grid
    this.objects = objects
    this.returnedOn = new Int32Array(objects.length)
    for (let i = 0; i < objects.length; i++) this.bucketise(i, objectRect(objects[i], grid))
  }

  query(rect: Rect): readonly PlacedObject[] {
    const visit = this.nextVisit()
    const candidates: PlacedObject[] = []
    const x1 = Math.floor((rect.x + rect.w) / this.bucket)
    const y1 = Math.floor((rect.y + rect.h) / this.bucket)
    for (let cx = Math.floor(rect.x / this.bucket); cx <= x1; cx++) {
      for (let cy = Math.floor(rect.y / this.bucket); cy <= y1; cy++) {
        const list = this.cells.get(bucketKey(cx, cy))
        if (!list) continue
        for (const i of list) {
          if (this.returnedOn[i] === visit) continue
          this.returnedOn[i] = visit
          candidates.push(this.objects[i])
        }
      }
    }
    return candidates
  }

  private bucketise(i: number, rect: Rect) {
    const x1 = Math.floor((rect.x + rect.w) / this.bucket)
    const y1 = Math.floor((rect.y + rect.h) / this.bucket)
    for (let cx = Math.floor(rect.x / this.bucket); cx <= x1; cx++) {
      for (let cy = Math.floor(rect.y / this.bucket); cy <= y1; cy++) {
        const key = bucketKey(cx, cy)
        const list = this.cells.get(key)
        if (list) list.push(i)
        else this.cells.set(key, [i])
      }
    }
  }

  private nextVisit(): number {
    if (this.visits === LAST_VISIT) {
      this.returnedOn.fill(0)
      this.visits = 0
    }
    return ++this.visits
  }
}
