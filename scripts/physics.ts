/**
 * Bench physics: the things that happen on a real stand and are not a single part's readout.
 * A coil let go by a switch arcs across the contacts; a transistor switching a relay without a
 * flyback diode dies of the spike and lives with one; an electrolytic the wrong way round
 * vents; junctions fail short and contacts weld rather than open; a rail trips, a meter's fuse
 * blows, a transformer on a battery burns its primary; an MCU pin fed 12 V takes the chip and
 * shorts its supply.
 *
 *   pnpm physics
 */
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PartState, type Schematic } from "@/schematic/types"
import { SimLoop, type Probe, type Snapshot } from "@/sim/loop"

let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0, note = "") => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(4)) : String(v))
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(58)} ${fmt(got).padStart(12)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}${note ? `  — ${note}` : ""}`)
}

type Run = { loop: SimLoop; snap: Snapshot; clock: number; run: (seconds: number, each?: (snap: Snapshot) => void) => Snapshot; parts: (p: Record<string, PartState>) => void }
/** Start a document running and hand back a way to advance it in simulated seconds. */
function start(doc: Schematic, probes: Probe[] = [], traceBucket = 0): Run {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setProbes(probes)
  loop.setTraceBucket(traceBucket)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  let parts: Record<string, PartState> = { ...doc.parts }
  // `each` sees every snapshot along the way, for what a snapshot hands over only once (the trace).
  const run = (seconds: number, each?: (snap: Snapshot) => void) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 10)
      loop.advance(clock)
      if (each) each(loop.snapshot()!)
    }
    return loop.snapshot()!
  }
  return {
    loop,
    get snap() {
      return loop.snapshot()!
    },
    get clock() {
      return clock
    },
    run,
    parts: (p) => {
      parts = { ...parts, ...p }
      loop.setParts(parts)
    },
  }
}
const reading = (snap: Snapshot, id: string, element = 0) => snap.readings.find((r) => r.object === id && r.element === element)!
const failures = (snap: Snapshot) =>
  Object.entries(snap.damage)
    .map(([, d]) => [d, ...(d.also ?? [])].map((e) => e.reason).join("; "))
    .join(" | ")

const wall0 = performance.now()

console.log("A coil let go: 12 V through a switch into 100 mH + 100 Ω, then the switch opens")
{
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "12 V", imax: "5 A" })
  const sw = place("switch", 6, 0)
  const l = place("inductor", 12, 0, { value: "100 mH", imax: "1 A" })
  const r = place("resistor", 18, 0, { value: "100 Ω", power: "5" })
  const gnd = place("ground", 3, 6)
  wire(bat, "+", sw, "1")
  wire(sw, "2", l, "1")
  wire(l, "2", r, "1")
  wire(r, "2", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  doc.parts[partKey(sw.id, "SW")] = { on: true }
  const gap: Probe = { id: "gap", a: pinKey(sw.id, "1"), b: pinKey(sw.id, "2") }
  const t = start(doc, [gap])
  let snap = t.run(0.02)
  expect("current settles to 12 / (100 + 0.5 + 0.05) (mA)", Math.abs(reading(snap, l.id).current) * 1e3, 119.3, 0.5)
  t.parts({ [partKey(sw.id, "SW")]: { on: false } })
  snap = t.run(0.0002)
  expect("the gap struck: probe saw ≥ 300 V across the switch", snap.probes.gap.max >= 300 ? "yes" : "no", "yes", 0, `peak ${snap.probes.gap.max.toFixed(0)} V`)
  expect("the switch is arcing", reading(snap, sw.id).extra?.state ?? "?", "arcing")
  const iArc = Math.abs(reading(snap, l.id).current) * 1e3
  expect("the coil's current keeps flowing through the arc (mA)", iArc > 60 ? 1 : 0, 1, 0, `${iArc.toFixed(1)} mA after 0.2 ms`)
  snap = t.run(0.02)
  expect("20 ms on, the arc is out", reading(snap, sw.id).extra?.state ?? "?", "open")
  expect("and the current is gone (mA)", Math.abs(reading(snap, l.id).current) * 1e3, 0, 0.5)
  expect("nothing burnt", failures(snap), "")
}

console.log("\nA MOSFET switching a relay coil: without a flyback diode the spike kills it, with one it lives")
for (const withDiode of [false, true]) {
  const { doc, place, wire } = builder(GRID)
  const rail = place("supply", 12, -6, { value: "+12V", voltage: "12 V", imax: "2 A" })
  const coil = place("inductor", 12, 0, { value: "50 mH", imax: "1 A" }, 90)
  const rcoil = place("resistor", 12, 6, { value: "60 Ω", power: "5" }, 90)
  const q = place("nmos", 12, 12, { value: "IRLZ44N", vth: "2 V", rdson: "22 mΩ", idmax: "47 A", vdsmax: "55 V", pmax: "110 W" })
  const drive = place("logic-state", 4, 14, { vdd: "5 V" })
  const gnd = place("ground", 15, 20)
  wire(rail, "V", coil, "1")
  wire(coil, "2", rcoil, "1")
  wire(rcoil, "2", q, "D")
  wire(q, "S", gnd, "GND")
  wire(drive, "OUT", q, "G")
  if (withDiode) {
    const d = place("diode", 20, 3, { value: "1N4148", vf: "0.7", imax: "300 mA", vrev: "100 V" }, 270)
    wire(d, "1", q, "D")
    wire(d, "2", rail, "V")
  }
  doc.parts[partKey(drive.id, "S")] = { on: true }
  const drain: Probe = { id: "drain", a: pinKey(q.id, "D"), b: null }
  const t = start(doc, [drain])
  let snap = t.run(0.02)
  expect(`${withDiode ? "with" : "without"} diode: coil current on (mA)`, Math.abs(reading(snap, coil.id).current) * 1e3, 200, 2)
  t.parts({ [partKey(drive.id, "S")]: { on: false } })
  snap = t.run(0.005)
  if (withDiode) {
    expect("drain never rose past 12 V + Vf", snap.probes.drain.max < 13.5 ? "yes" : "no", "yes", 0, `peak ${snap.probes.drain.max.toFixed(2)} V`)
    expect("the MOSFET survives", snap.damage[q.id] ? "burnt" : "fine", "fine")
  } else {
    expect("drain spiked past the 55 V rating", snap.probes.drain.max > 55 ? "yes" : "no", "yes", 0, `peak ${snap.probes.drain.max.toFixed(0)} V`)
    expect("the MOSFET is dead", snap.damage[q.id] ? "burnt" : "fine", "burnt", 0, snap.damage[q.id]?.reason)
    expect("and failed drain-to-source short", snap.damage[q.id]?.fail ?? "?", "short")
  }
}

console.log("\nAn electrolytic the wrong way round")
{
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "5 V" })
  const c = place("capacitor-polarized", 6, 0, { value: "100 µF", vmax: "16 V" })
  const r = place("resistor", 12, 0, { value: "1 kΩ" })
  const gnd = place("ground", 3, 6)
  // Anode (pin 1) to ground, cathode to +5 V.
  wire(bat, "+", r, "1")
  wire(r, "2", c, "2")
  wire(c, "1", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  const t = start(doc)
  const snap = t.run(0.5)
  expect("it broke down", snap.damage[c.id] ? "burnt" : "fine", "burnt", 0, snap.damage[c.id]?.reason)
  expect("by reverse voltage", snap.damage[c.id]?.reason.startsWith("reverse voltage") ? "yes" : "no", "yes")
  expect("as a short: the resistor now carries 5 V / 1 kΩ (mA)", Math.abs(reading(snap, r.id).current) * 1e3, 5, 0.1)
}

console.log("\nThe right way round it just charges")
{
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "5 V" })
  const c = place("capacitor-polarized", 6, 0, { value: "100 µF", vmax: "16 V" })
  const r = place("resistor", 12, 0, { value: "1 kΩ" })
  const gnd = place("ground", 3, 6)
  wire(bat, "+", r, "1")
  wire(r, "2", c, "1")
  wire(c, "2", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  const t = start(doc)
  const snap = t.run(0.5)
  expect("intact", snap.damage[c.id] ? "burnt" : "fine", "fine")
  expect("charged to the supply (V)", reading(snap, c.id).voltage, 5, 0.05)
}

console.log("\nJunctions fail short: a diode past its current keeps conducting, both ways")
{
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "5 V", imax: "10 A" })
  const d = place("diode", 6, 0, { value: "1N4148", vf: "0.7", imax: "300 mA", vrev: "100 V" })
  const r = place("resistor", 12, 0, { value: "10 Ω", power: "5" })
  const gnd = place("ground", 3, 6)
  wire(bat, "+", d, "1")
  wire(d, "2", r, "1")
  wire(r, "2", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  const t = start(doc)
  const snap = t.run(0.2)
  expect("the diode burnt", snap.damage[d.id] ? "burnt" : "fine", "burnt", 0, snap.damage[d.id]?.reason)
  expect("as a short", snap.damage[d.id]?.fail ?? "?", "short")
  expect("current after: 5 / (10 + 0.5 + 0.01) (mA)", Math.abs(reading(snap, r.id).current) * 1e3, 476, 3)
}

console.log("\nContacts weld: a tactile button (50 mA) on 3 V into 1 Ω stays closed after")
{
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "3 V", imax: "10 A" })
  const sw = place("pushbutton", 6, 0)
  const r = place("resistor", 12, 0, { value: "1 Ω", power: "5" })
  const gnd = place("ground", 3, 6)
  wire(bat, "+", sw, "1")
  wire(sw, "2", r, "1")
  wire(r, "2", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  const t = start(doc)
  t.run(0.01)
  t.parts({ [partKey(sw.id, "SW")]: { pressed: true } })
  let snap = t.run(0.1)
  expect("the button welded", snap.damage[sw.id]?.fail ?? "fine", "short", 0, snap.damage[sw.id]?.reason)
  t.parts({ [partKey(sw.id, "SW")]: { pressed: false } })
  snap = t.run(0.05)
  expect("released, the current still flows (A)", Math.abs(reading(snap, r.id).current), 3 / 1.51, 0.05)
}

console.log("\nA transistor saturates a realistic Vce: 9 V, 10 kΩ base, 1 kΩ collector")
{
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "9 V" })
  const rb = place("resistor", 6, 0, { value: "10 kΩ" })
  const rc = place("resistor", 12, -4, { value: "1 kΩ" })
  const q = place("npn", 14, 2)
  const gnd = place("ground", 3, 10)
  wire(bat, "+", rb, "1")
  wire(bat, "+", rc, "1")
  wire(rb, "2", q, "B")
  wire(rc, "2", q, "C")
  wire(q, "E", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  const t = start(doc)
  const snap = t.run(0.05)
  const qr = reading(snap, q.id)
  expect("region", qr.extra?.region ?? "?", "saturation")
  expect("Vce(sat) pin to pin (mV)", qr.voltage * 1e3, 90, 30, "BC547 datasheet: 90 mV typical at this drive")
  expect("Ic (mA)", Math.abs(qr.current) * 1e3, 8.9, 0.15)
  expect("the collector resistance stays out of the inspector", snap.readings.filter((r) => r.object === q.id && !r.hidden).length, 1)
}

console.log("\nA rail trips: a 2 V rail rated 1 A into 1 Ω")
{
  const { doc, place, wire } = builder(GRID)
  const rail = place("supply", 0, 0, { value: "+2V", voltage: "2 V", imax: "1 A" })
  const r = place("resistor", 4, 4, { value: "1 Ω", power: "5" })
  const gnd = place("ground", 4, 8)
  wire(rail, "V", r, "1")
  wire(r, "2", gnd, "GND")
  const t = start(doc)
  const snap = t.run(0.1)
  expect("the rail's supply tripped", snap.damage[rail.id] ? "tripped" : "fine", "tripped", 0, snap.damage[rail.id]?.reason)
  expect("nothing flows any more (A)", Math.abs(reading(snap, r.id).current), 0, 1e-6)
}

console.log("\nAn ammeter's fuse: the mA range (200 mA fuse) put in series with 12 V and 47 Ω")
{
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "12 V" })
  const pa = place("ammeter", 6, 0, { ref: "PA1", imax: "200 mA" })
  const r = place("resistor", 12, 0, { value: "47 Ω", power: "5" })
  const gnd = place("ground", 3, 6)
  wire(bat, "+", pa, "+")
  wire(pa, "-", r, "1")
  wire(r, "2", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  const t = start(doc)
  const snap = t.run(0.1)
  expect("the fuse blew", snap.damage[pa.id]?.fail ?? "fine", "open", 0, snap.damage[pa.id]?.reason)
  expect("the circuit is open (A)", Math.abs(reading(snap, r.id).current), 0, 1e-6)
}

console.log("\nA voltmeter past its range")
{
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "800 V" })
  const pv = place("voltmeter", 6, 0, { ref: "PV1", vmax: "600 V" })
  const gnd = place("ground", 3, 6)
  wire(bat, "+", pv, "+")
  wire(pv, "-", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  const t = start(doc)
  const snap = t.run(0.05)
  expect("the meter burnt", snap.damage[pv.id] ? "burnt" : "fine", "burnt", 0, snap.damage[pv.id]?.reason)
}

console.log("\nA transformer: magnetising current on mains, a burnt primary on a battery")
{
  const { doc, place, wire } = builder(GRID)
  const mains = place("ac-source", 0, 0)
  const tr = place("transformer", 6, 0)
  const load = place("resistor", 14, 0, { value: "100 Ω", power: "5" })
  const gnd = place("ground", 3, 8)
  wire(mains, "+", tr, "P1")
  wire(mains, "-", tr, "P2")
  wire(tr, "S1", load, "1")
  wire(tr, "S2", load, "2")
  wire(tr, "S2", gnd, "GND")
  wire(mains, "-", gnd, "GND")
  const t = start(doc)
  const snap = t.run(0.3)
  const ip = reading(snap, mains.id).rms!.current * 1e3
  expect("primary current: load 6.3 mA plus ~15 mA magnetising, in quadrature (mA)", ip, 16, 3, `${ip.toFixed(1)} mA`)
  expect("secondary under load (V RMS)", reading(snap, load.id).rms!.voltage, 11.8, 0.3)
  expect("intact", snap.damage[tr.id] ? "burnt" : "fine", "fine")
}
{
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "230 V", imax: "10 A" })
  const tr = place("transformer", 6, 0)
  const load = place("resistor", 14, 0, { value: "100 Ω", power: "5" })
  const gnd = place("ground", 3, 8)
  wire(bat, "+", tr, "P1")
  wire(bat, "-", tr, "P2")
  wire(tr, "S1", load, "1")
  wire(tr, "S2", load, "2")
  wire(tr, "S2", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  const t = start(doc)
  const snap = t.run(0.3)
  expect("on DC the primary winding burnt", snap.damage[tr.id]?.fail ?? "fine", "open", 0, snap.damage[tr.id]?.reason)
}

console.log("\nHalf a potentiometer burns, the other half keeps working")
{
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "5 V", imax: "10 A" })
  const pot = place("potentiometer", 6, 0, { value: "100 Ω", pos: "0.02", power: "0.25" })
  const r = place("resistor", 12, 0, { value: "100 Ω", power: "5" })
  const gnd = place("ground", 3, 6)
  wire(bat, "+", pot, "1")
  wire(pot, "W", gnd, "GND")
  wire(pot, "2", r, "1")
  wire(r, "2", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  const t = start(doc)
  const snap = t.run(0.2)
  expect("the 2 Ω end of the track burnt", snap.damage[pot.id] ? "burnt" : "fine", "burnt", 0, snap.damage[pot.id]?.reason)
  expect("but not the whole part", snap.damage[pot.id]?.fatal ? "fatal" : "partial", "partial")
  expect("the other half still reads", reading(snap, pot.id, 1) ? "yes" : "no", "yes")
}

console.log("\n12 V on a Nucleo pin: the chip dies and its supply shorts")
{
  const { doc, place, wire } = builder(GRID)
  const u = place("nucleo-f429zi", 0, 0)
  const bat = place("dc-source", 40, 10, { value: "12 V", imax: "3 A" })
  wire(bat, "+", u, "CN7-10")
  wire(bat, "-", u, "CN7-8")
  const t = start(doc)
  const snap = t.run(0.05)
  expect("the board burnt", snap.damage[u.id] ? "burnt" : "fine", "burnt", 0, snap.damage[u.id]?.reason)
  expect("the pin's failure is fatal", snap.damage[u.id]?.fatal ? "yes" : "no", "yes")
  // The blown pin clamps to the 3.3 V rail and the dead die shorts that rail: 12 V into ~0.5 Ω.
  expect("the battery then feeds the short through the dead die and burns", snap.damage[bat.id] ? "burnt" : "fine", "burnt", 0, snap.damage[bat.id]?.reason)
}

console.log("\nThe oscilloscope keeps the spike that killed the part, across the rebuild the failure causes")
{
  const { doc, place, wire } = builder(GRID)
  const rail = place("supply", 12, -6, { value: "+12V", voltage: "12 V", imax: "2 A" })
  const coil = place("inductor", 12, 0, { value: "50 mH", imax: "1 A" }, 90)
  const rcoil = place("resistor", 12, 6, { value: "60 Ω", power: "5" }, 90)
  const q = place("nmos", 12, 12, { value: "IRLZ44N", vth: "2 V", rdson: "22 mΩ", idmax: "47 A", vdsmax: "55 V", pmax: "110 W" })
  const drive = place("logic-state", 4, 14, { vdd: "5 V" })
  const gnd = place("ground", 15, 20)
  wire(rail, "V", coil, "1")
  wire(coil, "2", rcoil, "1")
  wire(rcoil, "2", q, "D")
  wire(q, "S", gnd, "GND")
  wire(drive, "OUT", q, "G")
  doc.parts[partKey(drive.id, "S")] = { on: true }
  const drain: Probe = { id: "drain", a: pinKey(q.id, "D"), b: null }
  // Buckets of 2 ms, as on the slowest timebase a user might have left the scope on.
  const t = start(doc, [drain], 2e-3)
  let peak = -Infinity
  let buckets = 0
  const collect = (snap: Snapshot) => {
    const ch = snap.trace
    for (let i = 0; i < ch.count; i++) peak = Math.max(peak, ch.data[i * 2 + 1])
    buckets += ch.count
  }
  t.run(0.02, collect)
  t.parts({ [partKey(drive.id, "S")]: { on: false } })
  const snap = t.run(0.03, collect)
  expect("the MOSFET died of the spike", snap.damage[q.id] ? "burnt" : "fine", "burnt", 0, snap.damage[q.id]?.reason)
  expect("the scope's trace holds the spike (V)", peak > 55 ? "yes" : "no", "yes", 0, `trace peak ${peak.toFixed(0)} V`)
  expect("and no buckets were lost to the rebuild", buckets, Math.floor(snap.time / 2e-3))
}

console.log("\nThe speed gauge: what the solver manages, not the setting")
{
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "5 V" })
  const r = place("resistor", 6, 0, { value: "1 kΩ" })
  const gnd = place("ground", 3, 6)
  wire(bat, "+", r, "1")
  wire(r, "2", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  const t = start(doc)
  expect("no rate before the first step", t.loop.snapshot()!.rate === null ? "null" : "set", "null")
  let snap = t.run(2)
  expect("ticks that keep up report the set speed", snap.rate!, 1, 0.01)
  // A tick that arrives late (the previous one took too long) is capped by the step budget.
  t.loop.advance(t.clock + 1000)
  t.loop.advance(t.clock + 2000)
  snap = t.loop.snapshot()!
  expect("a second-long tick delivers 1500 steps × 20 µs: the rate drops", snap.rate! < 0.2 ? "yes" : "no", "yes", 0, `${snap.rate!.toPrecision(2)}×`)
  t.loop.setRunning(false)
  t.loop.setRunning(true)
  expect("a pause forgets the old rate", t.loop.snapshot()!.rate === null ? "null" : "set", "null")
}

const wall = (performance.now() - wall0) / 1000
console.log(`\n${wall.toFixed(2)} s wall`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
