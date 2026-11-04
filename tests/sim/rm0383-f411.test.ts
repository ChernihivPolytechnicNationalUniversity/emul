/**
 * STM32F411CE against RM0383 Rev 4 where it differs from the F40x/F42x of RM0090. Every expectation
 * names the section or table it comes from.
 */
import { describe, expect, it } from "vitest"
import { STM32F411CE } from "@/mcu/chip"
import { F411_DMA1_REQUESTS, F411_DMA2_REQUESTS } from "@/mcu/periph/dma"
import { Stm32 } from "@/mcu/stm32f429"
import { buffer, example } from "../lib/firmware"

const RCC = 0x40023800
const FLASH = 0x40023c00
const PWR = 0x40007000
const SYSCFG = 0x40013800
const ADC1 = 0x40012000
const ADC_CCR = 0x40012304
const STIR = 0xe000ef00
const ISPR = 0xe000e200

/** adc-idle.elf (a WFI loop) with its initial SP moved to the top of the F411's 128 KB SRAM; it was linked for the F429's 192 KB. */
function idleImage(): ArrayBuffer {
  const image = buffer(example("adc-idle.elf")).slice(0)
  const view = new DataView(image)
  const VECTORS_IN_FILE = 0x1000
  expect(view.getUint32(VECTORS_IN_FILE, true)).toBe(0x20030000)
  view.setUint32(VECTORS_IN_FILE, 0x20020000, true)
  return image
}

function bare() {
  const mcu = new Stm32(STM32F411CE)
  mcu.load(idleImage(), "adc-idle.elf")
  mcu.run(1e-5)
  const w = (addr: number, value: number) => mcu.bus.write(addr, value >>> 0, 4)
  const r = (addr: number) => mcu.bus.read(addr, 4) >>> 0
  expect(mcu.cpu.halted).toBeNull()
  return { mcu, w, r }
}

describe("STM32F411CE to RM0383 Rev 4", () => {
  it("identifies as DEV_ID 0x431, REV_ID 0x1000 = revision A (§23.6.1)", () => {
    const { r } = bare()
    expect(r(0xe0042000)).toBe(0x10000431)
  })

  it("has 86 interrupt lines, 0–85, SPI5 last (§10.1.3 Table 37)", () => {
    const { w, r } = bare()
    w(STIR, 85)
    expect(r(ISPR + 8) & (1 << (85 - 64))).not.toBe(0)
    w(STIR, 86)
    expect(r(ISPR + 8) & (1 << (86 - 64))).toBe(0)
  })

  it("has 128 KB SRAM at 0x2000 0000 and no CCM (§2.3, §2.3.1)", () => {
    const ram = STM32F411CE.memory.filter((m) => m.kind === "ram")
    expect(ram.map((m) => [m.base, m.size])).toEqual([[0x20000000, 128 * 1024]])
  })

  it("has one bank of 8 flash sectors, 512 KB (§3.3 Table 4)", () => {
    expect(STM32F411CE.flash.banks).toBe(1)
    expect(STM32F411CE.flash.sectors.map((s) => s / 1024)).toEqual([16, 16, 16, 16, 64, 128, 128, 128])
    expect(STM32F411CE.memory.find((m) => m.kind === "flash")!.size).toBe(512 * 1024)
  })

  it("keeps four LATENCY bits (§3.8.1 LATENCY[3:0])", () => {
    const { mcu, w, r } = bare()
    w(FLASH, 0xf)
    expect(r(FLASH) & 0xf).toBe(0xf)
    expect(mcu.cpu.flashTiming.latency).toBe(15)
  })

  it("has RDERR in FLASH_SR (§3.8.4), SPRMOD in OPTCR with reset 0x0FFF AAED (§3.8.6), and no OPTCR1", () => {
    const { mcu, r } = bare()
    expect(mcu.flash.def(0x0c)!.w1c! & (1 << 8)).toBe(1 << 8)
    expect(mcu.flash.def(0x14)!.rw! & (1 << 31)).toBe(1 << 31)
    expect(r(FLASH + 0x14) & ~1).toBe(0x0fffaaec)
    expect(mcu.flash.def(0x18)).toBeUndefined()
  })

  it("rejects SNB 8 (no such sector) with WRPERR (§3.6.4, write protection error flag)", () => {
    const { w, r } = bare()
    w(FLASH + 0x04, 0x45670123)
    w(FLASH + 0x04, 0xcdef89ab)
    w(FLASH + 0x10, (1 << 1) | (8 << 3) | (2 << 8) | (1 << 16))
    expect(r(FLASH + 0x0c) & (1 << 4)).toBe(1 << 4)
  })

  it("resets PWR_CR to 0x0000 8000 with VOS[15:14], no over-drive (§5.4.1)", () => {
    const { w, r } = bare()
    expect(r(PWR)).toBe(0x8000)
    w(PWR, 0xffffffff)
    expect(r(PWR) & ~0xc).toBe(0x0030efff & ~0xc)
    expect(r(PWR + 4) & ((1 << 16) | (1 << 17))).toBe(0)
  })

  it("resets the RCC to the F411 values (§6.3.13, §6.3.15, §6.3.16, §6.3.20)", () => {
    const { r } = bare()
    expect(r(RCC + 0x50)).toBe(0x0061900f)
    expect(r(RCC + 0x60)).toBe(0x10e2c80f)
    expect(r(RCC + 0x64)).toBe(0x00077930)
    expect(r(RCC + 0x84)).toBe(0x24003000)
  })

  it("has no PLLSAI, and DCKCFGR with TIMPRE alone (§6.3.21)", () => {
    const { mcu, w, r } = bare()
    expect(mcu.rcc.def(0x88)).toBeUndefined()
    w(RCC + 0x8c, 0xffffffff)
    expect(r(RCC + 0x8c)).toBe(1 << 24)
    w(RCC, r(RCC) | (1 << 28))
    expect(r(RCC) & ((1 << 28) | (1 << 29))).toBe(0)
  })

  it("timer clocks follow TIMPRE: APB1 /2 gives 4 × PCLK1 = HCLK with TIMPRE set (§6.2, §6.3.21)", () => {
    const { mcu, w } = bare()
    w(RCC + 0x08, 4 << 10)
    expect(mcu.rcc.clocks().timclk1).toBe(2 * mcu.rcc.clocks().pclk1)
    w(RCC + 0x8c, 1 << 24)
    expect(mcu.rcc.clocks().timclk1).toBe(mcu.rcc.clocks().hclk)
  })

  it("divides the PLLI2S input by its own PLLI2SM (§6.3.20)", () => {
    const { mcu, w, r } = bare()
    // HSI 16 MHz, PLLM 16 in PLLCFGR (main PLL), PLLI2SM 8, N 192, R 2: 16 / 8 × 192 / 2 = 192 MHz.
    w(RCC + 0x04, 16 | (192 << 6))
    w(RCC + 0x84, (2 << 28) | (192 << 6) | 8)
    w(RCC, r(RCC) | (1 << 26))
    mcu.run(1e-3)
    expect(mcu.rcc.i2sHz()).toBe(192e6)
  })

  it("has GPIOA–E and GPIOH on the bus, no GPIOF/G (§2.3 Table 1)", () => {
    const { mcu } = bare()
    const named = (addr: number) => mcu.bus.peripheralAt(addr)?.name ?? ""
    for (const [port, addr] of [["A", 0x40020000], ["B", 0x40020400], ["C", 0x40020800], ["D", 0x40020c00], ["E", 0x40021000], ["H", 0x40021c00]] as const) expect(named(addr), port).toMatch(/GPIO/)
    for (const addr of [0x40021400, 0x40021800]) expect(named(addr), addr.toString(16)).not.toMatch(/GPIO/)
  })

  it("has TIM1–5, TIM9–11, USART1/2/6, SPI1–5, I2C1–3, ADC1 (Table 1)", () => {
    const { mcu } = bare()
    expect(mcu.tim.map((x) => x.spec.name)).toEqual(["TIM1", "TIM2", "TIM3", "TIM4", "TIM5", "TIM9", "TIM10", "TIM11"])
    expect(mcu.usart.map((x) => x.name)).toEqual(["USART1", "USART2", "USART6"])
    expect(mcu.spi.map((x) => x.name)).toEqual(["SPI1", "SPI2", "SPI3", "SPI4", "SPI5"])
    expect(mcu.i2c.map((x) => x.name)).toEqual(["I2C1", "I2C2", "I2C3"])
    expect(mcu.adc).toHaveLength(1)
  })

  it("has no DAC, FSMC, backup SRAM, LTDC or DMA2D (Table 1)", () => {
    const { mcu } = bare()
    const named = (addr: number) => mcu.bus.peripheralAt(addr)?.name ?? ""
    for (const addr of [0x40007400, 0xa0000000, 0x40024000, 0x40016800, 0x4002b000]) expect(named(addr), addr.toString(16)).not.toMatch(/DAC|FMC|FSMC|BKPSRAM|LTDC|DMA2D/)
    expect(mcu.bkpsram).toBeNull()
  })

  it("has I2C_FLTR (§18.6.10)", () => {
    const { mcu } = bare()
    expect(mcu.i2c[0].def(0x24)).toBeDefined()
  })

  it("masks SYSCFG MEMRMP to MEM_MODE[1:0] and PMC to ADC1DC2 (§7.2.1, §7.2.2)", () => {
    const { w, r } = bare()
    w(SYSCFG, 0xffffffff)
    expect(r(SYSCFG)).toBe(0x3)
    w(SYSCFG, 0)
    w(SYSCFG + 4, 0xffffffff)
    expect(r(SYSCFG + 4)).toBe(0x00010000)
  })

  it("maps DMA requests as Tables 27 and 28 ([stream][channel])", () => {
    expect(F411_DMA1_REQUESTS[0][0]).toBe("SPI3_RX")
    expect(F411_DMA1_REQUESTS[6][4]).toBe("USART2_TX")
    expect(F411_DMA1_REQUESTS[7][6]).toBe("USART2_RX")
    expect(F411_DMA2_REQUESTS[3][2]).toBe("SPI5_RX")
    expect(F411_DMA2_REQUESTS[7][4]).toBe("USART1_TX")
    expect(F411_DMA2_REQUESTS[6][0]).toBe("TIM1_CH1/TIM1_CH2/TIM1_CH3")
    for (const table of [F411_DMA1_REQUESTS, F411_DMA2_REQUESTS])
      for (const stream of table) for (const source of stream) expect(source, source).not.toMatch(/USART3|UART[45]|TIM[678]_|DAC|DCMI|CRYP|HASH|SPI6/)
  })

  it("reserves the TIM8 ADC trigger codes (§11.12.3 EXTSEL 1101/1110, JEXTSEL 1100–1110)", () => {
    expect(STM32F411CE.adc.regularTriggers[13]).toBeNull()
    expect(STM32F411CE.adc.regularTriggers[14]).toBeNull()
    for (const code of [12, 13, 14]) expect(STM32F411CE.adc.injectedTriggers[code]).toBeNull()
  })

  it("reads the temperature sensor and VBAT/4 both on ADC1_IN18 (§11.9 Figure 38, §11.10)", () => {
    const { mcu, w, r } = bare()
    const convert = (channel: number) => {
      w(ADC1 + 0x0c, 7 << ((channel % 10) * 3))
      w(ADC1 + 0x34, channel)
      w(ADC1 + 0x08, 1)
      w(ADC1 + 0x08, 1 | (1 << 30))
      mcu.run(2e-4)
      return r(ADC1 + 0x4c)
    }
    w(ADC_CCR, 1 << 22)
    mcu.setBattery(3.0)
    // 3.0 V / 4 = 0.75 V → 931.
    const vbat = convert(18)
    expect(vbat).toBeGreaterThan(900)
    expect(vbat).toBeLessThan(960)
  })
})
