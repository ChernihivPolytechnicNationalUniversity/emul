/**
 * The ATmega328P's housekeeping blocks: the watchdog (DS40002061B §11.8), the EEPROM (§8.4)
 * and self-programming of the flash (§27). The watchdog and the EEPROM/flash write timers run
 * from their own oscillators (128 kHz, the calibrated RC), so their times are kept in seconds
 * and turned into core cycles at the clock in force.
 */
import { Peripheral, type AvrBus } from "../io"
import type { AvrMcu } from "../mcu"

const WDT_HZ = 128e3

/** Watchdog timer: modes of Table 11-1, time-outs of Table 11-2, the WDCE timed sequence and WDRF/WDTON overrides. */
export class Watchdog extends Peripheral {
  readonly name = "WDT"
  override readonly domain = "wdt" as const
  private readonly mcu: AvrMcu
  wdtcsr = 0
  private wdif = false
  private wdceUntil = -1
  /** Time (s) the count started from (reset, WDR, enable). */
  private start = 0

  constructor(bus: AvrBus, mcu: AvrMcu, vector: number) {
    super(bus)
    this.mcu = mcu
    bus.register(0x60, { name: "WDTCSR", read: () => this.read(), write: (v) => this.write(v) })
    bus.irq.add({
      vector,
      pending: () => this.wdif && (this.wdtcsr & 0x40) !== 0,
      acknowledge: () => {
        this.wdif = false
        // Interrupt and system reset mode: the vector drops WDIE, so the next time-out resets.
        if (this.wde) this.wdtcsr &= ~0x40
      },
    })
    mcu.watchdog = { restart: () => this.restart() }
  }

  private get wdton() {
    return (this.mcu.fuses.high & 0x10) === 0
  }
  /** WDE as it acts: forced on by WDTON and by WDRF in MCUSR (§11.9.2). */
  private get wde() {
    return this.wdton || (this.wdtcsr & 0x08) !== 0 || (this.mcu.mcusrValue & 0x08) !== 0
  }
  private get wdie() {
    return !this.wdton && (this.wdtcsr & 0x40) !== 0
  }
  private get running() {
    return this.wde || this.wdie
  }
  /** The watchdog counts (for the supply current). */
  get on() {
    return this.running
  }
  private get timeout() {
    const wdp = (this.wdtcsr & 7) | ((this.wdtcsr >> 2) & 8)
    return (2048 << Math.min(wdp, 9)) / WDT_HZ
  }

  private read() {
    let v = this.wdtcsr & 0x67
    if (this.wde) v |= 0x08
    if (this.wdif) v |= 0x80
    if (this.wdton) v &= ~0x40
    if (this.bus.cpu.at < this.wdceUntil) v |= 0x10
    return v
  }

  /**
   * WDIF clears by writing one; WDIE is free (unless WDTON); WDE can always be set, but clearing it
   * and changing WDP need the timed sequence: WDCE and WDE written one together, then within four
   * cycles the new WDE/WDP with WDCE zero (§11.8.2, §11.9.2).
   */
  private write(v: number) {
    const at = this.bus.cpu.at
    const was = this.running
    if (v & 0x80) this.wdif = false
    if (!this.wdton) this.wdtcsr = (this.wdtcsr & ~0x40) | (v & 0x40)
    const open = at < this.wdceUntil
    if ((v & 0x18) === 0x18 && !open) {
      this.wdceUntil = at + 4
      this.wdtcsr |= 0x08
    } else if (open && !(v & 0x10)) {
      this.wdtcsr = (this.wdtcsr & 0x40) | (v & 0x2f)
      this.wdceUntil = -1
    } else if (v & 0x08) this.wdtcsr |= 0x08
    if (this.running && !was) this.start = this.mcu.now
    this.plan()
  }

  restart() {
    this.start = this.mcu.now
    this.plan()
  }

  reset() {
    // WDP and WDIE reset to zero; WDE follows WDRF (and WDTON) through `wde`.
    this.wdtcsr = 0
    this.wdif = false
    this.wdceUntil = -1
    this.start = this.mcu.time
    this.plan()
  }

  private plan() {
    this.due = this.running ? Math.ceil(this.mcu.timeCycle(this.start + this.timeout)) : Infinity
    this.bus.reschedule()
  }
  override clockChanged() {
    this.plan()
  }
  override service(cycle: number) {
    if (!this.running || cycle < this.due) return this.plan()
    // Time-out: interrupt mode first (if WDIE), else the system reset (Table 11-1).
    if (this.wdie) {
      this.wdif = true
      this.bus.irq.update()
      this.start = this.mcu.cycleTime(cycle)
      this.plan()
      return
    }
    this.mcu.requestReset("watchdog")
    this.due = Infinity
  }
}

/** Calibrated RC oscillator cycles of an EEPROM write (Table 8-2); erase-only and write-only take 1.8 ms (Table 8-1). */
const EEPROM_WRITE = 26368 / 8e6
const EEPROM_HALF = 1.8e-3

/** EEPROM with the EEMPE/EEPE sequence, the three programming modes and the CPU halts of §8.4.1. */
export class Eeprom extends Peripheral {
  readonly name = "EEPROM"
  override readonly domain = "none" as const
  private readonly mcu: AvrMcu
  private eear = 0
  private eedr = 0
  private eecr = 0
  private eempeUntil = -1
  /** Write in progress: when it ends (s) and what it does. */
  private writing: { end: number; addr: number; data: number; mode: number } | null = null
  /** Writes per byte, against the 100 000-cycle endurance (§8.4). */
  readonly wear: Uint32Array

  constructor(bus: AvrBus, mcu: AvrMcu, vector: number) {
    super(bus)
    this.mcu = mcu
    this.wear = new Uint32Array(mcu.eeprom.length)
    const mask = mcu.eeprom.length - 1
    bus.register(0x41, { name: "EEARL", read: () => this.eear & 0xff, write: (v) => !this.writing && (this.eear = ((this.eear & 0xff00) | v) & mask) })
    bus.register(0x42, { name: "EEARH", read: () => this.eear >> 8, write: (v) => !this.writing && (this.eear = ((v << 8) | (this.eear & 0xff)) & mask) })
    bus.register(0x40, { name: "EEDR", read: () => this.eedr, write: (v) => (this.eedr = v) })
    bus.register(0x3f, { name: "EECR", read: () => this.read(), write: (v, m) => this.write(v, m) })
    bus.irq.add({ vector, pending: () => (this.eecr & 0x08) !== 0 && !this.writing })
  }

  private read() {
    this.finish()
    return (this.eecr & 0x38) | (this.bus.cpu.at < this.eempeUntil ? 0x04 : 0) | (this.writing ? 0x02 : 0)
  }
  private write(v: number, m: number) {
    this.finish()
    const at = this.bus.cpu.at
    v = (this.eecr & ~m) | (v & m)
    // EEPMn are ignored while a write is in progress.
    const pm = this.writing ? this.eecr & 0x30 : v & 0x30
    this.eecr = pm | (v & 0x08)
    if (m & 0x04 && v & 0x04 && !(v & 0x02)) this.eempeUntil = at + 4
    if (m & 0x02 && v & 0x02 && at < this.eempeUntil && !this.writing && !this.mcu.selfProgramming) {
      const mode = (pm >> 4) & 3
      if (mode !== 3) {
        this.writing = { end: this.mcu.cycleTime(at) + (mode === 0 ? EEPROM_WRITE : EEPROM_HALF), addr: this.eear, data: this.eedr, mode }
        this.eempeUntil = -1
        this.bus.cpu.cycles += 2
        this.plan()
      }
    }
    if (m & 0x01 && v & 0x01 && !this.writing) {
      this.eedr = this.mcu.eeprom[this.eear]
      this.bus.cpu.cycles += 4
    }
    this.bus.irq.update()
  }

  private finish() {
    const w = this.writing
    if (!w || this.mcu.now < w.end) return
    const old = this.mcu.eeprom[w.addr]
    // Atomic: erase and write; erase only: 0xFF; write only: programming can only clear bits.
    this.mcu.eeprom[w.addr] = w.mode === 0 ? w.data : w.mode === 1 ? 0xff : old & w.data
    this.wear[w.addr]++
    this.writing = null
    this.bus.irq.update()
  }
  get busy() {
    return this.writing !== null
  }

  reset() {
    // A write in progress completes through a reset (§8.4.2); EEPMn keep their value then.
    this.eecr = this.writing ? this.eecr & 0x30 : 0
    this.eempeUntil = -1
  }
  private plan() {
    this.due = this.writing ? Math.ceil(this.mcu.timeCycle(this.writing.end)) : Infinity
    this.bus.reschedule()
  }
  override clockChanged() {
    this.plan()
  }
  override service() {
    this.finish()
    this.plan()
  }
}

/** Page erase/write time: Table 27-6 gives 3.7–4.5 ms; the middle is used. */
const SPM_TIME = 4.1e-3

/**
 * Self-programming (§27): SPM with SPMCSR selecting page buffer fill, page erase, page write,
 * RWW re-enable, and the signature/fuse reads (those through LPM, in the SoC). SPM is only
 * honoured from the boot loader section; SPMEN clears after four cycles if no SPM follows.
 */
export class SelfProgramming extends Peripheral {
  readonly name = "SPM"
  override readonly domain = "none" as const
  private readonly mcu: AvrMcu
  private readonly buffer: Uint16Array
  private busyUntil = 0
  /** Total time spent erasing and writing pages, s (for tests and the inspector). */
  busyTime = 0
  private rwwBusy = false

  constructor(bus: AvrBus, mcu: AvrMcu) {
    super(bus)
    this.mcu = mcu
    this.buffer = new Uint16Array(mcu.chip.pageWords).fill(0xffff)
    mcu.selfProgram = (z, r1r0) => this.spm(z, r1r0)
  }

  get busy() {
    return this.mcu.now < this.busyUntil
  }

  private spm(z: number, word: number): number {
    const cpu = this.bus.cpu
    const spmcsr = this.mcu.spmcsrValue
    // Only from the boot loader section (§27.3): elsewhere SPM does nothing.
    if (cpu.opPc < this.mcu.bootStart || !(spmcsr & 0x01)) return 0
    const page = (z >> 1) & ~(this.mcu.chip.pageWords - 1)
    const op = spmcsr & 0x1e
    if (op === 0) {
      this.buffer[(z >> 1) & (this.mcu.chip.pageWords - 1)] = word
      this.mcu.spmDone()
      return 0
    }
    if (op === 0x10) {
      // RWWSRE: the RWW section readable again once programming is over.
      if (!this.busy) this.rwwBusy = false
      this.mcu.spmDone(!this.rwwBusy)
      return 0
    }
    if (op === 0x02 || op === 0x04) {
      const start = page & cpu.pcMask
      if (op === 0x02) cpu.flash.fill(0xffff, start, start + this.buffer.length)
      else {
        for (let i = 0; i < this.buffer.length; i++) cpu.flash[start + i] &= this.buffer[i]
        this.buffer.fill(0xffff)
      }
      cpu.invalidate(start, this.buffer.length)
      this.busyTime += SPM_TIME
      this.busyUntil = this.mcu.now + SPM_TIME
      this.rwwBusy = start < this.mcu.bootStart
      this.mcu.spmStarted(this.busyUntil, this.rwwBusy)
      // Programming the NRWW (boot) section halts the CPU until done (§27.2.1).
      if (!this.rwwBusy) return Math.ceil(SPM_TIME * this.mcu.hz)
      return 0
    }
    this.mcu.feature(`SPM: SPMCSR operation 0x${spmcsr.toString(16)} (lock bits)`)
    this.mcu.spmDone()
    return 0
  }
  get rww() {
    return this.rwwBusy
  }
  reset() {
    this.buffer.fill(0xffff)
  }
}
