/**
 * The Kingbright 0.56" seven-segment displays against their sheets (tests/data/kingbright-56-seven-segment):
 * every segment's I–V follows the digitised curve, the pins are the internal circuit diagram's
 * leads, the ratings burn one segment open and leave the others, the derating curve holds at
 * the ambient set, and on the bench a four-digit display multiplexed at 1/4 duty survives peaks
 * a DC drive at the same current would not.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { deratedCurrent, SEGMENT_SHEETS, sevenSegmentComponents } from "@/schematic/components/seven-segment"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import tables from "../data/kingbright-56-seven-segment/tables.json"

type Curve = { points: number[][]; grid: { x: { slope: number }; y: { slope: number } } }
const curves = import.meta.glob<{ forwardVoltage: Curve; derating: Curve }>("../data/kingbright-56-seven-segment/curves/*.json", { eager: true, import: "default" })
const curveOf = (part: string) => curves[`../data/kingbright-56-seven-segment/curves/${part}.json`]
const table = (part: string) => (tables as Record<string, { VF_V: number[]; IF_mA: number; IFM_mA: number; PD_mW: number; VR_V: number; spec: string; rev: string }>)[part]

const PARTS = Object.keys(SEGMENT_SHEETS)
const VT = 0.025852

/** The fitted diode's voltage at a current, as the engine's D element computes it. */
function modelVolts(part: string, amps: number) {
  const { junctionVoltsAt10mA: vj, emission: n, seriesOhms: rs } = SEGMENT_SHEETS[part].fit
  const is = 0.01 / Math.expm1(vj / (n * VT))
  return n * VT * Math.log1p(amps / is) + amps * rs
}

function run(doc: Schematic, ms: number): Snapshot {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  while (clock < ms) {
    clock = Math.min(ms, clock + 10)
    loop.advance(clock)
  }
  const snap = loop.snapshot()!
  loop.dispose()
  return snap
}

/** A DC source through `ohms` into one segment of a single-digit display, common to the other rail. */
function segmentBench(def: string, part: string, segment: string, volts: number, ohms: number, props: Record<string, string> = {}) {
  const { doc, place, wire } = builder(GRID)
  const source = place("dc-source", 0, 0, { value: `${volts} V`, rint: `${ohms} Ω`, imax: "10 A" })
  const ds = place(def, 12, 0, { value: part, ...props })
  const gnd = place("ground", 4, 14)
  const anode = def.endsWith("ca")
  if (anode) {
    wire(source, "+", ds, "COM3")
    wire(ds, segment, gnd, "GND")
  } else {
    wire(source, "+", ds, segment)
    wire(ds, "COM8", gnd, "GND")
  }
  wire(source, "-", gnd, "GND")
  return { doc, ds }
}

const segmentIndex = (segment: string) => ["a", "b", "c", "d", "e", "f", "g", "DP"].indexOf(segment)
const current = (snap: Snapshot, ds: PlacedObject, segment: string) => Math.abs(snap.readings.find((r) => r.object === ds.id && r.element === segmentIndex(segment))?.current ?? 0)

describe("Kingbright 0.56\" seven-segment displays, sheet by sheet", () => {
  it.each(PARTS)("%s: the sheet's number, revision and absolute maxima", (part) => {
    const s = SEGMENT_SHEETS[part]
    const t = table(part)
    expect(s.spec).toBe(t.spec)
    expect(s.rev).toBe(t.rev)
    expect(s.vf).toEqual(t.VF_V)
    expect(s.ratings.current * 1e3).toBeCloseTo(t.IF_mA, 9)
    expect(s.ratings.peakCurrent * 1e3).toBeCloseTo(t.IFM_mA, 9)
    expect(s.ratings.power * 1e3).toBeCloseTo(t.PD_mW, 9)
    expect(s.ratings.reverseVolts).toBe(t.VR_V)
  })

  it.each(PARTS)("%s: the fitted segment follows the digitised I–V curve within 20 mV from 0.5 to 20 mA", (part) => {
    const c = curveOf(part).forwardVoltage
    let worst = 0
    for (const [v, ma] of c.points) if (ma > 0.5) worst = Math.max(worst, Math.abs(modelVolts(part, ma / 1000) - v))
    expect(worst).toBeLessThan(0.02)
    // The printed typical VF at 10 mA, within the sheet's ±0.1 V.
    expect(modelVolts(part, 0.01)).toBeNear(SEGMENT_SHEETS[part].vf[0], 0.1)
  })

  it.each(PARTS)("%s: the derating knots are the digitised curve's", (part) => {
    const pts = curveOf(part).derating.points.filter(([, ma]) => ma > 0.5)
    for (const [t, ma] of pts) expect.soft(deratedCurrent(SEGMENT_SHEETS[part], t) * 1e3, `${t} °C`).toBeNear(ma, 0.05)
  })

  it("pins carry the leads of the internal circuit diagrams", () => {
    const single = getDef("seven-segment-ca")!
    const leads = Object.fromEntries(single.pins.map((p) => [p.id, p.connectorPin]))
    expect(leads).toEqual({ a: 7, b: 6, c: 4, d: 2, e: 1, f: 9, g: 10, DP: 5, COM3: 3, COM8: 8 })
    const quad = getDef("seven-segment-4-cc")!
    expect(Object.fromEntries(quad.pins.map((p) => [p.id, p.connectorPin]))).toEqual({ a: 11, b: 7, c: 4, d: 2, e: 1, f: 10, g: 5, DP: 3, D1: 12, D2: 9, D3: 8, D4: 6 })
    expect(sevenSegmentComponents.map((d) => d.id)).toEqual(["seven-segment-ca", "seven-segment-cc", "seven-segment-4-ca", "seven-segment-4-cc"])
  })

  it.each(PARTS.filter((p) => p.includes("-11")).map((p) => [p.startsWith("SA") ? "seven-segment-ca" : "seven-segment-cc", p]))("%s %s: 5 V through 330 Ω lights segment a alone at the curve's current", (def, part) => {
    const { doc, ds } = segmentBench(def, part, "a", 5, 330)
    const snap = run(doc, 20)
    const amps = current(snap, ds, "a")
    // Solve 5 = 330 i + V(i) on the fitted curve: the sheet's segment at this current.
    let lo = 0
    let hi = 0.02
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2
      if (330 * mid + modelVolts(part, mid) > 5) hi = mid
      else lo = mid
    }
    expect(amps).toBeNearRel(lo, 0.01)
    for (const s of ["b", "c", "d", "e", "f", "g", "DP"]) expect.soft(snap.parts[partKey(ds.id, s)]?.on ?? false, s).toBe(false)
    expect(snap.parts[partKey(ds.id, "a")]?.on).toBe(true)
    expect(snap.damage[ds.id]).toBeFalsy()
  })

  it("a segment run past its DC rating burns open, and the other segments still work", () => {
    // 5 V straight into segment a through 20 Ω: ~150 mA, five times the 30 mA DC rating but under the 160 mA peak.
    const { doc, place, wire } = builder(GRID)
    const source = place("dc-source", 0, 0, { value: "5 V", rint: "20 Ω", imax: "10 A" })
    const ds = place("seven-segment-cc", 12, 0, { value: "SC56-11EWA" })
    const gnd = place("ground", 4, 14)
    const r = place("resistor", 0, 8, { value: "330 Ω", power: "0.25" })
    wire(source, "+", ds, "a")
    wire(source, "+", r, "1")
    wire(r, "2", ds, "b")
    wire(ds, "COM8", gnd, "GND")
    wire(source, "-", gnd, "GND")
    const snap = run(doc, 3000)
    const damage = snap.damage[ds.id]
    expect(damage, "segment a burnt").toBeTruthy()
    expect(damage!.fatal, "the display is not dead").toBe(false)
    expect(damage!.fail).toBe("open")
    expect(damage!.element).toBe(segmentIndex("a"))
    expect(snap.parts[partKey(ds.id, "b")]?.on, "segment b on its 330 Ω still lights").toBe(true)
  })

  it("a peak past IFM (1/10 duty, 0.1 ms) kills a segment at once", () => {
    const { doc, ds } = segmentBench("seven-segment-cc", "SC56-11EWA", "a", 12, 10)
    const snap = run(doc, 5)
    expect(snap.damage[ds.id]?.element).toBe(segmentIndex("a"))
  })

  it("a segment reversed past 5 V breaks; at 5 V it does not", () => {
    for (const [volts, broken] of [
      [4.9, false],
      [7, true],
    ] as const) {
      const { doc, place, wire } = builder(GRID)
      const source = place("dc-source", 0, 0, { value: `${volts} V`, rint: "1 kΩ" })
      const ds = place("seven-segment-cc", 12, 0, { value: "SC56-11EWA" })
      const gnd = place("ground", 4, 14)
      wire(source, "+", ds, "COM8")
      wire(ds, "a", gnd, "GND")
      wire(source, "-", gnd, "GND")
      const snap = run(doc, 20)
      expect.soft(!!snap.damage[ds.id], `${volts} V reversed`).toBe(broken)
    }
  })

  it("at 85 °C a 10 mA segment is past the derating curve and burns; at 25 °C it does not", () => {
    for (const [temp, broken] of [
      ["25", false],
      ["85", true],
    ] as const) {
      const { doc, ds } = segmentBench("seven-segment-cc", "SC56-11EWA", "a", 5, 300, { temp })
      const snap = run(doc, 3000)
      expect.soft(!!snap.damage[ds.id], `${temp} °C`).toBe(broken)
    }
  })
})

describe("on the bench: a four-digit display multiplexed", () => {
  /**
   * Segment a of all four digits fed through 22 Ω from 5 V (~110 mA when lit, under the 160 mA
   * peak but nearly four times the 30 mA DC rating); the digits' commons are pulled to ground in
   * turn by four pulse sources at 1/4 duty, 1 ms each. The average per segment is ~27 mA: it lives.
   * The same drive held on one digit is DC at ~110 mA: that segment burns.
   */
  function bench(duty: number, held = false) {
    const { doc, place, wire } = builder(GRID)
    const supply = place("dc-source", 0, 0, { value: "5 V", rint: "22 Ω", imax: "10 A" })
    const ds = place("seven-segment-4-cc", 14, 0, { value: "CC56-12EWA" })
    const gnd = place("ground", 2, 20)
    wire(supply, "+", ds, "a")
    wire(supply, "-", gnd, "GND")
    for (let d = 0; d < 4; d++) {
      // A low-side switch per digit: a pulse source from the common to ground, 0 V (on) for its quarter.
      // Held: digit 1 always on (its source at 0 %, a constant low), the others always off (100 %).
      const dutyPercent = held ? (d === 0 ? 0 : 100) : 100 * (1 - duty)
      const sw = place("pulse-source", 10 + d * 6, 12, { high: "5 V", low: "0 V", freq: "250 Hz", duty: String(dutyPercent), delay: `${d} ms`, rint: "1 Ω" })
      wire(ds, `D${d + 1}`, sw, "+")
      wire(sw, "-", gnd, "GND")
    }
    return { doc, ds }
  }

  it("1/4 duty: every digit's segment a lights and none burns", () => {
    const { doc, ds } = bench(0.25)
    const snap = run(doc, 1000)
    expect(snap.damage[ds.id]).toBeFalsy()
    for (let d = 1; d <= 4; d++) expect.soft(snap.parts[partKey(ds.id, `a${d}`)]?.on, `digit ${d}`).toBe(true)
  })

  it("the same ~110 mA held on one digit is DC: that digit's segment a burns, the rest of the display does not", () => {
    const { doc, ds } = bench(0.25, true)
    const snap = run(doc, 3000)
    const damage = snap.damage[ds.id]
    expect(damage?.fail).toBe("open")
    expect(damage?.fatal).toBe(false)
    expect(damage?.element, "digit 1's segment a").toBe(0)
  })
})
