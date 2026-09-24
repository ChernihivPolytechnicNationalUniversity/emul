/**
 * The target's memory as the UI has it at a stop: chunks the core sent (RAM, the stack, a
 * peripheral block), and the image's own flash contents underneath. Reads are synchronous;
 * one that falls outside what is held is recorded as a miss, which the session fetches and
 * then evaluates again — so the views render at once and fill in within a round trip.
 */
import type { MemoryChunk } from "./protocol"

/** Misses are fetched in whole pages of this size, so a struct read byte by byte costs one request. */
export const PAGE = 256

type Chunk = { addr: number; end: number; bytes: Uint8Array; invalid?: [number, number][] }

export class MemorySnapshot {
  private chunks: Chunk[] = []
  /** What the image put in flash: used where no chunk has the bytes (code, constants). */
  private readonly base: Chunk[]
  /** Page-aligned ranges asked for and not held. */
  readonly misses = new Set<number>()

  constructor(base: { addr: number; data: Uint8Array }[] = [], chunks: MemoryChunk[] = []) {
    this.base = base.map((s) => ({ addr: s.addr, end: s.addr + s.data.length, bytes: s.data })).sort((a, b) => a.addr - b.addr)
    for (const c of chunks) this.add(c)
  }

  /** Add (or replace) what the core sent for a range. */
  add(c: MemoryChunk) {
    const chunk: Chunk = { addr: c.addr, end: c.addr + c.bytes.length, bytes: c.bytes, invalid: c.invalid }
    // Newer bytes win: drop what they cover entirely, keep partial overlaps behind them.
    this.chunks = this.chunks.filter((x) => !(x.addr >= chunk.addr && x.end <= chunk.end))
    this.chunks.push(chunk)
    this.chunks.sort((a, b) => a.addr - b.addr)
    for (let p = Math.floor(c.addr / PAGE) * PAGE; p < chunk.end; p += PAGE) this.misses.delete(p)
  }

  private find(list: Chunk[], addr: number, size: number): Chunk | null {
    // Latest chunk first: a later fetch of a range supersedes an older one.
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i]
      if (addr >= c.addr && addr + size <= c.end) return c
    }
    return null
  }

  /** Whether nothing answers anywhere in the range (unmapped). */
  unmapped(addr: number, size: number): boolean {
    const c = this.find(this.chunks, addr, size)
    return !!c?.invalid?.some(([lo, hi]) => addr < hi && addr + size > lo)
  }

  /** `size` bytes at `addr`, or null when they are not held (a miss is recorded) or not mapped. */
  bytes(addr: number, size: number): Uint8Array | null {
    addr >>>= 0
    if (size <= 0) return new Uint8Array(0)
    const c = this.find(this.chunks, addr, size) ?? this.find(this.base, addr, size)
    if (!c) {
      for (let p = Math.floor(addr / PAGE) * PAGE; p < addr + size; p += PAGE) this.misses.add(p >>> 0)
      return null
    }
    if (c.invalid?.some(([lo, hi]) => addr < hi && addr + size > lo)) return null
    return c.bytes.subarray(addr - c.addr, addr - c.addr + size)
  }

  u8(addr: number): number | null {
    const b = this.bytes(addr, 1)
    return b ? b[0] : null
  }
  u16(addr: number): number | null {
    const b = this.bytes(addr, 2)
    return b ? b[0] | (b[1] << 8) : null
  }
  u32(addr: number): number | null {
    const b = this.bytes(addr, 4)
    return b ? (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0 : null
  }
  /** A little-endian read of 1, 2 or 4 bytes, the shape DWARF expressions ask for. */
  read(addr: number, size: number): number | null {
    return size === 1 ? this.u8(addr) : size === 2 ? this.u16(addr) : this.u32(addr)
  }

  /** A NUL-terminated string at `addr`, at most `max` bytes; null when the first byte is not held. */
  cString(addr: number, max = 256): { text: string; truncated: boolean } | null {
    const out: number[] = []
    for (let i = 0; i < max; i++) {
      const b = this.u8(addr + i)
      if (b === null) return i === 0 ? null : { text: decodeLatin(out), truncated: true }
      if (b === 0) return { text: decodeLatin(out), truncated: false }
      out.push(b)
    }
    return { text: decodeLatin(out), truncated: true }
  }

  /** The misses as ranges to fetch, and forget them. */
  takeMisses(): { addr: number; size: number }[] {
    const pages = [...this.misses].sort((a, b) => a - b)
    this.misses.clear()
    const out: { addr: number; size: number }[] = []
    for (const p of pages) {
      const last = out[out.length - 1]
      if (last && last.addr + last.size === p) last.size += PAGE
      else out.push({ addr: p, size: PAGE })
    }
    return out
  }
}

/** Bytes of target text: UTF-8 when it is, one byte per character otherwise. */
function decodeLatin(bytes: number[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes))
  } catch {
    return String.fromCharCode(...bytes)
  }
}
