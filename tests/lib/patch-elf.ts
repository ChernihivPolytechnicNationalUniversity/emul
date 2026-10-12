import { parseElf } from "@/mcu/elf"
import { buffer } from "./firmware"

const PT_LOAD = 1

export function patchWords(elf: Buffer, words: Record<string, number>): Buffer {
  const out = Buffer.from(elf)
  const symbols = parseElf(buffer(elf)).symbols
  const phoff = out.readUInt32LE(0x1c)
  const phentsize = out.readUInt16LE(0x2a)
  const phnum = out.readUInt16LE(0x2c)
  for (const [field, value] of Object.entries(words)) {
    const [name, plus] = field.split("+")
    const symbol = symbols.find((s) => s.name === name)
    if (!symbol) throw new Error(`${name} is not in the image`)
    const address = symbol.value + Number(plus ?? 0)
    let offset = -1
    for (let i = 0; i < phnum; i++) {
      const at = phoff + i * phentsize
      if (out.readUInt32LE(at) !== PT_LOAD) continue
      const fileOffset = out.readUInt32LE(at + 4)
      const vaddr = out.readUInt32LE(at + 8)
      const filesz = out.readUInt32LE(at + 16)
      if (address >= vaddr && address + 4 <= vaddr + filesz) offset = fileOffset + address - vaddr
    }
    if (offset < 0) throw new Error(`${field} is not in a loaded segment`)
    out.writeUInt32LE(value >>> 0, offset)
  }
  return out
}
