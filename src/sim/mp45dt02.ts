/**
 * ST MP45DT02 PDM MEMS microphone (STM32F4-Discovery MB997 B-01…D-01, U9).
 *
 * Source: ST datasheet DocID018658 Rev 8, January 2016 (`mp45dt02.pdf`). Section, table and
 * figure numbers below refer to it. The board ties LR to GND (R63), feeds CLK from PB10
 * (I2S2_CK) and reads DOUT on PC3 (I2S2_SD), VDD = 3 V (MB997 C-01 schematic, sheet 4).
 *
 * The part has no registers: a clock goes in, a 1-bit pulse-density stream of the sound pressure
 * comes out, one bit per CLK period (§2.2, §5).
 */
import type { DigitalEdge, DigitalPart } from "./digital-part"
import { formatSI } from "./units"

export type Mp45dt02Pins = { clk: string; dout: string }

/** LR pin strap (§5.1, Table 7). The Discovery board straps it to GND. */
export type Mp45dt02Channel = "gnd" | "vdd"

export type Mp45dt02Mode = "power-down" | "wake-up" | "active"

export type Mp45dt02Snapshot = {
  mode: Mp45dt02Mode
  /** CLK frequency measured from the last two falling edges, 0 before two. */
  clockHz: number
  /** CLK high time over period, from the last full period. */
  duty: number
  /** Seconds of wake-up left (Table 3, T_WK), 0 when active or powered down. */
  wakeLeft: number
  warnings: string[]
}

// --- Datasheet numbers ---------------------------------------------------------------------

/** Table 3: sensitivity So, typ −26 dBFS. Reference: 94 dBSPL = 1 Pa rms (see SENSITIVITY_PER_PA). */
const SENSITIVITY_DBFS = -26
/** Table 3: acoustic overload point, 120 dBSPL. */
const AOP_DBSPL = 120
/** Table 3: SNR 61 dB (A-weighted, 1 kHz, 1 Pa). */
const SNR_DB = 61
/** Table 3: T_WK, wake-up time ≤ 10 ms from the first clock edge to valid data (guaranteed by design). */
const T_WK = 10e-3
/** Table 5 / Table 3 note: power-down mode for f_CLK ≤ 0.23 MHz. */
const F_PD = 0.23e6
/** Table 5: normal-mode clock 1 – 3.25 MHz. */
const F_MIN = 1e6
const F_MAX = 3.25e6
/** Table 5: clock duty cycle 40 – 60 %. */
const DUTY_MIN = 0.4
const DUTY_MAX = 0.6
/** Table 5: T_L,EN / T_R,EN ≤ 30 ns, data enabled after the selecting clock edge. */
const T_EN = 30e-9
/** Table 5: T_L,DIS / T_R,DIS ≤ 16 ns, output released after the other clock edge. */
const T_DIS = 16e-9

const P_REF = 20e-6

/*
 * Decision (datasheet silent on the reference SPL and on what 0 dBFS means, Table 3):
 * - The sensitivity is read at 94 dBSPL = 1 Pa rms, the condition Table 3 gives for the SNR.
 * - 0 dBFS is a full-scale sine: peak amplitude equal to the PDM full scale (all ones / all
 *   zeros), the convention ST's PDM application notes use. With it the numbers agree: −26 dBFS
 *   at 94 dBSPL plus 26 dB is exactly 0 dBFS at the 120 dBSPL AOP, so the AOP is where the
 *   modulator input reaches full scale.
 * A sound pressure p (Pa, instantaneous) becomes modulator input p · 10^(−26/20) / √2.
 */
const SENSITIVITY_PER_PA = 10 ** (SENSITIVITY_DBFS / 20) / Math.SQRT2
/** Full-scale modulator input: the AOP's peak pressure (120 dBSPL rms → ·√2), clipped beyond. */
const AOP_PEAK_PA = P_REF * 10 ** (AOP_DBSPL / 20) * Math.SQRT2
/** Input-referred self-noise, Pa rms in the 20 kHz audio band: 1 Pa reference less the SNR. */
const NOISE_PA = 10 ** (-SNR_DB / 20)
const AUDIO_BAND = 20e3
/** Integrator bound: keeps the 2nd-order loop from running away when the input is clipped at full scale. */
const INTEGRATOR_LIMIT = 4
/** How long a warning stays in the snapshot after its cause last happened (as in the other parts). */
const WARNING_HOLD = 0.25

export const NOT_MODELLED: string[] = [
  "Frequency response (Figure 3): flat; the +1–2 dB rise near 8–10 kHz and the low-frequency roll-off are not modelled",
  "Distortion (Table 4: <1 % THD+N at 100 dBSPL, <5 % at 115 dBSPL): the model is linear up to the AOP and hard-clips there",
  "PSR (Table 3, −70 dBFS): supply ripple does not reach the output",
  "Supply (Table 3: Vdd 1.64–3.6 V, Idd 0.65 mA, IddPdn 20 µA): Vdd is not sensed, the part is assumed powered at the board's 3 V; currents are not drawn",
  "Input/output levels VIOL/VIOH, short-circuit current (Table 3): the pins are ideal logic",
  "Absolute maximum ratings, ESD, temperature (Table 6)",
  "Directivity and acoustic port: the sound is a single pressure at the port",
  "Sensitivity spread (Table 3: −29…−23 dBFS): the typical −26 dBFS is used",
  "The real modulator's order and noise shaping (not documented): a 2nd-order 1-bit ΔΣ with white self-noise stands in for it",
]

/** xorshift32 seeded from the object name: the same part on the same bench gives the same bits. */
function seedOf(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++)
    h = Math.imul(h ^ name.charCodeAt(i), 0x01000193)
  return h >>> 0 || 1
}

export class Mp45dt02 implements DigitalPart {
  readonly object: string
  readonly pins: readonly string[]
  readonly outputs: readonly string[]
  readonly out: DigitalEdge[] = []
  private readonly clkPin: string
  private readonly doutPin: string
  private readonly channel: Mp45dt02Channel
  private sound: (t: number) => number = () => 0

  private clk = true
  private mode: Mp45dt02Mode = "power-down"
  private wakeAt = -Infinity
  private lastFall = -Infinity
  private lastRise = -Infinity
  private clockHz = 0
  private duty = 0
  private driven: boolean | null = null
  private time = 0
  // 2nd-order ΔΣ state.
  private v1 = 0
  private v2 = 0
  private y = 1
  private rng = 1
  private spare: number | null = null
  private readonly warnings = new Map<string, { text: string; at: number }>()

  constructor(
    object: string,
    pins: Mp45dt02Pins,
    channel: Mp45dt02Channel = "gnd",
  ) {
    this.object = object
    this.clkPin = pins.clk
    this.doutPin = pins.dout
    this.pins = [pins.clk, pins.dout]
    this.outputs = [pins.dout]
    this.channel = channel
    this.reset()
  }

  /** What the microphone hears: a function of time (s) returning sound pressure in Pa; default silence. */
  setSound(pressure: (t: number) => number): void {
    this.sound = pressure
  }

  configure() {}

  reset() {
    this.mode = "power-down"
    this.wakeAt = -Infinity
    this.lastFall = -Infinity
    this.lastRise = -Infinity
    this.clockHz = 0
    this.duty = 0
    this.driven = null
    this.time = 0
    this.out.length = 0
    this.warnings.clear()
    this.rng = seedOf(this.object)
    this.spare = null
    this.clearModulator()
  }

  drive(pin: string): boolean | null {
    return pin === this.doutPin ? this.driven : null
  }

  input(pin: string, level: boolean, time: number) {
    if (pin !== this.clkPin || level === this.clk) return
    this.clk = level
    this.time = Math.max(this.time, time)
    if (!level) this.onFall(time)
    else this.onRise(time)
    // Table 7 / Figure 2: the channel's bit is enabled after its clock edge (T_EN) and released
    // after the opposite edge (T_DIS). LR = GND: data while CLK is low; LR = Vdd: while high.
    const dataEdge = this.channel === "gnd" ? !level : level
    if (dataEdge) {
      const bit = this.modulate(time)
      if (this.mode === "active") this.set(bit, time + T_EN)
    } else this.set(null, time + T_DIS)
  }

  tick(time: number) {
    this.time = Math.max(this.time, time)
    // Table 5: a clock at or below f_PD, or static, puts the part in power-down.
    // Decision (detection latency not documented): the part notices once a full f_PD period
    // passes without a falling edge, which is the earliest a frequency detector could tell.
    if (this.mode !== "power-down" && time >= this.powerDownAt())
      this.powerDown(this.powerDownAt())
  }

  quietUntil() {
    return this.mode === "power-down" ? Infinity : this.powerDownAt()
  }

  snapshot(): Mp45dt02Snapshot {
    const warnings: string[] = []
    for (const { text, at } of this.warnings.values())
      if (this.time - at <= WARNING_HOLD) warnings.push(text)
    const wakeLeft =
      this.mode === "wake-up" ? Math.max(0, this.wakeAt + T_WK - this.time) : 0
    // Until a second falling edge gives a period, the part cannot tell a real clock from a
    // power-down-range one (Table 5): report it as still powered down.
    const mode =
      this.mode === "wake-up" && this.clockHz === 0 ? "power-down" : this.mode
    return { mode, clockHz: this.clockHz, duty: this.duty, wakeLeft, warnings }
  }

  // --- Clock --------------------------------------------------------------------------------

  private powerDownAt() {
    return this.lastFall + 1 / F_PD
  }

  private onFall(time: number) {
    const period = time - this.lastFall
    // Table 5: a period longer than 1/f_PD is a clock in the power-down range.
    if (this.mode !== "power-down" && period > 1 / F_PD)
      this.powerDown(this.powerDownAt())
    if (this.mode === "power-down") this.wake(time)
    else {
      this.clockHz = 1 / period
      if (this.lastRise > this.lastFall)
        this.duty = (time - this.lastRise) / period
      this.checkClock(time)
    }
    this.lastFall = time
    if (this.mode === "wake-up" && time - this.wakeAt >= T_WK)
      this.mode = "active"
  }

  private onRise(time: number) {
    if (this.mode === "power-down") {
      this.wake(time)
      // Reference for the power-down detector until the first fall.
      this.lastFall = time
    }
    this.lastRise = time
    if (this.mode === "wake-up" && time - this.wakeAt >= T_WK)
      this.mode = "active"
  }

  /** Table 3: T_WK counts from the first clock edge after power-down. */
  private wake(time: number) {
    this.mode = "wake-up"
    this.wakeAt = time
    this.clockHz = 0
    this.duty = 0
    this.clearModulator()
  }

  private powerDown(at: number) {
    this.mode = "power-down"
    this.clockHz = 0
    // Decision (DOUT in power-down is not documented): high impedance. The output stage has no
    // clock to time its data half, and the 20 µA IddPdn (Table 3) leaves no room for a driver.
    this.set(null, at)
  }

  private checkClock(time: number) {
    const f = this.clockHz
    // Decision (0.23–1 MHz is neither power-down nor normal mode in Table 5): the modulator is
    // clocked by CLK, so the silicon keeps producing bits, with less oversampling and an
    // uncharacterised noise floor; the model runs on and warns. Same above 3.25 MHz.
    // A part-per-million margin: edge times are floating-point sums, a 1 MHz clock measures 0.9999… MHz.
    if (f < F_MIN * (1 - 1e-6))
      this.warn(
        "slow",
        `CLK ${formatSI(f, "Hz")} is below the 1 MHz normal-mode minimum (Table 5): performance is not specified`,
        time,
      )
    else if (f > F_MAX * (1 + 1e-6))
      this.warn(
        "fast",
        `CLK ${formatSI(f, "Hz")} is above the 3.25 MHz maximum (Table 5): performance is not specified`,
        time,
      )
    if (this.duty > 0 && (this.duty < DUTY_MIN || this.duty > DUTY_MAX))
      this.warn(
        "duty",
        `CLK duty cycle ${(this.duty * 100).toFixed(0)} % is outside the 40–60 % range (Table 5)`,
        time,
      )
  }

  // --- Modulator ----------------------------------------------------------------------------

  private clearModulator() {
    this.v1 = 0
    this.v2 = 0
    this.y = 1
  }

  /**
   * One PDM bit for the pressure at `time`. A 2nd-order 1-bit ΔΣ (two delaying integrators,
   * feedback into both) — the order is not documented (§2.2 only says PDM), 2nd order is the
   * least that shapes noise out of the audio band at the 2.4 MHz typical clock.
   */
  private modulate(time: number): boolean {
    const p = this.sound(time)
    // Table 3 SNR: white input-referred noise whose 20 kHz in-band share is 1 Pa − 61 dB.
    // Spread over the Nyquist band of this clock (the decision keeps the in-band level fixed).
    const fs = this.clockHz > 0 ? this.clockHz : 2.4e6
    const noise = NOISE_PA * Math.sqrt(fs / 2 / AUDIO_BAND) * this.gauss()
    // Table 3 AOP: the input is clipped at the 120 dBSPL peak (= modulator full scale).
    const pa = Math.max(
      -AOP_PEAK_PA,
      Math.min(AOP_PEAK_PA, (Number.isFinite(p) ? p : 0) + noise),
    )
    const x = pa * SENSITIVITY_PER_PA
    this.v1 = clamp(this.v1 + x - this.y)
    this.v2 = clamp(this.v2 + this.v1 - this.y)
    this.y = this.v2 >= 0 ? 1 : -1
    return this.y > 0
  }

  private gauss(): number {
    if (this.spare !== null) {
      const s = this.spare
      this.spare = null
      return s
    }
    const u = (this.next() + 0.5) / 4294967296
    const v = this.next() / 4294967296
    const r = Math.sqrt(-2 * Math.log(u))
    this.spare = r * Math.sin(2 * Math.PI * v)
    return r * Math.cos(2 * Math.PI * v)
  }

  private next(): number {
    let x = this.rng
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.rng = x >>> 0
    return this.rng
  }

  private set(level: boolean | null, time: number) {
    if (level === this.driven) return
    this.driven = level
    this.out.push({ pin: this.doutPin, level, time })
  }

  private warn(key: string, text: string, time: number) {
    this.warnings.set(key, { text, at: time })
  }
}

function clamp(v: number) {
  return v > INTEGRATOR_LIMIT
    ? INTEGRATOR_LIMIT
    : v < -INTEGRATOR_LIMIT
      ? -INTEGRATOR_LIMIT
      : v
}
