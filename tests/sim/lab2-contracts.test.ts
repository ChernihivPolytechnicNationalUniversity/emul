import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { EYE_SETTLED } from "../lib/eye"
import { example } from "../lib/firmware"
import { Lab2Bench, patchWord, type Joy } from "../lib/lab2-bench"

const ELF = example("lab2-variants.elf")
const TIMER_HZ = 108e6
const SYSCLK = 216e6
const ACCURACY = 0.001
const NEAR_BOUND = 0.002
const FREQUENCY_TOLERANCE = 1e-4
const STATE = { variant: 0, ready: 1, presses: 2, edges: 3, level: 4, hz: 7, duty: 8, range: 9, ticks: 10, value: 11, leds: 12, measurements: 13 } as const
const STATE_WORDS = 14
const JOY_INDEX: Record<Joy, number> = { JOY_A: 0, JOY_B: 1, JOY_C: 2, JOY_D: 3, JOY_CTR: 4 }
const LED_PADS = ["PD12", "PD13", "PD14"] as const
const DIES = ["R", "G", "B"] as const

const bench = (variant: number) =>
  new Lab2Bench({
    elf: "lab2-variants.elf",
    image: patchWord(ELF, "lab2_variant", variant),
    probes: [...LED_PADS, "PA15"],
    rgb: { R: "PD12", G: "PD13", B: "PD14" },
    wires: [{ from: "PH10", to: "PA15" }],
  })

async function state(b: Lab2Bench) {
  const w = await b.words("lab2", STATE_WORDS)
  return { ...Object.fromEntries(Object.entries(STATE).map(([k, i]) => [k, w[i]])), level: w.slice(STATE.level, STATE.level + 3) } as Record<Exclude<keyof typeof STATE, "level">, number> & { level: number[] }
}

async function booted(b: Lab2Bench, variant: number) {
  await b.boot()
  b.run(0.05)
  const s = await state(b)
  expect(s.ready, "firmware ready").toBe(1)
  expect(s.variant, "variant patched into the image").toBe(variant)
  expect(b.snapshot().mcus[b.u]?.sysclk, "216 MHz from the 8 MHz crystal").toBe(SYSCLK)
}

type RgbVariant = { variant: number; hz: number; start: number; moves: { joy: Joy; die: 0 | 1 | 2; step: number }[]; unused: Joy; centre: number }

const RGB: RgbVariant[] = [
  {
    variant: 1,
    hz: 100,
    start: 5,
    moves: [
      { joy: "JOY_C", die: 0, step: 5 },
      { joy: "JOY_B", die: 1, step: 10 },
      { joy: "JOY_A", die: 2, step: 30 },
    ],
    unused: "JOY_D",
    centre: 95,
  },
  {
    variant: 7,
    hz: 25,
    start: 95,
    moves: [
      { joy: "JOY_D", die: 0, step: -30 },
      { joy: "JOY_C", die: 1, step: -10 },
      { joy: "JOY_B", die: 2, step: -5 },
    ],
    unused: "JOY_A",
    centre: 5,
  },
]

const LEVEL_MIN = 5
const LEVEL_MAX = 95
const cyclic = (level: number, step: number) => (level + step > LEVEL_MAX ? LEVEL_MIN : level + step < LEVEL_MIN ? LEVEL_MAX : level + step)

describe.each(RGB)("lab 2 variant $variant: RGB brightness by PWM at $hz Hz on TIM4 CH1–CH3 (PD12–PD14)", (v) => {
  const b = bench(v.variant)
  const period = 1 / v.hz

  beforeAll(() => booted(b, v.variant))
  afterAll(() => b.dispose())

  it(`starts every channel at ${v.start} % on one timer, ${v.hz} Hz exactly with TIM4 at 108 MHz (APB1 /4, timer clock doubled)`, () => {
    const from = b.time
    b.run(3 * period)
    for (const pad of LED_PADS) {
      const pwm = b.pwm(pad, from)
      expect(pwm.period, `${pad} period`).toBeNearRel(period, 1e-6)
      expect(pwm.duty, `${pad} duty`).toBeNear(v.start / 100, 1e-6)
    }
  })

  it.each(v.moves)("$joy steps channel $die by $step % through a full cycle, wrapping at the ends (one step per press despite the joystick's bounce)", async ({ joy, die, step }) => {
    const before = await state(b)
    let level = before.level[die]
    const presses = Math.round((LEVEL_MAX - LEVEL_MIN) / Math.abs(step)) + 1
    for (let i = 0; i < presses; i++) {
      await b.press(joy)
      level = cyclic(level, step)
      const s = await state(b)
      expect.soft(s.level[die], `after press ${i + 1}`).toBe(level)
    }
    expect(level, "back where it started").toBe(before.level[die])
    const after = await state(b)
    expect(after.presses - before.presses, "presses taken").toBe(presses)
    expect(after.edges - before.edges, "EXTI edges, bounce included").toBeGreaterThan(2 * presses)
    const from = b.time
    b.run(3 * period)
    expect(b.pwm(LED_PADS[die], from).duty).toBeNear(level / 100, 1e-6)
  })

  it(`does nothing on ${v.unused}`, async () => {
    const before = await state(b)
    await b.press(v.unused)
    const after = await state(b)
    expect(after.level).toEqual(before.level)
    expect(after.presses - before.presses).toBe(1)
  })

  it(`sets every channel to ${v.centre} % on the centre`, async () => {
    await b.press(v.moves[0].joy)
    await b.press("JOY_CTR")
    expect((await state(b)).level).toEqual([v.centre, v.centre, v.centre])
    const from = b.time
    b.run(3 * period)
    for (const pad of LED_PADS) expect(b.pwm(pad, from).duty, pad).toBeNear(v.centre / 100, 1e-6)
  })
})

type SquareVariant = { variant: number; hz: [number, number]; hzStep: number; duty: [number, number]; dutyStep: number; hzUp: Joy; hzDown: Joy; dutyUp: Joy; dutyDown: Joy; centre: [number, number] }

const SQUARE: SquareVariant[] = [
  { variant: 2, hz: [200, 1000], hzStep: 100, duty: [10, 90], dutyStep: 10, hzUp: "JOY_C", hzDown: "JOY_B", dutyUp: "JOY_A", dutyDown: "JOY_D", centre: [1000, 10] },
  { variant: 8, hz: [100, 500], hzStep: 50, duty: [20, 80], dutyStep: 20, hzUp: "JOY_D", hzDown: "JOY_C", dutyUp: "JOY_A", dutyDown: "JOY_B", centre: [100, 80] },
]

describe.each(SQUARE)("lab 2 variant $variant: square-wave generator, direct on PD12 and inverted on PD13 (TIM4 CH1/CH2)", (v) => {
  const b = bench(v.variant)

  const measure = (hz: number, duty: number) => {
    const from = b.time
    b.run(4 / hz)
    const direct = b.pwm("PD12", from)
    const inverted = b.pwm("PD13", from)
    expect(1 / direct.period, "frequency").toBeNearRel(hz, FREQUENCY_TOLERANCE)
    expect(direct.duty, "duty").toBeNear(duty / 100, FREQUENCY_TOLERANCE)
    expect(1 / inverted.period, "inverted frequency").toBeNearRel(hz, FREQUENCY_TOLERANCE)
    expect(inverted.duty, "inverted duty").toBeNear(1 - duty / 100, FREQUENCY_TOLERANCE)
    const rises = b.edges("PD12").filter((e) => e.time > from && e.level)
    const falls = b.edges("PD13").filter((e) => e.time > from && !e.level)
    for (const r of rises.slice(0, 3)) expect(Math.min(...falls.map((f) => Math.abs(f.time - r.time))), "PD13 falls as PD12 rises").toBeLessThan(1 / TIMER_HZ + 1e-12)
  }

  const walk = async (joy: Joy, field: "hz" | "duty", step: number, limit: number) => {
    let value = (await state(b))[field]
    for (let guard = 0; guard < 20 && value !== limit; guard++) {
      await b.press(joy)
      const next = (await state(b))[field]
      expect.soft(next, `${joy} from ${value}`).toBe(value + step)
      value = next
    }
    expect(value).toBe(limit)
    await b.press(joy)
    expect((await state(b))[field], `${joy} clamps at ${limit}`).toBe(limit)
  }

  beforeAll(() => booted(b, v.variant))
  afterAll(() => b.dispose())

  it(`starts in the centre's state, ${v.centre[0]} Hz at ${v.centre[1]} % (the brief gives no initial values)`, async () => {
    const s = await state(b)
    expect([s.hz, s.duty]).toEqual(v.centre)
    measure(...v.centre)
  })

  it(`steps the frequency down by ${v.hzStep} Hz to ${v.hz[0]} Hz and clamps there`, async () => {
    const hz = (await state(b)).hz
    if (hz === v.hz[0]) await walk(v.hzUp, "hz", v.hzStep, v.hz[1])
    await walk(v.hzDown, "hz", -v.hzStep, v.hz[0])
    measure(v.hz[0], (await state(b)).duty)
  })

  it(`steps the frequency up by ${v.hzStep} Hz to ${v.hz[1]} Hz and clamps there`, async () => {
    await walk(v.hzUp, "hz", v.hzStep, v.hz[1])
    measure(v.hz[1], (await state(b)).duty)
  })

  it(`steps the duty by ${v.dutyStep} % between ${v.duty[0]} and ${v.duty[1]} %, clamped at both ends`, async () => {
    const s = await state(b)
    if (s.duty !== v.duty[0]) await walk(v.dutyDown, "duty", -v.dutyStep, v.duty[0])
    measure(s.hz, v.duty[0])
    await walk(v.dutyUp, "duty", v.dutyStep, v.duty[1])
    measure(s.hz, v.duty[1])
  })

  it("goes back to the centre's state on the centre", async () => {
    await b.press(v.hzDown)
    await b.press("JOY_CTR")
    const s = await state(b)
    expect([s.hz, s.duty]).toEqual(v.centre)
    measure(...v.centre)
  })
})

type Quantity = "frequency" | "period" | "width" | "gap"
type Lights = "red" | "green" | "blue" | "both" | "one" | "none"
type MeterVariant = {
  variant: number
  quantity: Quantity
  ranges: Partial<Record<Joy, [number, number]>>
  first: Joy
  fixed: { duty: number } | { hz: number }
  above: Lights
  within: Lights
  below: Lights
}

const MS = 1e-3

const METERS: MeterVariant[] = [
  { variant: 3, quantity: "frequency", ranges: { JOY_C: [200, 400], JOY_A: [400, 600], JOY_B: [600, 800], JOY_D: [800, 1000] }, first: "JOY_C", fixed: { duty: 0.5 }, above: "red", within: "green", below: "blue" },
  { variant: 4, quantity: "period", ranges: { JOY_D: [2.5 * MS, 5 * MS], JOY_B: [1.7 * MS, 2.5 * MS], JOY_A: [1.25 * MS, 1.7 * MS], JOY_C: [1.0 * MS, 1.25 * MS] }, first: "JOY_D", fixed: { duty: 0.25 }, above: "red", within: "green", below: "blue" },
  { variant: 5, quantity: "width", ranges: { JOY_C: [8 * MS, 10 * MS], JOY_A: [6 * MS, 8 * MS], JOY_B: [4 * MS, 6 * MS], JOY_D: [2 * MS, 4 * MS] }, first: "JOY_C", fixed: { hz: 100 }, above: "both", within: "none", below: "one" },
  { variant: 6, quantity: "gap", ranges: { JOY_D: [1.8 * MS, 2 * MS], JOY_B: [1.6 * MS, 1.8 * MS], JOY_A: [1.4 * MS, 1.6 * MS], JOY_C: [1.2 * MS, 1.4 * MS] }, first: "JOY_D", fixed: { hz: 500 }, above: "none", within: "both", below: "one" },
  { variant: 9, quantity: "frequency", ranges: { JOY_D: [100, 200], JOY_B: [200, 300], JOY_A: [300, 400], JOY_C: [400, 500] }, first: "JOY_D", fixed: { duty: 0.25 }, above: "blue", within: "red", below: "green" },
  { variant: 10, quantity: "period", ranges: { JOY_C: [5 * MS, 10 * MS], JOY_A: [3.3 * MS, 5 * MS], JOY_B: [2.5 * MS, 3.3 * MS], JOY_D: [2.0 * MS, 2.5 * MS] }, first: "JOY_C", fixed: { duty: 0.25 }, above: "blue", within: "red", below: "green" },
  { variant: 11, quantity: "width", ranges: { JOY_D: [0, 0.2 * MS], JOY_B: [0.2 * MS, 0.4 * MS], JOY_A: [0.4 * MS, 0.6 * MS], JOY_C: [0.6 * MS, 0.8 * MS] }, first: "JOY_D", fixed: { hz: 1000 }, above: "both", within: "none", below: "one" },
  { variant: 12, quantity: "gap", ranges: { JOY_C: [0, 0.5 * MS], JOY_A: [0.5 * MS, 1.0 * MS], JOY_B: [1.0 * MS, 1.5 * MS], JOY_D: [1.5 * MS, 2.0 * MS] }, first: "JOY_C", fixed: { hz: 250 }, above: "none", within: "both", below: "one" },
]

const LIGHTS: Record<Lights, [boolean, boolean, boolean]> = {
  red: [true, false, false],
  green: [false, true, false],
  blue: [false, false, true],
  both: [true, true, false],
  one: [true, false, false],
  none: [false, false, false],
}

type Source = { period: number; high: number }

function signalFor(m: MeterVariant, value: number): Source {
  if ("duty" in m.fixed) {
    const period = Math.round(m.quantity === "frequency" ? TIMER_HZ / value : value * TIMER_HZ)
    return { period, high: Math.round(period * m.fixed.duty) }
  }
  const period = Math.round(TIMER_HZ / m.fixed.hz)
  const part = Math.round(value * TIMER_HZ)
  const high = m.quantity === "width" ? part : period - part
  if (high <= 0) return { period: 0, high: 0 }
  if (high >= period) return { period: 0, high: 1 }
  return { period, high }
}

function truthOf(m: MeterVariant, s: Source): number {
  const fixedPeriod = "hz" in m.fixed ? 1 / m.fixed.hz : 0
  if (s.period === 0) {
    const high = s.high !== 0
    return m.quantity === "width" ? (high ? fixedPeriod : 0) : high ? 0 : fixedPeriod
  }
  if (m.quantity === "frequency") return TIMER_HZ / s.period
  if (m.quantity === "period") return s.period / TIMER_HZ
  return (m.quantity === "width" ? s.high : s.period - s.high) / TIMER_HZ
}

function pointsOf(m: MeterVariant, [lo, hi]: [number, number]) {
  const top = "hz" in m.fixed ? 1 / m.fixed.hz : Infinity
  const points: { name: string; value: number }[] = []
  if (lo > 0) points.push({ name: "just below", value: lo * (1 - NEAR_BOUND) }, { name: "just inside the bottom", value: lo * (1 + NEAR_BOUND) })
  else points.push({ name: "zero", value: 0 }, { name: "just above zero", value: hi * NEAR_BOUND * 5 })
  points.push({ name: "middle", value: (lo + hi) / 2 })
  if (hi >= top) points.push({ name: "the whole period", value: hi })
  else points.push({ name: "just inside the top", value: hi * (1 - NEAR_BOUND) }, { name: "just above", value: hi * (1 + NEAR_BOUND) })
  return points
}

const verdict = (m: MeterVariant, value: number, [lo, hi]: [number, number]): Lights => (value > hi ? m.above : value < lo ? m.below : m.within)
const displayed = (m: MeterVariant, raw: number) => (m.quantity === "frequency" ? raw / 1000 : raw === 0xffffffff ? Infinity : raw * 1e-9)

async function apply(b: Lab2Bench, source: Source) {
  const [sequence] = await b.words("bench_source", 1)
  await b.write("bench_source", [source.period, source.high], 2)
  await b.write("bench_source", [sequence + 1])
  for (let i = 0; i < 100; i++) {
    b.run(0.001)
    if ((await b.words("bench_source", 2))[1] === sequence + 1) break
  }
  const start = (await state(b)).measurements
  for (let i = 0; i < 200; i++) {
    b.run(0.001)
    if ((await state(b)).measurements >= start + 3) return state(b)
  }
  throw new Error(`no measurement for ${JSON.stringify(source)}`)
}

describe.each(METERS)("lab 2 variant $variant: $quantity meter by PWM-input capture on TIM2 (PA15), signal from TIM5 (PH10)", (m) => {
  const b = bench(m.variant)

  beforeAll(() => booted(b, m.variant))
  afterAll(() => b.dispose())

  it(`starts on ${m.first}'s range, the first the brief lists`, async () => {
    expect((await state(b)).range).toBe(JOY_INDEX[m.first])
  })

  describe.each(Object.entries(m.ranges) as [Joy, [number, number]][])("%s: range %j", (joy, range) => {
    beforeAll(() => b.press(joy))

    it.each(pointsOf(m, range))("$name ($value): measured within 0.1 %, shown as the brief says", async ({ value }) => {
      const source = signalFor(m, value)
      const truth = truthOf(m, source)
      const s = await apply(b, source)
      expect(s.range, "range").toBe(JOY_INDEX[joy])
      const shown = displayed(m, s.value)
      if (truth === 0) expect(shown).toBe(0)
      else expect(Math.abs(shown - truth) / truth, `measured ${shown} for ${truth}`).toBeLessThanOrEqual(ACCURACY)
      const want = verdict(m, truth, range)
      expect(s.leds, `LEDs for ${want}`).toBe(LIGHTS[want].reduce((bits, on, i) => bits | (on ? 1 << i : 0), 0))
      b.run(EYE_SETTLED)
      expect(DIES.map((d) => b.lit(d)), `the LED on the board shows ${want}`).toEqual(LIGHTS[want])
    })
  })

  it("ignores the centre", async () => {
    const before = (await state(b)).range
    await b.press("JOY_CTR")
    expect((await state(b)).range).toBe(before)
  })
})

describe("lab 2 meters fed by the signal source part (exact edges, no second timer)", () => {
  it.each<{ variant: number; props: Record<string, string>; joy: Joy; truth: number; lights: Lights }>([
    { variant: 11, props: { freq: "1 kHz", width: "0.2002 ms" }, joy: "JOY_D", truth: 0.2002 * MS, lights: "both" },
    { variant: 11, props: { freq: "1 kHz", width: "0.1998 ms" }, joy: "JOY_D", truth: 0.1998 * MS, lights: "none" },
    { variant: 3, props: { freq: "400.8 Hz", duty: "50" }, joy: "JOY_C", truth: 400.8, lights: "red" },
    { variant: 12, props: { freq: "250 Hz", width: "3.502 ms" }, joy: "JOY_C", truth: 0.498 * MS, lights: "both" },
  ])("variant $variant on $props.freq: $truth measured within 0.1 %, $lights", async ({ variant, props, joy, truth, lights }) => {
    const m = METERS.find((x) => x.variant === variant)!
    const b = new Lab2Bench({ elf: "lab2-variants.elf", image: patchWord(ELF, "lab2_variant", variant), rgb: { R: "PD12", G: "PD13", B: "PD14" }, pulse: { pad: "PA15", props } })
    try {
      await booted(b, variant)
      await b.press(joy)
      b.run(EYE_SETTLED)
      const s = await state(b)
      const shown = displayed(m, s.value)
      expect(Math.abs(shown - truth) / truth).toBeLessThanOrEqual(ACCURACY)
      expect(DIES.map((d) => b.lit(d))).toEqual(LIGHTS[lights])
    } finally {
      b.dispose()
    }
  })
})
