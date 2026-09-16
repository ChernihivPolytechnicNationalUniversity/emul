/**
 * FLASH interface (RM0090 §3, RM0385 §3): the access-control bits, and the controller that
 * programs and erases the flash and the option bytes.
 *
 * Programming and erasing take their datasheet time by stalling the core (code runs from the
 * same flash, so that is what the hardware does too); BSY therefore always reads clear and
 * EOP is already set when the store instruction retires. Programming clears bits only, erase
 * sets a sector to 0xFF; a store into flash with the controller locked or PG clear is a
 * sequence error, a size other than PSIZE a parallelism error, a write-protected sector a
 * WRP error. Option bytes are non-volatile: they survive resets and are only restored to the
 * factory values when new firmware is loaded (a fresh part). RDP is stored, never enforced.
 *
 * "v1" is the F4 register map (WDG_SW, nRST_STOP/STDBY, nWRP for two banks, boot by the
 * BOOT0/BOOT1 pins), "v2" the F7 one (IWDG/WWDG_SW, BOOT_ADD0/1 in OPTCR1, single bank).
 */
import type { Bus } from "../bus"
import type { ChipProfile } from "../chip"
import { RegBlock, type RegDef } from "./regblock"

const KEY1 = 0x45670123
const KEY2 = 0xcdef89ab
const OPTKEY1 = 0x08192a3b
const OPTKEY2 = 0x4c5d6e7f

const CR_PG = 1 << 0
const CR_SER = 1 << 1
const CR_MER = 1 << 2
const CR_MER1 = 1 << 15
const CR_STRT = 1 << 16
const CR_EOPIE = 1 << 24
const CR_ERRIE = 1 << 25
const CR_LOCK = 1 << 31

const SR_EOP = 1 << 0
const SR_OPERR = 1 << 1
const SR_WRPERR = 1 << 4
const SR_PGAERR = 1 << 5
const SR_PGPERR = 1 << 6
const SR_PGSERR = 1 << 7
const SR_ERRORS = SR_OPERR | SR_WRPERR | SR_PGAERR | SR_PGPERR | SR_PGSERR

const OPT_LOCK = 1 << 0
const OPT_STRT = 1 << 1

/** Datasheet typical times (DS9405 §6.3.15, DS10916 §6.3.15) for a x32 parallelism. */
const T_PROGRAM = 16e-6
const eraseTime = (size: number) => (size <= 32 * 1024 ? 0.25 : size <= 64 * 1024 ? 0.55 : size <= 128 * 1024 ? 1.0 : 2.0)
const T_MASS_ERASE = 8

export type FlashSector = { snb: number; bank: number; start: number; size: number }

export class FlashIf extends RegBlock {
  readonly map: "v1" | "v2"
  readonly geometry: ChipProfile["flash"]
  readonly flashBase: number
  readonly sectors: FlashSector[] = []
  bus: Bus | null = null
  /** The core stalls for this long: a program or erase in progress. */
  onBusy: (seconds: number) => void = () => {}
  raiseIrq: (irq: number) => void = () => {}
  /** The option bytes changed (BOR level, watchdog mode): the SoC re-reads what it cares about. */
  onOptions: () => void = () => {}
  /** ACR changed: wait states, prefetch, the instruction/data caches (and their reset bits). */
  onAcr: (acr: number, reset: boolean) => void = () => {}
  private keyStage = 0
  private optKeyStage = 0
  /** The programmed option bytes, kept across resets. */
  private optcr: number
  private optcr1: number
  private readonly optcrReset: number
  private readonly optcr1Reset: number

  constructor(map: "v1" | "v2", geometry: ChipProfile["flash"], flashBase: number) {
    super("FLASH", 0x40023c00, 0x400, [
      { name: "ACR", offset: 0x00, reset: 0, rw: 0x00001f0f },
      { name: "KEYR", offset: 0x04 },
      { name: "OPTKEYR", offset: 0x08 },
      { name: "SR", offset: 0x0c, reset: 0, w1c: SR_ERRORS | SR_EOP | (1 << 8) },
      { name: "CR", offset: 0x10, reset: CR_LOCK },
      { name: "OPTCR", offset: 0x14, reset: map === "v1" ? 0x0fffaaed : 0xc0ffaafd },
      { name: "OPTCR1", offset: 0x18, reset: map === "v1" ? 0x0fff0000 : 0x00400080 },
    ])
    this.map = map
    this.geometry = geometry
    this.flashBase = flashBase
    this.optcrReset = map === "v1" ? 0x0fffaaed : 0xc0ffaafd
    this.optcr1Reset = map === "v1" ? 0x0fff0000 : 0x00400080
    this.optcr = this.optcrReset
    this.optcr1 = this.optcr1Reset
    let offset = 0
    for (let bank = 0; bank < geometry.banks; bank++)
      geometry.sectors.forEach((size, i) => {
        this.sectors.push({ snb: bank * 16 + i, bank, start: offset, size })
        offset += size
      })
    this.reset()
  }

  reset() {
    super.reset()
    if (this.optcr === undefined) return
    this.keyStage = this.optKeyStage = 0
    this.onAcr(0, true)
    // Option bytes come back locked with what was programmed into them.
    this.regs[0x14 >>> 2] = (this.optcr | OPT_LOCK) >>> 0
    this.regs[0x18 >>> 2] = this.optcr1 >>> 0
    this.publishOptions()
  }

  /** New firmware loaded: a fresh part, factory option bytes. */
  restoreOptions() {
    this.optcr = this.optcrReset
    this.optcr1 = this.optcr1Reset
    this.reset()
  }

  // --- what the SoC asks ------------------------------------------------------------------

  /** BOOT0 (and BOOT1 = PB2 on the F4) → the vector table the core boots from. */
  bootAddress(boot0: boolean, boot1: boolean): number {
    if (this.map === "v2") {
      const add = boot0 ? (this.optcr1 >>> 16) & 0xffff : this.optcr1 & 0xffff
      return (add << 14) >>> 0
    }
    if (!boot0) return this.flashBase
    return boot1 ? 0x20000000 : this.geometry.system.base
  }
  /** WDG_SW (F4) / IWDG_SW (F7) clear: the independent watchdog runs from reset. */
  iwdgHardware() {
    return (this.optcr & (1 << 5)) === 0
  }
  /** nRST_STOP / nRST_STDBY clear: entering the mode resets the chip instead. */
  resetOnStop() {
    return (this.optcr & (1 << 6)) === 0
  }
  resetOnStandby() {
    return (this.optcr & (1 << 7)) === 0
  }
  /** BOR_LEV as the VDD the chip is held in reset below (V); "off" is the bare POR threshold. */
  borThreshold(): number {
    return [2.7, 2.4, 2.1, 1.7][(this.optcr >>> 2) & 3]
  }
  /** RDP level (0, 1, or 2 when 0xCC) — stored for the firmware to read, not enforced. */
  rdpLevel(): 0 | 1 | 2 {
    const rdp = (this.optcr >>> 8) & 0xff
    return rdp === 0xaa ? 0 : rdp === 0xcc ? 2 : 1
  }

  sectorOf(addr: number): FlashSector | null {
    const off = addr - this.flashBase
    for (const s of this.sectors) if (off >= s.start && off < s.start + s.size) return s
    return null
  }
  private writeProtected(s: FlashSector) {
    const nwrp = s.bank === 0 ? this.optcr : this.optcr1
    return (nwrp & (1 << (16 + (s.snb & 15)))) === 0
  }

  // --- register file ----------------------------------------------------------------------

  protected onRead(d: RegDef, current: number): number {
    // Cache reset bits read as zero; keys read as zero.
    if (d.name === "ACR") return current & ~0x1800
    if (d.name === "KEYR" || d.name === "OPTKEYR") return 0
    return current
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    switch (d.name) {
      case "ACR":
        this.onAcr(next, (written & 0x1800) !== 0)
        return
      case "KEYR":
        if (this.keyStage === 0 && written === KEY1) this.keyStage = 1
        else if (this.keyStage === 1 && written === KEY2) {
          this.keyStage = 0
          this.regs[0x10 >>> 2] &= ~CR_LOCK
        } else this.keyStage = 0
        return 0
      case "OPTKEYR":
        if (this.optKeyStage === 0 && written === OPTKEY1) this.optKeyStage = 1
        else if (this.optKeyStage === 1 && written === OPTKEY2) {
          this.optKeyStage = 0
          this.regs[0x14 >>> 2] &= ~OPT_LOCK
        } else this.optKeyStage = 0
        return 0
      case "CR": {
        // Locked: nothing but the interrupt enables can change; LOCK itself can only be set.
        if (old & CR_LOCK) return ((old & ~(CR_EOPIE | CR_ERRIE)) | (next & (CR_EOPIE | CR_ERRIE))) >>> 0
        let v = next
        if (v & CR_STRT) {
          v &= ~CR_STRT
          this.erase(v)
        }
        return v >>> 0
      }
      case "OPTCR": {
        if (old & OPT_LOCK) return (old | (next & OPT_LOCK)) >>> 0
        let v = next
        if (v & OPT_STRT) {
          v &= ~OPT_STRT
          this.optcr = v & ~OPT_LOCK
          this.optcr1 = this.regs[0x18 >>> 2]
          this.publishOptions()
          this.onOptions()
        }
        return v >>> 0
      }
      case "OPTCR1":
        return this.regs[0x14 >>> 2] & OPT_LOCK ? old : next
    }
  }

  /** The option bytes as they read back from their memory (RM0090 Table 15, RM0385 Table 9). */
  private publishOptions() {
    const at = this.bus?.bytesAt(this.geometry.optionBytes)
    if (!at) return
    const view = new DataView(at.bytes.buffer, at.offset, at.bytes.length - at.offset)
    const half = (off: number, v: number) => {
      view.setUint16(off, v & 0xffff, true)
      view.setUint16(off + 2, ~v & 0xffff, true)
    }
    if (this.map === "v1") {
      half(0, this.optcr & 0xfffc)
      half(8, (this.optcr >>> 16) & 0x0fff)
    } else {
      half(0, this.optcr & 0xffff)
      half(8, (this.optcr >>> 16) & 0xffff)
      half(16, this.optcr1 & 0xffff)
      half(24, (this.optcr1 >>> 16) & 0xffff)
    }
  }

  // --- the operations ---------------------------------------------------------------------

  private finish(flags: number) {
    this.regs[0x0c >>> 2] |= flags
    const cr = this.regs[0x10 >>> 2]
    if ((flags & SR_EOP && cr & CR_EOPIE) || (flags & SR_ERRORS && cr & CR_ERRIE)) this.raiseIrq(4)
  }

  /** A store into flash (from the bus): programs the word when the sequence is right. */
  programWrite(addr: number, value: number, size: 1 | 2 | 4) {
    const cr = this.regs[0x10 >>> 2]
    if (cr & CR_LOCK || !(cr & CR_PG)) {
      this.finish(SR_PGSERR)
      return
    }
    const psize = 1 << ((cr >>> 8) & 3)
    if (psize !== size) {
      this.finish(SR_PGPERR)
      return
    }
    const sector = this.sectorOf(addr)
    const at = this.bus?.bytesAt(addr)
    if (!sector || !at) {
      this.finish(SR_PGAERR)
      return
    }
    if (this.writeProtected(sector)) {
      this.finish(SR_WRPERR)
      return
    }
    // Programming can only clear bits.
    for (let i = 0; i < size; i++) at.bytes[at.offset + i] &= (value >>> (8 * i)) & 0xff
    this.bus!.flashDirty = true
    this.onBusy(T_PROGRAM)
    this.finish(SR_EOP)
  }

  /** STRT with SER (one sector) or MER/MER1 (a bank). */
  private erase(cr: number) {
    let targets: FlashSector[] = []
    if (cr & CR_SER) {
      const snb = (cr >>> 3) & 0x1f
      const s = this.sectors.find((x) => x.snb === snb)
      if (!s) {
        this.finish(SR_PGSERR)
        return
      }
      targets = [s]
    }
    if (cr & CR_MER) targets.push(...this.sectors.filter((s) => s.bank === 0))
    if (this.map === "v1" && cr & CR_MER1) targets.push(...this.sectors.filter((s) => s.bank === 1))
    if (!targets.length) {
      this.finish(SR_PGSERR)
      return
    }
    if (targets.some((s) => this.writeProtected(s))) {
      this.finish(SR_WRPERR)
      return
    }
    for (const s of targets) {
      const at = this.bus?.bytesAt(this.flashBase + s.start)
      if (at) at.bytes.fill(0xff, at.offset, at.offset + s.size)
    }
    this.bus!.flashDirty = true
    this.onBusy(targets.length === 1 ? eraseTime(targets[0].size) : T_MASS_ERASE)
    this.finish(SR_EOP)
  }
}
