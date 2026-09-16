/**
 * Logic-analyser decoders: pure functions over edge series (time, level), the way the
 * analyser's channels keep them. UART, SPI and I²C — the buses the MCU labs use — each
 * returning frames placed on the time axis with the text the analyser draws over the
 * waveform. Nothing here knows about the MCU: a bit-banged bus decodes the same as a
 * peripheral's.
 */

/** Level changes of one channel in time order; the level before the first edge is `!levels[0]`. */
export type EdgeSeries = { times: Float64Array; levels: Uint8Array; count: number; /** Level at the end of the recording. */ last: boolean }

/** The level of a series at time `t` (the level set by the last edge at or before `t`). */
export function levelAt(s: EdgeSeries, t: number): boolean {
  let lo = 0
  let hi = s.count
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (s.times[mid] <= t) lo = mid + 1
    else hi = mid
  }
  if (lo === 0) return s.count ? !s.levels[0] : s.last
  return s.levels[lo - 1] === 1
}

/** Index of the first edge at or after `t`. */
export function edgeFrom(s: EdgeSeries, t: number): number {
  let lo = 0
  let hi = s.count
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (s.times[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** A decoded item drawn over a channel between `start` and `end`. */
export type Frame = {
  start: number
  end: number
  /** Which decoder input the frame belongs on (a byte on MOSI vs. MISO, an I²C item on SDA). */
  channel: number
  text: string
  kind: "data" | "control" | "error"
  /** The byte, when the frame is one. */
  value?: number
}

export type UartOptions = { baud: number; bits?: number; parity?: "none" | "even" | "odd" }

/**
 * 8N1-style frames: a falling edge from the idle high starts one, bits are sampled mid-bit,
 * LSB first, and a stop bit that reads low is a framing error. `from`/`to` bound the search.
 */
export function decodeUart(rx: EdgeSeries, opts: UartOptions, from: number, to: number): Frame[] {
  const bits = opts.bits ?? 8
  const parity = opts.parity ?? "none"
  const bit = 1 / opts.baud
  const frames: Frame[] = []
  const total = 1 + bits + (parity === "none" ? 0 : 1) + 1
  let i = edgeFrom(rx, from)
  while (i < rx.count && rx.times[i] < to) {
    if (rx.levels[i] !== 0) {
      i++
      continue
    }
    const t0 = rx.times[i]
    let value = 0
    for (let b = 0; b < bits; b++) if (levelAt(rx, t0 + (b + 1.5) * bit)) value |= 1 << b
    let ok = true
    let pos = bits + 1.5
    if (parity !== "none") {
      const p = levelAt(rx, t0 + pos * bit)
      let ones = 0
      for (let b = 0; b < bits; b++) if (value & (1 << b)) ones++
      if (p) ones++
      if ((ones & 1) !== (parity === "odd" ? 1 : 0)) ok = false
      pos++
    }
    if (!levelAt(rx, t0 + pos * bit)) ok = false
    frames.push({ start: t0, end: t0 + total * bit, channel: 0, text: ok ? byteText(value) : `${byteText(value)}?`, kind: ok ? "data" : "error", value })
    // The next start bit can follow right after the stop bit.
    i = edgeFrom(rx, t0 + (total - 0.5) * bit)
  }
  return frames
}

export type SpiOptions = { cpol: 0 | 1; cpha: 0 | 1; bits?: number; lsbFirst?: boolean }

/**
 * SPI: data is sampled on the clock's first edge away from idle with CPHA=0, on the second
 * with CPHA=1; `cs` (active low) frames the bytes when it is there, otherwise a pause longer
 * than a byte's worth of clocks starts a new byte. Channels: 0 MOSI, 1 MISO.
 */
export function decodeSpi(sck: EdgeSeries, mosi: EdgeSeries | null, miso: EdgeSeries | null, cs: EdgeSeries | null, opts: SpiOptions, from: number, to: number): Frame[] {
  const bits = opts.bits ?? 8
  // With CPOL=0 the idle is low: the first edge is rising. CPHA=0 samples on it, CPHA=1 on the other.
  const sampleOnRising = (opts.cpol === 0) === (opts.cpha === 0)
  const frames: Frame[] = []
  let n = 0
  let vMosi = 0
  let vMiso = 0
  let start = 0
  let lastClock = -Infinity
  let period = Infinity
  const flush = (end: number) => {
    if (n === 0) return
    if (n === bits) {
      if (mosi) frames.push({ start, end, channel: 0, text: byteText(vMosi), kind: "data", value: vMosi })
      if (miso) frames.push({ start, end, channel: 1, text: byteText(vMiso), kind: "data", value: vMiso })
    } else frames.push({ start, end, channel: 0, text: `${n} bits`, kind: "error" })
    n = 0
    vMosi = vMiso = 0
  }
  let i = edgeFrom(sck, from)
  let csIdx = cs ? edgeFrom(cs, from) : 0
  for (; i < sck.count && sck.times[i] < to; i++) {
    const t = sck.times[i]
    // Chip-select edges before this clock frame the bytes.
    if (cs)
      while (csIdx < cs.count && cs.times[csIdx] <= t) {
        flush(cs.times[csIdx])
        csIdx++
      }
    if ((sck.levels[i] === 1) !== sampleOnRising) continue
    if (cs && levelAt(cs, t)) continue
    // A long gap between clocks without a chip select is a byte boundary.
    if (!cs && n > 0 && t - lastClock > 4 * period) flush(lastClock + period)
    if (n === 0) start = t - (Number.isFinite(period) ? period / 2 : 0)
    const bitIndex = opts.lsbFirst ? n : bits - 1 - n
    if (mosi && levelAt(mosi, t)) vMosi |= 1 << bitIndex
    if (miso && levelAt(miso, t)) vMiso |= 1 << bitIndex
    n++
    if (Number.isFinite(lastClock)) period = t - lastClock
    lastClock = t
    if (n === bits) flush(t + period / 2)
  }
  if (n > 0) flush(lastClock + period / 2)
  return frames
}

/**
 * I²C: START (SDA falls with SCL high), 7-bit address + R/W, an acknowledge after every byte
 * (SDA low), data bytes, STOP (SDA rises with SCL high), repeated START. Bits are sampled
 * on SCL's rising edges. Every item goes on channel 0 (SDA).
 */
export function decodeI2c(sda: EdgeSeries, scl: EdgeSeries, from: number, to: number): Frame[] {
  const frames: Frame[] = []
  // Walk both series merged in time order.
  let is = edgeFrom(sda, from)
  let ic = edgeFrom(scl, from)
  let inFrame = false
  let bit = 0
  let value = 0
  let byteStart = 0
  let first = true
  let read = false
  let lastRise = 0
  for (;;) {
    const ts = is < sda.count ? sda.times[is] : Infinity
    const tc = ic < scl.count ? scl.times[ic] : Infinity
    const t = Math.min(ts, tc)
    if (t >= to) break
    if (ts <= tc) {
      // SDA moved: a START/STOP if SCL is high.
      const level = sda.levels[is] === 1
      is++
      if (levelAt(scl, t)) {
        if (!level) {
          frames.push({ start: t, end: t, channel: 0, text: inFrame ? "Sr" : "S", kind: "control" })
          inFrame = true
          bit = 0
          value = 0
          first = true
        } else if (inFrame) {
          frames.push({ start: t, end: t, channel: 0, text: "P", kind: "control" })
          inFrame = false
        }
      }
    } else {
      const rising = scl.levels[ic] === 1
      ic++
      if (!rising || !inFrame) continue
      const period = lastRise ? t - lastRise : 0
      if (bit === 0) byteStart = t - period / 2
      lastRise = t
      const s = levelAt(sda, t)
      if (bit < 8) {
        value = (value << 1) | (s ? 1 : 0)
        bit++
      } else {
        // Acknowledge bit.
        const ack = !s
        const end = t + period / 2
        if (first) {
          read = (value & 1) === 1
          frames.push({ start: byteStart, end, channel: 0, text: `0x${(value >> 1).toString(16).toUpperCase().padStart(2, "0")} ${read ? "R" : "W"} ${ack ? "A" : "N"}`, kind: ack ? "control" : "error", value: value >> 1 })
          first = false
        } else frames.push({ start: byteStart, end, channel: 0, text: `${byteText(value)} ${ack ? "A" : "N"}`, kind: ack ? "data" : "error", value })
        bit = 0
        value = 0
      }
    }
  }
  return frames
}

/** "0x41 'A'" for printable ASCII, else just the hex. */
export function byteText(v: number): string {
  const hex = `0x${v.toString(16).toUpperCase().padStart(2, "0")}`
  return v >= 0x20 && v < 0x7f ? `${hex} '${String.fromCharCode(v)}'` : hex
}
