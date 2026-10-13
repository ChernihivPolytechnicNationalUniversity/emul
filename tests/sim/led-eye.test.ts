import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { GLOW_OPACITY, glowOf } from "@/components/field/led-glow"
import { partKey, type Schematic } from "@/schematic/types"
import { LED_FULL, SimLoop, type Snapshot } from "@/sim/loop"
import { sustainedPwm, sustainedReaches } from "../lib/eye"
import { example } from "../lib/firmware"
import { Lab2Bench, patchWord, type Joy } from "../lib/lab2-bench"

const SAMPLE_MS = 1
const WARM = 0.5
const STEADY = 0.01
const SAMPLED_PHASE = 1e-3
const GREY_LEVEL = 1 / 255

class Bench {
  private readonly loop = new SimLoop()
  private clock = 0

  constructor(doc: Schematic) {
    this.loop.setDoc(doc)
    this.loop.setParts(doc.parts)
    this.loop.setRunning(true)
    this.loop.advance(0)
  }

  run(seconds: number): Snapshot {
    const end = this.clock + seconds * 1000
    while (this.clock < end) {
      this.clock = Math.min(end, this.clock + SAMPLE_MS)
      this.loop.advance(this.clock)
    }
    return this.loop.snapshot()!
  }

  sample(key: string, seconds: number) {
    const out: { time: number; amps: number; level: number }[] = []
    for (let k = 0; k < seconds * 1000; k += SAMPLE_MS) {
      const snap = this.run(SAMPLE_MS / 1000)
      const part = snap.parts[key]
      out.push({ time: snap.time, amps: part?.amps ?? 0, level: part?.level ?? 0 })
    }
    return out
  }

  dispose() {
    this.loop.dispose()
  }
}

const swing = (values: number[]) => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return { mean, min: Math.min(...values), max: Math.max(...values), relative: (Math.max(...values) - Math.min(...values)) / mean }
}

function pulsedLed(pulse: Record<string, string>, extra?: (b: ReturnType<typeof builder>) => void) {
  const b = builder(GRID)
  const source = b.place("pulse-source", 0, 0, { high: "3.3 V", low: "0 V", rint: "1 Ω", ...pulse })
  const resistor = b.place("resistor", 5, 0, { value: "270 Ω" })
  const led = b.place("led", 12, 0)
  const gnd = b.place("ground", 4, 10)
  b.wire(source, "+", resistor, "1")
  b.wire(resistor, "2", led, "1")
  b.wire(led, "2", gnd, "GND")
  b.wire(source, "-", gnd, "GND")
  extra?.(b)
  return { bench: new Bench(b.doc), key: partKey(led.id, "LED") }
}

function onCurrent() {
  const { bench, key } = pulsedLed({ freq: "100 Hz", duty: "100" })
  bench.run(WARM)
  const amps = swing(bench.sample(key, 0.05).map((s) => s.amps)).mean
  bench.dispose()
  return amps
}

describe("an LED as the eye sees it: Watson's sustained cascade (1986, Fig. 6.4)", () => {
  const full = onCurrent()

  it.each([5, 25, 50, 75, 95])("at %i %% of 100 Hz shows the mean current, steady at every phase (Talbot–Plateau)", (duty) => {
    const { bench, key } = pulsedLed({ freq: "100 Hz", duty: String(duty) })
    bench.run(WARM)
    const s = swing(bench.sample(key, 0.1).map((x) => x.amps))
    bench.dispose()
    expect.soft(s.mean / full, `${duty} %: the fused light is the duty times the on current`).toBeNearRel(duty / 100, 2e-3)
    expect.soft(s.relative, `${duty} %: no phase of the period shows through`).toBeLessThan(STEADY)
  })

  it.each([
    [25, 5],
    [25, 50],
    [50, 5],
  ])("still flickers at %i Hz, %i %%, by as much as the cascade passes", (hz, duty) => {
    const { bench, key } = pulsedLed({ freq: `${hz} Hz`, duty: String(duty) })
    bench.run(WARM)
    const s = swing(bench.sample(key, 4 / hz).map((x) => x.amps))
    bench.dispose()
    const want = sustainedPwm(hz, duty / 100)
    expect.soft(s.relative, `${hz} Hz ${duty} %: peak-to-peak over the mean`).toBeNear((want.max - want.min) / want.mean, 0.02)
    expect.soft(s.min, `${hz} Hz ${duty} %: dimmer at its trough, never dark`).toBeGreaterThan(0)
  })

  it("lights and goes out along the cascade's step response, the settled path included", () => {
    const edge = 0.3
    const { bench, key } = pulsedLed({ freq: "0.1 Hz", width: "5 s", delay: `${edge} s` })
    bench.run(edge - 0.05)
    const rise = bench.sample(key, 0.2)
    bench.dispose()
    const crossing = (fraction: number) => rise.find((s) => s.amps >= fraction * full)!.time - edge
    for (const fraction of [0.1, 0.5, 0.9]) {
      expect.soft(crossing(fraction), `reaches ${fraction * 100} % of its light`).toBeNear(sustainedReaches(fraction), SAMPLED_PHASE + 1e-4)
    }
  })

  it("does not take its time from an AC source elsewhere on the sheet", () => {
    const edge = 0.3
    const crossing = (withSine: boolean) => {
      const { bench, key } = pulsedLed({ freq: "0.1 Hz", width: "5 s", delay: `${edge} s` }, (b) => {
        if (!withSine) return
        const sine = b.place("ac-source", 30, 0, { value: "1 V", freq: "10 Hz" })
        const load = b.place("resistor", 36, 0, { value: "1 kΩ" })
        const gnd = b.place("ground", 34, 10)
        b.wire(sine, "+", load, "1")
        b.wire(load, "2", gnd, "GND")
        b.wire(sine, "-", gnd, "GND")
      })
      bench.run(edge - 0.05)
      const rise = bench.sample(key, 0.2)
      bench.dispose()
      return rise.find((s) => s.amps >= 0.5 * full)!.time - edge
    }
    expect(crossing(true), "the same half-light time with a 10 Hz sine on another net").toBeNear(crossing(false), SAMPLED_PHASE + 1e-4)
  })

  it("has no dark cut-off: 0.1 mA glows at its share of full", () => {
    const b = builder(GRID)
    const source = b.place("dc-source", 0, 0, { value: "3.3 V", rint: "1 Ω" })
    const resistor = b.place("resistor", 5, 0, { value: "15 kΩ" })
    const led = b.place("led", 12, 0)
    const gnd = b.place("ground", 4, 10)
    b.wire(source, "+", resistor, "1")
    b.wire(resistor, "2", led, "1")
    b.wire(led, "2", gnd, "GND")
    b.wire(source, "-", gnd, "GND")
    const bench = new Bench(b.doc)
    const part = bench.run(WARM).parts[partKey(led.id, "LED")]!
    bench.dispose()
    expect.soft(part.amps, "about 0.1 mA through 15 kΩ").toBeNearRel(1e-4, 0.15)
    expect.soft(part.level, "lit, at its current over full").toBeNearRel(part.amps! / LED_FULL, 1e-9)
    expect.soft(part.on, "but below the on-state threshold the tests read").toBe(false)
  })
})

describe("our lab 2 (lab2-v3) on the Open746I-C, as the eye sees the RGB LED", () => {
  const DIES = { R: "PD12", G: "PD13", B: "PD14" } as const
  const b = new Lab2Bench({ elf: "lab2-rgb-pwm.elf", rgb: { ...DIES } })

  beforeAll(async () => {
    await b.boot()
    b.run(WARM)
  })
  afterAll(() => b.dispose())

  const watch = (seconds: number) => {
    const series: Record<keyof typeof DIES, number[]> = { R: [], G: [], B: [] }
    const steps = Math.round(seconds / (SAMPLE_MS / 1000))
    for (let k = 0; k < steps; k++) {
      const snap = b.run(SAMPLE_MS / 1000)
      for (const die of Object.keys(DIES) as (keyof typeof DIES)[]) series[die].push(snap.parts[partKey(b.led!, die)]?.level ?? 0)
    }
    return series
  }

  const shown = (levels: number[]) => swing(levels.map((level) => GLOW_OPACITY * glowOf(level)))

  it("glows steadily at the 5 % it boots with: every frame lit, the glow within a grey level", () => {
    for (const [die, levels] of Object.entries(watch(0.2))) {
      const s = shown(levels)
      expect.soft(s.min, `${die}: never dark`).toBeGreaterThan(0)
      expect.soft(s.max - s.min, `${die}: steady across the 100 Hz period, the pads' dithered sub-step edges included`).toBeLessThan(GREY_LEVEL)
    }
  })

  it.each(["JOY_CTR", "JOY_C"] satisfies Joy[])("stays steady after %s", async (joy) => {
    await b.press(joy)
    b.run(WARM)
    for (const [die, levels] of Object.entries(watch(0.1))) {
      const s = shown(levels)
      expect.soft(s.max - s.min, `${die} after ${joy}`).toBeLessThan(GREY_LEVEL)
    }
  })
})

describe("lab 2 variant 7 at 25 Hz: the flicker a real one shows", () => {
  const b = new Lab2Bench({ elf: "lab2-variants.elf", image: patchWord(example("lab2-variants.elf"), "lab2_variant", 7), rgb: { R: "PD12", G: "PD13", B: "PD14" } })

  beforeAll(async () => {
    await b.boot()
    b.run(WARM)
    await b.press("JOY_CTR")
    b.run(WARM)
  })
  afterAll(() => b.dispose())

  it("flickers at 5 % of 25 Hz by what the cascade passes, without going dark", () => {
    const levels: number[] = []
    for (let k = 0; k < 160; k++) levels.push(b.run(SAMPLE_MS / 1000).parts[partKey(b.led!, "R")]?.level ?? 0)
    const s = swing(levels)
    const want = sustainedPwm(25, 0.05)
    expect.soft(s.relative, "peak-to-peak over the mean").toBeNear((want.max - want.min) / want.mean, 0.03)
    expect.soft(s.min, "never dark").toBeGreaterThan(0)
  })
})
