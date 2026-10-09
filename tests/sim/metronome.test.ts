import { describe, expect, it } from "vitest"
import { buildMetronome } from "@/schematic/metronome"
import { GRID } from "@/schematic/geometry"
import { partKey, type Schematic } from "@/schematic/types"
import type { BuzzerSnapshot } from "@/sim/buzzer"
import type { Engine } from "@/sim/engine"
import { SimLoop } from "@/sim/loop"

function metronome(tempo = "0.5", pitch = "0.5") {
  const { doc, parts } = buildMetronome(GRID, { tempo, pitch })
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

})
