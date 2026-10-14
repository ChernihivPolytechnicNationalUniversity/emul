/**
 * Clock counts of the AVR core, from the AVR Instruction Set Manual (DS40002198C) Tables 5-2 to
 * 5-6, AVRe column, for a part with a 16-bit PC (ATmega328P): RCALL/ICALL 3, CALL/RET/RETI 4.
 * Interrupt response from the ATmega328P data sheet (DS40002061B §7.7, §7.7.1).
 */
import { describe, expect, it } from "vitest"
import { AvrCpu, type AvrSystem } from "@/mcu/avr/cpu"

function core(system: Partial<AvrSystem> = {}) {
  const sys: AvrSystem = { takeInterrupt: () => 0, sleep: () => false, canWake: () => true, wakeCycles: () => 0, watchdogReset: () => {}, spm: () => 0, lpm: () => 0, service: () => {}, ...system }
  const c = new AvrCpu(32 * 1024, 0x8ff, sys)
  c.reset()
  return c
}

/** Clocks of the instruction at word 0 (and where it leaves the PC). */
function clocks(words: number[], setup: (c: AvrCpu) => void = () => {}) {
  const c = core()
  words.forEach((w, i) => (c.flash[i] = w))
  setup(c)
  c.pc = 0
  c.run(1)
  if (c.halted) throw c.halted
  return { clocks: c.cycles, pc: c.pc }
}

const NOP = 0x0000
const LDS = 0x9100 // LDS r16, k (two words)

describe("instruction clocks (DS40002198C Tables 5-2…5-6, AVRe, 16-bit PC)", () => {
  const cases: [string, number[], number, ((c: AvrCpu) => void)?][] = [
    ["ADD", [0x0f01], 1],
    ["ADIW", [0x9601], 2],
    ["SBIW", [0x9701], 2],
    ["MUL", [0x9c01], 2],
    ["MULS", [0x0201], 2],
    ["FMULSU", [0x0389], 2],
    ["RJMP", [0xc005], 2],
    ["IJMP", [0x9409], 2],
    ["JMP", [0x940c, 0x0100], 3],
    ["RCALL", [0xd005], 3],
    ["ICALL", [0x9509], 3],
    ["CALL", [0x940e, 0x0100], 4],
    ["RET", [0x9508], 4],
    ["RETI", [0x9518], 4],
    ["BREQ not taken", [0xf009], 1],
    ["BREQ taken", [0xf009], 2, (c) => (c.data[0x5f] = 0x02)],
    ["CPSE no skip", [0x1001, NOP], 1, (c) => (c.data[1] = 1)],
    ["CPSE skip one-word", [0x1001, NOP], 2],
    ["CPSE skip two-word", [0x1001, LDS, 0x0100], 3],
    ["SBRC skip two-word", [0xfd00, 0x940e, 0x0000], 3],
    ["SBIS no skip", [0x9b18], 1],
    ["SBIC skip", [0x9918, NOP], 2],
    ["MOV", [0x2c01], 1],
    ["MOVW", [0x0101], 1],
    ["LDI", [0xe00f], 1],
    ["LDS", [LDS, 0x0100], 2],
    ["LD X", [0x900c], 2],
    ["LD X+", [0x900d], 2],
    ["LD -X", [0x900e], 2],
    ["LD Y+", [0x9009], 2],
    ["LDD Y+q", [0x8009], 2],
    ["LD Z", [0x8000], 2],
    ["LD -Z", [0x9002], 2],
    ["LDD Z+q", [0x8001], 2],
    ["STS", [0x9300, 0x0100], 2],
    ["ST X", [0x920c], 2],
    ["ST -Y", [0x920a], 2],
    ["STD Z+q", [0x8201], 2],
    ["LPM", [0x95c8], 3],
    ["LPM Rd,Z", [0x9004], 3],
    ["LPM Rd,Z+", [0x9005], 3],
    ["IN", [0xb000], 1],
    ["OUT", [0xb800], 1],
    ["PUSH", [0x920f], 2],
    ["POP", [0x900f], 2],
    ["SBI", [0x9a00], 2],
    ["CBI", [0x9800], 2],
    ["LSR", [0x9406], 1],
    ["SWAP", [0x9402], 1],
    ["BST", [0xfa00], 1],
    ["BLD", [0xf800], 1],
    ["SEC", [0x9408], 1],
    ["CLI", [0x94f8], 1],
    ["NOP", [NOP], 1],
    ["WDR", [0x95a8], 1],
    ["SLEEP", [0x9588], 1],
  ]
  it.each(cases)("%s", (_name, words, want, setup) => {
    expect(clocks(words, setup).clocks).toBe(want)
  })

  it("skips land past a two-word instruction", () => {
    expect(clocks([0x1001, LDS, 0x0100, NOP]).pc).toBe(3)
    expect(clocks([0x1001, NOP, NOP]).pc).toBe(2)
  })
})

describe("stack and calls (DS40002198C §6.20 CALL, §6.88 RET)", () => {
  it("CALL pushes the return address low byte first, SP drops by 2", () => {
    const c = core()
    c.flash.set([0x940e, 0x0123], 0)
    c.run(1)
    expect(c.pc).toBe(0x0123)
    expect(c.sp).toBe(0x8ff - 2)
    // Return address 0x0002: low byte at the old SP, high byte below it.
    expect(c.data[0x8ff]).toBe(0x02)
    expect(c.data[0x8fe]).toBe(0x00)
  })
  it("RET pops it back", () => {
    const c = core()
    c.flash.set([0x940e, 0x0010], 0)
    c.flash[0x10] = 0x9508
    c.run(5)
    expect(c.pc).toBe(2)
    expect(c.sp).toBe(0x8ff)
  })
  it("PUSH stores at SP then decrements (post-decrement); POP pre-increments", () => {
    const c = core()
    c.data[5] = 0xab
    c.flash.set([0x925f, 0x906f], 0) // PUSH r5; POP r6
    c.run(1)
    expect(c.data[0x8ff]).toBe(0xab)
    expect(c.sp).toBe(0x8fe)
    c.run(c.cycles + 1)
    expect(c.data[6]).toBe(0xab)
    expect(c.sp).toBe(0x8ff)
  })
})

describe("interrupts (DS40002061B §7.7, §7.7.1)", () => {
  /** A core with one interrupt source that is pending from the start and acknowledged on entry. */
  function withIrq(vector: number) {
    let pending = true
    const c = core({
      takeInterrupt: () => {
        if (!pending) return 0
        pending = false
        c.irqPending = false
        return vector
      },
    })
    c.irqPending = true
    return c
  }

  it("response is four clocks: PC pushed, I cleared, vector fetched (2 words per vector)", () => {
    const c = withIrq(17) // TIMER0_OVF at 0x0020
    c.data[0x5f] = 0x80
    c.flash.fill(0x0000)
    c.run(1)
    // 4 clocks of response, then the NOP at the vector (1 clock).
    expect(c.cycles).toBe(5)
    expect(c.pc).toBe(0x0021)
    expect(c.data[0x5f] & 0x80).toBe(0)
    expect(c.sp).toBe(0x8fd)
    expect(c.data[0x8ff] | (c.data[0x8fe] << 8)).toBe(0)
  })

  it("the instruction after SEI runs before a pending interrupt", () => {
    const c = withIrq(2)
    c.flash.set([0x9478, 0x0000, 0x0000], 0x10) // SEI; NOP; NOP
    c.pc = 0x10
    c.run(1) // SEI
    expect(c.pc).toBe(0x11)
    c.run(c.cycles + 1) // the NOP after SEI runs…
    expect(c.pc).toBe(0x12)
    c.run(c.cycles + 1) // …then the interrupt is taken
    expect(c.sp).toBe(0x8fd)
    expect(c.data[0x8ff] | (c.data[0x8fe] << 8)).toBe(0x12)
  })

  it("after RETI one instruction of the main program runs before the next interrupt", () => {
    const taken: number[] = []
    const c = core({
      takeInterrupt: () => {
        taken.push(c.pc)
        c.irqPending = taken.length < 2
        return 2
      },
    })
    c.flash[0x02] = 0x9518 // RETI at INT0's vector
    c.flash.fill(0x0000, 0x40, 0x48)
    c.pc = 0x40
    c.data[0x5f] = 0x80
    c.irqPending = true
    c.run(30)
    // Taken at 0x40, returned, one NOP ran (0x40 → 0x41), taken again at 0x41.
    expect(taken).toEqual([0x40, 0x41])
  })

  it("an interrupt during a multi-cycle instruction waits for it to complete", () => {
    const c = withIrq(2)
    c.irqPending = false
    c.data[0x5f] = 0x80
    c.flash.set([0x940e, 0x0040], 0) // CALL 0x40 (4 clocks)
    c.run(1)
    c.irqPending = true
    expect(c.cycles).toBe(4)
    expect(c.pc).toBe(0x40)
  })

  it("waking from sleep adds four clocks to the response, plus the mode's start-up time", () => {
    let pending = false
    const c = core({
      sleep: () => true,
      wakeCycles: () => 1000,
      takeInterrupt: () => {
        if (!pending) return 0
        pending = false
        c.irqPending = false
        return 2
      },
      service: () => {
        pending = true
        c.irqPending = true
        c.nextEventCycle = Infinity
      },
    })
    c.data[0x5f] = 0x80
    c.flash[0] = 0x9588 // SLEEP
    c.nextEventCycle = 50
    c.run(2000)
    // SLEEP (1) … asleep until the event at 50, start-up 1000, response 4 + 4, then NOPs.
    expect(c.sleeping).toBe(false)
    expect(c.data[0x8ff] | (c.data[0x8fe] << 8)).toBe(1)
    expect(c.sleepCycles).toBe(49 + 1000)
  })
})
