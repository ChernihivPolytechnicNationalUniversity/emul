/**
 * Small system peripherals: PWR (regulator flags, low-power mode selection, Standby wake-up),
 * SYSCFG, DWT cycle counter, DBGMCU id. The FLASH interface lives in flash.ts.
 */
import { WordPeripheral } from "../bus"
import { RegBlock, type RegDef } from "./regblock"

// --- PWR (RM0090 §5, RM0385 §4) -----------------------------------------------------------

/** F7 wake-up pins WKUP1–6 (RM0385 §4.3.6), as port × 16 + pin. */
const WKUP_V2 = [0, 2, 2 * 16 + 1, 2 * 16 + 13, 8 * 16 + 8, 8 * 16 + 11] // PA0 PA2 PC1 PC13 PI8 PI11

/**
 * Power control: the regulator flags software polls, the low-power mode selected for the next
 * SLEEPDEEP (Stop or Standby, regulator choice, under-drive), and the Standby wake-up pins
 * and flags. "v1" is the F4 map (CR/CSR, WKUP on PA0); "v2" the F7 one (CR1/CSR1 plus
 * CR2/CSR2 with six wake-up pins of either polarity).
 */
export class Pwr extends RegBlock {
  /** Set before a reset: a power-on clears the Standby/wake-up flags, any other reset keeps them. */
  powerOn = true
  readonly map: "v1" | "v2"

  constructor(map: "v1" | "v2" = "v1") {
    super(
      "PWR",
      0x40007000,
      0x400,
      map === "v1"
        ? [
            { name: "CR", offset: 0x00, reset: 0x0000c000 },
            { name: "CSR", offset: 0x04, reset: 0, rw: 0x00000300 },
          ]
        : [
            { name: "CR1", offset: 0x00, reset: 0x0000c000 },
            { name: "CSR1", offset: 0x04, reset: 0, rw: 0x00000200 },
            { name: "CR2", offset: 0x08, reset: 0, rw: 0x00003f00 },
            { name: "CSR2", offset: 0x0c, reset: 0, rw: 0x00003f00 },
          ],
    )
    this.map = map
  }

  reset() {
    const csr = this.regs ? this.regs[1] : 0
    const csr2 = this.regs ? this.regs[3] : 0
    super.reset()
    // SBF and the wake-up flags survive everything but a power-on (they are how firmware
    // learns it came back from Standby); so do the wake-up pin enables.
    if (!this.powerOn && this.regs) {
      this.regs[1] = csr & (this.map === "v1" ? 0x303 : 0x202)
      if (this.map === "v2") this.regs[3] = csr2 & 0x3f3f
    }
  }

  protected onWrite(d: RegDef, next: number, _old: number, written: number): number | void {
    switch (d.name) {
      case "CR":
      case "CR1": {
        // The regulator flags in CSR follow CR at once: VOSRDY, ODRDY (from ODEN), ODSWRDY (from ODSWEN).
        let csr = this.regs[1] & ~((1 << 14) | (1 << 16) | (1 << 17))
        csr |= 1 << 14
        if (next & (1 << 16)) csr |= 1 << 16
        if (next & (1 << 17)) csr |= 1 << 17
        // CWUF and CSBF clear their flags and read back as zero.
        if (this.map === "v1" && written & (1 << 2)) csr &= ~1
        if (written & (1 << 3)) csr &= ~2
        this.regs[1] = csr >>> 0
        return next & ~0xc
      }
      case "CR2":
        // CWUPF1–6 clear the wake-up pin flags in CSR2.
        this.regs[3] &= ~(written & 0x3f)
        return next & ~0x3f
    }
  }
  protected onRead(d: RegDef, current: number): number {
    if (d.name === "CSR" || d.name === "CSR1") return current | (1 << 14)
    return current
  }

  /** PDDS: the next deep sleep is Standby rather than Stop. */
  standby() {
    return (this.regs[0] & 2) !== 0
  }
  /** Which Stop flavour the regulator bits select, for the current and wake-up figures. */
  stopKind(): "stop" | "stopLp" | "stopUd" {
    const cr = this.regs[0]
    const lp = (cr & 1) !== 0
    const underDrive = ((cr >>> 18) & 3) === 3 && (cr & (lp ? 1 << 10 : 1 << 11)) !== 0
    return underDrive ? "stopUd" : lp ? "stopLp" : "stop"
  }

  /** Whether a pad edge is an enabled wake-up pin event; returns the pin's index (WKUP1 = 0) or −1. */
  wakeupPin(port: number, pin: number, level: boolean): number {
    if (this.map === "v1") return port === 0 && pin === 0 && level && this.regs[1] & (1 << 8) ? 0 : -1
    const i = WKUP_V2.indexOf(port * 16 + pin)
    if (i < 0 || !(this.regs[3] & (1 << (8 + i)))) return -1
    const falling = (this.regs[2] & (1 << (8 + i))) !== 0
    return level !== falling ? i : -1
  }

  /** Coming back from Standby: SBF, and the wake-up flag when a WKUP pin did it. */
  flagStandbyExit(pin: number) {
    this.regs[1] |= 2
    if (pin < 0) return
    if (this.map === "v1") this.regs[1] |= 1
    else this.regs[3] |= 1 << pin
  }
}

// --- SYSCFG (RM0090 §9) -------------------------------------------------------------------

export class Syscfg extends RegBlock {
  constructor() {
    super("SYSCFG", 0x40013800, 0x400, [
      { name: "MEMRMP", offset: 0x00 },
      { name: "PMC", offset: 0x04 },
      { name: "EXTICR1", offset: 0x08, rw: 0xffff },
      { name: "EXTICR2", offset: 0x0c, rw: 0xffff },
      { name: "EXTICR3", offset: 0x10, rw: 0xffff },
      { name: "EXTICR4", offset: 0x14, rw: 0xffff },
      { name: "CMPCR", offset: 0x20, rw: 1 },
    ])
  }
  /** MEMRMP.MEM_MODE written: what address 0 should alias (0 flash, 1 system memory, 3 SRAM; 2 = FMC, unmodelled). */
  onRemap: (mode: number) => void = () => {}

  protected onWrite(d: RegDef, next: number, old: number): void {
    if (d.name === "MEMRMP" && (next & 3) !== (old & 3)) this.onRemap(next & 3)
  }

  /** GPIO port index (0 = A) routed to EXTI line `line`. */
  extiPort(line: number): number {
    const reg = this.regs[(0x08 >>> 2) + (line >>> 2)]
    return (reg >>> ((line & 3) * 4)) & 0xf
  }
  protected onRead(d: RegDef, current: number): number {
    // CMPCR.READY mirrors CMP_PD.
    if (d.name === "CMPCR") return current & 1 ? 0x101 : 0
    return current
  }
}

// --- DWT: only CYCCNT, which some code uses for fine delays --------------------------------

export class Dwt extends WordPeripheral {
  ctrl = 0
  private cycleBase = 0
  private readonly cycles: () => number
  constructor(cycles: () => number) {
    super("DWT", 0xe0001000, 0x1000)
    this.cycles = cycles
  }
  reset() {
    this.ctrl = 0
    this.cycleBase = 0
  }
  readWord(offset: number): number {
    switch (offset) {
      case 0x00:
        return this.ctrl | 0x40000000 // NOCYCCNT = 0, NUMCOMP = 4
      case 0x04:
        return this.ctrl & 1 ? (this.cycles() - this.cycleBase) >>> 0 : 0
      default:
        return 0
    }
  }
  writeWord(offset: number, value: number): void {
    switch (offset) {
      case 0x00:
        if ((value & 1) && !(this.ctrl & 1)) this.cycleBase = this.cycles()
        this.ctrl = value & 1
        return
      case 0x04:
        this.cycleBase = this.cycles() - (value >>> 0)
        return
    }
  }
}

// --- DBGMCU ---------------------------------------------------------------------------------

export class Dbgmcu extends RegBlock {
  /** `idcode`: device id (bits 11:0) and revision (31:16) of the part, e.g. 0x20016419 for an F429 rev 3. */
  constructor(idcode: number) {
    super("DBGMCU", 0xe0042000, 0x1000, [
      { name: "IDCODE", offset: 0x00, reset: idcode, rw: 0 },
      { name: "CR", offset: 0x04 },
      { name: "APB1FZ", offset: 0x08 },
      { name: "APB2FZ", offset: 0x0c },
    ])
  }
}
