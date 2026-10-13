import { describe, expect, it } from "vitest"
import { STM32F746IG } from "@/mcu/chip"
import { Stm32 } from "@/mcu/stm32f429"
import { buffer, example } from "../lib/firmware"

const DONE = 0xc0ffee00
const SVCALL = 11
const BUS_FAULT = 5
const HARD_FAULT = 3
const PRECISERR_BFARVALID = 0x8200
const FORCED = 0x40000000
const USAGE_FAULT = 6
const UNDEFINSTR = 0x10000
const THREAD_PSP_NO_FP = 0xfffffffd
const SYST_RVR = 0xe000e014
const SYST_CSR = 0xe000e010
const STIR = 0xe000ef00

function runToBreakpoint(jit: boolean) {
  const mcu = new Stm32(STM32F746IG)
  mcu.cpu.jit = jit
  mcu.load(buffer(example("exam-privilege.elf")), "exam-privilege.elf")
  mcu.run(0.01)
  const base = mcu.firmware!.symbols.find((s) => s.name === "results")!.value
  const word = (i: number) => mcu.bus.peek(base + 4 * i, 4)! >>> 0
  const header = word(0)
  return { mcu, header, result: (n: number) => word(n) }
}

describe.each([
  ["compiled blocks", true],
  ["the interpreter", false],
])("Thread and Handler modes, privilege, MSP and PSP on the F746 (%s)", (_, jit) => {
  const { mcu, header, result } = runToBreakpoint(jit)

  it("runs to the end", () => {
    expect(mcu.cpu.halted?.reason).toBe("bkpt")
    expect(header >>> 8 << 8 >>> 0, "results written").toBe(DONE)
    expect(header & 0xff).toBe(49)
  })

  it("starts privileged in Thread mode on MSP", () => {
    expect.soft(result(1), "CONTROL").toBe(0)
    expect.soft(result(2), "IPSR").toBe(0)
  })

  it("moves Thread mode to PSP with CONTROL.SPSEL", () => {
    expect.soft(result(3), "CONTROL").toBe(2)
    expect.soft(result(4), "SP inside the process stack").toBe(1)
  })

  it("takes SVC in Handler mode on MSP and stacks the frame on PSP", () => {
    expect.soft(result(5), "IPSR in the handler").toBe(SVCALL)
    expect.soft(result(6), "EXC_RETURN").toBe(THREAD_PSP_NO_FP)
    expect.soft(result(7), "CONTROL in Handler mode").toBe(0)
    expect.soft(result(8), "frame on the process stack").toBe(1)
    expect.soft(result(9), "MSP back where it was").toBe(1)
    expect.soft(result(10), "PSP back where it was").toBe(1)
  })

  it("drops privilege with CONTROL.nPRIV and keeps unprivileged code from the special registers", () => {
    expect.soft(result(11), "CONTROL").toBe(3)
    expect.soft(result(12), "MRS MSP").toBe(0)
    expect.soft(result(13), "MRS PSP").toBe(0)
    expect.soft(result(14), "MRS BASEPRI").toBe(0)
    expect.soft(result(15), "MSR CONTROL ignored").toBe(3)
  })

  it("answers an unprivileged access to the System Control Space with a precise BusFault", () => {
    expect.soft(result(16), "faults after the SysTick reload write").toBe(1)
    expect.soft(result(17), "exception").toBe(BUS_FAULT)
    expect.soft(result(18), "BFSR").toBe(PRECISERR_BFARVALID)
    expect.soft(result(19), "BFAR").toBe(SYST_RVR)
    expect.soft(result(20), "faults after a read of SYST_CSR").toBe(2)
    expect.soft(result(21), "BFAR").toBe(SYST_CSR)
    expect.soft(result(22), "faults after STIR without USERSETMPEND").toBe(3)
    expect.soft(result(23), "BFAR").toBe(STIR)
  })

  it("gets privilege back through SVC, with nothing the unprivileged code tried having happened", () => {
    expect.soft(result(24), "CONTROL").toBe(2)
    expect.soft(result(25), "EXC_RETURN").toBe(THREAD_PSP_NO_FP)
    expect.soft(result(26), "BASEPRI").toBe(0x80)
    expect.soft(result(27), "PRIMASK after the unprivileged CPSID").toBe(0)
    expect.soft(result(28), "SysTick reload").toBe(0x777)
  })

  it("lets unprivileged code pend an interrupt through STIR with CCR.USERSETMPEND", () => {
    expect.soft(result(29), "faults").toBe(0)
    expect.soft(result(30), "interrupt taken").toBe(1)
  })

  it("escalates the BusFault to a forced HardFault with BusFault disabled", () => {
    expect.soft(result(31), "faults").toBe(1)
    expect.soft(result(32), "exception").toBe(HARD_FAULT)
    expect.soft(result(33), "HFSR").toBe(FORCED)
    expect.soft(result(34), "CFSR").toBe(PRECISERR_BFARVALID)
  })

  it("comes back to privileged Thread mode on MSP", () => {
    expect.soft(result(35), "CONTROL").toBe(0)
    expect.soft(result(36), "SP inside the process stack").toBe(0)
    expect.soft(result(37), "SVC calls").toBe(4)
  })

  it("escalates an SVC that cannot preempt (PRIMASK set) to a forced HardFault, the handler never entered", () => {
    expect.soft(result(38), "faults").toBe(1)
    expect.soft(result(39), "exception").toBe(HARD_FAULT)
    expect.soft(result(40), "HFSR").toBe(FORCED)
    expect.soft(result(41), "SVC calls").toBe(4)
  })

  it("escalates a UsageFault to a forced HardFault with UsageFault disabled", () => {
    expect.soft(result(42), "faults").toBe(1)
    expect.soft(result(43), "exception").toBe(HARD_FAULT)
    expect.soft(result(44), "HFSR").toBe(FORCED)
    expect.soft(result(45), "CFSR").toBe(UNDEFINSTR)
  })

  it("takes the same UsageFault as itself once SHCSR.USGFAULTENA is set", () => {
    expect.soft(result(46), "faults").toBe(1)
    expect.soft(result(47), "exception").toBe(USAGE_FAULT)
    expect.soft(result(48), "HFSR").toBe(0)
    expect.soft(result(49), "CFSR").toBe(UNDEFINSTR)
  })
})
