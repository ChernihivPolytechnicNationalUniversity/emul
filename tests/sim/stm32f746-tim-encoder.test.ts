import { beforeAll, describe, expect, it } from "vitest"
import { WiredCore } from "../lib/wired-core"

const US = 1e-6
const ENCODERS = { TIM3: ["PB4", "PB5"], TIM4: ["PD12", "PD13"], TIM2: ["PA15", "PB3"], TIM8: ["PC6", "PC7"] } as const
const FORWARD: [boolean, boolean][] = [
  [true, false],
  [true, true],
  [false, true],
  [false, false],
]
const BACKWARD: [boolean, boolean][] = [
  [false, true],
  [true, true],
  [true, false],
  [false, false],
]
const DIR = 1 << 4

describe("STM32F746 encoder interface", () => {
  const core = new WiredCore("timers-encoder.elf")
  const cnt = (tim: string) => core.timer(tim).read("CNT")
  const signed = (value: number, bits: number) => (value >= 2 ** (bits - 1) ? value - 2 ** bits : value)

  const turn = (pads: readonly [string, string], cycles: number, forward: boolean) => {
    let t = core.time + 10 * US
    for (let i = 0; i < cycles; i++)
      for (const [a, b] of forward ? FORWARD : BACKWARD) {
        core.drive(pads[0], a, t)
        core.drive(pads[1], b, t + 0.5 * US)
        t += 2 * US
      }
    core.runUntil(t + 10 * US)
  }

  beforeAll(() => {
    core.until(() => core.word("encoder_bench") === 1, 0.01)
  })

  it.each([
    { tim: "TIM3", mode: "3 (both inputs)", perCycle: 4, bits: 16 },
    { tim: "TIM4", mode: "1 (TI1 edges)", perCycle: 2, bits: 16 },
    { tim: "TIM2", mode: "2 (TI2 edges)", perCycle: 2, bits: 32 },
  ] as const)("$tim in encoder mode $mode counts $perCycle per cycle: 10 forward, 3 back", ({ tim, perCycle, bits }) => {
    turn(ENCODERS[tim], 10, true)
    expect(signed(cnt(tim), bits), "forward").toBe(10 * perCycle)
    expect(core.timer(tim).read("CR1") & DIR, "DIR up").toBe(0)
    turn(ENCODERS[tim], 3, false)
    expect(signed(cnt(tim), bits), "back").toBe(7 * perCycle)
    expect(core.timer(tim).read("CR1") & DIR, "DIR down").toBe(DIR)
  })

  it("wraps TIM8 between 0 and ARR = 99 both ways with an update each time", () => {
    turn(ENCODERS.TIM8, 30, true)
    expect(cnt("TIM8")).toBe(20)
    expect(core.word("encoder_bench", 1), "overflows").toBe(1)
    turn(ENCODERS.TIM8, 10, false)
    expect(cnt("TIM8")).toBe(80)
    expect(core.word("encoder_bench", 1), "and an underflow").toBe(2)
  })

  it("does not count while the shaft stands still", () => {
    const before = cnt("TIM3")
    core.run(1e-3)
    expect(cnt("TIM3")).toBe(before)
  })
})
