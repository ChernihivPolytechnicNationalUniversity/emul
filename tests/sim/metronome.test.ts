import { describe, expect, it } from "vitest"
import { buildMetronome } from "@/schematic/metronome"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type Schematic } from "@/schematic/types"
import type { BuzzerSnapshot } from "@/sim/buzzer"
import type { Engine } from "@/sim/engine"
import { SimLoop } from "@/sim/loop"

function metronome(tempo = "0.5", pitch = "0.5", volume = "0.8") {
  const { doc, parts } = buildMetronome(GRID, { tempo, pitch, volume })
  return { doc, ...parts }
}

function run(doc: Schematic, seconds: number, each: (loop: SimLoop) => void) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  while (clock < seconds * 1000) {
    clock += 2
    loop.advance(clock)
    each(loop)
  }
  return loop
}

const engineOf = (loop: SimLoop) => (loop as unknown as { engine: Engine }).engine

function record(doc: Schematic, m: ReturnType<typeof metronome>, seconds: number) {
  const edges = new Map<string, { high: boolean; time: number }[]>([m.u1, m.u2, m.u3].map((u) => [u.id, []]))
  let hooked: Engine | null = null
  const flashes: { led: number; time: number }[] = []
  const sounds: { time: number; level: number | null; tone: number | null; warnings: string[] }[] = []
  let lit = -1
  const loop = run(doc, seconds, (l) => {
    const e = engineOf(l)
    if (e !== hooked) {
      hooked = e
      e.onTimer = (object, high, time) => edges.get(object)?.push({ high, time })
    }
    const s = l.snapshot()!
    const bz = s.digital[m.buzzer.id] as BuzzerSnapshot | undefined
    if (bz) sounds.push({ time: s.time, level: bz.level, tone: bz.tone, warnings: bz.warnings })
    const on = m.leds.findIndex((led) => s.parts[partKey(led.id, "LED")]?.on)
    if (on >= 0 && on !== lit) flashes.push({ led: on, time: s.time })
    lit = on
  })
  return { loop, edges, flashes, sounds }
}

const rises = (xs: { high: boolean; time: number }[]) => xs.filter((x) => x.high).map((x) => x.time)

describe("Metronome V1 rev.B: three NE555s, a 74HC595 and the glue around them", () => {
  const m = metronome()
  const rec = record(m.doc, m, 4)

  it("steps LED1 → LED2 → LED3 → LED4 → LED1, one flash a beat", () => {
    const order = rec.flashes.map((f) => f.led)
    expect.soft(order.length, "flashes in 4 s").toBeGreaterThan(4)
    for (let k = 1; k < order.length; k++) expect.soft(order[k], `flash ${k}`).toBe((order[k - 1] + 1) % 4)
  })

  it("starts the ring from LED1 after the power-on clear", () => {
    expect.soft(rec.flashes[0]?.led).toBe(0)
  })

  it("beats at the tempo of U1's astable: ln 2 · (R1 + 2 (R2 + VR1)) · C1", () => {
    const t = rises(rec.edges.get(m.u1.id)!)
    const periods = t.slice(2).map((x, k) => x - t[k + 1])
    const want = Math.LN2 * (1e3 + 2 * (4.7e3 + 5e3)) * 47e-6
    for (const p of periods) expect.soft(p, "beat period").toBeNearRel(want, 0.03)
  })

  it("makes each beat a 1.1 · R_PULSE · C_PULSE ≈ 52 ms pulse on U2", () => {
    const xs = rec.edges.get(m.u2.id)!
    const pulses: { at: number; width: number }[] = []
    for (let k = 0; k + 1 < xs.length; k++) if (xs[k].high && !xs[k + 1].high) pulses.push({ at: xs[k].time, width: xs[k + 1].time - xs[k].time })
    const beats = pulses.filter((p) => p.width > 1e-3)
    expect.soft(beats.length).toBeGreaterThan(3)
    for (const p of beats) expect.soft(p.width, "beat pulse").toBeNearRel(1.1 * 10e3 * 4.7e-6, 0.05)
    const first = rises(rec.edges.get(m.u1.id)!).length ? Math.min(...pulses.map((p) => p.at)) : 0
    for (const p of pulses.filter((x) => x.width <= 1e-3))
      expect.soft(p.at, "the only cut-short pulse: the first beat, when the cleared register is latched and Q6 resets U2").toBeNear(first, 1e-9)
  })

  it("triggers U2 on U1's falling edge: at once while U2 is enabled, a solver step later when the step it latches has to release Q6 first", () => {
    const falls = rec.edges.get(m.u1.id)!.filter((x) => !x.high).map((x) => x.time)
    const lags = rises(rec.edges.get(m.u2.id)!).map((t) => Math.min(...falls.map((f) => Math.abs(f - t))))
    for (const lag of lags) expect.soft(lag, "lag").toBeLessThan(20e-6)
    expect.soft(lags.filter((lag) => lag < 0.5e-6).length, "beats fired within 0.5 µs").toBeGreaterThanOrEqual(lags.length - 1)
  })

  it("sounds U3 only during the beat pulse, at ln 2 · (R_A + 2 (R_B + VR2)) · C_TONE", () => {
    const tone = rec.edges.get(m.u3.id)!
    const pulse = rec.edges.get(m.u2.id)!
    const windows: [number, number][] = []
    for (let k = 0; k + 1 < pulse.length; k++) if (pulse[k].high && !pulse[k + 1].high) windows.push([pulse[k].time, pulse[k + 1].time])
    expect.soft(windows.length, "beat windows").toBeGreaterThan(3)
    for (const x of tone) expect.soft(windows.some(([a, b]) => x.time >= a - 1e-6 && x.time <= b + 1e-6), `tone edge at ${x.time.toFixed(4)} s inside a beat`).toBe(true)
    const t = rises(tone)
    const periods = t.slice(1).map((x, k) => x - t[k]).filter((p) => p < 2e-3)
    const want = Math.LN2 * (1e3 + 2 * (1e3 + 5e3)) * 100e-9
    const mean = periods.reduce((s, p) => s + p, 0) / periods.length
    expect.soft(mean, "tone period").toBeNearRel(want, 0.03)
  })

  it("beeps BZ1 at U3's tone in every beat window and nowhere else, and says its coil sees too little", () => {
    const pulse = rec.edges.get(m.u2.id)!
    const windows: [number, number][] = []
    for (let k = 0; k + 1 < pulse.length; k++) if (pulse[k].high && !pulse[k + 1].high && pulse[k + 1].time - pulse[k].time > 1e-3) windows.push([pulse[k].time, pulse[k + 1].time])
    const ring = 0.05
    for (const [a, b] of windows) {
      const inside = rec.sounds.filter((x) => x.time > a + 0.01 && x.time < b)
      expect.soft(inside.every((x) => x.level !== null), `audible through the beat at ${a.toFixed(3)} s`).toBe(true)
    }
    const between = rec.sounds.filter((x) => windows.every(([a, b]) => x.time < a || x.time > b + ring) && x.time > windows[0][0])
    expect.soft(between.length, "time between beats").toBeGreaterThan(100)
    expect.soft(between.filter((x) => x.level !== null).length, "silent between beats").toBe(0)
    const tones = rec.sounds.flatMap((x) => (x.tone === null ? [] : [x.tone])).sort((x, y) => x - y)
    expect.soft(tones[tones.length >> 1], "the tone it reads is U3's").toBeNearRel(1 / (Math.LN2 * (1e3 + 2 * (1e3 + 5e3)) * 100e-9), 0.04)
    expect.soft(rec.sounds.some((x) => x.warnings.some((w) => w.includes("under its 3–5 V operating range"))), "1.3 V across a 3–5 V part").toBe(true)
  })

  it("is loudest with VR2 near 0.8, where U3's tone sits on BZ1's 2.08 kHz resonance", () => {
    const peak = (pitch: string) => {
      const bench = metronome("0.5", pitch)
      return Math.max(...record(bench.doc, bench, 1.5).sounds.map((x) => x.level ?? -Infinity))
    }
    const onResonance = peak("0.8")
    expect.soft(onResonance - peak("0.5"), "0.8 against 0.5 (dB)").toBeGreaterThan(10)
    expect.soft(onResonance - peak("1"), "0.8 against 1 (dB)").toBeGreaterThan(8)
  })

  it("speeds up when VR1 is turned toward its wiper end", () => {
    const fast = metronome("0.9")
    const rec2 = record(fast.doc, fast, 2)
    const t = rises(rec2.edges.get(fast.u1.id)!)
    const p = t[t.length - 1] - t[t.length - 2]
    expect.soft(p).toBeNearRel(Math.LN2 * (1e3 + 2 * (4.7e3 + 1e3)) * 47e-6, 0.03)
  })

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

  it("SW1 off stops everything once C_BULK has run down; on again, the power-on clear restarts the ring from LED1", () => {
    const bench = metronome()
    const loop = new SimLoop()
    loop.setDoc(bench.doc)
    loop.setParts(bench.doc.parts)
    loop.setRunning(true)
    let clock = 0
    loop.advance(clock)
    const flashes: { led: number; time: number }[] = []
    const quiet: { lit: boolean; sounding: boolean; time: number }[] = []
    let lit = -1
    const runTo = (ms: number) => {
      while (clock < ms) {
        clock += 2
        loop.advance(clock)
        const snap = loop.snapshot()!
        const on = bench.leds.findIndex((led) => snap.parts[partKey(led.id, "LED")]?.on)
        if (on >= 0 && on !== lit) flashes.push({ led: on, time: snap.time })
        lit = on
        quiet.push({ lit: on >= 0, sounding: (snap.digital[bench.buzzer.id] as BuzzerSnapshot).sounding, time: snap.time })
      }
    }
    const power = (on: boolean) => loop.setParts({ ...bench.doc.parts, [partKey(bench.sw.id, "SW")]: { on } })
    runTo(3000)
    expect.soft(flashes.length, "beating before it is switched off").toBeGreaterThan(2)
    power(false)
    const offAt = loop.snapshot()!.time
    quiet.length = 0
    runTo(5000)
    const afterHoldUp = quiet.filter((x) => x.time > offAt + 0.2)
    expect.soft(afterHoldUp.length, "time watched while off").toBeGreaterThan(500)
    expect.soft(afterHoldUp.some((x) => x.lit), "no LED lit 0.2 s after switching off").toBe(false)
    expect.soft(afterHoldUp.some((x) => x.sounding), "BZ1 silent 0.2 s after switching off").toBe(false)
    power(true)
    const onFrom = flashes.length
    runTo(8000)
    const again = flashes.slice(onFrom).map((f) => f.led)
    expect.soft(again.length, "beating again").toBeGreaterThan(2)
    expect.soft(again.slice(0, 3), "from LED1, in order").toEqual([0, 1, 2])
  })

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
