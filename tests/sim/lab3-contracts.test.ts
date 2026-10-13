import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { pinKey } from "@/schematic/types"
import type { Snapshot } from "@/sim/loop"
import { Lab3Bench, PADS, type Lab3State } from "../lib/lab3-bench"

const CHOICES = {
  turn: "«на відповідний кут»: the angle of one step is the pot's travel over the levels its channel can take, so a full turn sweeps the whole range (variant 1: G ten bands of 10 %, B seven of 15 %), with 40 codes of hysteresis on each band edge",
  start: "levels start at the minimum — the brief's «мінімальний (початковий)» for 1 and 7; the generators' frequency and duty, which no line gives, likewise",
  variant7: "variant 7's channel B steps +10 % clockwise and −15 % counter-clockwise, as printed",
  edges: "a value exactly on an edge the brief's «більше … але менше» leaves out lights nothing",
  variant6: "variant 6 lights nothing at or above 3/4: its last band is «більше 2/3, але менше 3/4»",
  variant11: "variant 11's «перевищує 1/4» → red is read as printed: red for everything above 1/4, with green or blue in their own bands",
  sampleCount: "5, 6, 11, 12 give no N: one PWM period of 100 samples (5 kHz at 50 Hz, 10 kHz at 100 Hz)",
  dutySteps: "5, 6, 11, 12 do not say what steps the duty: JOY_A raises it by the variant's step, JOY_B lowers it, clamped to the range, starting at its minimum",
  median: "an even window's median is the mean of its two middle samples",
  trimmed: "«(20-2)/18», «(16-2)/14»: the window less its largest and smallest sample, averaged",
  note2: "note 2 makes PWM generation mandatory in 9, a voltmeter on pots with nothing to generate: its six dies are driven by TIM4 and TIM3 in PWM mode at 1 kHz, lit at 50 %; variant 7, missing from the note, uses PWM by its own text",
  pins: "pots through 2 kΩ on Arduino A2 (PF9, ADC3_IN7) and A3 (PF8, ADC3_IN6); RGB on TIM4 PD12/PD13/PD14; the second voltmeter LED on PG9/PG10/PG11 (variant 9: TIM3 on PC6/PC7/PC8); the PWM pair on TIM3 PB4/PB5",
} as const

const FULL = 4095
const HYSTERESIS_CODES = 40
const POT_SETTLE = 0.05
type Range = { minimum: number; maximum: number; up: number }
const bandsOf = (range: Range) => Math.floor((range.maximum - range.minimum) / range.up) + 1
const BAND_CENTRE = (band: number, range: Range) => (band + 0.5) / bandsOf(range)
const BRIGHTNESS = { minimum: 5, maximum: 95 }
const DUTY_TOLERANCE = 0.002
const FREQUENCY_TOLERANCE = 1e-3

type Channel = { pot: 0 | 1; pad: string; up: number; down: number }

function stepped(level: number, steps: number, ch: { up: number; down: number; minimum: number; maximum: number }) {
  for (; steps > 0; steps--) level = Math.min(ch.maximum, level + ch.up)
  for (; steps < 0; steps++) level = Math.max(ch.minimum, level - ch.down)
  return level
}

const sweepOf = (range: Range) => {
  const bands = bandsOf(range)
  return [...Array.from({ length: bands - 1 }, (_, i) => i + 1), ...Array.from({ length: bands - 1 }, (_, i) => bands - 2 - i)]
}

function spread(xs: number[]) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
}
const deviation = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const centre = sorted[sorted.length >> 1]
  return Math.max(...xs.map((x) => Math.abs(x - centre)))
}

function measuredAfter(bench: Lab3Bench, pad: string, settle: number, window: number) {
  bench.run(settle)
  const from = bench.loop.snapshot()!.time
  bench.run(window)
  return bench.pwm(pad, from)
}

type SlidingFilter = { kind: "median" | "trimmed"; window: number }

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const half = sorted.length >> 1
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2
}
const trimmedMean = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) - Math.min(...xs) - Math.max(...xs)) / (xs.length - 2)
const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

function filtersExactly(bench: () => Lab3Bench, { kind, window }: SlidingFilter) {
  it(`every filtered value is the ${kind} of the last ${window} raw samples (${kind === "median" ? CHOICES.median : CHOICES.trimmed})`, async () => {
    const b = bench()
    b.turn(0, 0.41)
    b.turn(1, 0.58)
    b.run(0.2)
    const s = await b.state()
    const filter = kind === "median" ? median : trimmedMean
    for (const ch of [0, 1]) {
      let tellsFromMean = 0
      for (let i = window - 1; i < s.raw[ch].length; i++) {
        const last = s.raw[ch].slice(i - window + 1, i + 1)
        expect.soft(s.filteredLog[ch][i], `channel ${ch + 1}, sample ${i}: ${last.join(" ")}`).toBeNear(filter(last), 1e-3)
        if (Math.abs(filter(last) - meanOf(last)) > 0.01) tellsFromMean++
      }
      expect(tellsFromMean, `channel ${ch + 1}: windows where the ${kind} and the plain mean differ`).toBeGreaterThan(5)
    }
  })
}

function filtersReject(bench: () => Lab3Bench, name: string) {
  it(`the ${name} filter rejects the ADC's impulsive noise: the filtered stream is far quieter than the raw one`, async () => {
    const b = bench()
    b.turn(0, 0.37)
    b.turn(1, 0.63)
    b.run(0.2)
    const s = await b.state()
    for (const ch of [0, 1]) {
      const raw = s.raw[ch]
      const filtered = s.filteredLog[ch]
      expect(spread(raw), `channel ${ch + 1}: the raw samples are noisy`).toBeGreaterThan(1)
      expect(spread(filtered), `channel ${ch + 1}: filtered spread against raw ${spread(raw).toFixed(2)} LSB`).toBeLessThan(spread(raw) / 2)
      expect(deviation(filtered), `channel ${ch + 1}: the worst filtered excursion against the raw one, ${deviation(raw)} LSB`).toBeLessThan(deviation(raw) / 2)
    }
  })
}

function wellBehaved(bench: () => Lab3Bench, variant: number) {
  it(`runs variant ${variant} at 216 MHz with nothing damaged and nothing unmodelled`, async () => {
    const snap = bench().run(0.01)
    const mcu = snap.mcus[bench().board.id]
    expect(mcu?.running, "core running").toBe(true)
    expect(mcu?.sysclk).toBe(216e6)
    expect(mcu?.unmodelled, "unmodelled").toEqual([])
    expect(snap.damage, "damage").toEqual({})
    expect((await bench().state()).variant).toBe(variant)
  })
}

describe.each([
  { variant: 1, hz: 100, filter: "median-of-16", sliding: { kind: "median", window: 16 } as SlidingFilter, channels: [{ pot: 0, pad: PADS.g, up: 10, down: 10 }, { pot: 1, pad: PADS.b, up: 15, down: 15 }] as Channel[], dark: PADS.r },
  { variant: 7, hz: 25, filter: "moving average with rejection 16 → 14", sliding: { kind: "trimmed", window: 16 } as SlidingFilter, channels: [{ pot: 0, pad: PADS.r, up: 30, down: 30 }, { pot: 1, pad: PADS.b, up: 10, down: 15 }] as Channel[], dark: PADS.g },
])("lab 3 variant $variant: two pots step the RGB LED's brightness by PWM at $hz Hz", ({ variant, hz, filter, sliding, channels, dark }) => {
  let bench: Lab3Bench
  const window = 3 / hz
  beforeAll(async () => {
    bench = new Lab3Bench(variant, "pots", "one", [PADS.r, PADS.g, PADS.b])
    for (const ch of channels) bench.turn(ch.pot, BAND_CENTRE(0, { ...BRIGHTNESS, up: ch.up }))
    await bench.boot()
    bench.run(0.1)
  })
  afterAll(() => bench.dispose())
  wellBehaved(() => bench, variant)

  it(`starts both driven channels at the minimum 5 %, at ${hz} Hz, and leaves the third die dark (${CHOICES.start})`, () => {
    for (const ch of channels) {
      const pwm = measuredAfter(bench, ch.pad, 0, window)
      expect(pwm.hz, `${ch.pad} Hz`).toBeNearRel(hz, FREQUENCY_TOLERANCE)
      expect(pwm.duty, `${ch.pad} duty`).toBeNear(0.05, DUTY_TOLERANCE)
    }
    const e = bench.store.edges(dark)!
    const highs = Array.from({ length: e.count }, (_, i) => i).filter((i) => e.levels[i] === 1)
    expect(highs, `${dark} never goes high`).toEqual([])
  })

  it.each(channels.map((ch, i) => ({ ...ch, index: i })))(`pot $pot steps its channel by +$up / −$down % per turn step and clamps at 5 and 95 % (${CHOICES.turn})`, async (ch) => {
    let expected = 5
    let band = 0
    const other = channels[1 - ch.index]
    const otherLevel = (await bench.state()).level[1 - ch.index]
    const range = { ...BRIGHTNESS, up: ch.up }
    for (const next of sweepOf(range)) {
      bench.turn(ch.pot, BAND_CENTRE(next, range))
      expected = stepped(expected, next - band, { ...ch, minimum: 5, maximum: 95 })
      band = next
      const pwm = measuredAfter(bench, ch.pad, POT_SETTLE, window)
      const s = await bench.state()
      expect.soft(s.level[ch.index], `band ${next}: level`).toBe(expected)
      expect.soft(pwm.duty, `band ${next}: duty on ${ch.pad}`).toBeNear(expected / 100, DUTY_TOLERANCE)
      expect.soft(pwm.hz, `band ${next}: Hz`).toBeNearRel(hz, FREQUENCY_TOLERANCE)
      expect.soft(s.level[1 - ch.index], `the other pot's channel (${other.pad}) does not move`).toBe(otherLevel)
    }
  })

  filtersReject(() => bench, filter)
  filtersExactly(() => bench, sliding)
})

describe("lab 3 variant 1: a turn counts from where the pot is, through 40 codes of hysteresis", () => {
  const G = { ...BRIGHTNESS, up: 10 }
  const B = { ...BRIGHTNESS, up: 15 }
  const width = (FULL + 1) / bandsOf(G)
  const at = (code: number) => code / FULL
  let bench: Lab3Bench
  const levels = async (settle = 0.1) => {
    bench.run(settle)
    return (await bench.state()).level
  }
  beforeAll(async () => {
    bench = new Lab3Bench(1, "pots", "one", [PADS.r, PADS.g, PADS.b])
    bench.turn(0, BAND_CENTRE(4, G))
    bench.turn(1, BAND_CENTRE(2, B))
    await bench.boot()
    bench.run(0.1)
  })
  afterAll(() => bench.dispose())

  it(`boots at 5 % on both channels with the pots half-way, and the first turn steps from there (${CHOICES.start})`, async () => {
    expect(await levels()).toEqual([5, 5])
    bench.turn(0, BAND_CENTRE(5, G))
    bench.turn(1, BAND_CENTRE(3, B))
    expect(await levels()).toEqual([15, 20])
    bench.turn(0, BAND_CENTRE(4, G))
    bench.turn(1, BAND_CENTRE(2, B))
    expect(await levels()).toEqual([5, 5])
  })

  it("a reading inside the hysteresis of an edge does not step; one past it steps once, either way", async () => {
    const edge = 5 * width
    const margin = HYSTERESIS_CODES / 2
    expect((await levels())[0]).toBe(5)
    bench.turn(0, at(edge + HYSTERESIS_CODES - margin))
    expect((await levels())[0], "just past the edge, inside the hysteresis").toBe(5)
    bench.turn(0, at(edge + HYSTERESIS_CODES + margin))
    expect((await levels())[0], "past the hysteresis").toBe(15)
    bench.turn(0, at(edge - HYSTERESIS_CODES + margin))
    expect((await levels())[0], "back under the edge, inside the hysteresis").toBe(15)
    bench.turn(0, at(edge - HYSTERESIS_CODES - margin))
    expect((await levels())[0], "back past the hysteresis").toBe(5)
  })

  it("a full clockwise turn from fully counter-clockwise sweeps each channel from 5 to exactly 95 %, one level per band", async () => {
    bench.turn(0, BAND_CENTRE(0, G))
    bench.turn(1, BAND_CENTRE(0, B))
    await levels()
    bench.turn(0, BAND_CENTRE(bandsOf(G) - 1, G))
    bench.turn(1, BAND_CENTRE(bandsOf(B) - 1, B))
    expect(await levels(0.2)).toEqual([95, 95])
    expect([bandsOf(G), bandsOf(B)]).toEqual([10, 7])
  })
})

describe.each([
  { variant: 2, filter: "moving average with rejection 20 → 18", sliding: { kind: "trimmed", window: 20 } as SlidingFilter, frequency: { minimum: 200, maximum: 1000, up: 100, down: 100 }, duty: { minimum: 10, maximum: 90, up: 10, down: 10 } },
  { variant: 8, filter: "median-of-20", sliding: { kind: "median", window: 20 } as SlidingFilter, frequency: { minimum: 100, maximum: 500, up: 50, down: 50 }, duty: { minimum: 20, maximum: 80, up: 20, down: 20 } },
])("lab 3 variant $variant: a square-wave generator, direct and inverted, its frequency and duty on the two pots", ({ variant, filter, sliding, frequency, duty }) => {
  let bench: Lab3Bench
  let hz = frequency.minimum
  let percent = duty.minimum
  beforeAll(async () => {
    bench = new Lab3Bench(variant, "pots", "none", [PADS.r, PADS.g])
    bench.turn(0, BAND_CENTRE(0, frequency))
    bench.turn(1, BAND_CENTRE(0, duty))
    await bench.boot()
    bench.run(0.1)
  })
  afterAll(() => bench.dispose())
  wellBehaved(() => bench, variant)

  const check = (label: string) => {
    const window = 3 / hz
    const direct = measuredAfter(bench, PADS.r, POT_SETTLE + 2 / hz, window)
    const inverted = bench.pwm(PADS.g, bench.loop.snapshot()!.time - window)
    expect.soft(direct.hz, `${label}: PD12 Hz`).toBeNearRel(hz, FREQUENCY_TOLERANCE)
    expect.soft(direct.duty, `${label}: PD12 duty`).toBeNear(percent / 100, DUTY_TOLERANCE)
    expect.soft(inverted.hz, `${label}: PD13 Hz`).toBeNearRel(hz, FREQUENCY_TOLERANCE)
    expect.soft(inverted.duty, `${label}: PD13 is the inverse`).toBeNear(1 - percent / 100, DUTY_TOLERANCE)
  }

  it(`starts at ${frequency.minimum} Hz and ${duty.minimum} % (${CHOICES.start})`, () => check("boot"))

  it(`pot 1 steps the frequency by ${frequency.up} Hz per turn step between ${frequency.minimum} and ${frequency.maximum} Hz, clamped`, () => {
    let band = 0
    for (const next of sweepOf(frequency)) {
      bench.turn(0, BAND_CENTRE(next, frequency))
      hz = stepped(hz, next - band, frequency)
      band = next
      check(`pot 1 band ${next}`)
    }
  })

  it(`pot 2 steps the duty by ${duty.up} % per turn step between ${duty.minimum} and ${duty.maximum} %, clamped, at any frequency`, () => {
    bench.turn(0, BAND_CENTRE(5, frequency))
    hz = stepped(hz, 5, frequency)
    let band = 0
    for (const next of sweepOf(duty)) {
      bench.turn(1, BAND_CENTRE(next, duty))
      percent = stepped(percent, next - band, duty)
      band = next
      check(`pot 2 band ${next}`)
    }
  })

  it("the inverted output switches at the very instants the direct one does", () => {
    const direct = bench.store.edges(PADS.r)!
    const inverted = bench.store.edges(PADS.g)!
    const from = bench.loop.snapshot()!.time - 3 / hz
    const at = (e: typeof direct, i: number) => e.times[i]
    let checked = 0
    for (let i = 0; i < direct.count; i++) {
      if (at(direct, i) < from) continue
      let nearest = Infinity
      for (let j = 0; j < inverted.count; j++) nearest = Math.min(nearest, Math.abs(at(inverted, j) - at(direct, i)))
      expect.soft(nearest, `edge at ${at(direct, i).toFixed(6)} s`).toBeLessThan(1e-6)
      checked++
    }
    expect(checked).toBeGreaterThan(4)
  })

  filtersReject(() => bench, filter)
  filtersExactly(() => bench, sliding)
})

type Rule = (x: number) => string
const RULES: Record<string, Rule> = {
  quarters: (x) => (x <= 1 / 4 ? "R" : x > 1 / 4 && x < 1 / 2 ? "G" : x > 1 / 2 && x < 3 / 4 ? "B" : x > 3 / 4 ? "RGB" : ""),
  thirds: (x) => (x <= 1 / 3 ? "R" : x > 1 / 3 && x < 2 / 3 ? "G" : x > 2 / 3 ? "B" : ""),
  thirdsBelowThreeQuarters: (x) => (x <= 1 / 3 ? "R" : x > 1 / 3 && x < 2 / 3 ? "G" : x > 2 / 3 && x < 3 / 4 ? "B" : ""),
  quartersReversed: (x) => (x > 3 / 4 ? "R" : x > 1 / 2 && x < 3 / 4 ? "G" : x > 1 / 4 && x < 1 / 2 ? "B" : x <= 1 / 4 ? "RGB" : ""),
  thirdsReversed: (x) => (x > 2 / 3 ? "R" : x > 1 / 3 && x < 2 / 3 ? "G" : x <= 1 / 3 ? "B" : ""),
  quartersRedAboveOneQuarter: (x) => (x <= 1 / 4 ? "RGB" : "R" + (x > 1 / 2 && x < 3 / 4 ? "G" : "") + (x > 1 / 4 && x < 1 / 2 ? "B" : "")),
}
const QUARTER_POINTS = [0.05, 0.24, 0.26, 0.4, 0.49, 0.51, 0.62, 0.74, 0.76, 0.95]
const THIRD_POINTS = [0.05, 0.32, 0.345, 0.5, 0.655, 0.68, 0.72, 0.76, 0.95]
const VOLTMETER_SETTLE = 0.12
const VOLTMETER_TOLERANCE_LSB = 4

const LED_PWM = { hz: 1000, duty: 0.5 }

describe.each([
  { variant: 3, quantity: "RMS", n: 32, rule: "quarters", points: QUARTER_POINTS, byPwm: false },
  { variant: 4, quantity: "mean", n: 16, rule: "thirds", points: THIRD_POINTS, byPwm: false },
  { variant: 9, quantity: "RMS", n: 16, rule: "quartersReversed", points: QUARTER_POINTS, byPwm: true },
  { variant: 10, quantity: "mean", n: 32, rule: "thirdsReversed", points: THIRD_POINTS, byPwm: false },
])("lab 3 variant $variant: a two-channel $quantity voltmeter over N = $n on the pots, one RGB LED per channel", ({ variant, rule, points, byPwm }) => {
  let bench: Lab3Bench
  const dies = [
    [PADS.r, PADS.g, PADS.b],
    [PADS.r2Pwm, PADS.g2Pwm, PADS.b2Pwm],
  ]
  beforeAll(async () => {
    bench = new Lab3Bench(variant, "pots", byPwm ? "two-on-timers" : "two", byPwm ? dies.flat() : [])
    await bench.boot()
    bench.run(0.05)
  })
  afterAll(() => bench.dispose())
  wellBehaved(() => bench, variant)

  it.each(points)(`at %f of the range on channel 1 and its mirror on channel 2, each LED shows its band (${CHOICES.edges})`, async (x) => {
    bench.turn(0, x)
    bench.turn(1, 1 - x)
    const snap = bench.run(VOLTMETER_SETTLE)
    const s = await bench.state()
    const rail = snap.pinVoltage[pinKey(bench.board.id, PADS.rail)]
    for (const ch of [0, 1]) {
      const volts = snap.pinVoltage[pinKey(bench.board.id, ch ? PADS.pot2 : PADS.pot1)]
      const fraction = volts / rail
      expect.soft(s.measured[ch], `channel ${ch + 1}: measured code against ${volts.toFixed(4)} V`).toBeNear(fraction * FULL, VOLTMETER_TOLERANCE_LSB)
      expect.soft(bench.lit(snap, ch), `channel ${ch + 1} at ${fraction.toFixed(3)}`).toBe(RULES[rule](fraction))
    }
  })

  if (byPwm)
    it(`drives every lit die by PWM, ${LED_PWM.hz} Hz at ${LED_PWM.duty * 100} % (${CHOICES.note2})`, () => {
      bench.turn(0, 0.62)
      bench.turn(1, 0.1)
      const snap = bench.run(VOLTMETER_SETTLE)
      const from = snap.time - 0.005
      bench.run(0.01)
      for (const [ch, pads] of dies.entries()) {
        const lit = bench.lit(bench.loop.snapshot()!, ch)
        expect(lit.length, `channel ${ch + 1} lights something`).toBeGreaterThan(0)
        ;(["R", "G", "B"] as const).forEach((die, k) => {
          const pwm = bench.pwm(pads[k], from)
          if (!lit.includes(die)) return expect.soft(pwm.duty, `channel ${ch + 1} ${die} dark`).toBe(0)
          expect.soft(pwm.hz, `channel ${ch + 1} ${die} Hz`).toBeNearRel(LED_PWM.hz, FREQUENCY_TOLERANCE)
          expect.soft(pwm.duty, `channel ${ch + 1} ${die} duty`).toBeNear(LED_PWM.duty, DUTY_TOLERANCE)
        })
      }
    })
})

type PairVariant = { variant: number; quantity: "RMS" | "mean"; hz: number; rule: string; minimum: number; maximum: number; step: number }

function pairLevels(v: PairVariant) {
  const up: number[] = []
  for (let d = v.minimum; d <= v.maximum; d += v.step) up.push(d)
  return up
}

describe.each<PairVariant>([
  { variant: 5, quantity: "RMS", hz: 50, rule: "quarters", minimum: 10, maximum: 90, step: 20 },
  { variant: 6, quantity: "mean", hz: 100, rule: "thirdsBelowThreeQuarters", minimum: 5, maximum: 95, step: 30 },
  { variant: 11, quantity: "RMS", hz: 100, rule: "quartersRedAboveOneQuarter", minimum: 5, maximum: 95, step: 30 },
  { variant: 12, quantity: "mean", hz: 50, rule: "thirdsReversed", minimum: 10, maximum: 90, step: 20 },
])("lab 3 variant $variant: the $quantity of its own direct and inverted $hz Hz PWM, fed back into A2 and A3", (v) => {
  let bench: Lab3Bench
  const transfer = (d: number) => (v.quantity === "RMS" ? Math.sqrt(d) : d)
  const samples = 100
  beforeAll(async () => {
    bench = new Lab3Bench(v.variant, "pwm-pair", "two", [PADS.direct, PADS.inverted])
    await bench.boot()
    bench.run(0.1)
  })
  afterAll(() => bench.dispose())
  wellBehaved(() => bench, v.variant)

  const visit = async (percent: number, label: string, snap: Snapshot, s: Lab3State) => {
    const window = 3 / v.hz
    const direct = bench.pwm(PADS.direct, snap.time - window)
    const inverted = bench.pwm(PADS.inverted, snap.time - window)
    expect.soft(s.duty, `${label}: duty`).toBe(percent)
    expect.soft(direct.hz, `${label}: PB4 Hz`).toBeNearRel(v.hz, FREQUENCY_TOLERANCE)
    expect.soft(direct.duty, `${label}: PB4 duty`).toBeNear(percent / 100, DUTY_TOLERANCE)
    expect.soft(inverted.duty, `${label}: PB5 duty`).toBeNear(1 - percent / 100, DUTY_TOLERANCE)
    for (const [ch, d] of [
      [0, percent / 100],
      [1, 1 - percent / 100],
    ] as const) {
      const low = transfer(Math.max(0, d - 1 / samples))
      const high = transfer(Math.min(1, d + 1 / samples))
      const x = s.measured[ch] / FULL
      expect.soft(x, `${label}, channel ${ch + 1}: ${v.quantity} of D = ${d.toFixed(2)} is ${transfer(d).toFixed(3)} of the range, ±1 sample of ${samples}`).toBeGreaterThanOrEqual(low - 1 / FULL)
      expect.soft(x).toBeLessThanOrEqual(high + 1 / FULL)
      const colour = RULES[v.rule](low)
      expect(RULES[v.rule](high), `${label}, channel ${ch + 1}: one sample either way stays in one band`).toBe(colour)
      expect.soft(bench.lit(snap, ch), `${label}, channel ${ch + 1} LED at ${x.toFixed(3)}`).toBe(colour)
    }
  }

  it(`starts at ${v.minimum} % and JOY_A steps the duty up by ${v.step} % to ${v.maximum} %, then stays there (${CHOICES.dutySteps}; ${CHOICES.sampleCount})`, async () => {
    const levels = pairLevels(v)
    for (const [i, percent] of [...levels, v.maximum].entries()) {
      if (i > 0) bench.press("JOY_A")
      const snap = bench.run(0.1)
      await visit(percent, i < levels.length ? `${percent} %` : `${percent} % after one press too many`, snap, await bench.state())
    }
  })

  it(`JOY_B steps it back down to ${v.minimum} % and stays there`, async () => {
    const levels = pairLevels(v).reverse().slice(1)
    for (const [i, percent] of [...levels, v.minimum].entries()) {
      bench.press("JOY_B")
      const snap = bench.run(0.1)
      await visit(percent, i < levels.length ? `${percent} %` : `${percent} % after one press too many`, snap, await bench.state())
    }
  })
})

describe("lab 3: what was decided where the brief is silent or contradicts itself", () => {
  it("every choice is recorded", () => {
    expect(Object.keys(CHOICES)).toEqual(["turn", "start", "variant7", "edges", "variant6", "variant11", "sampleCount", "dutySteps", "median", "trimmed", "note2", "pins"])
  })
})
