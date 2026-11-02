import type { Bus, Memory, MemoryPort } from "./bus"

export const READ = 1
export const WRITE = 2
export const EXEC = 4
const READ_WRITE = READ | WRITE
const PAGE_KNOWN = 0x80
const PAGE_CUT_BY_REGIONS = 0x08
const PAGE_PLAIN_MEMORY = 0x10
const FAST_READ = PAGE_PLAIN_MEMORY | READ
const FAST_WRITE = PAGE_PLAIN_MEMORY | WRITE

const PAGE_SHIFT = 16
const PAGE = 1 << PAGE_SHIFT
const PAGES = 1 << (32 - PAGE_SHIFT)
const PPB_BASE = 0xe0000000
const PPB_END = 0xe0100000
const STIR = 0xe000ef00
const FOUR_GB = 2 ** 32
const SUBREGIONS = 8
const SMALLEST_REGION = 32
const SMALLEST_REGION_WITH_SUBREGIONS = 256

export const MPU_ENABLE = 1
export const MPU_HFNMIENA = 2
export const MPU_PRIVDEFENA = 4
export const MPU_REGIONS = 8
export const MPU_RASR_WRITABLE = 0x173fff3f

const ACCESS_PERMISSIONS_PRIVILEGED_UNPRIVILEGED: readonly (readonly [number, number])[] = [
  [0, 0],
  [READ_WRITE, 0],
  [READ_WRITE, READ],
  [READ_WRITE, READ_WRITE],
  [0, 0],
  [READ, 0],
  [READ, READ],
  [READ, READ],
]

export function defaultMapExecutable(addr: number): boolean {
  return addr < 0x40000000 || (addr >= 0x60000000 && addr < 0xa0000000)
}

type Region = { base: number; size: number; subregion: number; disabledSubregions: number; privileged: number; unprivileged: number; executeNever: boolean }

function decodeRegion(rbar: number, rasr: number): Region | null {
  if ((rasr & 1) === 0) return null
  const size = 2 ** (((rasr >>> 1) & 0x1f) + 1)
  if (size < SMALLEST_REGION) return null
  const [privileged, unprivileged] = ACCESS_PERMISSIONS_PRIVILEGED_UNPRIVILEGED[(rasr >>> 24) & 7]
  return {
    base: size >= FOUR_GB ? 0 : (rbar & ~(size - 1)) >>> 0,
    size,
    subregion: size / SUBREGIONS,
    disabledSubregions: size >= SMALLEST_REGION_WITH_SUBREGIONS ? (rasr >>> 8) & 0xff : 0,
    privileged,
    unprivileged,
    executeNever: (rasr & (1 << 28)) !== 0,
  }
}

const PRIVILEGED_UNDER_MPU = 0
const UNPRIVILEGED_UNDER_MPU = 1
const UNPRIVILEGED_DEFAULT_MAP = 2
const PRIVILEGED_DEFAULT_MAP = 3

export type Refusal = (addr: number, access: number, unprivilegedPpb: boolean) => never

export class MemoryGuard implements MemoryPort {
  private readonly bus: Bus
  private readonly pageMem: (Memory | null)[]
  private readonly pageBase: Float64Array
  slow = false
  private readonly tables = [new Uint8Array(PAGES), new Uint8Array(PAGES), new Uint8Array(PAGES), new Uint8Array(PAGES)]
  private table: Uint8Array
  private mode = PRIVILEGED_UNDER_MPU
  private regions: Region[] = []
  private privilegedDefaultMap = false
  private privileged = true
  private mpuInForce = true
  private configurations = 0
  fetchKey = 0
  private readonly refuse: Refusal
  private readonly unprivilegedMayPend: () => boolean

  constructor(bus: Bus, refuse: Refusal, unprivilegedMayPend: () => boolean) {
    this.bus = bus
    this.pageMem = bus.pageMem
    this.pageBase = bus.pageBase
    this.refuse = refuse
    this.unprivilegedMayPend = unprivilegedMayPend
    this.table = this.tables[PRIVILEGED_UNDER_MPU]
  }

  configure(ctrl: number, rbar: ArrayLike<number>, rasr: ArrayLike<number>) {
    const regions: Region[] = []
    for (let i = 0; i < rbar.length; i++) {
      const r = decodeRegion(rbar[i], rasr[i])
      if (r !== null) regions.push(r)
    }
    this.regions = regions
    this.privilegedDefaultMap = (ctrl & MPU_PRIVDEFENA) !== 0
    for (const t of this.tables) t.fill(0)
    this.configurations++
    this.updateFetchKey()
  }

  select(privileged: boolean, mpuInForce: boolean) {
    this.privileged = privileged
    this.mpuInForce = mpuInForce
    this.mode = mpuInForce ? (privileged ? PRIVILEGED_UNDER_MPU : UNPRIVILEGED_UNDER_MPU) : privileged ? PRIVILEGED_DEFAULT_MAP : UNPRIVILEGED_DEFAULT_MAP
    this.table = this.tables[this.mode]
    this.updateFetchKey()
  }

  private updateFetchKey() {
    this.fetchKey = this.configurations * 4 + this.mode
  }

  read8(addr: number) {
    const p = addr >>> PAGE_SHIFT
    if ((this.table[p] & FAST_READ) === FAST_READ) {
      const mem = this.pageMem[p]!
      const off = addr - this.pageBase[p]
      if (off < mem.bytes.length) {
        if (mem.plain) return mem.bytes[off]
        if (mem.isFlash) {
          this.bus.onFlashRead?.(addr)
          return mem.bytes[off]
        }
      }
    }
    return this.read(addr, 1)
  }
  read16(addr: number) {
    const p = addr >>> PAGE_SHIFT
    if ((this.table[p] & FAST_READ) === FAST_READ) {
      const mem = this.pageMem[p]!
      const off = addr - this.pageBase[p]
      if (off + 2 <= mem.bytes.length) {
        if (mem.plain) return mem.view.getUint16(off, true)
        if (mem.isFlash) {
          this.bus.onFlashRead?.(addr)
          return mem.view.getUint16(off, true)
        }
      }
    }
    return this.read(addr, 2)
  }
  read32(addr: number) {
    const p = addr >>> PAGE_SHIFT
    if ((this.table[p] & FAST_READ) === FAST_READ) {
      const mem = this.pageMem[p]!
      const off = addr - this.pageBase[p]
      if (off + 4 <= mem.bytes.length) {
        if (mem.plain) return mem.view.getUint32(off, true)
        if (mem.isFlash) {
          this.bus.onFlashRead?.(addr)
          return mem.view.getUint32(off, true)
        }
      }
    }
    return this.read(addr, 4)
  }
  write8(addr: number, v: number) {
    const p = addr >>> PAGE_SHIFT
    if ((this.table[p] & FAST_WRITE) === FAST_WRITE) {
      const mem = this.pageMem[p]!
      const off = addr - this.pageBase[p]
      if (mem.plain && off < mem.bytes.length) {
        if (mem.watch) mem.stored(off, v, 1)
        mem.bytes[off] = v & 0xff
        return
      }
    }
    this.write(addr, v, 1)
  }
  write16(addr: number, v: number) {
    const p = addr >>> PAGE_SHIFT
    if ((this.table[p] & FAST_WRITE) === FAST_WRITE) {
      const mem = this.pageMem[p]!
      const off = addr - this.pageBase[p]
      if (mem.plain && off + 2 <= mem.bytes.length) {
        if (mem.watch) mem.stored(off, v, 2)
        mem.view.setUint16(off, v & 0xffff, true)
        return
      }
    }
    this.write(addr, v, 2)
  }
  write32(addr: number, v: number) {
    const p = addr >>> PAGE_SHIFT
    if ((this.table[p] & FAST_WRITE) === FAST_WRITE) {
      const mem = this.pageMem[p]!
      const off = addr - this.pageBase[p]
      if (mem.plain && off + 4 <= mem.bytes.length) {
        if (mem.watch) mem.stored(off, v, 4)
        mem.view.setUint32(off, v >>> 0, true)
        return
      }
    }
    this.write(addr, v, 4)
  }
  read(addr: number, size: 1 | 2 | 4) {
    if ((this.table[addr >>> PAGE_SHIFT] & READ) === 0) this.check(addr, size, READ)
    const value = this.bus.read(addr, size)
    this.slow ||= this.bus.slow
    return value
  }
  write(addr: number, value: number, size: 1 | 2 | 4) {
    if ((this.table[addr >>> PAGE_SHIFT] & WRITE) === 0) this.check(addr, size, WRITE)
    this.bus.write(addr, value, size)
    this.slow ||= this.bus.slow
  }

  fetchable(addr: number): boolean {
    const page = addr >>> PAGE_SHIFT
    let entry = this.table[page]
    if (entry & EXEC) return true
    if (entry === 0) entry = this.fill(page)
    if (entry & EXEC) return true
    return (entry & PAGE_CUT_BY_REGIONS) !== 0 && (this.permission(addr >>> 0) & EXEC) !== 0
  }

  allowsRange(addr: number, bytes: number, access: number): boolean {
    for (let offset = 0; offset < bytes; offset += 4) if (!this.allows((addr + offset) >>> 0, access)) return false
    return true
  }

  checkAsUnprivileged(addr: number, size: number, access: number, mpuInForce: boolean) {
    const { privileged, mpuInForce: before } = this
    this.select(false, mpuInForce)
    try {
      if ((this.table[addr >>> PAGE_SHIFT] & access) === 0) this.check(addr, size, access)
    } finally {
      this.select(privileged, before)
    }
  }

  private check(addr: number, size: number, access: number) {
    const a = addr >>> 0
    const page = a >>> PAGE_SHIFT
    let entry = this.table[page]
    if (entry === 0) entry = this.fill(page)
    if (entry & access) return
    if ((entry & PAGE_CUT_BY_REGIONS) !== 0 && this.allowsAccess(a, size, access)) return
    this.refuse(a, access, !this.privileged && a >= PPB_BASE && a < PPB_END)
  }

  private allowsAccess(a: number, size: number, access: number): boolean {
    if (a === STIR && access === WRITE && !this.privileged) return this.unprivilegedMayPend()
    return this.allows(a, access) && this.allows((a + size - 1) >>> 0, access)
  }

  private allows(a: number, access: number): boolean {
    return (this.permission(a) & access) !== 0
  }

  private permission(a: number): number {
    if (a >= PPB_BASE && a < PPB_END) return this.privileged ? READ_WRITE : 0
    const defaultMap = defaultMapExecutable(a) ? READ_WRITE | EXEC : READ_WRITE
    if (!this.mpuInForce) return defaultMap
    const regions = this.regions
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i]
      const offset = (a - r.base) >>> 0
      if (offset >= r.size) continue
      if ((r.disabledSubregions >>> Math.floor(offset / r.subregion)) & 1) continue
      const granted = this.privileged ? r.privileged : r.unprivileged
      return granted & READ && !r.executeNever ? granted | EXEC : granted
    }
    return this.privileged && this.privilegedDefaultMap ? defaultMap : 0
  }

  private fill(page: number): number {
    const start = page * PAGE
    const cut = this.regionBoundaryInside(start) || (!this.privileged && page === STIR >>> PAGE_SHIFT)
    const plainMemory = this.pageMem[page] !== null && this.bus.pageMixed[page] === 0 ? PAGE_PLAIN_MEMORY : 0
    const entry = cut ? PAGE_CUT_BY_REGIONS : PAGE_KNOWN | plainMemory | this.permission(start)
    this.table[page] = entry
    return entry
  }

  private regionBoundaryInside(start: number): boolean {
    if (!this.mpuInForce) return false
    for (const r of this.regions) {
      const grain = r.disabledSubregions !== 0 ? r.subregion : r.size
      if (grain < PAGE && r.base < start + PAGE && start < r.base + r.size) return true
    }
    return false
  }
}
