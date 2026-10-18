/**
 * The AVR core alone on every firmware/avr/build/*.elf: the result array the test leaves in SRAM
 * must match what the same C code produced on the host. Build with `pnpm firmware-avr`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { EM_AVR, parseElf, symbolAt } from "@/mcu/elf"
import { AvrCpu, type AvrSystem } from "@/mcu/avr/cpu"
import { FIRMWARE, buffer } from "../lib/firmware"

const BUILD = join(FIRMWARE, "avr", "build")
const MAX_CYCLES = 400_000_000
// The test programs (t_*.c, with host results to compare); debug-*.elf is the debugger's program.
const elfs = existsSync(BUILD) ? readdirSync(BUILD).filter((f) => f.startsWith("t_") && f.endsWith(".elf")).sort() : []

/** A core with nothing around it: flash reads for LPM, no interrupts, no sleep. */
function bareCore() {
  const system: AvrSystem = {
    takeInterrupt: () => 0,
    sleep: () => false,
    canWake: () => true,
    wakeCycles: () => 0,
    watchdogReset: () => {},
    spm: () => 0,
    lpm: (a) => (cpu.flash[a >> 1] >> ((a & 1) * 8)) & 0xff,
    service: () => {},
  }
  const cpu = new AvrCpu(32 * 1024, 0x8ff, system)
  return cpu
}

describe("AVR core against host builds", () => {
  it("has firmware/avr/build populated", () => {
    expect(elfs, `${BUILD} has no .elf images — build them with \`pnpm firmware-avr\``).not.toHaveLength(0)
  })

  it.each(elfs)("%s matches the host results", (file) => {
    const test = file.replace(/-(O[0-9s])\.elf$/, "")
    const expected = new Map<number, number>()
    for (const line of readFileSync(join(BUILD, `${test}.expect`), "utf8").split("\n")) {
      const m = line.match(/^(\d+) ([0-9a-f]{8})$/)
      if (m) expected.set(Number(m[1]), parseInt(m[2], 16))
    }
    const fw = parseElf(buffer(readFileSync(join(BUILD, file))), [EM_AVR])
    const cpu = bareCore()
    for (const s of fw.segments) if (s.addr < 0x800000) for (let i = 0; i < s.data.length; i++) {
      const a = s.addr + i
      cpu.flash[a >> 1] = (cpu.flash[a >> 1] & (a & 1 ? 0x00ff : 0xff00)) | (s.data[i] << ((a & 1) * 8))
    }
    cpu.reset()
    while (!cpu.halted && cpu.cycles < MAX_CYCLES) cpu.run(cpu.cycles + 1_000_000)
    const where = (pc: number) => {
      const s = symbolAt(fw.symbols, pc)
      return s ? `${s.symbol.name}+0x${s.offset.toString(16)}` : "?"
    }
    expect(cpu.halted, `did not finish within ${MAX_CYCLES} cycles (pc=0x${(cpu.pc * 2).toString(16)} in ${where(cpu.pc * 2)})`).not.toBeNull()
    expect(`${cpu.halted!.reason}: ${cpu.halted!.detail}`, `${cpu.halted!.message} in ${where(cpu.halted!.pc)}`).toBe("bkpt: break")
    const results = fw.symbols.find((s) => s.name === "results")!.value & 0xffff
    const word = (i: number) => (cpu.data[results + i * 4] | (cpu.data[results + i * 4 + 1] << 8) | (cpu.data[results + i * 4 + 2] << 16) | (cpu.data[results + i * 4 + 3] << 24)) >>> 0
    expect.soft((word(0) & 0xffffff00) >>> 0, "result header").toBe(0xc0ffee00)
    expect.soft(word(0) & 0xff, "results written").toBe(expected.size)
    const got = new Map([...expected.keys()].map((i) => [i, word(i)]))
    expect.soft(got, "results").toEqual(expected)
    expect.soft(cpu.stray, "accesses outside data memory").toBe(0)
  })
})
