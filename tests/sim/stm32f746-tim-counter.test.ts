import { describe, expect, it } from "vitest"
import { STM32F746IG } from "@/mcu/chip"
import { Tim, TIM_SPECS, type TimVersion } from "@/mcu/periph/tim"
import { parsePad, Stm32 } from "@/mcu/stm32f429"
import { buffer, example } from "../lib/firmware"

const OFFSET = { CR1: 0x00, CR2: 0x04, SMCR: 0x08, DIER: 0x0c, SR: 0x10, EGR: 0x14, CCMR1: 0x18, CCER: 0x20, CNT: 0x24, PSC: 0x28, ARR: 0x2c, RCR: 0x30, CCR1: 0x34 }
const CR1 = { CEN: 1, DIR: 1 << 4, ARPE: 1 << 7, center: (mode: number) => mode << 5 }
const UG = 1
const UIE = 1
const CC1IF = 2
const OC_TOGGLE = 3 << 4
const CC1S_TI1 = 1
const CC2S_TI2 = 1 << 8
const MMS_COMPARE_PULSE = 3 << 4
const SMS_ENCODER_BOTH = 3
const KERNEL_HZ = 1e6
const TICK = 1 / KERNEL_HZ

function timer(name: string, version: TimVersion = "v2") {
  const t = new Tim(TIM_SPECS.find((s) => s.name === name)!, version)
  t.setClock(KERNEL_HZ, KERNEL_HZ)
  const irqs: number[] = []
  const events: string[] = []
  const ref: boolean[] = []
  t.raiseIrq = (irq) => irqs.push(irq)
  t.onEvent = (event) => events.push(event)
  t.listen("OC", (level) => ref.push(level))
  const write = (reg: keyof typeof OFFSET, value: number) => t.write(OFFSET[reg], value >>> 0, 4)
  const read = (reg: keyof typeof OFFSET) => t.read(OFFSET[reg], 4) >>> 0
  const ticks = (n: number) => {
    for (let i = 0; i < n; i++) t.tick(1)
  }
  const count = (event: string) => events.filter((e) => e === event).length
  return { t, irqs, ref, write, read, ticks, count }
}

describe("STM32F746 timer counter against RM0385 (TIMx_CR1, TIMx_EGR, TIMx_RCR, TIMx_ARR)", () => {
  it.each([
    [1, "down", 1],
    [2, "up", 1],
    [3, "up and down", 2],
  ])("center-aligned mode %i sets CC1IF only while counting %s: the interrupt, the CH1 trigger and the MMS = 011 TRGO pulse follow it, OC1REF toggles on both slopes", (mode, _, perPeriod) => {
    const m = timer("TIM3")
    m.write("ARR", 10)
    m.write("CCR1", 4)
    m.write("CCMR1", OC_TOGGLE)
    m.write("DIER", CC1IF)
    m.write("CR2", MMS_COMPARE_PULSE)
    m.write("CR1", CR1.center(mode) | CR1.CEN)
    m.ticks(5 * 20)
    expect(m.irqs).toHaveLength(5 * perPeriod)
    expect(m.count("CH1")).toBe(5 * perPeriod)
    expect(m.count("TRGO")).toBe(5 * perPeriod)
    expect(m.ref).toHaveLength(10)
  })

  it("flags a match at the top as counting down and one at the bottom as counting up, the directions the counter leaves them in", () => {
    for (const [ccr, mode] of [
      [10, 1],
      [0, 2],
    ]) {
      const m = timer("TIM3")
      m.write("ARR", 10)
      m.write("CCR1", ccr)
      m.write("DIER", CC1IF)
      m.write("CR1", CR1.center(mode) | CR1.CEN)
      m.ticks(5 * 20 + 1)
      expect(m.irqs, `CCR1 = ${ccr}, CMS = ${mode}`).toHaveLength(5)
    }
  })

  it("keeps TIM1's repetition counter 16 bits wide on the F746 (REP[15:0]) and 8 bits on the F429 (REP[7:0])", () => {
    for (const [version, kept] of [
      ["v2", 300],
      ["v1", 300 & 0xff],
    ] as const) {
      const m = timer("TIM1", version)
      m.write("RCR", 300)
      expect(m.read("RCR"), version).toBe(kept)
      m.write("ARR", 9)
      m.write("EGR", UG)
      m.write("SR", 0)
      m.write("DIER", UIE)
      m.write("CR1", CR1.CEN)
      m.t.tick(10 * (kept + 1) - 1)
      expect(m.irqs, `${version}: no update before REP + 1 periods`).toHaveLength(0)
      m.t.tick(1)
      expect(m.irqs, `${version}: one update after them`).toHaveLength(1)
    }
  })

  it("keeps DIR read-only in center-aligned and in encoder mode", () => {
    const m = timer("TIM3")
    m.write("ARR", 100)
    m.write("CR1", CR1.center(1) | CR1.CEN)
    m.ticks(150)
    expect(m.read("CR1") & CR1.DIR, "counting down past the top").toBe(CR1.DIR)
    m.write("CR1", CR1.center(1) | CR1.CEN)
    m.ticks(10)
    expect(m.read("CR1") & CR1.DIR).toBe(CR1.DIR)
    expect(m.read("CNT"), "still counting down").toBe(40)
    const e = timer("TIM3")
    e.write("CCMR1", CC1S_TI1 | CC2S_TI2)
    e.write("SMCR", SMS_ENCODER_BOTH)
    e.write("CR1", CR1.DIR)
    expect(e.read("CR1") & CR1.DIR).toBe(0)
  })

  it("on EGR.CC1G with channel 1 an output sets CC1IF and its interrupt and leaves OC1REF alone", () => {
    const m = timer("TIM3")
    m.write("ARR", 999)
    m.write("CCR1", 500)
    m.write("CCMR1", OC_TOGGLE)
    m.write("CCER", 1)
    m.write("DIER", CC1IF)
    m.write("EGR", CC1IF)
    expect(m.read("SR") & CC1IF).toBe(CC1IF)
    expect(m.irqs).toHaveLength(1)
    expect(m.ref).toEqual([])
    m.write("CR1", CR1.CEN)
    m.ticks(1500)
    expect(m.ref, "toggled by the matches at 500 and 1500 only").toEqual([true, false])
  })

  it("captures a late edge at the counter's value at the edge's own time across both center-aligned turns", () => {
    const bottom = timer("TIM3")
    bottom.write("ARR", 100)
    bottom.write("CCMR1", CC1S_TI1)
    bottom.write("CCER", 1)
    bottom.write("CR1", CR1.center(1) | CR1.CEN)
    bottom.ticks(202)
    bottom.t.input(0, true, 5 * TICK)
    expect(bottom.read("CCR1"), "5 ticks before CNT = 2 on the way up the counter was at 3 on the way down").toBe(3)
    const top = timer("TIM3")
    top.write("ARR", 100)
    top.write("CCMR1", CC1S_TI1)
    top.write("CCER", 1)
    top.write("CR1", CR1.center(1) | CR1.CEN)
    top.ticks(98)
    top.t.tick(5)
    top.t.input(0, true, 4 * TICK)
    expect(top.read("CNT")).toBe(97)
    expect(top.read("CCR1"), "4 ticks back it was 99 on the way up").toBe(99)
  })

  it("captures a late edge with the period and prescaler that were in force at the edge, across the update that changed them", () => {
    const m = timer("TIM3")
    m.write("ARR", 99)
    m.write("CCMR1", CC1S_TI1)
    m.write("CCER", 1)
    m.write("CR1", CR1.ARPE | CR1.CEN)
    m.ticks(95)
    m.write("ARR", 9)
    m.write("PSC", 1)
    m.t.tick(20)
    expect(m.read("CNT"), "ARR 9, PSC 1 from the update at k = 100").toBe(7)
    m.t.input(0, true, 17 * TICK)
    expect(m.read("CCR1")).toBe(98)
  })

  it("blocks the counter while ARR is 0: no update events and no scheduler wake-ups, counting resumes once ARR is set", () => {
    for (const dir of [0, CR1.DIR]) {
      const m = timer("TIM3")
      m.write("ARR", 0)
      m.write("DIER", UIE)
      m.write("CR1", dir | CR1.CEN)
      m.t.tick(1000)
      expect(m.irqs).toEqual([])
      expect(m.read("CNT")).toBe(0)
      expect(m.t.cyclesUntilEvent()).toBe(Infinity)
      m.write("ARR", 9)
      m.t.tick(10)
      expect(m.irqs).toHaveLength(1)
    }
  })

  it("divides the encoder's count pulses by the prescaler, which RM0385 §23.3.15 says keeps working in encoder mode", () => {
    const m = timer("TIM3")
    m.write("PSC", 1)
    m.write("EGR", UG)
    m.write("CCMR1", CC1S_TI1 | CC2S_TI2)
    m.write("SMCR", SMS_ENCODER_BOTH)
    m.write("CR1", CR1.CEN)
    for (let cycle = 0; cycle < 2; cycle++)
      for (const [line, level] of [
        [0, true],
        [1, true],
        [0, false],
        [1, false],
      ] as const) {
        m.t.input(line, level)
        m.ticks(2)
      }
    expect(m.read("CNT"), "8 edges, prescaler ÷2").toBe(4)
  })
})

const RCC_APB1RSTR = 0x40023820
const RCC_AHB1ENR = 0x40023830
const RCC_APB1ENR = 0x40023840
const TIM2 = 0x40000000
const TIM2EN = 1
const GPIOA = 0x40020000
const PA15 = parsePad("PA15")!

function idleChip() {
  const mcu = new Stm32(STM32F746IG)
  mcu.load(buffer(example("adc-idle.elf")), "adc-idle.elf")
  mcu.run(1e-5)
  const w = (addr: number, value: number) => mcu.bus.write(addr >>> 0, value >>> 0, 4)
  const r = (addr: number) => mcu.bus.read(addr >>> 0, 4) >>> 0
  const tim2 = (reg: keyof typeof OFFSET) => TIM2 + OFFSET[reg]
  return { mcu, w, r, tim2 }
}

describe("STM32F746 timers behind their RCC enable and reset bits (RM0385 §5.2.12, §5.3.8, §5.3.13)", () => {
  it("ignores a timer whose clock is off, and freezes a running one while TIMxEN is clear", () => {
    const { mcu, w, r, tim2 } = idleChip()
    w(tim2("ARR"), 999)
    w(tim2("CR1"), CR1.CEN)
    expect(r(tim2("ARR")), "reads 0 without its clock").toBe(0)
    mcu.run(1e-4)
    w(RCC_APB1ENR, r(RCC_APB1ENR) | TIM2EN)
    expect(r(tim2("ARR")), "the write without a clock was lost").toBe(0xffffffff)
    expect(r(tim2("CNT"))).toBe(0)
    w(tim2("CR1"), CR1.CEN)
    mcu.run(1e-4)
    const counted = r(tim2("CNT"))
    expect(counted).toBeNear(mcu.clocks.timclk1 * 1e-4, 2)
    w(RCC_APB1ENR, r(RCC_APB1ENR) & ~TIM2EN)
    mcu.run(1e-4)
    w(RCC_APB1ENR, r(RCC_APB1ENR) | TIM2EN)
    expect(r(tim2("CNT")), "not a tick while its clock was off").toBe(counted)
    mcu.run(1e-4)
    expect(r(tim2("CNT")) - counted).toBeNear(mcu.clocks.timclk1 * 1e-4, 2)
  })

  it("returns every register to its reset value on a TIMxRST pulse and stays stopped", () => {
    const { mcu, w, r, tim2 } = idleChip()
    w(RCC_APB1ENR, r(RCC_APB1ENR) | TIM2EN)
    w(tim2("PSC"), 3)
    w(tim2("ARR"), 999)
    w(tim2("DIER"), UIE)
    w(tim2("CR1"), CR1.ARPE | CR1.CEN)
    mcu.run(1e-4)
    expect(r(tim2("CNT"))).toBeGreaterThan(0)
    w(RCC_APB1RSTR, TIM2EN)
    w(RCC_APB1RSTR, 0)
    expect([r(tim2("CR1")), r(tim2("DIER")), r(tim2("PSC")), r(tim2("ARR")), r(tim2("CNT"))]).toEqual([0, 0, 0, 0xffffffff, 0])
    mcu.run(1e-4)
    expect(r(tim2("CNT"))).toBe(0)
  })

  it("drops input edges while the chip is in Stop and takes the net change at the wake-up", () => {
    const { mcu, w, r, tim2 } = idleChip()
    w(RCC_AHB1ENR, r(RCC_AHB1ENR) | 1)
    w(RCC_APB1ENR, r(RCC_APB1ENR) | TIM2EN)
    w(GPIOA + 0x24, (r(GPIOA + 0x24) & ~(0xf << 28)) | (1 << 28))
    w(GPIOA, (r(GPIOA) & ~(3 << 30)) | (2 << 30))
    mcu.setPadAt(PA15, false, mcu.time)
    w(tim2("CCMR1"), CC1S_TI1)
    w(tim2("CCER"), 1)
    w(tim2("CR1"), CR1.CEN)
    mcu.run(1e-5)
    mcu.cpu.onDeepSleep()
    mcu.setPadAt(PA15, true, mcu.time)
    mcu.setPadAt(PA15, false, mcu.time)
    mcu.setPadAt(PA15, true, mcu.time)
    expect(r(tim2("SR")) & CC1IF, "no capture without a clock").toBe(0)
    mcu.cpu.onDeepWake()
    expect(r(tim2("SR")) & CC1IF, "the rising level seen once the clock is back").toBe(CC1IF)
    expect(r(tim2("SR")) & (CC1IF << 8), "one capture, not three edges").toBe(0)
  })
})
