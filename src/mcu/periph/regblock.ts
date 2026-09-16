/**
 * Table-driven peripheral: a block of word registers with reset values, a write mask per
 * register and hooks for side effects. Most STM32 peripherals are mostly this.
 */
import { WordPeripheral } from "../bus"

export type RegDef = {
  name: string
  offset: number
  reset?: number
  /** Bits software can change; the rest keep their current value. Default: all. */
  rw?: number
  /** Write-one-to-clear bits: writing 1 clears them, writing 0 leaves them. */
  w1c?: number
}

export type AccessLog = { offset: number; name: string; value: number; write: boolean; cycles: number }

export abstract class RegBlock extends WordPeripheral {
  readonly regs: Uint32Array
  private readonly defs = new Map<number, RegDef>()
  /** Accesses to offsets that have no register, for diagnostics. */
  readonly unknown = new Map<number, number>()

  constructor(name: string, base: number, size: number, defs: RegDef[]) {
    super(name, base, size)
    this.regs = new Uint32Array(size >>> 2)
    for (const d of defs) this.defs.set(d.offset, d)
    this.reset()
  }

  reset(): void {
    this.regs.fill(0)
    for (const d of this.defs.values()) this.regs[d.offset >>> 2] = (d.reset ?? 0) >>> 0
  }

  def(offset: number): RegDef | undefined {
    return this.defs.get(offset)
  }
  regName(offset: number): string {
    return this.defs.get(offset)?.name ?? `+0x${offset.toString(16)}`
  }

  /** Current value of a register by name (for the SoC and for debugging). */
  get(name: string): number {
    for (const d of this.defs.values()) if (d.name === name) return this.regs[d.offset >>> 2]
    throw new Error(`${this.name}: no register ${name}`)
  }
  set(name: string, value: number) {
    for (const d of this.defs.values()) {
      if (d.name === name) {
        this.regs[d.offset >>> 2] = value >>> 0
        return
      }
    }
    throw new Error(`${this.name}: no register ${name}`)
  }

  readWord(offset: number): number {
    const d = this.defs.get(offset)
    if (!d) {
      this.unknown.set(offset, (this.unknown.get(offset) ?? 0) + 1)
      return 0
    }
    return this.onRead(d, this.regs[offset >>> 2]) >>> 0
  }

  writeWord(offset: number, value: number): void {
    const d = this.defs.get(offset)
    if (!d) {
      this.unknown.set(offset, (this.unknown.get(offset) ?? 0) + 1)
      return
    }
    const i = offset >>> 2
    const old = this.regs[i]
    const rw = d.rw ?? 0xffffffff
    let next = ((old & ~rw) | (value & rw)) >>> 0
    if (d.w1c) next = (next & ~(value & d.w1c)) >>> 0
    const result = this.onWrite(d, next, old, value)
    this.regs[i] = (result === undefined ? next : result) >>> 0
  }

  /** Hook: transform the value software reads. */
  protected onRead(_d: RegDef, current: number): number {
    return current
  }
  /** Hook: side effects of a write; may return the value to store instead of `next`. */
  protected onWrite(_d: RegDef, _next: number, _old: number, _written: number): number | void {}
}
