import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ALL, Bench, board, DARK, HOLD, intervals, PWM_SLOT, SAME_WRITE, TICK, type Position } from "../lib/lab1-bench"

type Fade = {
  variant: number
  towards: "100 %" | "0 %"
  keys: { more: Position; fewer: Position; longer: Position; shorter: Position }
  states: [fewest: number, most: number]
  seconds: [shortest: number, longest: number]
  before: string
  after: string
}

const FADES: Fade[] = [
  { variant: 5, towards: "100 %", keys: { more: "A", fewer: "B", longer: "C", shorter: "D" }, states: [5, 10], seconds: [5, 10], before: DARK, after: ALL },
  { variant: 11, towards: "0 %", keys: { more: "B", fewer: "A", longer: "D", shorter: "C" }, states: [10, 15], seconds: [10, 15], before: ALL, after: DARK },
]

describe("lab 1 on the Open746I-C, variants 5 and 11: the smooth fades, the joystick bouncing as the board ships", () => {
  it("bounces the joystick", () => {
    expect(board.defaults?.bounce).toBe("on")
  })

  describe.each(FADES)("variant $variant: a smooth fade to $towards", (v) => {
    let b!: Bench
    beforeAll(() => {
      b = new Bench(v.variant)
      b.run(0.3)
    })
    afterAll(() => b.dispose())

    const fade = (states: number, seconds: number, during?: () => void) => {
      const pressedAt = b.now
      b.press("CTR")
      if (during) during()
      b.run(seconds + 0.3 - (b.now - pressedAt))
      const s = b.series("PB6")
      const times = [...s.times]
      const levels = [...s.levels]
      const from = times.findIndex((t) => t > pressedAt)
      const period = (states + 1) * PWM_SLOT
      const runs: { level: number; firstRise: number }[] = []
      for (let i = from; i + 2 < times.length; i++) {
        if (levels[i] !== 1 || levels[i + 1] !== 0 || levels[i + 2] !== 1) continue
        if (Math.abs(times[i + 2] - times[i] - period) > TICK / 2) continue
        const duty = (times[i + 1] - times[i]) / period
        const level = Math.round(duty * (states + 1))
        expect.soft(duty, "a duty of i/(N + 1)").toBeNear(level / (states + 1), 0.002)
        if (runs.at(-1)?.level !== level) runs.push({ level, firstRise: times[i] })
      }
      const fallAt = (t: number) => times.some((edge, i) => levels[i] === 0 && Math.abs(edge - t) < TICK / 2)
      const startedHigh = (r: { level: number; firstRise: number }) => fallAt(r.firstRise - period + r.level * PWM_SLOT)
      const segment = seconds / (states + 1)
      const starts = runs.map((r) => (startedHigh(r) ? r.firstRise - period : r.firstRise))
      const start = starts[0] - segment
      return { runs, starts, segment, start, pressedAt, settledFrom: times.filter((t) => t > pressedAt).at(-1)! }
    }

    const check = (states: number, seconds: number, during?: () => void) => {
      const f = fade(states, seconds, during)
      const want = Array.from({ length: states }, (_, i) => (v.towards === "100 %" ? i + 1 : states - i))
      expect.soft(f.runs.map((r) => r.level), `${states} intermediate states`).toEqual(want)
      for (const dt of intervals(f.starts.map((time) => ({ time, leds: "" })))) expect.soft(dt, "each state lasts T/(N + 1)").toBeNear(f.segment, 1.5 * TICK)
      expect.soft(f.start - f.pressedAt, "starts on the debounced press").toBeGreaterThan(0.02)
      expect.soft(f.start - f.pressedAt, "starts on the debounced press").toBeLessThan(HOLD)
      expect.soft(f.settledFrom - f.start, `reaches ${v.towards} after T = ${seconds} s`).toBeGreaterThan(seconds - (states + 1) * PWM_SLOT)
      expect.soft(f.settledFrom - f.start, `reaches ${v.towards} after T = ${seconds} s`).toBeLessThanOrEqual(seconds + TICK)
      expect.soft(b.ledsAt(b.now), "and stays there").toBe(v.after)
      for (const pad of ["PB7", "PH4", "PI8"] as const) {
        const own = [...b.series(pad).times].filter((t) => t > f.pressedAt)
        const led1 = [...b.series("PB6").times].filter((t) => t > f.pressedAt)
        expect.soft(own.length, `${pad} fades with LED1`).toBe(led1.length)
        expect.soft(Math.max(...own.map((t, i) => Math.abs(t - led1[i]))), `${pad} edges with LED1's`).toBeLessThan(SAME_WRITE)
      }
    }

    it(`starts at ${v.before}`, () => {
      expect(b.ledsAt(b.now)).toBe(v.before)
    })

    it(`${v.keys.fewer} and ${v.keys.shorter} hold at the bottom; the centre fades all four LEDs through ${v.states[0]} states over ${v.seconds[0]} s, ignoring the joystick meanwhile`, () => {
      b.press(v.keys.fewer, 2)
      b.press(v.keys.shorter, 2)
      check(v.states[0], v.seconds[0], () => b.press(v.keys.more, 2))
    })

    it(`${v.keys.more} adds one state: the two presses during the fade did not count`, () => {
      b.press(v.keys.more)
      check(v.states[0] + 1, v.seconds[0])
    })

    it(`${v.keys.more} and ${v.keys.longer} stop at ${v.states[1]} states and ${v.seconds[1]} s`, () => {
      b.press(v.keys.more, v.states[1] - v.states[0] + 1)
      b.press(v.keys.longer, v.seconds[1] - v.seconds[0] + 1)
      check(v.states[1], v.seconds[1])
    })

    it(`${v.keys.fewer} and ${v.keys.shorter} step back down from the top, one state and one second each`, () => {
      b.press(v.keys.fewer)
      b.press(v.keys.shorter)
      check(v.states[1] - 1, v.seconds[1] - 1)
    })
  })
})
