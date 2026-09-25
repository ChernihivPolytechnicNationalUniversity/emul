/**
 * Voltmeter and ammeter components: a resistive divider read by a voltmeter (its 10 MΩ input
 * barely loads it), an ammeter in series reading the loop current, both on a DC supply and on
 * an AC source (where they read RMS), and the meters' own operating point exposed as the field
 * readout the UI draws.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { pinKey, type Schematic } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

/** Run a document to steady state and return the last snapshot. */
function settle(doc: Schematic, seconds = 0.2): { loop: SimLoop; snap: Snapshot } {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const end = seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 20)
    loop.advance(clock)
  }
  return { loop, snap: loop.snapshot()! }
}
/** The value the field readout draws for a meter: its element-0 operating point (RMS in AC). */
const meterValue = (snap: Snapshot, id: string, read: "voltage" | "current") => {
  const r = snap.readings.find((x) => x.object === id && x.element === 0)!
  return r.rms ? r.rms[read] : read === "voltage" ? r.voltage : r.current
}

describe("meters", () => {
  it("voltmeter across the lower leg of a 1 k / 2 k divider on 9 V", () => {
    const { doc, place, wire } = builder(GRID)
    const bat = place("dc-source", 0, 0, { value: "9 V" })
    const r1 = place("resistor", 6, -2, { value: "1 kΩ" })
    const r2 = place("resistor", 6, 2, { value: "2 kΩ" })
    const pv = place("voltmeter", 12, 2, { ref: "PV1" })
    const gnd = place("ground", 3, 6)
    wire(bat, "+", r1, "1")
    wire(r1, "2", r2, "1")
    wire(r2, "1", pv, "+")
    wire(r2, "2", gnd, "GND")
    wire(pv, "-", gnd, "GND")
    wire(bat, "-", gnd, "GND")
    const { snap } = settle(doc)
    expect.soft(meterValue(snap, pv.id, "voltage"), "reads the divider output 9·2/3 (V)").toBeNear(6.0, 0.02)
    const i = snap.pinCurrent[pinKey(pv.id, "+")]
    expect.soft(Math.abs(i!) * 1e6, "its 10 MΩ input barely loads it (µA)").toBeNear(0.6, 0.05)
  })

  it("ammeter in series with a 470 Ω load on 5 V", () => {
    const { doc, place, wire } = builder(GRID)
    const bat = place("dc-source", 0, 0, { value: "5 V" })
    const pa = place("ammeter", 6, 0, { ref: "PA1" })
    const r = place("resistor", 12, 0, { value: "470 Ω" })
    const gnd = place("ground", 3, 4)
    wire(bat, "+", pa, "+")
    wire(pa, "-", r, "1")
    wire(r, "2", gnd, "GND")
    wire(bat, "-", gnd, "GND")
    const { snap } = settle(doc)
    expect.soft(Math.abs(meterValue(snap, pa.id, "current")) * 1e3, "reads 5 V / 470 Ω (mA)").toBeNear(10.638, 0.05)
    const across = snap.readings.find((x) => x.object === pa.id && x.element === 0)!
    expect.soft(Math.abs(across.voltage) * 1e3, "burden voltage of the 0.01 Ω shunt (mV)").toBeNear(0.106, 0.01)
  })

  it("both on a 5 V RMS, 50 Hz sine into a 1 kΩ load read RMS", () => {
    const { doc, place, wire } = builder(GRID)
    const src = place("ac-source", 0, 0, { value: "5 V", freq: "50 Hz" })
    const pa = place("ammeter", 6, 0, { ref: "PA1" })
    const r = place("resistor", 12, 0, { value: "1 kΩ" })
    const pv = place("voltmeter", 12, 4, { ref: "PV1" })
    const gnd = place("ground", 3, 6)
    wire(src, "+", pa, "+")
    wire(pa, "-", r, "1")
    wire(r, "1", pv, "+")
    wire(r, "2", gnd, "GND")
    wire(pv, "-", gnd, "GND")
    wire(src, "-", gnd, "GND")
    const { snap } = settle(doc, 0.3)
    expect.soft(snap.ac, "AC circuit detected").toBeTruthy()
    expect.soft(meterValue(snap, pv.id, "voltage"), "voltmeter reads the 5 V RMS across the load").toBeNear(5.0, 0.05)
    expect.soft(Math.abs(meterValue(snap, pa.id, "current")) * 1e3, "ammeter reads 5 mA RMS").toBeNear(5.0, 0.05)
  })

  it("has a meter spec before the run", () => {
    const { doc, place } = builder(GRID)
    place("voltmeter", 0, 0, { ref: "PV1" })
    const loop = new SimLoop()
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    // Not running: the meter has a spec but no live reading.
    expect.soft(getDef("voltmeter")!.meter?.read ?? "none", "voltmeter has a meter spec").toBe("voltage")
    expect.soft(getDef("ammeter")!.meter?.read ?? "none", "ammeter reads current").toBe("current")
  })
})
