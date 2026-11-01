/**
 * Register-level points of RM0090 (Rev 22) that the F429 model got wrong: the 4-bit FLASH_ACR
 * LATENCY of F42x (§3.9.2), WRPERR on an invalid sector number (§3.7.4), the F42x reset value of
 * RCC_AHB1LPENR (§6.3.15) and the I²C set, which on F4 ends at I2C3 (Table 1 memory map).
 */
import { describe, expect, it } from "vitest"
import { STM32F429ZI, STM32F746IG } from "@/mcu/chip"
import { Stm32 } from "@/mcu/stm32f429"

const FLASH = 0x40023c00
const ACR = FLASH + 0x00
const KEYR = FLASH + 0x04
const SR = FLASH + 0x0c
const CR = FLASH + 0x10
const SR_WRPERR = 1 << 4
const SR_PGSERR = 1 << 7
const CR_SER = 1 << 1
const CR_STRT = 1 << 16

describe("RM0090 on the F429 model", () => {
  it("keeps all four LATENCY bits of FLASH_ACR (§3.9.2, LATENCY[3:0])", () => {
    const mcu = new Stm32(STM32F429ZI)
    mcu.bus.write(ACR, 8, 4)
    expect(mcu.bus.read(ACR, 4) & 0xf).toBe(8)
    expect(mcu.cpu.flashTiming.latency).toBe(8)
  })

  it("flags WRPERR, not PGSERR, for a sector erase with an invalid SNB (§3.7.4)", () => {
    const mcu = new Stm32(STM32F429ZI)
    mcu.bus.write(KEYR, 0x45670123, 4)
    mcu.bus.write(KEYR, 0xcdef89ab, 4)
    // Sectors are 0–11 in bank 1 and 16–27 in bank 2 (§3.3, Table 6): 12 is not a sector.
    const cr = CR_SER | (12 << 3) | (2 << 8)
    mcu.bus.write(CR, cr, 4)
    mcu.bus.write(CR, cr | CR_STRT, 4)
    const sr = mcu.bus.read(SR, 4)
    expect(sr & SR_WRPERR).toBe(SR_WRPERR)
    expect(sr & SR_PGSERR).toBe(0)
  })

  it("resets RCC_AHB1LPENR to 0x7EEF 97FF (§6.3.15)", () => {
    const mcu = new Stm32(STM32F429ZI)
    expect(mcu.bus.read(0x40023850, 4) >>> 0).toBe(0x7eef97ff)
  })

  it("has I2C1–I2C3 only; 0x4000 6000 is not an I²C block (Table 1)", () => {
    const mcu = new Stm32(STM32F429ZI)
    expect(mcu.i2c.map((x) => x.name)).toEqual(["I2C1", "I2C2", "I2C3"])
  })

  it("keeps I2C4 on the F746 (RM0385 Table 1)", () => {
    const mcu = new Stm32(STM32F746IG)
    expect(mcu.i2c.map((x) => x.name)).toEqual(["I2C1", "I2C2", "I2C3", "I2C4"])
  })
})
