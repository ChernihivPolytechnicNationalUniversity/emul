/**
 * RTC (RM0090 §26, RM0385 §29 — the same "RTC v2"): BCD calendar with the async/sync
 * prescalers, initialization mode behind the write-protection keys, shadow-register sync
 * flag, subseconds, alarms A and B with their masks, the wake-up timer, the 20 backup
 * registers, daylight-saving ±1 h, 12/24 h format. Alarm and wake-up flags also pulse EXTI
 * lines 17 and 22, as the interrupts need.
 *
 * The clock comes from RCC's BDCR: LSE (32768 Hz), LSI (32 kHz) or HSE/RTCPRE; the calendar
 * runs only with RTCEN set. The backup domain — these registers and BDCR — survives system
 * resets and goes only on power-on.
 *
 * Not modelled (reported through `onUnsupported`): timestamp and tamper, calibration
 * (CALIBR/CALR, the calibration output), the reference clock input, the alarm output pin.
 */
import type { Clocked } from "./clocked"
import { RegBlock, type RegDef } from "./regblock"

const REGS: RegDef[] = [
  { name: "TR", offset: 0x00, rw: 0x007f7f7f },
  { name: "DR", offset: 0x04, reset: 0x2101, rw: 0x00ffff3f },
  { name: "CR", offset: 0x08, rw: 0x00ffffff },
  { name: "ISR", offset: 0x0c, reset: 0x7, rw: 0x0000ff9f },
  { name: "PRER", offset: 0x10, reset: 0x007f00ff, rw: 0x007f7fff },
  { name: "WUTR", offset: 0x14, reset: 0xffff, rw: 0xffff },
  { name: "CALIBR", offset: 0x18, rw: 0x9f },
  { name: "ALRMAR", offset: 0x1c },
  { name: "ALRMBR", offset: 0x20 },
  { name: "WPR", offset: 0x24, rw: 0xff },
  { name: "SSR", offset: 0x28, rw: 0 },
  { name: "SHIFTR", offset: 0x2c, rw: 0 },
  { name: "TSTR", offset: 0x30, rw: 0 },
  { name: "TSDR", offset: 0x34, rw: 0 },
  { name: "TSSSR", offset: 0x38, rw: 0 },
  { name: "CALR", offset: 0x3c, rw: 0xffff },
  { name: "TAFCR", offset: 0x40, rw: 0x00fcffff },
  { name: "ALRMASSR", offset: 0x44, rw: 0x0f007fff },
  { name: "ALRMBSSR", offset: 0x48, rw: 0x0f007fff },
  ...Array.from({ length: 20 }, (_, i) => ({ name: `BKP${i}R`, offset: 0x50 + i * 4 })),
]

const ISR_ALRAWF = 1 << 0
const ISR_ALRBWF = 1 << 1
const ISR_WUTWF = 1 << 2
const ISR_INITS = 1 << 4
const ISR_RSF = 1 << 5
const ISR_INITF = 1 << 6
const ISR_INIT = 1 << 7
const ISR_ALRAF = 1 << 8
const ISR_ALRBF = 1 << 9
const ISR_WUTF = 1 << 10
const CR_FMT = 1 << 6
const CR_ALRAE = 1 << 8
const CR_ALRBE = 1 << 9
const CR_WUTE = 1 << 10
const CR_TSE = 1 << 11
const CR_ALRAIE = 1 << 12
const CR_ALRBIE = 1 << 13
const CR_WUTIE = 1 << 14
const CR_ADD1H = 1 << 16
const CR_SUB1H = 1 << 17
const CR_COE = 1 << 23

const bcd = (n: number) => ((Math.floor(n / 10) & 0xf) << 4) | n % 10
const unbcd = (b: number) => ((b >>> 4) & 0xf) * 10 + (b & 0xf)
const daysInMonth = (y: number, m: number) => [31, y % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]

export class Rtc extends RegBlock implements Clocked {
  /** Calendar as numbers (the registers are BCD views of it). Years count from 2000. */
  private sec = 0
  private min = 0
  private hour = 0
  private day = 1
  private month = 1
  private year = 0
  private weekday = 1
  /** Subsecond position inside the current second, in synchronous prescaler ticks. */
  private subTicks = 0
  private wutCount = 0
  /** Core cycles per RTC clock and phase accumulator (RTCCLK ticks are fractional in core cycles). */
  private hclkHz = 16e6
  private rtcHz = 32768
  private acc = 0
  private active = false
  /** Write-protection key sequence: 0 locked, 1 after 0xCA, 2 unlocked. */
  private key = 0
  private rsfArmed = false
  /** Set before a reset that should keep the backup domain (system reset) or clear it (power-on). */
  powerOn = true

  onActive: (on: boolean) => void = () => {}
  sync: () => void = () => {}
  reschedule: () => void = () => {}
  raiseIrq: (irq: number) => void = () => {}
  /** An EXTI line pulse (17 alarm, 22 wake-up). */
  onExti: (line: number) => void = () => {}
  onUnsupported: (what: string) => void = () => {}
  /** Whether RCC has the RTC clocked, and at what rate (Hz); 0 when off. */
  clockHz: () => number = () => 0

  constructor() {
    super("RTC", 0x40002800, 0x400, REGS)
  }

  setClock(hclkHz: number) {
    this.hclkHz = hclkHz
  }

  reset() {
    if (this.subTicks === undefined) {
      super.reset()
      return
    }
    if (!this.powerOn) {
      // System reset: the backup domain keeps everything; only the key sequence restarts.
      this.key = 0
      return
    }
    super.reset()
    this.sec = this.min = this.hour = 0
    this.day = this.month = 1
    this.year = 0
    this.weekday = 1
    this.subTicks = 0
    this.wutCount = 0
    this.acc = 0
    this.key = 0
    this.rsfArmed = false
    this.setActive(false)
  }

  // --- configuration ------------------------------------------------------------------------

  private cr() {
    return this.regs[2]
  }
  private isr() {
    return this.regs[3]
  }
  private predivA() {
    return ((this.regs[4] >>> 16) & 0x7f) + 1
  }
  private predivS() {
    return (this.regs[4] & 0x7fff) + 1
  }
  private inInit() {
    return (this.isr() & ISR_INIT) !== 0
  }
  /** The calendar counts when clocked, enabled and not in initialization. */
  private counting() {
    return this.rtcHz > 0 && !this.inInit()
  }
  /** RTC clocks per second and per wake-up tick (WUCKSEL). */
  private wutDivider(): number {
    const sel = this.cr() & 7
    if (sel < 4) return 16 >> sel // RTCCLK / 16, 8, 4, 2
    return this.predivA() * this.predivS() // ck_spre (1 Hz)
  }

  /** RCC changed the RTC clock: refresh our rate. */
  refreshClock() {
    const hz = this.clockHz()
    if (hz !== this.rtcHz) {
      this.rtcHz = hz
      this.updateActive()
    }
  }

  // --- register file ------------------------------------------------------------------------

  read(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    // The shadow registers are in sync whenever the calendar runs; after software clears RSF
    // (to force a resync) the flag comes back on the next read, one clock later in effect.
    if (this.rsfArmed) this.rsfArmed = false
    else if (this.counting()) this.regs[3] |= ISR_RSF
    return super.read(offset, size)
  }
  write(offset: number, value: number, size: 1 | 2 | 4): void {
    this.sync()
    super.write(offset, value, size)
    this.reschedule()
  }

  private unlocked() {
    return this.key === 2
  }

  protected onRead(d: RegDef, current: number): number {
    switch (d.name) {
      case "TR":
        return this.timeBcd()
      case "DR":
        return this.dateBcd()
      case "SSR":
        return Math.max(0, this.predivS() - 1 - this.subTicks)
      case "ISR":
        return (current & ~(ISR_INITS | ISR_ALRAWF | ISR_ALRBWF | ISR_WUTWF)) | (this.year || this.month > 1 || this.day > 1 ? ISR_INITS : 0) | (this.cr() & CR_ALRAE ? 0 : ISR_ALRAWF) | (this.cr() & CR_ALRBE ? 0 : ISR_ALRBWF) | (this.cr() & CR_WUTE ? 0 : ISR_WUTWF)
      default:
        return current
    }
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    if (d.name === "WPR") {
      const k = written & 0xff
      this.key = k === 0xca ? 1 : k === 0x53 && this.key === 1 ? 2 : 0
      return 0
    }
    if (d.name.startsWith("BKP") || d.name === "TAFCR") return
    if (d.name === "ISR") {
      // INIT is writable always; the flags are write-zero-to-clear; the rest is read-only.
      let v = old
      if (written & ISR_INIT) v |= ISR_INIT | ISR_INITF
      else if (old & ISR_INIT) v &= ~(ISR_INIT | ISR_INITF)
      if (!(written & ISR_RSF) && old & ISR_RSF) {
        v &= ~ISR_RSF
        this.rsfArmed = true
      }
      v &= ~(~written & (ISR_ALRAF | ISR_ALRBF | ISR_WUTF | (0xf << 11)))
      this.regs[3] = v >>> 0
      this.updateActive()
      return v >>> 0
    }
    if (!this.unlocked()) return old
    switch (d.name) {
      case "TR":
        if (!this.inInit()) return old
        this.setTimeBcd(next)
        return old
      case "DR":
        if (!this.inInit()) return old
        this.setDateBcd(next)
        return old
      case "PRER":
        return this.inInit() ? next : old
      case "CR": {
        if (next & CR_TSE && !(old & CR_TSE)) this.onUnsupported("RTC timestamp")
        if (next & CR_COE && !(old & CR_COE)) this.onUnsupported("RTC calibration output")
        if (next & CR_ADD1H) this.addHours(1)
        if (next & CR_SUB1H) this.addHours(-1)
        const v = (next & ~(CR_ADD1H | CR_SUB1H)) >>> 0
        if (v & CR_WUTE && !(old & CR_WUTE)) this.wutCount = this.regs[5] & 0xffff
        this.regs[2] = v
        this.updateActive()
        return v
      }
      case "WUTR":
        return this.cr() & CR_WUTE ? old : next
      case "ALRMAR":
      case "ALRMASSR":
        return this.cr() & CR_ALRAE ? old : next
      case "ALRMBR":
      case "ALRMBSSR":
        return this.cr() & CR_ALRBE ? old : next
      case "CALIBR":
      case "CALR":
        if (next !== old) this.onUnsupported("RTC calibration")
        return
      case "SHIFTR":
        this.onUnsupported("RTC shift")
        return 0
    }
  }

  // --- calendar ---------------------------------------------------------------------------------

  private timeBcd() {
    const fmt12 = (this.cr() & CR_FMT) !== 0
    let h = this.hour
    let pm = 0
    if (fmt12) {
      pm = h >= 12 ? 1 : 0
      h = h % 12 === 0 ? 12 : h % 12
    }
    return (pm << 22) | (bcd(h) << 16) | (bcd(this.min) << 8) | bcd(this.sec)
  }
  private dateBcd() {
    return (bcd(this.year) << 16) | (this.weekday << 13) | (bcd(this.month) << 8) | bcd(this.day)
  }
  private setTimeBcd(v: number) {
    this.sec = Math.min(59, unbcd(v & 0x7f))
    this.min = Math.min(59, unbcd((v >>> 8) & 0x7f))
    let h = unbcd((v >>> 16) & 0x3f)
    if (this.cr() & CR_FMT) h = (h % 12) + (v & (1 << 22) ? 12 : 0)
    this.hour = Math.min(23, h)
    this.subTicks = 0
  }
  private setDateBcd(v: number) {
    this.day = Math.max(1, unbcd(v & 0x3f))
    this.month = Math.max(1, Math.min(12, unbcd((v >>> 8) & 0x1f)))
    this.weekday = Math.max(1, (v >>> 13) & 7)
    this.year = unbcd((v >>> 16) & 0xff)
  }
  private addHours(n: number) {
    this.hour = (this.hour + n + 24) % 24
  }

  /** One second passed. */
  private tickSecond() {
    if (++this.sec < 60) return this.checkAlarms()
    this.sec = 0
    if (++this.min < 60) return this.checkAlarms()
    this.min = 0
    if (++this.hour < 24) return this.checkAlarms()
    this.hour = 0
    this.weekday = (this.weekday % 7) + 1
    if (++this.day <= daysInMonth(this.year, this.month)) return this.checkAlarms()
    this.day = 1
    if (++this.month <= 12) return this.checkAlarms()
    this.month = 1
    this.year = (this.year + 1) % 100
    this.checkAlarms()
  }

  /** Alarm A/B compare on every second: fields not masked must match. */
  private checkAlarms() {
    const cr = this.cr()
    if (cr & CR_ALRAE && this.alarmMatches(this.regs[0x1c >>> 2])) this.flag(ISR_ALRAF, CR_ALRAIE, 17)
    if (cr & CR_ALRBE && this.alarmMatches(this.regs[0x20 >>> 2])) this.flag(ISR_ALRBF, CR_ALRBIE, 17)
  }
  private alarmMatches(a: number) {
    if (!(a & (1 << 7)) && unbcd(a & 0x7f) !== this.sec) return false
    if (!(a & (1 << 15)) && unbcd((a >>> 8) & 0x7f) !== this.min) return false
    if (!(a & (1 << 23))) {
      let h = unbcd((a >>> 16) & 0x3f)
      if (this.cr() & CR_FMT) h = (h % 12) + (a & (1 << 22) ? 12 : 0)
      if (h !== this.hour) return false
    }
    if (!(a & (1 << 31))) {
      const v = (a >>> 24) & 0x3f
      if (a & (1 << 30)) {
        if (v !== this.weekday) return false
      } else if (unbcd(v) !== this.day) return false
    }
    return true
  }

  private flag(bit: number, enable: number, line: number) {
    this.regs[3] |= bit
    if (this.cr() & enable) this.onExti(line)
  }

  // --- clocking -------------------------------------------------------------------------------

  private updateActive() {
    this.setActive(this.rtcHz > 0 && (!this.inInit() || (this.cr() & CR_WUTE) !== 0))
  }
  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    this.onActive(on)
  }

  tick(cycles: number) {
    if (this.rtcHz <= 0) return
    // RTC clocks elapsed, kept as a fraction in core cycles.
    this.acc += cycles * this.rtcHz
    const clocks = Math.floor(this.acc / this.hclkHz)
    if (clocks <= 0) return
    this.acc -= clocks * this.hclkHz
    const cr = this.cr()
    // Wake-up timer, in its own units.
    if (cr & CR_WUTE) {
      const div = this.wutDivider()
      this.wutClocks += clocks
      while (this.wutClocks >= div) {
        this.wutClocks -= div
        if (this.wutCount === 0) {
          this.wutCount = this.regs[5] & 0xffff
          this.flag(ISR_WUTF, CR_WUTIE, 22)
        } else this.wutCount--
      }
    }
    if (this.counting()) {
      // Calendar: PREDIV_A × PREDIV_S clocks per second; the subsecond counter runs at ck_apre.
      this.calClocks += clocks
      const a = this.predivA()
      while (this.calClocks >= a) {
        this.calClocks -= a
        if (++this.subTicks >= this.predivS()) {
          this.subTicks = 0
          this.tickSecond()
        }
      }
    }
  }
  private wutClocks = 0
  private calClocks = 0

  /** Advance by a stretch of wall time with no core cycles behind it (VDD off, VBAT on). */
  tickSeconds(seconds: number) {
    if (this.rtcHz <= 0 || this.hclkHz <= 0) return
    this.tick(seconds * this.hclkHz)
  }

  cyclesUntilEvent(): number {
    if (this.rtcHz <= 0) return Infinity
    // Next subsecond tick (ck_apre) is the finest event; a second is PREDIV_S of them.
    const a = this.predivA()
    const wut = this.cr() & CR_WUTE ? this.wutDivider() - this.wutClocks : Infinity
    const cal = this.counting() ? a - this.calClocks : Infinity
    const clocks = Math.max(1, Math.min(wut, cal))
    return Math.max(1, Math.ceil((clocks * this.hclkHz - this.acc) / this.rtcHz))
  }
}
