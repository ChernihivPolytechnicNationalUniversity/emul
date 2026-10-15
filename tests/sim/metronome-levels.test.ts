import { describe, expect, it } from "vitest"
import { pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { metronome } from "../lib/metronome-bench"

describe("Metronome V1 rev.B: three NE555s, a 74HC595 and the glue around them", () => {
  it("holds the levels the schematic annotates: BT ≈ 4.74 V, TEMPO_OUT high ≈ 4.4 V over the 74HC595's VIH, PULSE_TRIGGER resting at 3.26 V and dipping under TRIG's third of VCC", () => {
    const bench = metronome()
    const loop = new SimLoop()
    loop.setDoc(bench.doc)
    loop.setParts(bench.doc.parts)
    loop.setRunning(true)
    const probes = [
      { id: "tempo", a: pinKey(bench.u1.id, "OUT"), b: null },
      { id: "trigger", a: pinKey(bench.u2.id, "TRIG"), b: null },
    ]
    let clock = 0
    loop.advance(clock)
    const battery: number[] = []
    const vcc: number[] = []
    const resting: number[] = []
    while (clock < 4000) {
      clock += 1
      loop.advance(clock)
      if (clock === 1000) loop.setProbes(probes)
      if (clock <= 1000) continue
      const snap = loop.snapshot()!
      battery.push(snap.pinVoltage[pinKey(bench.bat.id, "+")])
      vcc.push(snap.pinVoltage[pinKey(bench.u4.id, "VCC")])
      resting.push(snap.pinVoltage[pinKey(bench.u2.id, "TRIG")])
    }
    const snap = loop.snapshot()!
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
    const supply = median(vcc)
    expect.soft(median(battery), "BT_POS, three fresh alkaline cells under the metronome's load (V)").toBeNearRel(4.74, 0.02)
    expect.soft(snap.probes.tempo.max, "TEMPO_OUT high through R_TEMPO_PULLUP (V)").toBeNear(4.4, 0.1)
    expect.soft(snap.probes.tempo.max, "…over the 74HC595's VIH, 0.7 VCC (V)").toBeGreaterThan(0.7 * supply)
    expect.soft(median(resting), "PULSE_TRIGGER at rest, 10 k up and 22 k down (V)").toBeNear(3.26, 0.1)
    expect.soft(snap.probes.trigger.min, "…dips under TRIG's VCC / 3 on each beat (V)").toBeLessThan(supply / 3)
    expect.soft(snap.probes.trigger.min, "…no lower than D_TRIGGER_LOW lets it (V)").toBeGreaterThan(-0.75)
  })

  it("lights each LED for U2's ≈ 52 ms beat pulse, the current well inside the 74HC595's output rating", () => {
    const bench = metronome()
    const rLed1 = bench.doc.objects.find((o) => o.def === "resistor" && o.props?.value === "330 Ω")!
    const loop = new SimLoop()
    loop.setDoc(bench.doc)
    loop.setParts(bench.doc.parts)
    loop.setRunning(true)
    let clock = 0
    loop.advance(clock)
    let on = false
    let since = 0
    let peak = 0
    const flashes: { width: number; peak: number }[] = []
    while (clock < 6000) {
      clock += 0.5
      loop.advance(clock)
      const snap = loop.snapshot()!
      const amps = Math.abs(snap.pinVoltage[pinKey(rLed1.id, "1")] - snap.pinVoltage[pinKey(rLed1.id, "2")]) / 330
      const now = amps > 1e-3
      if (now) peak = Math.max(peak, amps)
      if (now !== on) {
        if (on) flashes.push({ width: snap.time - since, peak })
        since = snap.time
        on = now
        peak = 0
      }
    }
    expect.soft(flashes.length, "LED1 flashes in 6 s").toBeGreaterThanOrEqual(2)
    for (const f of flashes) {
      expect.soft(f.width, "LED1 lit for the beat pulse (s)").toBeNearRel(1.1 * 10e3 * 4.7e-6, 0.05)
      expect.soft(f.peak * 1e3, "through 330 Ω from QA: a red LED's ≈ 2 V leaves ≈ 7.7 mA (mA)").toBeNear(7.7, 0.6)
      expect.soft(f.peak * 1e3, "well under the 74HC595's 35 mA per-pin maximum (mA)").toBeLessThan(35)
    }
  })
})
