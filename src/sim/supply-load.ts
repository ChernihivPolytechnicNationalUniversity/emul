/** Time constant of the sleep share the circuit sees, s. */
const LOAD_AVERAGED_OVER_SECONDS = 0.01
/** The sleep share and the supply are held in steps of these, moving on past 3/4 of a step. */
const LOAD_SLEEP_SHARE_STEP = 1 / 32
const LOAD_VOLT_STEP = 0.1
const LOAD_HYSTERESIS = 0.75

/**
 * The supply current a core puts on the circuit, which takes it as a resistor of the part's
 * nominal VDD over it (`$idd`): at the held supply V that resistor draws the datasheet's current
 * at V. The sleep share is averaged and held in steps, the supply held in steps, so the resistor
 * follows the firmware's duty and the rail's level but not a step's ripple: a resistor that
 * moves every step has the circuit solved again every step.
 */
export class SupplyLoad {
  private readonly nominal: number
  private asleep = 0
  private share = 0
  private volts = 0
  private time = 0
  private primed = false

  constructor(nominal: number) {
    this.nominal = nominal
  }

  reset() {
    this.primed = false
  }

  /** The share of the time since the last call spent asleep, the core's time and supply now, and the datasheet's current at a share and a supply. */
  next(asleep: number, time: number, vdd: number, at: (asleep: number, volts: number) => number): number {
    if (!this.primed) {
      this.primed = true
      this.asleep = asleep
      this.share = Math.round(asleep / LOAD_SLEEP_SHARE_STEP) * LOAD_SLEEP_SHARE_STEP
      this.volts = Math.round(vdd / LOAD_VOLT_STEP) * LOAD_VOLT_STEP
    } else {
      this.asleep += (asleep - this.asleep) * -Math.expm1(-Math.max(0, time - this.time) / LOAD_AVERAGED_OVER_SECONDS)
      if (Math.abs(this.asleep - this.share) > LOAD_HYSTERESIS * LOAD_SLEEP_SHARE_STEP) this.share = Math.round(this.asleep / LOAD_SLEEP_SHARE_STEP) * LOAD_SLEEP_SHARE_STEP
      if (Math.abs(vdd - this.volts) > LOAD_HYSTERESIS * LOAD_VOLT_STEP) this.volts = Math.round(vdd / LOAD_VOLT_STEP) * LOAD_VOLT_STEP
    }
    this.time = time
    const volts = this.volts > 0 ? this.volts : this.nominal
    return (at(this.share, volts) * this.nominal) / volts
  }
}
