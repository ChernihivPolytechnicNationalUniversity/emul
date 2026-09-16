/**
 * System bus of the emulated MCU: flat memories, the peripheral window and the
 * private peripheral bus, addressed by the Cortex-M memory map.
 *
 * Little-endian throughout. Word accesses to memory may be unaligned (the core allows it
 * for LDR/STR); peripherals only see aligned word accesses and get narrower ones folded
 * into a read-modify-write of the containing register.
 */

import { STM32F429ZI, type MemoryRegion } from "./chip"

export class BusFault extends Error {
  readonly address: number
  readonly write: boolean
  readonly size: number
  constructor(address: number, write: boolean, size: number) {
    super(`${write ? "write" : "read"}${size * 8} at 0x${(address >>> 0).toString(16).padStart(8, "0")}: unmapped`)
    this.address = address
    this.write = write
    this.size = size
  }
}

/** A memory-mapped block; offsets are relative to `base`, in bytes. */
export interface Peripheral {
  readonly name: string
  readonly base: number
  readonly size: number
  read(offset: number, size: 1 | 2 | 4): number
  write(offset: number, value: number, size: 1 | 2 | 4): void
  /** Called when the CPU is reset. */
  reset(): void
}

/**
 * Peripheral that keeps word registers in a table. Subclasses override `readWord` and
 * `writeWord`; byte and halfword accesses are folded onto them.
 */
export abstract class WordPeripheral implements Peripheral {
  readonly name: string
  readonly base: number
  readonly size: number
  constructor(name: string, base: number, size: number) {
    this.name = name
    this.base = base
    this.size = size
  }
  abstract readWord(offset: number): number
  abstract writeWord(offset: number, value: number): void
  reset(): void {}

  read(offset: number, size: 1 | 2 | 4): number {
    if (size === 4) return this.readWord(offset) >>> 0
    const word = this.readWord(offset & ~3) >>> 0
    const shift = (offset & 3) * 8
    return (word >>> shift) & (size === 1 ? 0xff : 0xffff)
  }
  write(offset: number, value: number, size: 1 | 2 | 4): void {
    if (size === 4) {
      this.writeWord(offset, value >>> 0)
      return
    }
    const aligned = offset & ~3
    const shift = (offset & 3) * 8
    const mask = (size === 1 ? 0xff : 0xffff) << shift
    const word = this.readWord(aligned) >>> 0
    this.writeWord(aligned, ((word & ~mask) | ((value << shift) & mask)) >>> 0)
  }
}

/** A plain RAM/ROM block, possibly visible at several base addresses. */
export class Memory {
  readonly name: string
  readonly base: number
  bases: number[]
  readonly bytes: Uint8Array
  readonly view: DataView
  readonly isFlash: boolean
  readonly kind: MemoryRegion["kind"]
  readonly external: MemoryRegion["external"]
  /**
   * An external memory answers only once its controller has set it up (FMC SDRAM init
   * sequence): before that reads are whatever floats on the bus and writes are lost.
   */
  enabled = true
  /** The controller's write protection (SDCR.WP): stores are dropped. */
  writeProtected = false
  /** Set on every store into this block while `watch` is on (a display framebuffer). */
  watch = false
  dirty = false
  constructor(r: MemoryRegion) {
    this.name = r.name
    this.base = r.base
    this.bases = [r.base, ...(r.aliases ?? [])]
    this.bytes = new Uint8Array(r.size)
    this.view = new DataView(this.bytes.buffer)
    this.isFlash = r.kind === "flash"
    this.kind = r.kind
    this.external = r.external
    if (r.external) this.enabled = false
  }
  /** Byte offset of `addr` in this block through any of its aliases, or -1. */
  offsetOf(addr: number): number {
    for (const b of this.bases) if (addr >= b && addr < b + this.bytes.length) return addr - b
    return -1
  }
}

const SRAM_BASE = 0x20000000
const PERIPH_BASE = 0x40000000
const PERIPH_END = 0x60000000
/** Peripheral lookup granularity; every STM32 block is at least 1 KB aligned. */
const PERIPH_GRAIN = 10

export class Bus {
  readonly memories: Memory[]
  readonly flash: Memory
  /** Bit-band aliases (0x2200_0000 for SRAM, 0x4200_0000 for peripherals) exist on M3/M4 only. */
  bitBand: boolean
  private periph: (Peripheral | undefined)[] = new Array((PERIPH_END - PERIPH_BASE) >>> PERIPH_GRAIN)
  /** Blocks outside the peripheral window: the private peripheral bus, the FMC/QUADSPI controllers. */
  private others: Peripheral[] = []
  /** Told when an external memory is touched before its controller enabled it (once per run is enough). */
  onUnreadyAccess: ((mem: string, addr: number, write: boolean) => void) | null = null
  readonly peripherals: Peripheral[] = []
  /**
   * Answers accesses in the peripheral window that no model claims, so firmware touching an
   * unmodelled block reads zeros instead of faulting. Null makes such accesses BusFaults.
   */
  fallback: Peripheral | null = null
  /** Set on any flash write so the CPU can drop its decoded-instruction cache. */
  flashDirty = false
  /**
   * Takes over stores into flash: the FLASH controller decides whether the word gets
   * programmed (unlocked, PG set) or the store is an error. Without one flash is plain RAM.
   */
  flashWriter: ((addr: number, value: number, size: 1 | 2 | 4) => void) | null = null
  /** Told of every data read from flash, for the wait-state accounting. */
  onFlashRead: ((addr: number) => void) | null = null
  /** Number of the last unmapped access, for diagnostics. */
  faults = 0

  constructor(regions: MemoryRegion[] = STM32F429ZI.memory, bitBand = STM32F429ZI.core.bitBand) {
    this.memories = regions.map((r) => new Memory(r))
    const flash = this.memories.find((m) => m.isFlash)
    if (!flash) throw new Error("memory map has no flash")
    this.flash = flash
    this.bitBand = bitBand
  }

  /** Which flat memory backs an address (through any alias), or null. */
  memoryAt(addr: number): Memory | null {
    for (const m of this.memories) if (m.offsetOf(addr) >= 0) return m
    return null
  }

  attach(p: Peripheral) {
    this.peripherals.push(p)
    if (p.base >= PERIPH_END || p.base < PERIPH_BASE) {
      this.others.push(p)
      return
    }
    const first = (p.base - PERIPH_BASE) >>> PERIPH_GRAIN
    const last = (p.base + p.size - 1 - PERIPH_BASE) >>> PERIPH_GRAIN
    for (let i = first; i <= last; i++) {
      if (this.periph[i]) throw new Error(`peripheral ${p.name} overlaps ${this.periph[i]!.name}`)
      this.periph[i] = p
    }
  }

  peripheralAt(addr: number): Peripheral | undefined {
    if (addr >= PERIPH_BASE && addr < PERIPH_END) return this.periph[(addr - PERIPH_BASE) >>> PERIPH_GRAIN] ?? this.fallback ?? undefined
    for (const p of this.others) if (addr >= p.base && addr < p.base + p.size) return p
    return undefined
  }

  resetPeripherals() {
    for (const p of this.peripherals) p.reset()
  }

  // --- generic access -----------------------------------------------------------

  read(addr: number, size: 1 | 2 | 4): number {
    addr >>>= 0
    const mem = this.memoryAt(addr)
    if (mem) {
      const off = mem.offsetOf(addr)
      if (off + size > mem.bytes.length) throw new BusFault(addr, false, size)
      if (mem.isFlash && this.onFlashRead) this.onFlashRead(addr)
      if (!mem.enabled) return this.unready(mem, addr, false, size)
      return size === 4 ? mem.view.getUint32(off, true) : size === 2 ? mem.view.getUint16(off, true) : mem.bytes[off]
    }
    // Bit-band aliases of SRAM and the peripheral region.
    if (this.bitBand && addr >= 0x22000000 && addr < 0x24000000) return (this.read(SRAM_BASE + ((addr - 0x22000000) >>> 5), 1) >>> (((addr - 0x22000000) >>> 2) & 7)) & 1
    if (this.bitBand && addr >= 0x42000000 && addr < 0x44000000) return (this.read(PERIPH_BASE + ((addr - 0x42000000) >>> 5), 1) >>> (((addr - 0x42000000) >>> 2) & 7)) & 1
    const p = this.peripheralAt(addr)
    if (p) return p.read(addr - p.base, size) >>> 0
    this.faults++
    throw new BusFault(addr, false, size)
  }

  write(addr: number, value: number, size: 1 | 2 | 4): void {
    addr >>>= 0
    const mem = this.memoryAt(addr)
    if (mem) {
      const off = mem.offsetOf(addr)
      if (off + size > mem.bytes.length) throw new BusFault(addr, true, size)
      // ROM (system memory, option bytes) takes no stores; flash goes through its controller.
      if (mem.kind === "rom") throw new BusFault(addr, true, size)
      if (mem.isFlash) {
        if (this.flashWriter) {
          this.flashWriter(addr, value >>> 0, size)
          return
        }
        this.flashDirty = true
      }
      if (!mem.enabled) {
        this.unready(mem, addr, true, size)
        return
      }
      if (mem.writeProtected) return
      if (mem.watch) mem.dirty = true
      if (size === 4) mem.view.setUint32(off, value >>> 0, true)
      else if (size === 2) mem.view.setUint16(off, value & 0xffff, true)
      else mem.bytes[off] = value & 0xff
      return
    }
    if (this.bitBand && addr >= 0x22000000 && addr < 0x24000000) {
      const target = SRAM_BASE + ((addr - 0x22000000) >>> 5)
      const bit = ((addr - 0x22000000) >>> 2) & 7
      const cur = this.read(target, 1)
      this.write(target, value & 1 ? cur | (1 << bit) : cur & ~(1 << bit), 1)
      return
    }
    if (this.bitBand && addr >= 0x42000000 && addr < 0x44000000) {
      const target = PERIPH_BASE + ((addr - 0x42000000) >>> 5)
      const bit = ((addr - 0x42000000) >>> 2) & 7
      const cur = this.read(target & ~3, 4)
      const b = bit + (target & 3) * 8
      this.write(target & ~3, value & 1 ? cur | (1 << b) : cur & ~(1 << b), 4)
      return
    }
    const p = this.peripheralAt(addr)
    if (p) {
      p.write(addr - p.base, value >>> 0, size)
      return
    }
    this.faults++
    throw new BusFault(addr, true, size)
  }

  /**
   * An external memory before its controller has brought it up: the data lines float, so a
   * read gives a bus-dependent pattern (the address bits, as an undriven bus tends to echo)
   * and a write goes nowhere. Reported once so the inspector can say what happened.
   */
  private unready(mem: Memory, addr: number, write: boolean, size: 1 | 2 | 4): number {
    if (this.onUnreadyAccess) this.onUnreadyAccess(mem.name, addr, write)
    if (write) return 0
    const pattern = ((addr * 2654435761) ^ (addr >>> 7)) >>> 0
    return size === 4 ? pattern : size === 2 ? pattern & 0xffff : pattern & 0xff
  }

  /**
   * Direct bytes of an enabled memory holding [addr, addr + length), for a display controller
   * to scan a framebuffer line without a bus access per pixel; null when unmapped, gated off
   * or crossing a block. Marks the block watched so stores into it flag `dirty`.
   */
  frameBytes(addr: number, length: number): { bytes: Uint8Array; offset: number } | null {
    const mem = this.memoryAt(addr)
    if (!mem || !mem.enabled) return null
    const off = mem.offsetOf(addr)
    if (off + length > mem.bytes.length) return null
    mem.watch = true
    return { bytes: mem.bytes, offset: off }
  }

  /** Whether any watched block was stored into since the flags were last cleared. */
  takeDirty(): boolean {
    let dirty = false
    for (const m of this.memories) {
      if (m.dirty) dirty = true
      m.dirty = false
    }
    return dirty
  }

  /** The external memory block of a kind ("sdram2"), for its controller to enable and for displays to read. */
  external(kind: MemoryRegion["external"]): Memory | null {
    for (const m of this.memories) if (m.external === kind) return m
    return null
  }

  read8(addr: number) {
    return this.read(addr, 1)
  }
  read16(addr: number) {
    return this.read(addr, 2)
  }
  read32(addr: number) {
    return this.read(addr, 4)
  }
  write8(addr: number, v: number) {
    this.write(addr, v, 1)
  }
  write16(addr: number, v: number) {
    this.write(addr, v, 2)
  }
  write32(addr: number, v: number) {
    this.write(addr, v, 4)
  }

  /** Instruction fetch: halfword from flash/RAM, never from a peripheral. */
  fetch16(addr: number): number {
    const mem = this.memoryAt(addr)
    if (!mem) throw new BusFault(addr, false, 2)
    const off = mem.offsetOf(addr)
    if (off + 2 > mem.bytes.length) throw new BusFault(addr, false, 2)
    return mem.view.getUint16(off, true)
  }

  /** Copy a blob into memory (used by the loader); silently clips to the region. */
  load(addr: number, data: Uint8Array) {
    const mem = this.memoryAt(addr)
    if (!mem) throw new Error(`cannot load ${data.length} bytes at 0x${addr.toString(16)}: no memory there`)
    const off = mem.offsetOf(addr)
    mem.bytes.set(data.subarray(0, Math.max(0, Math.min(data.length, mem.bytes.length - off))), off)
    if (mem.isFlash) this.flashDirty = true
  }

  /** Erased flash reads 0xFF; RAM comes up zeroed (real RAM is random, zero is the kinder lie). ROM is left alone. */
  clearMemories() {
    for (const m of this.memories) if (m.kind !== "rom") m.bytes.fill(m.isFlash ? 0xff : 0)
    this.flashDirty = true
  }
  /**
   * What address 0 aliases (RM0090 §2.4, SYSCFG MEMRMP): the boot pins pick flash, system
   * memory or SRAM at reset, and firmware may remap later. Only the alias moves; the block
   * stays at its own address too.
   */
  remap(target: "flash" | "system" | "sram") {
    const want = target === "flash" ? this.flash : this.memories.find((m) => (target === "system" ? m.name === "SYSTEM" : m.base === SRAM_BASE))
    for (const m of this.memories) m.bases = m.bases.filter((b) => b !== 0)
    if (want) want.bases = [...want.bases, 0]
  }
  /** A reset: RAM is lost, flash keeps what was programmed into it. */
  clearRam() {
    for (const m of this.memories) {
      if (m.kind !== "ram") continue
      m.bytes.fill(0)
      // An external memory drops off the bus again: its controller reset with the core.
      if (m.external) m.enabled = false
    }
  }
  /** Direct access to a ROM/flash block's bytes for the controller and the loader. */
  bytesAt(addr: number): { bytes: Uint8Array; offset: number } | null {
    const mem = this.memoryAt(addr)
    return mem ? { bytes: mem.bytes, offset: mem.offsetOf(addr) } : null
  }
}
