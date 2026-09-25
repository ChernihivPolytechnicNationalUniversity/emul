/**
 * The "System exam" schematic run headlessly through the same SimLoop the worker uses, against
 * the textbook answers.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { buildExam } from "@/schematic/exam"
import { partKey, pinKey, type PlacedObject } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

const { doc, parts } = buildExam(GRID)

const P = {
  zenerOut: { id: "zenerOut", a: pinKey(parts.zener.z.id, "2"), b: null },
  ampIn: { id: "ampIn", a: pinKey(parts.amp.q.id, "B"), b: null },
  ampOut: { id: "ampOut", a: pinKey(parts.amp.load.id, "1"), b: null },
  ampC: { id: "ampC", a: pinKey(parts.amp.q.id, "C"), b: null },
  ampE: { id: "ampE", a: pinKey(parts.amp.q.id, "E"), b: null },
  lpIn: { id: "lpIn", a: pinKey(parts.lowpass.r.id, "1"), b: null },
  lpOut: { id: "lpOut", a: pinKey(parts.lowpass.c.id, "1"), b: null },
  rlcC: { id: "rlcC", a: pinKey(parts.rlc.c.id, "1"), b: null },
  rectOut: { id: "rectOut", a: pinKey(parts.rectifier.load.id, "1"), b: null },
  mirrorLoad: { id: "mirrorLoad", a: pinKey(parts.mirror.load.id, "2"), b: null },
  clock: { id: "clock", a: pinKey(parts.mosfet.clock.id, "+"), b: null },
  nDrain: { id: "nDrain", a: pinKey(parts.mosfet.n.id, "D"), b: null },
}

const reading = (snap: Snapshot, o: PlacedObject, element = 0) => {
  const r = snap.readings.find((x) => x.object === o.id && x.element === element)
  if (!r) throw new Error(`no reading for ${o.props?.ref ?? o.id}`)
  return r
}

describe("system exam", () => {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setProbes(Object.values(P))
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
    }
  }
  let snap: Snapshot
  const probe = (p: { id: string }) => snap.probes[p.id]

  // Everything settles well inside a second: the slowest thing is the 10 µF coupling into
  // ~8 kΩ (τ ≈ 80 ms) and the rectifier's 1000 µF into 100 Ω (τ = 100 ms).
  beforeAll(() => {
    run(1.0)
    snap = loop.snapshot()!
  })

  it("Zener regulator", () => {
    expect.soft(probe(P.zenerOut).avg, "output voltage").toBeNearRel(5.1, 0.05)
    expect.soft(reading(snap, parts.zener.rs).current, "series current").toBeNearRel((12 - 5.1) / 470, 0.05)
    expect.soft(Math.abs(reading(snap, parts.zener.z).current), "zener current").toBeNearRel((12 - 5.1) / 470 - 5.1 / 1000, 0.08)
  })

  it("common-emitter amplifier", () => {
    const q = reading(snap, parts.amp.q)
    // Bias point from the Thevenin base network with Vbe ≈ 0.66 V at this current.
    const vth = (12 * 10) / 57
    const rth = (47e3 * 10e3) / 57e3
    const ib = (vth - 0.66) / (rth + 201 * 1e3)
    const ic = 200 * ib
    expect.soft(q.current, "collector current").toBeNearRel(ic, 0.05)
    expect.soft(probe(P.ampC).avg, "collector voltage").toBeNearRel(12 - ic * 2.2e3, 0.05)
    expect.soft(probe(P.ampE).avg, "emitter voltage").toBeNearRel(201 * ib * 1e3, 0.05)
    const vin = probe(P.ampIn)
    const vout = probe(P.ampOut)
    // Unbypassed emitter: |Av| = Rc ∥ RL / (Re + re), re = VT / Ic.
    const re = 0.025852 / ic
    const rcl = (2.2e3 * 10e3) / 12.2e3
    expect.soft((vout.max - vout.min) / (vin.max - vin.min), "voltage gain").toBeNearRel(rcl / (1e3 + re), 0.1)
    expect.soft(q.extra?.region, "region").toBe("active")
  })

  it("RC low-pass at fc", () => {
    const vin = probe(P.lpIn).rms
    const vout = probe(P.lpOut).rms
    expect.soft(vin, "input RMS").toBeNearRel(1, 0.02)
    expect.soft(vout / vin, "output / input at fc").toBeNearRel(Math.SQRT1_2, 0.05)
  })

  it("series RLC at resonance", () => {
    // Q = 10; the integrator's damping shows here.
    expect.soft(reading(snap, parts.rlc.r).rms!.current, "current at f0").toBeNearRel(1 / 10.1, 0.15)
    expect.soft(probe(P.rlcC).rms, "capacitor voltage (Q·Vin)").toBeNearRel(10 / 1.01, 0.15)
  })

  it("bridge rectifier", () => {
    const out = probe(P.rectOut)
    const iload = out.avg / 100
    // Less the winding drops under the charging peaks — a small transformer regulates poorly.
    expect.soft(out.max, "peak output").toBeNearRel(12 * Math.SQRT2 - 2 * 0.75, 0.1)
    // I/(2fC) is itself an estimate.
    expect.soft(out.max - out.min, "ripple").toBeNearRel(iload / (2 * 50 * 1000e-6), 0.3)
  })

  it("overload", () => {
    const r = parts.overload.r
    // A burnt-open part leaves the netlist altogether, so it has no reading and no current.
    expect.soft(snap.damage[r.id], "¼ W resistor at 1.44 W fails").toBeTruthy()
    expect.soft(snap.readings.find((x) => x.object === r.id)?.current ?? 0, "current after failure").toBeNear(0, 1e-9)
  })

  it("current mirror", () => {
    const wantRef = (12 - 0.66) / 10e3
    expect.soft(reading(snap, parts.mirror.rref).current, "reference current").toBeNearRel(wantRef, 0.05)
    expect.soft(reading(snap, parts.mirror.q2).current, "mirrored current").toBeNearRel((wantRef * 200) / 202, 0.05)
    expect.soft(12 - probe(P.mirrorLoad).avg, "load voltage").toBeNearRel((wantRef * 200 * 1e3) / 202, 0.05)
  })

  it("MOSFET switches", () => {
    const clk = probe(P.clock)
    expect.soft(clk.avg, "clock mean").toBeNearRel(2.5, 0.03)
    expect.soft(clk.rms, "clock RMS").toBeNearRel(5 * Math.SQRT1_2, 0.03)
    // On: Vgs = 5 V, k from Rds(on) = 22 mΩ at 8 V overdrive → ~59 mΩ at 3 V overdrive.
    const k = 1 / (2 * 0.022 * 8)
    const ron = 1 / (2 * k * 3)
    const ion = 12 / (100 + ron)
    const drain = probe(P.nDrain)
    expect.soft(drain.max, "N drain, off level").toBeNearRel(12, 0.01)
    expect.soft(drain.min, "N drain, on level").toBeNearRel(ion * ron, 0.1)
    expect.soft(drain.avg, "N drain mean (50 % duty)").toBeNearRel((12 + ion * ron) / 2, 0.02)
    expect.soft(reading(snap, parts.mosfet.n).rms!.current, "N drain current RMS").toBeNearRel(ion * Math.SQRT1_2, 0.03)
    const pRead = reading(snap, parts.mosfet.p)
    const kp = 1 / (2 * 0.117 * (10 - 3.7))
    const ronP = 1 / (2 * kp * (12 - 3.7))
    expect.soft(Math.abs(pRead.current), "P high-side current").toBeNearRel(12 / (100 + ronP), 0.02)
    expect.soft(pRead.extra?.region, "P region").toBe("ohmic")
  })

  it("LED behind a switch, open then closed", () => {
    expect.soft(reading(snap, parts.led.led).current, "current, switch open").toBeNear(0, 1e-9)
    loop.setParts({ [partKey(parts.led.sw.id, "SW")]: { on: true } })
    run(0.1)
    const lit = loop.snapshot()!
    expect.soft(reading(lit, parts.led.led).current, "current, switch closed").toBeNearRel((12 - 1.9) / 1000, 0.03)
    expect.soft(lit.parts[partKey(parts.led.led.id, "LED")]?.on, "lit").toBe(true)
  })
})
