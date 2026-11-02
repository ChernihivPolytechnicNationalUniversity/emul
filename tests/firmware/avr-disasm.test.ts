/**
 * The AVR disassembler against avr-objdump: every instruction line of the listings `pnpm
 * firmware-avr` writes beside its test images (firmware/avr/build/*.lst) must read the same —
 * mnemonic, operands and the numeric part of objdump's comment.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { avrDisasm, avrTwoWord } from "@/mcu/avr/disasm"
import { FIRMWARE } from "../lib/firmware"

const BUILD = join(FIRMWARE, "avr", "build")
const listings = existsSync(BUILD) ? readdirSync(BUILD).filter((f) => f.endsWith(".lst")).sort() : []

type Line = { addr: number; words: number[]; mnemonic: string; operands: string; comment: string }

function parse(text: string): Line[] {
  const out: Line[] = []
  for (const line of text.split("\n")) {
    const m = /^\s*([0-9a-f]+):\t((?:[0-9a-f]{2} )+)\s*\t([^\t]+)\t?([^;]*?)\s*(?:;\s*(.*))?$/.exec(line)
    if (!m) continue
    const b = m[2].trim().split(" ").map((x) => parseInt(x, 16))
    const words: number[] = []
    for (let i = 0; i + 1 < b.length; i += 2) words.push(b[i] | (b[i + 1] << 8))
    out.push({ addr: parseInt(m[1], 16), words, mnemonic: m[3].trim(), operands: m[4].trim(), comment: (m[5] ?? "").replace(/\s*<.*>$/, "").trim() })
  }
  return out
}

describe("AVR disassembly reads as avr-objdump's", () => {
  it("has listings", () => {
    expect(listings, `${BUILD} has no .lst — build them with \`pnpm firmware-avr\``).not.toHaveLength(0)
  })

  it.each(listings)("%s", (file) => {
    const lines = parse(readFileSync(join(BUILD, file), "utf8"))
    expect(lines.length).toBeGreaterThan(100)
    const bad: string[] = []
    for (const l of lines) {
      const insn = avrDisasm(l.words[0], l.words[1] ?? 0, l.addr)
      const got = `${insn.mnemonic} ${insn.operands} ; ${insn.comment}`
      const want = `${l.mnemonic} ${l.operands} ; ${l.comment}`
      if (got !== want || insn.size !== l.words.length * 2 || avrTwoWord(l.words[0]) !== (l.words.length === 2)) bad.push(`${l.addr.toString(16)}: ${want} ≠ ${got} (${insn.size})`)
    }
    expect(bad.slice(0, 20)).toEqual([])
  })
})
