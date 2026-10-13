import { beforeAll, describe, expect, it } from "vitest"
import { WiredCore } from "../lib/wired-core"

const TICK = 1 / 16e6
const ticks = (seconds: number) => Math.round(seconds / TICK)
const US = 1e-6
const FIELD = { ready: 0, widthPeriod: 1, widthHigh: 2, widthCount: 3, gapPeriod: 4, gapLow: 5, gapCount: 6, filteredCount: 7, filteredAt: 8, prescaledCount: 9, bothEdgesCount: 10, trcCount: 11, trcLast: 12, trcDelta: 13 } as const
const FILTER_SAMPLES = 8

describe("STM32F746 input capture", () => {
  const core = new WiredCore("timers-capture.elf")
  const field = (name: keyof typeof FIELD) => core.word("capture_bench", FIELD[name])

  const square = (pad: string, start: number, period: number, high: number, count: number) => {
    for (let i = 0; i < count; i++) {
      core.drive(pad, true, start + i * period)
      core.drive(pad, false, start + i * period + high)
    }
    return start + count * period
  }

  beforeAll(() => {
    core.until(() => field("ready") === 1, 0.01)
  })

  it.each([
    { f: 1000, duty: 0.3 },
    { f: 2500, duty: 0.75 },
    { f: 37, duty: 0.01 },
  ])("measures period and width of $f Hz at $duty duty on one pad in PWM-input mode (TIM2: CC1 on TI1, CC2 on TI1 indirect, reset on TI1FP1)", ({ f, duty }) => {
    const period = 1 / f
    const before = field("widthCount")
    const end = square("PA15", core.time + 10 * US, period, period * duty, 4)
    core.runUntil(end + period / 2)
    expect(field("widthCount") - before, "a capture at every rising edge").toBe(4)
    expect(field("widthPeriod")).toBeNear(ticks(period), 1)
    expect(field("widthHigh")).toBeNear(ticks(period * duty), 1)
  })

  it("measures the gap with the edges swapped (TIM5: reset on the falling edge, CC2 on the rising one)", () => {
    const period = 2e-3
    const low = 1.2e-3
    const start = core.time + 10 * US
    core.drive("PH10", true, start)
    for (let i = 0; i < 4; i++) {
      core.drive("PH10", false, start + 0.8e-3 + i * period)
      core.drive("PH10", true, start + 0.8e-3 + low + i * period)
    }
    core.runUntil(start + 4 * period + 0.5e-3)
    expect(field("gapCount"), "a capture at every falling edge").toBe(4)
    expect(field("gapPeriod")).toBeNear(ticks(period), 1)
    expect(field("gapLow")).toBeNear(ticks(low), 1)
  })

  it("drops a pulse shorter than the input filter (TIM3 IC1F: fCK_INT, N = 8) and captures a longer one N samples late", () => {
    const before = field("filteredCount")
    const glitch = core.time + 10 * US
    core.drive("PB4", true, glitch)
    core.drive("PB4", false, glitch + (FILTER_SAMPLES - 3) * TICK)
    core.runUntil(glitch + 10 * US)
    expect(field("filteredCount"), "a 5-tick glitch").toBe(before)
    const reference = core.timer("TIM3").read("CNT")
    const referenceAt = core.time
    const pulse = referenceAt + 10 * US
    core.drive("PB4", true, pulse)
    core.drive("PB4", false, pulse + (FILTER_SAMPLES + 2) * TICK)
    core.runUntil(pulse + 10 * US)
    expect(field("filteredCount"), "a 10-tick pulse").toBe(before + 1)
    const atEdge = (reference + (pulse - referenceAt) / TICK) % 65536
    expect(field("filteredAt") - atEdge).toBeGreaterThanOrEqual(FILTER_SAMPLES - 1.5)
    expect(field("filteredAt") - atEdge).toBeLessThanOrEqual(FILTER_SAMPLES + 0.5)
  })

  it("captures every 8th rising edge with IC1PSC = /8 (TIM4)", () => {
    const before = field("prescaledCount")
    const end = square("PD12", core.time + 10 * US, 4 * US, 2 * US, 16)
    core.runUntil(end + 10 * US)
    expect(field("prescaledCount") - before).toBe(2)
  })

  it("captures both edges with CC1P = CC1NP = 1 (TIM9)", () => {
    const before = field("bothEdgesCount")
    const end = square("PE5", core.time + 10 * US, 4 * US, 2 * US, 5)
    core.runUntil(end + 10 * US)
    expect(field("bothEdgesCount") - before).toBe(10)
  })

  it("captures TIM1's update events through TRC (TIM8 CC1S = 11, TS = ITR0): 1000 ticks apart", () => {
    core.run(1e-3)
    expect(field("trcCount")).toBeGreaterThan(10)
    expect(field("trcDelta")).toBe(1000)
  })
})
