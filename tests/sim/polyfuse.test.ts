/**
 * Bourns MF-MSMF resettable fuses (PTC) against the series data sheet: Ihold (no trip), Itrip
 * (always trips), the maximum time to trip at the listed current, Rmin as delivered, the
 * tripped dissipation (0.8 W typ.) that keeps a tripped part hot, Vmax. The part resets once
 * the power is taken away and it has cooled.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { Engine } from "@/sim/engine"
import { buildNetlist } from "@/sim/netlist"
import { DT } from "@/sim/speeds"

/** `volts` through the fuse into `load`, with a switch in the supply; the source and the switch add 1 mΩ each. */
function bench(volts: number, load: string, props: Record<string, string> = {}) {
  const b = builder(GRID)
  const f = b.place("polyfuse", 20, 10, props)
  const gnd = b.place("ground", 0, 60)
  const src = b.place("dc-source", 0, 10, { value: `${volts} V`, rint: "1 mΩ", imax: "200 A" })
  const sw = b.place("switch", 10, 0, { imax: "200 A", rcontact: "1 mΩ" })
  const r = b.place("resistor", 40, 20, { value: load, power: "1000" })
  b.wire(src, "+", sw, "1")
  b.wire(sw, "2", f, "1")
  b.wire(f, "2", r, "1")
  b.wire(r, "2", gnd, "GND")
  b.wire(src, "-", gnd, "GND")
  b.doc.parts[partKey(sw.id, "SW")] = { on: true }
  return { doc: b.doc, f, sw }
}

type Run = { e: Engine; doc: Schematic; f: PlacedObject; sw: PlacedObject }

function start(b: ReturnType<typeof bench>): Run {
  return { ...b, e: new Engine(buildNetlist(b.doc)) }
}

const reading = (r: Run) => r.e.readings().find((x) => x.object === r.f.id && x.kind === "R")!
const tripped = (r: Run) => reading(r).extra?.state === "tripped"

/** Steps until `until` holds or `seconds` pass; the time it took, or Infinity. */
function run(r: Run, seconds: number, until: (r: Run) => boolean = () => false) {
  const parts = (key: string) => r.doc.parts[key] ?? {}
  const t0 = r.e.time
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    r.e.step(DT, parts)
    if (r.e.failures.length) throw new Error(r.e.failures.map((f) => f.damage.reason).join("; "))
    if (until(r)) return r.e.time - t0
  }
  return Infinity
}

describe("MF-MSMF050 (Arduino's USB fuse): 15 V, Ihold 0.5 A, Itrip 1.0 A, 8 A in 0.15 s, 0.15–1.0 Ω, 0.8 W", () => {
  it("starts at Rmin, 0.15 Ω", () => {
    const r = start(bench(5, "50 Ω"))
    run(r, 1e-3)
    expect(reading(r).voltage / reading(r).current).toBeNear(0.15, 1e-3)
  })

  it("trips within 0.15 s at 8 A", () => {
    const r = start(bench(5, `${5 / 8 - 0.15 - 0.002} Ω`))
    const t = run(r, 0.3, tripped)
    expect.soft(t, "time to trip").toBeLessThanOrEqual(0.15 + 2 * DT)
    expect.soft(t, "time to trip").toBeGreaterThan(0.05)
  })

  it("trips at Itrip, 1.0 A, though it takes seconds", () => {
    const r = start(bench(5, `${5 - 0.15} Ω`))
    expect(run(r, 60, tripped)).toBeLessThan(60)
  })

  it("holds 0.5 A for a minute without tripping", () => {
    const r = start(bench(5, `${10 - 0.15} Ω`))
    expect(run(r, 60, tripped)).toBe(Infinity)
  })

  it("tripped, it lets through what keeps 0.8 W in it: about 160 mA from 5 V into a short", () => {
    const r = start(bench(5, "1 mΩ"))
    run(r, 0.5, tripped)
    run(r, 0.05)
    expect.soft(tripped(r), "tripped").toBe(true)
    expect.soft(reading(r).power, "dissipation (W)").toBeNear(0.8, 0.05)
    expect.soft(reading(r).current * 1e3, "current (mA)").toBeNear(160, 10)
  })

  it("stays tripped while powered, and resets once the power is off and it has cooled", () => {
    const r = start(bench(5, "1 mΩ"))
    run(r, 0.5, tripped)
    run(r, 2)
    expect.soft(tripped(r), "after 2 s powered").toBe(true)
    r.doc.parts[partKey(r.sw.id, "SW")] = { on: false }
    run(r, 0.1)
    expect.soft(tripped(r), "just switched off").toBe(true)
    const cooled = run(r, 120, (x) => !tripped(x))
    expect.soft(cooled, "time to reset").toBeLessThan(120)
    r.doc.parts[partKey(r.sw.id, "SW")] = { on: true }
    run(r, 1e-3)
    expect.soft(reading(r).current, "a short again draws amps").toBeGreaterThan(5)
  })

  it("is destroyed when it trips across more than its 15 V", () => {
    const r = start(bench(20, "1 mΩ"))
    expect(() => run(r, 0.5)).toThrow(/voltage/)
  })
})

describe("other MF-MSMF ratings from the table", () => {
  it("MF-MSMF010: holds 0.1 A, trips within 1.5 s at 0.5 A", () => {
    const hold = start(bench(5, `${5 / 0.1 - 0.7} Ω`, { model: "MF-MSMF010" }))
    expect.soft(run(hold, 20, tripped), "0.1 A").toBe(Infinity)
    const trip = start(bench(5, `${5 / 0.5 - 0.7 - 0.002} Ω`, { model: "MF-MSMF010" }))
    expect.soft(run(trip, 2, tripped), "0.5 A").toBeLessThanOrEqual(1.5 + 2 * DT)
  })
})
