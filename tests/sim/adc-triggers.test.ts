import { describe, expect, it } from "vitest"
import { STM32F429ZI, STM32F746IG, type ChipProfile } from "@/mcu/chip"
import { parsePad, Stm32 } from "@/mcu/stm32f429"
import { buffer, example } from "../lib/firmware"

const RM0090_REGULAR = ["TIM1_CH1", "TIM1_CH2", "TIM1_CH3", "TIM2_CH2", "TIM2_CH3", "TIM2_CH4", "TIM2_TRGO", "TIM3_CH1", "TIM3_TRGO", "TIM4_CH4", "TIM5_CH1", "TIM5_CH2", "TIM5_CH3", "TIM8_CH1", "TIM8_TRGO", "EXTI11"]
const RM0090_INJECTED = ["TIM1_CH4", "TIM1_TRGO", "TIM2_CH1", "TIM2_TRGO", "TIM3_CH2", "TIM3_CH4", "TIM4_CH1", "TIM4_CH2", "TIM4_CH3", "TIM4_TRGO", "TIM5_CH4", "TIM5_TRGO", "TIM8_CH2", "TIM8_CH3", "TIM8_CH4", "EXTI15"]
const RM0385_TABLE_96 = ["TIM1_CH1", "TIM1_CH2", "TIM1_CH3", "TIM2_CH2", "TIM5_TRGO", "TIM4_CH4", "TIM3_CH4", "TIM8_TRGO", "TIM8_TRGO2", "TIM1_TRGO", "TIM1_TRGO2", "TIM2_TRGO", "TIM4_TRGO", "TIM6_TRGO", null, "EXTI11"]
const RM0385_TABLE_97 = ["TIM1_TRGO", "TIM1_CH4", "TIM2_TRGO", "TIM2_CH1", "TIM3_CH4", "TIM4_TRGO", null, "TIM8_CH4", "TIM1_TRGO2", "TIM8_TRGO", "TIM8_TRGO2", "TIM3_CH3", "TIM5_TRGO", "TIM3_CH1", "TIM6_TRGO", null]
const F7_HAL_REGULAR = { T1_CC1: 0, T1_CC2: 1, T1_CC3: 2, T2_CC2: 3, T5_TRGO: 4, T4_CC4: 5, T3_CC4: 6, T8_TRGO: 7, T8_TRGO2: 8, T1_TRGO: 9, T1_TRGO2: 10, T2_TRGO: 11, T4_TRGO: 12, T6_TRGO: 13, EXT_IT11: 15 }
const F7_HAL_INJECTED = { T1_TRGO: 0, T1_CC4: 1, T2_TRGO: 2, T2_CC1: 3, T3_CC4: 4, T4_TRGO: 5, T8_CC4: 7, T1_TRGO2: 8, T8_TRGO: 9, T8_TRGO2: 10, T3_CC3: 11, T5_TRGO: 12, T3_CC1: 13, T6_TRGO: 14 }

const TIMERS: Record<string, number> = { TIM1: 0x40010000, TIM2: 0x40000000, TIM3: 0x40000400, TIM4: 0x40000800, TIM5: 0x40000c00, TIM6: 0x40001000, TIM8: 0x40010400 }
const TIM = { CR1: 0x00, CR2: 0x04, CCMR1: 0x18, CCMR2: 0x1c, PSC: 0x28, ARR: 0x2c, CCR1: 0x34 }
const ADC1 = 0x40012000
const ADC = { CR2: 0x08, SQR1: 0x2c, SQR3: 0x34, JSQR: 0x38 }
const EXTI_RTSR = 0x40013c08
const RCC_APB1ENR = 0x40023840
const RCC_APB2ENR = 0x40023844
const PWM_MODE_1 = 6
const TICK_PRESCALER = 15
const PERIOD_TICKS = 99
const COMPARE_AT = 50
const NEVER = 0xffff
const MMS_UPDATE = 2
const RUN_SECONDS = 0.002
const EXTI_HALF_PERIOD = 50e-6
const SETTLE_SECONDS = 20e-6
const ADON = 1
const CEN = 1

type Group = "regular" | "injected"
type Source = { kind: "timer"; timer: string; event: string } | { kind: "exti"; line: number }

function parseSource(name: string): Source {
  const exti = /^EXTI(\d+)$/.exec(name)
  if (exti) return { kind: "exti", line: Number(exti[1]) }
  const [timer, event] = name.split("_")
  return { kind: "timer", timer, event }
}

function census(chip: ChipProfile, group: Group, code: number, active: string[]) {
  const mcu = new Stm32(chip)
  mcu.load(buffer(example("adc-idle.elf")), "adc-idle.elf")
  mcu.run(1e-5)
  const events = new Map<string, number>()
  const count = (name: string) => events.set(name, (events.get(name) ?? 0) + 1)
  for (const t of mcu.tim) {
    const forward = t.onEvent
    t.onEvent = (event) => {
      count(`${t.spec.name}_${event}`)
      forward(event)
    }
  }
  const forwardLine = mcu.exti.onLine
  mcu.exti.onLine = (line) => {
    count(`EXTI${line}`)
    forwardLine(line)
  }
  const w = (addr: number, value: number) => mcu.bus.write(addr, value >>> 0, 4)
  w(RCC_APB1ENR, 0xffffffff)
  w(RCC_APB2ENR, 0xffffffff)
  const sources = active.map(parseSource)
  const timers = new Set(sources.flatMap((s) => (s.kind === "timer" ? [s.timer] : [])))
  for (const timer of timers) {
    const base = TIMERS[timer]
    const wanted = (event: string) => sources.some((s) => s.kind === "timer" && s.timer === timer && s.event === event)
    w(base + TIM.PSC, TICK_PRESCALER)
    w(base + TIM.ARR, PERIOD_TICKS)
    w(base + TIM.CCMR1, (PWM_MODE_1 << 4) | (PWM_MODE_1 << 12))
    w(base + TIM.CCMR2, (PWM_MODE_1 << 4) | (PWM_MODE_1 << 12))
    for (let ch = 1; ch <= 4; ch++) w(base + TIM.CCR1 + 4 * (ch - 1), wanted(`CH${ch}`) ? COMPARE_AT : NEVER)
    w(base + TIM.CR2, (wanted("TRGO") ? MMS_UPDATE << 4 : 0) | (wanted("TRGO2") ? MMS_UPDATE << 20 : 0))
  }
  const lines = sources.flatMap((s) => (s.kind === "exti" ? [s.line] : []))
  w(EXTI_RTSR, lines.reduce((m, line) => m | (1 << line), 0))
  if (group === "regular") {
    w(ADC1 + ADC.SQR1, 0)
    w(ADC1 + ADC.SQR3, 0)
    w(ADC1 + ADC.CR2, ADON | (1 << 28) | (code << 24))
  } else {
    w(ADC1 + ADC.JSQR, 0)
    w(ADC1 + ADC.CR2, ADON | (1 << 20) | (code << 16))
  }
  for (const timer of timers) w(TIMERS[timer] + TIM.CR1, CEN)
  const pads = lines.map((line) => parsePad(`PA${line}`)!)
  let level = false
  for (let t = 0; t < RUN_SECONDS; t += EXTI_HALF_PERIOD) {
    mcu.run(EXTI_HALF_PERIOD)
    level = !level
    for (const pad of pads) mcu.setPad(pad, level)
  }
  for (const timer of timers) w(TIMERS[timer] + TIM.CR1, 0)
  mcu.run(SETTLE_SECONDS)
  const adc = mcu.adc[0]
  return { conversions: group === "regular" ? adc.converted.regular : adc.converted.injected, events, unmodelled: [...mcu.unmodelled.features.keys()] }
}

function checkTable(chip: ChipProfile, group: Group, table: (string | null)[]) {
  const named = table.flatMap((name, code) => (name ? [{ name, code }] : []))
  it.each(named)("code $code: $name converts on every one of its own events", ({ name, code }) => {
    const run = census(chip, group, code, [name])
    const own = run.events.get(name) ?? 0
    expect(own, `${name} events in ${RUN_SECONDS * 1e3} ms`).toBeGreaterThan(10)
    expect(run.conversions, `${group} conversions`).toBe(own)
  })
  it.each(named)("code $code: $name does not convert on any other event of the table", ({ name, code }) => {
    const others = named.filter((n) => n.name !== name).map((n) => n.name)
    const run = census(chip, group, code, others)
    const fired = others.filter((o) => (run.events.get(o) ?? 0) > 0)
    expect(fired.length, "every other source of the table fires").toBe(others.length)
    expect(run.conversions, `${group} conversions with every other source firing`).toBe(0)
  })
  const reserved = table.flatMap((name, code) => (name ? [] : [code]))
  if (reserved.length)
    it.each(reserved)("code %i is reserved: nothing triggers it and the inspector says so", (code) => {
      const run = census(chip, group, code, named.map((n) => n.name))
      expect(run.conversions).toBe(0)
      expect(run.unmodelled.join("\n")).toMatch(new RegExp(`${group === "regular" ? "EXTSEL" : "JEXTSEL"} ${code} is reserved`))
    })
}

describe("ADC external triggers on the F746 follow RM0385, not RM0090", () => {
  it("the chip profile carries RM0385 Tables 96 and 97, which agree with the F7 HAL's encodings", () => {
    expect(STM32F746IG.adc.regularTriggers).toEqual(RM0385_TABLE_96)
    expect(STM32F746IG.adc.injectedTriggers).toEqual(RM0385_TABLE_97)
    const hal = (name: string) => name.replace(/^TIM(\d)_CH/, "T$1_CC").replace(/^TIM/, "T").replace(/^EXTI/, "EXT_IT")
    for (const [name, code] of Object.entries(F7_HAL_REGULAR)) expect(hal(STM32F746IG.adc.regularTriggers[code]!), `ADC_EXTERNALTRIGCONV_${name}`).toBe(name)
    for (const [name, code] of Object.entries(F7_HAL_INJECTED)) expect(hal(STM32F746IG.adc.injectedTriggers[code]!), `ADC_EXTERNALTRIGINJECCONV_${name}`).toBe(name)
  })
  it("only EXTSEL 0–3 and 15 mean the same as on the F4", () => {
    const same = RM0385_TABLE_96.flatMap((name, code) => (name === RM0090_REGULAR[code] ? [code] : []))
    expect(same).toEqual([0, 1, 2, 3, 15])
  })
  describe("regular group, EXTSEL", () => checkTable(STM32F746IG, "regular", STM32F746IG.adc.regularTriggers))
  describe("injected group, JEXTSEL", () => checkTable(STM32F746IG, "injected", STM32F746IG.adc.injectedTriggers))
})

describe("ADC external triggers on the F429 keep RM0090's table", () => {
  it("the chip profile carries the F4 table", () => {
    expect(STM32F429ZI.adc.regularTriggers).toEqual(RM0090_REGULAR)
    expect(STM32F429ZI.adc.injectedTriggers).toEqual(RM0090_INJECTED)
  })
  describe("regular group, EXTSEL", () => checkTable(STM32F429ZI, "regular", STM32F429ZI.adc.regularTriggers))
  describe("injected group, JEXTSEL", () => checkTable(STM32F429ZI, "injected", STM32F429ZI.adc.injectedTriggers))
})
