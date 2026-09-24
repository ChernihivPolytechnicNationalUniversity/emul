/**
 * Timers: firmware/hal/Src/pwm.c on the F429 model, measured at the pads.
 *   TIM3 CH3 PWM 1 kHz on PB0, duty stepping 10 % → 90 % every 100 ms
 *   TIM2 update interrupt at 200 Hz toggling PB7 (100 Hz square)
 *   TIM4 CH1 input capture on PB6, fed from PB0 here the way a wire would
 *   TIM1 CH1 / CH1N 20 kHz on PE9 / PE8, 30 % duty, complementary
 */
import { beforeAll, describe, expect, it } from "vitest"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"
import { buffer, hal } from "../lib/firmware"

const PB0 = parsePad("PB0")!
const PB6 = parsePad("PB6")!
const PB7 = parsePad("PB7")!
const PE8 = parsePad("PE8")!
const PE9 = parsePad("PE9")!

type Edges = { t: number; level: boolean }[]

const stats = (e: Edges) => {
  const rises = e.filter((x) => x.level).map((x) => x.t)
  const falls = e.filter((x) => !x.level).map((x) => x.t)
  if (rises.length < 3) return { period: 0, duty: 0, n: rises.length }
  const periods = rises.slice(1).map((t, i) => t - rises[i])
  const period = periods.reduce((a, b) => a + b, 0) / periods.length
  const highs = rises
    .slice(0, -1)
    .map((r) => {
      const f = falls.find((t) => t > r)
      return f === undefined ? NaN : f - r
    })
    .filter((x) => !Number.isNaN(x))
  const duty = highs.reduce((a, b) => a + b, 0) / highs.length / period
  return { period, duty, n: rises.length }
}

describe("timers on the F429", () => {
  const mcu = new Stm32F429()
  mcu.load(buffer(hal("pwm.elf")), "pwm.elf")
  const word = (name: string) => mcu.bus.read32(mcu.firmware!.symbols.find((s) => s.name === name)!.value)

  function record(seconds: number, step = 1e-6) {
    const edges: Record<string, Edges> = { PB0: [], PB7: [], PE8: [], PE9: [] }
    const last: Record<string, boolean | null> = { PB0: null, PB7: null, PE8: null, PE9: null }
    const pads = { PB0, PB7, PE8, PE9 }
    const end = mcu.time + seconds
    while (mcu.time < end && mcu.running) {
      if (!mcu.run(step)) break
      for (const [name, pad] of Object.entries(pads)) {
        const d = mcu.padDrive(pad)
        const level = d === "high" || d === "pullup"
        if (last[name] !== null && level !== last[name]) edges[name].push({ t: mcu.time, level })
        last[name] = level
      }
      mcu.setPad(PB6, last.PB0 === true)
    }
    return edges
  }

  describe("after boot", () => {
    beforeAll(() => {
      mcu.run(0.002)
    })

    it("keeps the core running", () => {
      expect(mcu.cpu.halted?.message).toBeUndefined()
      expect(mcu.running).toBe(true)
    })

    it("clocks the timers", () => {
      expect.soft(mcu.clocks.sysclk, "SYSCLK").toBe(180e6)
      expect.soft(mcu.clocks.timclk1, "APB1 timer clock (2 × PCLK1)").toBe(90e6)
      expect.soft(mcu.clocks.timclk2, "APB2 timer clock (2 × PCLK2)").toBe(180e6)
      expect.soft(mcu.tim.filter((t) => t.running).length, "timers running").toBe(4)
    })

    it("has PB0 claimed by TIM3", () => {
      expect(mcu.padDrive(PB0)).not.toBeNull()
    })
  })

  describe("first 50 ms (duty 10 %)", () => {
    let e: Record<string, Edges>
    beforeAll(() => {
      e = record(0.05)
    })

    it("puts TIM3 PWM on PB0", () => {
      const s = stats(e.PB0)
      expect.soft(s.period * 1e6, "period (µs)").toBeNearRel(1000, 0.002)
      expect.soft(s.duty, "duty").toBeNear(0.1, 0.02)
    })

    it("toggles PB7 from the TIM2 update interrupt", () => {
      expect.soft(stats(e.PB7).period * 1e3, "square period (ms)").toBeNearRel(10, 0.002)
      expect.soft(word("tim2Ticks"), "update count").toBeNearRel(10, 0.1)
    })

    it("puts complementary TIM1 PWM on PE9 / PE8", () => {
      const s = stats(e.PE9)
      expect.soft(s.period * 1e6, "CH1 period (µs)").toBeNearRel(50, 0.002)
      expect.soft(s.duty, "CH1 duty").toBeNear(0.3, 0.02)
      expect.soft(stats(e.PE8).duty, "CH1N duty").toBeNear(0.7, 0.02)
      const complementary = e.PE8.every((x) => {
        const at = e.PE9.filter((y) => Math.abs(y.t - x.t) < 1e-9)
        return at.length === 1 && at[0].level !== x.level
      })
      expect.soft(complementary, "CH1N is the inverse of CH1 edge for edge").toBe(true)
    })

    it("captures PB0 on TIM4", () => {
      expect.soft(word("capturePeriodUs"), "period (µs)").toBeNearRel(1000, 0.002)
      expect.soft(word("captureHighUs"), "high time (µs)").toBeNearRel(100, 0.02)
    })
  })

  it("ramps the duty in 100 ms steps, the capture following", () => {
    for (const want of [20, 30, 40]) {
      // Skip to the middle of the next step and measure 20 ms there.
      const stepStart = Math.floor(mcu.time / 0.1 + 1) * 0.1 + 0.0011
      while (mcu.time < stepStart + 0.03) mcu.run(0.0005)
      const e = record(0.02)
      expect.soft(stats(e.PB0).duty * 100, `duty at ${(mcu.time * 1e3).toFixed(0)} ms`).toBeNearRel(want, 0.03)
      if (want === 40) expect.soft(word("captureHighUs"), "TIM4 capture high time (µs)").toBeNearRel(400, 0.01)
    }
  })
})
