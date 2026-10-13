import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { partKey } from "@/schematic/types"
import { Lab2Bench, type Joy } from "../lib/lab2-bench"

const ELF = "lab2-f746.elf"
const SYSCLK = 50e6
const COUNTS = (999 + 1) * (1000 + 1)
const PERIOD = COUNTS / SYSCLK
const PWM_HZ = SYSCLK / COUNTS
const PADS = ["PD12", "PD13", "PD14"] as const
const INITIAL_PULSES = [999, 499, 0]
const DUTY_START = 950
const DUTY_MIN = 50
const DUTY_MAX = 950
const u32 = (x: number) => x >>> 0
const STEP: Record<Joy, (d: number) => number> = {
  JOY_A: (d) => (u32(d + 10) > DUTY_MAX ? DUTY_MAX : u32(d + 10)),
  JOY_B: (d) => (u32(d + 100) > DUTY_MAX ? DUTY_MAX : u32(d + 100)),
  JOY_C: (d) => (u32(d - 1) < DUTY_MIN ? DUTY_MIN : u32(d - 10)),
  JOY_D: (d) => (u32(d - 100) < DUTY_MIN ? DUTY_MIN : u32(d - 100)),
  JOY_CTR: () => DUTY_MIN,
}
const SEQUENCE: Joy[] = ["JOY_A", "JOY_D", "JOY_D", "JOY_C", "JOY_B", "JOY_CTR", "JOY_C", "JOY_B", "JOY_A", "JOY_D", "JOY_B", "JOY_B"]

describe("the lecturer's lab 2 (Laba2.elf, unchanged) on the Open746I-C", () => {
  const b = new Lab2Bench({ elf: ELF, probes: [...PADS], bounce: false })
  const duty = async () => (await b.words("duty_cycle", 1))[0]
  const measured = (pad: string) => {
    const from = b.time
    b.run(3 * PERIOD)
    return b.pwm(pad, from)
  }

  beforeAll(async () => {
    await b.boot()
    b.run(0.1)
  })
  afterAll(() => b.dispose())

  it("runs at 50 MHz from the 8 MHz crystal through PLLM 8, PLLN 100, PLLP 2", () => {
    const st = b.snapshot().mcus[b.u]
    expect(st?.halted, "halted").toBeFalsy()
    expect(st?.sysclk).toBe(SYSCLK)
  })

  it("lights USERLED3 and USERLED4 (PH4, PI8), not LEDs 1–4 as its comments say", () => {
    const parts = b.snapshot().parts
    expect(["LED1", "LED2", "LED3", "LED4"].map((led) => parts[partKey(b.u, led)]?.on)).toEqual([false, false, true, true])
  })

  it(`puts TIM4 PWM on PD12–PD14 at ${PWM_HZ.toFixed(3)} Hz (PSC 999, ARR 1000), starting at pulses 999 / 499 / 0`, () => {
    PADS.forEach((pad, i) => {
      if (INITIAL_PULSES[i] === 0) {
        expect(b.edges(pad).length, `${pad} stays low`).toBe(0)
        return
      }
      const pwm = measured(pad)
      expect(1 / pwm.period, `${pad} frequency`).toBeNearRel(PWM_HZ, 1e-6)
      expect(pwm.duty, `${pad} duty`).toBeNear(INITIAL_PULSES[i] / 1001, 1e-6)
    })
  })

  it("steps one duty for all three channels on each EXTI falling edge: A +1 %, B +10 %, C −1 %, D −10 %, the centre to 5 %, clamped to 5…95 %", async () => {
    let want = DUTY_START
    expect(await duty()).toBe(want)
    for (const joy of SEQUENCE) {
      await b.press(joy)
      want = STEP[joy](want)
      expect.soft(await duty(), `after ${joy}`).toBe(want)
    }
    for (const pad of PADS) expect(measured(pad).duty, pad).toBeNear(want / 1001, 1e-6)
  })

  it("wraps its unsigned duty on D below 10 %: (50 − 100) is not < 50 for a uint32_t, so the LEDs go fully on", async () => {
    await b.press("JOY_CTR")
    await b.press("JOY_D")
    expect(await duty()).toBe(u32(DUTY_MIN - 100))
    const from = b.time
    b.run(3 * PERIOD)
    for (const pad of PADS) {
      const edges = b.edges(pad)
      expect(edges.filter((e) => e.time > from), `${pad} stops switching`).toEqual([])
      expect(edges[edges.length - 1].level, `${pad} stays high: CCR1 = ${u32(DUTY_MIN - 100) & 0xffff} > ARR`).toBe(true)
    }
    await b.press("JOY_B")
    expect(await duty(), "B adds 100 and wraps back to 50").toBe(DUTY_MIN)
  })
})

describe("the lecturer's lab 2 with the joystick bouncing as shipped", () => {
  const b = new Lab2Bench({ elf: ELF })

  beforeAll(async () => {
    await b.boot()
    b.run(0.1)
  })
  afterAll(() => b.dispose())

  it("takes several steps for one press: no debounce, so every re-strike's falling edge counts", async () => {
    await b.press("JOY_CTR")
    const steps: number[] = []
    for (let i = 0; i < 3; i++) {
      const before = (await b.words("duty_cycle", 1))[0]
      await b.press("JOY_A")
      steps.push(((await b.words("duty_cycle", 1))[0] - before) / 10)
    }
    expect(Math.max(...steps), `steps per press of A: ${steps.join(", ")}`).toBeGreaterThan(1)
  })
})
