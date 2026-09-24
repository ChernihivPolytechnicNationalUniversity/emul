/**
 * A cursor over a DWARF section: fixed-size little-endian integers, LEB128, NUL-terminated
 * strings and the offsets whose width depends on the unit's format (32- or 64-bit DWARF).
 * Values wider than 53 bits come back rounded; nothing on a 32-bit target needs more.
 */
export class Reader {
  readonly bytes: Uint8Array
  readonly view: DataView
  pos: number
  /** 8 for 64-bit DWARF units, 4 otherwise: the width of section offsets. */
  offsetSize = 4
  /** Width of a target address. */
  addressSize = 4

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.pos = pos
  }

  get done() {
    return this.pos >= this.bytes.length
  }

  u8() {
    return this.bytes[this.pos++]
  }
  i8() {
    return this.view.getInt8(this.pos++)
  }
  u16() {
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }
  i16() {
    const v = this.view.getInt16(this.pos, true)
    this.pos += 2
    return v
  }
  u24() {
    const v = this.bytes[this.pos] | (this.bytes[this.pos + 1] << 8) | (this.bytes[this.pos + 2] << 16)
    this.pos += 3
    return v
  }
  u32() {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }
  i32() {
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }
  u64() {
    const lo = this.view.getUint32(this.pos, true)
    const hi = this.view.getUint32(this.pos + 4, true)
    this.pos += 8
    return hi * 0x100000000 + lo
  }
  i64() {
    const lo = this.view.getUint32(this.pos, true)
    const hi = this.view.getInt32(this.pos + 4, true)
    this.pos += 8
    return hi * 0x100000000 + lo
  }

  uleb() {
    let result = 0
    let mul = 1
    for (;;) {
      const b = this.bytes[this.pos++]
      result += (b & 0x7f) * mul
      mul *= 128
      if ((b & 0x80) === 0 || this.pos >= this.bytes.length) return result
    }
  }
  sleb() {
    let result = 0
    let mul = 1
    let b: number
    do {
      b = this.bytes[this.pos++]
      result += (b & 0x7f) * mul
      mul *= 128
    } while (b & 0x80 && this.pos < this.bytes.length)
    return b & 0x40 ? result - mul : result
  }

  /** A NUL-terminated string (UTF-8). */
  cstr() {
    const start = this.pos
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0) this.pos++
    const s = decodeUtf8(this.bytes, start, this.pos)
    this.pos++
    return s
  }

  /** A section offset in the unit's format. */
  offset() {
    return this.offsetSize === 8 ? this.u64() : this.u32()
  }
  address() {
    return this.addressSize === 8 ? this.u64() : this.addressSize === 2 ? this.u16() : this.u32()
  }
  /** An unsigned integer of `size` bytes. */
  sized(size: number) {
    return size === 1 ? this.u8() : size === 2 ? this.u16() : size === 3 ? this.u24() : size === 8 ? this.u64() : this.u32()
  }

  take(n: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  /**
   * A unit's initial length: 32-bit, or 0xffffffff followed by the 64-bit length. Sets the
   * offset size to match and returns the length of what follows.
   */
  initialLength() {
    const len = this.u32()
    if (len === 0xffffffff) {
      this.offsetSize = 8
      return this.u64()
    }
    this.offsetSize = 4
    return len
  }
}

const utf8 = new TextDecoder("utf-8")
/** Section strings are overwhelmingly ASCII: decode those without the TextDecoder round trip. */
export function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  let ascii = true
  for (let i = start; i < end; i++)
    if (bytes[i] >= 0x80) {
      ascii = false
      break
    }
  if (!ascii) return utf8.decode(bytes.subarray(start, end))
  let s = ""
  for (let i = start; i < end; i += 4096) s += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 4096)))
  return s
}

/** The NUL-terminated string at `offset` in a string section. */
export function stringAt(section: Uint8Array | undefined, offset: number): string {
  if (!section || offset >= section.length) return ""
  let end = offset
  while (end < section.length && section[end] !== 0) end++
  return decodeUtf8(section, offset, end)
}
