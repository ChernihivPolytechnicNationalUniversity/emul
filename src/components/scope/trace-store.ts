import type { TraceChunk } from "@/sim/engine"

/** Buckets kept per channel: a few screens of the longest timebase at 500 columns each. */
const CAPACITY = 4096

type Series = { min: Float32Array; max: Float32Array; head: number; len: number }

/**
 * Ring buffers of oscilloscope samples per probe, filled from the worker's chunks. Lives
 * outside React state: samples arrive twenty times a second and only the canvas reads them.
 */
export class TraceStore {
  private series = new Map<string, Series>()
  /** Seconds per bucket of everything stored; a change empties the store. */
  bucket = 0
  /** Simulated time at the end of the newest bucket. */
  end = 0
  /** Bumped on every change, so a component can subscribe by polling it. */
  version = 0

  push(chunk: TraceChunk, probes: string[]) {
    if (chunk.bucket !== this.bucket) {
      this.clear()
      this.bucket = chunk.bucket
    }
    const stride = probes.length * 2
    probes.forEach((id, p) => {
      let s = this.series.get(id)
      if (!s) {
        s = { min: new Float32Array(CAPACITY), max: new Float32Array(CAPACITY), head: 0, len: 0 }
        this.series.set(id, s)
      }
      for (let i = 0; i < chunk.count; i++) {
        s.min[s.head] = chunk.data[i * stride + p * 2]
        s.max[s.head] = chunk.data[i * stride + p * 2 + 1]
        s.head = (s.head + 1) % CAPACITY
        if (s.len < CAPACITY) s.len++
      }
    })
    // Probes that stopped reporting are stale; keep them out of the next frame.
    for (const id of [...this.series.keys()]) if (!probes.includes(id)) this.series.delete(id)
    this.end = chunk.start + chunk.count * chunk.bucket
    this.version++
  }

  clear() {
    this.series.clear()
    this.end = 0
    this.version++
  }

  /** How many buckets the fullest channel holds. */
  get length() {
    let n = 0
    for (const s of this.series.values()) if (s.len > n) n = s.len
    return n
  }

  /** Samples of a channel, oldest first, as (min, max) at index `i` from the oldest kept. */
  at(id: string, i: number): [min: number, max: number] | null {
    const s = this.series.get(id)
    if (!s || i < 0 || i >= s.len) return null
    const k = (s.head - s.len + i + CAPACITY) % CAPACITY
    return [s.min[k], s.max[k]]
  }

  has(id: string) {
    return this.series.has(id)
  }

  /** Channel ids held, in arrival order. */
  get ids() {
    return [...this.series.keys()]
  }

  /** A frozen copy: what the screen holds while the live store keeps filling. */
  clone() {
    const c = new TraceStore()
    c.bucket = this.bucket
    c.end = this.end
    for (const [id, s] of this.series) c.series.set(id, { min: s.min.slice(), max: s.max.slice(), head: s.head, len: s.len })
    return c
  }
}
