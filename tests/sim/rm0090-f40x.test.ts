/**
 * STM32F405/F407 against RM0090 Rev 22 where they differ from F42x, and DS8626 Rev 12 where the RM
 * defers to the datasheet. Every expectation names the section/table it comes from.
 */
import { describe, expect, it } from "vitest"
import { STM32F405RG, STM32F407VG } from "@/mcu/chip"
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

/** adc-idle.elf (a WFI loop) with its initial SP moved to the top of the F40x's 128 KB SRAM; it was linked for the F429's 192 KB. */
function idleImage(): ArrayBuffer {
  const image = buffer(example("adc-idle.elf")).slice(0)
  const view = new DataView(image)
  const VECTORS_IN_FILE = 0x1000 // the first PT_LOAD (0x0800_0000) starts at file offset 0x1000
  expect(view.getUint32(VECTORS_IN_FILE, true)).toBe(0x20030000)
  view.setUint32(VECTORS_IN_FILE, 0x20020000, true)
  return image
}

function bare(chip: typeof STM32F407VG) {
  const mcu = new Stm32(chip)
  mcu.load(idleImage(), "adc-idle.elf")
  mcu.run(1e-5)
  const w = (addr: number, value: number) => mcu.bus.write(addr, value >>> 0, 4)
  const r = (addr: number) => mcu.bus.read(addr, 4) >>> 0
  expect(mcu.cpu.halted).toBeNull()
  return { mcu, w, r }
}

describe.each([STM32F407VG, STM32F405RG])("$name to RM0090 (F40x)", (chip) => {
  it("identifies as DEV_ID 0x413 (§38.6.1); revision per ES0182 Table 2", () => {
    const { r } = bare(chip)
    expect(r(0xe0042000) & 0xfff).toBe(0x413)
    expect([0x1001, 0x1003, 0x1007, 0x100f, 0x101f]).toContain(r(0xe0042000) >>> 16)
  })

  it("has 82 interrupt lines, 0–81, FPU last (§12.1.1, Table 62)", () => {
    const { w, r } = bare(chip)
    w(STIR, 81)
    expect(r(ISPR + 8) & (1 << (81 - 64))).not.toBe(0)
    w(STIR, 82)
    expect(r(ISPR + 8) & (1 << (82 - 64))).toBe(0)
  })

  it("has SRAM1 + SRAM2 = 128 KB at 0x2000 0000, CCM 64 KB, no SRAM3 (§2.3.1, Table 3)", () => {
    const ram = chip.memory.filter((m) => m.kind === "ram")
    expect(ram.map((m) => [m.base, m.size])).toEqual([
      [0x20000000, 128 * 1024],
      [0x10000000, 64 * 1024],
    ])
    const { mcu } = bare(chip)
    mcu.bus.write(0x2001fffc, 0x12345678, 4)
    expect(mcu.bus.read(0x2001fffc, 4) >>> 0).toBe(0x12345678)
  })

  it("has one bank of 12 flash sectors, 1 MB (§3.3, Table 5)", () => {
    expect(chip.flash.banks).toBe(1)
    expect(chip.flash.sectors.map((s) => s / 1024)).toEqual([16, 16, 16, 16, 64, 128, 128, 128, 128, 128, 128, 128])
    expect(chip.memory.find((m) => m.kind === "flash")!.size).toBe(1024 * 1024)
  })

  it("keeps three LATENCY bits (§3.9.1, LATENCY[2:0])", () => {
    const { mcu, w, r } = bare(chip)
    w(FLASH, 0xf)
    expect(r(FLASH) & 0xf).toBe(7)
    expect(mcu.cpu.flashTiming.latency).toBe(7)
  })

  it("has no FLASH_OPTCR1 (§3.9.11: F42x/F43x only) and SNB[3:0] with no MER1 (§3.9.7)", () => {
    const { mcu, w, r } = bare(chip)
    expect(mcu.flash.def(0x18)).toBeUndefined()
    w(FLASH + 0x04, 0x45670123)
    w(FLASH + 0x04, 0xcdef89ab)
    // SNB 12 is not a sector on a one-bank part: WRPERR (§3.7.4).
    w(FLASH + 0x10, (1 << 1) | (12 << 3) | (2 << 8))
    w(FLASH + 0x10, (1 << 1) | (12 << 3) | (2 << 8) | (1 << 16))
    expect(r(FLASH + 0x0c) & (1 << 4)).toBe(1 << 4)
  })

  it("resets PWR_CR to 0x0000 4000 with a one-bit VOS and no over-drive (§5.4.1, Table 32)", () => {
    const { w, r } = bare(chip)
    expect(r(PWR)).toBe(0x4000)
    w(PWR, 0x4000 | (1 << 16) | (1 << 17) | (3 << 18) | (1 << 15) | (1 << 13))
    expect(r(PWR)).toBe(0x4000)
    expect(r(PWR + 4) & ((1 << 16) | (1 << 17))).toBe(0)
  })

  it("resets the RCC to the F40x values and has no PLLSAI or DCKCFGR (§7.3, Table 35)", () => {
    const { mcu, w, r } = bare(chip)
    expect(r(RCC + 0x50)).toBe(0x7e6791ff)
    expect(r(RCC + 0x60)).toBe(0x36fec9ff)
    expect(r(RCC + 0x64)).toBe(0x00075f33)
    expect(r(RCC + 0x84)).toBe(0x20003000)
    expect(mcu.rcc.def(0x88)).toBeUndefined()
    expect(mcu.rcc.def(0x8c)).toBeUndefined()
    w(RCC, r(RCC) | (1 << 28))
    expect(r(RCC) & ((1 << 28) | (1 << 29))).toBe(0)
  })

  it("has GPIOA–GPIOI only (§8, Table 35: no GPIOJ/K)", () => {
    const { mcu } = bare(chip)
    expect(mcu.gpio).toHaveLength(9)
  })

  it("has USART1–3, UART4–5, USART6, SPI1–3, I2C1–3 and no LTDC, DMA2D, SAI (Tables 1, 35, 62)", () => {
    const { mcu } = bare(chip)
    expect(mcu.usart.map((x) => x.name)).toEqual(["USART1", "USART2", "USART3", "UART4", "UART5", "USART6"])
    expect(mcu.spi.map((x) => x.name)).toEqual(["SPI1", "SPI2", "SPI3"])
    expect(mcu.i2c.map((x) => x.name)).toEqual(["I2C1", "I2C2", "I2C3"])
    for (const addr of [0x40016800, 0x4002b000, 0x40015800]) expect(mcu.bus.peripheralAt(addr)?.name ?? "", addr.toString(16)).not.toMatch(/LTDC|DMA2D|SAI/)
  })

  it("has no I2C_FLTR (§27.6.10: F42x/F43x only)", () => {
    const { mcu } = bare(chip)
    expect(mcu.i2c[0].def(0x24)).toBeUndefined()
  })

  it("has the FSMC: no SDRAM registers (§36.6.9, Table 253)", () => {
    const { mcu } = bare(chip)
    expect(mcu.fmc.def(0x00)).toBeDefined()
    expect(mcu.fmc.def(0x140)).toBeUndefined()
  })

  it("masks SYSCFG MEMRMP to MEM_MODE[1:0] and PMC to MII_RMII_SEL (§9.2.1, §9.2.2)", () => {
    const { w, r } = bare(chip)
    w(SYSCFG, 0xffffffff)
    expect(r(SYSCFG)).toBe(0x3)
    w(SYSCFG, 0)
    w(SYSCFG + 4, 0xffffffff)
    expect(r(SYSCFG + 4)).toBe(0x00800000)
  })

  it("reads the temperature sensor on ADC1_IN16 and VBAT/2 on IN18 (§13.3.3, §13.11; DS8626 T71)", () => {
    const { mcu, w, r } = bare(chip)
    const convert = (channel: number) => {
      w(ADC1 + 0x0c, 7 << ((channel % 10) * 3))
      w(ADC1 + 0x34, channel)
      w(ADC1 + 0x08, 1)
      w(ADC1 + 0x08, 1 | (1 << 30))
      mcu.run(2e-4)
      return r(ADC1 + 0x4c)
    }
    w(ADC_CCR, 1 << 23)
    const t = convert(16)
    // 25 °C → V25 = 0.76 V (DS8626 T69): 0.76 / 3.3 × 4095 ≈ 943.
    expect(t).toBeGreaterThan(900)
    expect(t).toBeLessThan(990)
    w(ADC_CCR, 1 << 22)
    mcu.setBattery(3.0)
    const vbat = convert(18)
    // 3.0 V / 2 = 1.5 V → 1861.
    expect(vbat).toBeGreaterThan(1820)
    expect(vbat).toBeLessThan(1900)
  })
})
