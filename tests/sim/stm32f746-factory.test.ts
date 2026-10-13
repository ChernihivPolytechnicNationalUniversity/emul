import { describe, expect, it } from "vitest"
import { BusFault } from "@/mcu/bus"
import { STM32F429ZI, STM32F746IG } from "@/mcu/chip"
import { Stm32 } from "@/mcu/stm32f429"
import { BENCH_SINGLE_READING_SPREAD_LSB as SPREAD } from "../lib/adc-bench"
import { buffer, example } from "../lib/firmware"

const RM0385 = {
  otp: { base: 0x1ff0f000, end: 0x1ff0f41f },
  uid: 0x1ff0f420,
  flashSize: 0x1ff0f442,
  packageData: 0x1ff0f7e0,
}
const DS10916 = { vrefintCal: 0x1ff0f44a, tsCal1: 0x1ff0f44c, tsCal2: 0x1ff0f44e }
const LQFP176_PACKAGE = 0b011
const ITCM_ALIAS_OFFSET = 0x1ff0f000 - 0x0010f000
const CALIBRATION_VDDA_MV = 3300
const DS10916_V25 = 0.76
const DS10916_AVG_SLOPE = 2.5e-3
const DS10916_VREFINT = { min: 1.18, max: 1.24 }
const BENCH_CHIP_2026_10_12 = {
  uid: [0x003c0027, 0x3138510a, 0x34303331],
  flashSizeKb: 1024,
  vrefintCal: 1499,
  tsCal1: 938,
  tsCal2: 1192,
  packageData: 0xfb77,
}
const factory = STM32F746IG.factory!
const volts = (code: number) => (code / 4095) * (CALIBRATION_VDDA_MV / 1000)
const TS_LSB_PER_DEGREE = (BENCH_CHIP_2026_10_12.tsCal2 - BENCH_CHIP_2026_10_12.tsCal1) / 80
const VDDA_MV_PER_VREFINT_LSB = CALIBRATION_VDDA_MV / BENCH_CHIP_2026_10_12.vrefintCal

describe("STM32F746IG factory-programmed bytes", () => {
  const mcu = new Stm32(STM32F746IG)
  const half = (addr: number) => mcu.bus.read(addr, 2)
  const word = (addr: number) => mcu.bus.read(addr, 4) >>> 0

  it("sit at RM0385 §41 and DS10916 Tables 70 and 73's addresses", () => {
    expect(factory.otp).toEqual({ base: RM0385.otp.base, size: RM0385.otp.end + 1 - RM0385.otp.base })
    expect(factory.uid.at).toBe(RM0385.uid)
    expect(factory.flashSizeKb.at).toBe(RM0385.flashSize)
    expect(factory.packageData.at).toBe(RM0385.packageData)
    expect(factory.vrefintCal.at).toBe(DS10916.vrefintCal)
    expect(factory.tsCal1.at).toBe(DS10916.tsCal1)
    expect(factory.tsCal2.at).toBe(DS10916.tsCal2)
  })

  it("are the bench chip's own, as firmware/ports/pinlab.c printed them on 2026-10-12", () => {
    expect({
      uid: factory.uid.words,
      flashSizeKb: factory.flashSizeKb.value,
      vrefintCal: factory.vrefintCal.value,
      tsCal1: factory.tsCal1.value,
      tsCal2: factory.tsCal2.value,
      packageData: factory.packageData.value,
    }).toEqual(BENCH_CHIP_2026_10_12)
    expect(factory.tsCal1.celsius).toBe(30)
    expect(factory.tsCal2.celsius).toBe(110)
    expect(factory.calibrationVdda * 1000).toBe(CALIBRATION_VDDA_MV)
  })

  it("make sense against DS10916: VREFINT_CAL inside Table 72's 1.18–1.24 V, the TS_CAL line near Table 69's typical V25 and slope", () => {
    expect(volts(factory.vrefintCal.value)).toBeGreaterThan(DS10916_VREFINT.min)
    expect(volts(factory.vrefintCal.value)).toBeLessThan(DS10916_VREFINT.max)
    const slope = (volts(factory.tsCal2.value) - volts(factory.tsCal1.value)) / (factory.tsCal2.celsius - factory.tsCal1.celsius)
    const v25 = volts(factory.tsCal1.value) - (factory.tsCal1.celsius - 25) * slope
    expect(slope * 1e3, "mV/°C").toBeNearRel(DS10916_AVG_SLOPE * 1e3, 0.05)
    expect(v25, "V at 25 °C").toBeNear(DS10916_V25, 0.025)
  })

  it("read back as the profile has them, in words, halfwords and bytes", () => {
    expect([0, 1, 2].map((i) => word(RM0385.uid + 4 * i))).toEqual(factory.uid.words)
    expect(mcu.bus.read(RM0385.uid, 1), "UID byte 0").toBe(factory.uid.words[0] & 0xff)
    expect(half(RM0385.flashSize), "F_SIZE in KB").toBe(1024)
    expect(half(RM0385.flashSize) * 1024, "the flash the profile maps").toBe(STM32F746IG.memory.find((m) => m.kind === "flash")!.size)
    expect((half(RM0385.packageData) >> 8) & 7, "PKG[2:0]: LQFP176").toBe(LQFP176_PACKAGE)
    expect(half(DS10916.vrefintCal)).toBe(factory.vrefintCal.value)
    expect(half(DS10916.tsCal1)).toBe(factory.tsCal1.value)
    expect(half(DS10916.tsCal2)).toBe(factory.tsCal2.value)
  })

  it("leave the OTP area erased, through the AXI address and the ITCM alias", () => {
    for (let addr = RM0385.otp.base; addr <= RM0385.otp.end; addr += 4) {
      if (word(addr) !== 0xffffffff) expect.fail(`OTP word at 0x${addr.toString(16)} is 0x${word(addr).toString(16)}`)
    }
    expect(word(RM0385.uid - ITCM_ALIAS_OFFSET), "UID through the ITCM alias").toBe(factory.uid.words[0])
  })

  it.each([
    ["OTP", RM0385.otp.base],
    ["UID", RM0385.uid],
    ["flash size", RM0385.flashSize],
    ["VREFINT_CAL", DS10916.vrefintCal],
    ["package data", RM0385.packageData],
  ])("fault on a write to %s, as ROM does", (_, addr) => {
    expect(() => mcu.bus.write(addr, 0, 2)).toThrow(BusFault)
    expect(() => mcu.bus.write(addr - ITCM_ALIAS_OFFSET, 0, 2)).toThrow(BusFault)
  })

  it("survive a firmware load, which erases flash and RAM", () => {
    mcu.load(buffer(example("open746-factory.elf")), "open746-factory.elf")
    expect(word(RM0385.uid)).toBe(factory.uid.words[0])
    expect(half(DS10916.vrefintCal)).toBe(factory.vrefintCal.value)
  })
})

describe("firmware calibrating the ADC with them on the F746", () => {
  const mcu = new Stm32(STM32F746IG)
  mcu.load(buffer(example("open746-factory.elf")), "open746-factory.elf")
  mcu.run(0.005)
  const bench = mcu.firmware!.symbols.find((s) => s.name === "bench")!.value
  const field = (index: number) => mcu.bus.read(bench + 4 * index, 4) | 0
  const result = {
    done: field(0),
    uid: [field(1) >>> 0, field(2) >>> 0, field(3) >>> 0],
    otpAnd: field(4) >>> 0,
    flashSizeKb: field(5),
    packageData: field(6),
    vrefintCal: field(7),
    tsCal1: field(8),
    tsCal2: field(9),
    vrefint: field(10),
    temperature: field(11),
    vddaMv: field(12),
    centidegrees: field(13),
    vbatQuarter: field(14),
    vbatWithBoth: field(15),
    adc3Vrefint: field(16),
  }

  it("runs to the end without a fault", () => {
    expect(mcu.cpu.halted, "core not halted").toBeNull()
    expect(result.done).toBe(1)
  })

  it("reads the signature the way HAL_GetUIDw0/1/2 and LL_GetFlashSize do", () => {
    expect(result.uid).toEqual(factory.uid.words)
    expect(result.otpAnd, "every OTP word erased").toBe(0xffffffff)
    expect(result.flashSizeKb).toBe(1024)
    expect((result.packageData >> 8) & 7).toBe(LQFP176_PACKAGE)
  })

  it("gets VDDA = 3.3 V back from VREFINT_CAL and the VREFINT channel", () => {
    expect(result.vrefint, "one VREFINT conversion at VDDA = 3.3 V: the calibration value within the bench's single-reading spread").toBeNear(result.vrefintCal, SPREAD)
    expect(result.vddaMv, "mV, one conversion's noise carried through 3300 · CAL / VREFINT").toBeNear(CALIBRATION_VDDA_MV, SPREAD * VDDA_MV_PER_VREFINT_LSB)
  })

  it("gets 25 °C back from TS_CAL1/TS_CAL2: the model's sensor follows this chip's own calibration line, at 25 °C", () => {
    expect(result.tsCal1).toBe(BENCH_CHIP_2026_10_12.tsCal1)
    expect(result.tsCal2).toBe(BENCH_CHIP_2026_10_12.tsCal2)
    expect(result.centidegrees / 100, "°C, one conversion's noise over the TS_CAL slope").toBeNear(25, SPREAD / TS_LSB_PER_DEGREE)
  })

  it("puts the temperature sensor and VBAT/4 on ADC1_IN18, VBAT winning when both are on, and gives ADC2/ADC3 no internal channels (RM0385 §15.10–15.11)", () => {
    const quarterCode = (volts: number) => Math.round((volts / 4 / 3.3) * 4095)
    expect(result.vbatQuarter, "VBAT/4 with VBAT at the 3.3 V default").toBeNear(quarterCode(3.3), SPREAD)
    expect(result.vbatWithBoth, "TSVREFE and VBATE both set: only VBAT is converted").toBeNear(result.vbatQuarter, 2 * SPREAD)
    expect(result.adc3Vrefint, "VREFINT is ADC1's alone: ADC3 converts nothing but its own noise").toBeLessThanOrEqual(SPREAD)
    const board = new Stm32(STM32F746IG)
    board.load(buffer(example("open746-factory.elf")), "open746-factory.elf")
    board.setBattery(3.0)
    board.run(0.005)
    const at = board.firmware!.symbols.find((s) => s.name === "bench")!.value
    expect(board.bus.read(at + 4 * 14, 4) | 0, "VBAT/4 follows the VBAT pin, here a 3.0 V cell").toBeNear(quarterCode(3.0), SPREAD)
  })

  it("reads VDDA back as the supply the board gives it, not the 3.3 V of the calibration", () => {
    const board = new Stm32(STM32F746IG)
    board.load(buffer(example("open746-factory.elf")), "open746-factory.elf")
    board.setSupply(3.29)
    board.run(0.005)
    const at = board.firmware!.symbols.find((s) => s.name === "bench")!.value
    expect(board.bus.read(at + 4 * 12, 4) | 0, "mV, one conversion's noise carried through 3300 · CAL / VREFINT").toBeNear(3290, SPREAD * VDDA_MV_PER_VREFINT_LSB)
  })
})

describe("STM32F429ZI factory-programmed bytes", () => {
  it("are not modelled: DS9405/RM0090 are not in the repository to take the addresses from, so a read faults", () => {
    const mcu = new Stm32(STM32F429ZI)
    expect(STM32F429ZI.factory).toBeUndefined()
    expect(() => mcu.bus.read(0x1fff7a10, 4)).toThrow(BusFault)
  })
})
