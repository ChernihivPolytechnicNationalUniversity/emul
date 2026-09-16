import type { LogicChunk } from "@/sim/loop"
import type { EdgeSeries } from "@/sim/protocols"

/** Edges kept per channel: a few seconds of a busy SPI bus. */
const CAPACITY = 1 << 18

type Series = { times: Float64Array; levels: Uint8Array; head: number; len: number; last: boolean }

/**
 * Edge history per probe for the logic analyser, filled from the worker's chunks. Like the
 * oscilloscope's trace store it lives outside React state and only the canvas reads it.
 */
export class LogicStore {
  private series = new Map<string, Series>()
  /** Simulated time at the end of the newest chunk. */
  end = 0
  /** Simulated time the recording started (the oldest edge still held, or the first chunk). */
  start = 0
  /** True when a chunk overflowed: something in the window is missing. */
  dropped = false
  /** Time of the newest edge on any channel; a bursty bus sits well behind `end`. */
  lastEdge = 0
  version = 0

  push(chunk: LogicChunk, probes: string[]) {
    const stale = new Set(this.series.keys())
    probes.forEach((id, p) => {
      stale.delete(id)
      let s = this.series.get(id)
      if (!s) {
        s = { times: new Float64Array(CAPACITY), levels: new Uint8Array(CAPACITY), head: 0, len: 0, last: true }
        this.series.set(id, s)
      }
      // 0xff: nothing seen on that net yet.
      if (chunk.levels[p] !== 0xff) s.last = (chunk.levels[p] & 1) === 1
    })
    for (let i = 0; i < chunk.count; i++) {
      const code = chunk.codes[i]
      const s = this.series.get(probes[code >> 1])
      if (!s) continue
      s.times[s.head] = chunk.times[i]
      s.levels[s.head] = code & 1
      s.head = (s.head + 1) % CAPACITY
      if (s.len < CAPACITY) s.len++
    }
    for (const id of stale) this.series.delete(id)
    for (let i = 0; i < chunk.count; i++) if (chunk.times[i] > this.lastEdge) this.lastEdge = chunk.times[i]
    if (chunk.dropped) this.dropped = true
    if (this.series.size && this.end === 0) this.start = chunk.end
    this.end = chunk.end
    this.version++
  }

  clear() {
    this.series.clear()
    this.end = 0
    this.start = 0
    this.lastEdge = 0
    this.dropped = false
    this.version++
  }

  has(id: string) {
    return this.series.has(id)
  }

  /** A channel's edges as a contiguous series (copied out of the ring), oldest first. */
  edges(id: string): EdgeSeries | null {
    const s = this.series.get(id)
    if (!s) return null
    const times = new Float64Array(s.len)
    const levels = new Uint8Array(s.len)
    const from = (s.head - s.len + CAPACITY) % CAPACITY
    const tail = Math.min(s.len, CAPACITY - from)
    times.set(s.times.subarray(from, from + tail))
    levels.set(s.levels.subarray(from, from + tail))
    if (tail < s.len) {
      times.set(s.times.subarray(0, s.len - tail), tail)
      levels.set(s.levels.subarray(0, s.len - tail), tail)
    }
    return { times, levels, count: s.len, last: s.last }
  }
}
