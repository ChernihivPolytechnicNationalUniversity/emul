/**
 * Pads toggling into listen-only loads (an LCD's inputs with their pull-ups, a pin's own
 * capacitance) on a rail that is not stiff: an ATmega328P fed from 5 V through a Schottky,
 * a 10 µF bulk capacitor and an LED on the rail. The solver may take such a toggle without a
 * full Newton solve only while the rail's answer to the load change stays within a millivolt;
 * against the same circuit solved in full every step, every node and every reading agrees.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { Engine } from "@/sim/engine"
import { buildNetlist, type GpioState } from "@/sim/netlist"
import { DT } from "@/sim/speeds"

function bench() {
  const { doc, place, wire } = builder(GRID)
  const s = place("supply", 0, 0, { voltage: "5 V", imax: "3 A" })
  const g = place("ground", 0, 20)
  const d = place("diode", 4, 0, { value: "SS14", vf: "0.35", imax: "1 A" })
  const u = place("atmega328p", 20, 0)
  const bulk = place("capacitor-polarized", 10, 6, { value: "10 µF", vmax: "16 V" })
  const r = place("resistor", 12, 0, { value: "220 Ω", power: "0.25" })
  const led = place("led", 14, 0, { value: "red", imax: "20 mA" })
  const up = place("resistor", 30, 0, { value: "40 kΩ", power: "0.25" })
  const load = place("resistor", 30, 6, { value: "1 kΩ", power: "0.25" })
  wire(s, "V", d, "1")
  for (const [o, p] of [[u, "VCC"], [u, "AVCC"], [bulk, "1"], [r, "1"], [up, "1"]] as const) wire(d, "2", o, p)
  wire(r, "2", led, "1")
  for (const [o, p] of [[led, "2"], [bulk, "2"], [u, "GND"], [load, "2"], [s, "GND"]] as const) wire(o, p, g, "GND")
  wire(u, "PB0", up, "2")
  wire(u, "PB1", load, "1")
  return { doc, u, up, load }
}

/**
 * Both engines through `steps` steps with the pads as `pins` has them at each; the worst node
 * difference, the worst current difference over 1 % of the current (past the power-up), and the
 * factorizations of each.
 */
function race(b: ReturnType<typeof bench>, pins: (step: number, node: string) => GpioState, steps: number) {
  const fast = new Engine(buildNetlist(b.doc))
  const full = new Engine(buildNetlist(b.doc))
  full.leafPath = false
  let step = 0
  const read = (_: number, object: string, node: string) => (object === b.u.id ? pins(step, node) : null)
  const parts = () => ({})
  let volts = 0
  let amps = 0
  for (; step < steps; step++) {
    fast.step(DT, parts, read)
    full.step(DT, parts, read)
    expect(fast.failures).toEqual([])
    for (let i = 0; i < full.v.length; i++) volts = Math.max(volts, Math.abs(fast.v[i] - full.v[i]))
    if (step < 500) continue
    const a = fast.readings()
    const f = full.readings()
    for (let i = 0; i < f.length; i++) amps = Math.max(amps, Math.abs(a[i].current - f[i].current) - 0.01 * Math.abs(f[i].current))
  }
  return { volts, amps, fast: fast.factorizationCount, full: full.factorizationCount }
}

/** 20 ms of power-up first (a firmware's init delays), then the traffic. */
const QUIET = 1000
const toggle = (step: number, period: number, first: GpioState, second: GpioState) => (Math.floor(Math.max(0, step - QUIET) / period) % 2 ? second : first)

describe("a pad toggling into a listen-only load", () => {
  it("PB0 into its 40 kΩ pull-up every 3 steps: as the full solve reads, with a fifth of its factorizations", () => {
    const r = race(bench(), (step, node) => (node === "PB0" ? toggle(step, 3, "high", "low") : node === "PB1" ? "low" : null), 6000)
    expect(r.volts, "worst node voltage difference (V)").toBeLessThan(1.5e-3)
    expect(r.amps, "worst current difference past 1 % (A)").toBeLessThan(40e-6)
    expect(r.fast, "factorizations").toBeLessThan(r.full / 5)
  })

  it("PB1 into 1 kΩ every 50 steps besides (5 mA: more than a millivolt on the rail, solved in full): still as the full solve reads", () => {
    // A millivolt left on the bulk capacitor drives 38 µA through its 26.5 Ω ESR when the next load step comes.
    const r = race(bench(), (step, node) => (node === "PB0" ? toggle(step, 3, "high", "low") : node === "PB1" ? toggle(step, 50, "low", "high") : null), 6000)
    expect(r.volts, "worst node voltage difference (V)").toBeLessThan(1.5e-3)
    expect(r.amps, "worst current difference past 1 % (A)").toBeLessThan(40e-6)
    expect(r.fast, "factorizations").toBeLessThan(r.full)
  })
})
