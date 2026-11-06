import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, type PartState } from "@/schematic/types"
import { Engine } from "@/sim/engine"
import { buildNetlist, type GpioState } from "@/sim/netlist"
import { DT } from "@/sim/speeds"

const SWITCHES = 40
const SETTLE = 20

function switchBank() {
  const { doc, place, wire } = builder(GRID)
  const rows = Array.from({ length: SWITCHES }, (_, i) => {
    const y = i * 6
    const supply = place("supply", 0, y, { value: "+3.3V", voltage: "3.3 V" })
    const sw = place("switch", 6, y)
    const load = place("resistor", 14, y, { value: "10 kΩ", power: "0.25" })
    const slow = place("resistor", 14, y + 3, { value: "1 MΩ", power: "0.25" })
    const reservoir = place("capacitor", 20, y + 3, { value: "10 µF" })
    const ground = place("ground", 26, y + 3)
    wire(supply, "V", sw, "1")
    wire(sw, "2", load, "1")
    wire(load, "1", slow, "1")
    wire(slow, "2", reservoir, "1")
    wire(load, "2", ground, "GND")
    wire(reservoir, "2", ground, "GND")
    return { sw, load }
  })
  return { doc, rows }
}

function mcuBench() {
  const { doc, place, wire } = builder(GRID)
  const s = place("supply", 0, 0, { voltage: "5 V", imax: "3 A" })
  const g = place("ground", 0, 20)
  const u = place("atmega328p", 20, 0)
  const load = place("resistor", 30, 6, { value: "1 kΩ", power: "0.25" })
  for (const p of ["VCC", "AVCC"]) wire(s, "V", u, p)
  for (const [o, p] of [[u, "GND"], [load, "2"], [s, "GND"]] as const) wire(o, p, g, "GND")
  wire(u, "PB1", load, "1")
  return { doc, u, load }
}

function current(engine: Engine, object: string) {
  const reading = engine.readings().find((r) => r.object === object)
  expect(reading, `${object} has a reading`).toBeDefined()
  return reading!.current
}

describe("the matrix's pattern is fixed when the circuit is built, so a switch or a pad changing state reorders nothing", () => {
  it(`${SWITCHES} switches between a supply and a load with a 10 s RC hanging off it, closed one at a time: no reordering, each load at 3.3 V while its switch is closed`, () => {
    const { doc, rows } = switchBank()
    const engine = new Engine(buildNetlist(doc))
    const keys = new Map(rows.map((r, i) => [partKey(r.sw.id, "SW"), i]))
    let closed = -1
    const parts = (key: string): PartState => ({ on: keys.get(key) === closed })
    for (let s = 0; s < SETTLE; s++) engine.step(DT, parts)
    const built = engine.orderingCount
    const wrong: string[] = []
    for (closed = 0; closed < rows.length; closed++) {
      for (let s = 0; s < SETTLE; s++) engine.step(DT, parts)
      rows.forEach((r, i) => {
        const amps = current(engine, r.load.id)
        const want = i === closed ? 3.3 / 10e3 : 0
        if (Math.abs(amps - want) > 1e-6) wrong.push(`switch ${closed} closed: load ${i} carries ${amps} A`)
      })
    }
    expect.soft(built, "orderings to build and settle the bank").toBeGreaterThan(0)
    expect.soft(engine.orderingCount - built, `orderings while ${SWITCHES} switches close and open in turn: at most the settled-state solver's first, made when a capacitor first drifts`).toBeLessThanOrEqual(1)
    expect.soft(wrong.slice(0, 10), `${wrong.length} wrong load currents`).toEqual([])
  })

  it("a pad driven high for the first time, after the core has run with it low, solved in full: no new ordering, the load at the rail", () => {
    const { doc, u, load } = mcuBench()
    const engine = new Engine(buildNetlist(doc))
    engine.leafPath = false
    let level: GpioState = "low"
    const pins = (_: number, object: string, node: string): GpioState | null => (object === u.id && node === "PB1" ? level : null)
    const parts = () => ({})
    for (let s = 0; s < 500; s++) engine.step(DT, parts, pins)
    const built = engine.orderingCount
    expect.soft(current(engine, load.id), "PB1 low: no load current (A)").toBeNear(0, 1e-6)
    level = "high"
    for (let s = 0; s < SETTLE; s++) engine.step(DT, parts, pins)
    expect.soft(engine.orderingCount - built, "orderings after PB1 is driven high").toBe(0)
    expect.soft(current(engine, load.id) * 1e3, "PB1 high: 5 V across 1 kΩ and the pad's 25 Ω (mA)").toBeNear(5 / 1.025, 0.1)
  })
})
