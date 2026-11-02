import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { pinKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { Engine } from "@/sim/engine"
import { buildNetlist, GROUND } from "@/sim/netlist"
import { DT } from "@/sim/speeds"

/** A regulator fed `vin` from a stiff source, `load` (a resistor value, or "short") from OUT to ground. */
function bench(def: string, vin: number, load?: string, props: Record<string, string> = {}, en?: number) {
  const b = builder(GRID)
  const u = b.place(def, 20, 10, props)
  const gnd = b.place("ground", 0, 60)
  b.wire(u, "GND", gnd, "GND")
  const src = b.place("dc-source", 0, 10, { value: `${vin} V`, rint: "1 mΩ", imax: "100 A" })
  b.wire(src, "+", u, "IN")
  b.wire(src, "-", gnd, "GND")
  if (load === "short") {
    const r = b.place("resistor", 40, 20, { value: "1 mΩ", power: "100" })
    b.wire(u, "OUT", r, "1")
    b.wire(r, "2", gnd, "GND")
  } else if (load) {
    const r = b.place("resistor", 40, 20, { value: load, power: "100" })
    b.wire(u, "OUT", r, "1")
    b.wire(r, "2", gnd, "GND")
  }
  // The LP2985's ON/OFF floats off: tied to IN unless the test drives it.
  if (en === undefined && u.def === "lp2985") b.wire(src, "+", u, "EN")
  if (en !== undefined) {
    if (en === 0) b.wire(u, "EN", gnd, "GND")
    else {
      const s = b.place("dc-source", 0, 40, { value: `${en} V`, rint: "1 mΩ", imax: "1 A" })
      b.wire(s, "+", u, "EN")
      b.wire(s, "-", gnd, "GND")
    }
  }
  return { doc: b.doc, u, src }
}

function simulate(doc: Schematic, seconds = 2e-3) {
  const e = new Engine(buildNetlist(doc))
  const parts = (key: string) => doc.parts[key] ?? {}
  for (let k = 0; k < Math.round(seconds / DT); k++) e.step(DT, parts)
  return e
}

/** Failures seen on any step: a raw engine reports a failure on the step it happens. */
function damaged(doc: Schematic, seconds = 0.05) {
  const e = new Engine(buildNetlist(doc))
  const parts = (key: string) => doc.parts[key] ?? {}
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    e.step(DT, parts)
    if (e.failures.length) return e.failures.map((f) => f.damage.reason)
  }
  return []
}

const volts = (e: Engine, obj: PlacedObject, pin: string) => {
  const net = e.net.pinNet.get(pinKey(obj.id, pin))
  return net === undefined || net === GROUND ? 0 : e.v[net]
}
const drawn = (e: Engine, src: PlacedObject) => Math.abs(e.readings().find((r) => r.object === src.id && r.kind === "V")!.current)
const regulator = (e: Engine, u: PlacedObject) => e.readings().find((r) => r.object === u.id && r.kind === "REG")!

/** Output with `ohms` of load at `vin`. */
const out = (def: string, vin: number, load: string, props: Record<string, string> = {}) => {
  const { doc, u } = bench(def, vin, load, props)
  return volts(simulate(doc), u, "OUT")
}

describe("NCP1117 against onsemi NCP1117/D (typical, 25 °C)", () => {
  it("holds 5.000 V at 7 V in and 10 mA out (4.950–5.050 V)", () => {
    expect(out("ncp1117", 7, "500 Ω")).toBeNear(5, 0.05)
  })

  it.each(["1.5", "1.8", "2.0", "2.5", "3.3", "5.0", "12"])("comes as the fixed %s V part", (v) => {
    expect(out("ncp1117", Number(v) + 3, "1 kΩ", { vout: v })).toBeNear(Number(v), Number(v) * 0.01)
  })

  it("drops out 0.95 V short of its input at 100 mA and 1.07 V at 800 mA", () => {
    // 5.5 V in, so the output follows the input at the dropout.
    const at = (amps: number) => {
      const r = (5.5 - 1) / amps
      const v = out("ncp1117", 5.5, `${r} Ω`)
      return { v, amps: v / r }
    }
    const light = at(0.1)
    const heavy = at(0.8)
    expect.soft(5.5 - light.v, `dropout at ${light.amps.toFixed(3)} A`).toBeNear(0.95, 0.02)
    expect.soft(5.5 - heavy.v, `dropout at ${heavy.amps.toFixed(3)} A`).toBeNear(1.07, 0.02)
  })

  it.each(["1 Ω", "short"])("limits the current to 1.5 A into %s", (load) => {
    const { doc, u } = bench("ncp1117", 7, load)
    const e = simulate(doc)
    expect.soft(regulator(e, u).current, "output current").toBeNear(1.5, 0.05)
    expect.soft(regulator(e, u).extra?.mode).toBe("current limit")
  })

  it("draws 6 mA of its own at 15 V with no load", () => {
    const { doc, src } = bench("ncp1117", 15)
    expect(drawn(simulate(doc), src) * 1e3).toBeNear(6, 0.1)
  })

  it("is destroyed past 20 V on its input, and not at 20 V", () => {
    expect.soft(damaged(bench("ncp1117", 22, "1 kΩ").doc), "22 V").toEqual([expect.stringContaining("voltage")])
    expect.soft(damaged(bench("ncp1117", 19.9, "1 kΩ").doc), "19.9 V").toEqual([])
  })
})

/**
 * Thermal shutdown: the junction heads for 25 °C + P · RθJA with an assumed time constant (the data
 * sheets give none): NCP1117 160 °C/W (SOT-223, minimum pad), off at 175 °C, back at an assumed
 * 160 °C; LP2985 178.6 °C/W, off at 170 °C, back at 150 °C.
 */
describe("thermal shutdown (RθJA and thresholds from the data sheets, time constants assumed)", () => {
  /** Output volts, sampled every 10 ms for `seconds`. */
  const trace = (def: string, vin: number, load: string, seconds: number, en?: number) => {
    const { doc, u } = bench(def, vin, load, {}, en)
    const e = new Engine(buildNetlist(doc))
    const parts = (key: string) => doc.parts[key] ?? {}
    const out: number[] = []
    const every = Math.round(0.01 / DT)
    for (let k = 1; k <= Math.round(seconds / DT); k++) {
      e.step(DT, parts)
      if (k % every === 0) out.push(volts(e, u, "OUT"))
    }
    return { out, e, u }
  }

  it("an NCP1117-5.0 dropping 7 V at 300 mA (2.1 W, 361 °C if it could) shuts down after about 1.2 s", () => {
    const { out } = trace("ncp1117", 12, `${5 / 0.3} Ω`, 2)
    const first = out.findIndex((v) => v < 1)
    expect.soft(out[10], "at 0.1 s").toBeNear(5, 0.05)
    expect.soft(first * 0.01, "shut down at (s)").toBeGreaterThan(0.9)
    expect.soft(first * 0.01, "shut down at (s)").toBeLessThan(1.5)
  })

  it("and comes back once its junction has cooled 15 °C, cycling", () => {
    const { out } = trace("ncp1117", 12, `${5 / 0.3} Ω`, 4)
    const after = out.slice(out.findIndex((v) => v < 1))
    expect.soft(after.some((v) => v > 4.9), "on again").toBe(true)
    expect.soft(after.at(-1)! < 1 || after.at(-1)! > 4.9, "on or off, never between").toBe(true)
  })

  it("says so in its reading, with the junction temperature", () => {
    const { e, u } = trace("ncp1117", 12, `${5 / 0.3} Ω`, 1.3)
    const r = regulator(e, u)
    expect.soft(r.extra?.mode).toBe("thermal shutdown")
    expect.soft(Number.parseFloat(String(r.extra?.Tj)), "Tj (°C)").toBeGreaterThan(160)
  })

  it("an NCP1117 at 7 V and 100 mA (0.2 W, 57 °C) never shuts down", () => {
    const { out, e, u } = trace("ncp1117", 7, "50 Ω", 10)
    expect.soft(Math.min(...out), "lowest output").toBeGreaterThan(4.9)
    expect.soft(Number.parseFloat(String(regulator(e, u).extra?.Tj)), "Tj (°C)").toBeNear(25 + (0.2 + (7 * 7 * 6e-3) / 15) * 160, 1)
  })

  it("an LP2985-3.3 from 16 V at 100 mA (1.27 W) shuts down at 170 °C and is back at 150 °C", () => {
    const { out } = trace("lp2985", 16, "33 Ω", 3)
    const off = out.findIndex((v) => v < 1)
    expect.soft(off, "shuts down").toBeGreaterThan(0)
    expect.soft(out.slice(off).some((v) => v > 3.2), "back on").toBe(true)
  })

  it("an LP2985-3.3 from 5 V at 150 mA (0.26 W, 70 °C) runs on", () => {
    const { out } = trace("lp2985", 5, "22 Ω", 5)
    expect(Math.min(...out)).toBeGreaterThan(3.1)
  })
})

describe("LP2985 against TI SLVS522S (new chip, typical, 25 °C)", () => {
  it("holds 3.3 V at 4.3 V in and 1 mA out (±0.5 %)", () => {
    expect(out("lp2985", 4.3, "3.3 kΩ")).toBeNear(3.3, 3.3 * 0.005)
  })

  it.each(["1.8", "2.5", "2.8", "2.9", "3.0", "3.3", "5.0"])("comes as the fixed %s V part", (v) => {
    expect(out("lp2985", Number(v) + 1, "1 kΩ", { vout: v })).toBeNear(Number(v), Number(v) * 0.005)
  })

  it("drops out 120 mV at 50 mA and 180 mV at 150 mA", () => {
    const at = (amps: number) => {
      const r = (3.3 - 0.15) / amps
      return 3.3 - out("lp2985", 3.3, `${r} Ω`)
    }
    expect.soft(at(0.05) * 1e3, "50 mA").toBeNear(120, 5)
    expect.soft(at(0.15) * 1e3, "150 mA").toBeNear(180, 5)
  })

  it("delivers 375 mA into a short", () => {
    const { doc, u } = bench("lp2985", 5, "short")
    expect(regulator(simulate(doc), u).current * 1e3).toBeNear(375, 10)
  })

  it("draws 69 µA of its own with no load at 4.3 V", () => {
    const { doc, src } = bench("lp2985", 4.3, undefined, {}, 4.3)
    expect(drawn(simulate(doc), src) * 1e6).toBeNear(69, 2)
  })

  it("is off with ON/OFF low and on with it high: on above 0.85 V, off below 0.72 V", () => {
    const at = (en: number) => {
      const { doc, u } = bench("lp2985", 5, "1 kΩ", {}, en)
      return volts(simulate(doc), u, "OUT")
    }
    expect.soft(at(0), "ON/OFF grounded").toBeNear(0, 0.01)
    expect.soft(at(0.6), "0.6 V").toBeNear(0, 0.01)
    expect.soft(at(0.9), "0.9 V").toBeNear(3.3, 0.02)
    expect.soft(at(2), "2 V").toBeNear(3.3, 0.02)
  })

  it("draws 1.12 µA shut down", () => {
    const { doc, src } = bench("lp2985", 16, undefined, {}, 0)
    expect(drawn(simulate(doc), src) * 1e6).toBeNear(1.12, 0.05)
  })

  it("is destroyed past 18 V on its input, and not at 16 V", () => {
    expect.soft(damaged(bench("lp2985", 19, "1 kΩ", {}, 5).doc), "19 V").toEqual([expect.stringContaining("voltage")])
    expect.soft(damaged(bench("lp2985", 16, "1 kΩ", {}, 5).doc), "16 V").toEqual([])
  })
})
