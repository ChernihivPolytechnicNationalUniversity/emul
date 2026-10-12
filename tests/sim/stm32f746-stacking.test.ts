import { describe, expect, it } from "vitest"
import { STM32F746IG } from "@/mcu/chip"
import { EXC } from "@/mcu/faults"
import { Stm32 } from "@/mcu/stm32f429"
import { buffer, example } from "../lib/firmware"

const DONE = 0xc0ffee00
const HARD_FAULT = 3
const BUS_FAULT = 5
const PENDSV = 14
const STKERR = 1 << 12
const PRECISERR = 1 << 9
const MSTKERR = 1 << 4
const MMARVALID = 1 << 7
const FORCED = 1 << 30
const VECTTBL = 1 << 1
const IRQ50_PENDING = 1 << 18
const ENTRY_WORDS = 4
const SCB_VTOR = 0xe000ed08
const SCB_SHCSR = 0xe000ed24
const MEMFAULTENA = 1 << 16
const MPU_CTRL = 0xe000ed94
const MPU_ENABLE_WITHOUT_BACKGROUND = 1
const BELOW_RAM = 0x20000010
const NOTHING_THERE = 0x30000000

function boot(elf: string) {
  const mcu = new Stm32(STM32F746IG)
  mcu.load(buffer(example(elf)), elf)
  return mcu
}

function runStacking(jit: boolean) {
  const mcu = boot("exam-stacking.elf")
  mcu.cpu.jit = jit
  mcu.run(0.05)
  const base = mcu.firmware!.symbols.find((s) => s.name === "results")!.value
  const word = (i: number) => mcu.bus.peek(base + 4 * i, 4)! >>> 0
  const entry = (n: number) => {
    const at = 2 + ENTRY_WORDS * n
    return { exc: word(at), cfsr: word(at + 1), hfsr: word(at + 2), irq50Pending: word(at + 3) }
  }
  return { mcu, header: word(0), entries: word(1), entry, depth: word(2 + ENTRY_WORDS * word(1)) }
}

describe.each([
  ["compiled blocks", true],
  ["the interpreter", false],
])("a fault on exception stacking is the firmware's fault, taken as ARMv7-M takes it (B1.5.11; PM0253 §2.5) (%s)", (_, jit) => {
  const { mcu, header, entries, entry, depth } = runStacking(jit)
  const expectEntry = (n: number, exc: number, cfsr: number, hfsr: number, irq50Pending = 0) =>
    expect.soft(entry(n), `entry ${n + 1}`).toEqual({ exc, cfsr, hfsr, irq50Pending })

  it("runs every scenario to the end", () => {
    expect(mcu.cpu.halted?.reason, mcu.cpu.halted?.message).toBe("bkpt")
    expect(header >>> 8 << 8 >>> 0, "results written").toBe(DONE)
    expect(entries, "handler entries").toBe(8)
  })

  it("enters the original exception with STKERR set and leaves the BusFault of equal priority pending", () => {
    expectEntry(0, PENDSV, STKERR, 0)
    expectEntry(1, BUS_FAULT, 0, 0)
  })

  it("enters the BusFault first when it is more urgent than the original, which stays pending", () => {
    expectEntry(2, BUS_FAULT, STKERR, 0)
    expectEntry(3, PENDSV, 0, 0)
  })

  it("escalates the stacking BusFault to a forced HardFault while BusFault is disabled, the original pending", () => {
    expectEntry(4, HARD_FAULT, STKERR, FORCED)
    expectEntry(5, PENDSV, 0, 0)
  })

  it("takes a vector the bus cannot read as a HardFault with VECTTBL, the interrupt still pending", () => {
    expectEntry(6, HARD_FAULT, 0, VECTTBL, IRQ50_PENDING)
  })

  it("runs the HardFault handler of firmware that recursed below RAM", () => {
    expectEntry(7, HARD_FAULT, PRECISERR | STKERR, FORCED)
    expect(depth, "calls deep before the stack ran out").toBeGreaterThan(2000)
  })
})

describe("faults the core cannot take lock it up, reported as a lockup and not as an emulator error", () => {
  it("a HardFault handler that needs the stack the recursion used up", () => {
    const mcu = boot("exam-overflow.elf")
    mcu.run(0.05)
    expect(mcu.cpu.halted?.reason).toBe("lockup")
    expect(mcu.cpu.halted?.message).not.toContain("emulator error")
    expect.soft(mcu.cpu.scs.cfsr & (PRECISERR | STKERR), "CFSR").toBe(PRECISERR | STKERR)
    expect.soft(mcu.cpu.scs.hfsr, "HFSR").toBe(FORCED)
  })

  it("a vector table where nothing is mapped: the HardFault vector cannot be read either", () => {
    const mcu = boot("exam-stacking.elf")
    mcu.bus.write(SCB_VTOR, NOTHING_THERE, 4)
    mcu.cpu.scs.setPending(EXC.PENDSV, true)
    expect(mcu.run(0.001)).toBe(false)
    expect(mcu.cpu.halted?.reason).toBe("lockup")
    expect(mcu.cpu.halted?.message).toContain("HardFault vector at 0x3000000c")
    expect(mcu.cpu.scs.hfsr & VECTTBL, "HFSR.VECTTBL").toBe(VECTTBL)
  })

  it("an NMI taken at priority −1 onto a stack below RAM", () => {
    const mcu = boot("exam-stacking.elf")
    mcu.cpu.faultmask = 1
    mcu.cpu.r[13] = BELOW_RAM
    mcu.cpu.scs.setPending(EXC.NMI, true)
    expect(mcu.run(0.001)).toBe(false)
    expect(mcu.cpu.halted?.reason).toBe("lockup")
    expect(mcu.cpu.halted?.message).toContain("BusFault on exception stacking")
    expect(mcu.cpu.scs.cfsr & STKERR, "CFSR.STKERR").toBe(STKERR)
  })
})

describe.each([
  ["compiled blocks", true],
  ["the interpreter", false],
])("a jump to where nothing is mapped (%s)", (_, jit) => {
  it("halts as the firmware's instruction fetch fault, not as an emulator error", () => {
    const mcu = boot("exam-stacking.elf")
    mcu.cpu.jit = jit
    mcu.cpu.pc = NOTHING_THERE
    expect(mcu.run(0.001)).toBe(false)
    expect(mcu.cpu.halted?.message).toBe("fault at 0x30000000: instruction fetch: read16 at 0x30000000: unmapped")
  })
})

describe("a frame the MPU refuses (MSTKERR)", () => {
  function refusedFrame(memManageEnabled: boolean) {
    const mcu = boot("exam-mpu.elf")
    if (memManageEnabled) mcu.bus.write(SCB_SHCSR, MEMFAULTENA, 4)
    mcu.bus.write(MPU_CTRL, MPU_ENABLE_WITHOUT_BACKGROUND, 4)
    const sp = mcu.cpu.r[13]
    mcu.cpu.exceptionEntry(EXC.PENDSV)
    return { mcu, sp }
  }

  it("enters the original exception with MSTKERR set, no fault address, the SP moved down by the frame, MemManage pending", () => {
    const { mcu, sp } = refusedFrame(true)
    expect.soft(mcu.cpu.ipsr, "IPSR").toBe(PENDSV)
    expect.soft(mcu.cpu.scs.cfsr & (MSTKERR | MMARVALID), "MMFSR").toBe(MSTKERR)
    expect.soft(mcu.cpu.scs.pending[EXC.MEM_MANAGE], "MemManage pending").toBe(1)
    expect.soft(mcu.cpu.r[13], "SP").toBe((sp - 0x20) & ~7)
  })

  it("escalates to a forced HardFault with MemManage disabled, the original pending", () => {
    const { mcu } = refusedFrame(false)
    expect.soft(mcu.cpu.ipsr, "IPSR").toBe(HARD_FAULT)
    expect.soft(mcu.cpu.scs.cfsr & MSTKERR, "MMFSR").toBe(MSTKERR)
    expect.soft(mcu.cpu.scs.hfsr, "HFSR").toBe(FORCED)
    expect.soft(mcu.cpu.scs.pending[EXC.PENDSV], "PendSV pending").toBe(1)
    expect.soft(mcu.unmodelled.summary().map((u) => u.block).join(","), "nothing reported as unmodelled").not.toContain("MSTKERR")
  })
})
