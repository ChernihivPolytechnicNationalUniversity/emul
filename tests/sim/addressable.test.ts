/**
 * The addressable-LED chain model on its own, fed exact-time edges: bits into words, the
 * cascade past a chain's own chips, the latch on the reset low, timing faults, the input
 * threshold, the backup line, the PWM the outputs run at, and the clocked (WS2801) input.
 */
import { describe, expect, it } from "vitest"
import { chainFor, NrzChain, type AddressableChain, type AddressableSnapshot } from "@/sim/addressable/chain"
import { onFraction, SINK_REFERENCE, SUPPLY_KEY, sinkGate } from "@/sim/addressable/light"
import { specByPart } from "@/sim/addressable/parts"
import type { ChipSpec } from "@/sim/addressable/spec"

const WS2812B = specByPart("WS2812B")!
const WS2811 = specByPart("WS2811")!
const WS2815 = specByPart("WS2815")!
const WS2801 = specByPart("WS2801")!

type Probe = { part: AddressableChain; t: number; edges: { pin: string; level: boolean | null; time: number }[] }

/** A chain on a stiff supply, its DIN driven at `high` volts. */
function bench(spec: ChipSpec, chips = 1, supply = 5, high = 5): Probe {
  const part = chainFor("U1", spec, chips)
  part.reset()
  const volts = (pin: string) => (pin === "VDD" ? supply : pin === "GND" ? 0 : high)
  part.sense(volts, 0)
  const probe: Probe = { part, t: 1e-3, edges: [] }
  // One valid pulse the analog side catches high, as a solve during a frame would.
  const t1h = spec.input.kind === "nrz" ? (spec.input.timing.t1h[0] + spec.input.timing.t1h[1]) / 2 : 1e-6
  part.input("DIN", true, probe.t)
  part.sense(volts, probe.t)
  part.input("DIN", false, probe.t + t1h)
  probe.t += 400e-6
  part.tick(probe.t)
  part.out.length = 0
  return probe
}

/** NRZ bits at the datasheet's nominal timing (the middle of each range). */
function send(p: Probe, spec: ChipSpec, bits: number[], { stretchHigh = 1 } = {}) {
  if (spec.input.kind !== "nrz") throw new Error("not nrz")
  const t = spec.input.timing
  const mid = (r: readonly [number, number]) => (r[0] + r[1]) / 2
  for (const b of bits) {
    p.part.input("DIN", true, p.t)
    p.t += (b ? mid(t.t1h) : mid(t.t0h)) * stretchHigh
    p.part.input("DIN", false, p.t)
    p.t += b ? mid(t.t1l) : mid(t.t0l)
    p.edges.push(...p.part.out.splice(0))
  }
}

const byteBits = (...bytes: number[]) => bytes.flatMap((v) => Array.from({ length: 8 }, (_, i) => (v >> (7 - i)) & 1))

function latch(p: Probe, spec: ChipSpec) {
  const reset = spec.input.kind === "nrz" ? spec.input.timing.reset : spec.input.timing.latch
  p.t += reset + 100e-6
  p.part.tick(p.t)
  return p.part.snapshot() as AddressableSnapshot
}

describe("NRZ chain", () => {
  it("takes 24 bits GRB, MSB first, and latches on the reset low", () => {
    const p = bench(WS2812B)
    send(p, WS2812B, byteBits(0x10, 0xff, 0x01))
    expect(p.part.snapshot().frames, "nothing latched before the reset").toBe(0)
    const s = latch(p, WS2812B)
    expect(s.frames).toBe(1)
    const [g, r, b] = s.words[0]
    expect([g.channel, r.channel, b.channel]).toEqual(["G", "R", "B"])
    expect([g.value, r.value, b.value]).toEqual([0x10, 0xff, 0x01])
    expect(s.drive[0][0].duty, "R full").toBeCloseTo(1)
    expect(s.drive[0][1].duty, "G 16/255").toBeCloseTo(16 / 255)
    expect(s.colors[0] >> 16, "shows red").toBeGreaterThan(200)
    expect(s.faults, "nominal timing breaks no rule").toEqual([])
  })

  it("passes everything past its own chips on at DO, delayed, and keeps none of it", () => {
    const p = bench(WS2812B, 2)
    const frame = byteBits(1, 2, 3, 4, 5, 6, 0xaa, 0x55, 0xf0)
    send(p, WS2812B, frame)
    const s = latch(p, WS2812B)
    expect(s.words.map((w) => w.map((f) => f.value))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ])
    const rises = p.edges.filter((e) => e.pin === "DO" && e.level === true)
    expect(rises.length, "the third chip's 24 pulses come out").toBe(24)
    expect(s.passed).toBe(24)
    // The pulses keep their widths: decode them as the next chip would.
    const widths: number[] = []
    for (let i = 0; i < p.edges.length; i++) if (p.edges[i].level === true) widths.push(p.edges[i + 1].time - p.edges[i].time)
    const t = WS2812B.input.kind === "nrz" ? WS2812B.input.timing : null!
    const bits = widths.map((w) => (w > (t.t0h[1] + t.t1h[0]) / 2 ? 1 : 0))
    expect(bits).toEqual(byteBits(0xaa, 0x55, 0xf0))
  })

  it("keeps the old colour of a chip whose word was cut short", () => {
    const p = bench(WS2812B)
    send(p, WS2812B, byteBits(0, 0x80, 0))
    latch(p, WS2812B)
    send(p, WS2812B, byteBits(0xff, 0xff).slice(0, 12))
    const s = latch(p, WS2812B)
    expect(s.words[0][1].value, "red stays 0x80").toBe(0x80)
  })

  it("flags pulses outside the datasheet windows", () => {
    const p = bench(WS2812B)
    send(p, WS2812B, byteBits(0, 0, 0), { stretchHigh: 0.4 })
    const s = latch(p, WS2812B)
    expect(s.faults.map((f) => f.rule)).toContain("T0H short")
  })

  it("ignores a data line that never reaches VIH (3.3 V into a 5 V pixel)", () => {
    const p = bench(WS2812B, 1, 5, 3.3)
    send(p, WS2812B, byteBits(0xff, 0xff, 0xff))
    const s = latch(p, WS2812B)
    expect(s.frames).toBe(0)
    expect(s.ignored).toBeGreaterThan(0)
    expect(s.dinHigh).toBeCloseTo(3.3)
    expect(s.vih).toBeCloseTo(3.5)
  })

  it("takes the same 3.3 V data at a 4.5 V supply (VIH 3.15 V)", () => {
    const p = bench(WS2812B, 1, 4.5, 3.3)
    send(p, WS2812B, byteBits(0, 0xff, 0))
    expect(latch(p, WS2812B).frames).toBe(1)
  })

  it("stays dark and lets DO go below its supply minimum", () => {
    const p = bench(WS2812B, 1, 2)
    send(p, WS2812B, byteBits(0xff, 0xff, 0xff))
    const s = latch(p, WS2812B)
    expect(s.powered).toBe(false)
    expect(s.frames).toBe(0)
    expect(p.part.drive("DO")).toBe(null)
  })

  it("draws its LEDs' current from the supply, PWM-averaged", () => {
    const p = bench(WS2812B)
    send(p, WS2812B, byteBits(0xff, 0xff, 0xff))
    latch(p, WS2812B)
    p.part.tick(p.t + 1e-3)
    const ohms = p.part.analog(SUPPLY_KEY)!
    const amps = 5 / ohms
    const light = WS2812B.light.kind === "pixel" ? WS2812B.light : null!
    const full = (light.current.R ?? 0) + (light.current.G ?? 0) + (light.current.B ?? 0) + WS2812B.quiescent
    expect(amps).toBeCloseTo(full, 3)
  })
})

describe("backup line (WS2815 BIN)", () => {
  it("moves to BIN when DIN goes quiet, skipping the dead chip's word", () => {
    const part = new NrzChain("U2", WS2815, 1)
    part.reset()
    const volts = (pin: string) => (pin === "VDD" ? 12 : pin === "GND" ? 0 : 5)
    part.sense(volts, 0)
    const t = WS2815.input.kind === "nrz" ? WS2815.input.timing : null!
    const mid = (r: readonly [number, number]) => (r[0] + r[1]) / 2
    let now = 1e-3
    const frameOnBin = (bits: number[]) => {
      for (const b of bits) {
        part.input("BIN", true, now)
        now += b ? mid(t.t1h) : mid(t.t0h)
        part.input("BIN", false, now)
        now += b ? mid(t.t1l) : mid(t.t0l)
      }
      now += t.reset + 100e-6
      part.tick(now)
    }
    // The chip before is dead: its word and ours come on BIN only, twice.
    frameOnBin(byteBits(1, 1, 1, 0x00, 0xff, 0x00))
    expect(part.snapshot().input).toBe("BIN")
    frameOnBin(byteBits(1, 1, 1, 0x00, 0xff, 0x00))
    const s = part.snapshot()
    expect(s.words[0].map((f) => f.value), "our word, the dead chip's skipped").toEqual([0x00, 0xff, 0x00])
  })

  it("stays on DIN while DIN carries data a word behind BIN", () => {
    const part = new NrzChain("U2", WS2815, 1)
    part.reset()
    part.sense((pin) => (pin === "VDD" ? 12 : pin === "GND" ? 0 : 5), 0)
    const t = WS2815.input.kind === "nrz" ? WS2815.input.timing : null!
    const mid = (r: readonly [number, number]) => (r[0] + r[1]) / 2
    let now = 1e-3
    const stream = byteBits(9, 9, 9, 0x11, 0x22, 0x33)
    const period = mid(t.t0h) + mid(t.t0l)
    // BIN sees the whole stream, DIN the same stream minus the first word, a word later.
    const events: { pin: string; level: boolean; time: number }[] = []
    stream.forEach((b, i) => {
      const at = now + i * period * 1.2
      const h = b ? mid(t.t1h) : mid(t.t0h)
      events.push({ pin: "BIN", level: true, time: at }, { pin: "BIN", level: false, time: at + h })
      if (i >= 24) events.push({ pin: "DIN", level: true, time: at + 300e-9 }, { pin: "DIN", level: false, time: at + 300e-9 + h })
    })
    events.sort((a, b) => a.time - b.time)
    for (const e of events) part.input(e.pin, e.level, e.time)
    now = events[events.length - 1].time + t.reset + 100e-6
    part.tick(now)
    const s = part.snapshot()
    expect(s.input).toBe("DIN")
    expect(s.words[0].map((f) => f.value)).toEqual([0x11, 0x22, 0x33])
  })
})

describe("constant-current outputs (WS2811)", () => {
  it("gates each output for its duty of the PWM period", () => {
    const p = bench(WS2811)
    send(p, WS2811, byteBits(0x80, 0x00, 0xff))
    latch(p, WS2811)
    // Over whole PWM periods the gate stands for the duty: Vgs = VTH + sqrt(fraction).
    const period = 1 / WS2811.pwmHz
    const start = Math.ceil(p.t / period) * period
    p.part.tick(start)
    p.part.tick(start + 10 * period)
    const order = p.part.snapshot().channels
    const gate = (ch: string) => p.part.analog(sinkGate(0, order.indexOf(ch as never)))!
    const word = p.part.snapshot().words[0]
    const duty = (ch: string) => word.find((f) => f.channel === ch)!.value / 255
    expect(gate("R"), "red off").toBe(0)
    // Vgs = VTH + sqrt(fraction × set / reference): the fraction over whole periods is the duty.
    const set = (16.5e-3) / SINK_REFERENCE
    for (const ch of ["G", "B"]) expect(((gate(ch) - 1) ** 2) / set, ch).toBeCloseTo(duty(ch), 2)
  })

  it("PWM on-fraction over any window", () => {
    expect(onFraction(0, 1e-3, 1e-3, 0.25)).toBeCloseTo(0.25)
    expect(onFraction(0, 0.25e-3, 1e-3, 0.25)).toBeCloseTo(1)
    expect(onFraction(0.25e-3, 0.5e-3, 1e-3, 0.25)).toBeCloseTo(0)
    expect(onFraction(0.9e-3, 1.1e-3, 1e-3, 0.25)).toBeCloseTo(0.5)
  })
})

describe("clocked input (WS2801)", () => {
  it("shifts SDI on CKI's rising edges, relays the rest, latches when CKI idles", () => {
    const part = chainFor("U3", WS2801, 1)
    part.reset()
    part.sense((pin) => (pin === "GND" ? 0 : pin === "POL" ? 5 : 5), 0)
    let now = 1e-3
    const out: { pin: string; level: boolean | null }[] = []
    for (const b of byteBits(0xff, 0x00, 0x80, 0xc3)) {
      part.input("SDI", b === 1, now)
      part.input("CKI", true, now + 1e-6)
      part.input("CKI", false, now + 2e-6)
      now += 4e-6
      out.push(...part.out.splice(0))
    }
    const latchTime = WS2801.input.kind === "clocked" ? WS2801.input.timing.latch : 0
    now += latchTime + 100e-6
    part.tick(now)
    const s = part.snapshot()
    expect(s.frames).toBe(1)
    expect(s.words[0].map((f) => f.value)).toEqual([0xff, 0x00, 0x80])
    expect(s.passed, "the fourth byte goes on").toBe(8)
    expect(out.filter((e) => e.pin === "CKO" && e.level === true).length).toBe(8)
    expect(s.drive[0][0].duty, "0xFF is 255/256").toBeCloseTo(255 / 256)
  })
})
