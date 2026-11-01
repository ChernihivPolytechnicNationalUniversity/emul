/**
 * The STM32F4-Discovery's MEMS accelerometer (U5) on its 4-wire SPI bus: the LIS302DL of MB997
 * A/B boards (ST datasheet Rev 4, Oct 2008, "DS302") and the LIS3DSH of C-01…E-01 boards (ST
 * DocID022405 Rev 2, Oct 2015, "DS3DSH"). Bus-level: whole bits on CS/SCK/MOSI in, MISO and the
 * INT pads out, the register file, and the sample clock against loop time (seconds).
 *
 * Board wiring (MB997 schematics, sheet "MEMS"): SPI1 SCK PA5, MOSI PA7, MISO PA6, CS PE3,
 * INT1 PE0, INT2 PE1, Vdd = Vdd_IO = 3 V.
 */
import type { PartState } from "@/schematic/types"
import type { DigitalEdge, DigitalPart } from "./digital-part"

export type LisVariant = "lis302dl" | "lis3dsh"
export type LisPins = { cs: string; sck: string; mosi: string; miso: string; int1: string; int2: string }

/** What the part does not do, for the UI to surface. */
export const NOT_MODELLED: string[] = [
  "I2C mode (CS high selects I2C; the board drives CS from PE3 for SPI)",
  "3-wire SPI (SIM=1): the register bit is stored, but read data is not driven onto SDI/MOSI, and MISO stays released",
  "SPI timing: the 10 MHz SCK limit and the setup/hold times of DS302 Table 5 / DS3DSH Table 5 are not checked",
  "Supply range, current draw, absolute maximum ratings, ESD and shock limits",
  "Zero-g offset, sensitivity tolerance, temperature drift and noise: the part is ideal",
  "Self-test settling (99 % after 3/ODR on the LIS302DL): the force applies from the next sample",
  "LIS302DL high-pass filter (FDS, HP_FF_WU1/2, HP_coeff, HP_FILTER_RESET): the registers are stored, data is unfiltered",
  "LIS302DL free-fall/wake-up generators FF_WU_1/2 (CFG, THS, DURATION, SRC): registers stored, never trigger; INT codes 001/010/011 stay inactive",
  "LIS302DL click/double-click engine (CLICK_*): registers stored, never triggers; INT code 111 stays inactive",
  "LIS302DL turn-on/BOOT duration: BOOT reloads nothing and self-clears at once",
  "LIS3DSH state machines SM1/SM2 (ST1_x/ST2_x programs, TIMx, THRSx, MASKx, SETTx, PRx, TCx, OUTSx, PEAKx, DES2, LC, VFC_x, CS_x): registers stored only; the op-code set is not in the datasheet",
  "LIS3DSH FIFO (FIFO_CTRL modes, watermark, FIFO_SRC, P1_* interrupts): always bypass, FIFO_SRC reads EMPTY",
  "LIS3DSH OFF_X/Y/Z offset correction (LSB weight undocumented): stored, not applied",
  "LIS3DSH anti-aliasing filter bandwidth (BW2:1): stored, not applied",
  "LIS3DSH temperature sensor OUT_T (zero point undocumented): reads 0",
  "LIS3DSH INT2 sources (SM interrupts, P2_BOOT): INT2 never asserts",
]

type Kind = "r" | "w" | "rw"

/** Sensitivities in mg/digit. DS302 Table 3: 18 / 72. DS3DSH Table 3 (FSCALE 000…100). */
const LIS302_SO = [18, 72]
const LIS3DSH_SO = [0.06, 0.12, 0.18, 0.24, 0.73]
/** DS3DSH Table 23, ODR codes 0001…1001 (0000 = power-down). */
const LIS3DSH_ODR = [0, 3.125, 6.25, 12.5, 25, 50, 100, 400, 800, 1600]

/**
 * LIS302DL self-test change at FS=0, LSb (DS302 Table 3): X negative, Y/Z positive with STP.
 * The board runs at 3.0 V, between the 2.5 V guaranteed window (3…32 LSb) and the 3.3 V typical
 * window (7…74 LSb, note 7); the datasheet gives no number for 3.0 V. Decision: 20 LSb, inside
 * both windows, so a firmware check against either passes. Applied as a force in g (§2.5.3: "an
 * actuation force… simulating a definite input acceleration"), so it is 4× fewer LSb at FS=1.
 */
const LIS302_ST_G = [-20 * 0.018, 20 * 0.018, 20 * 0.018]
/** LIS3DSH positive self-test difference (DS3DSH Table 3, ±2 g, typical): 140 / 140 / 590 mg. */
const LIS3DSH_ST_G = [0.14, 0.14, 0.59]

export type LisSnapshot = {
  variant: LisVariant
  active: boolean
  odr: number
  fullScale: string
  accel: { x: number; y: number; z: number }
  out: [number, number, number]
  status: number
  samples: number
}

export class LisAccelerometer implements DigitalPart {
  readonly object: string
  readonly pins: readonly string[]
  readonly outputs: readonly string[]
  readonly out: DigitalEdge[] = []
  readonly variant: LisVariant
  private readonly p: LisPins
  private readonly regs = new Uint8Array(128)
  private readonly kind: (Kind | undefined)[] = new Array(128)
  private readonly resetValue = new Uint8Array(128)
  private accel = { x: 0, y: 0, z: 1 }

  // SPI framing
  private cs = true
  private sck = true
  private mosi = false
  private bits = 0
  private shift = 0
  private cmd = -1
  private addr = 0
  private reading = false
  private outByte = 0
  private misoDrive: boolean | null = null
  private intDrive: [boolean | null, boolean | null] = [null, null]

  // Sampling
  private nextSample = Infinity
  private pulseEnd = Infinity
  private pulsing = false
  private samples = 0
  /** Latest converted sample per axis (LIS3DSH: what the outputs take once a BDU lock lifts). */
  private latest: [number, number, number] = [0, 0, 0]
  /** LIS3DSH BDU: per axis, the half (0 = L, 1 = H) read first, or -1 when unlocked. */
  private bduLock: [number, number, number] = [-1, -1, -1]
  private lastTime = 0

  constructor(object: string, pins: LisPins, variant: LisVariant) {
    this.object = object
    this.p = pins
    this.variant = variant
    this.pins = [pins.cs, pins.sck, pins.mosi, pins.miso, pins.int1, pins.int2]
    this.outputs = [pins.miso, pins.int1, pins.int2]
    if (variant === "lis302dl") this.mapLis302()
    else this.mapLis3dsh()
    this.reset()
  }

  /** DS302 Table 16. Unlisted/reserved addresses: kind undefined (writes ignored, reads 0). */
  private mapLis302() {
    const set = (a: number, k: Kind, v = 0) => {
      this.kind[a] = k
      this.resetValue[a] = v
    }
    set(0x0f, "r", 0x3b) // WHO_AM_I, §7.1
    set(0x20, "rw", 0x07) // CTRL_REG1, §7.2: PD=0, Zen=Yen=Xen=1
    set(0x21, "rw")
    set(0x22, "rw")
    set(0x23, "r") // HP_FILTER_RESET: a dummy read (§7.5); reads 0 here
    set(0x27, "r") // STATUS_REG
    for (const a of [0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d]) set(a, "r") // 28/2A/2C "Not Used": read 0 (undocumented)
    for (const a of [0x30, 0x32, 0x33, 0x34, 0x36, 0x37, 0x38, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f]) set(a, "rw")
    // FF_WU_THS_1 resets to "0000000x" (Table 16): x undefined; 0 chosen.
    for (const a of [0x31, 0x35, 0x39]) set(a, "r") // FF_WU_SRC_1/2, CLICK_SRC: engines not modelled, read 0
  }

  /** DS3DSH Table 15 and the §7 bit tables. */
  private mapLis3dsh() {
    const set = (a: number, k: Kind, v = 0) => {
      this.kind[a] = k
      this.resetValue[a] = v
    }
    set(0x0c, "r") // OUT_T
    set(0x0d, "r", 0x21) // INFO1, Table 16
    set(0x0e, "r", 0x00) // INFO2, Table 17
    set(0x0f, "r", 0x3f) // WHO_AM_I, Table 18
    for (let a = 0x10; a <= 0x17; a++) set(a, "rw") // OFF_x, CS_x, LC_L/H
    set(0x16, "rw", 0x01) // LC_L, Table 39
    for (const a of [0x18, 0x19, 0x1a]) set(a, "r") // STAT, PEAK1, PEAK2
    for (let a = 0x1b; a <= 0x1f; a++) set(a, "rw") // VFC_1..4, THRS3
    set(0x20, "rw", 0x07) // CTRL_REG4: Table 15 prints "-", Table 22 gives ODR=0000, Z/Y/Xen=1
    for (const a of [0x21, 0x22, 0x23, 0x24]) set(a, "rw")
    // CTRL_REG6: Table 28 states no default for BOOT and ADD_INC (others 0). Decision: ADD_INC=1
    // at reset (0x10). Real LIS3DSH silicon reads 0x10 here, and the many firmwares that burst-read
    // OUT_X_L..OUT_Z_H without touching CTRL_REG6 get coherent data; ST's own BSP never bursts on
    // this part (it reads the six bytes one by one), so it cannot tell either way.
    set(0x25, "rw", 0x10)
    set(0x27, "r") // STATUS
    for (let a = 0x28; a <= 0x2d; a++) set(a, "r") // OUT_X_L … OUT_Z_H
    set(0x2e, "rw") // FIFO_CTRL
    set(0x2f, "r", 0x20) // FIFO_SRC: bypass mode, nothing stored → EMPTY (Table 58); decision
    for (let a = 0x40; a <= 0x57; a++) set(a, "w") // ST1_x, TIMx_1, THRS2_1, THRS1_1
    for (const a of [0x59, 0x5a, 0x5b]) set(a, "w") // MASK1_B, MASK1_A, SETT1
    for (const a of [0x5c, 0x5d, 0x5e, 0x5f]) set(a, "r") // PR1, TC1_L/H, OUTS1
    for (let a = 0x60; a <= 0x7b; a++) set(a, "w") // ST2_x … SETT2
    for (const a of [0x7c, 0x7d, 0x7e, 0x7f]) set(a, "r") // PR2, TC2_L/H, OUTS2
  }

  // --- Configuration decoding ------------------------------------------------------------------

  private get is302() {
    return this.variant === "lis302dl"
  }

  /** Samples per second, 0 in power-down. DS302 §7.2 (PD, DR); DS3DSH Table 23. */
  private odr(): number {
    if (this.is302) {
      const c1 = this.regs[0x20]
      return c1 & 0x40 ? (c1 & 0x80 ? 400 : 100) : 0
    }
    const code = this.regs[0x20] >>> 4
    // Codes 1010–1111 are not listed in Table 23. Decision: they run at the top rate, as a decoder
    // that saturates would; firmware has no reason to write them.
    return LIS3DSH_ODR[Math.min(code, 9)]
  }

  /** mg/digit for the current full scale. */
  private sensitivity(): number {
    if (this.is302) return LIS302_SO[(this.regs[0x20] >>> 5) & 1]
    const fs = (this.regs[0x24] >>> 3) & 7
    // FSCALE 101–111 are not listed (Table 25). Decision: decode them as 100 (±16 g), as if only
    // the top bit were looked at once it is set.
    return LIS3DSH_SO[Math.min(fs, 4)]
  }

  private fullScale(): string {
    if (this.is302) return this.regs[0x20] & 0x20 ? "±8 g" : "±2 g"
    return ["±2 g", "±4 g", "±6 g", "±8 g", "±16 g"][Math.min((this.regs[0x24] >>> 3) & 7, 4)]
  }

  /** Enabled axes as a mask X=1, Y=2, Z=4 (DS302 §7.2; DS3DSH Table 22). Same bits on both. */
  private axes(): number {
    return this.regs[0x20] & 0x07
  }

  /** Self-test force in g per axis. */
  private selfTest(): [number, number, number] {
    if (this.is302) {
      // DS302 §7.2 STP/STM, Table 3 note 6: STM flips the sign on all axes. Both set is not
      // documented; decision: the two forces cancel.
      const c1 = this.regs[0x20]
      const sign = (c1 & 0x10 ? 1 : 0) - (c1 & 0x08 ? 1 : 0)
      return [LIS302_ST_G[0] * sign, LIS302_ST_G[1] * sign, LIS302_ST_G[2] * sign]
    }
    // DS3DSH Table 26: 01 positive, 10 negative, 11 not allowed. Only the positive values are
    // given (Table 3); negative = the same with the sign flipped (inferred: an electrostatic force
    // in the other direction). 11: decision, treated as normal mode.
    const st = (this.regs[0x24] >>> 1) & 3
    const sign = st === 1 ? 1 : st === 2 ? -1 : 0
    return [LIS3DSH_ST_G[0] * sign, LIS3DSH_ST_G[1] * sign, LIS3DSH_ST_G[2] * sign]
  }

  private sim(): boolean {
    return this.is302 ? (this.regs[0x21] & 0x80) !== 0 : (this.regs[0x24] & 0x01) !== 0
  }

  // --- DigitalPart ---------------------------------------------------------------------------

  /** Acceleration the board feels, in g, board axes; default (0, 0, 1) flat on a desk (DS §2.5.2). Taken at the next sample. */
  setAcceleration(g: { x: number; y: number; z: number }) {
    this.accel = { x: g.x, y: g.y, z: g.z }
  }

  reset() {
    this.bits = 0
    this.cmd = -1
    this.reading = false
    this.setMiso(null, this.lastTime)
    this.softReset()
  }

  /** Registers, flags and the sample clock to power-on state; the SPI frame in progress is kept. */
  private softReset() {
    this.regs.set(this.resetValue)
    this.nextSample = Infinity
    this.pulseEnd = Infinity
    this.pulsing = false
    this.latest = [0, 0, 0]
    this.bduLock = [-1, -1, -1]
    this.updateInts(this.lastTime)
  }

  configure(_props: Record<string, string>) {}

  interact(_part: string, _state: PartState, _time: number) {}

  drive(pin: string): boolean | null {
    if (pin === this.p.miso) return this.misoDrive
    if (pin === this.p.int1) return this.intDrive[0]
    if (pin === this.p.int2) return this.intDrive[1]
    return null
  }

  input(pin: string, level: boolean, time: number) {
    this.advance(time)
    if (pin === this.p.cs) {
      if (level === this.cs) return
      this.cs = level
      // DS §5.2: CS low starts a transaction, CS high ends it; SDO is released (internal pull-up,
      // DS302 Table 5 note 3, DS3DSH Fig. 3 note 2) while no transfer is in progress.
      this.bits = 0
      this.shift = 0
      this.cmd = -1
      this.reading = false
      if (level) this.setMiso(null, time)
      return
    }
    if (pin === this.p.mosi) {
      this.mosi = level
      return
    }
    if (pin !== this.p.sck) return
    if (level === this.sck) return
    this.sck = level
    if (this.cs) return // CPOL=1: SPC stopped high while CS is high; ignored
    if (level) this.onRise()
    else this.onFall(time)
  }

  /** DS §5.2: SDI is captured on the rising edge of SPC. */
  private onRise() {
    this.shift = ((this.shift << 1) | (this.mosi ? 1 : 0)) & 0xff
    this.bits++
    if (this.bits % 8) return
    if (this.bits === 8) {
      this.cmd = this.shift
      this.reading = (this.cmd & 0x80) !== 0 // bit 0 = RW, 1 = read
      // LIS302DL (§5.2): bit 1 = MS, bits 2–7 = AD5..0. LIS3DSH (§5.2 text): bits 1–7 = AD6..0,
      // no MS bit; auto-increment is CTRL_REG6.ADD_INC alone. Fig. 7–12 of DS3DSH still draw
      // "RW MS AD5..0" (copied from the LIS302DL); the text wins because the map reaches 7Fh.
      // ST's own Discovery BSP agrees: ACCELERO_IO_Read ORs MULTIPLEBYTE_CMD (0x40) only for
      // counts > 1, and LIS3DSH_ReadACC reads OUT_X_L…OUT_Z_H as six single-byte reads, and
      // LIS3DSH_Init writes CTRL_REG4 and CTRL_REG5 one at a time — never 0x40 on this part.
      this.addr = this.is302 ? this.cmd & 0x3f : this.cmd & 0x7f
      return
    }
    if (!this.reading) {
      this.writeReg(this.addr, this.shift, this.lastTime)
      this.addr = this.nextAddr()
    }
  }

  /** DS §5.2: SDO is driven on the falling edge; "the chip drives SDO at the start of bit 8". */
  private onFall(time: number) {
    if (!this.reading || this.bits < 8) return
    if (this.sim()) return // 3-wire: output would go on SDI (not modelled); MISO stays released
    const b = this.bits % 8
    if (b === 0) {
      this.outByte = this.readReg(this.addr)
      this.addr = this.nextAddr()
    }
    this.setMiso(((this.outByte >>> (7 - b)) & 1) === 1, time)
  }

  private nextAddr(): number {
    if (this.is302) {
      // §5.2: MS=1 increments, MS=0 keeps the address. Past 3Fh: wraps in the 6-bit field (undocumented).
      return this.cmd & 0x40 ? (this.addr + 1) & 0x3f : this.addr
    }
    // DS3DSH §5.2 / Table 28 ADD_INC. Past 7Fh: wraps (undocumented).
    return this.regs[0x25] & 0x10 ? (this.addr + 1) & 0x7f : this.addr
  }

  private setMiso(level: boolean | null, time: number) {
    if (this.misoDrive === level) return
    this.misoDrive = level
    this.out.push({ pin: this.p.miso, level, time })
  }

  // --- Registers -----------------------------------------------------------------------------

  private readReg(a: number): number {
    const k = this.kind[a]
    if (k === undefined) return 0 // reserved / unlisted: no documented content
    // LIS3DSH write-only registers (ST, TIM, THRS, MASK, SETT, DES): the read-back is undocumented
    // (DS3DSH Table 15 "w"). Decision: they read back what was written, as a plain register file.
    const v = this.regs[a]
    if (this.is302) {
      // §7.6 does not say what clears xDA/xOR. Decision (the usual ST behaviour): reading an
      // axis' OUT register clears its DA and OR bits; ZYXDA/ZYXOR clear once no enabled axis
      // still has unread data.
      if (a === 0x29) this.consume(0)
      else if (a === 0x2b) this.consume(1)
      else if (a === 0x2d) this.consume(2)
      return v
    }
    if (a === 0x18) {
      // STAT (Table 42): DRDY (b0) / DOR (b1) mirror STATUS ZYXDA / ZYXOR. LONG, SYNCx, INT_SMx: 0.
      const s = this.regs[0x27]
      return (s & 0x08 ? 0x01 : 0) | (s & 0x80 ? 0x02 : 0)
    }
    if (a >= 0x28 && a <= 0x2d) {
      const axis = (a - 0x28) >> 1
      const half = (a - 0x28) & 1
      const value = this.regs[a]
      // §7.5 BDU: "the content of the output registers is not updated until both MSb and LSb
      // are read". As ST's application notes for this family describe it: reading one half locks
      // the pair until the other half is read, and then the outputs take the latest sample.
      if (this.regs[0x20] & 0x08) {
        if (this.bduLock[axis] === -1) this.bduLock[axis] = half
        else if (this.bduLock[axis] !== half) {
          this.bduLock[axis] = -1
          this.loadOutput(axis)
        }
      }
      // Clearing rule undocumented (§7.8). Decision: the H byte (read after L in the natural
      // L→H order, as ST's BSP does) clears the axis' DA/OR.
      if (half === 1) this.consume(axis)
      return value
    }
    return v
  }

  private writeReg(a: number, v: number, time: number) {
    const k = this.kind[a]
    // Writes to read-only and reserved addresses are dropped (DS302 §6 / DS3DSH p.31 warn of
    // damage on reserved writes; the emulated die does not model that).
    if (k !== "rw" && k !== "w") return
    const odrBefore = this.odr()
    const pdBefore = this.is302 ? (this.regs[0x20] & 0x40) !== 0 : odrBefore > 0
    if (this.is302 && a === 0x21) v &= ~0x40 // BOOT self-clears (§7.3); reload is instant here
    if (!this.is302 && a === 0x25) v &= ~0x80 // BOOT self-clears (Table 28); boot time undocumented: 0
    if (!this.is302 && a === 0x23 && v & 0x01) {
      // STRT: "soft reset (POR function)" (Table 20). Decision: every register to its reset value,
      // STRT included (so it reads back 0), outputs and flags cleared, back in power-down.
      this.softReset()
      return
    }
    this.regs[a] = v
    if (a === 0x20) this.reschedule(odrBefore, pdBefore, time)
    if (!this.is302 && a === 0x20 && !(v & 0x08)) {
      // BDU cleared: the outputs follow the latest sample again.
      for (let i = 0; i < 3; i++) if (this.bduLock[i] !== -1) {
        this.bduLock[i] = -1
        this.loadOutput(i)
      }
    }
    this.updateInts(time)
  }

  private reschedule(odrBefore: number, wasOn: boolean, time: number) {
    const odr = this.odr()
    if (odr === 0) {
      this.nextSample = Infinity
      return
    }
    if (!wasOn) {
      // LIS302DL Table 4 note 5: turn-on time 3/ODR from power-down to valid data. LIS3DSH: no
      // turn-on time is specified (§7 item 12); decision: the first sample one period later.
      this.nextSample = time + (this.is302 ? 3 : 1) / odr
    } else if (odr !== odrBefore) {
      // Rate change while running (undocumented): the new period starts at the write.
      this.nextSample = time + 1 / odr
    }
  }

  private loadOutput(axis: number) {
    const raw = this.latest[axis]
    if (this.is302) this.regs[0x29 + 2 * axis] = raw & 0xff
    else {
      this.regs[0x28 + 2 * axis] = raw & 0xff
      this.regs[0x29 + 2 * axis] = (raw >>> 8) & 0xff
    }
  }

  /** Clear an axis' DA/OR after its output was read; ZYX flags once no enabled axis is pending. */
  private consume(axis: number) {
    const bit = 1 << axis
    let s = this.regs[0x27] & ~(bit | (bit << 4))
    if ((s & this.axes() & 0x07) === 0) s &= ~0x88
    if (s !== this.regs[0x27]) {
      this.regs[0x27] = s
      this.updateInts(this.lastTime)
    }
  }

  // --- Sampling ------------------------------------------------------------------------------

  /** One conversion at `time` (DS302 §3.2 RDY; DS3DSH §3 DRDY). */
  private sample(time: number) {
    const mask = this.axes()
    // Xen/Yen/Zen "enable the generation of Data Ready" per axis (DS302 §7.2); with none enabled
    // there is no data-ready (decision: and no update). A disabled axis keeps its last output.
    if (!mask) return
    this.samples++
    const so = this.sensitivity()
    const st = this.selfTest()
    const g = [this.accel.x + st[0], this.accel.y + st[1], this.accel.z + st[2]]
    // DS302: 8-bit two's complement, 1 LSb = So (Table 3, §2.5.2). DS3DSH: 16-bit two's
    // complement, L at the lower address (§7.23–7.25). Out-of-range values saturate.
    const [lo, hi] = this.is302 ? [-128, 127] : [-32768, 32767]
    let s = this.regs[0x27]
    for (let i = 0; i < 3; i++) {
      if (!(mask & (1 << i))) continue
      this.latest[i] = Math.max(lo, Math.min(hi, Math.round((g[i] * 1000) / so)))
      if (this.bduLock[i] === -1) this.loadOutput(i)
      // STATUS xOR: new data overwrote unread data; xDA: new data (DS302 §7.6, DS3DSH Table 30).
      if (s & (1 << i)) s |= 0x10 << i
      s |= 1 << i
    }
    if (s & 0x08 && this.regs[0x27] & 0x08) s |= 0x80
    s |= 0x08
    this.regs[0x27] = s
    if (!this.is302 && this.regs[0x23] & 0x20) {
      // IEL=1 pulsed (Table 20). The pulse width is not documented; decision: half a sample
      // period, so firmware polling the pin also sees it.
      this.pulsing = true
      this.pulseEnd = time + 0.5 / this.odr()
    }
    this.updateInts(time)
  }

  /** Run the sample clock (and pulse ends) up to `time`, in order. */
  private advance(time: number) {
    if (time > this.lastTime) this.lastTime = time
    for (;;) {
      const t = Math.min(this.nextSample, this.pulseEnd)
      if (t > time + 1e-12) return
      if (this.pulseEnd <= this.nextSample) {
        this.pulseEnd = Infinity
        this.pulsing = false
        this.updateInts(t)
        continue
      }
      const period = 1 / this.odr()
      // A long silent stretch with no pin to drive: jump ahead (the flags end up the same,
      // DA plus OR) instead of converting every missed sample.
      const behind = Math.floor((time - this.nextSample) / period)
      if (behind > 4 && !this.samplesDriveInt()) {
        this.sample(this.nextSample)
        this.nextSample += (behind - 1) * period
      }
      this.sample(this.nextSample)
      this.nextSample += period
    }
  }

  tick(time: number): boolean {
    this.advance(time)
    return false
  }

  quietUntil(): number {
    const next = this.samplesDriveInt() ? this.nextSample : Infinity
    return Math.min(next, this.pulseEnd)
  }

  // --- Interrupt pads ------------------------------------------------------------------------

  /** Whether a sample can change an INT pad. */
  private samplesDriveInt(): boolean {
    if (this.is302) {
      const c3 = this.regs[0x22]
      return (c3 & 0x07) === 0x04 || ((c3 >>> 3) & 0x07) === 0x04
    }
    return (this.regs[0x23] & 0x88) === 0x88
  }

  private updateInts(time: number) {
    let pads: [boolean | null, boolean | null]
    const drdy = (this.regs[0x27] & 0x08) !== 0
    if (this.is302) {
      // CTRL_REG3 (§7.4, Tables 24–25): I1CFG/I2CFG select the pad's signal; 000 = GND, 100 =
      // data ready. FF_WU and click sources are not modelled (inactive); 101/110 are not listed
      // (decision: inactive). RDY stays active while a set is unread (undocumented; decision).
      // IHL: 0 active high, 1 active low. PP_OD: 0 push-pull, 1 open drain.
      const c3 = this.regs[0x22]
      const active = [(c3 & 0x07) === 0x04 && drdy, ((c3 >>> 3) & 0x07) === 0x04 && drdy]
      const ihl = (c3 & 0x80) !== 0
      const od = (c3 & 0x40) !== 0
      pads = active.map((a) => {
        const high = a !== ihl
        return od ? (high ? null : false) : high
      }) as [boolean | null, boolean | null]
    } else {
      // CTRL_REG3 (Table 20): DR_EN routes DRDY to INT1; INT1_EN/INT2_EN enable the pads; IEA
      // 0 = active low, 1 = active high; IEL 0 = latched (here: until the data is read, the
      // same rule as STATUS), 1 = pulsed. Driver type undocumented (§7 item 11); decision:
      // push-pull when enabled, released when the pad is disabled.
      const c3 = this.regs[0x23]
      const iea = (c3 & 0x40) !== 0
      const pulsed = (c3 & 0x20) !== 0
      const int1 = (c3 & 0x80) !== 0 && (pulsed ? this.pulsing : drdy)
      pads = [c3 & 0x08 ? int1 === iea : null, c3 & 0x10 ? !iea : null]
    }
    for (let i = 0; i < 2; i++) {
      if (this.intDrive[i] === pads[i]) continue
      this.intDrive[i] = pads[i]
      this.out.push({ pin: i ? this.p.int2 : this.p.int1, level: pads[i], time })
    }
  }

  snapshot(): LisSnapshot {
    const out: [number, number, number] = this.is302
      ? [0, 1, 2].map((i) => (this.regs[0x29 + 2 * i] << 24) >> 24) as [number, number, number]
      : [0, 1, 2].map((i) => (((this.regs[0x29 + 2 * i] << 8) | this.regs[0x28 + 2 * i]) << 16) >> 16) as [number, number, number]
    return { variant: this.variant, active: this.odr() > 0, odr: this.odr(), fullScale: this.fullScale(), accel: { ...this.accel }, out, status: this.regs[0x27], samples: this.samples }
  }
}
