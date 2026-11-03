import { describe, expect, it } from "vitest"
import { STM32F405RG, STM32F407VG, type ChipProfile } from "@/mcu/chip"
import { Stm32 } from "@/mcu/stm32f429"
import { DS8626_SUPPLY as t, runAmps, sleepAmps, standbyAmps, stopAmps, vbatAmps, type EnableRegisters, type SupplyState } from "@/mcu/supply"
import { buffer, example } from "../lib/firmware"

const MHZ = [2, 4, 8, 16, 25, 30, 60, 90, 120, 144, 168]
const TABLE_20_ALL_ENABLED_MA = [2, 3, 5, 9, 12, 16, 30, 44, 56, 67, 87]
const TABLE_21_ALL_ENABLED_MA = [3, 4, 6, 11, 16, 20, 37, 53, 67, 76, 93]
const TABLE_22_ALL_ENABLED_MA = [2, 2, 3, 6, 8, 11, 20, 30, 38, 46, 59]
const WHOLE_MILLIAMP_ROUNDING = 0.5e-3
const CLOSURE_SLACK = 0.023

const EVERY_PERIPHERAL: EnableRegisters = { AHB1ENR: 0x7fffffff, AHB2ENR: 0xff, AHB3ENR: 1, APB1ENR: 0x3fffffff, APB2ENR: 0x7ffff }
const NONE: EnableRegisters = { AHB1ENR: 0, AHB2ENR: 0, AHB3ENR: 0, APB1ENR: 0, APB2ENR: 0 }

function datasheetConditions(mhz: number, enabled: EnableRegisters, instructionCacheOrRam = true): SupplyState {
  return {
    hclk: mhz * 1e6,
    pclk1: (mhz * 1e6) / 4,
    pclk2: (mhz * 1e6) / 2,
    enabled,
    enabledInSleep: EVERY_PERIPHERAL,
    scale1: mhz > 144,
    instructionCacheOrRam,
    hsi: false,
    hseCrystal: false,
    lsi: false,
    lse: false,
    backupRegulator: false,
    pllVco: mhz > 25 ? 336e6 : null,
    pllDrivesHclk: mhz > 25,
    plli2sVco: null,
    i2sMode: { 2: false, 3: false },
    adcsOn: 0,
    adcsConverting: 0,
    dacChannels: 0,
    compensationCell: false,
  }
}

describe("DS8626 supply tables: a base current plus every enabled peripheral's µA/MHz", () => {
  it(`every Table 28 clock on the base of Tables 20, 21 and 22 gives their 33 'all peripherals enabled' rows within whole-milliamp rounding plus ${CLOSURE_SLACK * 100} % (the worst, 144 MHz in Table 20, 1.34 mA over)`, () => {
    for (const [name, table, amps, cached] of [
      ["Table 20, run, ART on", TABLE_20_ALL_ENABLED_MA, runAmps, true],
      ["Table 21, run, ART off", TABLE_21_ALL_ENABLED_MA, runAmps, false],
      ["Table 22, sleep", TABLE_22_ALL_ENABLED_MA, sleepAmps, true],
    ] as const)
      MHZ.forEach((mhz, i) => {
        const got = amps(t, datasheetConditions(mhz, EVERY_PERIPHERAL, cached), 3.3)
        const want = table[i] * 1e-3
        expect.soft(got, `${name} at ${mhz} MHz`).toBeNear(want, WHOLE_MILLIAMP_ROUNDING + CLOSURE_SLACK * want)
      })
  })

  it("at 168 MHz: Table 20's 40 mA base and 46.77 mA of Table 28 (SPI2/3 or I2S2/3, never both, DS8626 Table 2 note 2; the bus matrix once) make its 87 mA to within its rounding", () => {
    const base = runAmps(t, datasheetConditions(168, NONE), 3.3)
    const all = runAmps(t, datasheetConditions(168, EVERY_PERIPHERAL), 3.3)
    expect.soft(base, "Table 20, all disabled").toBeNear(40e-3, 1e-9)
    expect.soft(all - base, "Table 28 at 168/42/84 MHz, Scale 1").toBeNear(46.77078e-3, 1e-8)
    expect.soft(all, "Table 20, all enabled").toBeNear(87e-3, WHOLE_MILLIAMP_ROUNDING)
  })

  it("takes the rows at or below 144 MHz as Scale 2 measurements (an estimate: the tables do not state VOS, but every column jumps from 144 to 168 MHz) and charges Scale 1 there Table 14 note 1's approximate 10 % from 30 MHz up, nothing below", () => {
    const at = (mhz: number, scale1: boolean) => runAmps(t, { ...datasheetConditions(mhz, NONE), scale1 }, 3.3)
    expect.soft(at(120, false), "120 MHz, Scale 2: Table 20's 26 mA").toBeNear(26e-3, 1e-9)
    expect.soft(at(120, true), "120 MHz, Scale 1").toBeNear(26e-3 / 0.9, 1e-9)
    expect.soft(at(16, true), "16 MHz, either scale").toBeNear(at(16, false), 1e-12)
    expect.soft(at(168, true), "168 MHz, Scale 1 as measured").toBeNear(40e-3, 1e-9)
    expect.soft(at(156, true), "between 144 and 168 MHz, both rows in Scale 1").toBeNear((31e-3 / 0.9 + 40e-3) / 2, 1e-9)
  })

  it("Stop: Table 23 by regulator and flash state; an ADC left on keeps its 1.6 mA analog part (RM0090 §5.3.5)", () => {
    const s = datasheetConditions(16, NONE)
    expect.soft(stopAmps(t, s, false, false, 3.3), "main regulator, flash in Stop").toBeNear(0.45e-3, 1e-12)
    expect.soft(stopAmps(t, s, false, true, 3.3), "main regulator, flash powered down").toBeNear(0.4e-3, 1e-12)
    expect.soft(stopAmps(t, s, true, false, 3.3), "low-power regulator, flash in Stop").toBeNear(0.31e-3, 1e-12)
    expect.soft(stopAmps(t, s, true, true, 3.3), "low-power regulator, flash powered down").toBeNear(0.28e-3, 1e-12)
    expect.soft(stopAmps(t, { ...s, adcsOn: 1 }, true, true, 3.3), "ADON left set").toBeNear(0.28e-3 + 1.6e-3, 1e-12)
  })

  it("Standby and VBAT: Tables 24 and 25 by backup regulator and LSE + RTC, interpolated between their 1.8, 2.4 and 3.3 V columns", () => {
    const s = datasheetConditions(16, NONE)
    const row = (backupRegulator: boolean, lse: boolean) => ({ ...s, backupRegulator, lse })
    expect.soft(standbyAmps(t, row(true, true), 3.3), "Standby, SRAM and RTC on, 3.3 V").toBeNear(4.0e-6, 1e-12)
    expect.soft(standbyAmps(t, row(false, true), 2.4), "Standby, RTC on, 2.4 V").toBeNear(2.7e-6, 1e-12)
    expect.soft(standbyAmps(t, row(false, false), 1.8), "Standby, neither, 1.8 V").toBeNear(1.7e-6, 1e-12)
    expect.soft(standbyAmps(t, row(true, false), 2.85), "Standby, SRAM on, half way from 2.4 to 3.3 V").toBeNear(2.8e-6, 1e-12)
    expect.soft(vbatAmps(t, true, true, 3.3), "VBAT, SRAM and RTC on, 3.3 V").toBeNear(1.68e-6, 1e-12)
    expect.soft(vbatAmps(t, false, true, 3.0), "VBAT, RTC on, a CR2032's 3.0 V").toBeNear(0.73e-6 + (0.96e-6 - 0.73e-6) * (0.6 / 0.9), 1e-12)
    expect.soft(vbatAmps(t, false, false, 2.0), "VBAT, neither").toBeNear(0.1e-6, 1e-12)
    expect.soft(vbatAmps(t, true, false, 3.6), "VBAT at 3.6 V: the 2.4–3.3 V slope carried on").toBeNear(0.86e-6 + (0.05e-6 / 0.9) * 0.3, 1e-12)
  })
})

const RCC = 0x40023800
const PWR = 0x40007000
const FLASH = 0x40023c00
const SYSCFG = 0x40013800
const ADC1 = 0x40012000
const DAC = 0x40007400
const SPI3 = 0x40003c00
const NOP = 0xbf00
const WFI_LOOP_IMAGE = "adc-idle.elf"

function image(withWfi: boolean): ArrayBuffer {
  const elf = buffer(example(WFI_LOOP_IMAGE)).slice(0)
  const view = new DataView(elf)
  view.setUint32(0x1000, 0x20020000, true)
  if (!withWfi) view.setUint16(0x11ac, NOP, true)
  return elf
}

function running(chip: ChipProfile = STM32F405RG, sleeping = false) {
  const mcu = new Stm32(chip)
  mcu.setClockSources({ hz: 8e6, kind: "crystal", startup: 2e-3 }, { hz: 32768, kind: "crystal", startup: 2 })
  mcu.load(image(sleeping), sleeping ? "wfi.elf" : "busy.elf")
  mcu.run(1e-4)
  expect(mcu.cpu.halted).toBeNull()
  const w = (addr: number, value: number) => mcu.bus.write(addr, value >>> 0, 4)
  const r = (addr: number) => mcu.bus.read(addr, 4) >>> 0
  const amps = () => {
    mcu.supplyCurrent()
    mcu.run(1e-4)
    return mcu.supplyCurrent()
  }
  return { mcu, w, r, amps }
}

function onPll(mhz: number) {
  const m = running()
  const { w, r, mcu } = m
  w(RCC + 0x00, r(RCC) | (1 << 16))
  mcu.run(3e-3)
  w(RCC + 0x04, (1 << 22) | (7 << 24) | ((mhz * 2) << 6) | 8)
  w(RCC + 0x00, r(RCC) | (1 << 24))
  mcu.run(1e-3)
  w(FLASH + 0x00, 5)
  w(RCC + 0x08, (5 << 10) | (4 << 13) | 2)
  mcu.run(1e-4)
  expect(mcu.clocks.hclk, "the PLL drives HCLK").toBe(mhz * 1e6)
  return m
}

const RM0090_ENABLE_BITS_AND_TABLE_28_SCALE_1: readonly [string, number, number, number][] = [
  ["GPIOA", 0x30, 0, 2.7], ["GPIOB", 0x30, 1, 2.5], ["GPIOC", 0x30, 2, 2.54], ["GPIOD", 0x30, 3, 2.55], ["GPIOE", 0x30, 4, 2.68],
  ["GPIOF", 0x30, 5, 2.53], ["GPIOG", 0x30, 6, 2.51], ["GPIOH", 0x30, 7, 2.51], ["GPIOI", 0x30, 8, 2.5], ["CRC", 0x30, 12, 0.41],
  ["BKPSRAM", 0x30, 18, 0.63], ["DMA1", 0x30, 21, 37.44 + 13.1], ["DMA2", 0x30, 22, 37.69 + 13.1], ["ETHMAC", 0x30, 25, 20.43 + 13.1], ["OTGHS", 0x30, 29, 28.33 + 13.1],
  ["DCMI", 0x34, 0, 5.87], ["RNG", 0x34, 6, 1.5], ["OTGFS", 0x34, 7, 26.45], ["FSMC", 0x38, 0, 12.46],
  ["TIM2", 0x40, 0, 16.71], ["TIM3", 0x40, 1, 12.33], ["TIM4", 0x40, 2, 13.45], ["TIM5", 0x40, 3, 17.14], ["TIM6", 0x40, 4, 2.43],
  ["TIM7", 0x40, 5, 2.43], ["TIM12", 0x40, 6, 6.62], ["TIM13", 0x40, 7, 5.05], ["TIM14", 0x40, 8, 5.26], ["WWDG", 0x40, 11, 1.0],
  ["SPI2", 0x40, 14, 2.43], ["SPI3", 0x40, 15, 2.43], ["USART2", 0x40, 17, 2.69], ["USART3", 0x40, 18, 2.74], ["UART4", 0x40, 19, 3.24],
  ["UART5", 0x40, 20, 2.69], ["I2C1", 0x40, 21, 2.67], ["I2C2", 0x40, 22, 2.83], ["I2C3", 0x40, 23, 2.81], ["CAN1", 0x40, 25, 5.12],
  ["CAN2", 0x40, 26, 4.81], ["PWR", 0x40, 28, 1.0], ["DAC", 0x40, 29, 1.67],
  ["TIM1", 0x44, 0, 16.79], ["TIM8", 0x44, 1, 17.88], ["USART1", 0x44, 4, 3.51], ["USART6", 0x44, 5, 3.55], ["ADC1", 0x44, 8, 4.67],
  ["ADC2", 0x44, 9, 4.67], ["ADC3", 0x44, 10, 4.43], ["SDIO", 0x44, 11, 7.08], ["SPI1", 0x44, 12, 1.32], ["SYSCFG", 0x44, 14, 0.74],
  ["TIM9", 0x44, 16, 7.64], ["TIM10", 0x44, 17, 4.89], ["TIM11", 0x44, 18, 5.19],
]

describe("the F405's supply current follows what the firmware switched on", () => {
  it("out of reset: HSI at 16 MHz, ART off, no peripheral clock — Table 21's 7 mA and the HSI's 60 µA (Table 34)", () => {
    const { amps } = running()
    expect.soft(amps(), "reset state").toBeNear(7e-3 + 60e-6, 1e-9)
  })

  it("the instruction cache (ICEN) moves the base to Table 20; the data cache alone (DCEN) does not: Tables 20/21 measure the ART with and without, and DCEN keeps no code", () => {
    const { w, amps } = running()
    w(FLASH, 1 << 10)
    expect.soft(amps(), "DCEN only: Table 21").toBeNear(7e-3 + 60e-6, 1e-9)
    w(FLASH, 1 << 9)
    expect.soft(amps(), "ICEN only: Table 20").toBeNear(5e-3 + 60e-6, 1e-9)
    w(FLASH, (1 << 9) | (1 << 10))
    expect.soft(amps(), "both").toBeNear(5e-3 + 60e-6, 1e-9)
  })

  it("every peripheral clock at its RM0090 enable bit draws Table 28's Scale 1 µA/MHz on its bus at 16 MHz, the bus matrix with each non-CPU master (Table 28 note 2)", () => {
    for (const chip of [STM32F405RG, STM32F407VG]) {
      const { w, amps } = running(chip)
      const base = amps()
      for (const [name, offset, bit, perMhz] of RM0090_ENABLE_BITS_AND_TABLE_28_SCALE_1) {
        w(RCC + offset, 1 << bit)
        const notBonded = chip === STM32F405RG && (name === "ETHMAC" || name === "DCMI")
        expect.soft(amps() - base, `${chip.name} ${name}${notBonded ? ", not on the F405 (DS8626 Table 2)" : ""}`).toBeNear(notBonded ? 0 : perMhz * 16e-6, 1e-9)
        w(RCC + offset, offset === 0x30 ? 1 << 20 : 0)
      }
    }
  })

  it("SPI3 in I²S mode draws I2S3's 2.26 µA/MHz instead of SPI3's 2.43 (I2SMOD, DS8626 Table 28)", () => {
    const { w, r, amps } = running()
    w(RCC + 0x40, 1 << 15)
    const spi = amps()
    w(SPI3 + 0x1c, r(SPI3 + 0x1c) | (1 << 11))
    expect.soft(amps() - spi, "I2S3 against SPI3 at 16 MHz").toBeNear((2.26 - 2.43) * 16e-6, 1e-9)
  })

  it("PLLI2S on adds its VDD and VDDA current at its VCO (Table 37: the midpoint of 0.15–0.40 + 0.30–0.40 mA at 100 MHz and 0.45–0.75 + 0.55–0.85 mA at 432 MHz)", () => {
    const { w, r, amps } = running()
    const off = amps()
    w(RCC + 0x84, (2 << 28) | (192 << 6))
    w(RCC + 0x04, (r(RCC + 0x04) & ~0x3f) | 16)
    w(RCC, r(RCC) | (1 << 26))
    const at100 = (0.15 + 0.4) / 2 + (0.3 + 0.4) / 2
    const at432 = (0.45 + 0.75) / 2 + (0.55 + 0.85) / 2
    expect.soft(amps() - off, "PLLI2S at a 192 MHz VCO").toBeNear((at100 + ((192 - 100) / 332) * (at432 - at100)) * 1e-3, 1e-9)
  })

  it("an ADC's clock, its ADON (1.6 mA) and a running conversion (Table 67's IVREF+ 300 µA); a DAC's clock and 0.8 mA per enabled channel", () => {
    const { w, r, amps, mcu } = running()
    const before = amps()
    w(RCC + 0x44, r(RCC + 0x44) | (1 << 8))
    expect.soft(amps() - before, "ADC1 clock at PCLK2 = 16 MHz").toBeNear(4.67 * 16e-6, 1e-9)
    w(ADC1 + 0x08, 1)
    expect.soft(amps() - before, "and ADON").toBeNear(4.67 * 16e-6 + 1.6e-3, 1e-9)
    w(ADC1 + 0x08, 1 | (1 << 1) | (1 << 30))
    mcu.run(1e-5)
    expect.soft(mcu.adc[0].converting, "continuous conversion running").toBe(true)
    expect.soft(amps() - before, "and converting").toBeNear(4.67 * 16e-6 + 1.6e-3 + 0.3e-3, 1e-9)
    w(ADC1 + 0x08, 0)
    w(RCC + 0x44, r(RCC + 0x44) & ~(1 << 8))
    w(RCC + 0x40, r(RCC + 0x40) | (1 << 29))
    w(DAC, 1 | (1 << 16))
    expect.soft(amps() - before, "DAC clock at PCLK1 = 16 MHz and both channels").toBeNear(1.67 * 16e-6 + 1.6e-3, 1e-9)
  })

  it("SYSCFG's compensation cell adds Table 28 note 1's 0.22 mA", () => {
    const { w, r, amps } = running()
    w(RCC + 0x44, r(RCC + 0x44) | (1 << 14))
    const before = amps()
    w(SYSCFG + 0x20, 1)
    expect.soft(amps() - before, "CMP_PD").toBeNear(0.22e-3, 1e-9)
  })

  it("168 MHz from the 8 MHz crystal: Table 21's 46 mA without the instruction cache (the PLL inside it), an estimated 532 µA for the HSE oscillator (DS8626 Rev 4 Table 31, at 25 MHz) and the HSI left on", () => {
    const { amps } = onPll(168)
    expect.soft(amps(), "busy loop at 168 MHz, ICEN off, flash latency 5").toBeNear(46e-3 + 532e-6 + 60e-6, 1e-9)
  })

  it("Scale 2 at 120 MHz saves the estimated 10 %; PWR's clock costs its 1.00 / 0.56 µA/MHz", () => {
    const { w, r, amps } = onPll(120)
    w(FLASH, r(FLASH) | (1 << 9))
    w(RCC + 0x40, r(RCC + 0x40) | (1 << 28))
    const oscillators = 532e-6 + 60e-6
    expect.soft(amps(), "VOS = 1 (Scale 1, the reset value)").toBeNear(26e-3 / 0.9 + 1.0 * 30e-6 + oscillators, 1e-9)
    w(PWR, r(PWR) & ~(1 << 14))
    expect.soft(amps(), "VOS = 0 (Scale 2)").toBeNear(26e-3 + 0.56 * 30e-6 + oscillators, 1e-9)
  })

  it("leaving Stop keeps no stale current: the HSE and PLL that Stop turned off stop being billed though HCLK (the HSI's 16 MHz) is the same before and after", () => {
    const { w, r, amps, mcu } = running()
    w(RCC + 0x00, r(RCC) | (1 << 16))
    mcu.run(3e-3)
    w(RCC + 0x04, (1 << 22) | (7 << 24) | (192 << 6) | 8)
    w(RCC + 0x00, r(RCC) | (1 << 24))
    mcu.run(1e-3)
    const pll = 0.275e-3 + 0.35e-3 + ((192 - 100) / 332) * (0.6e-3 + 0.7e-3 - (0.275e-3 + 0.35e-3))
    expect.soft(amps(), "HSI system clock with the HSE and the PLL running beside it").toBeNear(7e-3 + 60e-6 + 532e-6 + pll, 1e-9)
    mcu.rcc.enterStop()
    expect.soft(mcu.supplyCurrent(), "after Stop: HSI alone").toBeNear(7e-3 + 60e-6, 1e-9)
  })

  it("decodes Stop's regulator (LPDS) and flash (FPDS) from PWR_CR: Table 23's four rows", () => {
    const { w, r, mcu } = running()
    mcu.lowPower = "stop"
    for (const [lpds, fpds, want] of [[0, 0, 0.45e-3], [0, 1, 0.4e-3], [1, 0, 0.31e-3], [1, 1, 0.28e-3]] as const) {
      w(PWR, (r(PWR) & ~((1 << 0) | (1 << 9))) | lpds | (fpds << 9))
      expect.soft(mcu.supplyCurrent(), `LPDS ${lpds}, FPDS ${fpds}`).toBeNear(want, 1e-12)
    }
  })

  it("Standby from the registers: BRE and the LSE pick Table 24's row, VDD its column", () => {
    const { w, r, mcu } = running()
    w(RCC + 0x40, r(RCC + 0x40) | (1 << 28))
    w(PWR, r(PWR) | (1 << 8))
    w(RCC + 0x70, 1)
    w(PWR + 0x04, r(PWR + 0x04) | (1 << 9))
    mcu.setSupply(2.4)
    mcu.lowPower = "standby"
    expect.soft(mcu.supplyCurrent(), "backup SRAM and RTC on, 2.4 V").toBeNear(3.4e-6, 1e-12)
  })

  it("in Sleep (WFI) a peripheral is billed only while LPENR keeps its clock too: TIM2 with and without TIM2LPEN", () => {
    const { w, r, amps } = running(STM32F405RG, true)
    expect.soft(amps(), "asleep: Table 22's 16 MHz base and the HSI").toBeNear(2e-3 + 60e-6, 1e-9)
    w(RCC + 0x40, r(RCC + 0x40) | 1)
    expect.soft(amps(), "TIM2 enabled, LPENR's reset value keeping it").toBeNear(2e-3 + 60e-6 + 16.71 * 16e-6, 1e-9)
    w(RCC + 0x60, r(RCC + 0x60) & ~1)
    expect.soft(amps(), "TIM2LPEN cleared").toBeNear(2e-3 + 60e-6, 1e-9)
  })

  it("a sector erase draws Table 39's 12 mA at x32, the PSIZE written in the same CR write as STRT, not the one before", () => {
    const { w, amps, mcu } = running()
    const before = amps()
    w(FLASH + 0x04, 0x45670123)
    w(FLASH + 0x04, 0xcdef89ab)
    w(FLASH + 0x10, (2 << 8) | (1 << 1) | (11 << 3) | (1 << 16))
    mcu.runUntil(mcu.time + 0.5)
    expect.soft(mcu.supplyCurrent() - before, "the first half second of erasing sector 11, PSIZE x32 set with STRT").toBeNear(12e-3, 1e-9)
    mcu.runUntil(mcu.time + 3)
    expect.soft(amps() - before, "after it").toBeNear(0, 1e-9)
  })

  it("counts a word program's 16 µs at 12 mA (x32) as the charge it is, 0.192 µC, through the load the circuit sees, and two programs at different PSIZE each at its own current (x8 5 mA + x32 12 mA)", () => {
    const program = (psize: number, at: number) => {
      const { w, mcu } = running()
      const vdd = STM32F405RG.electrical.vdd
      for (let k = 0; k < 20; k++) {
        mcu.runUntil(mcu.time + 20e-6)
        mcu.supplyLoad()
      }
      const base = mcu.supplyLoad()
      w(FLASH + 0x04, 0x45670123)
      w(FLASH + 0x04, 0xcdef89ab)
      let charge = 0
      for (const size of [psize, 2].slice(0, at)) {
        w(FLASH + 0x10, (size << 8) | 1)
        mcu.bus.write(0x08080000 + 4 * size, 0, (1 << size) as 1 | 2 | 4)
      }
      for (let k = 0; k < 50; k++) {
        mcu.runUntil(mcu.time + 20e-6)
        charge += ((mcu.supplyLoad() - base) * vdd) / vdd * 20e-6
      }
      return charge
    }
    expect.soft(program(2, 1), "one x32 word").toBeNearRel(12e-3 * 16e-6, 0.03)
    expect.soft(program(0, 2), "an x8 byte, then an x32 word").toBeNearRel((5e-3 + 12e-3) * 16e-6, 0.03)
  })

  it("re-prices a PLL fed from the HSE when the crystal on the board changes, though HCLK (the HSI) and RCC's registers do not", () => {
    const { w, r, amps, mcu } = running()
    w(RCC + 0x00, r(RCC) | (1 << 16))
    mcu.run(3e-3)
    w(RCC + 0x04, (1 << 22) | (7 << 24) | (100 << 6) | 8)
    w(RCC + 0x00, r(RCC) | (1 << 24))
    mcu.run(1e-3)
    const at100 = amps()
    mcu.setClockSources({ hz: 16e6, kind: "crystal", startup: 2e-3 }, { hz: 32768, kind: "crystal", startup: 2 })
    mcu.run(3e-3)
    const vcoAmps = (mhz: number) => 0.625e-3 + ((mhz - 100) / 332) * (1.3e-3 - 0.625e-3)
    expect.soft(amps() - at100, "VCO 100 → 200 MHz").toBeNear(vcoAmps(200) - vcoAmps(100), 1e-9)
  })

  it("draws its table current at whatever VDD the board gives it: the load handed to the circuit is that current at the nominal 3.3 V's resistance", () => {
    const { mcu } = running()
    for (const vdd of [1.8, 2.4, 3.3, 3.6]) {
      mcu.setSupply(vdd)
      for (let k = 0; k < 5000; k++) {
        mcu.runUntil(mcu.time + 20e-6)
        mcu.supplyLoad()
      }
      const amps = mcu.supplyCurrent()
      const resistance = STM32F405RG.electrical.vdd / mcu.supplyLoad()
      expect.soft(vdd / resistance, `at ${vdd} V, within the 10 mV the load's VDD is held to`).toBeNearRel(amps, 0.005 / vdd)
    }
  })

  it("the backup domain on VBAT draws Table 25's current for its state: BRE and the LSE", () => {
    const { w, r, mcu } = running()
    w(RCC + 0x40, r(RCC + 0x40) | (1 << 28))
    w(PWR, r(PWR) | (1 << 8))
    expect.soft(mcu.backupDomainCurrent(3.3), "nothing on").toBeNear(0.1e-6, 1e-12)
    w(RCC + 0x70, 1)
    mcu.run(2.1)
    expect.soft(mcu.backupDomainCurrent(3.3), "LSE on").toBeNear(0.96e-6, 1e-12)
    w(PWR + 0x04, r(PWR + 0x04) | (1 << 9))
    expect.soft(mcu.backupDomainCurrent(1.8), "and BRE, at 1.8 V").toBeNear(1.29e-6, 1e-12)
  })
})
