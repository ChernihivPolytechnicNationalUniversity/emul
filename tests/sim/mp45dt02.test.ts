/**
 * MP45DT02 PDM microphone, from ST DocID018658 Rev 8 (mp45dt02.pdf):
 * Table 3 (sensitivity −26 dBFS, AOP 120 dBSPL, T_WK ≤ 10 ms, power-down clock),
 * Table 5 (f_CLK 1–3.25 MHz, f_PD ≤ 0.23 MHz, T_EN ≤ 30 ns, T_DIS ≤ 16 ns),
 * Table 7 / Figure 2 (LR = GND: data while CLK low, Hi-Z while CLK high).
 */
import { describe, expect, it } from "vitest"
import type { DigitalEdge } from "@/sim/digital-part"
import { Mp45dt02, NOT_MODELLED, type Mp45dt02Snapshot } from "@/sim/mp45dt02"

const PINS = { clk: "CLK", dout: "DOUT" }
const T_WK = 10e-3
const T_EN = 30e-9
const T_DIS = 16e-9
const F_PD = 0.23e6

type Bit = { time: number; bit: boolean }

/** A square clock on CLK from `from` for `duration`, starting high so the first edge is a fall. */
function clock(
  m: Mp45dt02,
  f: number,
  from: number,
  duration: number,
  duty = 0.5,
) {
  const period = 1 / f
  const n = Math.round(duration * f)
  const edges: DigitalEdge[] = []
  const bits: Bit[] = []
  for (let i = 0; i < n; i++) {
    const fall = from + i * period
    m.input(PINS.clk, false, fall)
    m.input(PINS.clk, true, fall + period * (1 - duty))
    if (m.out.length) {
      for (const e of m.out) {
        edges.push(e)
        if (e.level !== null) bits.push({ time: e.time, bit: e.level })
      }
      m.out.length = 0
    }
  }
  return { edges, bits, end: from + n * period }
}

function mic() {
  const m = new Mp45dt02("U9", PINS)
  m.reset()
  m.input(PINS.clk, true, 0)
  return m
}

/** Moving-average (first-order CIC) decimation of ±1 PDM by `r`. */
function decimate(bits: Bit[], r: number): number[] {
  const pcm: number[] = []
  for (let i = 0; i + r <= bits.length; i += r) {
    let s = 0
    for (let k = i; k < i + r; k++) s += bits[k].bit ? 1 : -1
    pcm.push(s / r)
  }
  return pcm
}

/** Level of the `f` component of PCM at rate `fs`, as dBFS of a full-scale sine (peak 1 = 0 dBFS). */
function toneDbfs(pcm: number[], fs: number, f: number): number {
  let re = 0
  let im = 0
  for (let n = 0; n < pcm.length; n++) {
    re += pcm[n] * Math.cos((2 * Math.PI * f * n) / fs)
    im -= pcm[n] * Math.sin((2 * Math.PI * f * n) / fs)
  }
  const amplitude = (2 * Math.hypot(re, im)) / pcm.length
  return 20 * Math.log10(amplitude)
}

const sine =
  (rmsPa: number, f = 1000) =>
  (t: number) =>
    rmsPa * Math.SQRT2 * Math.sin(2 * Math.PI * f * t)
const pa = (dbSpl: number) => 20e-6 * 10 ** (dbSpl / 20)

/** Wake the microphone at f_CLK then record `seconds` of valid data. */
function record(m: Mp45dt02, f: number, seconds: number) {
  const wake = clock(m, f, 1e-6, T_WK + 1e-4)
  return clock(m, f, wake.end, seconds).bits
}

describe("MP45DT02 sensitivity and AOP (Table 3)", () => {
  const F = 2.4e6
  const R = 64

  it("reads a 1 kHz 1 Pa (94 dBSPL) tone at −26 dBFS", () => {
    const m = mic()
    m.setSound(sine(1))
    const bits = record(m, F, 20e-3)
    const level = toneDbfs(decimate(bits, R), F / R, 1000)
    expect(level).toBeGreaterThan(-26.5)
    expect(level).toBeLessThan(-25.5)
  })

  it("stays linear up to 110 dBSPL (−10 dBFS)", () => {
    const m = mic()
    m.setSound(sine(pa(110)))
    const level = toneDbfs(decimate(record(m, F, 20e-3), R), F / R, 1000)
    expect(level).toBeGreaterThan(-10.6)
    expect(level).toBeLessThan(-9.4)
  })

  it("clips beyond the 120 dBSPL acoustic overload point", () => {
    const m = mic()
    m.setSound(sine(pa(130)))
    const pcm = decimate(record(m, F, 20e-3), R)
    const level = toneDbfs(pcm, F / R, 1000)
    // Linear would be +10 dBFS; a hard-clipped full-scale sine tops out at a square wave, 4/π = +2.1 dBFS.
    expect(level).toBeLessThan(2.5)
    expect(level).toBeGreaterThan(-1)
    expect(Math.max(...pcm.map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it("averages to 50 % ones in silence", () => {
    const m = mic()
    const bits = record(m, F, 10e-3)
    const ones = bits.filter((b) => b.bit).length / bits.length
    expect(ones).toBeGreaterThan(0.495)
    expect(ones).toBeLessThan(0.505)
    // Not a stuck pattern: both levels in every short window.
    const pcm = decimate(bits, R)
    expect(Math.max(...pcm.map(Math.abs))).toBeLessThan(0.5)
  })

  it("is deterministic: same object name, same bitstream", () => {
    const a = mic()
    const b = mic()
    a.setSound(sine(1))
    b.setSound(sine(1))
    const x = record(a, F, 1e-3).map((v) => v.bit)
    const y = record(b, F, 1e-3).map((v) => v.bit)
    expect(x).toEqual(y)
  })
})

describe("MP45DT02 DOUT timing, LR = GND (Table 5, Table 7, Figure 2)", () => {
  it("drives the bit T_EN = 30 ns after CLK falls and releases T_DIS = 16 ns after it rises", () => {
    const m = mic()
    const f = 2.4e6
    const wake = clock(m, f, 1e-6, T_WK + 1e-4)
    const period = 1 / f
    const fall = wake.end
    m.input(PINS.clk, false, fall)
    expect(m.out).toHaveLength(1)
    expect(m.out[0].pin).toBe("DOUT")
    expect(typeof m.out[0].level).toBe("boolean")
    expect(m.out[0].time).toBeCloseTo(fall + T_EN, 15)
    expect(m.drive("DOUT")).toBe(m.out[0].level)
    m.out.length = 0
    m.input(PINS.clk, true, fall + period / 2)
    expect(m.out).toEqual([
      { pin: "DOUT", level: null, time: fall + period / 2 + T_DIS },
    ])
    expect(m.drive("DOUT")).toBeNull()
  })

  it("never drives DOUT while CLK is high", () => {
    const m = mic()
    const f = 2.4e6
    const { edges } = clock(m, f, 1e-6, T_WK + 1e-3)
    const period = 1 / f
    for (const e of edges.filter((x) => x.level !== null)) {
      const phase = ((e.time - 1e-6) / period) % 1
      // Falls at phase 0, rises at 0.5: every drive lands T_EN into the low half.
      expect(phase * period).toBeCloseTo(T_EN, 10)
    }
    expect(edges.length).toBeGreaterThan(0)
  })

  it("with LR = Vdd mirrors the phases: data after the rising edge, Hi-Z after the falling", () => {
    const m = new Mp45dt02("U9", PINS, "vdd")
    m.reset()
    m.input(PINS.clk, true, 0)
    const f = 2.4e6
    const wake = clock(m, f, 1e-6, T_WK + 1e-4)
    const period = 1 / f
    m.input(PINS.clk, false, wake.end)
    expect(m.out).toEqual([
      { pin: "DOUT", level: null, time: wake.end + T_DIS },
    ])
    m.out.length = 0
    m.input(PINS.clk, true, wake.end + period / 2)
    expect(m.out).toHaveLength(1)
    expect(typeof m.out[0].level).toBe("boolean")
    expect(m.out[0].time).toBeCloseTo(wake.end + period / 2 + T_EN, 15)
  })
})

describe("MP45DT02 clock, power-down and wake-up (Table 3, Table 5)", () => {
  it("holds DOUT released for T_WK = 10 ms after the first clock edge, then outputs data", () => {
    const m = mic()
    const f = 2.4e6
    const first = 1e-6
    const { bits } = clock(m, f, first, 12e-3)
    expect(bits.length).toBeGreaterThan(0)
    expect(bits[0].time).toBeGreaterThanOrEqual(first + T_WK)
    expect(bits[0].time).toBeLessThan(first + T_WK + 2 / f)
    expect((m.snapshot() as Mp45dt02Snapshot).mode).toBe("active")
  })

  it("measures the clock frequency and duty cycle from the edges", () => {
    const m = mic()
    clock(m, 2.4e6, 1e-6, 1e-4, 0.45)
    const s = m.snapshot() as Mp45dt02Snapshot
    expect(s.clockHz).toBeCloseTo(2.4e6, -3)
    expect(s.duty).toBeCloseTo(0.45, 3)
    expect(s.mode).toBe("wake-up")
  })

  it("outputs nothing with the clock at or below f_PD = 0.23 MHz", () => {
    const m = mic()
    const { edges } = clock(m, 0.2e6, 1e-6, 15e-3)
    expect(edges.filter((e) => e.level !== null)).toEqual([])
    expect(m.drive("DOUT")).toBeNull()
    expect((m.snapshot() as Mp45dt02Snapshot).mode).toBe("power-down")
  })

  it("outputs data at the 1 MHz bottom of the normal range", () => {
    const m = mic()
    const { bits } = clock(m, 1e6, 1e-6, 12e-3)
    expect(bits.length).toBeGreaterThan(1000)
    expect((m.snapshot() as Mp45dt02Snapshot).warnings).toEqual([])
  })

  it("between f_PD and 1 MHz still runs but warns (decision: undocumented band)", () => {
    const m = mic()
    const { bits } = clock(m, 0.5e6, 1e-6, 12e-3)
    expect(bits.length).toBeGreaterThan(0)
    expect((m.snapshot() as Mp45dt02Snapshot).warnings.join(" ")).toMatch(
      /1 MHz/,
    )
  })

  it("warns about a duty cycle outside 40–60 %", () => {
    const m = mic()
    clock(m, 2.4e6, 1e-6, 1e-4, 0.3)
    expect((m.snapshot() as Mp45dt02Snapshot).warnings.join(" ")).toMatch(
      /duty/,
    )
  })

  it("powers down when the clock stops, releasing DOUT, and needs T_WK again after restart", () => {
    const m = mic()
    const f = 2.4e6
    const run = clock(m, f, 1e-6, T_WK + 1e-3)
    // Stop with CLK low, in the data half: DOUT is driven.
    m.input(PINS.clk, false, run.end)
    expect(m.drive("DOUT")).not.toBeNull()
    m.out.length = 0
    const pd = run.end + 1 / F_PD
    expect(m.quietUntil()).toBeCloseTo(pd, 12)
    m.tick(pd - 1e-7)
    expect(m.out).toEqual([])
    m.tick(pd + 1e-7)
    expect(m.out).toEqual([{ pin: "DOUT", level: null, time: pd }])
    expect(m.drive("DOUT")).toBeNull()
    expect((m.snapshot() as Mp45dt02Snapshot).mode).toBe("power-down")
    expect(m.quietUntil()).toBe(Infinity)
    m.out.length = 0
    m.input(PINS.clk, true, pd + 1e-3)
    const restart = pd + 2e-3
    const { bits } = clock(m, f, restart, 11e-3)
    expect(bits[0].time).toBeGreaterThanOrEqual(pd + 1e-3 + T_WK)
  })

  it("is in power-down with Hi-Z output from reset, before any clock", () => {
    const m = mic()
    expect(m.drive("DOUT")).toBeNull()
    expect((m.snapshot() as Mp45dt02Snapshot).mode).toBe("power-down")
    expect(m.pins).toEqual(["CLK", "DOUT"])
    expect(m.outputs).toEqual(["DOUT"])
  })
})

describe("MP45DT02 coverage", () => {
  it("lists what is not modelled", () => {
    expect(NOT_MODELLED.length).toBeGreaterThan(0)
  })
})
