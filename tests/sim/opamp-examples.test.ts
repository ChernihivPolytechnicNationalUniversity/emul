/**
 * The op amp examples run as a student opens them: the inverting amplifier's gain, its phase and
 * where it clips, and the flasher's period and its two LEDs taking turns.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { opampAmplifier, opampFlasher } from "@/schematic/examples/opamp"
import { partKey, pinKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { Engine } from "@/sim/engine"
import { SimLoop, type Probe, type Snapshot } from "@/sim/loop"
import { buildNetlist, GROUND } from "@/sim/netlist"
import { DT } from "@/sim/speeds"

const byRef = (doc: Schematic, ref: string) => doc.objects.find((o) => o.props?.ref === ref)!

function start(doc: Schematic, probes: Probe[] = []) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setProbes(probes)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number, each?: (snap: Snapshot) => void) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 10)
      loop.advance(clock)
      each?.(loop.snapshot()!)
    }
    return loop.snapshot()!
  }
  return { loop, run }
}

describe("Op amp inverting amplifier", () => {
  const doc = opampAmplifier.build(GRID)
  const g1 = byRef(doc, "G1")
  const u1 = byRef(doc, "U1")
  const probes: Probe[] = [
    { id: "in", a: pinKey(g1.id, "+"), b: pinKey(g1.id, "-") },
    { id: "out", a: pinKey(u1.id, "OUT"), b: null },
  ]
  // G1's 0.35 V RMS behind its 50 Ω into 10 kΩ to the virtual ground, 100 kΩ back.
  const peak = 0.35 * Math.SQRT2
  const gain = 100e3 / (10e3 + 50)

  it("puts out the input ×10 and inverted, IN− held at ground", () => {
    const { run } = start(doc, probes)
    let worst = 0
    let snap = run(0.05)
    snap = run(0.1, (s) => {
      worst = Math.max(worst, Math.abs(s.probes.out.v + 10 * s.probes.in.v))
    })
    // Fifty samples a cycle catch the crest within 3.6°.
    expect.soft((snap.probes.out.max - snap.probes.out.min) / 2, "peak").toBeNearRel(gain * peak * Math.cos(Math.PI / 50), 0.002)
    // The TL072's 3 mV of offset, times the noise gain 1 + 100 kΩ / 10.05 kΩ.
    expect.soft((snap.probes.out.max + snap.probes.out.min) / 2, "offset").toBeNear(3e-3 * (1 + gain), 2e-3)
    expect.soft(worst, "OUT against −10 × G1's terminals, sample by sample").toBeLessThan(0.05)
    const u = snap.readings.find((r) => r.object === u1.id && r.kind === "OPAMP")!
    expect.soft(Math.abs(Number.parseFloat(u.extra!["IN+ − IN−"])), "the virtual ground, in µV or mV").toBeLessThan(5)
  })

  it("turned up to 1.5 V RMS, clips about a volt and a half short of the ±12 V rails", () => {
    const { loop, run } = start(doc, probes)
    run(0.02)
    loop.setDoc({ ...doc, objects: doc.objects.map((o) => (o.id === g1.id ? { ...o, props: { ...o.props, value: "1.5 V" } } : o)) })
    const snap = run(0.1)
    // The TL072 stops 1.06 V short and sags 323 Ω × 1.2 mA more, into 10 kΩ and the feedback.
    expect.soft(snap.probes.out.max, "clipped high").toBeNear(10.56, 0.05)
    expect.soft(snap.probes.out.min, "clipped low").toBeNear(-10.56, 0.05)
    expect.soft(Object.keys(snap.damage), "nothing burns").toEqual([])
  })
})

describe("Op amp flasher", () => {
  const doc = opampFlasher.build(GRID)
  const u1 = byRef(doc, "U1")
  const led1 = byRef(doc, "LED1")
  const led2 = byRef(doc, "LED2")

  it("flips every R1 · C1 · ln 3, 0.516 s", () => {
    const e = new Engine(buildNetlist(doc))
    const out = (obj: PlacedObject) => {
      const net = e.net.pinNet.get(pinKey(obj.id, "OUT"))
      return net === undefined || net === GROUND ? 0 : e.v[net]
    }
    const flips: number[] = []
    let sign = 0
    for (let k = 0; k < Math.round(5 / DT); k++) {
      e.step(DT, () => ({}))
      const v = out(u1)
      if (Math.abs(v) > 5 && Math.sign(v) !== sign) {
        sign = Math.sign(v)
        flips.push(e.time)
      }
    }
    const half = (flips[flips.length - 1] - flips[1]) / (flips.length - 2)
    expect.soft(flips.length, "flips in 5 s").toBeGreaterThanOrEqual(10)
    expect.soft(half, "half-period").toBeNearRel(47e3 * 10e-6 * Math.log(3), 0.002)
  })

  it("lights LED1 and LED2 in turn, each within its rating, with U1 held at a rail", () => {
    const { run } = start(doc)
    const seen = new Set<string>()
    let held = 0
    const snap = run(4, (s) => {
      seen.add([led1, led2].map((led) => !!s.parts[partKey(led.id, "LED")]?.on).join(","))
      const u = s.readings.find((r) => r.object === u1.id && r.kind === "OPAMP")!
      if (u.extra?.Output.endsWith("held there by its positive feedback")) held++
    })
    expect.soft(seen.has("true,false") && seen.has("false,true"), "each LED on alone").toBe(true)
    expect.soft(held, "snapshots that find U1 latched").toBeGreaterThan(300)
    for (const led of [led1, led2]) {
      const r = snap.readings.find((x) => x.object === led.id && x.kind === "D")!
      expect.soft(r.load ?? 0, `${led.props?.ref} against its 20 mA`).toBeLessThan(0.5)
    }
    expect.soft(Object.keys(snap.damage), "nothing burns").toEqual([])
  })
})
