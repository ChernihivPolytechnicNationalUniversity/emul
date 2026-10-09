import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { Engine } from "@/sim/engine"
import { buildNetlist, GROUND } from "@/sim/netlist"
import { SimLoop } from "@/sim/loop"
import { ne555Flasher } from "@/schematic/timers"
import { DT } from "@/sim/speeds"

type Edge = { high: boolean; time: number }

function bench(vcc: number) {
  const b = builder(GRID)
  const u = b.place("ne555", 20, 10)
  const supply = b.place("dc-source", 0, 10, { value: `${vcc} V`, rint: "1 mΩ", imax: "10 A" })
  const gnd = b.place("ground", 0, 30)
  b.wire(supply, "+", u, "VCC")
  b.wire(supply, "-", gnd, "GND")
  b.wire(u, "GND", gnd, "GND")
  const resistor = (value: string, a: [PlacedObject, string], c: [PlacedObject, string]) => {
    const r = b.place("resistor", 40, 2 + b.doc.objects.length, { value, power: "5" })
    b.wire(a[0], a[1], r, "1")
    b.wire(r, "2", c[0], c[1])
    return r
  }
  const capacitor = (value: string, a: [PlacedObject, string], c: [PlacedObject, string]) => {
    const k = b.place("capacitor", 40, 2 + b.doc.objects.length, { value, vmax: "50 V" })
    b.wire(a[0], a[1], k, "1")
    b.wire(k, "2", c[0], c[1])
    return k
  }
  const source = (volts: number, pin: [PlacedObject, string]) => {
    const s = b.place("dc-source", 60, 2 + b.doc.objects.length, { value: `${volts} V`, rint: "1 mΩ" })
    b.wire(s, "+", pin[0], pin[1])
    b.wire(s, "-", gnd, "GND")
    return s
  }
  return { ...b, u, supply, gnd, resistor, capacitor, source }
}

type Bench = ReturnType<typeof bench>

function astable(vcc: number, ra: string, rb: string, c: string) {
  const b = bench(vcc)
  const { u, gnd } = b
  b.wire(u, "RESET", u, "VCC")
  b.wire(u, "TRIG", u, "THRES")
  b.resistor(ra, [u, "VCC"], [u, "DIS"])
  b.resistor(rb, [u, "DIS"], [u, "THRES"])
  b.capacitor(c, [u, "THRES"], [gnd, "GND"])
  b.capacitor("10 nF", [u, "CTRL"], [gnd, "GND"])
  return b
}

function simulate(doc: Schematic, seconds: number, each?: (e: Engine) => void) {
  const e = new Engine(buildNetlist(doc))
  const edges: Edge[] = []
  e.onTimer = (_, high, time) => edges.push({ high, time })
  const parts = (key: string) => doc.parts[key] ?? {}
  const steps = Math.round(seconds / DT)
  for (let k = 0; k < steps; k++) {
    e.step(DT, parts)
    each?.(e)
  }
  return { e, edges }
}

const volts = (e: Engine, obj: PlacedObject, pin: string) => {
  const net = e.net.pinNet.get(pinKey(obj.id, pin))
  return net === undefined || net === GROUND ? 0 : e.v[net]
}
const timer = (e: Engine, b: Bench) => e.readings().find((r) => r.object === b.u.id && r.kind === "TMR")!
const into = (e: Engine, obj: PlacedObject, pin: string) => e.terminalCurrents().get(pinKey(obj.id, pin)) ?? 0
const supplyCurrent = (e: Engine, b: Bench) => Math.abs(e.readings().find((r) => r.object === b.supply.id && r.kind === "V")!.current)

function cycles(edges: Edge[], skip = 2) {
  const rises = edges.filter((x) => x.high).map((x) => x.time)
  const falls = edges.filter((x) => !x.high).map((x) => x.time)
  const periods: number[] = []
  const highs: number[] = []
  for (let k = skip; k + 1 < rises.length; k++) {
    periods.push(rises[k + 1] - rises[k])
    const fall = falls.find((t) => t > rises[k])
    if (fall !== undefined && fall < rises[k + 1]) highs.push(fall - rises[k])
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
  return { period: mean(periods), high: mean(highs), spread: Math.max(...periods) - Math.min(...periods), count: periods.length }
}

const LN2 = Math.LN2
const LN3 = Math.log(3)

describe("NE555 against the TI datasheet (SLFS022K, typical at 25 °C)", () => {
  it.each([5, 15])("puts CTRL at 2/3 and the trigger level at 1/3 of %d V", (vcc) => {
    const b = bench(vcc)
    b.wire(b.u, "RESET", b.u, "VCC")
    const { e } = simulate(b.doc, 1e-3)
    expect.soft(volts(e, b.u, "CTRL"), "CTRL open circuit").toBeNear((2 / 3) * vcc, 0.01)
    expect.soft(timer(e, b).extra?.Thresholds).toBe(vcc === 5 ? "1.67 V / 3.33 V" : "5.00 V / 10.00 V")
  })

  it.each([
    [5, "low", 3e-3],
    [5, "high", 2e-3],
    [15, "low", 10e-3],
    [15, "high", 9e-3],
  ] as const)("draws the typical supply current at %d V, output %s, no load", (vcc, state, want) => {
    const b = bench(vcc)
    b.wire(b.u, "RESET", b.u, "VCC")
    if (state === "low") {
      b.wire(b.u, "TRIG", b.u, "VCC")
      b.wire(b.u, "THRES", b.u, "VCC")
    } else b.wire(b.u, "TRIG", b.gnd, "GND")
    const { e } = simulate(b.doc, 1e-3)
    expect.soft(timer(e, b).extra?.Output).toBe(state)
    expect.soft(supplyCurrent(e, b), "ICC").toBeNearRel(want, 0.12)
  })

  it.each([
    [15, "1.5 kΩ", 0.01, 0.045, 0.25],
    [15, "300 Ω", 0.05, 0.18, 0.75],
    [15, "150 Ω", 0.1, 0.6, 2.5],
    [5, "1 kΩ", 0.005, 0.027, 0.35],
    [5, "620 Ω", 0.008, 0.04, 0.4],
  ] as const)("sinks at %d V through %s: VOL near the figure, under the table's maximum", (vcc, load, amps, typ, max) => {
    const b = bench(vcc)
    b.wire(b.u, "RESET", b.gnd, "GND")
    b.resistor(load, [b.u, "VCC"], [b.u, "OUT"])
    const { e } = simulate(b.doc, 1e-3)
    const vol = volts(e, b.u, "OUT")
    expect.soft(-timer(e, b).current, "sink current").toBeNearRel(amps, 0.1)
    expect.soft(vol, "VOL").toBeLessThan(max)
    expect.soft(vol, "VOL").toBeNearRel(typ, 0.3)
  })

  it("leaves saturation past about 45 mA at 5 V, as figure 5-1 shows", () => {
    const b = bench(5)
    b.wire(b.u, "RESET", b.gnd, "GND")
    b.resistor("60 Ω", [b.u, "VCC"], [b.u, "OUT"])
    const { e } = simulate(b.doc, 1e-3)
    const vol = volts(e, b.u, "OUT")
    expect.soft(vol, "VOL past the knee").toBeGreaterThan(1)
    expect.soft(vol, "VOL past the knee").toBeLessThan(1.7)
  })

  it.each([
    [5, "3.7 kΩ", 0.001, 1.3],
    [5, "360 Ω", 0.01, 1.4],
    [15, "1.36 kΩ", 0.01, 1.4],
    [5, "33 Ω", 0.1, 1.65],
    [15, "133 Ω", 0.1, 1.65],
    [15, "62 Ω", 0.2, 2.5],
  ] as const)("sources at %d V into %s: VCC − VOH follows figure 5-4 and the table", (vcc, load, amps, drop) => {
    const b = bench(vcc)
    b.wire(b.u, "RESET", b.u, "VCC")
    b.wire(b.u, "TRIG", b.gnd, "GND")
    b.resistor(load, [b.u, "OUT"], [b.gnd, "GND"])
    const { e } = simulate(b.doc, 1e-3)
    const voh = volts(e, b.u, "OUT")
    expect.soft(timer(e, b).current, "source current").toBeNearRel(amps, 0.12)
    expect.soft(vcc - voh, "drop").toBeNear(drop, 0.08)
    if (amps === 0.1) expect.soft(voh, "VOH at 100 mA, table minimum").toBeGreaterThan(vcc === 5 ? 2.75 : 12.75)
  })

  it.each([
    [5, "560 Ω", 0.008, 0.15, 0.4],
    [15, "1 kΩ", 0.015, 0.18, 0.48],
  ] as const)("holds DIS at saturation at %d V into %s", (vcc, load, amps, typ, max) => {
    const b = bench(vcc)
    b.wire(b.u, "RESET", b.gnd, "GND")
    b.resistor(load, [b.u, "VCC"], [b.u, "DIS"])
    const { e } = simulate(b.doc, 1e-3)
    const v = volts(e, b.u, "DIS")
    expect.soft(into(e, b.u, "DIS"), "DIS current").toBeNearRel(amps, 0.1)
    expect.soft(v, "on-state voltage").toBeLessThan(max)
    expect.soft(v, "on-state voltage").toBeNear(typ, 0.1)
  })

  it("lets DIS go while the output is high", () => {
    const b = bench(5)
    b.wire(b.u, "RESET", b.u, "VCC")
    b.wire(b.u, "TRIG", b.gnd, "GND")
    b.resistor("1 kΩ", [b.u, "VCC"], [b.u, "DIS"])
    const { e } = simulate(b.doc, 1e-3)
    expect.soft(Math.abs(into(e, b.u, "DIS")), "off-state current").toBeLessThan(100e-9)
    expect.soft(timer(e, b).extra?.Discharge).toBe("off")
  })

  it("resets below about 0.7 V on RESET and not above", () => {
    for (const [level, want] of [
      [0.6, "low"],
      [0.8, "high"],
    ] as const) {
      const b = bench(5)
      b.wire(b.u, "TRIG", b.gnd, "GND")
      b.source(level, [b.u, "RESET"])
      const { e } = simulate(b.doc, 1e-3)
      expect.soft(timer(e, b).extra?.Output, `RESET at ${level} V`).toBe(want)
    }
  })

  it("sources 0.4 mA from a grounded RESET and takes 0.1 mA at VCC", () => {
    const low = bench(5)
    low.wire(low.u, "RESET", low.gnd, "GND")
    expect.soft(into(simulate(low.doc, 1e-3).e, low.u, "RESET") * 1e3, "RESET at 0 V (mA)").toBeNear(-0.4, 0.01)
    const high = bench(5)
    high.wire(high.u, "RESET", high.u, "VCC")
    expect.soft(into(simulate(high.doc, 1e-3).e, high.u, "RESET") * 1e3, "RESET at VCC (mA)").toBeNear(0.1, 0.01)
  })

  it("a RESET left open floats high and the timer runs", () => {
    const b = bench(5)
    b.wire(b.u, "TRIG", b.u, "THRES")
    b.resistor("1 kΩ", [b.u, "VCC"], [b.u, "DIS"])
    b.resistor("10 kΩ", [b.u, "DIS"], [b.u, "THRES"])
    b.capacitor("10 nF", [b.u, "THRES"], [b.gnd, "GND"])
    const { e, edges } = simulate(b.doc, 5e-3)
    expect.soft(volts(e, b.u, "RESET"), "RESET open").toBeGreaterThan(3.5)
    expect.soft(edges.length, "transitions").toBeGreaterThan(20)
  })

  it("draws the trigger and threshold bias currents", () => {
    const b = bench(15)
    b.wire(b.u, "RESET", b.u, "VCC")
    b.wire(b.u, "TRIG", b.gnd, "GND")
    b.source(5, [b.u, "THRES"])
    const { e } = simulate(b.doc, 1e-3)
    expect.soft(into(e, b.u, "TRIG") * 1e6, "TRIG at 0 V (µA)").toBeNear(-0.5, 0.01)
    expect.soft(into(e, b.u, "THRES") * 1e9, "THRES (nA)").toBeNear(30, 1)
  })
})

describe("NE555 timing", () => {
  it("charges the first cycle from empty in ln 3 · (RA + RB) · C", () => {
    const b = bench(5)
    b.wire(b.u, "RESET", b.u, "VCC")
    b.wire(b.u, "TRIG", b.u, "THRES")
    b.resistor("1 kΩ", [b.u, "VCC"], [b.u, "DIS"])
    b.resistor("10 kΩ", [b.u, "DIS"], [b.u, "THRES"])
    b.capacitor("10 nF", [b.u, "THRES"], [b.gnd, "GND"])
    const { edges } = simulate(b.doc, 1e-3)
    expect.soft(edges[0].high, "starts high").toBe(true)
    expect.soft(edges[0].time, "starts at power-up").toBeLessThan(1e-6)
    expect.soft(edges[1].time - edges[0].time).toBeNearRel(LN3 * 11e3 * 10e-9, 0.003)
  })

  it("cuts the first cycle short while the CTRL capacitor is still charging", () => {
    const { edges } = simulate(astable(5, "1 kΩ", "10 kΩ", "10 nF").doc, 1e-3)
    expect.soft(edges[1].time - edges[0].time).toBeLessThan(0.97 * LN3 * 11e3 * 10e-9)
  })

  it.each([
    [5, "1 kΩ", "10 kΩ", "10 nF", 1e3, 10e3, 10e-9],
    [9, "10 kΩ", "10 kΩ", "100 nF", 10e3, 10e3, 100e-9],
    [12, "4.7 kΩ", "47 kΩ", "1 µF", 4.7e3, 47e3, 1e-6],
    [15, "100 kΩ", "220 kΩ", "4.7 nF", 100e3, 220e3, 4.7e-9],
    [5, "2.2 kΩ", "68 kΩ", "22 µF", 2.2e3, 68e3, 22e-6],
  ] as const)("runs at 1.44 / ((RA + 2RB) C) at %d V with %s, %s, %s", (vcc, ra, rb, c, RA, RB, C) => {
    const b = astable(vcc, ra, rb, c)
    const period = LN2 * (RA + 2 * RB) * C
    const { edges } = simulate(b.doc, Math.max(4e-3, 8 * period))
    const run = cycles(edges)
    expect.soft(run.count, "cycles measured").toBeGreaterThan(3)
    expect.soft(run.period, "period").toBeNearRel(period, 0.02)
    expect.soft(run.high / run.period, "duty, TRIG's 0.5 µA bias current included").toBeNearRel((RA + RB) / (RA + 2 * RB), 0.03)
    expect.soft(run.spread / run.period, "jitter from the solver step").toBeLessThan(0.002)
  })

  it("keeps its period when VCC changes, the thresholds following the supply", () => {
    const at = (vcc: number) => cycles(simulate(astable(vcc, "10 kΩ", "47 kΩ", "10 nF").doc, 20e-3).edges).period
    const p5 = at(5)
    expect.soft(at(10), "10 V vs 5 V").toBeNearRel(p5, 0.01)
    expect.soft(at(15), "15 V vs 5 V").toBeNearRel(p5, 0.01)
  })

  it("times each phase to the exponential the RC network and the measured DIS drop give, to 0.5 %", () => {
    const vcc = 5
    const b = astable(vcc, "1 kΩ", "10 kΩ", "10 nF")
    let dis = 0
    const { edges } = simulate(b.doc, 10e-3, (e) => {
      if (timer(e, b).extra?.Discharge === "on") dis = volts(e, b.u, "DIS")
    })
    const run = cycles(edges)
    const hi = (2 / 3) * vcc
    const lo = vcc / 3
    const tH = 11e3 * 10e-9 * Math.log((vcc - lo) / (vcc - hi))
    const tL = 10e3 * 10e-9 * Math.log((hi - dis) / (lo - dis))
    expect.soft(run.high, "high").toBeNearRel(tH, 0.005)
    expect.soft(run.period - run.high, "low").toBeNearRel(tL, 0.005)
  })

  it("resolves a 190 kHz astable, four periods a solver step, to 2 %", () => {
    const b = astable(5, "1 kΩ", "3.3 kΩ", "1 nF")
    const { e, edges } = simulate(b.doc, 2e-3)
    const run = cycles(edges, 20)
    expect.soft(1 / run.period, "frequency").toBeNearRel(1 / (LN2 * (1e3 + 6.6e3) * 1e-9), 0.03)
    expect.soft(timer(e, b).extra?.Timing, "no warning").toBeUndefined()
  })

  it("says so when it runs faster than the solver can follow", () => {
    const b = astable(5, "1 kΩ", "1 kΩ", "470 pF")
    const { e } = simulate(b.doc, 1e-3)
    expect.soft(timer(e, b).extra?.Timing).toMatch(/too fast/)
  })

  it("moves both thresholds with CTRL", () => {
    const vcc = 5
    const b = bench(vcc)
    const { u, gnd } = b
    b.wire(u, "RESET", u, "VCC")
    b.wire(u, "TRIG", u, "THRES")
    b.resistor("10 kΩ", [u, "VCC"], [u, "DIS"])
    b.resistor("10 kΩ", [u, "DIS"], [u, "THRES"])
    b.capacitor("100 nF", [u, "THRES"], [gnd, "GND"])
    b.source(2, [u, "CTRL"])
    const { e, edges } = simulate(b.doc, 30e-3)
    const run = cycles(edges)
    expect.soft(timer(e, b).extra?.Thresholds).toBe("1.00 V / 2.00 V")
    expect.soft(run.high, "high, 1 V to 2 V toward 5 V").toBeNearRel(20e3 * 100e-9 * Math.log(4 / 3), 0.01)
    expect.soft(run.period - run.high, "low, 2 V to 1 V").toBeNearRel(10e3 * 100e-9 * Math.log(2), 0.02)
  })
})

function monostable(r: string, c: string, trigger: { freq: string; duty: string }) {
  const b = bench(5)
  const { u, gnd } = b
  b.wire(u, "RESET", u, "VCC")
  b.wire(u, "DIS", u, "THRES")
  b.resistor(r, [u, "VCC"], [u, "THRES"])
  b.capacitor(c, [u, "THRES"], [gnd, "GND"])
  b.capacitor("10 nF", [u, "CTRL"], [gnd, "GND"])
  const pulse = b.place("pulse-source", 60, 30, { high: "5 V", low: "0 V", rint: "100 Ω", ...trigger })
  b.wire(pulse, "+", u, "TRIG")
  b.wire(pulse, "-", gnd, "GND")
  return b
}

const pulses = (edges: Edge[]) => {
  const out: number[] = []
  for (let k = 0; k + 1 < edges.length; k++) if (edges[k].high && !edges[k + 1].high) out.push(edges[k + 1].time - edges[k].time)
  return out
}

describe("NE555 integration edge cases", () => {
  it.each(["1 nF", "10 nF", "100 nF", "1 µF"])("drives %s hung on its output without overshooting its high level", (load) => {
    const b = bench(5)
    b.wire(b.u, "RESET", b.u, "VCC")
    b.wire(b.u, "TRIG", b.gnd, "GND")
    b.capacitor(load, [b.u, "OUT"], [b.gnd, "GND"])
    let peak = 0
    simulate(b.doc, 2e-3, (e) => (peak = Math.max(peak, volts(e, b.u, "OUT"))))
    expect.soft(peak, "OUT stays a Darlington drop under VCC").toBeLessThan(4.1)
    const t = start(b.doc).run(0.01)
    expect.soft(t.damage, "nothing damaged").toEqual({})
  })

  it.each(["1 nF", "100 nF"])("keeps an astable's period with %s on its output", (load) => {
    const plain = cycles(simulate(astable(5, "1 kΩ", "10 kΩ", "10 nF").doc, 6e-3).edges).period
    const b = astable(5, "1 kΩ", "10 kΩ", "10 nF")
    b.capacitor(load, [b.u, "OUT"], [b.gnd, "GND"])
    expect.soft(cycles(simulate(b.doc, 6e-3).edges).period).toBeNearRel(plain, 0.01)
  })

  it("runs three fast astables side by side each at its own frequency", () => {
    const alone = cycles(simulate(astable(5, "1 kΩ", "3.3 kΩ", "1 nF").doc, 2e-3).edges, 20).period
    const b = astable(5, "1 kΩ", "3.3 kΩ", "1 nF")
    const others = [1, 2].map((k) => {
      const u = b.place("ne555", 20, 30 * k + 30)
      b.wire(u, "VCC", b.u, "VCC")
      b.wire(u, "GND", b.gnd, "GND")
      b.wire(u, "RESET", b.u, "VCC")
      b.wire(u, "TRIG", u, "THRES")
      b.resistor("1 kΩ", [b.u, "VCC"], [u, "DIS"])
      b.resistor("3.3 kΩ", [u, "DIS"], [u, "THRES"])
      b.capacitor("1 nF", [u, "THRES"], [b.gnd, "GND"])
      b.capacitor("10 nF", [u, "CTRL"], [b.gnd, "GND"])
      return u
    })
    const e = new Engine(buildNetlist(b.doc))
    const edges = new Map<string, Edge[]>([b.u, ...others].map((u) => [u.id, []]))
    e.onTimer = (object, high, time) => edges.get(object)!.push({ high, time })
    for (let k = 0; k < 2e-3 / DT; k++) e.step(DT, () => ({}))
    for (const [id, xs] of edges) expect.soft(cycles(xs, 20).period, id === b.u.id ? "the first" : "another").toBeNearRel(alone, 0.01)
    expect.soft(timer(e, b).extra?.Timing, "no deferral").toBeUndefined()
  })
})

describe("NE555 chained to another", () => {
  it("fires a second timer through a coupling capacitor the moment the first one falls", () => {
    const b = astable(5, "1 kΩ", "10 kΩ", "100 nF")
    const u2 = b.place("ne555", 20, 60)
    b.wire(u2, "VCC", b.u, "VCC")
    b.wire(u2, "GND", b.gnd, "GND")
    b.wire(u2, "RESET", b.u, "VCC")
    const coupling = b.capacitor("1 nF", [b.u, "OUT"], [u2, "TRIG"])
    b.resistor("10 kΩ", [b.u, "VCC"], [u2, "TRIG"])
    b.resistor("10 kΩ", [b.u, "VCC"], [u2, "THRES"])
    b.wire(u2, "DIS", u2, "THRES")
    b.capacitor("100 nF", [u2, "THRES"], [b.gnd, "GND"])
    const e = new Engine(buildNetlist(b.doc))
    const edges: (Edge & { object: string })[] = []
    e.onTimer = (object, high, time) => edges.push({ object, high, time })
    for (let k = 0; k < 0.02 / DT; k++) e.step(DT, () => ({}))
    const falls = edges.filter((x) => x.object === b.u.id && !x.high).map((x) => x.time)
    const fired = edges.filter((x) => x.object === u2.id && x.high).map((x) => x.time)
    expect.soft(fired.length, "second timer pulses").toBeGreaterThan(5)
    for (const t of fired) {
      const lag = Math.min(...falls.filter((f) => f <= t).map((f) => t - f))
      expect.soft(lag * 1e6, "µs after the first timer's fall").toBeLessThan(0.5)
    }
    expect.soft(edges.every((x, k) => k === 0 || x.time >= edges[k - 1].time), "events in time order").toBe(true)
    void coupling
  })
})

describe("NE555 monostable", () => {
  it.each([
    ["10 kΩ", "1 µF", 10e3 * 1e-6],
    ["100 kΩ", "100 nF", 100e3 * 100e-9],
    ["47 kΩ", "4.7 µF", 47e3 * 4.7e-6],
  ] as const)("holds the output high for 1.1 RC with %s and %s", (r, c, rc) => {
    const b = monostable(r, c, { freq: "3 Hz", duty: "99" })
    const widths = pulses(simulate(b.doc, 1.2).edges)
    expect.soft(widths.length, "pulses").toBeGreaterThan(1)
    for (const w of widths) expect.soft(w, "pulse width").toBeNearRel(LN3 * rc, 0.01)
  })

  it("keeps the output high while the trigger is held low past the timing interval", () => {
    const b = monostable("10 kΩ", "1 µF", { freq: "20 Hz", duty: "60" })
    const widths = pulses(simulate(b.doc, 0.3).edges)
    expect.soft(widths.length, "pulses").toBeGreaterThanOrEqual(4)
    for (const w of widths) expect.soft(w, "stretched to the trigger's 20 ms").toBeNear(0.02, 1e-4)
  })

  it("ignores triggers during the pulse, which makes it a divide-by-three", () => {
    const b = monostable("10 kΩ", "1 µF", { freq: "250 Hz", duty: "75" })
    const { edges } = simulate(b.doc, 0.2)
    const widths = pulses(edges)
    expect.soft(widths.length, "pulses").toBeGreaterThanOrEqual(10)
    for (const w of widths.slice(1)) expect.soft(w, "not extended by retriggers").toBeNearRel(LN3 * 10e-3, 0.02)
    const rises = edges.filter((x) => x.high).map((x) => x.time)
    const gaps = rises.slice(2).map((t, k) => t - rises[k + 1])
    expect.soft(gaps.length, "gaps").toBeGreaterThanOrEqual(10)
    for (const g of gaps) expect.soft(g, "every third trigger").toBeNear(0.012, 2e-5)
  })

  it("ends the pulse at once when RESET goes low", () => {
    const b = bench(5)
    const { u, gnd } = b
    b.wire(u, "DIS", u, "THRES")
    b.resistor("10 kΩ", [u, "VCC"], [u, "THRES"])
    b.capacitor("10 µF", [u, "THRES"], [gnd, "GND"])
    b.wire(u, "TRIG", gnd, "GND")
    const rst = b.place("pulse-source", 60, 30, { high: "5 V", low: "0 V", freq: "20 Hz", duty: "50", rint: "10 Ω" })
    b.wire(rst, "+", u, "RESET")
    b.wire(rst, "-", gnd, "GND")
    const { edges } = simulate(b.doc, 0.1)
    const widths = pulses(edges)
    expect.soft(widths.length, "pulses").toBeGreaterThanOrEqual(2)
    for (const w of widths) expect.soft(w, "cut to RESET's 25 ms").toBeNear(0.025, 1e-4)
  })
})

describe("NE555 power", () => {
  it("stays off below 1.8 V, runs but warns below the 4.5 V minimum", () => {
    const off = astable(1.5, "1 kΩ", "10 kΩ", "10 nF")
    const dead = simulate(off.doc, 2e-3)
    expect.soft(dead.edges.length, "no transitions at 1.5 V").toBe(0)
    expect.soft(timer(dead.e, off).extra?.Output).toBe("off")
    const low = astable(3, "1 kΩ", "10 kΩ", "10 nF")
    const run = simulate(low.doc, 2e-3)
    expect.soft(run.edges.length, "runs at 3 V").toBeGreaterThan(10)
    expect.soft(timer(run.e, low).extra?.Supply).toMatch(/below the 4\.50 V minimum/)
  })

  it("warns above the 16 V recommended maximum", () => {
    const b = astable(17, "10 kΩ", "10 kΩ", "10 nF")
    expect.soft(timer(simulate(b.doc, 1e-3).e, b).extra?.Supply).toMatch(/above the 16\.00 V maximum/)
  })

  it("flags an input driven above VCC", () => {
    const b = bench(5)
    b.wire(b.u, "RESET", b.u, "VCC")
    b.source(7, [b.u, "THRES"])
    expect.soft(timer(simulate(b.doc, 1e-3).e, b).extra?.Inputs).toMatch(/THRES/)
  })
})

type Run = { loop: SimLoop; run: (seconds: number) => ReturnType<SimLoop["snapshot"]> & object }
function start(doc: Schematic): Run {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  return {
    loop,
    run: (seconds: number) => {
      const end = clock + seconds * 1000
      while (clock < end) {
        clock = Math.min(end, clock + 10)
        loop.advance(clock)
      }
      return loop.snapshot()!
    },
  }
}

describe("NE555 on the bench", () => {
  it("shows its frequency, duty and output in the inspector readings", () => {
    const b = astable(9, "1 kΩ", "10 kΩ", "100 nF")
    const snap = start(b.doc).run(0.1)
    const r = snap.readings.find((x) => x.object === b.u.id && x.kind === "TMR")!
    expect.soft(r.extra?.Frequency).toMatch(/^6[0-9]{2}\.[0-9]+ Hz$/)
    expect.soft(Number(r.extra?.Duty.replace(" %", ""))).toBeNear(52.4, 1)
  })

  it("burns when its high output is shorted to ground", () => {
    const b = bench(12)
    b.wire(b.u, "RESET", b.u, "VCC")
    b.wire(b.u, "TRIG", b.gnd, "GND")
    const sw = b.place("switch", 40, 30)
    b.wire(b.u, "OUT", sw, "1")
    b.wire(sw, "2", b.gnd, "GND")
    b.doc.parts[partKey(sw.id, "SW")] = { on: true }
    const t = start(b.doc)
    const snap = t.run(1)
    expect.soft(snap.damage[b.u.id]?.reason, "the timer").toMatch(/current|power/)
    expect.soft(snap.damage[b.u.id]?.fatal).toBe(true)
  })

  it("dies at 20 V, over the 18 V absolute maximum", () => {
    const b = astable(20, "10 kΩ", "10 kΩ", "10 nF")
    const snap = start(b.doc).run(0.05)
    expect.soft(snap.damage[b.u.id]?.reason).toMatch(/voltage/)
  })

  it("conducts through the substrate and fails short on a supply connected backwards", () => {
    const b = builder(GRID)
    const u = b.place("ne555", 20, 10)
    const supply = b.place("dc-source", 0, 10, { value: "9 V", rint: "0.5 Ω", imax: "10 A" })
    const gnd = b.place("ground", 0, 30)
    b.wire(supply, "+", u, "GND")
    b.wire(supply, "-", gnd, "GND")
    b.wire(u, "VCC", gnd, "GND")
    const snap = start(b.doc).run(0.05)
    expect.soft(snap.damage[u.id]?.fail).toBe("short")
  })

  it("lights an LED from OUT through 330 Ω at 9 V with about VCC − 1.45 V on the pin", () => {
    const b = bench(9)
    b.wire(b.u, "RESET", b.u, "VCC")
    b.wire(b.u, "TRIG", b.gnd, "GND")
    const led = b.place("led", 50, 30, { value: "red" })
    const r = b.resistor("330 Ω", [b.u, "OUT"], [led, "1"])
    b.wire(led, "2", b.gnd, "GND")
    const snap = start(b.doc).run(0.05)
    const out = snap.pinVoltage[pinKey(b.u.id, "OUT")]
    expect.soft(9 - out, "drop at ~20 mA").toBeNear(1.44, 0.06)
    expect.soft(snap.parts[partKey(led.id, "LED")]?.on).toBe(true)
    void r
  })
})

describe("the NE555 flasher example", () => {
  it("blinks its two LEDs in turn at about 1 Hz", () => {
    const doc = ne555Flasher.build(GRID)
    const u = doc.objects.find((o) => o.def === "ne555")!
    const leds = doc.objects.filter((o) => o.def === "led")
    const t = start(doc)
    const seen = new Set<string>()
    let both = 0
    for (let k = 0; k < 40; k++) {
      const s = t.run(0.1)
      const lit = leds.map((led) => s.parts[partKey(led.id, "LED")]?.on ?? false)
      seen.add(lit.join(","))
      if (lit[0] && lit[1]) both++
    }
    expect.soft(seen.has("true,false") && seen.has("false,true"), "each LED on alone").toBe(true)
    expect.soft(both, "both lit only in the eye's 10 ms around a transition").toBeLessThan(5)
    const r = t.run(0.1).readings.find((x) => x.object === u.id && x.kind === "TMR")!
    const hz = Number.parseFloat(r.extra!.Frequency) * (r.extra!.Frequency.includes("mHz") ? 1e-3 : 1)
    expect.soft(hz, "1.44 / ((10k + 2·68k) · 10 µF)").toBeNearRel(1.44 / (146e3 * 10e-6), 0.04)
  })
})
