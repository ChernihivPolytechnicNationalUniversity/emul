/**
 * The two comparators and the voltage reference (DS40044G §10, §11; checklist P3-001…P3-072,
 * P9-180…P9-218). The inputs per mode are drawn in Figure 10-1 (read from the PDF: in modes 011, 110
 * and 001 both VIN+ are RA2; only 110 puts the outputs on RA3/RA4 — decision D21). The outputs are
 * the inputs' comparison, inverted by CnINV; a change against the value CMCON last latched sets CMIF
 * and keeps setting it until CMCON is read or written (Figure 10-3). They run without a clock, so in
 * Sleep too, and wake the part.
 *
 * The reference is a 16-tap ladder of unit resistors (Figure 11-1): 8R + 16R (+ 8R in the high range)
 * between VDD and VSS, VREF = VR/24·VDD (VRR = 1) or VDD/4 + VR/32·VDD (VRR = 0), seen through the
 * ladder's own resistance on RA2 (D312: R = 2 kΩ).
 */
import { Peripheral, type PicBus } from "../io"

export interface ComparatorHost {
  /** The voltage on RA0–RA3 as the circuit last solved it. */
  volts(pin: number): number
  readonly vdd: number
  setCmif(cycle: number): void
  /** The outputs or the pins they use changed: RA3/RA4 refresh. */
  pinsChanged(cycle: number): void
  readonly defective001: boolean
}

/** What VIN- and VIN+ of C1 and C2 are in each mode: a pin (0–3), "vref", "vss", or null (off). */
type Inputs = [string | number | null, string | number | null, string | number | null, string | number | null]
function inputs(cm: number, cis: boolean): Inputs {
  switch (cm) {
    case 1:
      return [cis ? 3 : 0, 2, 1, 2]
    case 2:
      return [cis ? 3 : 0, "vref", cis ? 2 : 1, "vref"]
    case 3:
    case 6:
      return [0, 2, 1, 2]
    case 4:
      return [0, 3, 1, 2]
    case 5:
      return [null, null, 1, 2]
    default:
      return [null, null, null, null]
  }
}

export class Comparators extends Peripheral {
  readonly name = "Comparators"
  override readonly domain = "own" as const
  private readonly host: ComparatorHost
  cmcon = 0
  vrcon = 0
  /** Live outputs (after CnINV) and the ones latched by the last CMCON access. */
  private out = 0
  private latched = 0
  private reported001 = false

  constructor(bus: PicBus, host: ComparatorHost) {
    super(bus)
    this.host = host
  }
  get mode() {
    return this.cmcon & 7
  }

  reset() {
    this.cmcon = 0
    this.vrcon = 0
    this.out = 0
    this.latched = 0
  }

  // --- voltage reference ------------------------------------------------------------------------

  /** VREF, V (0 with the module powered down, decision D23). */
  vref(): number {
    if (!(this.vrcon & 0x80)) return 0
    const vr = this.vrcon & 0x0f
    const vdd = this.host.vdd
    return this.vrcon & 0x20 ? (vr / 24) * vdd : vdd / 4 + (vr / 32) * vdd
  }
  /** The ladder's Thevenin resistance at the tap, Ω (Figure 11-1, R from D312). */
  vrefOhms(): number {
    const R = 2000
    const vr = this.vrcon & 0x0f
    const below = this.vrcon & 0x20 ? vr : 8 + vr
    const above = this.vrcon & 0x20 ? 24 - vr : 24 - vr
    return (below * R * above * R) / (below * R + above * R) || 0
  }
  /** VREF on RA2: VREN and VROE set (TRISA<2> = 1 is the SoC's to check, §11). */
  get outputOn() {
    return (this.vrcon & 0xc0) === 0xc0
  }

  // --- comparators ------------------------------------------------------------------------------

  private level(src: string | number | null): number {
    if (src === null) return 0
    if (src === "vref") return this.vref()
    if (src === "vss") return 0
    return this.host.volts(src as number)
  }
  /** The outputs from the inputs now: bit 0 C1, bit 1 C2. */
  private compute(): number {
    const cm = this.mode
    const [m1, p1, m2, p2] = inputs(cm, (this.cmcon & 0x08) !== 0)
    if (cm === 1 && this.host.defective001) {
      if (!this.reported001) {
        this.reported001 = true
        this.bus.feature("Comparator mode 001: defective on the original PIC16F627/628 (DS40300C Figure 9-1) — outputs held at 0 (decision D22)")
      }
      return 0
    }
    let o = 0
    if (m1 !== null && this.level(p1) > this.level(m1)) o |= 1
    if (m2 !== null && this.level(p2) > this.level(m2)) o |= 2
    // CnINV (bits 4, 5) invert each output; an off comparator reads 0 either way (Figure 10-1).
    if (m1 !== null && this.cmcon & 0x10) o ^= 1
    if (m2 !== null && this.cmcon & 0x20) o ^= 2
    return o
  }
  /** Re-evaluate at fractional cycle c (an input or the mode changed). */
  evaluate(c: number) {
    const o = this.compute()
    if (o !== this.out) {
      this.out = o
      this.host.pinsChanged(c)
    }
    if (this.out !== this.latched) this.host.setCmif(Math.ceil(c - 1e-9))
  }
  get outputs() {
    return this.out
  }

  /** CMCON reads latch the outputs (Figure 10-3): the mismatch ends. */
  readCmcon(): number {
    this.latched = this.out
    return (this.out << 6) | (this.cmcon & 0x3f)
  }
  peekCmcon(): number {
    return (this.out << 6) | (this.cmcon & 0x3f)
  }
  writeCmcon(v: number, c: number) {
    this.cmcon = v & 0x3f
    this.out = this.compute()
    // A write latches too (§10.6 a): mode changes may still show a mismatch next — the "false interrupt" of §10.1 note 1.
    this.latched = this.out
    this.host.pinsChanged(c)
  }
  writeVrcon(v: number, c: number) {
    this.vrcon = v & 0xef
    this.evaluate(c)
    this.host.pinsChanged(c)
  }
  /** The CMIF mismatch persists: called after software clears CMIF. */
  mismatch(): boolean {
    return this.out !== this.latched
  }
}
