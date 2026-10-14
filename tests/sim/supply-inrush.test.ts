/**
 * Power-on inrush: a bulk electrolytic straight across a power rail. A real one charges through
 * its ESR and the supply's output resistance in a fraction of a millisecond and nothing trips;
 * a dead short across the same rail still takes it down.
 *
 * ESR from the Nichicon UVR catalogue (CAT.8100L, "Tangent of loss angle", 120 Hz, 20 °C):
 * tan δ max 0.28 / 0.24 / 0.20 / 0.16 / 0.14 / 0.12 / 0.10 / 0.08 at 6.3 / 10 / 16 / 25 / 35 /
 * 50 / 63 / 100 V, 0.20 at 160–315 V, 0.25 at 350–450 V, plus 0.02 for every 1000 µF over
 * 1000 µF; ESR = tan δ / (2π · 120 Hz · C).
 * Rail output resistance: Fairchild LM78XX (© 2006), LM7805, "Output Resistance f = 1 kHz: 15 mΩ".
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import type { PlacedObject } from "@/schematic/types"
import { Engine } from "@/sim/engine"
import { buildNetlist } from "@/sim/netlist"
import { DT } from "@/sim/speeds"

const W = 2 * Math.PI * 120

function esrOf(props: Record<string, string>) {
  const { doc, place } = builder(GRID)
  const c = place("capacitor-polarized", 0, 0, props)
  const r = buildNetlist(doc).elements.filter((e) => e.object === c.id && e.kind === "R")
  expect(r.length, "one series resistance inside the electrolytic").toBe(1)
  return (r[0] as { value: number }).value
}

describe("electrolytic ESR from the UVR tan δ table", () => {
  it.each([
    ["100 µF", "16 V", 0.2 / (W * 100e-6)],
    ["10 µF", "16 V", 0.2 / (W * 10e-6)],
    ["100 µF", "6.3 V", 0.28 / (W * 100e-6)],
    ["470 µF", "10 V", 0.24 / (W * 470e-6)],
    ["1000 µF", "25 V", 0.16 / (W * 1000e-6)],
    ["2200 µF", "35 V", (0.14 + 0.02) / (W * 2200e-6)],
    ["4700 µF", "16 V", (0.2 + 0.06) / (W * 4700e-6)],
    ["22 µF", "50 V", 0.12 / (W * 22e-6)],
    ["1 µF", "63 V", 0.1 / (W * 1e-6)],
    ["47 µF", "100 V", 0.08 / (W * 47e-6)],
    ["10 µF", "250 V", 0.2 / (W * 10e-6)],
    ["4.7 µF", "400 V", 0.25 / (W * 4.7e-6)],
    // Between rows the lower row's (larger) tan δ: a 20 V part is no better than a 16 V one.
    ["100 µF", "20 V", 0.2 / (W * 100e-6)],
  ])("%s %s", (value, vmax, want) => {
    expect(esrOf({ value, vmax })).toBeNearRel(want, 1e-9)
  })

  it("the default part (10 µF 16 V) is 26.5 Ω at 120 Hz", () => {
    expect(esrOf({})).toBeNear(26.53, 0.01)
  })

  it("an ESR typed in the inspector wins", () => {
    expect(esrOf({ value: "100 µF", vmax: "16 V", esr: "80 mΩ" })).toBeNearRel(0.08, 1e-9)
  })
})

it("the power rail has the LM78xx's 15 mΩ output resistance", () => {
  const { doc, place } = builder(GRID)
  const s = place("supply", 0, 0, { voltage: "5 V", imax: "1 A" })
  const r = buildNetlist(doc).elements.filter((e) => e.object === s.id && e.kind === "R")
  expect(r.length).toBe(1)
  expect((r[0] as { value: number }).value).toBeNearRel(0.015, 1e-9)
})

/** The "Bird" bench a user reported: 5 V 3 A rail, 100 µF + 100 nF across it, an NE555 astable driving a buzzer through an emitter follower. */
function bird() {
  const b = builder(GRID)
  const bz = b.place("buzzer-cem-1203-42", 0, 0, { ref: "BZ1" })
  const u = b.place("ne555", 10, 0, { ref: "U1" })
  const s = b.place("supply", 20, 0, { voltage: "5 V", imax: "3 A", value: "+5V" })
  const g = b.place("ground", 30, 0)
  const c1 = b.place("capacitor-polarized", 40, 0, { ref: "C1", value: "100 µF" })
  const c2 = b.place("capacitor", 50, 0, { ref: "C2" })
  const r1 = b.place("resistor", 60, 0, { ref: "R1" })
  const r2 = b.place("resistor", 70, 0, { ref: "R2", value: "2 kΩ" })
  const c3 = b.place("capacitor", 80, 0, { ref: "C3" })
  const c4 = b.place("capacitor", 90, 0, { ref: "C4", value: "10 nF" })
  const q = b.place("npn", 100, 0, { ref: "Q1", value: "BC337", beta: "250", rc: "1 Ω", icmax: "800 mA", pmax: "625 mW" })
  const rv = b.place("potentiometer", 110, 0, { ref: "RV1" })
  const d = b.place("diode", 120, 0, { ref: "D1" })
  const V: [PlacedObject, string] = [s, "V"]
  const G: [PlacedObject, string] = [g, "GND"]
  const w = (a: [PlacedObject, string], c: [PlacedObject, string]) => b.wire(a[0], a[1], c[0], c[1])
  w([c1, "1"], V)
  w([c1, "2"], G)
  w([c2, "1"], V)
  w([c2, "2"], G)
  w([r1, "1"], V)
  w([u, "RESET"], V)
  w([u, "VCC"], V)
  w([q, "C"], V)
  w([r2, "1"], [u, "DIS"])
  w([r2, "2"], [u, "THRES"])
  w([u, "TRIG"], [u, "THRES"])
  w([c3, "1"], [u, "THRES"])
  w([c3, "2"], G)
  w([u, "GND"], G)
  w([c4, "2"], G)
  w([rv, "2"], G)
  w([rv, "W"], [q, "B"])
  w([rv, "1"], [u, "OUT"])
  w([bz, "2"], G)
  w([d, "1"], G)
  w([q, "E"], [bz, "1"])
  w([d, "2"], [q, "E"])
  return { ...b, s, c1, g }
}

describe("power-on with a bulk electrolytic across the rail", () => {
  it("the Bird bench runs a second without tripping the rail, C1 charging through its ESR", () => {
    const b = bird()
    const e = new Engine(buildNetlist(b.doc))
    const parts = (k: string) => b.doc.parts[k] ?? {}
    const esr = (e.readings().find((r) => r.object === b.c1.id && r.kind === "R") ?? null)!
    expect(esr, "C1's ESR is a solved element").toBeTruthy()
    let peak = 0
    for (let k = 0; k < Math.round(1 / DT); k++) {
      e.step(DT, parts)
      expect(e.failures, `nothing fails (step ${k})`).toEqual([])
      const r = e.readings().find((x) => x.object === b.c1.id && x.kind === "R")!
      peak = Math.max(peak, Math.abs(r.current))
    }
    // 5 V across 2.65 Ω + 15 mΩ: at most 1.88 A, and the first 20 µs step of a 265 µs RC reads a little under it.
    expect(peak, "C1's inrush peak (A)").toBeLessThan(5 / (0.2 / (W * 100e-6) + 0.015) + 1e-3)
    expect(peak, "C1's inrush peak (A)").toBeGreaterThan(1.6)
    const rail = e.readings().find((r) => r.object === b.s.id && r.kind === "V")!
    expect(rail.limits, "the rail's meter still carries the rating").toBeTruthy()
  })

  it("a 100 µF electrolytic alone on a 1 A 3.3 V rail: no trip", () => {
    const { doc, place, wire } = builder(GRID)
    const s = place("supply", 0, 0, { voltage: "3.3 V", imax: "1 A" })
    const g = place("ground", 0, 10)
    const c = place("capacitor-polarized", 4, 4, { value: "100 µF", vmax: "6.3 V" })
    wire(s, "V", c, "1")
    wire(c, "2", g, "GND")
    const e = new Engine(buildNetlist(doc))
    for (let k = 0; k < Math.round(0.02 / DT); k++) {
      e.step(DT, () => ({}))
      expect(e.failures).toEqual([])
    }
  })

  it("a dead short across the rail still trips it at once", () => {
    const { doc, place, wire } = builder(GRID)
    const s = place("supply", 0, 0, { voltage: "5 V", imax: "3 A" })
    const g = place("ground", 0, 10)
    wire(s, "V", g, "GND")
    const e = new Engine(buildNetlist(doc))
    e.step(DT, () => ({}))
    expect(e.failures.map((f) => f.object)).toEqual([s.id])
    expect(e.failures[0].damage.reason).toMatch(/current .* exceeds the 3\.00 A rating/)
  })

  it("an overload of 2 × rated rides a few ms, then trips; 0.9 × never does", () => {
    const trips = (load: string) => {
      const { doc, place, wire } = builder(GRID)
      const s = place("supply", 0, 0, { voltage: "2 V", imax: "1 A" })
      const r = place("resistor", 4, 4, { value: load, power: "50" })
      const g = place("ground", 4, 8)
      wire(s, "V", r, "1")
      wire(r, "2", g, "GND")
      const e = new Engine(buildNetlist(doc))
      for (let k = 0; k < Math.round(0.2 / DT); k++) {
        e.step(DT, () => ({}))
        if (e.failures.length) return k * DT
      }
      return Infinity
    }
    // Stress follows (I/Imax)² = 4 through τ = 35 ms: crosses 1 at τ·ln(4/3) ≈ 10 ms.
    expect(trips("1 Ω") * 1e3).toBeNear(10, 2)
    expect(trips("2.2 Ω")).toBe(Infinity)
  })
})
