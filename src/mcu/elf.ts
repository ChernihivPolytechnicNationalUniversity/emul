/**
 * ELF32 (little-endian ARM) reader: loadable segments by physical address, plus the
 * symbol table for the debugger. Also parses Intel HEX and raw binaries into the same shape.
 */

export type Segment = { addr: number; data: Uint8Array }
export type Symbol = { name: string; value: number; size: number; type: "func" | "object" | "other" }

export type Firmware = {
  format: "elf" | "hex" | "bin"
  segments: Segment[]
  entry: number | null
  symbols: Symbol[]
}

const PT_LOAD = 1
const SHT_SYMTAB = 2
const STT_OBJECT = 1
const STT_FUNC = 2

export function parseElf(buf: ArrayBuffer): Firmware {
  const v = new DataView(buf)
  const bytes = new Uint8Array(buf)
  if (v.getUint32(0, false) !== 0x7f454c46) throw new Error("not an ELF file")
  if (bytes[4] !== 1) throw new Error("not a 32-bit ELF")
  if (bytes[5] !== 1) throw new Error("not little-endian")
  const machine = v.getUint16(18, true)
  if (machine !== 40) throw new Error(`not an ARM ELF (e_machine = ${machine})`)
  const entry = v.getUint32(24, true)
  const phoff = v.getUint32(28, true)
  const shoff = v.getUint32(32, true)
  const phentsize = v.getUint16(42, true)
  const phnum = v.getUint16(44, true)
  const shentsize = v.getUint16(46, true)
  const shnum = v.getUint16(48, true)

  const segments: Segment[] = []
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize
    const type = v.getUint32(p, true)
    if (type !== PT_LOAD) continue
    const offset = v.getUint32(p + 4, true)
    const paddr = v.getUint32(p + 12, true)
    const filesz = v.getUint32(p + 16, true)
    if (filesz === 0) continue
    segments.push({ addr: paddr, data: bytes.slice(offset, offset + filesz) })
  }

  const symbols: Symbol[] = []
  for (let i = 0; i < shnum; i++) {
    const s = shoff + i * shentsize
    if (v.getUint32(s + 4, true) !== SHT_SYMTAB) continue
    const symOff = v.getUint32(s + 16, true)
    const symSize = v.getUint32(s + 20, true)
    const link = v.getUint32(s + 24, true)
    const entsize = v.getUint32(s + 36, true) || 16
    const strSec = shoff + link * shentsize
    const strOff = v.getUint32(strSec + 16, true)
    const strSize = v.getUint32(strSec + 20, true)
    const strtab = bytes.subarray(strOff, strOff + strSize)
    const name = (idx: number) => {
      let end = idx
      while (end < strtab.length && strtab[end] !== 0) end++
      return new TextDecoder().decode(strtab.subarray(idx, end))
    }
    for (let o = symOff; o + entsize <= symOff + symSize; o += entsize) {
      const nameIdx = v.getUint32(o, true)
      const value = v.getUint32(o + 4, true)
      const size = v.getUint32(o + 8, true)
      const info = bytes[o + 12]
      const type = info & 0xf
      if (nameIdx === 0) continue
      const n = name(nameIdx)
      if (n.startsWith("$")) continue // mapping symbols ($t, $d)
      symbols.push({ name: n, value: type === STT_FUNC ? value & ~1 : value, size, type: type === STT_FUNC ? "func" : type === STT_OBJECT ? "object" : "other" })
    }
  }
  symbols.sort((a, b) => a.value - b.value)
  return { format: "elf", segments, entry, symbols }
}

/** Intel HEX with extended linear addresses (what STM32CubeIDE emits). */
export function parseIhex(text: string): Firmware {
  const chunks: Segment[] = []
  let upper = 0
  let entry: number | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith(":")) continue
    const len = parseInt(line.slice(1, 3), 16)
    const addr = parseInt(line.slice(3, 7), 16)
    const type = parseInt(line.slice(7, 9), 16)
    const data = new Uint8Array(len)
    for (let i = 0; i < len; i++) data[i] = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16)
    switch (type) {
      case 0:
        chunks.push({ addr: (upper + addr) >>> 0, data })
        break
      case 1:
        break
      case 4:
        upper = ((data[0] << 8) | data[1]) << 16
        break
      case 5:
        entry = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0
        break
      case 2:
        upper = ((data[0] << 8) | data[1]) << 4
        break
    }
  }
  // Merge adjacent chunks.
  chunks.sort((a, b) => a.addr - b.addr)
  const segments: Segment[] = []
  for (const c of chunks) {
    const last = segments[segments.length - 1]
    if (last && last.addr + last.data.length === c.addr) {
      const merged = new Uint8Array(last.data.length + c.data.length)
      merged.set(last.data)
      merged.set(c.data, last.data.length)
      last.data = merged
    } else segments.push({ addr: c.addr, data: c.data })
  }
  return { format: "hex", segments, entry, symbols: [] }
}

export function parseBin(buf: ArrayBuffer, base = 0x08000000): Firmware {
  return { format: "bin", segments: [{ addr: base, data: new Uint8Array(buf) }], entry: null, symbols: [] }
}

/** Pick the parser by content: ELF magic, then HEX record marker, else raw binary. */
export function parseFirmware(buf: ArrayBuffer, name = ""): Firmware {
  const bytes = new Uint8Array(buf)
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return parseElf(buf)
  if (bytes[0] === 0x3a || /\.(hex|ihex)$/i.test(name)) return parseIhex(new TextDecoder().decode(buf))
  return parseBin(buf)
}

/** Nearest symbol at or below an address, for disassembly labels. */
export function symbolAt(symbols: Symbol[], addr: number): { symbol: Symbol; offset: number } | null {
  let lo = 0
  let hi = symbols.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (symbols[mid].value <= addr) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (best < 0) return null
  // Prefer a function symbol among equal addresses.
  let i = best
  while (i > 0 && symbols[i - 1].value === symbols[best].value) i--
  for (let j = i; j <= best; j++) if (symbols[j].type === "func") return { symbol: symbols[j], offset: addr - symbols[j].value }
  return { symbol: symbols[best], offset: addr - symbols[best].value }
}
