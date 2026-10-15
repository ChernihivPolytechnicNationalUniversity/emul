import { describe, expect, it } from "vitest"
import { pinKey } from "@/schematic/types"
import type { BuzzerSnapshot } from "@/sim/buzzer"
import { SimLoop } from "@/sim/loop"
import { metronome } from "../lib/metronome-bench"

describe("Metronome V1 rev.B: three NE555s, a 74HC595 and the glue around them", () => {
  it("VR3 sets Q5's gate drive, not a smooth volume: silent below the 2N7000's 2.1 V threshold, rising over a short stretch, full once Q5 saturates and the 100 Ω limits the coil", () => {
    const at = (volume: string) => {
      const bench = metronome("0.5", "0.8", volume)
      const q5 = bench.doc.objects.find((o) => o.props?.ref === "Q5")!
      const loop = new SimLoop()
      loop.setDoc(bench.doc)
      loop.setParts(bench.doc.parts)
      loop.setProbes([{ id: "gate", a: pinKey(q5.id, "G"), b: null }])
      loop.setRunning(true)
      let clock = 0
      let gate = -Infinity
      let level = -Infinity
      loop.advance(clock)
      while (clock < 2500) {
        clock += 2
        loop.advance(clock)
        const snap = loop.snapshot()!
        gate = Math.max(gate, snap.probes.gate.max)
        level = Math.max(level, (snap.digital[bench.buzzer.id] as BuzzerSnapshot).level ?? -Infinity)
      }
      return { gate, level }
    }
    const full = at("1")
    expect.soft(full.gate, "VR3 at 1: TONE_OUT's high through 1 kΩ into 100 kΩ (V)").toBeGreaterThan(4)
    const half = at("0.5")
    expect.soft(half.gate / full.gate, "the gate follows VR3's position").toBeNear(0.5, 0.03)
    expect.soft(half.level, "VR3 at 0.5: the gate reaches only the threshold, silent").toBe(-Infinity)
    expect.soft(at("0.45").level, "VR3 at 0.45: silent").toBe(-Infinity)
    const sixTenths = at("0.6").level
    const sevenTenths = at("0.7").level
    const eightTenths = at("0.8").level
    expect.soft(sixTenths, "VR3 at 0.6: Q5 partly on, audible (dBA)").toBeGreaterThan(60)
    expect.soft(sevenTenths - sixTenths, "louder at 0.7 than 0.6 (dB)").toBeGreaterThan(5)
    expect.soft(eightTenths - sevenTenths, "louder at 0.8 than 0.7 (dB)").toBeGreaterThan(0.5)
    expect.soft(Math.abs(full.level - eightTenths), "no louder past 0.8: Q5 is saturated (dB)").toBeLessThan(1)
  })
})
