/**
 * Cirrus Logic CS43L22 low-power stereo DAC with headphone amplifier, as fitted to the
 * STM32F4-Discovery (MB997 B-01…E-01, U7). Bus-level: an I²C slave control port on the
 * scaffold of `digital-part.ts`, and an I²S/LJ/RJ/DSP slave receiver on SCLK/LRCK/SDIN with an
 * MCLK ratio check. Decoded frames go through the digital volume chain into a buffer
 * (`takeAudio`) and the bench sound (`pressure`).
 *
 * Reference: Cirrus DS792F2 (March 2010). "§x" is a datasheet section, "p.N" a page.
 * Where the datasheet is silent or contradicts itself, a "Decision:" comment says what the model
 * does and why.
 */
import { I2cSlave } from "./digital-part"
import { FULL_SCALE_PASCALS } from "./sound-stream"

export type Cs43l22Pins = { sda: string; scl: string; reset: string; mclk: string; sclk: string; sdin: string; lrck: string }

export type Cs43l22Options = {
  /** REVID[2:0] (§7.1): 0 A0, 1 A1, 2 B0, 3 B1. Decision: B1 by default, the datasheet does not say which revision ships. */
  revision?: number
  /** AD0 pin level (§5.1); GND on MB997. */
  ad0?: boolean
  /** SPKR/HP pin level (§7.3); tied to GND on MB997. */
  spkrHp?: boolean
  /** Supplies, volts: VA (2.5 V on MB997, LD3985M25R), VL (3 V), VP (3 V). */
  va?: number
  vl?: number
  vp?: number
}

/** What the model leaves out, for the README coverage table and the inspector. */
export const NOT_MODELLED: string[] = [
  "Master mode (M/S = 1, §7.5.1): the codec does not drive SCLK/LRCK; serial data is ignored with a warning. SCLK=MCLK (§7.6.1) likewise",
  "Serial port setup/hold times (40/20/20 ns) and clock duty cycles (p.16); data is sampled at the SCLK edge",
  "Soft ramp and zero cross (DIGSFT, DIGZC, ANLGSFTx, ANLGZCx, §7.8, §7.11.5–6): every volume change is instant",
  "Bass/treble shelving (TC_EN, §7.17–7.18), de-emphasis (DEEMPH, §7.11.4) and the limiter (§4.2.2, §7.23–7.25): registers stored, signal passes untouched (warning when enabled)",
  "Analog passthrough AIN1–AIN4 (PASSxSEL, PASSxVOL, PASSxMUTE, PASSTHRUx, §4.3, §7.7, §7.13): no analog inputs; registers stored",
  "Class-D speaker path (SPKxVOL, SPKxMUTE, SPKMONO, SPKSWAP, MUTE50/50, short detect, battery compensation, §4.5, §7.12, §7.21, §7.27): speaker outputs are not connected on MB997; registers stored",
  "Charge pump frequency (0x34, §7.30): stored only",
  "The meaning of the §4.11 required initialization writes (0x00, 0x47, 0x32 bit 7): stored and tracked as 'init done', no effect invented",
  "Power-up/down analog behaviour (VQ/FILT+ and charge-pump ramp, pops, the HP amp swinging to +VHP when MCLK stops early, §4.8, §4.10): output starts one LRCK period after the ratio is measured",
  "DAC filter response, group delay 9/Fs, noise and THD (p.11–15): ideal DAC",
  "AUTO = 0 clocking with 12/24/27 MHz MCLK (Table 1: VIDEOCLK, RATIO ≠ 00): the ratio is not checked in those settings",
  "Die temperature monitor (§4.1.4): no register exists for it",
  "Supply sensing, VL input thresholds other than thresholds(), supply currents (p.19) and absolute maximum ratings",
  "I²C timing other than the SCL frequency (≤ 100 kHz) and tirs (550 ns): setup/hold, tbuf, rise/fall",
  "Beep waveform (assumed sine) and its 0 dB reference (assumed digital full scale): the datasheet gives neither",
]

// --- Register map (§6 Quick Reference p.35–36) ---------------------------------------------------

const PDN_UP = 0x9e
const RESET_VALUES: Record<number, number> = {
  0x02: 0x01, 0x03: 0x07, 0x04: 0x05, 0x05: 0xa0, 0x08: 0x81, 0x09: 0x81, 0x0a: 0xa5, 0x0d: 0x60, 0x0e: 0x02,
  0x18: 0x80, 0x19: 0x80, 0x1f: 0x88, 0x28: 0x7f, 0x2b: 0x3f, 0x32: 0x3b, 0x34: 0x5f,
}
/** §7 preamble + headings: ID, Status, VP level and Speaker status are read only. */
const READ_ONLY = new Set([0x01, 0x2e, 0x30, 0x31])
/** Whole reserved registers in the map (§6). */
const RESERVED_REGS = new Set([0x03, 0x0b, 0x10, 0x11, 0x12, 0x13, 0x16, 0x17, 0x18, 0x19, 0x2a, 0x2b, 0x2c, 0x2d, 0x32, 0x33])
/** Reserved bits inside read/write registers (§6), which "must maintain their default value" (§7). */
const RESERVED_BITS: Record<number, number> = { 0x06: 0x20, 0x07: 0xb7, 0x08: 0xf0, 0x09: 0xf0, 0x0a: 0xf0, 0x0c: 0x7f, 0x26: 0x0f, 0x29: 0xc0, 0x2f: 0x30, 0x34: 0x0f }
/** §4.11 required initialization settings, in order: register, value or [bit 7 must be] for 0x32. */
const INIT_STEPS: [number, (v: number) => boolean][] = [
  [0x00, (v) => v === 0x99],
  [0x47, (v) => v === 0x80],
  [0x32, (v) => (v & 0x80) !== 0],
  [0x32, (v) => (v & 0x80) === 0],
  [0x00, (v) => v === 0x00],
]

// Status 0x2E bits. Decision: the §7.26 table order (b5 DSPAOVFL, b4 DSPBOVFL), not the Quick
// Reference's (b5 DSPB, b4 DSPA): §7.26 is the detailed definition, and it keeps the A-above-B
// pattern of PCMAOVFL (b3) / PCMBOVFL (b2) in the same register.
const SPCLKERR = 0x40
const DSPAOVFL = 0x20
const DSPBOVFL = 0x10
const PCMAOVFL = 0x08
const PCMBOVFL = 0x04

/** HPGAIN[2:0] → analog gain G (§7.10.1). */
const HPGAIN = [0.3959, 0.4571, 0.5111, 0.6047, 0.7099, 0.8399, 1.0, 1.143]
/** Modulation index in the full-scale output 2·G·MI·VA Vpp (p.11). */
const MI = 0.6787
/** Beep frequency table at the nominal Fs of each speed mode (§7.15.1). */
const BEEP_HZ = [260.87, 521.74, 585.37, 666.67, 705.88, 774.19, 888.89, 1000.0, 1043.48, 1200.0, 1333.33, 1411.76, 1600.0, 1714.29, 2000.0, 2181.82]
/** ONTIME[3:0], seconds (§7.15.2). */
const BEEP_ON = [0.086, 0.43, 0.78, 1.2, 1.5, 1.8, 2.2, 2.5, 2.8, 3.2, 3.5, 3.8, 4.2, 4.5, 4.8, 5.2]
/** OFFTIME[2:0], seconds (§7.16.1). */
const BEEP_OFF = [1.23, 2.58, 3.9, 5.2, 6.6, 8.05, 9.35, 10.8]

type Speed = "QSM" | "HSM" | "SSM" | "DSM"
/** Nominal Fs of each speed mode, the Fs the beep tables are given for (§7.15 "Fs = 12, 24, 48 or 96 kHz"). */
const NOMINAL_FS: Record<Speed, number> = { QSM: 12000, HSM: 24000, SSM: 48000, DSM: 96000 }
/** §9.1 (AUTO = 1): internal MCLK:LRCK ratios (after MCLKDIV2) and the speed mode each selects. */
const AUTO_RATIOS: [number, Speed][] = [
  [128, "DSM"], [192, "DSM"], [256, "SSM"], [384, "SSM"], [512, "HSM"], [768, "HSM"], [1024, "QSM"], [1536, "QSM"],
]
/** §9.2 (AUTO = 0): MCLK:LRCK ratios listed for each SPEED setting's sample-rate group. */
const MANUAL_RATIOS: Record<Speed, number[]> = {
  QSM: [512, 768, 1024, 1536, 2048, 3072],
  HSM: [256, 384, 512, 768, 1024, 1536],
  SSM: [256, 384, 512, 768],
  DSM: [128, 192, 256, 384],
}
const SPEED_BITS: Speed[] = ["DSM", "SSM", "HSM", "QSM"]

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, 0.01 * b)
const gain = (halfDb: number) => 10 ** (halfDb / 40)

/** PCMxVOL[6:0] (§7.14.2): +12 dB at 0x18 … 0 dB at 0x00, 0x7F = −0.5 dB … 0x19 = −51.5 dB. */
function pcmGain(code: number) {
  const c = code & 0x7f
  return gain(c <= 0x18 ? c : c - 128)
}
/** MSTxVOL[7:0] (§7.19.1): two's complement half-dB, +12 dB at 0x18, 0x19–0x34 all −102 dB. */
function masterGain(code: number) {
  if (code <= 0x18) return gain(code)
  if (code <= 0x34) return gain(-204)
  return gain(code - 256)
}
/**
 * HPxVOL[7:0] (§7.20.1): 0x00 = 0 dB, 0xFF = −0.5 dB, 0.5 dB steps, 0x01 = muted.
 * Decision: 0x34 is −102 dB, not the table's "−96.0 dB": the stated step is 0.5 dB, Fig. 9 gives the
 * range as "+0 dB/−102 dB", and −96 dB is the speaker table's value at 0x40 (§7.21), so the HP row is
 * a copy-paste slip. Codes 0x02–0x33 (and the positive half) are unlisted; they floor at −102 dB like
 * MSTxVOL's unlisted codes, since the HP volume has no positive gain.
 */
function headphoneGain(code: number) {
  if (code === 0x00) return 1
  if (code === 0x01) return 0
  return code < 0x80 ? gain(-204) : gain(code - 256)
}
/**
 * BPVOL[4:0] (§7.16.2): 2 dB steps, 00110 = +6 dB … 00000 = −6 dB, 11111 = −8 dB … 00111 = −56 dB.
 * Decision: the table only gives end points; the mapping below is the one 2 dB ladder through all
 * four listed points (the datasheet states no formula).
 */
function beepGain(code: number) {
  const c = code & 0x1f
  return 10 ** ((c <= 6 ? -6 + 2 * c : -6 - 2 * (32 - c)) / 20)
}

type Warning = { message: string; time: number }

export class Cs43l22 extends I2cSlave {
  readonly pins: readonly string[]
  readonly outputs: readonly string[]
  private readonly pinMap: Cs43l22Pins
  private readonly opts: Required<Cs43l22Options>

  /** The register file as the control port reads it back. */
  private regs = new Uint8Array(128)
  /** The settings in effect: equal to `regs` except while FREEZE holds changes (§7.11.3). */
  private active = new Uint8Array(128)
  private status = 0
  private map = 0
  private incr = false
  private expectMap = false
  private initStep = 0

  private now = 0
  private inReset = true
  private resetFellAt: number | null = null
  private resetRoseAt = -Infinity
  private startAt = -Infinity
  private address7 = 0x4a
  private lastSclRise = -Infinity

  private powered = false
  private synced = false
  private clockOk = false
  private speed: Speed = "SSM"
  private ratio = 0
  private rate = 0
  private powerDownAt: number | null = null

  // Serial port state.
  private mclkCount = 0
  private mclkHz = 0
  private lastMclk = -Infinity
  private sclkCount = 0
  private sclkLevel = false
  private sdin = false
  private lrck = false
  private lastLrckRise: number | null = null
  private prevLr = false
  private slotValid = false
  private acc = 0
  private count = 0
  private pendingLeft: number | null = null
  private lastFrameAt: number | null = null

  // Beep generator (§4.2.1).
  private beepMode = 0
  private beepOn = false
  /** Seconds at the nominal Fs left in the current on/off phase. */
  private beepLeft = 0
  private beepFirstCycle = false
  private beepInterrupted = false
  private beepPhase = 0

  // Output.
  private left: number[] = []
  private right: number[] = []
  private outRate = 0
  private lastPressure = 0
  private played = 0
  private warnings = new Map<string, Warning>()

  constructor(object: string, pins: Cs43l22Pins, options: Cs43l22Options = {}) {
    super(object, pins.sda, pins.scl)
    this.pinMap = pins
    this.pins = [pins.sda, pins.scl, pins.reset, pins.mclk, pins.sclk, pins.sdin, pins.lrck]
    this.outputs = [pins.sda]
    this.opts = { revision: 3, ad0: false, spkrHp: false, va: 2.5, vl: 3.0, vp: 3.0, ...options }
    this.reset()
  }

  // --- DigitalPart ---------------------------------------------------------------------------

  /** Board props carry nothing for the codec: the options are fixed by the board wiring. */
  configure(_props: Record<string, string>) {}

  reset() {
    super.reset()
    this.inReset = true
    this.resetFellAt = null
    this.resetRoseAt = -Infinity
    this.loadDefaults()
    this.left = []
    this.right = []
    this.played = 0
    this.lastPressure = 0
    this.warnings.clear()
    this.mclkHz = 0
    this.lastMclk = -Infinity
    this.lastLrckRise = null
    this.lastFrameAt = null
    this.sclkLevel = false
    this.sdin = false
    this.lrck = false
    this.prevLr = false
  }

  prime(levels: Map<string, boolean>, time: number) {
    const p = this.pinMap
    if (levels.has(p.sdin)) this.sdin = levels.get(p.sdin)!
    if (levels.has(p.lrck)) this.lrck = this.prevLr = levels.get(p.lrck)!
    if (levels.has(p.sclk)) this.sclkLevel = levels.get(p.sclk)!
    if (levels.get(p.reset)) this.releaseReset(time)
  }

  /** VIL ≤ 0.30·VL, VIH ≥ 0.65·VL for VL above 2.0 V (p.10). */
  thresholds(): [falling: number, rising: number] {
    return [0.3 * this.opts.vl, 0.65 * this.opts.vl]
  }

  input(pin: string, level: boolean, time: number) {
    this.now = time
    const p = this.pinMap
    if (this.powerDownAt !== null && pin !== p.mclk) this.checkMclkStop(time)
    switch (pin) {
      case p.scl:
        if (level) {
          // fSCL ≤ 100 kHz (p.17). Decision: the port still works above it (warning only); the datasheet does not say what fails.
          if (time - this.lastSclRise < 9.9e-6) this.warn("i2c-speed", `SCL period ${(1e6 * (time - this.lastSclRise)).toFixed(2)} µs: the CS43L22 control port is specified to 100 kHz (p.17)`)
          this.lastSclRise = time
        }
        super.input(pin, level, time)
        return
      case p.sda:
        super.input(pin, level, time)
        return
      case p.reset:
        if (level) this.releaseReset(time)
        else this.holdReset(time)
        return
      case p.mclk:
        if (level) {
          this.mclkCount++
          this.lastMclk = time
        }
        return
      case p.sclk: {
        const was = this.sclkLevel
        this.sclkLevel = level
        if (was === level) return
        // Data is clocked in on the rising edge of SCLK (§4.7); INV_SCLK inverts it (§7.5.2).
        const inverted = (this.active[0x06] & 0x40) !== 0
        if (level !== inverted) this.capture(time)
        return
      }
      case p.sdin:
        this.sdin = level
        return
      case p.lrck:
        if (level && !this.lrck) this.onLrckRise(time)
        this.lrck = level
        return
    }
  }

  protected setSda(level: boolean | null, time: number) {
    // Held in reset, the codec never drives SDA (§4.8: the control port is accessible once RESET is high).
    super.setSda(this.inReset ? null : level, time)
  }

  snapshot() {
    const g = HPGAIN[this.active[0x0d] >> 5]
    return {
      address: this.address7,
      reset: this.inReset,
      powered: this.powered,
      synced: this.synced,
      initDone: this.initStep === INIT_STEPS.length,
      rate: this.rate,
      mclkRatio: this.ratio,
      speed: this.speed,
      format: this.formatName(),
      headphones: [this.hpOn(0), this.hpOn(1)],
      fullScaleVpp: 2 * g * MI * this.opts.va,
      played: this.played,
      regs: Array.from(this.regs.subarray(0, 0x35)),
      warnings: [...this.warnings.values()].map((w) => w.message),
    }
  }

  // --- Audio out ------------------------------------------------------------------------------

  /** Samples the DAC has played since the last call, per channel, in [-1, 1] after volume/mute, with the deduced sample rate. */
  takeAudio(): { rate: number; left: Float32Array; right: Float32Array } {
    const out = { rate: this.outRate || this.rate, left: Float32Array.from(this.left), right: Float32Array.from(this.right) }
    this.left = []
    this.right = []
    return out
  }

  /**
   * Sound pressure for the bench audio (the loop sums `pressure()` of its parts at 1/DT): the
   * headphone voltage, with the full-scale output at HPGAIN 110 (G = 1.000) as the bench full scale.
   */
  pressure(): number {
    return this.lastPressure
  }

  pitch(): number | null {
    return null
  }

  /**
   * Word-level feed for a host that hands over whole I²S frames instead of SCLK/SDIN edges: two
   * signed `bits`-wide samples at `time`. Goes through the same clock check (MCLK from `setMclk`)
   * and signal chain as the bit-level receiver.
   */
  receiveFrame(left: number, right: number, bits: number, time: number) {
    this.now = time
    if (this.powerDownAt !== null) this.checkMclkStop(time)
    if (this.lastFrameAt !== null) {
      const period = time - this.lastFrameAt
      if (period > 0) this.clockPeriod(period, this.mclkHz * period, 0)
    }
    this.lastFrameAt = time
    const full = 2 ** (bits - 1)
    this.emit(left / full, right / full)
  }

  /** MCLK as a frequency, for a host that does not toggle the MCLK pin edge by edge (0: stopped). */
  setMclk(hz: number, time: number) {
    this.now = time
    if (hz <= 0 && this.mclkHz > 0) this.mclkStopped(time)
    this.mclkHz = Math.max(0, hz)
  }

  // --- Reset pin (§4.8, §5.1, p.16) ------------------------------------------------------------

  private holdReset(time: number) {
    if (this.inReset) return
    // RESET low releases SDA at once and puts every register back to its default (§4.10 step 6).
    this.setSda(null, time)
    this.inReset = true
    this.resetFellAt = time
    this.loadDefaults()
    this.lastPressure = 0
  }

  private releaseReset(time: number) {
    if (!this.inReset) return
    // RESET low pulse ≥ 1 ms (p.16). Decision: a shorter pulse still resets (warning only): the
    // registers clear asynchronously; the 1 ms is about supplies and clocks settling (Note 11).
    if (this.resetFellAt !== null && time - this.resetFellAt < 1e-3) this.warn("reset-pulse", `RESET was low for ${(1e6 * (time - this.resetFellAt)).toFixed(0)} µs: the CS43L22 needs at least 1 ms (p.16)`)
    this.inReset = false
    this.resetRoseAt = time
    // AD0 is sensed on the RESET rising edge (§5.1); chip address 100101 + AD0.
    this.address7 = 0x4a | (this.opts.ad0 ? 1 : 0)
  }

  private loadDefaults() {
    this.regs.fill(0)
    for (const [r, v] of Object.entries(RESET_VALUES)) this.regs[Number(r)] = v
    this.regs[0x01] = 0xe0 | (this.opts.revision & 7)
    this.active.set(this.regs)
    this.status = 0
    this.map = 0
    this.incr = false
    this.initStep = 0
    this.powered = false
    this.synced = false
    this.clockOk = false
    this.powerDownAt = null
    this.pendingLeft = null
    this.slotValid = false
    this.count = 0
    this.acc = 0
    this.beepMode = 0
    this.beepOn = false
    this.beepLeft = 0
    this.beepFirstCycle = false
    this.beepInterrupted = false
  }

  // --- I²C control port (§5.1) -----------------------------------------------------------------

  protected onStart() {
    this.startAt = this.now
  }

  protected address() {
    if (this.inReset) return -1
    // RESET rising edge to START ≥ tirs = 550 ns (p.17). Decision: an earlier START is not seen (no
    // ACK): the port is not guaranteed to be out of reset before tirs.
    if (this.startAt - this.resetRoseAt < 550e-9) {
      this.warn("tirs", "I²C START less than 550 ns after RESET rose (tirs, p.17): not acknowledged")
      return -1
    }
    return this.address7
  }

  protected onSelected(read: boolean) {
    // After the address with R/W = 0 the next byte is the MAP (§5.1); a read starts at the current MAP.
    this.expectMap = !read
  }

  protected onByte(byte: number) {
    if (this.inReset) return
    if (this.expectMap) {
      // MAP bit 7 = INCR, MAP[6:0] = register (§5.1.1, Fig. 16).
      this.expectMap = false
      this.incr = (byte & 0x80) !== 0
      this.map = byte & 0x7f
      return
    }
    this.writeRegister(this.map, byte)
    if (this.incr) this.map = (this.map + 1) & 0x7f
  }

  protected nextByte() {
    if (this.inReset) return 0xff
    // Decision on the read cycle: the p.34 pseudocode has the host ACK the byte, Fig. 17 shows NO
    // ACK. The model follows standard I²C, which both satisfy for a single byte: an ACK asks for the
    // next byte (from MAP+1 with INCR, the same register without), a NACK ends the read. After an ACK
    // the codec drives that next byte's MSB, so a STOP only gets through if that bit is 1, as on
    // any I²C slave.
    const value = this.readRegister(this.map)
    if (this.incr) this.map = (this.map + 1) & 0x7f
    return value
  }

  private readRegister(r: number) {
    switch (r) {
      case 0x2e: {
        // Status: set bits mean "happened at least once since the last read"; reading clears them (§7.26).
        const value = this.status
        this.status = 0
        return value
      }
      case 0x30: {
        // VPLVL (§7.28): VP = code·VA/63.3, while the VP ADC runs (VPMONITOR, or forced on by BATTCMP, §7.27.2).
        // Decision: reads 0 (its reset value) while the ADC is off.
        const on = (this.active[0x2f] & 0xc0) !== 0
        return on ? Math.min(255, Math.round((this.opts.vp * 63.3) / this.opts.va)) : 0
      }
      case 0x31:
        // Speaker status (§7.29): SPKR/HP pin level in bit 3; SPKxSHRT never set (speaker outputs unconnected).
        return this.opts.spkrHp ? 0x08 : 0
      default:
        return this.regs[r]
    }
  }

  private writeRegister(r: number, value: number) {
    // Decision: writes to read-only registers are acknowledged and dropped. The datasheet only says
    // they are read only; I²C slaves of this family ACK every data byte.
    if (READ_ONLY.has(r)) return
    // §4.11 required initialization settings, tracked in order.
    if (this.initStep < INIT_STEPS.length) {
      const [reg, ok] = INIT_STEPS[this.initStep]
      if (reg === r && ok(value)) this.initStep++
    }
    // Decision: reserved registers and bits latch what is written (the §4.11 sequence relies on
    // reserved 0x32 holding a written bit), and the model warns, since §7 says they "must maintain
    // their default value". 0x00, 0x47 and anything past 0x34 are outside the map; they are stored
    // and read back as written (§4.11 writes 0x00 and 0x47; nothing documents a read of them).
    const initReg = r === 0x00 || r === 0x47 || r === 0x32
    if (!initReg && (RESERVED_REGS.has(r) || r > 0x34) && value !== this.regs[r]) this.warn(`reserved-${r}`, `Write 0x${value.toString(16)} to reserved register 0x${r.toString(16)} (§6: reserved, keep the default)`)
    const mask = RESERVED_BITS[r]
    if (mask && (value & mask) !== ((RESET_VALUES[r] ?? 0) & mask)) this.warn(`reserved-bits-${r}`, `Register 0x${r.toString(16)}: reserved bits changed (§7: must keep their default)`)
    this.regs[r] = value
    if (r === 0x0e) {
      // FREEZE (§7.11.3): "modifications may be made to all control port registers without the
      // changes taking effect until after the FREEZE is disabled". Decision: 0x0E itself always takes
      // effect (else FREEZE could never be cleared); read-back shows the written values at once.
      const wasFrozen = (this.active[0x0e] & 0x08) !== 0
      this.commit(0x0e)
      if (wasFrozen && (value & 0x08) === 0) for (let k = 0; k < 128; k++) if (this.active[k] !== this.regs[k]) this.commit(k)
      return
    }
    if ((this.active[0x0e] & 0x08) === 0) this.commit(r)
  }

  /** A register's written value takes effect. */
  private commit(r: number) {
    const was = this.active[r]
    const value = this.regs[r]
    this.active[r] = value
    if (r === 0x02) this.powerControl(value)
    else if (r === 0x1e && (was & 0xc0) !== (value & 0xc0)) this.beepControl(value >> 6)
    if (r === 0x0e && (value & 0x04)) this.warn("deemph", "DEEMPH set: de-emphasis is not modelled (§7.11.4)")
    if (r === 0x1e && (value & 0x01)) this.warn("tone", "TC_EN set: bass/treble tone control is not modelled (§7.17.5)")
    if (r === 0x28 && (value & 0x80)) this.warn("limiter", "LIMIT set: the limiter is not modelled (§7.24)")
    if (r === 0x0e && (value & 0xc0)) this.warn("passthru", "PASSTHRUx set: analog passthrough is not modelled (§7.11.1)")
    if (r === 0x06 && (value & 0x80)) this.warn("master", "M/S = 1: master mode is not modelled; the codec drives no clocks (§7.5.1)")
    if (r === 0x06 && (value & 0x0c) === 0x0c) this.warn("dacdif", "DACDIF = 11 is reserved (§7.5.4)")
    if (r === 0x06 && (value & 0x10) && (value & 0x0c) !== 0) this.warn("dsp-lj", "DSP mode needs DACDIF = Left-Justified (§7.5.3 note 2)")
  }

  // --- Power (§4.9, §4.10, §7.2) ---------------------------------------------------------------

  private powerControl(pdn: number) {
    // PDN[7:0] (§7.2.1): 0x9E powered up; 0x01 and 0x9F powered down. Decision: the reserved codes
    // power down too (warning): the datasheet lists only 0x9E as "Powered Up".
    if (pdn !== PDN_UP && pdn !== 0x01 && pdn !== 0x9f) this.warn("pdn", `Power Ctl 1 = 0x${pdn.toString(16)} is a reserved code (§7.2.1); treated as powered down`)
    const up = pdn === PDN_UP
    if (up === this.powered) return
    this.powered = up
    this.synced = false
    this.clockOk = false
    this.pendingLeft = null
    if (up) {
      // Decision: without the §4.11 settings the codec still plays (warning): the datasheet says only
      // that the performance figures were measured with them, and gives no effect to model.
      if (this.initStep < INIT_STEPS.length) this.warn("init", "Powered up (0x02 = 0x9E) without the §4.11 required initialization settings (0x00 = 0x99, 0x47 = 0x80, 0x32 bit 7 pulsed, 0x00 = 0x00)")
      // SPCLKERR reads 1 on initial power-up while the serial port re-synchronizes (§7.26.1 note).
      this.status |= SPCLKERR
      this.powerDownAt = null
    } else {
      this.powerDownAt = this.now
      this.lastPressure = 0
    }
  }

  /** §4.10 step 4: MCLK must keep running ≥ 100 µs after 0x9F. */
  private checkMclkStop(time: number) {
    const since = this.powerDownAt!
    if (this.mclkHz > 0 || this.lastMclk === -Infinity) {
      if (time - since >= 100e-6) this.powerDownAt = null
      return
    }
    // MCLK edges stopped: no edge for 1 µs (the slowest MCLK in §9 is 6.144 MHz).
    if (time - this.lastMclk > 1e-6) {
      if (this.lastMclk - since < 100e-6) this.mclkStopped(this.lastMclk)
      this.powerDownAt = null
    }
  }

  private mclkStopped(time: number) {
    if (this.powered || (this.powerDownAt !== null && time < this.powerDownAt)) this.warn("mclk-stop", "MCLK stopped while the CS43L22 is powered up (§4.10: power down with 0x9F first)")
    else if (this.powerDownAt !== null && time - this.powerDownAt < 100e-6)
      this.warn("mclk-early", `MCLK removed ${(1e6 * (time - this.powerDownAt)).toFixed(0)} µs after power-down: §4.10 step 4 requires at least 100 µs (the HP amp can drive to +VHP, clicks)`)
  }

  private hpOn(channel: 0 | 1) {
    // PDN_HPx (§7.3.1): 00 on while SPKR/HP is LO, 01 on while HI, 10 always on, 11 always off.
    // INV_SWCH (§7.6.2) inverts the pin's sense.
    const code = (this.active[0x04] >> (channel === 0 ? 4 : 6)) & 3
    const pin = this.opts.spkrHp !== ((this.active[0x07] & 0x08) !== 0)
    return code === 2 || (code === 0 && !pin) || (code === 1 && pin)
  }

  // --- Serial port clocks (§4.6, §4.8, §7.4, §9) ----------------------------------------------

  private onLrckRise(time: number) {
    // §4.9 step 5: "LRCK may only be applied … while the PDN bit is set to 1" (powered down).
    if (this.powered && (this.lastLrckRise === null || time - this.lastLrckRise > 10e-3))
      this.warn("lrck-late", "LRCK started while powered up: §4.9 step 5 says to start it while 0x02 holds a power-down code (the model plays anyway)")
    if (this.lastLrckRise !== null) {
      const period = time - this.lastLrckRise
      // MCLK occurrences are counted over one LRCK period (§4.8); `setMclk` stands in for edges.
      const ratio = this.mclkCount > 0 ? this.mclkCount : this.mclkHz * period
      this.clockPeriod(period, ratio, this.sclkCount)
    }
    this.lastLrckRise = time
    this.mclkCount = 0
    this.sclkCount = 0
  }

  /** One LRCK period measured: Fs, the MCLK:LRCK ratio and the SCLKs in it. */
  private clockPeriod(period: number, ratio: number, sclks: number) {
    this.rate = Math.round(1 / period)
    this.ratio = Math.round(ratio)
    if (!this.powered) return
    // SCLK ≤ 64·Fs in slave mode (p.16).
    if (sclks > 65) this.warn("sclk", `${sclks} SCLK per LRCK: the CS43L22 accepts at most 64·Fs (p.16)`)
    const auto = (this.active[0x05] & 0x80) !== 0
    let ok = false
    if (this.ratio === 0) {
      // §4.8: the DAC and the ratio detection run from MCLK. Decision: without MCLK nothing plays.
      this.warn("mclk", "MCLK absent while the CS43L22 is powered up: no audio (§4.8)")
    } else if (auto) {
      // AUTO = 1: speed from the MCLK:LRCK ratio, after MCLKDIV2 (§7.4.1, §7.4.6, §9.1; the starred
      // 2× ratios need MCLKDIV2). Decision: any listed internal ratio is accepted whatever Fs is, and
      // selects the speed mode by ratio. The Fs groups of §9.1 are examples, and the ratio is what the
      // detector counts (§4.8).
      const internal = this.active[0x05] & 0x01 ? ratio / 2 : ratio
      const hit = AUTO_RATIOS.find(([r]) => near(internal, r))
      if (hit) {
        ok = true
        this.speed = hit[1]
      }
    } else {
      this.speed = SPEED_BITS[(this.active[0x05] >> 5) & 3]
      // Table 1 settings (VIDEOCLK, RATIO ≠ 00) are not checked: see NOT_MODELLED.
      ok = (this.active[0x05] & 0x0e) !== 0 || MANUAL_RATIOS[this.speed].some((r) => near(ratio, r))
    }
    if (this.ratio !== 0 && !ok) this.warn("ratio", `MCLK:LRCK ratio ${this.ratio} is not valid for Clocking Ctl 0x${this.active[0x05].toString(16)} (§9): SPCLKERR, no audio`)
    // SPCLKERR: the MCLK/LRCK ratio is not valid (§7.26.1). Decision: the DAC plays nothing while it
    // is invalid, as the serial port cannot synchronize.
    if (!ok) this.status |= SPCLKERR
    this.clockOk = ok
    // Normal operation begins once the ratio has been measured over one LRCK period (§4.8).
    this.synced = ok
    if (ok) this.outRate = this.rate
  }

  // --- Serial data (§4.7, §7.5) --------------------------------------------------------------

  private formatName() {
    const c = this.active[0x06]
    if (c & 0x10) return "DSP"
    return ["LJ", "I2S", "RJ", "reserved"][(c >> 2) & 3]
  }

  /** A capturing SCLK edge: sample LRCK and SDIN. */
  private capture(_time: number) {
    this.sclkCount++
    const c = this.active[0x06]
    if (c & 0x80) return
    const lr = this.lrck
    const d = this.sdin ? 1 : 0
    const changed = lr !== this.prevLr
    this.prevLr = lr
    if (c & 0x10) {
      // DSP mode (§4.7.1): LRCK is a frame sync; the MSB comes on the first SCLK rising edge after
      // its rising edge, left then right packed. AWL 00/01/10/11 = 32/24/20/16 bits (§7.5.5).
      const bits = [32, 24, 20, 16][c & 3]
      if (changed && lr) {
        this.slotValid = true
        this.acc = 0
        this.count = 0
      }
      if (!this.slotValid || this.count >= 2 * bits) return
      this.acc = this.acc * 2 + d
      this.count++
      if (this.count === bits) {
        this.pendingLeft = this.signed(this.acc, bits)
        this.acc = 0
      } else if (this.count === 2 * bits && this.pendingLeft !== null) {
        const l = this.pendingLeft
        this.pendingLeft = null
        this.emit(l, this.signed(this.acc, bits))
      }
      return
    }
    const dif = (c >> 2) & 3
    if (dif === 1) {
      // I²S (§4.7 Fig. 12): LRCK low = left; the MSB one SCLK after the LRCK edge, so the bit on the
      // edge where LRCK is first seen changed is the previous word's LSB.
      this.shiftIn(d, 24)
      if (changed) this.endSlot(lr)
      return
    }
    // Left-/Right-Justified (Fig. 13, 14): LRCK high = left; LJ has the MSB on the first edge after
    // the LRCK edge, RJ the LSB on the last edge before it.
    if (changed) this.endSlot(lr === false)
    this.shiftIn(d, dif === 2 ? [24, 20, 18, 16][c & 3] : 24)
  }

  /** One bit into the slot: LJ/I²S keep the first (up to) 24 bits MSB first, RJ keeps the last `keep`. */
  private shiftIn(d: number, keep: number) {
    const rj = !(this.active[0x06] & 0x10) && ((this.active[0x06] >> 2) & 3) === 2
    if (rj) {
      this.acc = (this.acc * 2 + d) % 2 ** keep
      this.count = Math.min(this.count + 1, keep)
    } else if (this.count < keep) {
      this.acc = this.acc * 2 + d
      this.count++
    }
  }

  /** The slot that just ended was the left channel (`left`) or the right. */
  private endSlot(left: boolean) {
    const valid = this.slotValid && this.count > 0
    const value = valid ? this.signed(this.acc, this.count) : 0
    this.slotValid = true
    this.acc = 0
    this.count = 0
    if (!valid) return
    if (left) this.pendingLeft = value
    else if (this.pendingLeft !== null) {
      const l = this.pendingLeft
      this.pendingLeft = null
      this.emit(l, value)
    }
  }

  /** Two's complement data (§4.7), MSB-aligned: n bits → [-1, 1). */
  private signed(raw: number, n: number) {
    const full = 2 ** (n - 1)
    return (raw >= full ? raw - 2 * full : raw) / full
  }

  // --- Signal chain (§4.2 Fig. 5) -------------------------------------------------------------

  private emit(l: number, r: number) {
    if (!this.powered || !this.synced || !this.clockOk || this.inReset) return
    const a = this.active
    // PLYBCKB=A (§7.10.2): channel A's volume settings drive both channels; "Mute is not affected".
    const gang = (a[0x0d] & 0x10) !== 0
    const vol = (reg: number, ch: 0 | 1) => a[gang ? reg : reg + ch]

    // 1. PCMxVOL / PCMxMUTE (§7.14), INV_PCMx (§7.10.3); clipping latches PCMxOVFL (§7.26.3).
    const pcm = (x: number, ch: 0 | 1) => {
      if (a[0x1a + ch] & 0x80) return 0
      let y = x * pcmGain(vol(0x1a, ch))
      if (a[0x0d] & (ch === 0 ? 0x04 : 0x08)) y = -y
      if (Math.abs(y) > 1) {
        this.status |= ch === 0 ? PCMAOVFL : PCMBOVFL
        y = Math.sign(y)
      }
      return y
    }
    const pl = pcm(l, 0)
    const pr = pcm(r, 1)
    // 2. PCMxSWP (§7.22): 00 own channel, 01 (L+R)/2, 11 the other channel. Decision: code 10, which
    // has no row text, mixes like 01 (the table row appears merged with it).
    const swp = (code: number, own: number, other: number) => (code === 0 ? own : code === 3 ? other : (own + other) / 2)
    let x = [swp(a[0x26] >> 6, pl, pr), swp((a[0x26] >> 4) & 3, pr, pl)]
    // 3. Beep (§4.2.1), mixed or alternated with SDIN (BEEPMIXDIS, §7.17.2).
    const beep = this.beepSample()
    if (beep !== null) x = (a[0x1e] & 0x20) !== 0 ? [beep, beep] : [x[0] + beep, x[1] + beep]
    // 4–6. Tone control, de-emphasis, limiter: not modelled (pass through).
    const out = [0, 0]
    for (const ch of [0, 1] as const) {
      // 7. MSTxVOL / MSTxMUTE (§7.19, §7.10.4). Decision: MSTxMUTE mutes, the table's "Not Inverted /
      // Inverted" rows are a copy-paste of INV_PCMx. Clipping after the DSP latches DSPxOVFL (§7.26.2).
      let y = a[0x0d] & (ch === 0 ? 0x01 : 0x02) ? 0 : x[ch] * masterGain(vol(0x20, ch))
      if (Math.abs(y) > 1) {
        this.status |= ch === 0 ? DSPAOVFL : DSPBOVFL
        y = Math.sign(y)
      }
      // 8a. DAC → HPxVOL (§7.20), HPxMUTE (§7.12.1), headphone channel power (§7.3).
      if (a[0x0f] & (ch === 0 ? 0x40 : 0x80) || !this.hpOn(ch)) y = 0
      else y *= headphoneGain(vol(0x22, ch))
      out[ch] = y
    }
    this.left.push(out[0])
    this.right.push(out[1])
    // Keep at most ~2 s per channel if nobody drains.
    if (this.left.length > 1 << 18) {
      this.left.splice(0, this.left.length - (1 << 17))
      this.right.splice(0, this.right.length - (1 << 17))
    }
    this.played++
    // Headphone voltage: full scale is 2·G·MI·VA Vpp (p.11); the bench's full scale is G = 1.000.
    const g = HPGAIN[a[0x0d] >> 5]
    this.lastPressure = ((out[0] + out[1]) / 2) * g * FULL_SCALE_PASCALS
  }

  // --- Beep generator (§4.2.1, §7.15–7.17) ----------------------------------------------------

  private beepControl(mode: number) {
    const prev = this.beepMode
    this.beepMode = mode
    const on = BEEP_ON[this.active[0x1c] & 0x0f]
    if (mode === 0) {
      this.beepInterrupted = this.beepOn && this.beepFirstCycle
      this.beepOn = false
      return
    }
    this.beepOn = true
    this.beepPhase = 0
    // Re-engaging before the first cycle has completed keeps the beep on for the maximum ONTIME
    // (§7.17.1 note 2).
    if (prev === 0 && this.beepInterrupted) {
      this.beepInterrupted = false
      this.beepFirstCycle = true
      this.beepLeft = BEEP_ON[15]
      return
    }
    this.beepFirstCycle = mode !== 3
    this.beepLeft = on
  }

  /** The beep's sample this frame, or null while silent. */
  private beepSample(): number | null {
    if (this.beepMode === 0) return null
    // Frequency and times are given at the nominal Fs of each speed mode and scale with the actual Fs
    // (§7.15.1 note 2, §7.15.2 note 2, §7.16.1 note 2): count in frames at the nominal rate.
    // Decision: OFFTIME, tabulated "Fs = 48 or 96 kHz" only, scales the same way at 12/24 kHz.
    const nominal = NOMINAL_FS[this.speed]
    const step = 1 / nominal
    if (this.beepMode !== 3) {
      this.beepLeft -= step
      if (this.beepLeft < -1e-12) {
        if (this.beepMode === 1) {
          this.beepOn = false
          this.beepFirstCycle = false
          this.beepLeft = Infinity
        } else {
          this.beepOn = !this.beepOn
          this.beepFirstCycle = false
          this.beepLeft += this.beepOn ? BEEP_ON[this.active[0x1c] & 0x0f] : BEEP_OFF[this.active[0x1d] >> 5]
        }
      }
    }
    if (!this.beepOn) return null
    // Decision: a sine at BPVOL relative to digital full scale; the datasheet gives neither the
    // waveform nor the reference level.
    const hz = BEEP_HZ[this.active[0x1c] >> 4]
    const value = Math.sin(2 * Math.PI * this.beepPhase) * beepGain(this.active[0x1d])
    this.beepPhase = (this.beepPhase + hz / nominal) % 1
    return value
  }

  private warn(key: string, message: string) {
    if (this.warnings.has(key)) return
    this.warnings.set(key, { message, time: this.now })
  }
}
