import { describe, expect, it } from "vitest"
import { STM32F746IG } from "@/mcu/chip"
import { EXC } from "@/mcu/faults"
import { Stm32 } from "@/mcu/stm32f429"
import { buffer, example } from "../lib/firmware"

const DONE = 0xc0ffee00
const MEM_MANAGE = 4
const HARD_FAULT = 3
const DACCVIOL_MMARVALID = 0x82
const IACCVIOL = 0x01
const FORCED = 0x40000000
const RCC_CR = 0x40023800
const EIGHT_UNIFIED_REGIONS = 0x800

function run(jit: boolean) {
  const mcu = new Stm32(STM32F746IG)
  mcu.cpu.jit = jit
  mcu.load(buffer(example("exam-mpu.elf")), "exam-mpu.elf")
  mcu.run(0.01)
  const symbol = (name: string) => mcu.firmware!.symbols.find((s) => s.name === name)!.value
  const base = symbol("results")
  const word = (i: number) => mcu.bus.peek(base + 4 * i, 4)! >>> 0
  return { mcu, header: word(0), result: word, symbol }
}

describe.each([
  ["compiled blocks", true],
  ["the interpreter", false],
])("the Cortex-M7 MPU of the F746 (%s)", (_, jit) => {
  const { mcu, header, result, symbol } = run(jit)

  it("reports eight unified regions and selects them through RBAR.VALID", () => {
    expect.soft(result(1), "MPU_TYPE").toBe(EIGHT_UNIFIED_REGIONS)
    expect.soft(result(2), "RNR after RBAR with VALID").toBe(5)
    expect.soft(result(3), "RBAR reads back with REGION").toBe((symbol("guarded") | 5) >>> 0)
    expect.soft(result(4), "RBAR.REGION follows RNR").toBe(0)
    expect.soft(result(5), "RASR: XN, full access, 64 bytes, enabled").toBe(0x13000009)
  })

  it("lets privileged code use a privileged-only region", () => {
    expect.soft(result(6), "read back").toBe(0x11)
    expect.soft(result(7), "faults").toBe(0)
  })

  it("refuses a privileged write into a read-only region: MemManage, DACCVIOL with MMFAR", () => {
    expect.soft(result(8), "faults").toBe(1)
    expect.soft(result(9), "exception").toBe(MEM_MANAGE)
    expect.soft(result(10), "MMFSR").toBe(DACCVIOL_MMARVALID)
    expect.soft(result(11), "MMFAR is the word written").toBe(1)
    expect.soft(result(12), "the word is unchanged").toBe(0)
  })

  it("refuses to execute from an XN region: IACCVIOL without MMFAR, and runs the code once XN is off", () => {
    expect.soft(result(13), "faults").toBe(1)
    expect.soft(result(14), "exception").toBe(MEM_MANAGE)
    expect.soft(result(15), "MMFSR").toBe(IACCVIOL)
    expect.soft(result(16), "stacked PC at the code").toBe(1)
    expect.soft(result(17), "the code's answer").toBe(42)
  })

  it("gives an overlap to the higher-numbered region", () => {
    expect.soft(result(18), "faults").toBe(0)
    expect.soft(result(19), "written").toBe(0x33)
  })

  it("passes an access in a disabled sub-region to the region below", () => {
    expect.soft(result(20), "faults in the disabled sub-region").toBe(0)
    expect.soft(result(21), "faults in the next sub-region").toBe(1)
    expect.soft(result(22), "MMFAR").toBe(1)
    expect.soft(result(23), "written through the region below").toBe(0x55)
    expect.soft(result(24), "refused").toBe(0)
  })

  it("holds unprivileged code to the unprivileged permissions, with no background region", () => {
    expect.soft(result(25), "faults after reading a privileged-only word").toBe(1)
    expect.soft(result(26), "MMFSR").toBe(DACCVIOL_MMARVALID)
    expect.soft(result(27), "MMFAR").toBe(1)
    expect.soft(result(28), "read-only for unprivileged: read").toBe(0x77)
    expect.soft(result(29), "faults after writing it").toBe(2)
    expect.soft(result(30), "MMFAR").toBe(1)
    expect.soft(result(31), "faults after reading a peripheral no region covers").toBe(3)
    expect.soft(result(32), "a MemManage, not a BusFault").toBe(MEM_MANAGE)
    expect.soft(result(33), "MMFAR").toBe(RCC_CR)
    expect.soft(result(34), "CONTROL after SVC back").toBe(0)
  })

  it("uses the default map as a background for privileged code only with PRIVDEFENA", () => {
    expect.soft(result(35), "faults without PRIVDEFENA").toBe(1)
    expect.soft(result(36), "MMFAR").toBe(RCC_CR)
    expect.soft(result(37), "faults with PRIVDEFENA").toBe(0)
  })

  it("is bypassed at priority −1 while HFNMIENA is clear", () => {
    expect.soft(result(38), "faults with FAULTMASK set").toBe(0)
    expect.soft(result(39), "read through a no-access region").toBe(0x11)
    expect.soft(result(40), "faults with FAULTMASK clear").toBe(1)
  })

  it("escalates to a forced HardFault with MemManage disabled", () => {
    expect.soft(result(41), "faults").toBe(1)
    expect.soft(result(42), "exception").toBe(HARD_FAULT)
    expect.soft(result(43), "HFSR").toBe(FORCED)
    expect.soft(result(44), "MMFSR").toBe(DACCVIOL_MMARVALID)
  })

  it("checks nothing while disabled but the default map's XN: no fetch from a peripheral", () => {
    expect.soft(result(45), "read").toBe(0x11)
    expect.soft(result(46), "faults").toBe(0)
    expect.soft(result(47), "faults after calling into the RCC").toBe(1)
    expect.soft(result(48), "MMFSR").toBe(IACCVIOL)
  })

  it("locks the core up on a violation at priority −1 with HFNMIENA set", () => {
    expect(header).toBe((DONE | 48) >>> 0)
    expect(mcu.cpu.halted?.reason).toBe("lockup")
    expect(mcu.cpu.scs.mmfar, "MMFAR of the access that locked it up").toBe(symbol("guarded") + 4)
  })
})

describe("what the MPU model leaves out, reported in the inspector", () => {
  const MPU_CTRL = 0xe000ed94
  const ENABLE_WITHOUT_BACKGROUND = 1

  it("says so when an exception return unstacks a frame the MPU refuses (stacking: stm32f746-stacking.test.ts)", () => {
    const mcu = new Stm32(STM32F746IG)
    mcu.load(buffer(example("exam-mpu.elf")), "exam-mpu.elf")
    mcu.bus.write(MPU_CTRL, ENABLE_WITHOUT_BACKGROUND, 4)
    mcu.cpu.exceptionEntry(EXC.PENDSV)
    mcu.cpu.exceptionReturn(mcu.cpu.r[14])
    const reported = mcu.unmodelled.summary().map((u) => u.block)
    expect(reported).not.toContain("MemManage on exception stacking (MSTKERR): the MPU refuses the frame, which was written anyway")
    expect(reported).toContain("MemManage on exception return (MUNSTKERR): the MPU refuses the frame, which was read anyway")
  })
})
