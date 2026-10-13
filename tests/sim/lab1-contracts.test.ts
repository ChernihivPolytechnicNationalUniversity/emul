import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Bench, board, COUNTER_SHOWN_FOR, COUNTERS_IN_RAM, DARK, DEBOUNCED_TICKS, intervals, LED_PADS, NAIVE_TICKS, STEP_TOLERANCE, TICK, type Position } from "../lib/lab1-bench"

type Moving = {
  variant: number
  pattern: string
  keys: { rightToLeft: Position; leftToRight: Position; longer: Position; shorter: Position }
  centre: "stops" | "blanks, keeping the position"
  initial: string
  rightToLeft: string[]
  leftToRight: string[]
  lowest: number
  up: number[]
  down: number
}

const LIGHT = { initial: "●○○○", rightToLeft: ["○●○○", "○○●○", "○○○●", "●○○○", "○●○○"], leftToRight: ["●○○○", "○○○●", "○○●○", "○●○○", "●○○○"] }
const WALL = { initial: "●●○○", rightToLeft: ["○●●○", "○○●●", "●○○●", "●●○○", "○●●○"], leftToRight: ["●●○○", "●○○●", "○○●●", "○●●○", "●●○○"] }
const FILL = {
  initial: "●○○○",
  rightToLeft: ["●●○○", "●●●○", "●●●●", "●●●○", "●●○○", "●○○○", "●●○○"],
  leftToRight: ["○○●●", "○●●●", "●●●●", "○●●●", "○○●●", "○○○●"],
}

const MOVING: Moving[] = [
  { variant: 1, pattern: "running light", keys: { rightToLeft: "C", leftToRight: "B", longer: "A", shorter: "D" }, centre: "stops", ...LIGHT, lowest: 1, up: [2, 3, 4, 5, 5], down: 4 },
  { variant: 2, pattern: "running wall", keys: { rightToLeft: "C", leftToRight: "B", longer: "A", shorter: "D" }, centre: "blanks, keeping the position", ...WALL, lowest: 1, up: [2.5, 4, 5.5, 7, 7], down: 5.5 },
  { variant: 6, pattern: "fill and drain", keys: { rightToLeft: "C", leftToRight: "B", longer: "A", shorter: "D" }, centre: "stops", ...FILL, lowest: 0.5, up: [0.7, 0.9, 1.1, 1.3, 1.5, 1.5], down: 1.3 },
  { variant: 7, pattern: "running light", keys: { rightToLeft: "B", leftToRight: "C", longer: "D", shorter: "A" }, centre: "stops", ...LIGHT, lowest: 0.5, up: [1, 1.5, 2, 2.5, 3, 3.5, 3.5], down: 3 },
  { variant: 8, pattern: "running wall", keys: { rightToLeft: "B", leftToRight: "C", longer: "D", shorter: "A" }, centre: "blanks, keeping the position", ...WALL, lowest: 0.5, up: [2.5, 4.5, 6.5, 7.5, 7.5], down: 5.5 },
  { variant: 12, pattern: "fill and drain", keys: { rightToLeft: "B", leftToRight: "C", longer: "D", shorter: "A" }, centre: "stops", ...FILL, lowest: 1.4, up: [1.8, 2.2, 2.6, 3, 3.4, 3.4], down: 3 },
]

type Blink = { variant: number; keys: { faster: Position; slower: Position; more: Position; fewer: Position }; hertz: number[]; down: number[] }

const BLINK: Blink[] = [
  { variant: 3, keys: { faster: "A", slower: "D", more: "C", fewer: "B" }, hertz: [2, 4, 6, 8, 10, 12, 12], down: [10, 8, 6, 4, 2, 2] },
  { variant: 9, keys: { faster: "D", slower: "A", more: "B", fewer: "C" }, hertz: [3, 6, 9, 12, 15, 15], down: [12, 9, 6, 3, 3] },
]

type Counters = { variant: number; start: number; order: Position[]; presses: Partial<Record<Position, number>>; shown: string[]; wrapPresses: [Position, number]; wrapShown: string }

const COUNTERS: Counters[] = [
  { variant: 4, start: 0, order: ["A", "B", "C", "D"], presses: { A: 3, B: 1, C: 5 }, shown: ["●●○○", "●○○○", "●○●○", "○○○○"], wrapPresses: ["A", 14], wrapShown: "●○○○" },
  { variant: 10, start: 15, order: ["D", "C", "B", "A"], presses: { D: 3, B: 15 }, shown: ["○○●●", "●●●●", "○○○○", "●●●●"], wrapPresses: ["C", 16], wrapShown: "●●●●" },
]

export const DOUBTS_RESOLVED = {
  initialValues: "every setting starts at the bottom of its range (dwell, blink frequency, blinking LEDs 1, fade states and duration); moving patterns start stopped, showing their first picture",
  rightToLeft: "USERLED1 is the right-hand end of the indicator: «справа наліво» runs LED1 → LED4, and LED1 is bit 0 of a binary number",
  wall: "two adjacent LEDs rotate by one; at the edge they wrap one at a time («по черзі»): LED3+LED4, LED4+LED1, LED1+LED2",
  fillAndDrain: "the bar grows from the end it is anchored at (LED1 for right to left, LED4 for left to right) to all four, shrinks back to one, grows again; the other direction re-anchors it at once",
  variant8: "steps of 2 s from 0.5 s clamp at the top and bottom: 0.5, 2.5, 4.5, 6.5, 7.5 and back 5.5, 3.5, 1.5, 0.5 («поки не досягне» reaches the limit)",
  blinking: "LED1…LEDn blink together at 50 %, the rest dark; the centre stops the blinking with the n LEDs lit and a second press resumes it",
  counters: "the four LEDs show each count modulo 16 (LED1 the least significant bit), so 15 + 1 shows 0 and 0 − 1 shows 15; the centre starts and stops a display that shows each counter for 1 s in the brief's order, cyclically",
  fades: "duration steps of 1 s; N intermediate states are N + 1 equal segments over T at duties i/(N + 1), software PWM in 0.5 ms slots on all four LEDs; the LEDs keep the end level; every centre press restarts the fade from its start level",
  debounce: "the five lines are sampled every 100 µs and a change is taken once it has held for 20 ms",
} as const

describe("lab 1 on the Open746I-C, every variant, the joystick bouncing as the board ships", () => {
  it("bounces the joystick", () => {
    expect(board.defaults?.bounce).toBe("on")
  })

  describe.each(MOVING)("variant $variant: $pattern", (v) => {
    let b!: Bench
    beforeAll(() => {
      b = new Bench(v.variant)
      b.run(0.3)
    })
    afterAll(() => b.dispose())

    it(`starts stopped on ${v.initial}`, () => {
      expect(b.ledsAt(b.now)).toBe(v.initial)
      expect(b.quietFor(1.5 * v.lowest)).toEqual([])
    })

    it(`${v.keys.rightToLeft} runs it right to left, LED1 → LED4, a step every ${v.lowest} s, wrapping`, () => {
      b.press(v.keys.rightToLeft)
      const rightToLeft = b.next(v.rightToLeft.length, (v.rightToLeft.length + 1) * v.lowest)
      expect(rightToLeft.map((c) => c.leds)).toEqual(v.rightToLeft)
      for (const dt of intervals(rightToLeft)) expect.soft(dt).toBeNear(v.lowest, STEP_TOLERANCE)
    })

    it(`${v.keys.leftToRight} turns it round, left to right`, () => {
      const pressedAt = b.now
      b.press(v.keys.leftToRight)
      const leftToRight = b.next(v.leftToRight.length, (v.leftToRight.length + 1) * v.lowest, pressedAt)
      expect(leftToRight.map((c) => c.leds)).toEqual(v.leftToRight)
      const steps = v.pattern === "fill and drain" ? leftToRight.slice(1) : leftToRight
      for (const dt of intervals(steps)) expect.soft(dt).toBeNear(v.lowest, STEP_TOLERANCE)
    })

    it(`the centre ${v.centre}`, () => {
      b.next(1, 2 * v.lowest)
      const before = b.ledsAt(b.now)
      b.press("CTR")
      const after = b.ledsAt(b.now)
      expect(after).toBe(v.centre === "stops" ? before : DARK)
      expect(b.quietFor(2 * v.lowest)).toEqual([])
      if (v.centre === "stops") return
      b.press(v.keys.rightToLeft)
      expect(b.ledsAt(b.now), "the wall comes back where it was").toBe(before)
    })

    it(`${v.keys.longer} lengthens the dwell by its step to the top and holds it there: ${v.up.join(", ")} s`, () => {
      if (v.centre === "stops") b.press(v.keys.rightToLeft)
      b.run(0.05)
      for (const dwell of v.up) {
        const [step] = b.next(1, 2 * dwell + 1)
        b.press(v.keys.longer)
        const [following] = b.next(1, 2 * dwell + 1)
        expect.soft(following.time - step.time, `dwell after ${v.keys.longer}`).toBeNear(dwell, STEP_TOLERANCE)
      }
    })

    it(`${v.keys.shorter} shortens it by the same step, down to ${v.lowest} s and no further`, () => {
      const [step] = b.next(1, 2 * v.up.at(-1)! + 1)
      b.press(v.keys.shorter)
      const [following] = b.next(1, 2 * v.down + 1)
      expect.soft(following.time - step.time, "one step down").toBeNear(v.down, STEP_TOLERANCE)
      b.press(v.keys.shorter, v.up.length + 1)
      const steps = b.next(3, 4 * v.down + 1)
      expect.soft(steps[2].time - steps[1].time, "at the bottom").toBeNear(v.lowest, STEP_TOLERANCE)
    })
  })

  describe.each(BLINK)("variant $variant: blinking", (v) => {
    let b!: Bench
    beforeAll(() => {
      b = new Bench(v.variant)
      b.run(0.3)
    })
    afterAll(() => b.dispose())

    const blinkPeriods = (pad: (typeof LED_PADS)[number], from: number) => {
      const s = b.series(pad)
      const rises = [...s.times].filter((t, i) => t > from && s.levels[i] === 1)
      const falls = [...s.times].filter((t, i) => t > from && s.levels[i] === 0)
      const highs = rises.slice(0, -1).map((r) => falls.find((f) => f > r)! - r)
      return { periods: intervals(rises.map((time) => ({ time, leds: "" }))), highs }
    }

    const measure = (hertz: number) => {
      const from = b.now + 0.01
      b.run(Math.max(0.6, 5 / hertz))
      const { periods, highs } = blinkPeriods("PB6", from)
      expect.soft(periods.length, `${hertz} Hz: periods seen`).toBeGreaterThanOrEqual(3)
      for (const p of periods) expect.soft(p, `${hertz} Hz period`).toBeNear(1 / hertz, 1.5 * TICK)
      for (const h of highs) expect.soft(h, `${hertz} Hz on time`).toBeNear(1 / (2 * hertz), 1.5 * TICK)
      return from
    }

    it(`blinks LED1 alone at ${v.hertz[0]} Hz from the start`, () => {
      const from = measure(v.hertz[0])
      for (const pad of ["PB7", "PH4", "PI8"] as const) expect.soft(b.changes(from).every((c) => c.leds.slice(1) === "○○○"), `${pad} dark`).toBe(true)
    })

    it(`${v.keys.faster} raises the frequency a step at a time to ${v.hertz.at(-1)} Hz and holds it`, () => {
      for (const hertz of v.hertz.slice(1)) {
        b.press(v.keys.faster)
        measure(hertz)
      }
    })

    it(`${v.keys.slower} lowers it back to ${v.down.at(-1)} Hz and holds it`, () => {
      for (const hertz of v.down) {
        b.press(v.keys.slower)
        measure(hertz)
      }
    })

    it(`${v.keys.more} blinks one LED more each time, up to all four; ${v.keys.fewer} one fewer, down to one`, () => {
      const blinking = () => {
        const from = b.now + 0.01
        b.run(2.5 / v.down.at(-1)!)
        const pictures = new Set(b.changes(from).map((c) => c.leds))
        return [...pictures].sort().reverse()
      }
      const lit = (n: number) => "●".repeat(n) + "○".repeat(4 - n)
      for (const n of [2, 3, 4, 4]) {
        b.press(v.keys.more)
        expect.soft(blinking(), `${n} blinking`).toEqual([lit(n), DARK])
      }
      for (const n of [3, 2, 1, 1]) {
        b.press(v.keys.fewer)
        expect.soft(blinking(), `${n} blinking`).toEqual([lit(n), DARK])
      }
    })

    it("the centre stops the blinking with the LEDs lit, and starts it again", () => {
      b.press(v.keys.more)
      b.press("CTR")
      expect(b.ledsAt(b.now)).toBe("●●○○")
      expect(b.quietFor(1)).toEqual([])
      b.press("CTR")
      measure(v.down.at(-1)!)
    })
  })

  describe.each(COUNTERS)("variant $variant: press counters from $start, shown in the order $order", (v) => {
    let b!: Bench
    beforeAll(() => {
      b = new Bench(v.variant)
      b.run(0.3)
    })
    afterAll(() => b.dispose())

    const showCycle = (want: string[]) => {
      const pressedAt = b.now
      b.press("CTR")
      const [first] = b.next(1, 1, pressedAt)
      const shown = [0.5, 1.5, 2.5, 3.5, 4.5].map((t) => {
        b.run(Math.max(0, first.time + t - b.now))
        return b.ledsAt(first.time + t)
      })
      expect(shown).toEqual([...want, want[0]])
      const slots = b.changes(first.time - TICK, first.time + 4)
      for (const c of slots) expect.soft((c.time - first.time) / COUNTER_SHOWN_FOR, "a counter's slot starts on the second").toBeNear(Math.round(c.time - first.time), 2 * TICK)
      b.press("CTR")
      expect(b.ledsAt(b.now), "the centre again stops the display").toBe(DARK)
    }

    it("shows nothing until the centre is pressed", () => {
      expect(b.ledsAt(b.now)).toBe(DARK)
      expect(b.quietFor(0.5)).toEqual([])
    })

    it(`counts every press once and shows the counters in the order ${v.order.join(", ")}, a second each, round and round`, () => {
      for (const [position, times] of Object.entries(v.presses)) b.press(position as Position, times)
      showCycle(v.shown)
    })

    it(`wraps round 16: ${v.wrapPresses[1]} more presses of ${v.wrapPresses[0]}`, () => {
      b.press(...v.wrapPresses)
      const pressedAt = b.now
      b.press("CTR")
      const [first] = b.next(1, 1, pressedAt)
      const slot = v.order.indexOf(v.wrapPresses[0])
      b.run(first.time + slot + 0.5 - b.now)
      expect(b.ledsAt(b.now)).toBe(v.wrapShown)
      b.press("CTR")
    })
  })

  describe("the debounce is what makes one press one count (variant 4)", () => {
    const counted = async (debounceTicks: number) => {
      const b = new Bench(4, debounceTicks)
      b.run(0.3)
      for (const position of ["A", "B", "C", "D"] as const) b.press(position)
      const reply = await b.loop.inspect(b.board, { ranges: [{ addr: COUNTERS_IN_RAM, size: 16 }] })
      b.dispose()
      const bytes = reply!.memory[0].bytes
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return [0, 1, 2, 3].map((i) => view.getUint32(4 * i, true))
    }

    it("debounced, each of A, B, C and D pressed once counts 1", async () => {
      expect(await counted(DEBOUNCED_TICKS)).toEqual([1, 1, 1, 1])
    })

    it("without the debounce, every re-strike of the contacts on the press and on the release counts", async () => {
      for (const [i, n] of (await counted(NAIVE_TICKS)).entries()) expect.soft(n, `counter ${"ABCD"[i]}`).toBeGreaterThan(1)
    })
  })
})
