import { describe, expect, it } from "vitest"
import { LogicStore } from "@/components/logic/logic-store"
import { STM32F746IG } from "@/mcu/chip"
import { parseElf } from "@/mcu/elf"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { DT } from "@/sim/speeds"
import { nextPulseEdge, pulseHigh, pulseTiming } from "@/sim/pulse"
import { buffer, example } from "../lib/firmware"

const TIMER_HZ = 108e6
const ONE_TICK = 1
const ELF = example("open746-capture.elf")
const BENCH = parseElf(buffer(ELF)).symbols.find((s) => s.name === "bench")!.value
const CAPTURES = 64
const BENCH_SIZE = 12 + 4 * CAPTURES + CAPTURES
const STRIP_GND = "P18-35"
const BOOTED_BY = 0.008
const ANALYSER_HIGH_OF_3V3 = 0.7

const board = getDef("open746i-c")!
const PA15 = board.pins.find((p) => /^P(18|19|20|21)-\d+$/.test(p.id) && p.mcu === "PA15")!.id

type Signal = { variant: string; freq: string; duty?: string; width?: string; seconds: number }

const SIGNALS: Signal[] = [
  { variant: "3, the lowest frequency", freq: "200 Hz", duty: "50", seconds: 0.005 },
  { variant: "3, the highest frequency", freq: "1 kHz", duty: "50", seconds: 0.001 },
  { variant: "4, the longest period", freq: "200 Hz", duty: "25", seconds: 0.005 },
  { variant: "4, the shortest period", freq: "1 kHz", duty: "25", seconds: 0.001 },
  { variant: "5, the narrowest pulse", freq: "100 Hz", width: "2 ms", seconds: 0.01 },
  { variant: "5, 8 ms", freq: "100 Hz", width: "8 ms", seconds: 0.01 },
  { variant: "6, the shortest gap", freq: "500 Hz", width: "0.8 ms", seconds: 0.002 },
  { variant: "9, the lowest frequency", freq: "100 Hz", duty: "25", seconds: 0.01 },
  { variant: "10, the shortest period", freq: "500 Hz", duty: "25", seconds: 0.002 },
  { variant: "11, the 0.2 ms bound", freq: "1 kHz", width: "0.2 ms", seconds: 0.001 },
  { variant: "11, 0.1 % of a bound", freq: "1 kHz", width: "0.2002 ms", seconds: 0.001 },
  { variant: "12, the 0.5 ms gap", freq: "250 Hz", width: "3.5 ms", seconds: 0.004 },
  { variant: "a fractional duty", freq: "1 kHz", duty: "37.5", seconds: 0.001 },
]

const CONSTANT: { variant: string; freq: string; duty?: string; width?: string; level: number }[] = [
  { variant: "11, width 0: 0 %", freq: "1 kHz", width: "0 s", level: 0 },
  { variant: "6, gap 2 ms at 500 Hz: 0 %", freq: "500 Hz", duty: "0", level: 0 },
  { variant: "12, gap 0: 100 %", freq: "250 Hz", width: "4 ms", level: 1 },
  { variant: "5, width 10 ms at 100 Hz: 100 %", freq: "100 Hz", duty: "100", level: 1 },
]

type Run = { count: number; overcaptures: number; ticks: number[]; levels: number[]; store: LogicStore; idle: number; lowest: number; highest: number; vdd: number }

async function capture(props: Record<string, string>, seconds: number, capacitor?: string): Promise<Run> {
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "open746-capture.elf", firmwareData: ELF.toString("base64") }
  const added = builder(GRID)
  const source = added.place("pulse-source", 90, 10, { high: "3.3 V", low: "0 V", ...props })
  added.wire(source, "+", u, PA15)
  added.wire(source, "-", u, STRIP_GND)
  if (capacitor) {
    const c = added.place("capacitor", 95, 10, { value: capacitor })
    added.wire(c, "1", u, PA15)
    added.wire(c, "2", u, STRIP_GND)
  }
  doc.objects.push(...added.doc.objects)
  doc.wires.push(...added.doc.wires)
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setProbes([{ id: "PA15", a: pinKey(u.id, PA15), b: null }])
  loop.setLogic(true)
  loop.setRunning(true)
  const store = new LogicStore()
  let clock = 0
  loop.advance(clock)
  const end = (BOOTED_BY + seconds) * 1000
  let lowest = Infinity
  let highest = -Infinity
  while (clock < end) {
    clock = Math.min(end, clock + 1)
    loop.advance(clock)
    const snap = loop.snapshot()
    if (snap?.logic) store.push(snap.logic, snap.traceProbes)
    const v = snap?.pinVoltage[pinKey(u.id, PA15)]
    if (v !== undefined && clock > end / 2) {
      lowest = Math.min(lowest, v)
      highest = Math.max(highest, v)
    }
  }
  const idle = loop.snapshot()!.pinVoltage[pinKey(u.id, PA15)]
  const vdd = loop.snapshot()!.pinVoltage[pinKey(u.id, "P23-1")]
  const reply = await loop.inspect(u.id, { ranges: [{ addr: BENCH, size: BENCH_SIZE }] })
  loop.dispose()
  const bytes = reply!.memory[0].bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(view.getUint32(0, true), "the capture firmware is ready").toBe(1)
  const count = view.getUint32(4, true)
  const ticks = Array.from({ length: Math.min(count, CAPTURES) }, (_, i) => view.getUint32(12 + 4 * i, true))
  const levels = Array.from({ length: Math.min(count, CAPTURES) }, (_, i) => view.getUint8(12 + 4 * CAPTURES + i))
  return { count, overcaptures: view.getUint32(8, true), ticks, levels, store, idle, lowest, highest, vdd }
}

const secondsOf = (props: { freq: string; duty?: string; width?: string }) => {
  const freq = Number.parseFloat(props.freq) * (props.freq.includes("k") ? 1e3 : 1)
  const width = props.width === undefined ? NaN : Number.parseFloat(props.width) * (props.width.includes("ms") ? 1e-3 : 1)
  return { period: 1 / freq, width: Number.isFinite(width) ? width : (Number(props.duty) / 100) * (1 / freq) }
}

describe("pulse source edges into an MCU input are exact", () => {
  it("times its edges from the delay, a period apart, high for the width, in the model's own arithmetic", () => {
    const timing = pulseTiming({ frequency: 1000, duty: 0.25, delay: 3e-4 })
    const edges: number[] = []
    for (let e = nextPulseEdge(0, timing); e && edges.length < 6; e = nextPulseEdge(e.time, timing)) edges.push(e.time)
    expect(edges.map((t) => Math.round(t * 1e9))).toEqual([300000, 550000, 1300000, 1550000, 2300000, 2550000])
    expect(pulseHigh(2.9e-4, { frequency: 1000, duty: 0.25, delay: 3e-4 }), "before the delay").toBe(false)
    expect(pulseHigh(5.4e-4, { frequency: 1000, duty: 0.25, delay: 3e-4 }), "inside the first pulse").toBe(true)
    expect(pulseHigh(1e-3, { frequency: 1000, duty: 0, delay: 0 }), "0 %").toBe(false)
    expect(pulseHigh(1e-3, { frequency: 1000, duty: 1, delay: 0 }), "100 %").toBe(true)
  })

  it("never rises at 0 Hz and 0 %, delay or not, in the exact edges as in the analog level", () => {
    for (const delay of [0, 1e-3]) {
      const source = { frequency: 0, duty: 0, delay }
      expect(nextPulseEdge(0, pulseTiming(source)), `delay ${delay}`).toBeNull()
      expect(pulseHigh(2e-3, source), `delay ${delay}`).toBe(false)
    }
  })

  it.each(SIGNALS)("TIM2 at 108 MHz captures variant $variant ($freq) to one tick", async (signal) => {
    const { freq, duty, width } = signal
    const run = await capture({ freq, ...(duty === undefined ? {} : { duty }), ...(width === undefined ? {} : { width }) }, 6 * signal.seconds)
    const want = secondsOf(signal)
    expect(run.overcaptures, "no capture lost").toBe(0)
    expect(run.count, "edges captured").toBeGreaterThanOrEqual(8)
    expect(run.levels.every((level, i) => i === 0 || level !== run.levels[i - 1]), "edges alternate").toBe(true)
    const rises = run.ticks.filter((_, i) => run.levels[i] === 1)
    const widths = run.ticks.flatMap((t, i) => (i > 0 && run.levels[i - 1] === 1 ? [t - run.ticks[i - 1]] : []))
    expect(rises.length).toBeGreaterThanOrEqual(4)
    for (let k = 1; k < rises.length; k++) expect.soft(rises[k] - rises[k - 1], `period ${k}`).toBeNear(want.period * TIMER_HZ, ONE_TICK)
    for (const [k, w] of widths.entries()) expect.soft(w, `width ${k}`).toBeNear(want.width * TIMER_HZ, ONE_TICK)
  })

  it.each(CONSTANT)("variant $variant is a constant level: nothing to capture", async ({ freq, duty, width, level }) => {
    const run = await capture({ freq, ...(duty === undefined ? {} : { duty }), ...(width === undefined ? {} : { width }) }, 0.01)
    expect(run.count, "edges captured after the firmware started").toBe(0)
    expect(run.idle > 1.65 ? 1 : 0, "the level on PA15").toBe(level)
  })

  it("starts at its delay, on the exact microsecond, as the analyser sees it", async () => {
    const run = await capture({ freq: "1 kHz", duty: "50", delay: "9.3 ms" }, 0.004)
    const edges = run.store.edges("PA15")!
    const times = [...edges.times].filter((t) => t > 0.009)
    expect(times.slice(0, 4).map((t) => Math.round(t * 1e9))).toEqual([9300000, 9800000, 10300000, 10800000])
    expect(run.levels[0], "the first capture is the first rising edge").toBe(1)
  })

  describe("only while the net follows the source: a source the circuit loads gives the analog net's edges", () => {
    it("keeps PA15 between the thresholds behind 100 kΩ into 100 nF, so TIM2 captures nothing", async () => {
      const run = await capture({ freq: "1 kHz", duty: "50", rint: "100 kΩ" }, 0.06, "100 nF")
      const { rising, falling } = STM32F746IG.electrical.inputThresholdsOfVdd
      expect(run.highest, "never up to VIH").toBeLessThan(rising * run.vdd)
      expect(run.lowest, "never down to VIL").toBeGreaterThan(falling * run.vdd)
      expect(run.count, "edges captured").toBe(0)
    })

    it("lets the analyser see the first rise late by the climb of τ = 1 kΩ × 100 nF, five solver steps, and TIM2 a period a millisecond apart", async () => {
      const tau = 1e3 * 100e-9
      const run = await capture({ freq: "1 kHz", duty: "50", delay: "9.3 ms", rint: "1 kΩ" }, 0.006, "100 nF")
      const edges = run.store.edges("PA15")!
      const firstRise = [...edges.times].find((t, i) => t > 0.009 && edges.levels[i] === 1)!
      const climb = tau * Math.log(1 / (1 - ANALYSER_HIGH_OF_3V3))
      expect(firstRise - 9.3e-3, "late by the climb to the analyser's threshold").toBeNear(climb, 3 * DT)
      const rises = run.ticks.filter((_, i) => run.levels[i] === 1)
      expect(rises.length).toBeGreaterThanOrEqual(4)
      for (let k = 1; k < rises.length; k++) expect.soft(rises[k] - rises[k - 1], `period ${k}`).toBeNear(1e-3 * TIMER_HZ, DT * TIMER_HZ)
    })

    it("still follows a 1 Ω source into 100 nF, τ = 100 ns, far inside a solver step: its first edge on the exact microsecond", async () => {
      const run = await capture({ freq: "1 kHz", duty: "50", delay: "9.3 ms" }, 0.002, "100 nF")
      const edges = run.store.edges("PA15")!
      expect([...edges.times].filter((t) => t > 0.009).slice(0, 2).map((t) => Math.round(t * 1e9))).toEqual([9300000, 9800000])
    })
  })
})
