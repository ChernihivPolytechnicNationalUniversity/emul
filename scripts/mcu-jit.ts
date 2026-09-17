/**
 * Differential test of the block compiler: the same firmware runs on two cores, one executing
 * compiled blocks (jit.ts) and one the instruction closures, in identical time slices, and
 * every register, flag, cycle count and the RAM must agree after every slice.
 *
 *   pnpm mcu-jit                 all images below, 0.3 s of simulated time each
 *   pnpm mcu-jit cube 2          images whose name contains "cube", 2 s each
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { STM32F429ZI, STM32F746IG, type ChipProfile } from "@/mcu/chip"
import { Stm32 } from "@/mcu/stm32f429"

const filter = process.argv[2] ?? ""
const seconds = Number(process.argv[3] ?? 0.3)
const pub = (name: string) => join(import.meta.dirname, "..", "firmware", "examples", name)
const images: [string, ChipProfile][] = [
  [pub("nucleo-blink.elf"), STM32F429ZI],
  [pub("nucleo-square.elf"), STM32F429ZI],
  [pub("nucleo-pwm.elf"), STM32F429ZI],
  [pub("nucleo-uart.elf"), STM32F429ZI],
  [pub("lab1-f746.elf"), STM32F746IG],
  [pub("open746-cube.elf"), STM32F746IG],
]
const SDRAM = [{ name: "SDRAM", base: 0xd0000000, size: 8 * 1024 * 1024, kind: "ram" as const, external: "sdram2" as const }]

let failed = 0
for (const [path, chip] of images) {
  if (!path.includes(filter)) continue
  const make = (jit: boolean) => {
    const m = new Stm32(chip, chip === STM32F746IG ? SDRAM : [])
    m.cpu.jit = jit
    m.load(readFileSync(path).buffer as ArrayBuffer, path)
    return m
  }
  const a = make(true)
  const b = make(false)
  const name = path.split("/").pop()!
  let t = 0
  let mismatch = ""
  const wall0 = performance.now()
  while (t < seconds && !mismatch) {
    t += 20e-6
    a.runUntil(t)
    b.runUntil(t)
    const ca = a.cpu
    const cb = b.cpu
    for (let i = 0; i < 16; i++) if (ca.r[i] !== cb.r[i]) mismatch = `r${i} ${ca.r[i].toString(16)} vs ${cb.r[i].toString(16)}`
    for (const f of ["pc", "n", "z", "c", "v", "q", "ge", "cycles", "instructions", "itstate", "ipsr", "primask", "basepri", "control", "sleeping"] as const)
      if (ca[f] !== cb[f]) mismatch = `${f} ${ca[f]} vs ${cb[f]}`
    for (let i = 0; i < 32; i++) if (ca.sBits[i] !== cb.sBits[i]) mismatch = `s${i} ${ca.sBits[i]} vs ${cb.sBits[i]}`
    if (a.cpu.halted || b.cpu.halted) {
      if (!!a.cpu.halted !== !!b.cpu.halted) mismatch = `halted ${a.cpu.halted?.reason} vs ${b.cpu.halted?.reason}`
      break
    }
    if (mismatch) mismatch += ` at t=${(t * 1e6).toFixed(0)} µs, pc=0x${cb.pc.toString(16)} (${cb.instructions} instr)`
  }
  if (!mismatch) {
    for (const ma of a.bus.memories) {
      const mb = b.bus.memories.find((m) => m.name === ma.name)!
      for (let i = 0; i < ma.bytes.length; i++)
        if (ma.bytes[i] !== mb.bytes[i]) {
          mismatch = `${ma.name}[0x${i.toString(16)}] ${ma.bytes[i]} vs ${mb.bytes[i]}`
          break
        }
      if (mismatch) break
    }
  }
  const wall = (performance.now() - wall0) / 1000
  if (mismatch) failed++
  console.log(`${mismatch ? "✗" : "✓"} ${name.padEnd(20)} ${a.cpu.instructions.toString().padStart(10)} instr  ${wall.toFixed(1)} s  ${mismatch}`)
}
console.log(failed ? `${failed} mismatching` : "all images agree")
process.exit(failed ? 1 : 0)
