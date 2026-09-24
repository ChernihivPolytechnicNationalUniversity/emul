/**
 * Battery chemistry on the bench: an alkaline pair's terminal voltage and its time left at a
 * light and at a heavy load (Peukert), a lead-acid block, a coin cell sagging under a load it
 * was never meant for, a small cell run all the way down until the load goes dark and the
 * exhausted cell's voltage collapses, a Li-ion cell taken past empty until it dies, a primary
 * cell force-charged until it vents, a Li-ion cell overcharged into thermal runaway, and a
 * NiMH cell on charge reporting when it will be full. Then the second-order effects: the cold
 * (capacity and resistance at −20 °C), diffusion (the voltage sags on for minutes under load and
 * rests back up after it), self-heating (an 18650-class cell shorted through a wire runs away),
 * wear (cycles and years), and a mismatched pack that is empty when its weakest cell is.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, type PartState, type Schematic } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { parseValue } from "@/sim/units"

/** Start a document running at many times real time and hand back a way to advance it in simulated seconds. */
function start(doc: Schematic, speed = 200) {
  const loop = new SimLoop()
  loop.speed = speed
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + (seconds * 1000) / speed
    while (clock < end) {
      clock = Math.min(end, clock + 10)
      loop.advance(clock)
    }
    return loop.snapshot()!
  }
  let parts: Record<string, PartState> = { ...doc.parts }
  return {
    loop,
    run,
    parts: (p: Record<string, PartState>) => {
      parts = { ...parts, ...p }
      loop.setParts(parts)
    },
  }
}
const reading = (snap: Snapshot, id: string) => snap.readings.find((r) => r.object === id && r.element === 0)!
const extra = (snap: Snapshot, id: string, key: string) => reading(snap, id).extra?.[key] ?? "?"
/** Hours in a "5 d 3 h" / "3 h 20 min" / "12 min" / "42 s" / "2.3 years" reading. */
function hours(text: string): number {
  const m = /(?:(\d+) d)?\s*(?:(\d+) h)?\s*(?:(\d+) min)?\s*(?:(\d+) s)?/.exec(text)
  const y = /([\d.]+) years/.exec(text)
  if (y) return Number(y[1]) * 365.25 * 24
  if (!m) return NaN
  return Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0) + Number(m[3] ?? 0) / 60 + Number(m[4] ?? 0) / 3600
}

/** A battery into a resistor to ground. */
function bench(battery: Record<string, string>, load: string, watts = "5") {
  const { doc, place, wire } = builder(GRID)
  const bat = place("battery", 0, 0, battery)
  const r = place("resistor", 6, 0, { value: load, power: watts })
  const gnd = place("ground", 3, 6)
  wire(bat, "+", r, "1")
  wire(r, "2", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  return { doc, bat, r, place, wire }
}

const timeLeft = (snap: Snapshot, id: string) => extra(snap, id, "Time left")

describe("battery chemistry", () => {
  it("two fresh AA alkalines (2.5 Ah) on 100 Ω", () => {
    const { doc, bat } = bench({ chem: "alkaline", cells: "2", capacity: "2.5 Ah", soc: "100" }, "100 Ω")
    const snap = start(doc).run(0.05)
    const r = reading(snap, bat.id)
    // 2 × 1.6 V open-circuit less the drop across 2 × 0.35 / 2.5 = 0.28 Ω.
    expect.soft(r.voltage, "terminal voltage (V)").toBeNear(3.191, 0.01)
    expect.soft(Math.round((r.charge ?? 0) * 100), "charge shown (%)").toBe(100)
    expect.soft(extra(snap, bat.id, "Open-circuit"), "open-circuit voltage (V)").toBe("3.20 V")
    expect.soft(extra(snap, bat.id, "Internal R"), "internal resistance (Ω)").toBe("280.00 mΩ")
    // ~32 mA is close to the 100 h rate: a shade under the nameplate 78 h.
    expect.soft(hours(timeLeft(snap, bat.id)), "time left at 32 mA (h)").toBeNear(74, 4)
  })

  it("the same pair on 3 Ω: Peukert — 1 A gets half the nameplate capacity", () => {
    const { doc, bat } = bench({ chem: "alkaline", cells: "2", capacity: "2.5 Ah", soc: "100" }, "3 Ω")
    const snap = start(doc).run(0.05)
    expect.soft(-reading(snap, bat.id).current, "load current (A)").toBeNear(0.976, 0.01)
    expect.soft(hours(timeLeft(snap, bat.id)), "time left (h): 2.5 Ah / 1 A would be 2.6 h").toBeNear(1.25, 0.15)
  })

  it("12 V 7 Ah lead-acid block on 12 Ω", () => {
    const { doc, bat } = bench({ chem: "lead-acid", cells: "6", capacity: "7 Ah", soc: "100" }, "12 Ω", "20")
    const snap = start(doc).run(0.05)
    expect.soft(reading(snap, bat.id).voltage, "terminal voltage (V)").toBeNear(12.73, 0.03)
    expect.soft(hours(timeLeft(snap, bat.id)), "time left at 1.06 A (h): the 20 h rate is 0.35 A").toBeNear(5.3, 0.3)
  })

  it("CR2032 (220 mAh) half used, into 150 Ω: 15 Ω inside it, so it sags", () => {
    const { doc, bat } = bench({ chem: "li-mno2", cells: "1", capacity: "220 mAh", soc: "50" }, "150 Ω")
    const snap = start(doc).run(0.05)
    expect.soft(reading(snap, bat.id).voltage, "terminal voltage (V)").toBeNear(2.62, 0.03)
    expect.soft(hours(timeLeft(snap, bat.id)), "18 mA is far past its 0.2 mA rate: hours, not the 6 h of Ah / A").toBeNear(2.1, 0.4)
    const { doc: doc2, bat: bat2 } = bench({ chem: "li-mno2", cells: "1", capacity: "220 mAh", soc: "100" }, "1 MΩ")
    const snap2 = start(doc2).run(0.05)
    expect.soft(hours(timeLeft(snap2, bat2.id)) / 8766, "at 3 µA it is self-discharge that sets the life (years)").toBeNear(7.5, 1.5)
  })

  it("a nearly flat Li-ion cell (5 mAh, 2 %) into an LED: it dims, dies, and then is exhausted", () => {
    const { doc, place, wire } = builder(GRID)
    // A toy-sized cell so the run-down takes seconds.
    const bat = place("battery", 0, 0, { chem: "li-ion", cells: "1", capacity: "5 mAh", soc: "2" })
    const r = place("resistor", 6, 0, { value: "33 Ω" })
    const led = place("led", 12, 0, { color: "red" })
    const gnd = place("ground", 3, 6)
    wire(bat, "+", r, "1")
    wire(r, "2", led, "1")
    wire(led, "2", gnd, "GND")
    wire(bat, "-", gnd, "GND")
    const t = start(doc)
    let snap = t.run(0.1)
    const v0 = reading(snap, bat.id).voltage
    const i0 = -reading(snap, bat.id).current
    // 3.06 V open-circuit at 2 %, 58 Ω inside at this depth, 1.9 V across the LED.
    expect.soft(i0 * 1e3, "lit: the LED draws (mA)").toBeNear(13, 2)
    expect.soft(timeLeft(snap, bat.id), "time left reads seconds").toMatch(/s$/)
    const left0 = hours(timeLeft(snap, bat.id)) * 3600
    snap = t.run(10)
    expect.soft(reading(snap, bat.id).voltage, "10 s on: the voltage is sagging (V)").toBeLessThan(v0 - 0.01)
    expect.soft((reading(snap, bat.id).charge ?? 0) * 100, "charge is going down (%)").toBeNear(1.3, 0.2)
    expect.soft(hours(timeLeft(snap, bat.id)) * 3600, "the estimate counts down with the clock (s)").toBeNear(left0 - 10, 5)
    snap = t.run(25)
    expect.soft(timeLeft(snap, bat.id), "35 s on: empty").toBe("empty")
    expect.soft(-reading(snap, bat.id).current * 1e3, "the LED is going dark (mA)").toBeLessThan(2)
    expect.soft(reading(snap, bat.id).voltage, "the exhausted cell cannot hold its voltage under load (V)").toBeLessThan(2)
    expect.soft(snap.damage[bat.id], "still intact").toBeFalsy()
    snap = t.run(60)
    expect.soft(snap.damage[bat.id], "dragged on below its cut-off, the Li-ion cell is dead").toBeTruthy()
    expect.soft(snap.damage[bat.id]?.fail ?? "?", "dead open").toBe("open")
    expect.soft(-(reading(snap, led.id)?.current ?? 0) * 1e3, "the LED is out (mA)").toBeNear(0, 0.01)
  })

  it("an alkaline cell force-charged from a 12 V supply vents", () => {
    const { doc, place, wire } = builder(GRID)
    // Again a toy-sized cell, so the abuse fits in seconds.
    const bat = place("battery", 0, 0, { chem: "alkaline", cells: "1", capacity: "20 mAh", soc: "100" })
    const src = place("dc-source", 8, 0, { value: "12 V", rint: "0.5 Ω", imax: "3 A" })
    const r = place("resistor", 4, -4, { value: "10 Ω", power: "5" })
    const gnd = place("ground", 4, 6)
    wire(src, "+", r, "2")
    wire(r, "1", bat, "+")
    wire(bat, "-", gnd, "GND")
    wire(src, "-", gnd, "GND")
    const t = start(doc)
    let snap = t.run(0.05)
    expect.soft(reading(snap, bat.id).current * 1e3, "current is being pushed in (mA)").toBeNear(380, 20)
    expect.soft(extra(snap, bat.id, "Charging (avg)"), "the inspector says charging").not.toBe("?")
    expect.soft(timeLeft(snap, bat.id), "and nothing to wait for").toBe("—")
    expect.soft(Math.round((reading(snap, bat.id).charge ?? 0) * 100), "it holds its charge, not more (%)").toBe(100)
    snap = t.run(8)
    expect.soft(snap.damage[bat.id]?.reason ?? "", "vented").toMatch(/vented/)
    expect.soft(snap.damage[bat.id]?.fail ?? "?", "open circuit now").toBe("open")
  })

  it("a full Li-ion cell left on 9 V goes into thermal runaway", () => {
    const { doc, place, wire } = builder(GRID)
    const bat = place("battery", 0, 0, { chem: "li-ion", cells: "1", capacity: "10 mAh", soc: "100" })
    const src = place("dc-source", 8, 0, { value: "9 V", rint: "0.5 Ω", imax: "30 A" })
    const r = place("resistor", 4, -4, { value: "1 Ω", power: "5" })
    const gnd = place("ground", 4, 6)
    wire(src, "+", r, "2")
    wire(r, "1", bat, "+")
    wire(bat, "-", gnd, "GND")
    wire(src, "-", gnd, "GND")
    const t = start(doc)
    let snap = t.run(1)
    expect.soft((reading(snap, bat.id).charge ?? 0) * 100, "charge climbs past 100 % (%)").toBeGreaterThan(100.5)
    expect.soft(parseFloat(extra(snap, bat.id, "Open-circuit")), "open-circuit voltage rises past 4.2 V").toBeGreaterThan(4.2)
    snap = t.run(8)
    expect.soft(snap.damage[bat.id]?.reason ?? "", "5 % over: thermal runaway").toMatch(/thermal runaway/)
    expect.soft(snap.damage[bat.id]?.fail ?? "?", "it fails short").toBe("short")
  })

  it("a half-charged NiMH cell on a 5 V trickle reports when it will be full", () => {
    const { doc, place, wire } = builder(GRID)
    const bat = place("battery", 0, 0, { chem: "nimh", cells: "1", capacity: "10 mAh", soc: "50" })
    const src = place("dc-source", 8, 0, { value: "5 V" })
    const r = place("resistor", 4, -4, { value: "470 Ω" })
    const gnd = place("ground", 4, 6)
    wire(src, "+", r, "2")
    wire(r, "1", bat, "+")
    wire(bat, "-", gnd, "GND")
    wire(src, "-", gnd, "GND")
    const snap = start(doc).run(0.1)
    expect.soft(parseFloat(extra(snap, bat.id, "Charging (avg)")), "charging at (mA)").toBeNear(7.9, 0.3)
    // 5 mAh to put back at 7.9 mA and 70 % efficiency: 54 min.
    expect.soft(hours(timeLeft(snap, bat.id).replace("full in ", "")), "full in (h)").toBeNear(0.9, 0.1)
  })

  it("the AA pair at −20 °C: 40 % of the capacity, four times the resistance", () => {
    const { doc, bat } = bench({ chem: "alkaline", cells: "2", capacity: "2.5 Ah", soc: "100", temp: "-20" }, "100 Ω")
    const snap = start(doc).run(0.05)
    expect.soft(parseValue(extra(snap, bat.id, "Internal R")), "internal resistance (Ω)").toBeNear(1.12, 0.03)
    expect.soft(extra(snap, bat.id, "Capacity"), "capacity now").toBe("1.00 Ah (40 %)")
    // 40 % of the 75 h at 25 °C, less again because 31 mA is a heavier rate for what is now a 1 Ah cell.
    expect.soft(hours(timeLeft(snap, bat.id)), "time left (h)").toBeNear(25, 3)
    expect.soft(extra(snap, bat.id, "Temperature"), "cell temperature is the air's").toBe("-20.0 °C")
    const { doc: hot, bat: bat2 } = bench({ chem: "alkaline", cells: "2", capacity: "2.5 Ah", soc: "100", temp: "60" }, "100 Ω")
    const snap2 = start(hot).run(0.05)
    expect.soft(parseValue(extra(snap2, bat2.id, "Internal R")) * 1e3, "at 60 °C the resistance is 0.7× (mΩ)").toBeNear(196, 4)
  })

  it("diffusion: the AA pair on 3 Ω sags on for a while, and rests back up when the load goes", () => {
    const { doc, place, wire } = builder(GRID)
    const bat = place("battery", 0, 0, { chem: "alkaline", cells: "2", capacity: "2.5 Ah", soc: "100" })
    const sw = place("switch", 6, 0)
    const r = place("resistor", 12, 0, { value: "3 Ω", power: "5" })
    const gnd = place("ground", 3, 6)
    wire(bat, "+", sw, "1")
    wire(sw, "2", r, "1")
    wire(r, "2", gnd, "GND")
    wire(bat, "-", gnd, "GND")
    doc.parts[partKey(sw.id, "SW")] = { on: true }
    const t = start(doc)
    let snap = t.run(0.05)
    const v0 = reading(snap, bat.id).voltage
    snap = t.run(40)
    expect.soft(v0 - reading(snap, bat.id).voltage, "40 s in, the terminal voltage has sagged past the ohmic drop (V)").toBeNear(0.25, 0.06)
    expect.soft(parseValue(extra(snap, bat.id, "Polarization")), "polarization built up (V)").toBeNear(0.27, 0.06)
    expect.soft(parseFloat(extra(snap, bat.id, "Temperature")), "and the cells have warmed a little (°C)").toBeNear(25.5, 0.4)
    t.parts({ [partKey(sw.id, "SW")]: { on: false } })
    snap = t.run(0.05)
    const ocv = parseFloat(extra(snap, bat.id, "Open-circuit"))
    expect.soft(ocv - reading(snap, bat.id).voltage, "switch off: the ohmic drop is gone at once, the rest is not (V below OCV)").toBeNear(0.27, 0.06)
    snap = t.run(30)
    expect.soft(ocv - reading(snap, bat.id).voltage, "30 s later it has rested most of the way up (V below OCV)").toBeNear(0.06, 0.03)
    snap = t.run(120)
    expect.soft(ocv - reading(snap, bat.id).voltage, "2 min on, the slow branch is still creeping up (V below OCV)").toBeNear(0.035, 0.015)
  })

  it("a 500 mAh Li-ion pouch shorted through a wire heats into thermal runaway", () => {
    const { doc, bat } = bench({ chem: "li-ion", cells: "1", capacity: "500 mAh", soc: "100" }, "50 mΩ", "100")
    const t = start(doc)
    let snap = t.run(0.05)
    expect.soft(-reading(snap, bat.id).current, "short-circuit current (A)").toBeNear(14.5, 0.5)
    snap = t.run(5)
    expect.soft(parseFloat(extra(snap, bat.id, "Temperature")), "5 s in it is hot to the touch (°C)").toBeGreaterThan(55)
    expect.soft(snap.damage[bat.id], "still in one piece").toBeFalsy()
    snap = t.run(20)
    expect.soft(snap.damage[bat.id]?.reason ?? "", "130 °C: thermal runaway").toMatch(/thermal runaway/)
    expect.soft(snap.damage[bat.id]?.fail ?? "?", "it fails short").toBe("short")
  })

  it("an 18650 after 500 cycles and two years: 76 % of its capacity, 2.2× the resistance", () => {
    const { doc, bat } = bench({ chem: "li-ion", cells: "1", capacity: "3 Ah", soc: "100", cycles: "500", years: "2" }, "10 Ω")
    const snap = start(doc).run(0.05)
    expect.soft(extra(snap, bat.id, "Capacity"), "capacity now").toBe("2.28 Ah (76 %)")
    expect.soft(parseFloat(extra(snap, bat.id, "Internal R")), "internal resistance (mΩ)").toBeNear(88, 2)
    const { doc: fresh, bat: bat2 } = bench({ chem: "li-ion", cells: "1", capacity: "3 Ah", soc: "100" }, "10 Ω")
    const snap2 = start(fresh).run(0.05)
    expect.soft(hours(timeLeft(snap2, bat2.id)) / hours(timeLeft(snap, bat.id)), "a fresh one has 24 % more time left (h)").toBeNear(1.32, 0.05)
  })

  it("a 3S pack with 30 % cell mismatch is empty when its weakest cell is", () => {
    // 350 / 500 / 650 mAh cells at 4 %, ~1 A: the small one is flat in under a minute.
    const { doc, bat } = bench({ chem: "li-ion", cells: "3", capacity: "500 mAh", soc: "4", spread: "30" }, "10 Ω", "20")
    const t = start(doc)
    let snap = t.run(0.05)
    expect.soft(extra(snap, bat.id, "Cells"), "all cells start at 4 %").toBe("4 – 4 %")
    snap = t.run(25)
    const cells = /(\d+) – (\d+) %/.exec(extra(snap, bat.id, "Cells"))!
    expect.soft(Number(cells[2]), "the small cell drains faster").toBeGreaterThan(Number(cells[1]))
    snap = t.run(40)
    expect.soft(timeLeft(snap, bat.id), "the pack reads empty").toBe("empty")
    const after = /(\d+) – (\d+) %/.exec(extra(snap, bat.id, "Cells"))!
    expect.soft(Number(after[2]), "while the big cell still holds charge (%)").toBeGreaterThanOrEqual(1)
    snap = t.run(60)
    expect.soft(snap.damage[bat.id]?.reason ?? "", "the weakest cell dragged below cut-off kills the pack").toMatch(/a cell discharged/)
  })
})
