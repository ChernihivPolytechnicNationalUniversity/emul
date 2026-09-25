/**
 * Bench physics: the things that happen on a real stand and are not a single part's readout.
 * A coil let go by a switch arcs across the contacts; a transistor switching a relay without a
 * flyback diode dies of the spike and lives with one; an electrolytic the wrong way round
 * vents; junctions fail short and contacts weld rather than open; a rail trips, a meter's fuse
 * blows, a transformer on a battery burns its primary; an MCU pin fed 12 V takes the chip and
 * shorts its supply.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PartState, type Schematic } from "@/schematic/types"
import { SimLoop, type Probe, type Snapshot } from "@/sim/loop"

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

describe("bench physics", () => {
  it("a coil let go: 12 V through a switch into 100 mH + 100 Ω, then the switch opens", () => {
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
    expect.soft(Math.abs(reading(snap, l.id).current) * 1e3, "current settles to 12 / (100 + 0.5 + 0.05) (mA)").toBeNear(119.3, 0.5)
    t.parts({ [partKey(sw.id, "SW")]: { on: false } })
    snap = t.run(0.0002)
    expect.soft(snap.probes.gap.max, "the gap struck: probe saw ≥ 300 V across the switch").toBeGreaterThanOrEqual(300)
    expect.soft(reading(snap, sw.id).extra?.state ?? "?", "the switch is arcing").toBe("arcing")
    expect.soft(Math.abs(reading(snap, l.id).current) * 1e3, "the coil's current keeps flowing through the arc (mA)").toBeGreaterThan(60)
    snap = t.run(0.02)
    expect.soft(reading(snap, sw.id).extra?.state ?? "?", "20 ms on, the arc is out").toBe("open")
    expect.soft(Math.abs(reading(snap, l.id).current) * 1e3, "and the current is gone (mA)").toBeNear(0, 0.5)
    expect.soft(failures(snap), "nothing burnt").toBe("")
  })

  describe("a MOSFET switching a relay coil", () => {
    it.each([false, true])("with a flyback diode: %s", (withDiode) => {
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
      expect.soft(Math.abs(reading(snap, coil.id).current) * 1e3, "coil current on (mA)").toBeNear(200, 2)
      t.parts({ [partKey(drive.id, "S")]: { on: false } })
      snap = t.run(0.005)
      if (withDiode) {
        expect.soft(snap.probes.drain.max, "drain never rose past 12 V + Vf").toBeLessThan(13.5)
        expect.soft(snap.damage[q.id], "the MOSFET survives").toBeFalsy()
      } else {
        expect.soft(snap.probes.drain.max, "drain spiked past the 55 V rating").toBeGreaterThan(55)
        expect.soft(snap.damage[q.id], "the MOSFET is dead").toBeTruthy()
        expect.soft(snap.damage[q.id]?.fail ?? "?", "and failed drain-to-source short").toBe("short")
      }
    })
  })

  it("an electrolytic the wrong way round breaks down short", () => {
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
    const snap = start(doc).run(0.5)
    expect.soft(snap.damage[c.id], "it broke down").toBeTruthy()
    expect.soft(snap.damage[c.id]?.reason, "by reverse voltage").toMatch(/^reverse voltage/)
    expect.soft(Math.abs(reading(snap, r.id).current) * 1e3, "as a short: the resistor now carries 5 V / 1 kΩ (mA)").toBeNear(5, 0.1)
  })

  it("the right way round it just charges", () => {
    const { doc, place, wire } = builder(GRID)
    const bat = place("dc-source", 0, 0, { value: "5 V" })
    const c = place("capacitor-polarized", 6, 0, { value: "100 µF", vmax: "16 V" })
    const r = place("resistor", 12, 0, { value: "1 kΩ" })
    const gnd = place("ground", 3, 6)
    wire(bat, "+", r, "1")
    wire(r, "2", c, "1")
    wire(c, "2", gnd, "GND")
    wire(bat, "-", gnd, "GND")
    const snap = start(doc).run(0.5)
    expect.soft(snap.damage[c.id], "intact").toBeFalsy()
    expect.soft(reading(snap, c.id).voltage, "charged to the supply (V)").toBeNear(5, 0.05)
  })

  it("junctions fail short: a diode past its current keeps conducting, both ways", () => {
    const { doc, place, wire } = builder(GRID)
    const bat = place("dc-source", 0, 0, { value: "5 V", imax: "10 A" })
    const d = place("diode", 6, 0, { value: "1N4148", vf: "0.7", imax: "300 mA", vrev: "100 V" })
    const r = place("resistor", 12, 0, { value: "10 Ω", power: "5" })
    const gnd = place("ground", 3, 6)
    wire(bat, "+", d, "1")
    wire(d, "2", r, "1")
    wire(r, "2", gnd, "GND")
    wire(bat, "-", gnd, "GND")
    const snap = start(doc).run(0.2)
    expect.soft(snap.damage[d.id], "the diode burnt").toBeTruthy()
    expect.soft(snap.damage[d.id]?.fail ?? "?", "as a short").toBe("short")
    expect.soft(Math.abs(reading(snap, r.id).current) * 1e3, "current after: 5 / (10 + 0.5 + 0.01) (mA)").toBeNear(476, 3)
  })

  it("contacts weld: a tactile button (50 mA) on 3 V into 1 Ω stays closed after", () => {
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
    expect.soft(snap.damage[sw.id]?.fail ?? "fine", "the button welded").toBe("short")
    t.parts({ [partKey(sw.id, "SW")]: { pressed: false } })
    snap = t.run(0.05)
    expect.soft(Math.abs(reading(snap, r.id).current), "released, the current still flows (A)").toBeNear(3 / 1.51, 0.05)
  })

  it("a transistor saturates a realistic Vce: 9 V, 10 kΩ base, 1 kΩ collector", () => {
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
    const snap = start(doc).run(0.05)
    const qr = reading(snap, q.id)
    expect.soft(qr.extra?.region ?? "?", "region").toBe("saturation")
    expect.soft(qr.voltage * 1e3, "Vce(sat) pin to pin (mV), BC547 datasheet: 90 mV typical at this drive").toBeNear(90, 30)
    expect.soft(Math.abs(qr.current) * 1e3, "Ic (mA)").toBeNear(8.9, 0.15)
    expect.soft(snap.readings.filter((r) => r.object === q.id && !r.hidden).length, "the collector resistance stays out of the inspector").toBe(1)
  })

  it("a rail trips: a 2 V rail rated 1 A into 1 Ω", () => {
    const { doc, place, wire } = builder(GRID)
    const rail = place("supply", 0, 0, { value: "+2V", voltage: "2 V", imax: "1 A" })
    const r = place("resistor", 4, 4, { value: "1 Ω", power: "5" })
    const gnd = place("ground", 4, 8)
    wire(rail, "V", r, "1")
    wire(r, "2", gnd, "GND")
    const snap = start(doc).run(0.1)
    expect.soft(snap.damage[rail.id], "the rail's supply tripped").toBeTruthy()
    expect.soft(Math.abs(reading(snap, r.id).current), "nothing flows any more (A)").toBeNear(0, 1e-6)
  })

  it("an ammeter's fuse: the mA range (200 mA fuse) put in series with 12 V and 47 Ω", () => {
    const { doc, place, wire } = builder(GRID)
    const bat = place("dc-source", 0, 0, { value: "12 V" })
    const pa = place("ammeter", 6, 0, { ref: "PA1", imax: "200 mA" })
    const r = place("resistor", 12, 0, { value: "47 Ω", power: "5" })
    const gnd = place("ground", 3, 6)
    wire(bat, "+", pa, "+")
    wire(pa, "-", r, "1")
    wire(r, "2", gnd, "GND")
    wire(bat, "-", gnd, "GND")
    const snap = start(doc).run(0.1)
    expect.soft(snap.damage[pa.id]?.fail ?? "fine", "the fuse blew").toBe("open")
    expect.soft(Math.abs(reading(snap, r.id).current), "the circuit is open (A)").toBeNear(0, 1e-6)
  })

  it("a voltmeter past its range burns", () => {
    const { doc, place, wire } = builder(GRID)
    const bat = place("dc-source", 0, 0, { value: "800 V" })
    const pv = place("voltmeter", 6, 0, { ref: "PV1", vmax: "600 V" })
    const gnd = place("ground", 3, 6)
    wire(bat, "+", pv, "+")
    wire(pv, "-", gnd, "GND")
    wire(bat, "-", gnd, "GND")
    const snap = start(doc).run(0.05)
    expect(snap.damage[pv.id], "the meter burnt").toBeTruthy()
  })

  it("a transformer on mains draws its magnetising current", () => {
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
    const snap = start(doc).run(0.3)
    expect.soft(reading(snap, mains.id).rms!.current * 1e3, "primary current: load 6.3 mA plus ~15 mA magnetising, in quadrature (mA)").toBeNear(16, 3)
    expect.soft(reading(snap, load.id).rms!.voltage, "secondary under load (V RMS)").toBeNear(11.8, 0.3)
    expect.soft(snap.damage[tr.id], "intact").toBeFalsy()
  })

  it("a transformer on a battery burns its primary", () => {
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
    const snap = start(doc).run(0.3)
    expect(snap.damage[tr.id]?.fail ?? "fine", "on DC the primary winding burnt").toBe("open")
  })

  it("half a potentiometer burns, the other half keeps working", () => {
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
    const snap = start(doc).run(0.2)
    expect.soft(snap.damage[pot.id], "the 2 Ω end of the track burnt").toBeTruthy()
    expect.soft(snap.damage[pot.id]?.fatal, "but not the whole part").toBeFalsy()
    expect.soft(reading(snap, pot.id, 1), "the other half still reads").toBeTruthy()
  })

  it("12 V on a Nucleo pin: the chip dies and its supply shorts", () => {
    const { doc, place, wire } = builder(GRID)
    const u = place("nucleo-f429zi", 0, 0)
    const bat = place("dc-source", 40, 10, { value: "12 V", imax: "3 A" })
    wire(bat, "+", u, "CN7-10")
    wire(bat, "-", u, "CN7-8")
    const snap = start(doc).run(0.05)
    expect.soft(snap.damage[u.id], "the board burnt").toBeTruthy()
    expect.soft(snap.damage[u.id]?.fatal, "the pin's failure is fatal").toBeTruthy()
    // The blown pin clamps to the 3.3 V rail and the dead die shorts that rail: 12 V into ~0.5 Ω.
    expect.soft(snap.damage[bat.id], "the battery then feeds the short through the dead die and burns").toBeTruthy()
  })

  it("the oscilloscope keeps the spike that killed the part, across the rebuild the failure causes", () => {
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
    expect.soft(snap.damage[q.id], "the MOSFET died of the spike").toBeTruthy()
    expect.soft(peak, "the scope's trace holds the spike (V)").toBeGreaterThan(55)
    expect.soft(buckets, "and no buckets were lost to the rebuild").toBe(Math.floor(snap.time / 2e-3))
  })

  it("the speed gauge reports what the solver manages, not the setting", () => {
    const { doc, place, wire } = builder(GRID)
    const bat = place("dc-source", 0, 0, { value: "5 V" })
    const r = place("resistor", 6, 0, { value: "1 kΩ" })
    const gnd = place("ground", 3, 6)
    wire(bat, "+", r, "1")
    wire(r, "2", gnd, "GND")
    wire(bat, "-", gnd, "GND")
    const t = start(doc)
    expect.soft(t.loop.snapshot()!.rate, "no rate before the first step").toBeNull()
    let snap = t.run(2)
    expect.soft(snap.rate!, "ticks that keep up report the set speed").toBeNear(1, 0.01)
    // A tick that arrives late (the previous one took too long) is capped by the step budget.
    t.loop.advance(t.clock + 1000)
    t.loop.advance(t.clock + 2000)
    snap = t.loop.snapshot()!
    expect.soft(snap.rate!, "a second-long tick delivers 1500 steps × 20 µs: the rate drops").toBeLessThan(0.2)
    t.loop.setRunning(false)
    t.loop.setRunning(true)
    expect.soft(t.loop.snapshot()!.rate, "a pause forgets the old rate").toBeNull()
  })
})
