/**
 * Every firmware/build/*.elf on the bare core: the result array the test leaves at the start of
 * SRAM must match what the same C code produced on the host.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { symbolAt } from "@/mcu/elf"
import { CpuHalt } from "@/mcu/faults"
import { STM32F746IG } from "@/mcu/chip"
import { Stm32, Stm32F429 } from "@/mcu/stm32f429"
import { FIRMWARE, buffer } from "../lib/firmware"

const BUILD = join(FIRMWARE, "build")
const RESULTS = 0x20000000
const MAX_CYCLES = 200_000_000

const elfs = existsSync(BUILD) ? readdirSync(BUILD).filter((f) => f.endsWith(".elf")).sort() : []

describe("core against host builds", () => {
  it("has firmware/build populated", () => {
    expect(elfs, `${BUILD} has no .elf images — build them with \`make -C firmware\``).not.toHaveLength(0)
  })

  it.each(elfs)("%s matches the host results", (file) => {
    const test = file.replace(/-(O[0-9s]|M7)\.elf$/, "")
    const expected = new Map<number, number>()
    for (const line of readFileSync(join(BUILD, `${test}.expect`), "utf8").split("\n")) {
      const m = line.match(/^(\d+) ([0-9a-f]{8})$/)
      if (m) expected.set(Number(m[1]), parseInt(m[2], 16))
    }

    // "-M7" images are Cortex-M7 builds (fpv5-d16): they run on the F746 profile.
    const mcu = file.endsWith("-M7.elf") ? new Stm32(STM32F746IG) : new Stm32F429()
    mcu.load(buffer(readFileSync(join(BUILD, file))), file)
    const fw = mcu.firmware!
    const cpu = mcu.cpu

    let halt: CpuHalt | null = null
    try {
      while (cpu.cycles < MAX_CYCLES) cpu.run(1_000_000)
    } catch (e) {
      if (e instanceof CpuHalt) halt = e
      else throw e
    }
    const where = (pc: number) => {
      const s = symbolAt(fw.symbols, pc)
      return s ? `${s.symbol.name}+0x${s.offset.toString(16)}` : "?"
    }

    expect(halt, `did not finish within ${MAX_CYCLES} cycles (pc=0x${cpu.pc.toString(16)} in ${where(cpu.pc)})`).not.toBeNull()
    expect(`${halt!.reason}: ${halt!.detail}`, `${halt!.message} in ${where(halt!.pc)}`).toBe("bkpt: bkpt #0")
    const header = cpu.bus.read32(RESULTS)
    expect.soft(((header & 0xffffff00) >>> 0).toString(16), "result header").toBe("c0ffee00")
    expect.soft(header & 0xff, "results written").toBe(expected.size)
    const got = new Map([...expected.keys()].map((i) => [i, cpu.bus.read32(RESULTS + i * 4)]))
    expect.soft(got, "results").toEqual(expected)
    expect.soft(cpu.scs.faults.map((f) => `${f.detail} at ${where(f.pc)}`), "faults").toEqual([])
  })
})
