import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Lab2Bench, type Joy } from "../lib/lab2-bench"

const ELF = "lab2-rgb-pwm.elf"
const SYSCLK = 216e6
const PWM_HZ = 100
const PERIOD = 1 / PWM_HZ
const LEVEL_MIN = 5
const LEVEL_MAX = 95
const RING = LEVEL_MAX - LEVEL_MIN + 1
const DIES = { R: "PD12", G: "PD13", B: "PD14" } as const
type Die = keyof typeof DIES
const STEPS: Partial<Record<Joy, [Die, number]>> = { JOY_C: ["R", 5], JOY_B: ["G", 10], JOY_A: ["B", 30] }

const ring = (level: number) => (level > LEVEL_MAX ? level - RING : level)

describe("our lab 2 (stm32_labs lab2-v3, unchanged) on the Open746I-C, the joystick bouncing as shipped", () => {
  const b = new Lab2Bench({ elf: ELF, probes: Object.values(DIES), rgb: { ...DIES } })
  const levels: Record<Die, number> = { R: LEVEL_MIN, G: LEVEL_MIN, B: LEVEL_MIN }
  const duty = (die: Die) => {
    const from = b.time
    b.run(4 * PERIOD)
    return b.pwm(DIES[die], from)
  }
  const expectLevels = (label: string) => {
    for (const die of Object.keys(DIES) as Die[]) {
      const pwm = duty(die)
      expect.soft(1 / pwm.period, `${label}: ${die} at ${PWM_HZ} Hz`).toBeNearRel(PWM_HZ, 1e-6)
      expect.soft(pwm.duty, `${label}: ${die} at ${levels[die]} %`).toBeNear(levels[die] / 100, 1e-6)
    }
  }

  beforeAll(async () => {
    await b.boot()
    b.run(0.1)
  })
  afterAll(() => b.dispose())

  it("runs at 216 MHz and starts every die at 5 % of a 100 Hz period", () => {
    expect(b.snapshot().mcus[b.u]?.sysclk).toBe(SYSCLK)
    expectLevels("boot")
  })

  it.each(Object.entries(STEPS) as [Joy, [Die, number]][])("%s steps its die by its percentage once per press, the debounce taking every re-strike, and wraps round past 95 % (the brigade's «циклічне»)", async (joy, [die, step]) => {
    const presses = Math.ceil((LEVEL_MAX - levels[die]) / step) + 1
    for (let i = 0; i < presses; i++) {
      await b.press(joy)
      levels[die] = ring(levels[die] + step)
    }
    expect(levels[die], "the walk went past 95 % and wrapped").toBeLessThan(LEVEL_MAX)
    expectLevels(`${presses} presses of ${joy}`)
  })

  it("D changes nothing, and the centre puts all three dies at 95 %", async () => {
    await b.press("JOY_D")
    expectLevels("after D")
    await b.press("JOY_CTR")
    levels.R = levels.G = levels.B = LEVEL_MAX
    expectLevels("after the centre")
  })
})
