import { describe, expect, it } from "vitest"
import { STM32F429ZI, STM32F746IG } from "@/mcu/chip"
import { Stm32 } from "@/mcu/stm32f429"
import { buffer, example } from "../lib/firmware"

const value = (index: number) => (0xa5c30000 | (index << 8) | (31 - index)) >>> 0
const backupAddress = (index: number) => 0x40002850 + index * 4

describe.each([STM32F429ZI, STM32F746IG])("$name RTC backup registers and DBGMCU", (chip) => {
  it("reads the chip identity and all implemented backup words from firmware", () => {
    const mcu = new Stm32(chip)
    mcu.load(buffer(example("open746-backup.elf")), "open746-backup.elf")
    expect(mcu.run(0.002)).toBe(true)
    expect(mcu.cpu.halted).toBeNull()
    const bench = mcu.firmware!.symbols.find((s) => s.name === "bench")!.value
    expect(mcu.bus.read(bench, 4)).toBe(1)
    expect(mcu.bus.read(bench + 4, 4) >>> 0).toBe(chip.id === "stm32f746ig" ? 0x10016449 : 0x20016419)
    const count = chip.id === "stm32f746ig" ? 32 : 20
    expect(mcu.rtc.registerList().filter((d) => d.name.startsWith("BKP"))).toHaveLength(count)
    for (let i = 0; i < 32; i++) {
      expect(mcu.bus.read(bench + 8 + i * 4, 4) >>> 0, `BKP${i}R firmware read`).toBe(i < count ? value(i) : 0)
      expect(mcu.rtc.def(0x50 + 4 * i) !== undefined, `BKP${i}R in register map`).toBe(i < count)
    }
  })

  it("retains the full backup bank through a system reset and a VBAT-backed power cycle", () => {
    const mcu = new Stm32(chip)
    for (let i = 0; i < chip.rtcBackupRegisters; i++) mcu.bus.write(backupAddress(i), value(i), 4)
    mcu.reset("system")
    for (let i = 0; i < chip.rtcBackupRegisters; i++) expect(mcu.bus.read(backupAddress(i), 4) >>> 0).toBe(value(i))
    mcu.reset("por", { backup: true })
    for (let i = 0; i < chip.rtcBackupRegisters; i++) expect(mcu.bus.read(backupAddress(i), 4) >>> 0).toBe(value(i))
    mcu.reset("por")
    for (let i = 0; i < chip.rtcBackupRegisters; i++) expect(mcu.bus.read(backupAddress(i), 4)).toBe(0)
  })

  it("keeps words beyond the chip's backup bank outside its register map", () => {
    const mcu = new Stm32(chip)
    for (let i = chip.rtcBackupRegisters; i < 34; i++) {
      mcu.bus.write(backupAddress(i), 0xffffffff, 4)
      expect(mcu.rtc.def(0x50 + 4 * i)).toBeUndefined()
      expect(mcu.bus.read(backupAddress(i), 4)).toBe(0)
    }
  })
})
