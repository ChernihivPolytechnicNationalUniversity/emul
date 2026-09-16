/**
 * Runs every firmware/build/*.elf on the bare core and compares the result array the test
 * leaves at the start of SRAM with what the same C code produced on the host.
 *
 *   pnpm mcu-test            all tests
 *   pnpm mcu-test t_arith    one test (both optimisation levels and the Cortex-M7 build)
 *
 * Exit code 1 on any mismatch, halt for the wrong reason, or unimplemented instruction.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { symbolAt } from "@/mcu/elf"
import { CpuHalt } from "@/mcu/faults"
import { STM32F746IG } from "@/mcu/chip"
import { Stm32, Stm32F429 } from "@/mcu/stm32f429"

const BUILD = join(import.meta.dirname, "..", "firmware", "build")
const filter = process.argv[2]
const RESULTS = 0x20000000
const MAX_CYCLES = 200_000_000

const elfs = readdirSync(BUILD)
  .filter((f) => f.endsWith(".elf") && (!filter || f.startsWith(filter)))
  .sort()

let failed = 0
for (const file of elfs) {
  const test = file.replace(/-(O[0-9s]|M7)\.elf$/, "")
  const expectFile = join(BUILD, `${test}.expect`)
  const expected = new Map<number, number>()
  for (const line of readFileSync(expectFile, "utf8").split("\n")) {
    const m = line.match(/^(\d+) ([0-9a-f]{8})$/)
    if (m) expected.set(Number(m[1]), parseInt(m[2], 16))
  }

  // "-M7" images are Cortex-M7 builds (fpv5-d16): they run on the F746 profile.
  const mcu = file.endsWith("-M7.elf") ? new Stm32(STM32F746IG) : new Stm32F429()
  mcu.load(readFileSync(join(BUILD, file)).buffer as ArrayBuffer, file)
  const fw = mcu.firmware!
  const cpu = mcu.cpu

  const t0 = performance.now()
  let halt: CpuHalt | null = null
  try {
    while (cpu.cycles < MAX_CYCLES) cpu.run(1_000_000)
  } catch (e) {
    if (e instanceof CpuHalt) halt = e
    else throw e
  }
  const ms = performance.now() - t0
  const where = (pc: number) => {
    const s = symbolAt(fw.symbols, pc)
    return s ? `${s.symbol.name}+0x${s.offset.toString(16)}` : "?"
  }

  const problems: string[] = []
  if (!halt) problems.push(`did not finish within ${MAX_CYCLES} cycles (pc=0x${cpu.pc.toString(16)} in ${where(cpu.pc)})`)
  else if (!(halt.reason === "bkpt" && halt.detail === "bkpt #0")) problems.push(`${halt.message} in ${where(halt.pc)}`)
  else {
    const header = cpu.bus.read32(RESULTS)
    if (((header & 0xffffff00) >>> 0) !== 0xc0ffee00) problems.push(`bad result header 0x${header.toString(16)}`)
    const n = header & 0xff
    if (n !== expected.size) problems.push(`test wrote ${n} results, host expected ${expected.size}`)
    for (const [i, want] of expected) {
      const got = cpu.bus.read32(RESULTS + i * 4)
      if (got !== want) problems.push(`result[${i}] = ${got.toString(16).padStart(8, "0")}, expected ${want.toString(16).padStart(8, "0")}`)
    }
  }
  if (cpu.scs.faults.length) for (const f of cpu.scs.faults) problems.push(`fault: ${f.detail} at ${where(f.pc)}`)

  const mips = cpu.instructions / ms / 1000
  const status = problems.length ? "✗" : "✓"
  console.log(`${status} ${file.padEnd(18)} ${String(cpu.instructions).padStart(9)} instr ${String(cpu.cycles).padStart(10)} cyc ${ms.toFixed(0).padStart(5)} ms ${mips.toFixed(1).padStart(6)} MIPS`)
  for (const p of problems.slice(0, 12)) console.log(`    ${p}`)
  if (problems.length > 12) console.log(`    … ${problems.length - 12} more`)
  if (problems.length) failed++
}
console.log(`\n${elfs.length - failed}/${elfs.length} firmware images passed`)
process.exit(failed ? 1 : 0)
