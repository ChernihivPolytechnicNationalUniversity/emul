/**
 * STM32F401CC and F401CE against RM0368 Rev 6 where they differ from the F411 (RM0383 Rev 4); the comparison is
 * docs/blackpill-f401/f401-vs-f411.md. Every expectation names the section or table it comes from.
 */
import { describe, expect, it } from "vitest"
import { STM32F401CC, STM32F401CE, type ChipProfile } from "@/mcu/chip"
import { F401_DMA1_REQUESTS, F401_DMA2_REQUESTS, F411_DMA1_REQUESTS, F411_DMA2_REQUESTS } from "@/mcu/periph/dma"
import { Stm32 } from "@/mcu/stm32f429"
import { buffer, example } from "../lib/firmware"

const RCC = 0x40023800
const FLASH = 0x40023c00
const PWR = 0x40007000
const STIR = 0xe000ef00
const ISPR = 0xe000e200

/** adc-idle.elf (a WFI loop) with its initial SP moved to the top of the part's SRAM. */
function bare(chip: ChipProfile) {
  const image = buffer(example("adc-idle.elf")).slice(0)
  const view = new DataView(image)
  const sram = chip.memory.find((m) => m.name === "SRAM")!
  view.setUint32(0x1000, sram.base + sram.size, true)
  const mcu = new Stm32(chip)
  mcu.load(image, "adc-idle.elf")
  mcu.run(1e-5)
  expect(mcu.cpu.halted).toBeNull()
  return { mcu, w: (addr: number, value: number) => mcu.bus.write(addr, value >>> 0, 4), r: (addr: number) => mcu.bus.read(addr, 4) >>> 0 }
}

describe.each([
  { chip: STM32F401CC, dev: 0x423, flashKb: 256, sramKb: 64, sectors: [16, 16, 16, 16, 64, 128] },
  { chip: STM32F401CE, dev: 0x433, flashKb: 512, sramKb: 96, sectors: [16, 16, 16, 16, 64, 128, 128, 128] },
])("$chip.name to RM0368 Rev 6", ({ chip, dev, flashKb, sramKb, sectors }) => {
  it("identifies by DEV_ID (§23.6.1) with REV_ID 0x1001, markings 1/Z (ES0222/ES0299 Table 2)", () => {
    expect(bare(chip).r(0xe0042000)).toBe((0x1001 << 16) | dev)
  })

  it("has its flash and SRAM (§2.3 Tables 3/4) and sectors (§3.3 Table 5)", () => {
    expect(chip.memory.find((m) => m.name === "FLASH")!.size).toBe(flashKb * 1024)
    expect(chip.memory.find((m) => m.name === "SRAM")!.size).toBe(sramKb * 1024)
    expect(chip.flash.sectors.map((s) => s / 1024)).toEqual(sectors)
  })

  it("has 85 interrupt lines, 0–84, SPI4 last: no SPI5 (§10.1.3 Table 38)", () => {
    const { w, r } = bare(chip)
    w(STIR, 84)
    expect(r(ISPR + 8) & (1 << (84 - 64))).not.toBe(0)
    w(STIR, 85)
    expect(r(ISPR + 8) & (1 << (85 - 64))).toBe(0)
  })

  it("has SPI1–4, no SPI5 (Table 1)", () => {
    expect(bare(chip).mcu.spi.map((x) => x.name)).toEqual(["SPI1", "SPI2", "SPI3", "SPI4"])
  })

  it("keeps four LATENCY bits, RDERR and SPRMOD as the F411 (§3.8.1, §3.8.4, §3.8.6)", () => {
    const { mcu, w, r } = bare(chip)
    w(FLASH, 0xf)
    expect(r(FLASH) & 0xf).toBe(0xf)
    expect(mcu.flash.def(0x0c)!.w1c! & (1 << 8)).toBe(1 << 8)
    expect(mcu.flash.def(0x14)!.rw! & (1 << 31)).toBe(1 << 31)
  })

  it("resets PWR_CR to 0x0000 8000 with no FMSSR/FISSR (§5.4.1: bits 31:16 reserved)", () => {
    const { w, r } = bare(chip)
    expect(r(PWR)).toBe(0x8000)
    w(PWR, 0xffffffff)
    expect(r(PWR) & ~0xc).toBe(0x0000efff & ~0xc)
  })

  it("has DCKCFGR with TIMPRE alone (§6.3.21) and no PLLSAI", () => {
    const { mcu, w, r } = bare(chip)
    w(RCC + 0x8c, 0xffffffff)
    expect(r(RCC + 0x8c)).toBe(1 << 24)
    expect(mcu.rcc.def(0x88)).toBeUndefined()
  })

  it("feeds PLLI2S through PLLCFGR.PLLM, PLLI2SCFGR bits 5:0 reserved (§6.3.2, §6.3.20)", () => {
    const { mcu, w, r } = bare(chip)
    // HSI 16 MHz / PLLM 8 × PLLI2SN 192 / PLLI2SR 2 = 192 MHz; the 63 written to bits 5:0 is dropped.
    w(RCC + 0x04, 8 | (336 << 6))
    w(RCC + 0x84, (2 << 28) | (192 << 6) | 63)
    expect(r(RCC + 0x84) & 0x3f).toBe(0)
    w(RCC, r(RCC) | (1 << 26))
    mcu.run(1e-3)
    expect(mcu.rcc.i2sHz()).toBe(192e6)
  })

  it("keeps the F411's RCC LPENR and PLLI2SCFGR resets (§6.3.13, §6.3.15, §6.3.16, §6.3.20)", () => {
    const { r } = bare(chip)
    expect([r(RCC + 0x50), r(RCC + 0x60), r(RCC + 0x64), r(RCC + 0x84)]).toEqual([0x0061900f, 0x10e2c80f, 0x00077930, 0x24003000])
  })
})

describe("RM0368 Tables 28/29: the F411's DMA map less nine requests", () => {
  it("empties DMA1 S1 ch0 (I2C1_TX) and S7 ch6 (USART2_RX), DMA2 S2 ch2 (SPI1_TX), S4 ch4 (SPI4_RX) and every SPI5 request", () => {
    const changed: string[] = []
    for (const [n, a, b] of [[1, F411_DMA1_REQUESTS, F401_DMA1_REQUESTS], [2, F411_DMA2_REQUESTS, F401_DMA2_REQUESTS]] as const)
      a.forEach((stream, s) => stream.forEach((source, c) => source !== b[s][c] && changed.push(`DMA${n} S${s} ch${c} ${source}→${b[s][c] || "–"}`)))
    expect(changed.sort()).toEqual(
      ["DMA1 S1 ch0 I2C1_TX→–", "DMA1 S7 ch6 USART2_RX→–", "DMA2 S2 ch2 SPI1_TX→–", "DMA2 S3 ch2 SPI5_RX→–", "DMA2 S4 ch2 SPI5_TX→–", "DMA2 S4 ch4 SPI4_RX→–", "DMA2 S5 ch5 SPI5_TX→–", "DMA2 S5 ch7 SPI5_RX→–", "DMA2 S6 ch7 SPI5_TX→–"].sort(),
    )
  })
})
