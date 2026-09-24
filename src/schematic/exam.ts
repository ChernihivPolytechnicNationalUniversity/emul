import { ClipboardCheckIcon } from "lucide-react"
import { builder } from "./builder"
import type { Example } from "./examples"
import type { PlacedObject, Schematic } from "./types"

/**
 * A bench of textbook circuits with answers known in closed form, so the simulator can be
 * marked against them: every block below states what it is meant to read. `tests/sim/exam.test.ts`
 * runs the checks headlessly; the same document opens from File › Examples for a look.
 *
 * Blocks share nothing but the drawing: each has its own rail and ground symbol.
 */
export type ExamBench = {
  doc: Schematic
  /** The parts the checks read, by block. */
  parts: {
    zener: { z: PlacedObject; rs: PlacedObject; load: PlacedObject }
    amp: { q: PlacedObject; rc: PlacedObject; re: PlacedObject; src: PlacedObject; load: PlacedObject }
    lowpass: { r: PlacedObject; c: PlacedObject; src: PlacedObject }
    rlc: { r: PlacedObject; l: PlacedObject; c: PlacedObject; src: PlacedObject }
    rectifier: { c: PlacedObject; load: PlacedObject; t: PlacedObject }
    led: { led: PlacedObject; r: PlacedObject; sw: PlacedObject }
    overload: { r: PlacedObject }
    mirror: { q1: PlacedObject; q2: PlacedObject; rref: PlacedObject; load: PlacedObject }
    mosfet: { n: PlacedObject; p: PlacedObject; rn: PlacedObject; rp: PlacedObject; clock: PlacedObject }
  }
}

const V12 = { value: "+12V", voltage: "12 V" }

export function buildExam(grid: number): ExamBench {
  const { doc, place, wire } = builder(grid)
  /** A rail symbol at (x, y) whose pin sits at (x+1, y+2); wires join it on the row below. */
  const rail = (x: number, y: number) => place("supply", x, y, V12)
  const gnd = (x: number, y: number) => place("ground", x, y)
  /** Vertical two-pin part: pin 1 on top at (x+1, y), pin 2 below at (x+1, y+4). */
  const vert = (def: string, x: number, y: number, props: Record<string, string>) => place(def, x, y, props, 90)
  /** Same, flipped: pin 2 on top. Diodes go this way to point their cathode up. */
  const vertUp = (def: string, x: number, y: number, props: Record<string, string>) => place(def, x, y, props, 270)

  // --- 1. Zener shunt regulator: 12 V through 470 Ω into a 5.1 V zener with a 1 kΩ load.
  //     Expect ~5.1 V out and about 9.6 mA through the zener.
  const zener = (() => {
    const ox = 0
    const v = rail(ox + 2, 0)
    const rs = vert("resistor", ox + 2, 4, { value: "470 Ω", power: "0.5" })
    const z = vertUp("zener", ox + 2, 10, { value: "5.1 V", power: "0.5" })
    const load = vert("resistor", ox + 6, 10, { value: "1 kΩ", power: "0.25" })
    const g = gnd(ox + 2, 16)
    wire(v, "V", rs, "1")
    wire(rs, "2", z, "2")
    wire(z, "2", load, "1", [[ox + 3, 9], [ox + 7, 9]])
    wire(z, "1", g, "GND")
    wire(load, "2", g, "GND", [[ox + 7, 15], [ox + 3, 15]])
    return { z, rs, load }
  })()

  // --- 2. Common-emitter amplifier, divider bias, unbypassed emitter: R1 47k / R2 10k,
  //     Rc 2.2k, Re 1k, β 200. Expect Ic ≈ 1.35 mA, Vc ≈ 9 V, gain ≈ −2.2 at 1 kHz.
  const amp = (() => {
    const ox = 12
    const v = rail(ox + 20, 0)
    const rc = vert("resistor", ox + 16, 4, { value: "2.2 kΩ", power: "0.25" })
    const q = place("npn", ox + 14, 9, { value: "BC547", beta: "200" })
    const re = vert("resistor", ox + 16, 14, { value: "1 kΩ", power: "0.25" })
    const r1 = vert("resistor", ox + 8, 4, { value: "47 kΩ", power: "0.25" })
    const j = place("junction", ox + 8, 10)
    const r2 = vert("resistor", ox + 8, 12, { value: "10 kΩ", power: "0.25" })
    const cin = place("capacitor-polarized", ox + 2, 10, { value: "10 µF", vmax: "25 V" })
    const src = place("ac-source", ox - 1, 12, { value: "100 mV", freq: "1 kHz", offset: "0 V", rint: "1 Ω", imax: "1 A" })
    const cout = place("capacitor-polarized", ox + 20, 8, { value: "10 µF", vmax: "25 V" })
    const load = vert("resistor", ox + 24, 10, { value: "10 kΩ", power: "0.25" })
    const g = gnd(ox + 16, 20)
    wire(v, "V", rc, "1", [[ox + 21, 3], [ox + 17, 3]])
    wire(v, "V", r1, "1", [[ox + 21, 3], [ox + 9, 3]])
    wire(rc, "2", q, "C")
    wire(q, "E", re, "1")
    wire(re, "2", g, "GND")
    wire(r1, "2", j, "J")
    wire(r2, "1", j, "J")
    wire(q, "B", j, "J")
    wire(r2, "2", g, "GND", [[ox + 9, 19], [ox + 17, 19]])
    // Anode towards the base, which sits at +2 V; the source side is at 0 V.
    wire(src, "+", cin, "2")
    wire(cin, "1", j, "J")
    wire(src, "-", g, "GND", [[ox, 19], [ox + 17, 19]])
    wire(q, "C", cout, "1", [[ox + 17, 8], [ox + 19, 8], [ox + 19, 9]])
    wire(cout, "2", load, "1")
    wire(load, "2", g, "GND", [[ox + 25, 19], [ox + 17, 19]])
    return { q, rc, re, src, load }
  })()

  // --- 3. RC low-pass driven at its corner frequency: 1 kΩ, 100 nF, fc = 1591.5 Hz.
  //     Expect |Vout| = Vin / √2 ≈ 0.707 V RMS, 45° behind.
  const lowpass = (() => {
    const ox = 0
    const oy = 24
    const src = place("ac-source", ox, oy + 2, { value: "1 V", freq: "1591.5 Hz", offset: "0 V", rint: "0.1 Ω", imax: "1 A" })
    const r = place("resistor", ox + 2, oy, { value: "1 kΩ", power: "0.25" })
    const c = vert("capacitor", ox + 6, oy + 2, { value: "100 nF", vmax: "50 V" })
    const g = gnd(ox + 6, oy + 8)
    wire(src, "+", r, "1")
    wire(r, "2", c, "1")
    wire(c, "2", g, "GND")
    wire(src, "-", g, "GND", [[ox + 1, oy + 7], [ox + 7, oy + 7]])
    return { r, c, src }
  })()

  // --- 4. Series RLC at resonance: 10 Ω, 10 mH, 1 µF → f0 = 1591.5 Hz, Q = 10.
  //     Expect 100 mA RMS and 10 V RMS across the capacitor from a 1 V source.
  const rlc = (() => {
    const ox = 12
    const oy = 24
    const src = place("ac-source", ox, oy + 2, { value: "1 V", freq: "1591.5 Hz", offset: "0 V", rint: "0.1 Ω", imax: "1 A" })
    const r = place("resistor", ox + 2, oy, { value: "10 Ω", power: "5" })
    const l = place("inductor", ox + 6, oy, { value: "10 mH", imax: "1 A" })
    const c = vert("capacitor", ox + 10, oy + 2, { value: "1 µF", vmax: "50 V" })
    const g = gnd(ox + 10, oy + 8)
    wire(src, "+", r, "1")
    wire(r, "2", l, "1")
    wire(l, "2", c, "1")
    wire(c, "2", g, "GND")
    wire(src, "-", g, "GND", [[ox + 1, oy + 7], [ox + 11, oy + 7]])
    return { r, l, c, src }
  })()

  // --- 5. Bridge rectifier: 230 V → 12 V, 1000 µF, 100 Ω load.
  //     Expect ~15.5 V peak and ripple ≈ I / (2 f C) ≈ 1.5 V.
  const rectifier = (() => {
    const ox = 28
    const oy = 24
    const mains = place("ac-source", ox, oy + 4)
    const t = place("transformer", ox + 4, oy + 4)
    const diode = { value: "1N4007", vf: "0.7", imax: "1 A", vrev: "1000 V" }
    const d1 = place("diode", ox + 13, oy + 2, diode, 315)
    const d2 = place("diode", ox + 17, oy + 2, diode, 225)
    const d3 = place("diode", ox + 13, oy + 6, diode, 225)
    const d4 = place("diode", ox + 17, oy + 6, diode, 315)
    const c = vertUp("capacitor-polarized", ox + 26, oy + 2, { value: "1000 µF", vmax: "25 V" })
    const load = vert("resistor", ox + 30, oy + 2, { value: "100 Ω", power: "5" })
    const g = gnd(ox + 16, oy + 13)
    wire(mains, "+", t, "P1")
    wire(mains, "-", t, "P2")
    wire(t, "S1", d1, "1")
    wire(d1, "1", d3, "2")
    wire(t, "S2", d2, "1", [[ox + 10, oy + 16], [ox + 24, oy + 16], [ox + 24, oy + 6]])
    wire(d2, "1", d4, "2")
    wire(d1, "2", d2, "2")
    // Anode (pin 1) on the positive rail.
    wire(d2, "2", c, "1")
    wire(c, "1", load, "1")
    wire(d3, "1", d4, "1")
    wire(d3, "1", g, "GND")
    wire(c, "2", g, "GND")
    wire(load, "2", c, "2")
    return { c, load, t }
  })()

  // --- 6. LED behind a switch: 12 V, 1 kΩ, red LED (Vf 1.9 V at 10 mA).
  //     Expect nothing with the switch open and ≈10.1 mA with it closed.
  const led = (() => {
    const ox = 42
    const v = rail(ox + 2, 0)
    const sw = vert("switch", ox + 2, 4, { value: "SPST" })
    const r = vert("resistor", ox + 2, 9, { value: "1 kΩ", power: "0.25" })
    const d = vert("led", ox + 2, 14, { value: "red", imax: "30 mA" })
    const g = gnd(ox + 2, 19)
    wire(v, "V", sw, "1")
    wire(sw, "2", r, "1")
    wire(r, "2", d, "1")
    wire(d, "2", g, "GND")
    return { led: d, r, sw }
  })()

  // --- 7. Overload: 100 Ω rated ¼ W straight across 12 V dissipates 1.44 W.
  //     Expect it to burn open within a few milliseconds and the current to stop.
  const overload = (() => {
    const ox = 48
    const v = rail(ox + 2, 0)
    const r = vert("resistor", ox + 2, 4, { value: "100 Ω", power: "0.25" })
    const g = gnd(ox + 2, 9)
    wire(v, "V", r, "1")
    wire(r, "2", g, "GND")
    return { r }
  })()

  // --- 8. Current mirror: 10 kΩ sets Iref ≈ 1.13 mA in Q1; Q2 copies it into a 1 kΩ load.
  //     Expect Iout ≈ Iref · β/(β+2) ≈ 1.12 mA, Vload ≈ 1.1 V.
  const mirror = (() => {
    const ox = 54
    const v = rail(ox + 6, 0)
    const rref = vert("resistor", ox + 2, 4, { value: "10 kΩ", power: "0.25" })
    const load = vert("resistor", ox + 10, 4, { value: "1 kΩ", power: "0.25" })
    const q1 = place("npn", ox, 9, { value: "BC547", beta: "200" })
    const q2 = place("npn", ox + 8, 9, { value: "BC547", beta: "200" })
    const j = place("junction", ox + 4, 10)
    const g = gnd(ox + 4, 15)
    wire(v, "V", rref, "1", [[ox + 7, 3], [ox + 3, 3]])
    wire(v, "V", load, "1", [[ox + 7, 3], [ox + 11, 3]])
    wire(rref, "2", q1, "C")
    wire(load, "2", q2, "C")
    // Diode-connected Q1: collector tied to its base, and to Q2's base.
    wire(q1, "C", j, "J", [[ox + 3, 8], [ox + 5, 8]])
    wire(q1, "B", q1, "C", [[ox - 1, 11], [ox - 1, 8]])
    wire(q2, "B", j, "J")
    wire(q1, "E", g, "GND", [[ox + 3, 14], [ox + 5, 14]])
    wire(q2, "E", g, "GND", [[ox + 11, 14], [ox + 5, 14]])
    return { q1, q2, rref, load }
  })()

  // --- 9. MOSFET switches: an N-channel low-side switch clocked at 1 kHz, 50 % duty, and a
  //     P-channel high-side switch held on. Expect 120 mA through each 100 Ω when on, the
  //     N-channel drain averaging half the rail, and the clock reading 2.5 V mean / 3.54 V RMS.
  const mosfet = (() => {
    const ox = 74
    const v = rail(ox + 6, 0)
    const rn = vert("resistor", ox + 2, 4, { value: "100 Ω", power: "5" })
    const n = place("nmos", ox, 9)
    const clock = place("pulse-source", ox - 5, 10, { high: "5 V", low: "0 V", freq: "1 kHz", duty: "50" })
    const p = place("pmos", ox + 8, 4)
    const rp = vert("resistor", ox + 10, 9, { value: "100 Ω", power: "5" })
    const g = gnd(ox + 4, 15)
    wire(v, "V", rn, "1", [[ox + 7, 3], [ox + 3, 3]])
    wire(v, "V", p, "S", [[ox + 7, 3], [ox + 11, 3]])
    wire(rn, "2", n, "D")
    wire(clock, "+", n, "G")
    wire(clock, "-", g, "GND", [[ox - 4, 14], [ox + 5, 14]])
    wire(n, "S", g, "GND", [[ox + 3, 14], [ox + 5, 14]])
    wire(p, "D", rp, "1")
    wire(p, "G", g, "GND", [[ox + 7, 6], [ox + 7, 8], [ox + 5, 8], [ox + 5, 14]])
    wire(rp, "2", g, "GND", [[ox + 11, 14], [ox + 5, 14]])
    return { n, p, rn, rp, clock }
  })()

  return { doc, parts: { zener, amp, lowpass, rlc, rectifier, led, overload, mirror, mosfet } }
}

export const systemExam: Example = {
  id: "system-exam",
  name: "System exam",
  description: "Nine textbook circuits with known answers: regulator, amplifier, filters, rectifier, LED, overload, current mirror, MOSFET switches.",
  icon: ClipboardCheckIcon,
  build: (grid) => buildExam(grid).doc,
}
