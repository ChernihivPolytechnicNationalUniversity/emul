/**
 * The serial terminal's two halves, as the simulation loop drives them: a receiver that
 * decodes 8N1 frames from timestamped level edges (whatever the analog step, the edges carry
 * exact times from the emulator), and a transmitter that turns bytes into a timed edge list.
 */

export type Edge = { time: number; level: boolean }

/** 8N1 receiver over an edge stream. Call `edge` in time order, then `poll(now)` to flush frames. */
export class UartDecoder {
  private readonly edges: Edge[] = []
  private level = true
  /** Start of the frame being decoded, or -1. */
  private frameAt = -1
  readonly bytes: number[] = []
  /** Frames whose stop bit read low. */
  framingErrors = 0

  baud: number
  constructor(baud: number) {
    this.baud = baud
  }

  edge(e: Edge) {
    this.edges.push(e)
  }

  /** Level at time t, from the edge history (edges before t applied). */
  private levelAt(t: number, from: number): { level: boolean; index: number } {
    let level = from > 0 ? this.edges[from - 1].level : this.level
    let i = from
    while (i < this.edges.length && this.edges[i].time <= t) {
      level = this.edges[i].level
      i++
    }
    return { level, index: i }
  }

  /** Decode every frame that is complete by `now`. */
  poll(now: number) {
    const bit = 1 / this.baud
    for (;;) {
      if (this.frameAt < 0) {
        // Look for a falling edge from an idle (high) line.
        let i = 0
        while (i < this.edges.length && !(this.level && !this.edges[i].level)) {
          this.level = this.edges[i].level
          i++
        }
        this.edges.splice(0, i)
        if (!this.edges.length) return
        this.frameAt = this.edges[0].time
        // The start edge itself is consumed; the line is low from here.
        this.level = false
        this.edges.shift()
      }
      const end = this.frameAt + bit * 9.5
      if (now < end) return
      let byte = 0
      let index = 0
      for (let b = 0; b < 8; b++) {
        const r = this.levelAt(this.frameAt + bit * (1.5 + b), index)
        if (r.level) byte |= 1 << b
        index = r.index
      }
      const stop = this.levelAt(end, index)
      if (stop.level) this.bytes.push(byte)
      else this.framingErrors++
      // Consume edges up to the stop sample; keep the level there.
      this.level = stop.level
      this.edges.splice(0, stop.index)
      this.frameAt = -1
    }
  }
}

/** Edges for an 8N1 frame of `byte` starting at `at`. The line is assumed high before. */
export function uartFrameEdges(byte: number, at: number, baud: number): Edge[] {
  const bit = 1 / baud
  const bits = [false, ...Array.from({ length: 8 }, (_, i) => ((byte >>> i) & 1) === 1), true]
  const out: Edge[] = []
  let level = true
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== level) {
      level = bits[i]
      out.push({ time: at + bit * i, level })
    }
  }
  return out
}

/** Seconds one 8N1 frame takes. */
export function uartFrameSeconds(baud: number) {
  return 10 / baud
}
