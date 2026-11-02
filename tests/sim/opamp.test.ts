/**
 * Op amps: every preset against its datasheet's typical figures at 25 °C — open-loop gain and
 * offset, the output's swing into the sheet's loads, its short-circuit current, the supply and
 * bias currents, the slew rate and the gain-bandwidth product — then the textbook circuits on
 * the generic part (inverting, non-inverting and summing gain, the integrator, the comparator,
 * the Schmitt trigger's thresholds and the astable's period, timed within the solver's step),
 * and what a bench does to them: too much supply, a supply the wrong way round, a shorted
 * output, an input driven past a rail.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { pinKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { Engine, type Reading } from "@/sim/engine"
import { buildNetlist, GROUND } from "@/sim/netlist"
import { DT } from "@/sim/speeds"

type Pin = [PlacedObject, string]

/** One op amp on its own supply: V+ at `vplus`, V− at `vminus`, both sources from ground through `rint`. */
function bench(part: string, vplus: number, vminus = 0, props: Record<string, string> = {}, rint = "1 mΩ") {
  const b = builder(GRID)
  const u = b.place(`opamp-${part}`, 20, 10, props)
  const gnd = b.place("ground", 0, 60)
  let row = 0
  const next = () => (row += 3)
  /** A stiff source from ground to `pin`, through `rint`; 0 V ties the pin to ground. */
  const source = (volts: number, pin: Pin, rint = "1 mΩ") => {
    if (volts === 0) {
      b.wire(pin[0], pin[1], gnd, "GND")
      return undefined
    }
    const s = b.place("dc-source", 60, next(), { value: `${Math.abs(volts)} V`, rint, imax: "100 A" })
    b.wire(s, volts > 0 ? "+" : "-", pin[0], pin[1])
    b.wire(s, volts > 0 ? "-" : "+", gnd, "GND")
    return s
  }
  const vp = source(vplus, [u, "V+"], rint)
  const vm = source(vminus, [u, "V-"], rint)
  const two = (def: string, props: Record<string, string>, a: Pin, c: Pin) => {
    const part = b.place(def, 40, next(), props)
    b.wire(a[0], a[1], part, "1")
    b.wire(part, "2", c[0], c[1])
    return part
  }
  const resistor = (value: string, a: Pin, c: Pin) => two("resistor", { value, power: "5" }, a, c)
  const ground: Pin = [gnd, "GND"]
  return { ...b, u, gnd, ground, vp, vm, source, two, resistor }
}

type Bench = ReturnType<typeof bench>

function simulate(doc: Schematic, seconds: number, each?: (e: Engine) => void) {
  const e = new Engine(buildNetlist(doc))
  const parts = (key: string) => doc.parts[key] ?? {}
  const steps = Math.round(seconds / DT)
  for (let k = 0; k < steps; k++) {
    e.step(DT, parts)
    each?.(e)
  }
  return e
}

const volts = (e: Engine, obj: PlacedObject, pin: string) => {
  const net = e.net.pinNet.get(pinKey(obj.id, pin))
  return net === undefined || net === GROUND ? 0 : e.v[net]
}
const amp = (e: Engine, b: Bench): Reading => e.readings().find((r) => r.object === b.u.id && r.kind === "OPAMP")!
/** Current the op amp's output pin delivers (negative: sinks). */
const output = (e: Engine, b: Bench) => amp(e, b).current
/** What a source delivers, by its own reading. */
const delivers = (e: Engine, source: PlacedObject | undefined) => Math.abs(e.readings().find((r) => r.object === source!.id && r.kind === "V")!.current)

/**
 * A follower's error at two inputs gives the open-loop gain and the offset: the output settles
 * where A·(VIN − VOUT + VOS) = VOUT − VMID, so the error changes by ΔVIN / (1 + A) and is
 * VOS·A / (1 + A) at mid-supply.
 */
function gainAndOffset(part: string, vplus: number, vminus: number, inputs: [number, number]) {
  const mid = (vplus + vminus) / 2
  const errors = inputs.map((vin) => {
    const b = bench(part, vplus, vminus)
    b.source(vin, [b.u, "IN+"])
    b.wire(b.u, "OUT", b.u, "IN-")
    const e = simulate(b.doc, 0.2)
    return volts(e, b.u, "OUT") - volts(e, b.u, "IN+")
  })
  const gain = (inputs[1] - inputs[0]) / (errors[0] - errors[1]) - 1
  return { gain, vos: (errors[0] * (1 + gain) + inputs[0] - mid) / gain }
}

/** An open-loop amplifier driven to a rail by 1 V of drive, loaded by `load` to `to` volts. */
function railed(part: string, vplus: number, vminus: number, high: boolean, load: string, to = 0) {
  const b = bench(part, vplus, vminus)
  const mid = (vplus + vminus) / 2
  b.source(high ? mid + 0.5 : mid - 0.5, [b.u, "IN+"])
  b.source(high ? mid - 0.5 : mid + 0.5, [b.u, "IN-"])
  const target = b.source(to, [b.place("junction", 50, 50), "J"])
  b.resistor(load, [b.u, "OUT"], target ? [target, to > 0 ? "+" : "-"] : b.ground)
  const e = simulate(b.doc, 2e-3)
  return { e, b, out: volts(e, b.u, "OUT") }
}

/** An open-loop amplifier driven to a rail, its output tied straight to `to` volts. */
function shorted(part: string, vplus: number, vminus: number, high: boolean, to = 0) {
  const b = bench(part, vplus, vminus)
  const mid = (vplus + vminus) / 2
  b.source(high ? mid + 0.5 : mid - 0.5, [b.u, "IN+"])
  b.source(high ? mid - 0.5 : mid + 0.5, [b.u, "IN-"])
  b.source(to, [b.u, "OUT"])
  const e = simulate(b.doc, 2e-3)
  return { e, b, amps: output(e, b) }
}

/** Supply current of a follower held at mid-supply with nothing on its output. */
function quiescent(part: string, vplus: number, vminus = 0) {
  const b = bench(part, vplus, vminus)
  b.source((vplus + vminus) / 2, [b.u, "IN+"])
  b.wire(b.u, "OUT", b.u, "IN-")
  return delivers(simulate(b.doc, 2e-3), b.vp)
}

/** A follower fed a ±10 V square: the output, step by step, after the falling edge at 0.5 ms. */
function slewing(part: string) {
  const b = bench(part, 15, -15)
  const p = b.place("pulse-source", 0, 0, { high: "10 V", low: "-10 V", freq: "1 kHz", duty: "50", rint: "1 mΩ" })
  b.wire(p, "+", b.u, "IN+")
  b.wire(p, "-", b.gnd, "GND")
  b.wire(b.u, "OUT", b.u, "IN-")
  const out: number[] = []
  simulate(b.doc, 0.62e-3, (e) => {
    if (e.time > 0.47e-3) out.push(volts(e, b.u, "OUT"))
  })
  return out
}

describe("LM358 against TI SLOS068AB (typical, 25 °C)", () => {
  it("has 100 V/mV of open-loop gain and 2 mV of offset", () => {
    const { gain, vos } = gainAndOffset("lm358", 15, 0, [4, 9])
    expect.soft(gain, "AOL").toBeNearRel(100e3, 0.01)
    expect.soft(vos * 1e3, "VOS (mV)").toBeNear(2, 0.01)
  })

  it("stops 1.5 V short of V+ into 2 kΩ at 5 V, and 5 mV above V− into 10 kΩ", () => {
    expect.soft(5 - railed("lm358", 5, 0, true, "2 kΩ").out, "from V+").toBeNear(1.5, 0.02)
    expect.soft(railed("lm358", 5, 0, false, "10 kΩ").out * 1e3, "from V− (mV)").toBeNear(5, 0.5)
  })

  it("at 30 V into 10 kΩ stays under the table's 3 V from V+", () => {
    const drop = 30 - railed("lm358", 30, 0, true, "10 kΩ").out
    expect.soft(drop, "from V+").toBeLessThan(3)
    expect.soft(drop, "from V+").toBeGreaterThan(1.4)
  })

  it("sources 30 mA into V− and sinks 20 mA from V+ at 15 V", () => {
    expect.soft(shorted("lm358", 15, 0, true, 0).amps * 1e3, "source (mA)").toBeNear(30, 0.01)
    expect.soft(shorted("lm358", 15, 0, false, 15).amps * 1e3, "sink (mA)").toBeNear(-20, 0.01)
  })

  it("draws 350 µA at 5 V and 500 µA at 30 V per amplifier", () => {
    expect.soft(quiescent("lm358", 5) * 1e6, "5 V (µA)").toBeNearRel(350, 0.01)
    expect.soft(quiescent("lm358", 30) * 1e6, "30 V (µA)").toBeNearRel(500, 0.01)
  })

  it("pushes 20 nA out of its PNP inputs", () => {
    const b = bench("lm358", 15, 0)
    b.resistor("1 MΩ", [b.u, "IN+"], b.ground)
    b.wire(b.u, "OUT", b.u, "IN-")
    const e = simulate(b.doc, 2e-3)
    expect(volts(e, b.u, "IN+") * 1e3, "1 MΩ to ground (mV)").toBeNear(20, 0.01)
  })

  it("slews at 0.3 V/µs: 6 V a step", () => {
    const out = slewing("lm358")
    const moves = out.slice(1).map((v, k) => v - out[k]).filter((d) => Math.abs(d) > 1)
    expect.soft(moves.length, "steps it took to fall 20 V").toBe(4)
    for (const d of moves.slice(0, 3)) expect.soft(d, "fall per 20 µs").toBeNear(-6, 1e-6)
    expect.soft(out[out.length - 1], "settles on the input").toBeNear(-10 + 2e-3, 1e-3)
  })

  it("has 0.7 MHz of gain-bandwidth: at a gain of 1000 it is 3 dB down at 700 Hz", () => {
    const ac = (freq: number) => {
      const b = bench("lm358", 15, -15)
      const s = b.place("ac-source", 0, 0, { value: "3.5355 mV", freq: `${freq} Hz`, rint: "1 mΩ" })
      b.wire(s, "-", b.gnd, "GND")
      b.resistor("1 kΩ", [s, "+"], [b.u, "IN-"])
      b.resistor("1 MΩ", [b.u, "OUT"], [b.u, "IN-"])
      b.wire(b.u, "IN+", b.gnd, "GND")
      let n = 0
      let sum = 0
      let sum2 = 0
      simulate(b.doc, 0.2, (e) => {
        if (e.time < 0.1) return
        const v = volts(e, b.u, "OUT")
        n++
        sum += v
        sum2 += v * v
      })
      return Math.sqrt(sum2 / n - (sum / n) ** 2)
    }
    const corner = 0.7e6 / 1001
    const flat = ac(corner / 10)
    expect.soft(flat, "a decade below, ×1000 less the pole's 0.5 %").toBeNearRel(2.5 * Math.SQRT2 / Math.sqrt(1.01), 0.01)
    // Backward Euler takes 2.6 % off the response at the corner, 14 steps a cycle.
    expect.soft(ac(corner) / flat, "at the corner").toBeNearRel(Math.sqrt(1.01 / 2), 0.04)
  })

  it("says so when an input leaves its common-mode range, V− to V+ − 1.5 V", () => {
    const b = bench("lm358", 5, 0)
    b.source(4, [b.u, "IN+"])
    b.wire(b.u, "OUT", b.u, "IN-")
    const e = simulate(b.doc, 2e-3)
    // IN− follows the output to its 3.6 V swing, outside as well.
    expect(amp(e, b).extra?.Inputs).toBe("IN+, IN− outside the common-mode range, V− to V+ − 1.50 V")
  })
})

describe("LM741 against TI SNOSC25D (LM741C at ±15 V)", () => {
  it("has 200 V/mV of open-loop gain and 2 mV of offset", () => {
    const { gain, vos } = gainAndOffset("lm741", 15, -15, [-5, 5])
    expect.soft(gain, "AOL").toBeNearRel(200e3, 0.01)
    expect.soft(vos * 1e3, "VOS (mV)").toBeNear(2, 0.01)
  })

  it.each([
    ["10 kΩ", 14],
    ["2 kΩ", 13],
  ] as const)("swings ±%s → ±%d V", (load, swing) => {
    expect.soft(railed("lm741", 15, -15, true, load).out, "high").toBeNear(swing, 0.02)
    expect.soft(railed("lm741", 15, -15, false, load).out, "low").toBeNear(-swing, 0.02)
  })

  it("delivers 25 mA into a short either way", () => {
    expect.soft(shorted("lm741", 15, -15, true).amps * 1e3, "sourcing (mA)").toBeNear(25, 0.01)
    expect.soft(shorted("lm741", 15, -15, false).amps * 1e3, "sinking (mA)").toBeNear(-25, 0.01)
  })

  it("draws 1.7 mA", () => {
    expect(quiescent("lm741", 15, -15) * 1e3).toBeNearRel(1.7, 0.01)
  })

  it("takes 80 nA into its NPN inputs and has 2 MΩ between them", () => {
    const b = bench("lm741", 15, -15)
    b.resistor("1 MΩ", [b.u, "IN+"], b.ground)
    b.wire(b.u, "OUT", b.u, "IN-")
    const e = simulate(b.doc, 2e-3)
    // The offset across the 2 MΩ between the inputs feeds 1 nA of the 80 into IN+ from IN−.
    expect.soft(volts(e, b.u, "IN+") * 1e3, "1 MΩ from ground (mV)").toBeNear(-80 + 1, 0.01)
    const open = bench("lm741", 15, -15)
    const s = open.source(1, [open.u, "IN+"])
    open.source(0, [open.u, "IN-"])
    expect.soft(delivers(simulate(open.doc, 2e-3), s) * 1e9, "1 V across the inputs (nA)").toBeNear(500 + 80, 1)
  })

  it("slews at 0.5 V/µs: 10 V a step", () => {
    const out = slewing("lm741")
    const moves = out.slice(1).map((v, k) => v - out[k]).filter((d) => Math.abs(d) > 1)
    // Less the 5 µA its own 2 MΩ input draws through its 196 Ω while it is 10 V from the input.
    expect.soft(moves[0], "the first step, slewing").toBeNear(-10 - 196 * 5e-6, 1e-6)
    // The rest is the closed loop's single pole, 2π · 1 MHz · 20 µs = 126 to 1 a step: 80 mV short of it.
    expect.soft(moves[1], "the second, settling").toBeNear(-10 * (1 - 1 / (1 + 2 * Math.PI * 1e6 * DT)), 2e-3)
  })
})

describe("TL072 against TI SLOS080W (TL07xC at ±15 V)", () => {
  it("has 200 V/mV of open-loop gain and 3 mV of offset", () => {
    const { gain, vos } = gainAndOffset("tl072", 15, -15, [-5, 5])
    expect.soft(gain, "AOL").toBeNearRel(200e3, 0.01)
    expect.soft(vos * 1e3, "VOS (mV)").toBeNear(3, 0.01)
  })

  it.each([
    ["10 kΩ", 13.5],
    ["2 kΩ", 12],
  ] as const)("swings ±%s → ±%d V", (load, swing) => {
    expect.soft(railed("tl072", 15, -15, true, load).out, "high").toBeNear(swing, 0.02)
    expect.soft(railed("tl072", 15, -15, false, load).out, "low").toBeNear(-swing, 0.02)
  })

  it("delivers 26 mA into a short, draws 1.4 mA and takes picoamps at its inputs", () => {
    expect.soft(shorted("tl072", 15, -15, true).amps * 1e3, "short (mA)").toBeNear(26, 0.01)
    expect.soft(quiescent("tl072", 15, -15) * 1e3, "IQ (mA)").toBeNearRel(1.4, 0.01)
    const b = bench("tl072", 15, -15)
    b.resistor("1 MΩ", [b.u, "IN+"], b.ground)
    b.wire(b.u, "OUT", b.u, "IN-")
    expect.soft(volts(simulate(b.doc, 2e-3), b.u, "IN+") * 1e6, "1 MΩ from ground (µV)").toBeNear(-65, 1)
  })

  it("slews 20 V/µs: a 20 V step is through within one step", () => {
    const out = slewing("tl072")
    const moves = out.slice(1).map((v, k) => v - out[k]).filter((d) => Math.abs(d) > 1)
    expect(moves.length).toBe(1)
  })
})

describe("MCP6002 against Microchip DS20001733L", () => {
  it("has 112 dB of open-loop gain", () => {
    expect(gainAndOffset("mcp6002", 5.5, 0, [2, 3.5]).gain).toBeNearRel(398e3, 0.01)
  })

  it("comes within 25 mV of either rail into 10 kΩ to VDD / 2 at 5.5 V", () => {
    const high = railed("mcp6002", 5.5, 0, true, "10 kΩ", 2.75).out
    const low = railed("mcp6002", 5.5, 0, false, "10 kΩ", 2.75).out
    expect.soft(5.5 - high, "from VDD").toBeLessThan(0.025)
    expect.soft(low, "from VSS").toBeLessThan(0.025)
    expect.soft(5.5 - high, "from VDD").toBeGreaterThan(0.01)
  })

  it.each([
    [1.8, 6],
    [5.5, 23],
  ] as const)("at %d V delivers ±%d mA into a short", (vdd, ma) => {
    expect.soft(shorted("mcp6002", vdd, 0, true, 0).amps * 1e3, "source").toBeNear(ma, 0.01)
    expect.soft(shorted("mcp6002", vdd, 0, false, vdd).amps * 1e3, "sink").toBeNear(-ma, 0.01)
  })

  it("draws 100 µA", () => {
    expect(quiescent("mcp6002", 5.5) * 1e6).toBeNearRel(100, 0.01)
  })

  it("takes its inputs 0.3 V past either rail without a word, and reports 1 V past", () => {
    const at = (vin: number) => {
      const b = bench("mcp6002", 5, 0)
      b.source(vin, [b.u, "IN+"], "10 kΩ")
      b.wire(b.u, "OUT", b.u, "IN-")
      const e = simulate(b.doc, 2e-3)
      return { inputs: amp(e, b).extra?.Inputs, out: volts(e, b.u, "OUT") }
    }
    expect.soft(at(5.25).inputs, "0.25 V above VDD").toBeUndefined()
    expect.soft(at(5.25).out, "the output at the rail").toBeNear(5, 1e-3)
    expect.soft(at(6.5).inputs, "1.5 V above VDD").toBe("IN+ past the absolute maximum")
  })
})

describe("the generic op amp in the textbook circuits, on ±15 V", () => {
  function inverting(vin: number, rin: string, rf: string, props: Record<string, string> = {}) {
    const b = bench("generic", 15, -15, props)
    const s = b.place("dc-source", 0, 0, { value: `${vin} V`, rint: "1 mΩ" })
    b.wire(s, "-", b.gnd, "GND")
    b.resistor(rin, [s, "+"], [b.u, "IN-"])
    b.resistor(rf, [b.u, "OUT"], [b.u, "IN-"])
    b.wire(b.u, "IN+", b.gnd, "GND")
    const e = simulate(b.doc, 1e-3)
    return { e, b, out: volts(e, b.u, "OUT") }
  }

  it("inverts with a gain of −Rf / Rin, holding IN− at a virtual ground", () => {
    const { e, b, out } = inverting(1, "1 kΩ", "10 kΩ")
    expect.soft(out).toBeNearRel(-10, 1e-4)
    expect.soft(Math.abs(volts(e, b.u, "IN-")) * 1e6, "IN− (µV)").toBeLessThan(20)
    expect.soft(amp(e, b).extra?.Output).toBe("linear")
  })

  it("clips at the rails when asked for more", () => {
    const { e, b, out } = inverting(2, "1 kΩ", "10 kΩ")
    expect.soft(out, "rail to rail, less 10 Ω × 1.6 mA").toBeNear(-15 + 0.016, 0.002)
    expect.soft(amp(e, b).extra?.Output).toBe("saturated low")
  })

  it("amplifies by 1 + Rf / Rg without inverting, and follows at 1", () => {
    const b = bench("generic", 15, -15)
    b.source(0.5, [b.u, "IN+"])
    b.resistor("9 kΩ", [b.u, "OUT"], [b.u, "IN-"])
    b.resistor("1 kΩ", [b.u, "IN-"], b.ground)
    expect.soft(volts(simulate(b.doc, 1e-3), b.u, "OUT")).toBeNearRel(5, 1e-4)
    const f = bench("generic", 15, -15)
    f.source(3.3, [f.u, "IN+"])
    f.wire(f.u, "OUT", f.u, "IN-")
    expect.soft(volts(simulate(f.doc, 1e-3), f.u, "OUT")).toBeNearRel(3.3, 1e-5)
  })

  it("sums: −(V1 + V2) through equal resistors", () => {
    const b = bench("generic", 15, -15)
    for (const vin of [1.5, 2.25]) {
      const s = b.place("dc-source", 0, vin * 4, { value: `${vin} V`, rint: "1 mΩ" })
      b.wire(s, "-", b.gnd, "GND")
      b.resistor("10 kΩ", [s, "+"], [b.u, "IN-"])
    }
    b.resistor("10 kΩ", [b.u, "OUT"], [b.u, "IN-"])
    b.wire(b.u, "IN+", b.gnd, "GND")
    expect(volts(simulate(b.doc, 1e-3), b.u, "OUT")).toBeNearRel(-3.75, 1e-4)
  })

  it("integrates: 1 V into 10 kΩ ramps 100 nF at 1000 V/s until the rail", () => {
    const b = bench("generic", 15, -15)
    const s = b.source(1, [b.place("junction", 50, 50), "J"])!
    b.resistor("10 kΩ", [s, "+"], [b.u, "IN-"])
    b.two("capacitor", { value: "100 nF", vmax: "50 V" }, [b.u, "IN-"], [b.u, "OUT"])
    b.wire(b.u, "IN+", b.gnd, "GND")
    const at: Record<string, number> = {}
    simulate(b.doc, 20e-3, (e) => {
      const ms = Math.round(e.time * 1e5) / 100
      if (ms === 2 || ms === 7 || ms === 20) at[ms] = volts(e, b.u, "OUT")
    })
    expect.soft((at[7] - at[2]) / 5e-3, "slope (V/s)").toBeNearRel(-1000, 1e-3)
    expect.soft(at[20], "at the rail").toBeNear(-15, 0.01)
  })

  it("open loop, moves at 2π · GBW per volt of drive: 1 mV at 1 MHz is 0.126 V a step", () => {
    const b = bench("generic", 15, -15, { gbw: "1 MHz" })
    b.source(1e-3, [b.u, "IN+"])
    b.wire(b.u, "IN-", b.gnd, "GND")
    const out: number[] = []
    simulate(b.doc, 0.1e-3, (e) => out.push(volts(e, b.u, "OUT")))
    // Each step adds k = 2π · GBW · dt times the drive, and leaks k / gain of where it stands towards mid-supply.
    const k = 2 * Math.PI * 1e6 * DT
    for (let n = 1; n < 5; n++) expect.soft(out[n] - out[n - 1], `step ${n}`).toBeNearRel((k * 1e-3 - (k / 1e6) * out[n - 1]) / (1 + k / 1e6), 1e-6)
    expect.soft(out[1] - out[0], "0.126 V").toBeNearRel(0.1257, 1e-3)
  })

  it("compares: the output takes the rail of whichever input is higher", () => {
    for (const [a, c, rail] of [
      [1, 1.1, -15],
      [1.1, 1, 15],
    ] as const) {
      const b = bench("generic", 15, -15)
      b.source(a, [b.u, "IN+"])
      b.source(c, [b.u, "IN-"])
      expect.soft(volts(simulate(b.doc, 1e-3), b.u, "OUT"), `IN+ ${a} V, IN− ${c} V`).toBeNear(rail, 1e-3)
    }
  })

  it("as a Schmitt trigger, flips where the input crosses ±β · 15 V", () => {
    const b = bench("generic", 15, -15)
    b.resistor("10 kΩ", [b.u, "OUT"], [b.u, "IN+"])
    b.resistor("10 kΩ", [b.u, "IN+"], b.ground)
    const s = b.place("ac-source", 0, 0, { value: "7.0711 V", freq: "10 Hz", rint: "1 mΩ" })
    b.wire(s, "+", b.u, "IN-")
    b.wire(s, "-", b.gnd, "GND")
    const flips: number[] = []
    let high: boolean | undefined
    let before = 0
    simulate(b.doc, 0.3, (e) => {
      const out = volts(e, b.u, "OUT")
      const vin = volts(e, b.u, "IN-")
      if (Math.abs(out) > 10 && out > 10 !== high) {
        // The first is the power-up: from 0 V it tips whichever way the input starts.
        if (high !== undefined) flips.push(Math.abs(vin) < Math.abs(before) ? before : vin)
        high = out > 10
      }
      before = vin
    })
    // It tips low at power-up, so the first crossing it answers is at −7.5 V, 63.5 ms in.
    expect.soft(flips.length, "two flips a cycle").toBe(5)
    // An input moving 12.6 mV a step: the flip is between the steps either side of the threshold.
    for (const v of flips) expect.soft(Math.abs(v), "threshold").toBeNear(7.5, 0.013)
  })

  /** The astable: R from OUT to IN− with C to ground, half the output fed back to IN+. */
  function astable(props: Record<string, string>, r: string, c: string, seconds: number) {
    const b = bench("generic", 15, -15, props)
    b.resistor("10 kΩ", [b.u, "OUT"], [b.u, "IN+"])
    b.resistor("10 kΩ", [b.u, "IN+"], b.ground)
    b.resistor(r, [b.u, "OUT"], [b.u, "IN-"])
    b.two("capacitor", { value: c, vmax: "100 V" }, [b.u, "IN-"], b.ground)
    const flips: number[] = []
    let sign = 0
    const e = simulate(b.doc, seconds, (e) => {
      const out = volts(e, b.u, "OUT")
      if (Math.abs(out) > 10 && Math.sign(out) !== sign) {
        sign = Math.sign(out)
        flips.push(e.time)
      }
    })
    return { e, b, flips, half: (flips[flips.length - 1] - flips[2]) / (flips.length - 3) }
  }

  it("as an astable, starts from rest and swings every R·C·ln 3, timed within the step", () => {
    // 10 kΩ · 10 nF · ln 3 = 109.86 µs, 5.49 steps: a flip only at a step's end would make it 100 or 120 µs.
    const { flips, half } = astable({ slew: "1000 V/µs" }, "10 kΩ", "10 nF", 0.05)
    expect.soft(flips[0], "tips over at once, with nothing to break the balance").toBeLessThan(2 * DT)
    expect.soft(flips.length, "half-periods in 50 ms").toBeGreaterThan(450)
    expect.soft(half, "half-period").toBeNearRel(10e3 * 10e-9 * Math.log(3), 0.002)
  })

  it("at its 10 V/µs the 3 µs swing between the rails lengthens each half by under that", () => {
    const { half } = astable({}, "10 kΩ", "10 nF", 0.05)
    const textbook = 10e3 * 10e-9 * Math.log(3)
    expect.soft(half - textbook, "longer").toBeGreaterThan(0)
    expect.soft(half - textbook, "but by less than the swing takes").toBeLessThan(3e-6)
  })

  it("says it is held at a rail by its own positive feedback", () => {
    const { e, b } = astable({}, "100 kΩ", "1 µF", 0.02)
    expect(amp(e, b).extra?.Output).toMatch(/^saturated (high|low), held there by its positive feedback$/)
  })

  it("takes its figures from the inspector: offset, current limit, swing", () => {
    const f = bench("generic", 15, -15, { vos: "5 mV" })
    f.source(1, [f.u, "IN+"])
    f.wire(f.u, "OUT", f.u, "IN-")
    expect.soft(volts(simulate(f.doc, 1e-3), f.u, "OUT") - 1, "offset").toBeNear(5e-3, 1e-5)
    const s = bench("generic", 15, -15, { isc: "10 mA" })
    s.source(1, [s.u, "IN+"])
    s.wire(s.u, "IN-", s.gnd, "GND")
    s.wire(s.u, "OUT", s.gnd, "GND")
    expect.soft(output(simulate(s.doc, 1e-3), s) * 1e3, "limit (mA)").toBeNear(10, 1e-6)
    const r = bench("generic", 15, -15, { rail: "1.5 V" })
    r.source(1, [r.u, "IN+"])
    r.wire(r.u, "IN-", r.gnd, "GND")
    expect.soft(volts(simulate(r.doc, 1e-3), r.u, "OUT"), "swing").toBeNear(13.5, 1e-3)
  })

  it("without a supply its output lets go", () => {
    const b = bench("generic", 0, 0)
    b.source(1, [b.u, "IN+"])
    b.wire(b.u, "IN-", b.gnd, "GND")
    const s = b.source(5, [b.place("junction", 50, 50), "J"])!
    b.resistor("10 kΩ", [s, "+"], [b.u, "OUT"])
    const e = simulate(b.doc, 1e-3)
    expect.soft(volts(e, b.u, "OUT"), "pulled up through 10 kΩ, but for the solver's 0.1 nS node leak").toBeNear(5, 1e-5)
    expect.soft(amp(e, b).extra?.Output).toBe("no supply")
  })
})

describe("op amps on the bench", () => {
  const damaged = (doc: Schematic, seconds: number) => {
    const e = new Engine(buildNetlist(doc))
    const parts = (key: string) => doc.parts[key] ?? {}
    for (let k = 0; k < Math.round(seconds / DT); k++) {
      e.step(DT, parts)
      if (e.failures.length) return e.failures
    }
    return []
  }

  it("an LM358 on 36 V is destroyed, its die shorting the supply", () => {
    const b = bench("lm358", 36, 0)
    b.wire(b.u, "IN+", b.gnd, "GND")
    b.wire(b.u, "OUT", b.u, "IN-")
    const failures = damaged(b.doc, 1e-3)
    expect.soft(failures.map((f) => f.object)).toEqual([b.u.id])
    expect.soft(failures[0]?.damage).toMatchObject({ element: 0, fail: "short", reason: "voltage 36.00 V exceeds the 32.00 V rating" })
  })

  it("a supply connected the wrong way round burns through the substrate diode", () => {
    const b = bench("lm358", -9, 0, {}, "10 Ω")
    const failures = damaged(b.doc, 0.1)
    expect.soft(failures.map((f) => f.object)).toEqual([b.u.id])
    expect.soft(failures[0]?.damage.fail).toBe("short")
    expect.soft(failures[0]?.damage.reason).toMatch(/^current .* exceeds the 50\.00 mA rating$/)
  })

  it("the generic op amp's supply rating comes from the inspector", () => {
    const b = bench("generic", 15, -15, { vmax: "24 V" })
    b.wire(b.u, "IN+", b.gnd, "GND")
    b.wire(b.u, "OUT", b.u, "IN-")
    expect(damaged(b.doc, 1e-3)[0]?.damage.reason).toBe("voltage 30.00 V exceeds the 24.00 V rating")
  })

  it.each([
    ["lm741", 15, -15],
    ["lm358", 30, 0],
    ["tl072", 15, -15],
  ] as const)("an %s survives its output shorted to ground for three seconds", (part, vplus, vminus) => {
    const { b } = shorted(part, vplus, vminus, true, 0)
    expect(damaged(b.doc, 3)).toEqual([])
  })

  it("an MCP6002 input pulled 5 V below VSS: through 10 kΩ its diode holds, through 100 Ω it burns", () => {
    const pulled = (r: string) => {
      const b = bench("mcp6002", 5, 0)
      const s = b.source(-5, [b.place("junction", 50, 50), "J"])!
      b.resistor(r, [s, "-"], [b.u, "IN+"])
      b.wire(b.u, "OUT", b.u, "IN-")
      return damaged(b.doc, 0.2)
    }
    expect.soft(pulled("10 kΩ")).toEqual([])
    const burnt = pulled("100 Ω")
    expect.soft(burnt[0]?.damage.element, "the IN+ protection diode").toBe(2)
    expect.soft(burnt[0]?.damage.reason).toMatch(/^current .* exceeds the 2\.00 mA rating$/)
  })

  it("an MCP6002 warns above 6 V and is destroyed past 7 V", () => {
    const at = (vdd: number) => {
      const b = bench("mcp6002", vdd, 0)
      b.source(vdd / 2, [b.u, "IN+"])
      b.wire(b.u, "OUT", b.u, "IN-")
      return { b, failures: damaged(b.doc, 1e-3), e: simulate(b.doc, 1e-3) }
    }
    const warm = at(6.5)
    expect.soft(warm.failures).toEqual([])
    expect.soft(amp(warm.e, warm.b).extra?.Supply).toBe("above the 6.00 V maximum")
    expect.soft(at(7.5).failures[0]?.damage.reason).toBe("voltage 7.50 V exceeds the 7.00 V rating")
  })
})
