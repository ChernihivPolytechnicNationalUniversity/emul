/**
 * The PIC16 core and SoC on every firmware/pic/build/*.hex: C built with SDCC (pic14) for the
 * PIC16F648A, run from its own configuration word. The results the program leaves at 0A0h must
 * match gpsim's (an independent simulator, build/*.gpsim) and, wherever gpsim agrees with the host
 * build of the same C (build/*.expect), the host's too. Where gpsim and the host differ, SDCC's code
 * does not mean what the C means (variable shifts and signed compares in SDCC 4.4.0): that is
 * reported, not failed. Build with `pnpm firmware-pic`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { PIC16F648A } from "@/mcu/pic/chip"
import { createPic } from "@/mcu/pic/parts"
import { FIRMWARE, buffer } from "../lib/firmware"

const BUILD = join(FIRMWARE, "pic", "build")
const RESULTS = 0xa0
const hexes = existsSync(BUILD) ? readdirSync(BUILD).filter((f) => f.endsWith(".hex")).sort() : []

describe("PIC16 core against host builds", () => {
  it("has firmware/pic/build populated", () => {
    expect(hexes, `${BUILD} has no .hex images — build them with \`pnpm firmware-pic\``).not.toHaveLength(0)
  })

  it.each(hexes)("%s matches the host results", (file) => {
    const test = file.replace(/\.hex$/, "")
    const results = (ext: string) => {
      const out = new Map<number, number>()
      for (const line of readFileSync(join(BUILD, `${test}.${ext}`), "utf8").split("\n")) {
        const m = line.match(/^(\d+) ([0-9a-f]{8})$/)
        if (m) out.set(Number(m[1]), parseInt(m[2], 16))
      }
      return out
    }
    const expected = results("gpsim")
    const host = results("expect")
    const m = createPic(PIC16F648A)
    m.load(buffer(readFileSync(join(BUILD, file))), file)
    // The image carries its configuration word: INTOSC, no WDT, no PWRT, MCLR on, no BOR, no LVP.
    expect(m.config).toBe(0x3f38)
    const word = (i: number) => {
      let v = 0
      for (let b = 3; b >= 0; b--) v = (v << 8) | m.peekFile(RESULTS + i * 4 + b)
      return v >>> 0
    }
    let t = 0
    while (t < 120 && (word(0) & 0xffffff00) >>> 0 !== 0xc0ffee00) {
      t += 0.5
      expect(m.runUntil(t), m.cpu.halted?.message).toBe(true)
    }
    expect((word(0) & 0xffffff00) >>> 0, `no result header after ${t} s (pc 0x${m.cpu.pc.toString(16)})`).toBe(0xc0ffee00)
    expect.soft(word(0) & 0xff, "results written").toBe(expected.size)
    expect.soft(new Map([...expected.keys()].map((i) => [i, word(i)])), "results against gpsim").toEqual(expected)
    const compiler = [...host].filter(([i, v]) => expected.get(i) !== v).map(([i]) => i)
    for (const [i, v] of host) if (!compiler.includes(i)) expect.soft(word(i), `result ${i} against the host`).toBe(v)
    if (compiler.length) console.info(`${file}: results ${compiler.join(", ")} — SDCC's code differs from the host's C; checked against gpsim only`)
    expect.soft([...m.unmodelled.keys()], "unmodelled blocks touched").toEqual([])
  })
})
