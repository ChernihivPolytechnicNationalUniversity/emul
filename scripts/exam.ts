/**
 * Marks the simulator against the "System exam" schematic: runs it headlessly through the
 * same SimLoop the worker uses and compares what it reads with the textbook answers.
 *
 *   pnpm exam
 *
 * Exit code 1 when any check is outside its tolerance.
 */
import { GRID } from "@/schematic/geometry"
import { buildExam } from "@/schematic/exam"
import { partKey, pinKey, type PlacedObject } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { formatSI } from "@/sim/units"

const { doc, parts } = buildExam(GRID)

// Probes: instantaneous, RMS, mean and extremes between two pins (or a pin and ground).
const P = {
  zenerOut: { id: "zenerOut", a: pinKey(parts.zener.z.id, "2"), b: null },
  ampIn: { id: "ampIn", a: pinKey(parts.amp.q.id, "B"), b: null },
  ampOut: { id: "ampOut", a: pinKey(parts.amp.load.id, "1"), b: null },
  ampC: { id: "ampC", a: pinKey(parts.amp.q.id, "C"), b: null },
  ampE: { id: "ampE", a: pinKey(parts.amp.q.id, "E"), b: null },
  lpIn: { id: "lpIn", a: pinKey(parts.lowpass.r.id, "1"), b: null },
  lpOut: { id: "lpOut", a: pinKey(parts.lowpass.c.id, "1"), b: null },
  rlcC: { id: "rlcC", a: pinKey(parts.rlc.c.id, "1"), b: null },
  rectOut: { id: "rectOut", a: pinKey(parts.rectifier.load.id, "1"), b: null },
  mirrorLoad: { id: "mirrorLoad", a: pinKey(parts.mirror.load.id, "2"), b: null },
  clock: { id: "clock", a: pinKey(parts.mosfet.clock.id, "+"), b: null },
  nDrain: { id: "nDrain", a: pinKey(parts.mosfet.n.id, "D"), b: null },
}

const loop = new SimLoop()
loop.setDoc(doc)
loop.setProbes(Object.values(P))
const failures: string[] = []
loop.onFailure = (f) => failures.push(`${f.ref}: ${f.damage.reason}`)
loop.setRunning(true)

/** Advance the loop by `seconds` of simulated time in wall-clock sized ticks. */
let clock = 0
loop.advance(clock)
function run(seconds: number) {
  const end = clock + seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 30)
    loop.advance(clock)
  }
}

/** Operating point of an object's first model element. */
const reading = (snap: Snapshot, o: PlacedObject, element = 0) => {
  const r = snap.readings.find((x) => x.object === o.id && x.element === element)
  if (!r) throw new Error(`no reading for ${o.props?.ref ?? o.id}`)
  return r
}
const probe = (snap: Snapshot, p: { id: string }) => snap.probes[p.id]

type Check = { block: string; what: string; got: number; want: number; tol: number; unit: string; note?: string }
const checks: Check[] = []
const expect = (c: Check) => checks.push(c)

// Everything settles well inside a second: the slowest thing is the 10 µF coupling into
// ~8 kΩ (τ ≈ 80 ms) and the rectifier's 1000 µF into 100 Ω (τ = 100 ms).
run(1.0)
const snap = loop.snapshot()!

// 1. Zener regulator
{
  const vz = probe(snap, P.zenerOut).avg
  const iz = reading(snap, parts.zener.z).current
  const irs = reading(snap, parts.zener.rs).current
  expect({ block: "Zener", what: "output voltage", got: vz, want: 5.1, tol: 0.05, unit: "V" })
  expect({ block: "Zener", what: "series current", got: irs, want: (12 - 5.1) / 470, tol: 0.05, unit: "A" })
  expect({ block: "Zener", what: "zener current", got: Math.abs(iz), want: (12 - 5.1) / 470 - 5.1 / 1000, tol: 0.08, unit: "A" })
}

// 2. Common-emitter amplifier
{
  const q = reading(snap, parts.amp.q)
  const vc = probe(snap, P.ampC).avg
  const ve = probe(snap, P.ampE).avg
  // Bias point from the Thevenin base network with Vbe ≈ 0.66 V at this current.
  const vth = (12 * 10) / 57
  const rth = (47e3 * 10e3) / 57e3
  const ib = (vth - 0.66) / (rth + 201 * 1e3)
  const ic = 200 * ib
  expect({ block: "CE amp", what: "collector current", got: q.current, want: ic, tol: 0.05, unit: "A" })
  expect({ block: "CE amp", what: "collector voltage", got: vc, want: 12 - ic * 2.2e3, tol: 0.05, unit: "V" })
  expect({ block: "CE amp", what: "emitter voltage", got: ve, want: 201 * ib * 1e3, tol: 0.05, unit: "V" })
  const vin = probe(snap, P.ampIn)
  const vout = probe(snap, P.ampOut)
  const ampIn = (vin.max - vin.min) / 2
  const ampOut = (vout.max - vout.min) / 2
  // Unbypassed emitter: |Av| = Rc ∥ RL / (Re + re), re = VT / Ic.
  const re = 0.025852 / ic
  const rcl = (2.2e3 * 10e3) / 12.2e3
  expect({ block: "CE amp", what: "voltage gain", got: ampOut / ampIn, want: rcl / (1e3 + re), tol: 0.1, unit: "×" })
  expect({ block: "CE amp", what: "region", got: q.extra?.region === "active" ? 1 : 0, want: 1, tol: 0, unit: "", note: q.extra?.region })
}

// 3. RC low-pass at fc
{
  const vin = probe(snap, P.lpIn).rms
  const vout = probe(snap, P.lpOut).rms
  expect({ block: "RC low-pass", what: "input RMS", got: vin, want: 1, tol: 0.02, unit: "V" })
  expect({ block: "RC low-pass", what: "output / input at fc", got: vout / vin, want: Math.SQRT1_2, tol: 0.05, unit: "×" })
}

// 4. Series RLC at resonance
{
  const i = reading(snap, parts.rlc.r).rms!.current
  const vc = probe(snap, P.rlcC).rms
  expect({ block: "RLC", what: "current at f0", got: i, want: 1 / 10.1, tol: 0.15, unit: "A", note: "Q = 10; the integrator's damping shows here" })
  expect({ block: "RLC", what: "capacitor voltage (Q·Vin)", got: vc, want: 10 / 1.01, tol: 0.15, unit: "V" })
}

// 5. Bridge rectifier
{
  const out = probe(snap, P.rectOut)
  const vpk = 12 * Math.SQRT2 - 2 * 0.75
  const iload = out.avg / 100
  expect({ block: "Rectifier", what: "peak output", got: out.max, want: vpk, tol: 0.1, unit: "V", note: "less the winding drops under the charging peaks — a small transformer regulates poorly" })
  expect({ block: "Rectifier", what: "ripple", got: out.max - out.min, want: iload / (2 * 50 * 1000e-6), tol: 0.3, unit: "V", note: "I/(2fC) is itself an estimate" })
}

// 6. LED behind a switch: open first, then closed
{
  const dark = reading(snap, parts.led.led).current
  expect({ block: "LED", what: "current, switch open", got: dark, want: 0, tol: 0, unit: "A" })
  loop.setParts({ [partKey(parts.led.sw.id, "SW")]: { on: true } })
  run(0.1)
  const lit = loop.snapshot()!
  const i = reading(lit, parts.led.led).current
  const on = lit.parts[partKey(parts.led.led.id, "LED")]?.on ? 1 : 0
  expect({ block: "LED", what: "current, switch closed", got: i, want: (12 - 1.9) / 1000, tol: 0.03, unit: "A" })
  expect({ block: "LED", what: "lit", got: on, want: 1, tol: 0, unit: "" })
}

// 7. Overload
{
  const r = parts.overload.r
  const burnt = snap.damage[r.id]
  // A burnt-open part leaves the netlist altogether, so it has no reading and no current.
  const after = snap.readings.find((x) => x.object === r.id)?.current ?? 0
  expect({ block: "Overload", what: "¼ W resistor at 1.44 W fails", got: burnt ? 1 : 0, want: 1, tol: 0, unit: "", note: burnt?.reason })
  expect({ block: "Overload", what: "current after failure", got: after, want: 0, tol: 0, unit: "A" })
}

// 8. Current mirror
{
  const iref = reading(snap, parts.mirror.rref).current
  const iout = reading(snap, parts.mirror.q2).current
  const vload = 12 - probe(snap, P.mirrorLoad).avg
  const wantRef = (12 - 0.66) / 10e3
  expect({ block: "Mirror", what: "reference current", got: iref, want: wantRef, tol: 0.05, unit: "A" })
  expect({ block: "Mirror", what: "mirrored current", got: iout, want: (wantRef * 200) / 202, tol: 0.05, unit: "A" })
  expect({ block: "Mirror", what: "load voltage", got: vload, want: (wantRef * 200 * 1e3) / 202, tol: 0.05, unit: "V" })
}

// 9. MOSFET switches
{
  const clock = probe(snap, P.clock)
  expect({ block: "MOSFET", what: "clock mean", got: clock.avg, want: 2.5, tol: 0.03, unit: "V" })
  expect({ block: "MOSFET", what: "clock RMS", got: clock.rms, want: 5 * Math.SQRT1_2, tol: 0.03, unit: "V" })
  // On: Vgs = 5 V, k from Rds(on) = 22 mΩ at 8 V overdrive → ~59 mΩ at 3 V overdrive.
  const k = 1 / (2 * 0.022 * 8)
  const ron = 1 / (2 * k * 3)
  const ion = 12 / (100 + ron)
  const drain = probe(snap, P.nDrain)
  const nRead = reading(snap, parts.mosfet.n)
  expect({ block: "MOSFET", what: "N drain, off level", got: drain.max, want: 12, tol: 0.01, unit: "V" })
  expect({ block: "MOSFET", what: "N drain, on level", got: drain.min, want: ion * ron, tol: 0.1, unit: "V" })
  expect({ block: "MOSFET", what: "N drain mean (50 % duty)", got: drain.avg, want: (12 + ion * ron) / 2, tol: 0.02, unit: "V" })
  expect({ block: "MOSFET", what: "N drain current RMS", got: nRead.rms!.current, want: ion * Math.SQRT1_2, tol: 0.03, unit: "A" })
  const pRead = reading(snap, parts.mosfet.p)
  const kp = 1 / (2 * 0.117 * (10 - 3.7))
  const ronP = 1 / (2 * kp * (12 - 3.7))
  expect({ block: "MOSFET", what: "P high-side current", got: Math.abs(pRead.current), want: 12 / (100 + ronP), tol: 0.02, unit: "A" })
  expect({ block: "MOSFET", what: "P region", got: pRead.extra?.region === "ohmic" ? 1 : 0, want: 1, tol: 0, unit: "", note: pRead.extra?.region })
}

// --- report --------------------------------------------------------------------
const fmt = (v: number, unit: string) => (unit === "" ? String(v) : unit === "×" ? `${v.toFixed(3)}×` : formatSI(v, unit, 3))
let failed = 0
let block = ""
for (const c of checks) {
  if (c.block !== block) {
    block = c.block
    console.log(`\n${block}`)
  }
  const err = c.want === 0 ? Math.abs(c.got) : Math.abs(c.got - c.want) / Math.abs(c.want)
  const ok = c.tol === 0 ? (c.want === 0 ? Math.abs(c.got) < 1e-9 : c.got === c.want) : err <= c.tol
  if (!ok) failed++
  const dev = c.tol === 0 ? "" : `  (${(err * 100).toFixed(1)}% off, ±${c.tol * 100}%)`
  console.log(`  ${ok ? "✓" : "✗"} ${c.what.padEnd(30)} ${fmt(c.got, c.unit).padStart(11)}  expected ${fmt(c.want, c.unit)}${dev}${c.note ? `  — ${c.note}` : ""}`)
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed; solver converged: ${snap.converged}; sim time ${snap.time.toFixed(2)} s`)
if (failures.length) console.log(`failures reported: ${failures.join("; ")}`)
process.exit(failed ? 1 : 0)
