/**
 * ADC/DAC: firmware/hal/Src/adc.c on the F429 model with a scripted voltage on PA3; the PWM duty
 * on PB0 follows it, VREFINT is read through the internal channel, and the DAC on PA4 plays its
 * sine through TIM6 + DMA.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"
import { buffer, hal } from "../lib/firmware"

const A0 = parsePad("PA3")!
const LD1 = parsePad("PB0")!
const DAC1 = parsePad("PA4")!

describe("ADC1 and DAC1 on the F429", () => {
  const mcu = new Stm32F429()
  mcu.load(buffer(hal("adc.elf")), "adc.elf")
  let a0Volts = 1.0
  mcu.analogRead = (pad) => (pad.port === A0.port && pad.pin === A0.pin ? a0Volts : null)
  const word = (name: string) => mcu.bus.read32(mcu.firmware!.symbols.find((s) => s.name === name)!.value)

  const dacSamples: { t: number; v: number }[] = []
  function run(seconds: number, step = 50e-6) {
    const end = mcu.time + seconds
    while (mcu.time < end && mcu.running) {
      if (!mcu.run(step)) break
      const d = mcu.padDrive(DAC1)
      if (typeof d === "number") dacSamples.push({ t: mcu.time, v: d })
    }
  }
  function duty(seconds: number) {
    mcu.takeDuty(LD1, 0)
    const t0 = mcu.time
    run(seconds)
    return mcu.takeDuty(LD1, mcu.time - t0) ?? -1
  }

  describe("A0 → PWM duty on LD1", () => {
    beforeAll(() => run(0.03))

    it("keeps the core running without HAL errors", () => {
      expect(mcu.cpu.halted?.message).toBeUndefined()
      expect(mcu.running).toBe(true)
      expect(word("errors")).toBe(0)
    })

    it("reads VREFINT as 1.21 V", () => {
      // 1.21 V / 3.3 V × 4095
      expect(word("vrefint")).toBeNear(1502, 2)
    })

    it("follows 1.0 V on A0", () => {
      expect.soft(word("adcValue"), "counts").toBeNear(1241, 2)
      expect.soft(duty(0.02), "PWM duty (30 %)").toBeNear(0.303, 0.01)
    })

    it("follows 2.5 V on A0", () => {
      a0Volts = 2.5
      run(0.02)
      expect.soft(word("adcValue"), "counts").toBeNear(3102, 2)
      expect.soft(duty(0.02), "PWM duty (76 %)").toBeNear(0.757, 0.01)
    })

    it("clips above VREF at 4095", () => {
      a0Volts = 3.6
      run(0.02)
      expect(word("adcValue")).toBe(4095)
    })

    it("samples every ~11 ms", () => {
      expect(word("samples")).toBeNear(8, 2)
    })
  })

  describe("DAC1 sine via TIM6 TRGO + DMA", () => {
    let recent: { t: number; v: number }[] = []
    beforeAll(() => {
      recent = dacSamples.filter((s) => s.t > mcu.time - 0.06)
    })

    it("swings from 0 to VREF", () => {
      expect.soft(Math.max(...recent.map((s) => s.v)), "peak (V)").toBeNear(3.3, 0.05)
      expect.soft(Math.min(...recent.map((s) => s.v)), "trough (V)").toBeNear(0, 0.05)
    })

    it("has a 20 ms (50 Hz) period", () => {
      // Period: time between successive upward crossings of mid-scale.
      const crossings: number[] = []
      for (let i = 1; i < recent.length; i++) if (recent[i - 1].v < 1.65 && recent[i].v >= 1.65) crossings.push(recent[i].t)
      const period = crossings.length >= 2 ? (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1) : 0
      expect(period * 1e3).toBeNear(20, 0.2)
    })

    it("steps through 17 distinct levels", () => {
      // A 32-point sine has 17 distinct levels (it is symmetric about its peaks).
      expect(new Set(recent.map((s) => Math.round(s.v * 1000))).size).toBe(17)
    })

    it("touches no unmodelled features", () => {
      expect(mcu.unmodelled.summary()).toHaveLength(0)
    })
  })
})
