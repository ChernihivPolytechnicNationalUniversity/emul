/**
 * Busy-waits skipped by the compiled core (`Cpu.spinCheck`): a loop that only reads memory and
 * branches, and goes round leaving every register and flag as it was, is taken up to the next
 * deadline at once. Against the interpreter — which runs every pass — the state after every
 * slice is the same: registers, flags, cycles, instructions, and RAM. The slices are of uneven
 * length (1–40 µs), so deadlines fall at every point of a pass. HAL_Delay polling uwTick (moved
 * by the SysTick handler) is skipped; a loop polling a peripheral flag (the UART's TXE) is not,
 * and agrees all the same.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STM32F429ZI } from "@/mcu/chip"
import { Stm32 } from "@/mcu/stm32f429"
import { FIRMWARE } from "../lib/firmware"

function race(name: string, seconds: number) {
  const make = (jit: boolean) => {
    const m = new Stm32(STM32F429ZI, [])
    m.cpu.jit = jit
    m.load(readFileSync(join(FIRMWARE, "examples", name)).buffer as ArrayBuffer, name)
    return m
  }
  const a = make(true)
  const b = make(false)
  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
  let t = 0
  let slices = 0
  while (t < seconds) {
    t += (1 + 39 * rand()) * 1e-6
    a.runUntil(t)
    b.runUntil(t)
    slices++
    const ca = a.cpu
    const cb = b.cpu
    for (const f of ["pc", "n", "z", "c", "v", "q", "ge", "cycles", "instructions", "itstate", "ipsr", "primask", "basepri", "control", "sleeping"] as const)
      if (ca[f] !== cb[f]) throw new Error(`${name}: ${f} ${ca[f]} vs ${cb[f]} after slice ${slices} (t = ${(t * 1e6).toFixed(1)} µs)`)
    for (let i = 0; i < 16; i++) if (ca.r[i] !== cb.r[i]) throw new Error(`${name}: r${i} after slice ${slices}`)
  }
  for (const ma of a.bus.memories) {
    const mb = b.bus.memories.find((m) => m.name === ma.name)!
    expect(Buffer.from(ma.bytes).equals(Buffer.from(mb.bytes)), `${name}: ${ma.name}`).toBe(true)
  }
  return a.cpu.spunCycles / a.cpu.cycles
}

describe("busy-waits skipped by the compiled core", () => {
  it("nucleo-blink (HAL_Delay on uwTick): as the interpreter, slice for slice, with most of its cycles skipped", () => {
    expect(race("nucleo-blink.elf", 0.12)).toBeGreaterThan(0.8)
  })

  it("nucleo-uart (HAL_Delay, and a transmit polling TXE): as the interpreter", () => {
    race("nucleo-uart.elf", 0.12)
  })

  it("nucleo-pwm (timers running beside the delay): as the interpreter", () => {
    race("nucleo-pwm.elf", 0.12)
  })
})
