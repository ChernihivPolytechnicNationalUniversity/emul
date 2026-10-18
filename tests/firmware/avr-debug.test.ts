/**
 * The debug unit on the ATmega328P core: breakpoints, instruction steps, steps over and out of
 * calls, BREAK, and interrupts at a stop. Programs are hand-assembled (DS40002198C encodings) so
 * every address is known; byte addresses throughout, as avr-gcc's ELF and DWARF count flash.
 * Return addresses on the stack: high byte at SP+1, low at SP+2 (CALL/RCALL/ICALL, §6).
 * After SEI and RETI one more instruction runs before any pending interrupt (DS40002061B §7.7).
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ATMEGA328P } from "@/mcu/avr/chip"
import type { AvrMcu } from "@/mcu/avr/mcu"
import { createAvr } from "@/mcu/avr/parts"
import type { BreakpointSpec, StepRequest } from "@/debug/protocol"
import { at, brk, call, inc, jmp, ldi, nop, out, rcall, ret, reti, rjmp, sei, sts } from "../lib/avr-asm"
import { FIRMWARE, buffer } from "../lib/firmware"

const SPL = 0x3d
const SPH = 0x3e
const TCCR0B = 0x25
const TCNT0 = 0x26
const TIMSK0 = 0x6e
/** TIMER0 OVF is vector 17: word (17 − 1) × 2 with two-word vectors. */
const TIMER0_OVF = 0x20

/** DWEN programmed: BREAK stops the core (ISA §6.13); `NO_DW` leaves it a NOP. */
const DW = { low: 0xff, high: 0x99, extended: 0xfd, lock: 0xff }
const NO_DW = { ...DW, high: 0xd9 }

function mcu(words: number[], fuses = DW) {
  const m = createAvr(ATMEGA328P)
  m.fuses = { ...fuses }
  m.setClockFeed({ hz: 16e6, kind: "crystal" })
  m.cpu.flash.fill(0xffff)
  m.cpu.flash.set(words, 0)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  return m
}

/** Run until the core stops for the debugger or halts; the stop, or null after `seconds`. */
function go(m: AvrMcu, seconds = 0.1) {
  const end = m.time + seconds
  while (m.time < end && !m.debugStop && !m.cpu.halted) m.runUntil(Math.min(end, m.time + 1e-3))
  return m.debugStop
}
const bp = (address: number, id = `b${address}`): BreakpointSpec => ({ id, kind: "address", address, enabled: true })
const step = (m: AvrMcu, s: StepRequest) => {
  m.debug({ op: "step", step: s })
  return go(m)
}
const pc = (m: AvrMcu) => m.cpu.pc * 2

/**
 * main: SP = 0x08FF, then round a loop calling f (RCALL), which calls g (CALL).
 * Byte addresses: loop 0x88, after the RCALL 0x8A, f 0xA0 (CALL g), f after the CALL 0xA4, g 0xB0.
 */
const calls = () =>
  at([
    [0x00, jmp(0x40)],
    [0x40, [...ldi(16, 0x08), ...out(SPH, 16), ...ldi(16, 0xff), ...out(SPL, 16)]],
    [0x44, [...rcall(0x50 - 0x45), ...inc(17), ...rjmp(0x44 - 0x47)]],
    [0x50, [...call(0x58), ...ret()]],
    [0x58, [...inc(18), ...ret()]],
  ])

describe("breakpoints and steps through calls", () => {
  const m = mcu(calls())
  m.debug({ op: "breakpoints", list: [bp(0x88)] })

  it("stops at the loop, before the RCALL runs", () => {
    expect(go(m)).toMatchObject({ reason: "breakpoint", pc: 0x88, breakpoint: "b136" })
    expect(pc(m)).toBe(0x88)
    expect(m.cpu.sp).toBe(0x8ff)
    expect(m.running).toBe(false)
  })

  it("keeps the core where it is while stopped", () => {
    const cycles = m.cpu.cycles
    m.runUntil(m.time + 1e-3)
    expect(m.cpu.cycles).toBe(cycles)
    expect(pc(m)).toBe(0x88)
  })

  it("steps one instruction into f: the RCALL left 0x8A on the stack, high byte at SP+1", () => {
    expect(step(m, { kind: "instruction" })).toMatchObject({ reason: "step", pc: 0xa0 })
    expect(m.cpu.sp).toBe(0x8fd)
    expect([m.cpu.data[0x8fe], m.cpu.data[0x8ff]]).toEqual([0x00, 0x45])
  })

  it("steps over the CALL g: g ran (r18), and the core is past the CALL in f", () => {
    const r18 = m.cpu.data[18]
    expect(step(m, { kind: "instruction", over: true })).toMatchObject({ reason: "step", pc: 0xa4 })
    expect(m.cpu.data[18]).toBe(r18 + 1)
    expect(m.cpu.sp).toBe(0x8fd)
  })

  it("steps out of f to the return address, the stack back above it", () => {
    expect(step(m, { kind: "until", addr: 0x8a, sp: 0x8fd + 2 })).toMatchObject({ reason: "step", pc: 0x8a })
    expect(m.cpu.sp).toBe(0x8ff)
  })

  it("continues round the loop to the breakpoint again", () => {
    const r17 = m.cpu.data[17]
    m.debug({ op: "resume" })
    expect(go(m)).toMatchObject({ reason: "breakpoint", pc: 0x88 })
    expect(m.cpu.data[17]).toBe(r17 + 1)
  })

  it("steps over the RCALL: f and g ran, the core is at the INC after it", () => {
    const r18 = m.cpu.data[18]
    expect(step(m, { kind: "instruction", over: true })).toMatchObject({ reason: "step", pc: 0x8a })
    expect(m.cpu.data[18]).toBe(r18 + 1)
  })

  it("treats a line step without line information as an instruction step", () => {
    expect(step(m, { kind: "over" })).toMatchObject({ reason: "step", pc: 0x8c })
  })

  it("stops in g for a breakpoint there, called from f, and not again at the loop once it is gone", () => {
    m.debug({ op: "breakpoints", list: [bp(0xb0)] })
    m.debug({ op: "resume" })
    expect(go(m)).toMatchObject({ reason: "breakpoint", pc: 0xb0 })
    expect(m.cpu.sp).toBe(0x8fb)
    expect([m.cpu.data[0x8fc], m.cpu.data[0x8fd]]).toEqual([0x00, 0x52])
  })

  it("runs freely once no breakpoint is left", () => {
    m.debug({ op: "breakpoints", list: [] })
    m.debug({ op: "resume" })
    const cycles = m.cpu.cycles
    expect(go(m, 1e-3)).toBeNull()
    expect(m.cpu.cycles - cycles).toBeGreaterThan(15_000)
  })
})

describe("BREAK", () => {
  const prog = () => at([[0x00, [...inc(17), ...brk(), ...inc(18), ...rjmp(-1)]]])

  it("stops the core on the BREAK with debugWIRE on, and going on runs past it", () => {
    const m = mcu(prog())
    m.debug({ op: "breakpoints", list: [] })
    expect(go(m)).toMatchObject({ reason: "bkpt", pc: 2 })
    expect(m.cpu.halted).toBeNull()
    expect(m.cpu.data[17]).toBe(1)
    expect(m.cpu.data[18]).toBe(0)
    expect(step(m, { kind: "instruction" })).toMatchObject({ reason: "step", pc: 6 })
    expect(m.cpu.data[18]).toBe(1)
  })

  it("is a NOP without debugWIRE, debugger or not", () => {
    const m = mcu(prog(), NO_DW)
    m.debug({ op: "breakpoints", list: [] })
    expect(go(m)).toBeNull()
    expect(m.cpu.data[18]).toBe(1)
  })
})

/**
 * Timer 0 at clk/1 from TCNT0 = 0xFF overflows on the next count: TOV0 is pending before SEI.
 * Byte addresses: SEI 0xA0, X (INC r20, runs before the interrupt) 0xA2, Y (INC r21) 0xA4;
 * the handler at 0xC0 counts in r19.
 */
const timer = () =>
  at([
    [0x00, jmp(0x40)],
    [TIMER0_OVF, jmp(0x60)],
    [
      0x40,
      [
        ...ldi(16, 0x08), ...out(SPH, 16), ...ldi(16, 0xff), ...out(SPL, 16),
        ...ldi(16, 1), ...sts(TIMSK0, 16), ...ldi(16, 0xff), ...out(TCNT0, 16), ...ldi(16, 1), ...out(TCCR0B, 16),
        ...nop(), ...nop(),
      ],
    ],
    [0x50, [...sei(), ...inc(20), ...inc(21), ...rjmp(-3)]],
    [0x60, [...inc(19), ...reti()]],
  ])

describe("interrupts at a stop", () => {
  it("takes an interrupt due at a breakpoint first: the stop comes once the handler has returned", () => {
    const m = mcu(timer())
    m.debug({ op: "breakpoints", list: [bp(0xa4)] })
    expect(go(m)).toMatchObject({ reason: "breakpoint", pc: 0xa4 })
    expect(m.cpu.data[20]).toBe(1)
    expect(m.cpu.data[19]).toBe(1)
    expect(m.cpu.sp).toBe(0x8ff)
  })

  it("holds the interrupt off for an instruction step, as a probe's single step does", () => {
    const m = mcu(timer())
    m.debug({ op: "breakpoints", list: [bp(0xa2)] })
    expect(go(m)).toMatchObject({ reason: "breakpoint", pc: 0xa2 })
    expect(m.cpu.interruptDue()).toBe(false)
    expect(step(m, { kind: "instruction" })).toMatchObject({ reason: "step", pc: 0xa4 })
    expect(m.cpu.interruptDue()).toBe(true)
    expect(step(m, { kind: "instruction" })).toMatchObject({ reason: "step", pc: 0xa6 })
    expect(m.cpu.data[19]).toBe(0)
    expect(m.cpu.data[21]).toBe(1)
  })

  it("stops on the vector for a breakpoint there, the interrupted Y on the stack", () => {
    const m = mcu(timer())
    m.debug({ op: "breakpoints", list: [bp(TIMER0_OVF * 2)] })
    expect(go(m)).toMatchObject({ reason: "breakpoint", pc: TIMER0_OVF * 2 })
    expect(m.cpu.sp).toBe(0x8fd)
    expect([m.cpu.data[0x8fe], m.cpu.data[0x8ff]]).toEqual([0x00, 0x52])
    expect(m.cpu.data[19]).toBe(0)
  })

  it("steps out of the handler: RETI back at Y, the handler counted once", () => {
    const m = mcu(timer())
    m.debug({ op: "breakpoints", list: [bp(0xc0)] })
    expect(go(m)).toMatchObject({ reason: "breakpoint", pc: 0xc0 })
    m.debug({ op: "breakpoints", list: [] })
    expect(step(m, { kind: "until", addr: 0xa4, sp: 0x8ff })).toMatchObject({ reason: "step", pc: 0xa4 })
    expect(m.cpu.data[19]).toBe(1)
  })
})

describe("an image from avr-gcc", () => {
  const file = join(FIRMWARE, "avr", "build", "t_call-O0.elf")
  it.skipIf(!existsSync(file))("steps into a function through ICALL, and out of it to the instruction after the ICALL", () => {
    const m = createAvr(ATMEGA328P)
    m.fuses = { ...NO_DW }
    m.setClockFeed({ hz: 16e6, kind: "crystal" })
    m.load(buffer(readFileSync(file)), "t_call-O0.elf")
    const fns = ["f0", "f1", "f2", "f3"].map((n) => m.firmware!.symbols.find((s) => s.name === n)!.value)
    const runTest = m.firmware!.symbols.find((s) => s.name === "run_test")!
    // The first ICALL in run_test: the call through fns[].
    let icall = runTest.value
    while (m.cpu.flash[icall / 2] !== 0x9509) icall += 2
    m.debug({ op: "breakpoints", list: [bp(icall)] })
    expect(go(m, 1)).toMatchObject({ reason: "breakpoint", pc: icall })
    const sp = m.cpu.sp
    m.debug({ op: "breakpoints", list: [] })
    expect(step(m, { kind: "instruction" })?.reason).toBe("step")
    expect(fns).toContain(pc(m))
    expect(m.cpu.sp).toBe(sp - 2)
    expect(step(m, { kind: "until", addr: icall + 2, sp })).toMatchObject({ reason: "step", pc: icall + 2 })
    expect(m.cpu.sp).toBe(sp)
  })
})
