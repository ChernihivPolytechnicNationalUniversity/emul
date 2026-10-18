/**
 * Busy-waits skipped by the compiled core (`Cpu.spinCheck`): a loop that goes round leaving
 * every register, flag and byte of memory as it was, touching no peripheral, is taken up to the
 * next deadline at once. Against the interpreter — which runs every pass — the state after every
 * slice is the same: registers, flags, cycles, instructions, and RAM. The slices are of uneven
 * length (1–40 µs), so deadlines fall at every point of a pass. HAL_Delay polling uwTick (moved
 * by the SysTick handler) is skipped, and so is a main loop calling a function that pushes,
 * copies a table onto its stack and returns until an interrupt sets a flag (the Open746I-C's
 * touch demo: two blocks, stores that change nothing); a loop polling a peripheral flag (the
 * UART's TXE) is not, and agrees all the same.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STM32F429ZI, STM32F746IG, type ChipProfile } from "@/mcu/chip"
import { Stm32 } from "@/mcu/stm32f429"
import { FIRMWARE } from "../lib/firmware"

const SDRAM = [{ name: "SDRAM", base: 0xd0000000, size: 8 * 1024 * 1024, kind: "ram" as const, external: "sdram2" as const }]

function race(name: string, seconds: number, chip: ChipProfile = STM32F429ZI) {
  const make = (jit: boolean) => {
    const m = new Stm32(chip, chip === STM32F746IG ? SDRAM : [])
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

  it("open746-touch (GT911_Scan returning at once until its flag is set): as the interpreter, most of its cycles skipped", () => {
    expect(race("open746-touch.elf", 0.12, STM32F746IG)).toBeGreaterThan(0.8)
  })

  it("lab1-f746 (the running light): as the interpreter", () => {
    race("lab1-f746.elf", 0.12, STM32F746IG)
  })
})
