/**
 * A circuit whose capacitors are still easing off the last load step is taken as settled once
 * what they have left to move every node by is under 10 µV. The bench: an ATmega328P on a 5 V
 * rail behind a 0.5 Ω polyfuse and a Schottky (an Arduino Nano's USB feed), 200 Ω for the board's own 25 mA (the core at 16 MHz, Table 29-8, and a
 * USB bridge: the loop puts the core's on as its supply current, a bare engine does not), a pad
 * driving an LED through 220 Ω (not a leaf: the LED is nonlinear), a Nano's 100 nF on AREF and
 * its 100 nF from DTR# into RESET (both ends pulled to +5V: a load step leaves it easing off for
 * many steps by nanoamps, as are the pins' own picofarads; the strict rule waits them out), and
 * optionally a slow RC
 * charging from the rail. The rail is either the Nano's +5V as its model has it (no bulk
 * capacitance: settled within a few steps of an edge) or held by a 10 µF and a 47 µF electrolytic,
 * their ESR in series (still easing off when the next PWM edge comes). Against the same circuit held to the strict
 * rule (every node still within a microvolt, every capacitor drifting under a millivolt a
 * second), every node and reading agrees, and the slow RC is never frozen while it has volts to go.
 * Both engines take every pad toggle in full (`leafPath` off: the leaf shortcut, which a settled
 * circuit opens, has its own tolerance and its own test, engine-leaf).
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { Engine } from "@/sim/engine"
import { buildNetlist, type GpioState } from "@/sim/netlist"
import { DT } from "@/sim/speeds"

function bench(rail: "nano" | "electrolytic", slow: boolean) {
  const { doc, place, wire } = builder(GRID)
  const s = place("supply", 0, 0, { voltage: "5 V", imax: "3 A" })
  const g = place("ground", 0, 20)
  const fuse = place("resistor", 2, -6, { value: "0.5 Ω", power: "0.25" })
  const d = place("diode", 4, 0, { value: "SS14", vf: "0.35", imax: "1 A" })
  const u = place("atmega328p", 20, 0)
  const r = place("resistor", 60, 0, { value: "220 Ω", power: "0.25" })
  const led = place("led", 66, 0, { value: "red", imax: "20 mA" })
  const board = place("resistor", 50, 30, { value: "200 Ω", power: "0.25" })
  const aref = place("capacitor", 40, 30, { value: "100 nF", vmax: "16 V" })
  // A Nano's reset coupling: DTR# (450 Ω out of +5V) into RESET through 100 nF, RESET pulled to +5V by 1 kΩ.
  const dtr = place("resistor", 30, 40, { value: "450 Ω", power: "0.25" })
  const c4 = place("capacitor", 36, 40, { value: "100 nF", vmax: "16 V" })
  const rp = place("resistor", 42, 40, { value: "1 kΩ", power: "0.25" })
  wire(s, "V", fuse, "1")
  wire(fuse, "2", d, "1")
  for (const [o, p] of [[u, "VCC"], [u, "AVCC"], [board, "1"]] as const) wire(d, "2", o, p)
  if (rail === "electrolytic")
    for (const [x, value] of [[10, "10 µF"], [50, "47 µF"]] as const) {
      const c = place("capacitor-polarized", x, 6, { value, vmax: "16 V" })
      wire(d, "2", c, "1")
      wire(c, "2", g, "GND")
    }
  wire(u, "PB1", r, "1")
  wire(u, "AREF", aref, "1")
  wire(d, "2", dtr, "1")
  wire(dtr, "2", c4, "1")
  wire(c4, "2", u, "PC6")
  wire(d, "2", rp, "1")
  wire(rp, "2", u, "PC6")
  wire(r, "2", led, "1")
  for (const [o, p] of [[led, "2"], [board, "2"], [aref, "2"], [u, "GND"], [s, "GND"]] as const) wire(o, p, g, "GND")
  if (slow) {
    // τ = 100 kΩ × 10 µF = 1 s, from the rail: volts still to go for seconds.
    const rs = place("resistor", 60, 20, { value: "100 kΩ", power: "0.25" })
    const cs = place("capacitor", 66, 20, { value: "10 µF", vmax: "16 V" })
    wire(d, "2", rs, "1")
    wire(rs, "2", cs, "1")
    wire(cs, "2", g, "GND")
  }
  return { doc, u }
}

/**
 * Both engines through `steps` steps with PB1 as `pin` has it at each; the worst node
 * difference, the worst current difference over 1 % of the current (past the power-up), and the
 * factorizations of each.
 */
function race(b: ReturnType<typeof bench>, pin: (step: number) => GpioState, steps: number) {
  const fast = new Engine(buildNetlist(b.doc))
  const full = new Engine(buildNetlist(b.doc))
  full.tailPath = false
  fast.leafPath = false
  full.leafPath = false
  let step = 0
  const read = (_: number, object: string, node: string) => (object === b.u.id && node === "PB1" ? pin(step) : null)
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

/** 20 ms of power-up first, then PB1 toggling every `period` steps (50: Arduino's 490 Hz PWM at half duty). */
const QUIET = 1000
const pwm = (period: number) => (step: number): GpioState => (step < QUIET || Math.floor((step - QUIET) / period) % 2 ? "low" : "high")

describe("capacitors easing off a load step", () => {
  it("an LED pulsed on a Nano's rail: as the strict rule reads, with under a third of its factorizations", () => {
    const r = race(bench("nano", false), pwm(50), 8000)
    expect(r.volts, "worst node voltage difference (V)").toBeLessThan(50e-6)
    expect(r.amps, "worst current difference past 1 % (A)").toBeLessThan(5e-6)
    expect(r.fast, "factorizations").toBeLessThan(r.full / 3)
  })

  it("an LED pulsed on electrolytics still easing off at the next edge: as the strict rule reads, never more factorizations", () => {
    const r = race(bench("electrolytic", false), pwm(50), 8000)
    expect(r.volts, "worst node voltage difference (V)").toBeLessThan(50e-6)
    expect(r.amps, "worst current difference past 1 % (A)").toBeLessThan(5e-6)
    expect(r.fast, "factorizations").toBeLessThanOrEqual(r.full)
  })

  for (const rail of ["nano", "electrolytic"] as const)
    it(`a 1 s RC charging from the ${rail} rail is never frozen on the way: its voltage is the strict rule's`, () => {
      const r = race(bench(rail, true), pwm(50), 8000)
      expect(r.volts, "worst node voltage difference (V)").toBeLessThan(50e-6)
      expect(r.amps, "worst current difference past 1 % (A)").toBeLessThan(5e-6)
    })

  it("the 1 s RC alone after power-up: it charges on, step for step with the strict rule", () => {
    const r = race(bench("electrolytic", true), () => "low", 8000)
    expect(r.volts, "worst node voltage difference (V)").toBeLessThan(50e-6)
  })
})
