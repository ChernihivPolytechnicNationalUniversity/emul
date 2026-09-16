/**
 * RCC — reset and clock control (RM0090 §7). The internal oscillators and the PLLs lock
 * instantly: their ready flags follow the enable bits, and the system clock switch takes
 * effect at once. HSE and LSE depend on what the circuit puts on OSC_IN/OSC_OUT: a crystal
 * (ready after its start-up time) or, in bypass, an external clock; nothing there and the
 * ready flag never comes, which is what firmware waiting on HSE sees on a board without a
 * crystal. The clock tree is evaluated from the registers so SysTick, timers and the UARTs
 * see the right rates.
 */
import { RegBlock, type RegDef } from "./regblock"

export const RCC_BASE = 0x40023800

export const HSI_HZ = 16_000_000
export const LSI_HZ = 32_000

/**
 * What sits on the oscillator pins: a crystal (needs the on-chip amplifier, so no bypass)
 * that oscillates `startup` seconds after being enabled, an external clock (bypass only), or
 * — for a core run without a circuit — "any": whichever the firmware asks for, at once.
 */
export type ClockSource = { hz: number; kind: "crystal" | "clock" | "any"; startup: number }

/** The bench: 8 MHz and 32.768 kHz at hand in either mode, as tests without a board want. */
export const BENCH_HSE: ClockSource = { hz: 8_000_000, kind: "any", startup: 0 }
export const BENCH_LSE: ClockSource = { hz: 32_768, kind: "any", startup: 0 }

const CR_HSION = 1 << 0
const CR_HSIRDY = 1 << 1
const CR_HSEON = 1 << 16
const CR_HSERDY = 1 << 17
const CR_HSEBYP = 1 << 18
const BDCR_LSEON = 1 << 0
const BDCR_LSERDY = 1 << 1
const BDCR_LSEBYP = 1 << 2
const CR_PLLON = 1 << 24
const CR_PLLRDY = 1 << 25
const CR_PLLI2SON = 1 << 26
const CR_PLLI2SRDY = 1 << 27
const CR_PLLSAION = 1 << 28
const CR_PLLSAIRDY = 1 << 29

const REGS: RegDef[] = [
  { name: "CR", offset: 0x00, reset: 0x00000083, rw: 0x150dff01 },
  { name: "PLLCFGR", offset: 0x04, reset: 0x24003010, rw: 0x0f437fff },
  { name: "CFGR", offset: 0x08, reset: 0, rw: 0xffffffff & ~0xc },
  { name: "CIR", offset: 0x0c, reset: 0 },
  { name: "AHB1RSTR", offset: 0x10 },
  { name: "AHB2RSTR", offset: 0x14 },
  { name: "AHB3RSTR", offset: 0x18 },
  { name: "APB1RSTR", offset: 0x20 },
  { name: "APB2RSTR", offset: 0x24 },
  { name: "AHB1ENR", offset: 0x30, reset: 0x00100000 },
  { name: "AHB2ENR", offset: 0x34 },
  { name: "AHB3ENR", offset: 0x38 },
  { name: "APB1ENR", offset: 0x40 },
  { name: "APB2ENR", offset: 0x44 },
  { name: "AHB1LPENR", offset: 0x50, reset: 0x7e6791ff },
  { name: "AHB2LPENR", offset: 0x54, reset: 0x000000f1 },
  { name: "AHB3LPENR", offset: 0x58, reset: 0x00000001 },
  { name: "APB1LPENR", offset: 0x60, reset: 0xf6fec9ff },
  { name: "APB2LPENR", offset: 0x64, reset: 0x04777f33 },
  { name: "BDCR", offset: 0x70 },
  { name: "CSR", offset: 0x74, reset: 0x0e000000, rw: 0x01000001 },
  { name: "SSCGR", offset: 0x80 },
  { name: "PLLI2SCFGR", offset: 0x84, reset: 0x24003000 },
  { name: "PLLSAICFGR", offset: 0x88, reset: 0x24003000 },
  { name: "DCKCFGR", offset: 0x8c },
]

export type ClockTree = {
  sysclk: number
  hclk: number
  pclk1: number
  pclk2: number
  /** Timer kernel clocks (×2 when the APB prescaler is not 1, RM0090 §7.2). */
  timclk1: number
  timclk2: number
  source: "HSI" | "HSE" | "PLL"
}

export class Rcc extends RegBlock {
  /** Bumped whenever something that changes clock rates is written. */
  version = 0
  /** Fired when the clock tree may have changed (the SoC ends its run slice to re-time). */
  onChange: (() => void) | null = null

  constructor() {
    super("RCC", RCC_BASE, 0x400, REGS)
  }

  /** Set before a reset: a power-on clears the backup domain (BDCR), a system reset keeps it. */
  powerOn = true

  /** The oscillator pins as the circuit populates them (null: nothing there). */
  hse: ClockSource | null = BENCH_HSE
  lse: ClockSource | null = BENCH_LSE
  /** Core time in seconds, for the oscillator start-up delays. */
  now: () => number = () => 0
  /** When HSEON / LSEON were last set, for the start-up delay. */
  private hseOnAt = 0
  private lseOnAt = 0

  reset() {
    const bdcr = this.regs ? this.regs[0x70 >>> 2] : 0
    super.reset()
    if (!this.powerOn) this.regs[0x70 >>> 2] = bdcr
    // Core time restarts at zero: an LSE that was oscillating keeps going through a system
    // reset; HSE is switched off by every reset and starts over when firmware enables it.
    this.hseOnAt = 0
    this.lseOnAt = !this.powerOn && bdcr & BDCR_LSERDY ? -Infinity : 0
    this.version++
  }

  /** The HSE source the CR mode can use: a crystal without bypass, a clock with it. */
  private hseSource(cr = this.regs[0]): ClockSource | null {
    const s = this.hse
    if (!s) return null
    return s.kind === "any" || (cr & CR_HSEBYP ? s.kind === "clock" : s.kind === "crystal") ? s : null
  }
  private lseSource(bdcr = this.regs[0x70 >>> 2]): ClockSource | null {
    const s = this.lse
    if (!s) return null
    return s.kind === "any" || (bdcr & BDCR_LSEBYP ? s.kind === "clock" : s.kind === "crystal") ? s : null
  }
  /** HSE frequency as the clock tree sees it: 0 until it is on and ready. */
  hseHz(): number {
    return this.refreshHse() & CR_HSERDY ? this.hse!.hz : 0
  }
  lseHz(): number {
    return this.refreshLse() & BDCR_LSERDY ? this.lse!.hz : 0
  }
  /** Bring HSERDY up to date with the source and the start-up delay; returns CR. */
  private refreshHse(): number {
    const cr = this.regs[0]
    const src = this.hseSource(cr)
    const ready = (cr & CR_HSEON) !== 0 && src !== null && this.now() >= this.hseOnAt + src.startup
    const v = ready ? cr | CR_HSERDY : cr & ~CR_HSERDY
    if (v !== cr) {
      this.regs[0] = v >>> 0
      this.bump()
    }
    return this.regs[0]
  }
  private refreshLse(): number {
    const i = 0x70 >>> 2
    const bdcr = this.regs[i]
    const src = this.lseSource(bdcr)
    const ready = (bdcr & BDCR_LSEON) !== 0 && src !== null && this.now() >= this.lseOnAt + src.startup
    const v = ready ? bdcr | BDCR_LSERDY : bdcr & ~BDCR_LSERDY
    if (v !== bdcr) {
      this.regs[i] = v >>> 0
      this.bump()
    }
    return this.regs[i]
  }
  /** Why HSE is not ready while firmware has it on: for the inspector. Null when it is fine. */
  hseProblem(): string | null {
    const cr = this.regs[0]
    if (!(cr & CR_HSEON) || this.refreshHse() & CR_HSERDY) return null
    const s = this.hse
    if (!s) return cr & CR_HSEBYP ? "HSE bypass on: no external clock on OSC_IN" : "HSE on: no crystal on OSC_IN/OSC_OUT"
    if (cr & CR_HSEBYP && s.kind === "crystal") return "HSE bypass on, but OSC_IN/OSC_OUT carry a crystal"
    if (!(cr & CR_HSEBYP) && s.kind === "clock") return "HSE in crystal mode, but OSC_IN carries an external clock (needs HSEBYP)"
    return null
  }
  lseProblem(): string | null {
    const bdcr = this.regs[0x70 >>> 2]
    if (!(bdcr & BDCR_LSEON) || this.refreshLse() & BDCR_LSERDY) return null
    const s = this.lse
    if (!s) return bdcr & BDCR_LSEBYP ? "LSE bypass on: no external clock on OSC32_IN" : "LSE on: no crystal on OSC32_IN/OSC32_OUT"
    if (bdcr & BDCR_LSEBYP && s.kind === "crystal") return "LSE bypass on, but OSC32_IN/OSC32_OUT carry a crystal"
    if (!(bdcr & BDCR_LSEBYP) && s.kind === "clock") return "LSE in crystal mode, but OSC32_IN carries an external clock (needs LSEBYP)"
    return null
  }

  /** The RTC clock in Hz per BDCR (RTCEN, RTCSEL) and CFGR.RTCPRE; 0 when off. */
  rtcHz(): number {
    const bdcr = this.regs[0x70 >>> 2]
    if (!(bdcr & (1 << 15))) return 0
    switch ((bdcr >>> 8) & 3) {
      case 1:
        return this.lseHz()
      case 2:
        return this.regs[0x74 >>> 2] & 1 ? LSI_HZ : 0
      case 3: {
        const pre = (this.regs[2] >>> 16) & 0x1f
        return pre >= 2 ? this.hseHz() / pre : 0
      }
      default:
        return 0
    }
  }
  private bump() {
    this.version++
    this.onChange?.()
  }

  /**
   * Entering Stop or Standby (RM0090 §6.3.1, §6.3.3): HSE and the PLLs are switched off by
   * hardware and HSI becomes the system clock, which is what the core wakes up on.
   */
  enterStop() {
    const cr = this.regs[0] & ~(CR_HSEON | CR_HSERDY | CR_PLLON | CR_PLLRDY | CR_PLLI2SON | CR_PLLI2SRDY | CR_PLLSAION | CR_PLLSAIRDY)
    this.regs[0] = (cr | CR_HSION | CR_HSIRDY) >>> 0
    this.regs[2] &= ~0xf
    this.bump()
  }

  protected onRead(d: RegDef, value: number): number {
    // The external oscillators come ready on their own time.
    if (d.name === "CR") return this.refreshHse()
    if (d.name === "BDCR") return this.refreshLse()
    return value
  }

  protected onWrite(d: RegDef, next: number, old: number): number | void {
    switch (d.name) {
      case "CR": {
        // Internal ready flags track the enable bits; the PLL locks at once (its source must
        // be ready, which the HAL checks). HSE starts its oscillator when switched on and
        // reports ready through `refreshHse`.
        let v = next & ~(CR_HSIRDY | CR_HSERDY | CR_PLLRDY | CR_PLLI2SRDY | CR_PLLSAIRDY)
        if (v & CR_HSION) v |= CR_HSIRDY
        if (v & CR_HSEON && !(old & CR_HSEON)) this.hseOnAt = this.now()
        if (v & CR_HSEON) v |= old & CR_HSERDY
        // The PLL locks only on a source that is running (the HAL checks HSERDY before it).
        const pllSrcReady = this.regs[1] & (1 << 22) ? (v & CR_HSERDY) !== 0 : (v & CR_HSIRDY) !== 0
        if (v & CR_PLLON && pllSrcReady) v |= CR_PLLRDY
        if (v & CR_PLLI2SON) v |= CR_PLLI2SRDY
        if (v & CR_PLLSAION) v |= CR_PLLSAIRDY
        // HSICAL reads back as a plausible calibration value.
        v = (v & ~0xff00) | 0x1000
        if (v !== old) this.bump()
        this.regs[0] = v >>> 0
        return this.refreshHse()
      }
      case "CFGR": {
        // SWS mirrors SW when the selected source is ready.
        const sw = next & 3
        const cr = this.refreshHse()
        const ready = sw === 0 ? (cr & CR_HSIRDY) !== 0 : sw === 1 ? (cr & CR_HSERDY) !== 0 : sw === 2 ? (cr & CR_PLLRDY) !== 0 : false
        const sws = ready ? sw : (old >>> 2) & 3
        const v = ((next & ~0xc) | (sws << 2)) >>> 0
        if (v !== old) this.bump()
        return v
      }
      case "PLLCFGR":
      case "PLLI2SCFGR":
      case "PLLSAICFGR":
      case "DCKCFGR":
        if (next !== old) this.bump()
        return
      case "CSR":
        // LSIRDY follows LSION; RMVF clears the reset flags.
        {
          let v = next & ~2
          if (v & 1) v |= 2
          if (v & (1 << 24)) v &= 0x00ffffff
          if ((v & 1) !== (old & 1)) this.bump()
          return v >>> 0
        }
      case "BDCR": {
        // LSE starts its crystal when switched on (`refreshLse` brings LSERDY); BDRST clears
        // the domain (and reads back until cleared).
        let v = next & ~BDCR_LSERDY
        if (v & BDCR_LSEON && !(old & BDCR_LSEON)) this.lseOnAt = this.now()
        if (v & BDCR_LSEON) v |= old & BDCR_LSERDY
        if (v & (1 << 16)) v &= 1 << 16
        if (v !== old) this.bump()
        this.regs[0x70 >>> 2] = v >>> 0
        return this.refreshLse()
      }
    }
  }

  /** Whether a peripheral clock enable bit is set (bus register name + bit). */
  enabled(reg: "AHB1ENR" | "AHB2ENR" | "AHB3ENR" | "APB1ENR" | "APB2ENR", bit: number): boolean {
    return (this.get(reg) & (1 << bit)) !== 0
  }

  pllOutput(): { p: number; q: number } {
    const cfg = this.get("PLLCFGR")
    const m = cfg & 0x3f
    const n = (cfg >>> 6) & 0x1ff
    const p = (((cfg >>> 16) & 3) + 1) * 2
    const q = (cfg >>> 24) & 0xf
    const src = cfg & (1 << 22) ? this.hseHz() : HSI_HZ
    if (m === 0 || q === 0) return { p: 0, q: 0 }
    const vco = (src / m) * n
    return { p: vco / p, q: vco / q }
  }

  /**
   * LCD-TFT pixel clock: PLLSAI's R output through DCKCFGR's PLLSAIDIVR (RM0090 §6.3.24,
   * RM0385 §5.3.25). Zero while PLLSAI is off or the LTDC has no clock (APB2ENR.LTDCEN).
   */
  ltdcHz(): number {
    if (!(this.regs[0] & CR_PLLSAION)) return 0
    if (!(this.get("APB2ENR") & (1 << 26))) return 0
    const cfg = this.get("PLLCFGR")
    const m = cfg & 0x3f
    const src = cfg & (1 << 22) ? this.hseHz() : HSI_HZ
    const sai = this.get("PLLSAICFGR")
    const n = (sai >>> 6) & 0x1ff
    const r = (sai >>> 28) & 7
    const divr = 2 ** (((this.get("DCKCFGR") >>> 16) & 3) + 1)
    if (m === 0 || r === 0) return 0
    return ((src / m) * n) / r / divr
  }

  clocks(): ClockTree {
    const cfgr = this.get("CFGR")
    const sws = (cfgr >>> 2) & 3
    let sysclk: number
    let source: ClockTree["source"]
    if (sws === 1) {
      sysclk = this.hseHz()
      source = "HSE"
    } else if (sws === 2) {
      sysclk = this.pllOutput().p
      source = "PLL"
    } else {
      sysclk = HSI_HZ
      source = "HSI"
    }
    const hpre = (cfgr >>> 4) & 0xf
    const ahbDiv = hpre < 8 ? 1 : 2 ** (hpre - 7 + (hpre >= 12 ? 1 : 0))
    const hclk = sysclk / ahbDiv
    const apbDiv = (v: number) => (v < 4 ? 1 : 2 ** (v - 3))
    const ppre1 = apbDiv((cfgr >>> 10) & 7)
    const ppre2 = apbDiv((cfgr >>> 13) & 7)
    const timpre = (this.get("DCKCFGR") & (1 << 24)) !== 0
    const timclk = (pclk: number, div: number) => (timpre ? (div <= 4 ? hclk : pclk * 4) : div === 1 ? pclk : pclk * 2)
    return {
      sysclk,
      hclk,
      pclk1: hclk / ppre1,
      pclk2: hclk / ppre2,
      timclk1: timclk(hclk / ppre1, ppre1),
      timclk2: timclk(hclk / ppre2, ppre2),
      source,
    }
  }
}
