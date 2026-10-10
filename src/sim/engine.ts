import { partKey, type Damage, type PartState } from "@/schematic/types"
import {
  capacityAfterAge,
  capacityAtTemp,
  cellOcv,
  DEAD_SOC,
  drainRate,
  formatDuration,
  packResistance,
  resistanceAfterAge,
  resistanceAtTemp,
  thermalMass,
  thermalResistance,
} from "./battery"
import { GROUND, type GpioState, type Netlist, type Resolved } from "./netlist"
import { bias, dischargeSink, nextLatch, NE555, outputSink, outputSource, quiescent, supplyShare } from "./ne555"
import { SparseLU } from "./sparse-lu"
import { formatSI } from "./units"

const VT = 0.025852
/** Leak from every node to ground; keeps floating nodes solvable. */
const GMIN = 1e-9
/**
 * An arc across open contacts: struck when the gap voltage reaches the switch's strike voltage
 * (an inductive load whose current has nowhere else to go), it then drops V_ARC — the minimum
 * an arc between metal contacts sustains at — plus R_ARC, until the current falls below the
 * holding value and it goes out. A 12 V circuit cannot keep an arc alive on its own; a coil
 * can, until its energy is spent. The drop and resistance are fixed, so the circuit stays
 * linear while it burns; the polarity is the one the gap struck with.
 */
const R_ARC = 20
const V_ARC = 15
const ARC_HOLD = 0.02
/** Re-solves of one step after a gap strikes: the arc changes the circuit the step is solved in. */
const MAX_STRIKES = 3
/**
 * Integration weight for capacitors and inductors: 1 is backward Euler, 0.5 trapezoidal.
 * Backward Euler damps every resonance it meets (a Q of 10 read as 3 at 30 steps a period);
 * pure trapezoidal rings at switching edges. Just past the middle keeps the ringing decaying
 * while a resonance loses only a couple of percent of its Q.
 */
const THETA = 0.52
/** STM32 output driver and weak pull resistances (DS9405: ~40 kΩ pulls). */
const R_GPIO = 25
/** Output resistance of a pad sourcing a voltage (the DAC's buffered output). */
const R_DAC = 100
const R_PULL = 40e3
/** Output resistance of an ideal regulator: keeps two in parallel solvable and sharing. */
const R_REG = 0.01
const REG_MODES = ["regulating", "dropout", "current limit", "off"] as const
const REG_REGULATE = 0
const REG_DROPOUT = 1
const REG_LIMIT = 2
const REG_OPEN = 3
const CHG_VPROG = 1
const CHG_GAIN = 1200
const CHG_TRICKLE = 2.9
const CHG_TRICKLE_HYST = 0.08
const CHG_TERM = 0.1
const CHG_TERM_TIME = 1e-3
const CHG_RECHARGE = 0.15
const CHG_UVLO = 3.8
const CHG_UVLO_HYST = 0.2
const CHG_SLEEP = 0.03
const CHG_WAKE = 0.1
const CHG_OD_R = 60
const CHG_CE = 1.2
const CHG_TEMP_OFF = 0.1
const CHG_TEMP_LOW = 0.45
const CHG_TEMP_HIGH = 0.8
const CHG_OFF = 0
const CHG_TRICKLING = 1
const CHG_CHARGING = 2
const CHG_DONE = 3
const PROT_DRIVE_R = 1e3
const PROT_LOAD = 0.3
const PROT_CHARGE_OFF = 1
const PROT_DISCHARGE_OFF = 2
const PROT_OVERCURRENT_OFF = 4
const PROT_SHORTED = 8
const BOOST_MODES = ["regulating", "current limit", "off", "undervoltage"] as const
const BOOST_REGULATE = 0
const BOOST_LIMIT = 1
const BOOST_IDLE = 2
const BOOST_UVLO = 3
const BOOST_FOLD = 0.2
const BOOST_STEP = 0.5
const BOOST_UVLO_HYST = 0.1
const BOOST_EN = 1.5
const BOOST_DROOP = 1e-4
const TERM_SLOTS = 8
const TMR_HIGH = 1
const TMR_POWERED = 2
const TMR_MAX_EVENTS = 16
const TMR_CAPPED_STEPS = 3
const TMR_REFINE = 3
const TMR_TOLERANCE = 1e-6
const TMR_MIN_STEP = 1e-12
const TMR_RESTART = 0.02
const TMR_KICK = 0.05
const TMR_CONTROLLED_STEPS = 3
const TMR_INPUT_MARGIN = 0.5
const TMR_MARGINS = 4
const TMR_SOURCE_VT = 0.05
const TMR_SOURCE_KNEE = 1.25
const CMOS_VT = 1
const CMOS_STEP = Math.log(1.01)
const MAX_ITER = 60
const MODE_FREEZE = 20
const ABS_TOL = 1e-6
const REL_TOL = 1e-3
/**
 * A circuit that has stopped moving is not solved again until something drives it: after
 * SETTLED_STEPS consecutive steps that moved no node by more than SETTLED_DV and left every
 * capacitor and inductor drifting by less than SETTLED_DRIFT per second, the step is skipped.
 */
const SETTLED_STEPS = 3
const SETTLED_DV = 1e-6
const SETTLED_DRIFT = 1e-3
/** Operating points remembered by switch/pad state (see `solve`). */
const MEMO_POINTS = 64
type OperatingPoint = { v: Float64Array; x: Float64Array; region: Uint8Array; jA: Float64Array; jB: Float64Array; live: Float64Array }
type Timer = Extract<Resolved, { kind: "TMR" }>
type Pad = Extract<Resolved, { kind: "GPIO" }>
const NONLINEAR_KINDS = new Set<Resolved["kind"]>(["D", "Q", "REG", "CHG", "BOOST", "TMR", "M"])
const switchesMask = (el: Resolved) =>
  el.kind === "SW" || el.kind === "GPIO" || (el.kind === "R" && el.live) || el.kind === "BAT" || el.kind === "CHG" || el.kind === "PROT" || el.kind === "TMR"
const SURGE = 20
/** Averaging window for RMS readings in AC circuits: at least this long, and a few periods of the slowest source. */
const RMS_MIN_TAU = 0.05
const RMS_PERIODS = 3

export type Failure = { object: string; damage: Damage; ref: string }

/** Persistence of vision for LED brightness: PWM above ~100 Hz reads as a steady level. */
const LED_EYE_TAU = 0.01
/**
 * Window for a battery's average load, which its time-to-empty estimate divides into the charge
 * left: long enough to cover a sleeping MCU's wake-ups, short enough to follow a changed load.
 * A sliding window of `BAT_AVG_BUCKETS` buckets rather than an exponential average, so a
 * changed load is fully in the figure after the window and the estimate does not creep towards
 * the answer for a minute. Until the run is that old the average is over the whole run.
 */
const BAT_AVG_WINDOW = 10
const BAT_AVG_BUCKETS = 100
const BAT_AVG_BUCKET = BAT_AVG_WINDOW / BAT_AVG_BUCKETS
/** Below this a battery's current is the solver's node leak, not a load. */
const BAT_LEAK = 1e-8
/** A battery's resistance is stepped in 1 % increments as it drains, so a linear circuit keeps its factorization between steps. */
const BAT_R_STEP = Math.log(1.01)
/** Charge forced into a primary cell before it vents, as a fraction of its capacity. */
const PRIMARY_CHARGE_LIMIT = 0.03
/** Cells a pack can have in series (the inspector's slider range); per-cell state is laid out in blocks of this. */
const MAX_CELLS = 20

/** Operating point of one element after a step. */
export type Reading = {
  object: string
  element: number
  kind: Resolved["kind"]
  /** Through-current (collector current for a BJT), amps. */
  current: number
  /** Voltage across (Vce for a BJT), volts. */
  voltage: number
  /** Dissipated power, watts. */
  power: number
  /** Worst load relative to a rating, 0..∞; undefined when unrated. */
  load?: number
  /** Extra values: Vbe, Ib, region for BJTs; wiper etc. */
  extra?: Record<string, string>
  limits?: Resolved["limits"]
  /** An internal element (a transistor's collector resistance): solved, not shown. */
  hidden?: boolean
  /** RMS current and voltage and average power over the last few cycles; only in AC circuits. */
  rms?: { current: number; voltage: number; power: number }
  /** A battery's state of charge, 0..1 (over 1 when overcharged). */
  charge?: number
}

const Q_IS = 1e-14
const Q_VCRIT = VT * Math.log(VT / (Math.SQRT2 * Q_IS))
const Q_BR = 3
const BJT_REGIONS = ["cut-off", "saturation", "reverse", "active"] as const
const MOS_REGIONS = ["off", "ohmic", "reverse", "saturation"] as const

export type PartReader = (key: string) => PartState

/** Whether a switch element conducts given its part's state. */
export function switchClosed(closed: "on" | "pressed" | "off", st: PartState): boolean {
  return closed === "on" ? !!st.on : closed === "off" ? !st.on : !!st.pressed
}
/** What an MCU pad (object, model node) drives right now. */
/** `index` is the element's position in the netlist, for the reader to cache its lookup by. */
export type PinReader = (index: number, object: string, node: string) => GpioState
const NO_PINS: PinReader = () => null
/** GpioState encoded for the per-step array: 0 floating, 1 high, 2 low, 3 pull-up, 4 pull-down. */
const GPIO_CODE: Record<string, number> = { high: 1, low: 2, pullup: 3, pulldown: 4 }
const GPIO_VOLTS = 5

/**
 * What a probe across two nodes reads. Everything but `v` covers the last measuring window —
 * a few cycles — and every solver step in it counts, so an RMS is a real RMS and a peak is
 * the peak rather than whatever the display happened to sample.
 */
export type ProbeReading = {
  /** Instantaneous difference, volts. */
  v: number
  rms: number
  /** Mean over the window, i.e. the DC component. */
  avg: number
  /** Extremes over the window. */
  min: number
  max: number
}

/**
 * A run of oscilloscope samples: `count` buckets of `bucket` seconds starting at `start`,
 * each holding the trough and peak every probe saw in it, laid out [bucket][probe][min, max].
 * Peak detection per bucket rather than plain decimation, so a narrow spike is never missed.
 */
export type TraceChunk = { start: number; bucket: number; count: number; data: Float32Array }

/** What a battery's charge and drain rate (per second, negative when charging) amount to in the inspector. */
function batteryTimeLeft(lo: number, hi: number, rate: number, amps: number, rechargeable: boolean): string {
  // A primary cell being force-charged is not going anywhere; its self-discharge life is beside the point.
  if (amps < 0 && !rechargeable) return "—"
  if (lo <= 0) return rate < 0 && rechargeable ? `empty, full in ${formatDuration((1 - hi) / -rate)}` : "empty"
  if (rate > 0) return formatDuration(lo / rate)
  if (rate < 0) return rechargeable ? (hi >= 1 ? "full" : `full in ${formatDuration((1 - hi) / -rate)}`) : "—"
  return "—"
}

/** SPICE pn-junction voltage limiting: keeps Newton steps from overflowing the exponential. */
function pnjlim(vnew: number, vold: number, vt: number, vcrit: number) {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt
      return arg > 0 ? vold + vt * Math.log(arg) : vcrit
    }
    return vt * Math.log(vnew / vt)
  }
  return vnew
}

/**
 * Transient MNA solver with backward-Euler companions and Newton-Raphson for
 * diodes and BJTs. Small dense matrices, solved by LU with partial pivoting.
 *
 * The step runs thousands of times per second, so it allocates nothing: every per-element
 * quantity lives in a flat array indexed by the element's position in the netlist, and the
 * matrix is factorized in place. Readings are kept as numbers and only turned into objects
 * when something asks for them.
 */
export class Engine {
  readonly size: number
  time = 0
  converged = true
  /** Node voltages (size = nodes), persists between steps. */
  readonly v: Float64Array
  readonly net: Netlist
  /** Parts that broke during the last step; the caller drains this. */
  readonly failures: Failure[] = []
  /** True when any source has an AC component; RMS readings are then kept. */
  readonly ac: boolean
  /** Running mean of the squared node voltages (AC only). */
  readonly v2: Float64Array

  private readonly A: Float64Array
  private readonly z: Float64Array
  private readonly x: Float64Array
  private readonly lu: SparseLU
  /** Newton iterate, reused between steps. */
  private readonly guess: Float64Array
  /** Closest solution seen while iterating, kept in case the iteration runs out of steps. */
  private readonly best: Float64Array

  // --- per-element state, indexed by position in net.elements ---
  /** Capacitor voltage and current, inductor current and voltage after the last step. */
  private readonly capV: Float64Array
  private readonly capI: Float64Array
  private readonly indI: Float64Array
  private readonly indV: Float64Array
  /** Accumulated overload (seconds × excess ratio). */
  private readonly stress: Float64Array
  /** Load against the heating rating each element last ran at, for the settled steps. */
  private readonly rRatio: Float64Array
  /** Last junction voltages used for limiting: [vd | vbe] and [vbc]. */
  private readonly jA: Float64Array
  private readonly jB: Float64Array
  /** Running means of i², v² and p (AC only). */
  private readonly msI: Float64Array
  private readonly msV: Float64Array
  private readonly msP: Float64Array
  private msPrimed = false
  /** Diode currents, instantaneous and averaged (for steady LED brightness on AC). */
  readonly diodeI: Float64Array
  readonly diodeAvg: Float64Array
  /** Battery: per cell (blocks of MAX_CELLS) the state of charge (0..1; below 0 exhausted, above 1 overcharged). */
  private readonly batSoc: Float64Array
  /** Battery: ohmic resistance in force and its 1 % step, pack open-circuit voltage, the two diffusion voltages, cell temperature (°C), charge throughput (A·s, for live cycle wear). */
  private readonly batR: Float64Array
  private readonly batStep: Int32Array
  private readonly batOcv: Float64Array
  private readonly batV1: Float64Array
  private readonly batV2: Float64Array
  private readonly batT: Float64Array
  private readonly batThru: Float64Array
  /**
   * Battery: the sliding window of load — per element, `BAT_AVG_BUCKETS` buckets of charge (A·s)
   * and of drain (soc) for the weakest cell, the bucket being filled and how much of it, and the
   * seconds the element has been solved for (the average covers the whole run until the window fills).
   */
  private readonly batWinI: Float64Array
  private readonly batWinRate: Float64Array
  private readonly batWinAt: Int32Array
  private readonly batWinFill: Float64Array
  private readonly batAge: Float64Array
  /** Battery: charge forced into a primary cell (A·s). */
  private readonly batCharged: Float64Array
  /** Probe node pairs, two entries each; either side may be GROUND. */
  private probeNodes = new Int32Array(0)
  /** Per probe, for the window being filled: sum, sum of squares, trough, peak. */
  private probeAcc = new Float64Array(0)
  /** The same, for the last window that finished; that is what a reading reports. */
  private probeLast = new Float64Array(0)
  private probeSeconds = 0
  private probeSamples = 0
  private probeLastSamples = 0
  /** Oscilloscope bucket length in seconds; 0 when nobody is watching. */
  private traceBucket = 0
  /** Per probe, the trough and peak of the bucket being filled. */
  private traceAcc = new Float64Array(0)
  private traceSeconds = 0
  /** Finished buckets since the last drain, and the time the first of them started. */
  private traceOut: number[] = []
  private traceStart = 0
  // Operating point of every element after the last step.
  private readonly rCurrent: Float64Array
  private readonly rVoltage: Float64Array
  private readonly rPower: Float64Array
  private readonly rLoad: Float64Array
  private readonly rVbe: Float64Array
  private readonly rIb: Float64Array
  private readonly rRegion: Uint8Array
  /** Pad state of every GPIO element for the step in progress, and the volts when it sources a voltage. */
  private readonly gpioState: Uint8Array
  /** While the open gap of a switch element carries an arc: 1 struck with a positive voltage a→b, 2 negative. */
  private readonly arc: Uint8Array
  /** Node voltages before the step, and at the instant a gap struck during it (for the probes and the ratings). */
  private readonly prevV: Float64Array
  private readonly strikeV: Float64Array
  private struck = false
  /** Resistance in force for each element: the model's value, or what the pin reader said for a live R. */
  private readonly ohms: Float64Array
  private readonly gpioVolts: Float64Array
  private readonly ctl: Uint8Array
  private readonly ctlT: Float64Array
  private readonly subV: Float64Array
  private readonly timers: Int32Array
  private readonly burst: Uint8Array
  private readonly burstSeen: Uint8Array
  private readonly capped: Uint8Array
  private readonly scaledPads: Int32Array
  private readonly padSteps: Int32Array
  private readonly branchOut = new Float64Array(2)
  private readonly marginsStart = new Float64Array(TMR_MARGINS)
  private readonly marginsEnd = new Float64Array(TMR_MARGINS)
  private readonly marginsAt = new Float64Array(TMR_MARGINS)
  private eventTimer = -1
  private eventMargin = -1
  private eventFraction = 0
  private eventFrom = 0
  private eventTo = 0
  private eventful = false
  private theta = THETA
  private subSpan = 0
  private subBackward = false
  private switchedAt = 0
  private readonly arcStart: Uint8Array
  private readonly capacitors: Int32Array
  onTimer?: (object: string, high: boolean, time: number) => void

  /** Current leaving the net into an element, per terminal node key. */
  private readonly termCurrent: Float64Array
  private readonly termIndex: Map<string, number>
  private readonly termKeys: string[]
  /** Terminal slots of each element, in the order of its `keys`. */
  private readonly termOf: Int32Array
  private readonly termAt: Int32Array

  /** Element index by id, for carrying state over to a rebuilt engine. */
  private readonly indexOf: Map<string, number>
  /** No diodes or transistors: one solve per step, and the matrix never changes. */
  private readonly linear: boolean
  /** Every switch's part key, built once: the reader is called per element per step. */
  private readonly partKeys: string[]
  /** Indices of the elements read from pads each step: GPIO drivers and live resistors. */
  private readonly padElements: Int32Array
  /** Elements whose exact value the switch mask does not carry: live resistors and DAC-driven pads. */
  private readonly liveElements: Int32Array
  /** No capacitor, inductor or battery: the operating point is a function of the inputs alone. */
  private readonly stateless: boolean
  /** Diodes (their eye average moves every step) and, after each full update, the parts under load or still hot. */
  private readonly diodeElements: Int32Array
  private loadedElements: number[] = []
  private readonly strikeElements: Int32Array
  private readonly limitsOf: (Resolved["limits"] | undefined)[]
  private readonly isDiode: Uint8Array
  private readonly heatDt: Float64Array
  private readonly heatShare: Float64Array
  private readonly junctionElements: Int32Array
  private readonly nonlinearElements: Int32Array
  private readonly maskElements: Int32Array
  /** RMS averaging time constant, seconds. */
  private readonly tau: number
  /** Switch/pad hash of the current step, and how many steps in a row ended at a fixed point. */
  private stepMask = 0
  private settledRun = 0
  private readonly drifting: boolean
  /** The `dt` and switch states `lu` was factorized for; a change invalidates it. */
  private luDt = 0
  private luSwitches = 0
  private luValid = false

  constructor(net: Netlist) {
    this.net = net
    const n = net.nodes
    const m = net.elements.length
    this.size = n + net.sources
    this.v = new Float64Array(n)
    this.v2 = new Float64Array(n)
    this.guess = new Float64Array(n)
    this.best = new Float64Array(this.size)
    this.A = new Float64Array(this.size * this.size)
    this.z = new Float64Array(this.size)
    this.x = new Float64Array(this.size)
    this.lu = new SparseLU(this.size)

    let minFreq = Infinity
    let linear = true
    for (const el of net.elements) {
      if (el.kind === "V" && el.amplitude > 0 && el.frequency < minFreq) minFreq = el.frequency
      if (el.kind === "D" || el.kind === "Q" || el.kind === "M" || el.kind === "REG" || el.kind === "CHG" || el.kind === "PROT" || el.kind === "BOOST" || el.kind === "TMR") linear = false
    }
    this.ac = minFreq < Infinity
    this.tau = this.ac ? Math.max(RMS_MIN_TAU, RMS_PERIODS / minFreq) : 0
    this.linear = linear
    this.partKeys = net.elements.map((el) => (el.kind === "SW" ? partKey(el.object, el.part) : ""))
    this.padElements = Int32Array.from(net.elements.flatMap((el, i) => (el.kind === "GPIO" || (el.kind === "R" && el.live) ? [i] : [])))
    this.diodeElements = Int32Array.from(net.elements.flatMap((el, i) => (el.kind === "D" ? [i] : [])))
    this.limitsOf = net.elements.map((el) => el.limits)
    this.isDiode = Uint8Array.from(net.elements, (el) => (el.kind === "D" ? 1 : 0))
    this.heatDt = new Float64Array(net.elements.length)
    this.heatShare = new Float64Array(net.elements.length)
    this.junctionElements = Int32Array.from(net.elements.flatMap((el, i) => (el.kind === "D" || el.kind === "Q" || el.kind === "TMR" ? [i] : [])))
    this.nonlinearElements = Int32Array.from(net.elements.flatMap((el, i) => (NONLINEAR_KINDS.has(el.kind) ? [i] : [])))
    this.strikeElements = Int32Array.from(net.elements.flatMap((el, i) => (el.kind === "SW" && el.strike !== Infinity ? [i] : [])))
    this.maskElements = Int32Array.from(net.elements.flatMap((el, i) => (switchesMask(el) ? [i] : [])))
    this.liveElements = Int32Array.from(net.elements.flatMap((el, i) => (el.kind === "GPIO" || (el.kind === "R" && el.live) ? [i] : [])))
    this.stateless = !net.elements.some((el) => el.kind === "C" || el.kind === "L" || el.kind === "BAT" || el.kind === "CHG" || el.kind === "PROT" || el.kind === "TMR")
    this.drifting = net.elements.some((el) => el.kind === "BAT" || el.kind === "CHG" || el.kind === "PROT")

    this.capV = new Float64Array(m)
    this.capI = new Float64Array(m)
    this.indI = new Float64Array(m)
    this.indV = new Float64Array(m)
    this.stress = new Float64Array(m)
    this.rRatio = new Float64Array(m)
    this.jA = new Float64Array(m)
    this.jB = new Float64Array(m)
    this.msI = new Float64Array(m)
    this.msV = new Float64Array(m)
    this.msP = new Float64Array(m)
    this.diodeI = new Float64Array(m)
    this.diodeAvg = new Float64Array(m)
    this.rCurrent = new Float64Array(m)
    this.rVoltage = new Float64Array(m)
    this.rPower = new Float64Array(m)
    // −1 is "unrated"; a step that never settled leaves the previous load in place.
    this.rLoad = new Float64Array(m).fill(-1)
    this.rVbe = new Float64Array(m)
    this.rIb = new Float64Array(m)
    this.rRegion = new Uint8Array(m)
    this.gpioState = new Uint8Array(m)
    this.arc = new Uint8Array(m)
    this.prevV = new Float64Array(n)
    this.strikeV = new Float64Array(n)
    this.gpioVolts = new Float64Array(m)
    this.ctl = new Uint8Array(m)
    this.ctlT = new Float64Array(m * 3)
    this.subV = new Float64Array(n)
    this.timers = Int32Array.from(net.elements.flatMap((el, i) => (el.kind === "TMR" ? [i] : [])))
    this.burst = new Uint8Array(m)
    this.burstSeen = new Uint8Array(m)
    this.capped = new Uint8Array(m)
    this.scaledPads = Int32Array.from(net.elements.flatMap((el, i) => (el.kind === "GPIO" && el.ohms > 0 && el.ohmsAt > 0 && el.vddNet !== undefined ? [i] : [])))
    this.padSteps = new Int32Array(m)
    this.arcStart = new Uint8Array(m)
    this.capacitors = Int32Array.from(net.elements.flatMap((el, i) => (el.kind === "C" ? [i] : [])))
    for (const i of this.timers) this.ctlT.fill(NaN, i * 3, i * 3 + 3)
    this.ohms = new Float64Array(m)
    this.batSoc = new Float64Array(m * MAX_CELLS)
    this.batR = new Float64Array(m)
    this.batStep = new Int32Array(m)
    this.batOcv = new Float64Array(m)
    this.batV1 = new Float64Array(m)
    this.batV2 = new Float64Array(m)
    this.batT = new Float64Array(m)
    this.batThru = new Float64Array(m)
    this.batWinI = new Float64Array(m * BAT_AVG_BUCKETS)
    this.batWinRate = new Float64Array(m * BAT_AVG_BUCKETS)
    this.batWinAt = new Int32Array(m)
    this.batWinFill = new Float64Array(m)
    this.batCharged = new Float64Array(m)
    this.batAge = new Float64Array(m)
    for (let i = 0; i < m; i++) {
      const el = net.elements[i]
      if (el.kind === "R") this.ohms[i] = el.value
      else if (el.kind === "GPIO") this.ohms[i] = el.ohms || R_GPIO
      else if (el.kind === "BAT") {
        for (let k = 0; k < el.cells; k++) this.batSoc[i * MAX_CELLS + k] = el.soc0
        this.batT[i] = el.temp
        this.batteryState(i)
      }
    }

    this.indexOf = new Map(net.elements.map((el, i) => [el.id, i]))
    // Terminal keys are interned once; the step then accumulates into dense slots.
    this.termIndex = new Map()
    this.termKeys = []
    this.termOf = new Int32Array(m * TERM_SLOTS).fill(-1)
    this.termAt = new Int32Array(m)
    net.elements.forEach((el, i) => {
      this.termAt[i] = el.keys.length
      el.keys.forEach((key, k) => {
        let slot = this.termIndex.get(key)
        if (slot === undefined) {
          slot = this.termKeys.length
          this.termIndex.set(key, slot)
          this.termKeys.push(key)
        }
        this.termOf[i * TERM_SLOTS + k] = slot
      })
    })
    this.termCurrent = new Float64Array(this.termKeys.length)
  }

  /** Carry capacitor voltages, inductor currents and wear over from a previous engine. */
  adopt(prev: Engine) {
    for (const [id, from] of prev.indexOf) {
      const to = this.indexOf.get(id)
      if (to === undefined) continue
      this.capV[to] = prev.capV[from]
      this.capI[to] = prev.capI[from]
      this.indI[to] = prev.indI[from]
      this.indV[to] = prev.indV[from]
      this.stress[to] = prev.stress[from]
      this.rRatio[to] = prev.rRatio[from]
      this.msI[to] = prev.msI[from]
      this.msV[to] = prev.msV[from]
      this.msP[to] = prev.msP[from]
      this.diodeAvg[to] = prev.diodeAvg[from]
      this.arc[to] = prev.arc[from]
      this.ctl[to] = prev.ctl[from]
      for (let k = 0; k < 3; k++) this.ctlT[to * 3 + k] = prev.ctlT[from * 3 + k]
      // A battery keeps draining across an edit — unless the edit was to the battery itself.
      // Its temperature, wear and mismatch may change under it: the charge stays, the cell
      // temperature relaxes to the new air from where it was.
      const el = this.net.elements[to]
      const was = prev.net.elements[from]
      if (el.kind === "BAT" && was.kind === "BAT" && el.chem === was.chem && el.capacity === was.capacity && el.soc0 === was.soc0 && el.cells === was.cells) {
        for (let k = 0; k < MAX_CELLS; k++) this.batSoc[to * MAX_CELLS + k] = prev.batSoc[from * MAX_CELLS + k]
        this.batV1[to] = prev.batV1[from]
        this.batV2[to] = prev.batV2[from]
        this.batT[to] = prev.batT[from]
        this.batThru[to] = prev.batThru[from]
        for (let k = 0; k < BAT_AVG_BUCKETS; k++) {
          this.batWinI[to * BAT_AVG_BUCKETS + k] = prev.batWinI[from * BAT_AVG_BUCKETS + k]
          this.batWinRate[to * BAT_AVG_BUCKETS + k] = prev.batWinRate[from * BAT_AVG_BUCKETS + k]
        }
        this.batWinAt[to] = prev.batWinAt[from]
        this.batWinFill[to] = prev.batWinFill[from]
        this.batCharged[to] = prev.batCharged[from]
        this.batAge[to] = prev.batAge[from]
        this.batteryState(to)
      }
    }
    this.msPrimed = prev.msPrimed
    // Node voltages carry over by pin (nets get renumbered): the next step starts from the
    // old solution, and an MCU does not see its supply at zero for a step after an edit.
    // Node averages are not carried; they re-prime from the next solution.
    for (const nets of ["pinNet", "nodeNet"] as const) {
      for (const [key, to] of this.net[nets]) {
        const from = prev.net[nets].get(key)
        if (from !== undefined && to !== GROUND && from !== GROUND) this.v[to] = prev.v[from]
      }
    }
    this.time = prev.time
    this.setTrace(prev.traceBucket)
  }

  /**
   * Carry the probe statistics and the oscilloscope buckets over from a previous engine,
   * once the probes are pointed at the new nets. A rebuild happens on every edit and on every
   * failure, and the bucket being filled at that moment is the one with the spike that did
   * the damage: dropping it would leave the scope showing nothing where the part died.
   */
  adoptProbes(prev: Engine) {
    if (prev.probeNodes.length !== this.probeNodes.length) return
    this.probeAcc.set(prev.probeAcc)
    this.probeLast.set(prev.probeLast)
    this.probeSeconds = prev.probeSeconds
    this.probeSamples = prev.probeSamples
    this.probeLastSamples = prev.probeLastSamples
    if (prev.traceBucket !== this.traceBucket || this.traceBucket === 0) return
    this.traceAcc.set(prev.traceAcc)
    this.traceSeconds = prev.traceSeconds
    this.traceOut = prev.traceOut
    this.traceStart = prev.traceStart
  }

  /** Relative size of cell `k` in a pack with a capacity spread: evenly from 1 − spread to 1 + spread. */
  private cellSize(el: Extract<Resolved, { kind: "BAT" }>, k: number) {
    return el.cells > 1 ? 1 + el.spread * ((2 * k) / (el.cells - 1) - 1) : 1
  }

  /** Full cycles a battery has seen: the ones it was placed with plus what has flowed through it since. */
  private cellCycles(el: Extract<Resolved, { kind: "BAT" }>, i: number) {
    return el.cycles + this.batThru[i] / (2 * el.capacity * 3600)
  }

  /** Usable capacity of cell `k` right now, Ah: nameplate × size × temperature × wear. */
  private cellCapacity(el: Extract<Resolved, { kind: "BAT" }>, i: number, k: number) {
    return el.capacity * this.cellSize(el, k) * capacityAtTemp(el.chem, this.batT[i]) * capacityAfterAge(el.chem, this.cellCycles(el, i), el.years)
  }

  /**
   * The pack's open-circuit voltage and ohmic resistance at its cells' states of charge,
   * temperature and wear. The resistance is stepped in 1 % increments so a linear circuit
   * keeps its factorization between steps.
   */
  private batteryState(i: number) {
    const el = this.net.elements[i]
    if (el.kind !== "BAT") return
    const chem = el.chem
    const rScale = (resistanceAtTemp(chem, this.batT[i]) * resistanceAfterAge(chem, this.cellCycles(el, i), el.years)) / el.cells
    let ocv = 0
    let r = 0
    for (let k = 0; k < el.cells; k++) {
      const soc = this.batSoc[i * MAX_CELLS + k]
      ocv += cellOcv(chem, soc)
      // A smaller cell has proportionally more resistance.
      r += packResistance(chem, (el.rFull * rScale) / this.cellSize(el, k), soc)
    }
    this.batOcv[i] = ocv
    const step = Math.round(Math.log(r / el.rFull) / BAT_R_STEP)
    if (step === this.batStep[i] && this.batR[i] > 0) return
    this.batStep[i] = step
    this.batR[i] = el.rFull * Math.exp(step * BAT_R_STEP)
  }

  /**
   * A battery's load (A) and the weakest cell's drain rate (per second) averaged over the
   * sliding window — or over just the newest part of it when the load has been steady there
   * for at least a second and different before: a switch closed two seconds ago reads the new
   * load now, not a fading mix of before and after. A pulsed load (an MCU waking every second)
   * is never steady bucket to bucket, so it keeps the whole window.
   */
  private batteryAverage(i: number): [amps: number, rate: number] {
    const base = i * BAT_AVG_BUCKETS
    const complete = Math.min(BAT_AVG_BUCKETS - 1, Math.floor(this.batAge[i] / BAT_AVG_BUCKET))
    const fill = this.batWinFill[i]
    // Newest first: the partial bucket (when it has enough in it to mean something), then the complete ones.
    let q = 0
    let d = 0
    let span = 0
    let steady = true
    let steadySpan = 0
    let steadyQ = 0
    let steadyD = 0
    let ref = NaN
    let n = 0
    const take = (charge: number, drain: number, seconds: number) => {
      q += charge
      d += drain
      span += seconds
      if (steady) {
        const level = charge / seconds
        if (Number.isNaN(ref)) ref = level
        else if (Math.abs(level - ref) > 0.2 * Math.max(Math.abs(ref), Math.abs(level), BAT_LEAK)) steady = false
        if (steady) {
          steadySpan += seconds
          steadyQ += charge
          steadyD += drain
          n++
        }
      }
    }
    const at = this.batWinAt[i]
    if (fill >= 0.2 * BAT_AVG_BUCKET) take(this.batWinI[base + at], this.batWinRate[base + at], fill)
    for (let k = 1; k <= complete; k++) {
      const slot = base + ((at - k + BAT_AVG_BUCKETS) % BAT_AVG_BUCKETS)
      take(this.batWinI[slot], this.batWinRate[slot], BAT_AVG_BUCKET)
    }
    if (span <= 0) return [0, 0]
    if (!steady && steadySpan >= 1 && n > 1) return [steadyQ / steadySpan, steadyD / steadySpan]
    return [q / span, d / span]
  }

  /** State of charge of a pack's weakest and strongest cell. */
  private batteryCells(el: Extract<Resolved, { kind: "BAT" }>, i: number): [min: number, max: number] {
    let lo = Infinity
    let hi = -Infinity
    for (let k = 0; k < el.cells; k++) {
      const soc = this.batSoc[i * MAX_CELLS + k]
      if (soc < lo) lo = soc
      if (soc > hi) hi = soc
    }
    return [lo, hi]
  }

  /** Terminal voltage of a source at time `t`. */
  private sourceVoltage(el: Extract<Resolved, { kind: "V" }>, t: number) {
    if (el.amplitude <= 0) return el.value
    if (el.shape === "pulse") {
      const phase = ((t * el.frequency) % 1 + 1) % 1
      return phase < el.duty ? el.value + el.amplitude : el.value
    }
    return el.value + el.amplitude * Math.sin(2 * Math.PI * el.frequency * t + el.phase)
  }

  /**
   * Shichman–Hodges drain current and its derivatives at (vgs, vds), both already mirrored
   * for a PMOS and with vds ≥ 0: the channel is symmetric, so a negative vds is handled by
   * the caller swapping drain and source.
   */
  private mosfet(el: Extract<Resolved, { kind: "M" }>, vgs: number, vds: number): [id: number, gm: number, gds: number, region: number] {
    const vov = vgs - el.vth
    if (vov <= 0) return [0, 0, 0, 0]
    const clm = 1 + el.lambda * vds
    if (vds < vov) {
      const shape = 2 * vov * vds - vds * vds
      return [el.k * shape * clm, 2 * el.k * vds * clm, 2 * el.k * (vov - vds) * clm + el.k * shape * el.lambda, 1]
    }
    return [el.k * vov * vov * clm, 2 * el.k * vov * clm, el.k * vov * vov * el.lambda, 3]
  }

  /** Exponential moving average step with the RMS time constant. */
  private ema(prev: number, value: number, dt: number) {
    return prev + (value - prev) * Math.min(1, dt / this.tau)
  }

  // --- matrix helpers; methods rather than closures, so a step allocates nothing ---

  /** Conductance between two nodes. */
  private addG(a: number, b: number, val: number) {
    const { A } = this
    if (a !== GROUND) A[this.cell(a, a)] += val
    if (b !== GROUND) A[this.cell(b, b)] += val
    if (a !== GROUND && b !== GROUND) {
      A[this.cell(a, b)] -= val
      A[this.cell(b, a)] -= val
    }
  }

  /** Current source of `i` amps flowing from a to b. */
  private addI(a: number, b: number, i: number) {
    const { z } = this
    if (a !== GROUND) z[a] -= i
    if (b !== GROUND) z[b] += i
  }

  /** One term of a linearized terminal current: g·(V[p] − V[q]) leaving node `at`. */
  private addTerm(at: number, p: number, q: number, gk: number) {
    const { A } = this
    if (at === GROUND) return
    if (p !== GROUND) A[this.cell(at, p)] += gk
    if (q !== GROUND) A[this.cell(at, q)] -= gk
  }

  private vol(i: number, from: Float64Array) {
    return i === GROUND ? 0 : from[i]
  }

  /**
   * Stamp everything whose contribution to `A` does not depend on the solution. `withZ` also
   * fills the right-hand side; a reused factorization needs the right-hand side alone.
   */
  private stampLinear(dt: number, parts: PartReader, withA: boolean, withZ: boolean) {
    const { A, z } = this
    const n = this.net.nodes
    if (withA) for (let i = 0; i < n; i++) A[this.cell(i, i)] += GMIN
    const elements = this.net.elements
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      switch (el.kind) {
        case "R":
          if (withA) this.addG(el.a, el.b, 1 / this.ohms[i])
          break
        // θ-method companions: i = C/(θ dt) · (v − v₀) − (1−θ)/θ · i₀ for a capacitor,
        // i = i₀ + dt/L · (θ v + (1−θ) v₀) for an inductor.
        case "C": {
          const geq = el.value / (this.theta * dt)
          if (withA) this.addG(el.a, el.b, geq)
          if (withZ) this.addI(el.a, el.b, -geq * this.capV[i] - ((1 - this.theta) / this.theta) * this.capI[i])
          break
        }
        case "L":
          if (withA) this.addG(el.a, el.b, (this.theta * dt) / el.value)
          if (withZ) this.addI(el.a, el.b, this.indI[i] + (((1 - this.theta) * dt) / el.value) * this.indV[i])
          break
        case "V": {
          const r = n + el.index
          if (withA) {
            if (el.plus !== GROUND) {
              A[this.cell(el.plus, r)] += 1
              A[this.cell(r, el.plus)] += 1
            }
            if (el.minus !== GROUND) {
              A[this.cell(el.minus, r)] -= 1
              A[this.cell(r, el.minus)] -= 1
            }
          }
          if (withZ) z[r] = this.sourceVoltage(el, this.time + dt)
          break
        }
        case "BAT": {
          // Thevenin cell: V(plus) − V(minus) = OCV + R·x[r], x[r] being the current entering
          // at plus (negative while the battery delivers). Row r carries −R on its own unknown.
          const r = n + el.index
          if (withA) {
            if (el.plus !== GROUND) {
              A[this.cell(el.plus, r)] += 1
              A[this.cell(r, el.plus)] += 1
            }
            if (el.minus !== GROUND) {
              A[this.cell(el.minus, r)] -= 1
              A[this.cell(r, el.minus)] -= 1
            }
            A[this.cell(r, r)] -= this.batR[i]
          }
          // The diffusion voltages sit in series with the open-circuit voltage.
          if (withZ) z[r] = this.batOcv[i] - this.batV1[i] - this.batV2[i]
          break
        }
        case "XFMR": {
          // Unknown x[r] is the current entering the secondary at s1. Row r: V(s1) − V(s2) − n·(V(p1) − V(p2)) = 0;
          // the primary draws −n·x[r] at p1 so the power balances.
          if (!withA) break
          const r = n + el.index
          const couple = (node: number, val: number) => {
            if (node === GROUND) return
            A[this.cell(node, r)] += val
            A[this.cell(r, node)] += val
          }
          couple(el.s1, 1)
          couple(el.s2, -1)
          couple(el.p1, -el.ratio)
          couple(el.p2, el.ratio)
          break
        }
        case "SW": {
          if (switchClosed(el.closed, parts(this.partKeys[i]))) {
            if (withA) this.addG(el.a, el.b, 1 / el.ron)
          } else if (this.arc[i]) {
            // i = (v − pol·V_ARC) / R_ARC: a conductance and the Norton current of the arc drop.
            if (withA) this.addG(el.a, el.b, 1 / R_ARC)
            if (withZ) this.addI(el.b, el.a, ((this.arc[i] === 1 ? 1 : -1) * V_ARC) / R_ARC)
          }
          break
        }
        case "GPIO": {
          // Driver: 25 Ω to VDD or ground. Pull: 40 kΩ to VDD or ground. Floating: nothing.
          // With a rail node the high side is a conductance to that rail, so the pad follows it.
          const st = this.gpioState[i]
          if (st === 0) break
          if (st === GPIO_VOLTS) {
            // A sourced voltage: R_DAC to ground plus the current that sets the level.
            if (withA) this.addG(el.node, GROUND, 1 / R_DAC)
            if (withZ) this.addI(GROUND, el.node, this.gpioVolts[i] / R_DAC)
            break
          }
          const r = st <= 2 ? this.ohms[i] : R_PULL
          const high = st === 1 || st === 3
          if (high && el.vddNet !== undefined) {
            if (withA) this.addG(el.node, el.vddNet, 1 / r)
            break
          }
          if (withA) this.addG(el.node, el.gndNet ?? GROUND, 1 / r)
          if (withZ && high) this.addI(GROUND, el.node, el.vdd / r)
          break
        }
        case "CHG": {
          const r = n + el.prog
          const tied = el.progNet === el.gnd || this.ctl[i] === CHG_OFF
          if (withA) {
            if (tied) A[this.cell(r, r)] = 1
            else {
              if (el.progNet !== GROUND) {
                A[this.cell(el.progNet, r)] += 1
                A[this.cell(r, el.progNet)] += 1
              }
              if (el.gnd !== GROUND) {
                A[this.cell(el.gnd, r)] -= 1
                A[this.cell(r, el.gnd)] -= 1
              }
            }
            const st = this.ctl[i]
            if ((st === CHG_TRICKLING || st === CHG_CHARGING) && el.chrg !== undefined) this.addG(el.chrg, el.gnd, 1 / CHG_OD_R)
            if (st === CHG_DONE && el.stdby !== undefined) this.addG(el.stdby, el.gnd, 1 / CHG_OD_R)
          }
          if (withZ) z[r] = tied ? 0 : CHG_VPROG
          break
        }
        case "PROT": {
          if (!withA) break
          const st = this.ctl[i]
          this.addG(el.od, st & (PROT_DISCHARGE_OFF | PROT_OVERCURRENT_OFF) ? el.vss : el.vdd, 1 / PROT_DRIVE_R)
          this.addG(el.oc, st & PROT_CHARGE_OFF ? el.cs : el.vdd, 1 / PROT_DRIVE_R)
          if (st & PROT_OVERCURRENT_OFF) this.addG(el.cs, el.vss, 1 / el.spec.releaseR)
          break
        }
      }
    }
  }

  /**
   * The running quantities of a settled step, with every current and voltage as it was: the
   * LED eye averages move toward their currents and stressed parts keep heating. Returns
   * false when a part would cross its limit, for the full update to record the failure.
   */
  private settledTick(dt: number): boolean {
    this.failures.length = 0
    const k = Math.min(1, dt / LED_EYE_TAU)
    const diodes = this.diodeElements
    for (let j = 0; j < diodes.length; j++) {
      const i = diodes[j]
      this.diodeAvg[i] += (this.rCurrent[i] - this.diodeAvg[i]) * k
    }
    const loaded = this.loadedElements
    const elements = this.net.elements
    for (let j = 0; j < loaded.length; j++) {
      const i = loaded[j]
      const lim = elements[i].limits
      if (!lim) continue
      const heat = this.stress[i] + (this.rRatio[i] - this.stress[i]) * -Math.expm1(-dt / lim.tau)
      if (heat > 1) return false
      this.stress[i] = heat
    }
    return true
  }

  /**
   * How many steps of `dt` from here are sure to take the settled path, pads and switches
   * as they are: none unless the circuit is at its fixed point, and fewer when a stressed
   * part would reach its limit on the way.
   */
  settledFor(dt: number): number {
    if (this.settledRun < SETTLED_STEPS) return 0
    let steps = Infinity
    const loaded = this.loadedElements
    const elements = this.net.elements
    for (let j = 0; j < loaded.length; j++) {
      const i = loaded[j]
      const load = this.rRatio[i]
      const lim = elements[i].limits
      if (!lim || load <= 1) continue
      const t = lim.tau * Math.log((load - this.stress[i]) / (load - 1))
      steps = Math.min(steps, Math.floor(t / dt) - 1)
    }
    return Math.max(0, steps)
  }

  /**
   * Whether the step just taken left the circuit where it was: converged, no strike, no AC
   * source, nothing stored moving (a capacitor still charging or an inductor's current
   * ramping would drift over the steps skipped), no battery (its state drifts by design),
   * and the node voltages within tolerance of the step before.
   */
  private settledAfter(dt: number): boolean {
    if (!this.converged || this.struck || this.ac || this.drifting || this.eventful) return false
    const n = this.net.nodes
    for (let i = 0; i < n; i++) if (Math.abs(this.v[i] - this.prevV[i]) > SETTLED_DV) return false
    const elements = this.net.elements
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      // Drift bounds: at most SETTLED_DRIFT volts (or amps) per second if the state were frozen.
      if (el.kind === "C" && Math.abs(this.capI[i]) > el.value * SETTLED_DRIFT) return false
      if (el.kind === "L" && Math.abs(this.indV[i]) > el.value * SETTLED_DRIFT) return false
    }
    return dt > 0
  }

  /** Hash of every switch and pad state, so a toggle invalidates the cached factorization. */
  private switchMask(parts: PartReader) {
    let mask = 0
    const elements = this.net.elements
    const masked = this.maskElements
    for (let k = 0; k < masked.length; k++) {
      const i = masked[k]
      const el = elements[i]
      if (el.kind === "SW") mask = (mask * 31 + (switchClosed(el.closed, parts(this.partKeys[i])) ? 1 : this.arc[i] ? 2 : 0)) | 0
      else if (el.kind === "GPIO") mask = (mask * 31 + this.gpioState[i] + 7 * this.padSteps[i]) | 0
      else if (el.kind === "R" && el.live) mask = (mask * 31 + (this.ohms[i] | 0)) | 0
      else if (el.kind === "BAT") mask = (mask * 31 + this.batStep[i]) | 0
      else if (el.kind === "CHG" || el.kind === "PROT" || el.kind === "TMR") mask = (mask * 31 + this.ctl[i]) | 0
    }
    return mask
  }

  /**
   * One step of `dt`. `refreshPins` false promises the pads read exactly what they did last
   * step (the caller tracks its MCUs' pad versions), so the reads are skipped.
   */
  step(dt: number, parts: PartReader, pins: PinReader = NO_PINS, refreshPins = true) {
    const n = this.net.nodes
    const elements = this.net.elements

    // Pad states are read once per step: the MCU may change them between steps, not within.
    let disturbed = false
    const padElements = this.padElements
    for (let k = 0; refreshPins && k < padElements.length; k++) {
      const i = padElements[k]
      const el = elements[i]
      if (el.kind === "GPIO") {
        const st = pins(i, el.object, el.nodeKey)
        if (typeof st === "number") {
          if (this.gpioState[i] !== GPIO_VOLTS || this.gpioVolts[i] !== st) disturbed = true
          this.gpioState[i] = GPIO_VOLTS
          this.gpioVolts[i] = st
        } else {
          const code = st ? GPIO_CODE[st] : 0
          if (this.gpioState[i] !== code) disturbed = true
          this.gpioState[i] = code
        }
      } else if (el.kind === "R" && el.live) {
        const r = pins(i, el.object, el.live)
        const ohms = typeof r === "number" && r > 0 ? r : el.value
        if (this.ohms[i] !== ohms) disturbed = true
        this.ohms[i] = ohms
      }
    }
    if (this.scaledPads.length && this.scalePads()) disturbed = true
    const mask = this.switchMask(parts)
    if (mask !== this.stepMask) disturbed = true
    this.stepMask = mask
    if (disturbed) {
      this.settledRun = 0
      this.restartStiffCapacitors(dt)
    }

    if (this.settledRun >= SETTLED_STEPS) {
      // At a fixed point of the circuit with nothing driving it anywhere else, this step's
      // solution is the previous one: only the running quantities move on.
      this.struck = false
      this.converged = true
      if (!this.settledTick(dt)) this.updateState(dt, parts)
      this.updateProbes(dt)
      this.time += dt
      return
    }

    this.struck = false
    this.eventful = false
    this.failures.length = 0
    this.prevV.set(this.v)
    for (let k = 0; k < this.timers.length; k++) this.burst[this.timers[k]] = 0
    let left = dt
    for (let events = 0; ; ) {
      const controlled = this.subSpan > 0
      const span = controlled ? Math.min(left, this.subSpan) : left
      this.theta = controlled && this.subBackward ? 1 : THETA
      this.subV.set(this.v)
      if (this.timers.length) this.arcStart.set(this.arc)
      const wasStruck: boolean = this.struck
      this.solveFrom(span, parts)
      if (events >= TMR_MAX_EVENTS * this.timers.length || !this.converged || !this.findTimerEvent()) {
        if (span === left) break
        this.updateState(span, parts)
        this.time += span
        left -= span
        this.subSpan = this.nextSubSpan(span, dt)
        continue
      }
      events++
      this.eventful = true
      const timer = this.eventTimer
      this.arc.set(this.arcStart)
      this.struck = wasStruck
      if (this.eventFraction * span > TMR_MIN_STEP) {
        const sub = this.settleEvent(span, parts) * span
        this.updateState(sub, parts)
        this.time += sub
        left -= sub
      } else this.v.set(this.subV)
      this.switchTimer(timer, this.time)
      this.stepMask = this.switchMask(parts)
      this.subSpan = TMR_RESTART * dt
      this.subBackward = true
      this.switchedAt = this.time
      if (left <= TMR_MIN_STEP) {
        left = 0
        break
      }
    }
    if (left > 0) {
      const controlled = this.subSpan > 0
      this.updateState(left, parts)
      this.time += left
      if (controlled) this.subSpan = this.nextSubSpan(left, dt)
    }
    this.theta = THETA
    for (let k = 0; k < this.timers.length; k++) {
      const i = this.timers[k]
      this.capped[i] = this.burst[i] >= TMR_MAX_EVENTS && this.timerPending(i) ? Math.min(255, this.capped[i] + 1) : 0
      if (this.capped[i] >= TMR_CAPPED_STEPS) this.burstSeen[i] = 1
    }
    this.updateProbes(dt)
    this.settledRun = this.settledAfter(dt) ? this.settledRun + 1 : 0
    if (this.settledRun >= SETTLED_STEPS) {
      this.loadedElements = []
      for (let i = 0; i < this.rRatio.length; i++) if (this.rRatio[i] !== 0 || this.stress[i] !== 0) this.loadedElements.push(i)
    }

    if (this.ac) {
      for (let i = 0; i < n; i++) this.v2[i] = this.msPrimed ? this.ema(this.v2[i], this.v[i] * this.v[i], dt) : this.v[i] * this.v[i]
    }
    this.msPrimed = true
  }

  private restartStiffCapacitors(dt: number) {
    const elements = this.net.elements
    for (let k = 0; k < this.capacitors.length; k++) {
      const i = this.capacitors[k]
      const el = elements[i] as Extract<Resolved, { kind: "R" | "C" | "L" }>
      const companion = el.value / (THETA * dt)
      const seen = Math.min(this.conductanceBeside(el.a, companion), this.conductanceBeside(el.b, companion))
      if (el.value / seen < dt) this.capI[i] = 0
    }
  }

  private conductanceBeside(node: number, companion: number) {
    return node === GROUND ? Infinity : Math.max(this.A[node * this.size + node] - companion, GMIN)
  }

  private nextSubSpan(span: number, dt: number): number {
    const next = 2 * span
    const elements = this.net.elements
    const { A, size } = this
    const companion = (c: number) => c / (this.theta * span)
    const load = (node: number, c: number) => (node === GROUND ? Infinity : Math.max(A[node * size + node] - companion(c), GMIN))
    let stiff = false
    for (let k = 0; k < this.capacitors.length && !stiff; k++) {
      const i = this.capacitors[k]
      const el = elements[i] as Extract<Resolved, { kind: "R" | "C" | "L" }>
      const settle = el.value / Math.min(load(el.a, el.value), load(el.b, el.value))
      const kick = ((1 - THETA) / THETA) * Math.abs(this.capI[i]) * (next / el.value)
      stiff = settle < next && kick > TMR_KICK
    }
    this.subBackward = stiff
    if (next >= dt || this.time - this.switchedAt > TMR_CONTROLLED_STEPS * dt) {
      this.subBackward = false
      return 0
    }
    return next
  }

  private solveFrom(dt: number, parts: PartReader) {
    for (let strike = 0; strike <= MAX_STRIKES; strike++) {
      if (strike > 0) this.v.set(this.subV)
      this.converged = this.solve(dt, parts)
      if (strike === MAX_STRIKES || !this.checkStrikes(parts)) break
      this.stepMask = this.switchMask(parts)
    }
  }

  private scalePads(): boolean {
    let changed = false
    const elements = this.net.elements
    for (let k = 0; k < this.scaledPads.length; k++) {
      const i = this.scaledPads[k]
      const el = elements[i] as Pad
      const supply = this.vol(el.vddNet!, this.v) - (el.gndNet === undefined ? 0 : this.vol(el.gndNet, this.v))
      const scale = (el.ohmsAt - CMOS_VT) / Math.max(supply - CMOS_VT, 0.2)
      const steps = Math.round(Math.log(scale) / CMOS_STEP)
      if (steps === this.padSteps[i]) continue
      this.padSteps[i] = steps
      this.ohms[i] = el.ohms * Math.exp(steps * CMOS_STEP)
      changed = true
    }
    return changed
  }

  private timerMargins(el: Timer, v: Float64Array, out: Float64Array) {
    const gnd = this.vol(el.gnd, v)
    out[0] = this.vol(el.vcc, v) - gnd - NE555.operating
    out[1] = NE555.resetThreshold - (this.vol(el.reset, v) - gnd)
    out[2] = this.vol(el.lo, v) - this.vol(el.trig, v)
    out[3] = this.vol(el.thres, v) - this.vol(el.ctrl, v)
  }

  private timerState(st: number, m: Float64Array): number {
    if (m[0] <= 0) return 0
    const high = st & TMR_POWERED ? (st & TMR_HIGH) !== 0 : false
    return TMR_POWERED | (nextLatch(high, m[1] > 0, m[2] > 0, m[3] > 0) ? TMR_HIGH : 0)
  }

  private timerPending(i: number): boolean {
    this.timerMargins(this.net.elements[i] as Timer, this.v, this.marginsAt)
    return this.timerState(this.ctl[i], this.marginsAt) !== this.ctl[i]
  }

  private findTimerEvent(): boolean {
    const elements = this.net.elements
    const start = this.marginsStart
    const end = this.marginsEnd
    const at = this.marginsAt
    let best = Infinity
    for (let t = 0; t < this.timers.length; t++) {
      const i = this.timers[t]
      if (this.burst[i] >= TMR_MAX_EVENTS) continue
      const el = elements[i] as Timer
      const st = this.ctl[i]
      this.timerMargins(el, this.subV, start)
      if (this.timerState(st, start) !== st) {
        if (best > 0) {
          best = 0
          this.eventTimer = i
          this.eventMargin = -1
        }
        continue
      }
      this.timerMargins(el, this.v, end)
      for (let k = 0; k < TMR_MARGINS; k++) {
        if (start[k] > 0 === end[k] > 0) continue
        const f = start[k] / (start[k] - end[k])
        if (f >= best) continue
        for (let j = 0; j < TMR_MARGINS; j++) at[j] = j === k ? end[j] : start[j] + (end[j] - start[j]) * f
        if (this.timerState(st, at) === st) continue
        best = f
        this.eventTimer = i
        this.eventMargin = k
        this.eventFrom = start[k]
        this.eventTo = end[k]
      }
    }
    this.eventFraction = best
    return best < Infinity
  }

  private settleEvent(left: number, parts: PartReader): number {
    const el = this.net.elements[this.eventTimer] as Timer
    const k = this.eventMargin
    let lo = 0
    let hi = 1
    let mLo = this.eventFrom
    let mHi = this.eventTo
    const crossed = (m: number) => m > 0 === mHi > 0
    let f = this.eventFraction
    for (let round = 0; ; round++) {
      this.v.set(this.subV)
      this.arc.set(this.arcStart)
      this.solveFrom(f * left, parts)
      this.timerMargins(el, this.v, this.marginsAt)
      const m = this.marginsAt[k]
      if (crossed(m)) {
        if (Math.abs(m) <= TMR_TOLERANCE || round >= TMR_REFINE) return f
        hi = f
        mHi = m
      } else {
        lo = f
        mLo = m
        if (round >= TMR_REFINE) {
          this.v.set(this.subV)
          this.arc.set(this.arcStart)
          this.solveFrom(hi * left, parts)
          return hi
        }
      }
      f = lo + (hi - lo) * (mLo / (mLo - mHi))
      if (!(f > lo && f < hi)) f = (lo + hi) / 2
    }
  }

  private switchTimer(i: number, time: number) {
    const el = this.net.elements[i] as Timer
    this.timerMargins(el, this.v, this.marginsAt)
    const st = this.ctl[i]
    const next = this.timerState(st, this.marginsAt)
    if (next === st) return
    const t = i * 3
    if (!(st & TMR_HIGH) && next & TMR_HIGH) {
      this.ctlT[t] = this.ctlT[t + 1]
      this.ctlT[t + 1] = time
    } else if (st & TMR_HIGH && !(next & TMR_HIGH)) this.ctlT[t + 2] = time
    this.ctl[i] = next
    if ((st ^ next) & TMR_HIGH) this.onTimer?.(el.object, (next & TMR_HIGH) !== 0, time)
    this.burst[i]++
  }

  /**
   * An open switch whose gap voltage reached its strike voltage arcs over. The solution the
   * gap reached is kept at the instant of the strike — the circuit did pass through it — so
   * the probes see the spike and anything rated below it breaks; then the step is re-solved
   * with the arc conducting. Returns whether anything struck.
   */
  private checkStrikes(parts: PartReader): boolean {
    const elements = this.net.elements
    const strikable = this.strikeElements
    let struck = false
    let worst = 1
    for (let k = 0; k < strikable.length; k++) {
      const i = strikable[k]
      const el = elements[i]
      if (el.kind !== "SW" || this.arc[i]) continue
      if (switchClosed(el.closed, parts(this.partKeys[i]))) continue
      const vd = Math.abs(this.vol(el.a, this.v) - this.vol(el.b, this.v))
      if (vd < el.strike) continue
      this.arc[i] = this.vol(el.a, this.v) - this.vol(el.b, this.v) > 0 ? 1 : 2
      struck = true
      // The gap breaks down on the way up: the state at the strike is the previous solution
      // carried this fraction of the way to the unclamped one.
      if (el.strike / vd < worst) worst = el.strike / vd
    }
    if (!struck) return false
    const n = this.net.nodes
    for (let k = 0; k < n; k++) this.strikeV[k] = this.subV[k] + (this.v[k] - this.subV[k]) * worst
    this.struck = true
    return true
  }

  /** One solve of the step from the current state; returns whether Newton settled. */
  private solve(dt: number, parts: PartReader): boolean {
    const { A, z, x, guess } = this
    const n = this.net.nodes
    const elements = this.net.elements
    // Junction voltages start from the previous solution.
    const junctions = this.junctionElements
    if (!this.linear) {
      for (let k = 0; k < junctions.length; k++) {
        const i = junctions[k]
        const el = elements[i]
        if (el.kind === "D") {
          const nvt = el.n * VT
          const vcrit = nvt * Math.log(nvt / (Math.SQRT2 * el.is))
          this.jA[i] = Math.min(vcrit, this.vol(el.anode, this.v) - this.vol(el.cathode, this.v))
          this.jB[i] = 0
        } else if (el.kind === "Q") {
          const s = el.polarity
          this.jA[i] = Math.min(Q_VCRIT, s * (this.vol(el.b, this.v) - this.vol(el.e, this.v)))
          this.jB[i] = Math.min(Q_VCRIT, s * (this.vol(el.b, this.v) - this.vol(el.c, this.v)))
        } else if (el.kind === "TMR") this.jA[i] = this.vol(el.vcc, this.v) - this.vol(el.out, this.v)
      }
    }
    let converged = false
    /** Smallest error any iterate reached, and with it the `best` solution vector. */
    let bestErr = Infinity

    // A linear circuit has a constant matrix: factorize once and only rebuild the
    // right-hand side, which turns the per-step cost from O(n³) into O(n²).
    const mask = this.stepMask
    // The operating point last found for these switch and pad states: on a circuit with no
    // stored energy it is the answer (the same inputs give the same fixed point); on one
    // with, it is where the iteration starts, which spares it the junction limiting of a
    // cold start. A PWM dithering a pad flips between two such points every step.
    const memo = this.linear || this.ac ? undefined : this.memo.get(mask)
    if (memo !== undefined && this.memoMatches(memo)) {
      if (this.stateless) {
        this.v.set(memo.v)
        x.set(memo.x)
        this.rRegion.set(memo.region)
        this.jA.set(memo.jA)
        this.jB.set(memo.jB)
        return true
      }
      this.v.set(memo.v)
      for (let k = 0; k < junctions.length; k++) {
        const i = junctions[k]
        const el = elements[i]
        if (el.kind === "D") this.jA[i] = this.vol(el.anode, this.v) - this.vol(el.cathode, this.v)
        else if (el.kind === "Q") {
          const sg = el.polarity
          this.jA[i] = sg * (this.vol(el.b, this.v) - this.vol(el.e, this.v))
          this.jB[i] = sg * (this.vol(el.b, this.v) - this.vol(el.c, this.v))
        } else if (el.kind === "TMR") this.jA[i] = this.vol(el.vcc, this.v) - this.vol(el.out, this.v)
      }
    }
    guess.set(this.v)
    if (this.linear && this.luValid && this.luDt === dt && this.luSwitches === mask) {
      z.fill(0)
      this.stampLinear(dt, parts, false, true)
      converged = this.substitute()
    } else {
      for (let iter = 0; iter < MAX_ITER; iter++) {
        this.frozen = iter >= MODE_FREEZE
        A.fill(0)
        z.fill(0)
        // Set when junction limiting changed a voltage: the node solution can look stable while
        // the diode operating point is still creeping up, so that iteration is never "converged".
        let clamped = false
        const limit = (vnew: number, vold: number, vt: number, vcrit: number) => {
          const v = pnjlim(vnew, vold, vt, vcrit)
          if (Math.abs(v - vnew) > ABS_TOL) clamped = true
          return v
        }
        const g = (i: number) => (i === GROUND ? 0 : guess[i])

        this.stampLinear(dt, parts, true, true)

        const nonlinear = this.nonlinearElements
        for (let k = 0; k < nonlinear.length; k++) {
          const i = nonlinear[k]
          const el = elements[i]
          if (el.kind === "D") {
            const nvt = el.n * VT
            const vcrit = nvt * Math.log(nvt / (Math.SQRT2 * el.is))
            let vd = limit(g(el.anode) - g(el.cathode), this.jA[i], nvt, vcrit)
            if (el.zener) vd = Math.max(vd, -el.zener - 1)
            this.jA[i] = vd
            const ef = Math.exp(Math.min(vd / nvt, 80))
            let id = el.is * (ef - 1)
            let gd = (el.is / nvt) * ef
            if (el.zener) {
              // Reverse breakdown as a mirrored junction offset by Vz.
              const er = Math.exp(Math.min(-(vd + el.zener) / nvt, 80))
              id -= el.is * (er - 1)
              gd += (el.is / nvt) * er
            }
            this.addG(el.anode, el.cathode, gd)
            this.addI(el.anode, el.cathode, id - gd * vd)
          } else if (el.kind === "Q") {
            // Ebers-Moll transport model; PNP handled by mirroring voltages and currents.
            const s = el.polarity
            const vbe = limit(s * (g(el.b) - g(el.e)), this.jA[i], VT, Q_VCRIT)
            const vbc = limit(s * (g(el.b) - g(el.c)), this.jB[i], VT, Q_VCRIT)
            this.jA[i] = vbe
            this.jB[i] = vbc
            const ef = Math.exp(Math.min(vbe / VT, 80))
            const er = Math.exp(Math.min(vbc / VT, 80))
            const iF = Q_IS * (ef - 1)
            const iR = Q_IS * (er - 1)
            const ic = iF - iR - iR / Q_BR
            const ib = iF / el.beta + iR / Q_BR
            const gf = (Q_IS / VT) * ef
            const gr = (Q_IS / VT) * er
            // dIc/dVbe, dIc/dVbc, dIb/dVbe, dIb/dVbc
            const g1 = gf
            const g2 = -gr * (1 + 1 / Q_BR)
            const g3 = gf / el.beta
            const g4 = gr / Q_BR
            const ic0 = s * (ic - g1 * vbe - g2 * vbc)
            const ib0 = s * (ib - g3 * vbe - g4 * vbc)
            this.addTerm(el.c, el.b, el.e, g1)
            this.addTerm(el.c, el.b, el.c, g2)
            if (el.c !== GROUND) z[el.c] -= ic0
            this.addTerm(el.b, el.b, el.e, g3)
            this.addTerm(el.b, el.b, el.c, g4)
            if (el.b !== GROUND) z[el.b] -= ib0
            this.addTerm(el.e, el.b, el.e, -(g1 + g3))
            this.addTerm(el.e, el.b, el.c, -(g2 + g4))
            if (el.e !== GROUND) z[el.e] += ic0 + ib0
          } else if (el.kind === "REG") {
            if (this.regulator(i, el.in, el.out, el.gnd, n + el.index, el.value, el.dropout, el.imax, true)) clamped = true
          } else if (el.kind === "CHG") {
            const st = this.ctl[i]
            const set = Math.max(0, -x[n + el.prog]) * CHG_GAIN
            const imax = st === CHG_TRICKLING ? set * CHG_TERM : set
            if (this.regulator(i, el.in, el.bat, el.gnd, n + el.index, el.value, 0, imax, st === CHG_TRICKLING || st === CHG_CHARGING)) clamped = true
          } else if (el.kind === "BOOST") {
            if (this.boost(i, el)) clamped = true
          } else if (el.kind === "TMR") {
            if (this.timer(el, i)) clamped = true
          } else if (el.kind === "M") {
            const s = el.polarity
            // Below zero Vds the roles of drain and source swap; nothing else changes.
            const swap = s * (g(el.d) - g(el.s)) < 0
            const dn = swap ? el.s : el.d
            const sn = swap ? el.d : el.s
            const vgs = s * (g(el.g) - g(sn))
            const vds = s * (g(dn) - g(sn))
            const [id, gm, gds] = this.mosfet(el, vgs, vds)
            // Drain current linearized: i = gm·(Vg − Vs) + gds·(Vd − Vs) + i0, leaving dn into sn.
            const i0 = s * (id - gm * vgs - gds * vds)
            this.addTerm(dn, el.g, sn, gm)
            this.addTerm(dn, dn, sn, gds)
            if (dn !== GROUND) z[dn] -= i0
            this.addTerm(sn, el.g, sn, -gm)
            this.addTerm(sn, dn, sn, -gds)
            if (sn !== GROUND) z[sn] += i0
          }
        }

        if (!this.factorize()) break
        this.substitute()

        let maxErr = 0
        for (let i = 0; i < n; i++) {
          const err = Math.abs(x[i] - guess[i]) - (ABS_TOL + REL_TOL * Math.abs(x[i]))
          if (err > maxErr) maxErr = err
          guess[i] = x[i]
        }
        if ((maxErr <= 0 && !clamped) || this.linear) {
          converged = true
          break
        }
        // A circuit switching regeneratively — a latch tipping over — passes through an
        // operating point where the Jacobian is singular, and there the iteration can chatter
        // instead of settling. Whatever it lands on when the iterations run out is arbitrary
        // and may be far off; the closest point it saw is not.
        if (maxErr < bestErr) {
          bestErr = maxErr
          this.best.set(x)
        }
      }
      if (!converged && bestErr < Infinity) {
        x.set(this.best)
        guess.set(this.best.subarray(0, n))
      }
      this.luDt = dt
      this.luSwitches = mask
    }

    this.v.set(guess.subarray(0, n))
    if (this.linear) for (let i = 0; i < n; i++) this.v[i] = x[i]
    if (converged && !this.linear && !this.ac) this.remember(mask)
    return converged
  }

  private addBranch(a: number, b: number, v: number, out: Float64Array) {
    this.addG(a, b, out[1])
    this.addI(a, b, out[0] - out[1] * v)
  }

  private timer(el: Timer, i: number): boolean {
    const g = (k: number) => (k === GROUND ? 0 : this.guess[k])
    const out = this.branchOut
    const st = this.ctl[i]
    const high = (st & TMR_HIGH) !== 0
    const vcc = g(el.vcc)
    const gnd = g(el.gnd)
    const supply = vcc - gnd
    quiescent(supply, high, out)
    this.addBranch(el.vcc, el.gnd, supply, out)
    if (!(st & TMR_POWERED)) return false
    let clamped = false
    if (high) {
      const raw = vcc - g(el.out)
      const drop = pnjlim(raw, this.jA[i], TMR_SOURCE_VT, TMR_SOURCE_KNEE)
      if (Math.abs(drop - raw) > ABS_TOL) clamped = true
      this.jA[i] = drop
      outputSource(drop, out)
      this.addBranch(el.vcc, el.out, drop, out)
    } else {
      const vo = g(el.out) - gnd
      outputSink(vo, supply, out)
      this.addBranch(el.out, el.gnd, vo, out)
      const vd = g(el.dis) - gnd
      dischargeSink(vd, supply, out)
      this.addBranch(el.dis, el.gnd, vd, out)
    }
    const trig = vcc - g(el.trig)
    bias(NE555.triggerBias * supplyShare(supply), trig, out)
    this.addBranch(el.vcc, el.trig, trig, out)
    const thres = g(el.thres) - gnd
    bias(NE555.thresholdBias * supplyShare(supply), thres, out)
    this.addBranch(el.thres, el.gnd, thres, out)
    const gr = (NE555.resetGrounded + NE555.resetAtSupply) / supply
    this.addI(el.vcc, el.reset, NE555.resetGrounded)
    this.addTerm(el.reset, el.reset, el.gnd, gr)
    this.addTerm(el.vcc, el.reset, el.gnd, -gr)
    return clamped
  }

  private regulator(i: number, inN: number, outN: number, gndN: number, r: number, value: number, dropout: number, imax: number, enabled: boolean): boolean {
    const { A, z, x } = this
    const g = (k: number) => (k === GROUND ? 0 : this.guess[k])
    let clamped = false
    const vin = g(inN) - g(gndN)
    const vout = g(outN) - g(gndN)
    const iPrev = x[r]
    const avail = vin - dropout
    const target = Math.min(value, avail)
    const prev = this.rRegion[i]
    const regOrDrop = avail >= value - 1e-9 ? REG_REGULATE : REG_DROPOUT
    let mode: number
    if (!enabled) mode = REG_OPEN
    // Limiting is left only once the output recovers: its saturating law already gives
    // nothing when the input collapses, and it must not flip to "off" on the way there.
    else if (prev === REG_LIMIT) mode = vout >= value - 1e-3 ? regOrDrop : REG_LIMIT
    else if (avail <= 0.02) mode = REG_OPEN
    else if (prev === REG_OPEN) mode = vout < target - 2e-3 ? regOrDrop : REG_OPEN
    else if (iPrev > imax) mode = REG_LIMIT
    // Sourcing: stay on, picking regulate/dropout by what the input can give. Only a
    // regulator asked to sink, or one idle under an output held higher, switches off.
    else if (iPrev > 1e-6) mode = regOrDrop
    else if (iPrev < -1e-6 || vout > target + 2e-3) mode = REG_OPEN
    else mode = regOrDrop
    if (this.frozen && enabled) mode = prev
    if (mode !== prev) clamped = true
    this.rRegion[i] = mode
    // Through current x[r] leaves `in` and arrives at `out`.
    if (inN !== GROUND) A[this.cell(inN, r)] += 1
    if (outN !== GROUND) A[this.cell(outN, r)] -= 1
    switch (mode) {
      // vout = Vset − R·x (regulating) or vout = vin − dropout − R·x (dropout): a little
      // sag with load, so two regulators on one rail share instead of fighting.
      case REG_REGULATE:
        if (outN !== GROUND) A[this.cell(r, outN)] += 1
        if (gndN !== GROUND) A[this.cell(r, gndN)] -= 1
        A[this.cell(r, r)] += R_REG
        z[r] = value
        break
      case REG_DROPOUT:
        if (outN !== GROUND) A[this.cell(r, outN)] += 1
        if (inN !== GROUND) A[this.cell(r, inN)] -= 1
        A[this.cell(r, r)] += R_REG
        z[r] = -dropout
        break
      case REG_LIMIT: {
        // The pass element saturating: x = imax·(1 − e^(−d/vsat)) of the headroom
        // d = vin − vout, linearized at the previous headroom and stepped at most vsat at
        // a time, the way junctions are limited. Smooth, so a limiter fed by an upstream
        // limiter settles on passing what it gets instead of demanding the impossible.
        const vsat = Math.max(dropout, 0.2)
        let d = vin - vout
        const dPrev = prev === REG_LIMIT ? this.jA[i] : d
        if (d > dPrev + vsat) {
          d = dPrev + vsat
          clamped = true
        } else if (d < dPrev - vsat) {
          d = dPrev - vsat
          clamped = true
        }
        this.jA[i] = d
        let f: number
        let gk: number
        if (d <= 0) {
          f = 0
          gk = (imax / vsat) * 0.01
        } else {
          const e = Math.exp(-d / vsat)
          f = imax * (1 - e)
          gk = Math.max(1e-6, (imax / vsat) * e)
        }
        A[this.cell(r, r)] = 1
        if (inN !== GROUND) A[this.cell(r, inN)] -= gk
        if (outN !== GROUND) A[this.cell(r, outN)] += gk
        z[r] = f - gk * d
        break
      }
      default:
        A[this.cell(r, r)] = 1
        z[r] = 0
    }
    return clamped
  }

  private boost(i: number, el: Extract<Resolved, { kind: "BOOST" }>): boolean {
    const { A, z, x } = this
    const n = this.net.nodes
    const g = (k: number) => (k === GROUND ? 0 : this.guess[k])
    const r = n + el.index
    const prev = this.rRegion[i]
    const running = prev === BOOST_REGULATE || prev === BOOST_LIMIT
    let clamped = false
    const step = (now: number, last: number) => {
      if (!running || Math.abs(now - last) <= BOOST_STEP) return now
      clamped = true
      return last + Math.sign(now - last) * BOOST_STEP
    }
    const bal = el.vcc ?? el.in
    const vi = step(g(bal) - g(el.gnd), this.jA[i])
    const vo = step(g(el.out) - g(el.gnd), this.jB[i])
    this.jA[i] = vi
    this.jB[i] = vo
    const vfb = g(el.fb) - g(el.gnd)
    const xPrev = x[r]
    const viE = Math.max(vi, 0.05)
    const up = vo > el.eff * viE
    const iinPrev = (up ? vo / (el.eff * viE) : 1) * xPrev
    const off = el.en !== undefined && g(el.en) - g(el.gnd) < BOOST_EN
    const headroom = off ? -1 : vi - el.uvlo
    const fold = headroom > 0 ? Math.exp(-headroom / BOOST_FOLD) : 1
    const limit = headroom > 0 ? el.ilim * (1 - fold) : 0
    let mode: number
    if (off) mode = BOOST_UVLO
    else if (prev === BOOST_UVLO) mode = vi < el.uvlo + BOOST_UVLO_HYST ? BOOST_UVLO : vfb < el.vref - 1e-3 ? BOOST_REGULATE : BOOST_IDLE
    else if (prev === BOOST_LIMIT) mode = vfb >= el.vref - 1e-3 && headroom > 0 ? BOOST_REGULATE : BOOST_LIMIT
    else if (prev === BOOST_IDLE) mode = vi < el.uvlo ? BOOST_UVLO : vfb < el.vref - 1e-3 ? BOOST_REGULATE : BOOST_IDLE
    else if (iinPrev > limit || headroom <= 0) mode = BOOST_LIMIT
    else if (xPrev < -1e-6 || vfb > el.vref + 1e-3) mode = BOOST_IDLE
    else mode = BOOST_REGULATE
    if (this.frozen) mode = prev
    this.rRegion[i] = mode
    if (mode === BOOST_UVLO || mode === BOOST_IDLE || (mode === BOOST_LIMIT && headroom <= 0)) {
      A[this.cell(r, r)] = 1
      z[r] = 0
      if (mode === BOOST_IDLE) this.addI(el.in, el.gnd, el.iq)
      return mode !== prev || clamped
    }
    if (el.out !== GROUND) A[this.cell(el.out, r)] -= 1
    if (el.gnd !== GROUND) A[this.cell(el.gnd, r)] += 1
    let a1 = 0
    let a2 = 1
    let a3 = 0
    if (up) {
      a1 = xPrev / (el.eff * viE)
      a2 = vo / (el.eff * viE)
      a3 = -(vo * xPrev) / (el.eff * viE * viE)
    }
    const c = iinPrev - a1 * vo - a2 * xPrev - a3 * vi
    this.boostInput(el.in, 1, el, r, a1, a2, a3, c + el.iq)
    this.boostInput(el.gnd, -1, el, r, a1, a2, a3, c + el.iq)
    if (mode === BOOST_REGULATE) {
      if (el.fb !== GROUND) A[this.cell(r, el.fb)] += 1
      if (el.gnd !== GROUND) A[this.cell(r, el.gnd)] -= 1
      A[this.cell(r, r)] += BOOST_DROOP
      z[r] = el.vref
    } else {
      const slope = (el.ilim / BOOST_FOLD) * fold
      if (el.out !== GROUND) A[this.cell(r, el.out)] += a1
      if (el.gnd !== GROUND) A[this.cell(r, el.gnd)] -= a1 + a3 - slope
      if (bal !== GROUND) A[this.cell(r, bal)] += a3 - slope
      A[this.cell(r, r)] += a2
      z[r] = limit - slope * vi - c
    }
    return mode !== prev || clamped
  }

  private boostInput(node: number, s: number, el: Extract<Resolved, { kind: "BOOST" }>, r: number, a1: number, a2: number, a3: number, c: number) {
    if (node === GROUND) return
    const { A, z } = this
    if (el.out !== GROUND) A[this.cell(node, el.out)] += s * a1
    if (el.gnd !== GROUND) A[this.cell(node, el.gnd)] -= s * (a1 + a3)
    const bal = el.vcc ?? el.in
    if (bal !== GROUND) A[this.cell(node, bal)] += s * a3
    A[this.cell(node, r)] += s * a2
    z[node] -= s * c
  }

  /** The operating points by switch/pad state, a few of the last distinct ones. */
  private readonly memo = new Map<number, OperatingPoint>()
  private frozen = false
  private remember(mask: number) {
    const live = this.liveElements
    const point = this.memo.get(mask) ?? {
      v: new Float64Array(this.v.length),
      x: new Float64Array(this.x.length),
      region: new Uint8Array(this.rRegion.length),
      jA: new Float64Array(this.jA.length),
      jB: new Float64Array(this.jB.length),
      live: new Float64Array(live.length),
    }
    point.v.set(this.v)
    point.x.set(this.x)
    point.region.set(this.rRegion)
    point.jA.set(this.jA)
    point.jB.set(this.jB)
    for (let k = 0; k < live.length; k++) point.live[k] = this.liveValue(live[k])
    this.memo.delete(mask)
    this.memo.set(mask, point)
    if (this.memo.size > MEMO_POINTS) this.memo.delete(this.memo.keys().next().value!)
  }
  /** The mask rounds live resistances and leaves DAC voltages out: those must match exactly. */
  private memoMatches(point: OperatingPoint): boolean {
    const live = this.liveElements
    for (let k = 0; k < live.length; k++) if (point.live[k] !== this.liveValue(live[k])) return false
    return true
  }

  private liveValue(i: number): number {
    return this.net.elements[i].kind === "GPIO" ? this.gpioVolts[i] : this.ohms[i]
  }

  /**
   * Nodes to measure between, two entries per probe. Setting them is cheap and may happen
   * mid-run; the statistics start over whenever the pairs change.
   */
  setProbes(nodes: ArrayLike<number>) {
    let same = this.probeNodes.length === nodes.length
    for (let i = 0; same && i < nodes.length; i++) same = this.probeNodes[i] === nodes[i]
    if (same) return
    this.probeNodes = Int32Array.from(nodes as ArrayLike<number>)
    this.probeAcc = new Float64Array((nodes.length >> 1) * 4)
    this.probeLast = new Float64Array((nodes.length >> 1) * 4)
    this.resetProbeWindow()
    this.probeLastSamples = 0
    this.resetTrace()
  }

  /** Start (or stop, with 0) collecting oscilloscope buckets of `bucket` seconds. */
  setTrace(bucket: number) {
    if (bucket === this.traceBucket) return
    this.traceBucket = bucket
    this.resetTrace()
  }

  private resetTrace() {
    const probes = this.probeNodes.length >> 1
    this.traceAcc = new Float64Array(probes * 2)
    for (let p = 0; p < probes; p++) {
      this.traceAcc[p * 2] = Infinity
      this.traceAcc[p * 2 + 1] = -Infinity
    }
    this.traceSeconds = 0
    this.traceOut = []
    this.traceStart = this.time
  }

  /** Hand over the buckets finished since the last call. */
  drainTrace(): TraceChunk {
    const probes = this.probeNodes.length >> 1
    const stride = probes * 2
    const count = stride ? this.traceOut.length / stride : 0
    const chunk = { start: this.traceStart, bucket: this.traceBucket, count, data: Float32Array.from(this.traceOut) }
    this.traceOut = []
    this.traceStart += count * this.traceBucket
    return chunk
  }

  private resetProbeWindow() {
    for (let p = 0; p < this.probeAcc.length; p += 4) {
      this.probeAcc[p] = 0
      this.probeAcc[p + 1] = 0
      this.probeAcc[p + 2] = Infinity
      this.probeAcc[p + 3] = -Infinity
    }
    this.probeSeconds = 0
    this.probeSamples = 0
  }

  /**
   * Accumulate what every probe sees this step.
   *
   * Over a window rather than through a running mean: a mean that is quick enough to follow
   * the circuit still ripples at the signal's own frequency, and a decaying peak sags between
   * one cycle's crest and the next. Summing a whole window and reporting the last finished one
   * gives an exact RMS, mean and pair of extremes, refreshed a few times a second.
   */
  private updateProbes(dt: number) {
    const nodes = this.probeNodes
    if (nodes.length === 0) return
    const acc = this.probeAcc
    const tracing = this.traceBucket > 0
    const trace = this.traceAcc
    // The instant a gap struck is a real point of the waveform, if not a whole sample of it:
    // it sets the extremes so the spike shows, and nothing else.
    if (this.struck) {
      const sv = this.strikeV
      for (let p = 0; p < nodes.length >> 1; p++) {
        const d = this.vol(nodes[p * 2], sv) - this.vol(nodes[p * 2 + 1], sv)
        const s = p * 4
        if (d < acc[s + 2]) acc[s + 2] = d
        if (d > acc[s + 3]) acc[s + 3] = d
        if (tracing) {
          if (d < trace[p * 2]) trace[p * 2] = d
          if (d > trace[p * 2 + 1]) trace[p * 2 + 1] = d
        }
      }
    }
    for (let p = 0; p < nodes.length >> 1; p++) {
      const d = this.vol(nodes[p * 2], this.v) - this.vol(nodes[p * 2 + 1], this.v)
      const s = p * 4
      acc[s] += d
      acc[s + 1] += d * d
      if (d < acc[s + 2]) acc[s + 2] = d
      if (d > acc[s + 3]) acc[s + 3] = d
      if (tracing) {
        if (d < trace[p * 2]) trace[p * 2] = d
        if (d > trace[p * 2 + 1]) trace[p * 2 + 1] = d
      }
    }
    if (tracing) {
      this.traceSeconds += dt
      if (this.traceSeconds >= this.traceBucket - 1e-12) {
        for (let p = 0; p < trace.length; p += 2) {
          this.traceOut.push(trace[p], trace[p + 1])
          trace[p] = Infinity
          trace[p + 1] = -Infinity
        }
        this.traceSeconds -= this.traceBucket
      }
    }
    this.probeSeconds += dt
    this.probeSamples++
    // A window is a few cycles of the slowest source, and at least RMS_MIN_TAU on DC.
    if (this.probeSeconds >= Math.max(RMS_MIN_TAU, this.tau)) {
      this.probeLast.set(acc)
      this.probeLastSamples = this.probeSamples
      this.resetProbeWindow()
    }
  }

  /** What each probe reads now, in the order the pairs were given. */
  probeReadings(): ProbeReading[] {
    // Before the first window closes the partial one still beats showing nothing.
    const done = this.probeLastSamples > 0
    const src = done ? this.probeLast : this.probeAcc
    const count = done ? this.probeLastSamples : this.probeSamples
    const out: ProbeReading[] = []
    for (let p = 0; p < this.probeNodes.length >> 1; p++) {
      const s = p * 4
      const v = this.vol(this.probeNodes[p * 2], this.v) - this.vol(this.probeNodes[p * 2 + 1], this.v)
      out.push(
        count > 0
          ? { v, rms: Math.sqrt(src[s + 1] / count), avg: src[s] / count, min: src[s + 2], max: src[s + 3] }
          : { v, rms: Math.abs(v), avg: v, min: v, max: v },
      )
    }
    return out
  }

  /** Energy-storage state, terminal currents and the operating point of every element. */
  private updateState(dt: number, parts: PartReader) {
    const { x } = this
    const n = this.net.nodes
    const elements = this.net.elements
    const tc = this.termCurrent
    tc.fill(0)
    if (this.struck) this.strikeRatings()

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const base = i * TERM_SLOTS
      switch (el.kind) {
        case "R": {
          const vd = this.vol(el.a, this.v) - this.vol(el.b, this.v)
          const cur = vd / this.ohms[i]
          tc[this.termOf[base]] += cur
          tc[this.termOf[base + 1]] -= cur
          this.record(el, i, dt, cur, vd, vd * cur)
          break
        }
        case "C": {
          const vNow = this.vol(el.a, this.v) - this.vol(el.b, this.v)
          const cur = (el.value / (this.theta * dt)) * (vNow - this.capV[i]) - ((1 - this.theta) / this.theta) * this.capI[i]
          tc[this.termOf[base]] += cur
          tc[this.termOf[base + 1]] -= cur
          this.capV[i] = vNow
          this.capI[i] = cur
          this.record(el, i, dt, cur, vNow, 0)
          break
        }
        case "L": {
          const vd = this.vol(el.a, this.v) - this.vol(el.b, this.v)
          const cur = this.indI[i] + (dt / el.value) * (this.theta * vd + (1 - this.theta) * this.indV[i])
          this.indI[i] = cur
          this.indV[i] = vd
          tc[this.termOf[base]] += cur
          tc[this.termOf[base + 1]] -= cur
          this.record(el, i, dt, cur, vd, 0)
          break
        }
        case "V": {
          const cur = x[n + el.index]
          const vs = this.sourceVoltage(el, this.time + dt)
          tc[this.termOf[base]] += cur
          tc[this.termOf[base + 1]] -= cur
          this.record(el, i, dt, cur, vs, Math.abs(cur * vs))
          break
        }
        case "BAT": {
          // The node leak (GMIN) through an open circuit is not a load.
          const cur = Math.abs(x[n + el.index]) < BAT_LEAK ? 0 : x[n + el.index]
          const vt = this.vol(el.plus, this.v) - this.vol(el.minus, this.v)
          tc[this.termOf[base]] += cur
          tc[this.termOf[base + 1]] -= cur
          this.record(el, i, dt, cur, vt, Math.abs(cur * vt))
          if (!this.converged) break
          const chem = el.chem
          const drain = -cur
          const temp = this.batT[i]
          // Coulomb counting per cell with the chemistry's rate loss — the same current through
          // every cell, so a smaller one drains faster; an exhausted cell stops at the floor.
          // The cell that matters is the one that empties first on discharge, fills first on charge.
          let worst = drain >= 0 ? -Infinity : Infinity
          for (let k = 0; k < el.cells; k++) {
            const rate = drainRate(chem, this.cellCapacity(el, i, k), drain, temp)
            if (drain >= 0 ? rate > worst : rate < worst) worst = rate
            const at = i * MAX_CELLS + k
            this.batSoc[at] = Math.max(-DEAD_SOC, this.batSoc[at] - rate * dt)
          }
          this.batThru[i] += Math.abs(drain) * dt
          // Diffusion: each RC pair charges towards drain × R with its own time constant.
          const r0 = this.batR[i]
          const pol = chem.polarization
          this.batV1[i] += ((drain * pol.r1 * r0 - this.batV1[i]) * dt) / pol.tau1
          this.batV2[i] += ((drain * pol.r2 * r0 - this.batV2[i]) * dt) / pol.tau2
          // Self-heating: the ohmic and diffusion losses warm the cell; it cools to the air through its surface.
          const heat = drain * drain * r0 + drain * (this.batV1[i] + this.batV2[i])
          this.batT[i] += ((heat - (temp - el.temp) / thermalResistance(chem, el.capacity)) * dt) / thermalMass(chem, el.capacity)
          this.batAge[i] += dt
          // Sliding window: the charge of this step goes into the bucket being filled.
          const slot = i * BAT_AVG_BUCKETS + this.batWinAt[i]
          this.batWinI[slot] += drain * dt
          this.batWinRate[slot] += worst * dt
          this.batWinFill[i] += dt
          if (this.batWinFill[i] >= BAT_AVG_BUCKET) {
            this.batWinFill[i] -= BAT_AVG_BUCKET
            this.batWinAt[i] = (this.batWinAt[i] + 1) % BAT_AVG_BUCKETS
            const next = i * BAT_AVG_BUCKETS + this.batWinAt[i]
            this.batWinI[next] = 0
            this.batWinRate[next] = 0
          }
          this.batteryState(i)
          const [lo, hi] = this.batteryCells(el, i)
          if (this.batT[i] > chem.thermal.tVent) {
            this.failWith(el, chem.thermal.fail, `reached ${this.batT[i].toFixed(0)} °C: ${chem.thermal.what}`)
          } else if (chem.chargeEfficiency === 0) {
            // A primary cell cannot take a charge: the current forced in makes gas until the seal gives.
            if (drain < 0) this.batCharged[i] -= drain * dt
            if (this.batCharged[i] > PRIMARY_CHARGE_LIMIT * el.capacity * 3600)
              this.failWith(el, "open", `charged with ${formatSI(-drain, "A")}: a primary cell, it vented`)
          } else if (chem.overcharge && hi > 1 + chem.overcharge.soc) {
            this.failWith(el, chem.overcharge.fail, `${el.cells > 1 ? "a cell " : ""}overcharged to ${formatSI(cellOcv(chem, hi), "V")}: ${chem.overcharge.what}`)
          } else if (chem.deepDischarge && lo < -chem.deepDischarge.soc) {
            this.failWith(el, "open", `${el.cells > 1 ? "a cell " : ""}discharged below ${formatSI(cellOcv(chem, 0), "V")}: ${chem.deepDischarge.what}`)
          }
          break
        }
        case "XFMR": {
          const is = x[n + el.index]
          const vs = this.vol(el.s1, this.v) - this.vol(el.s2, this.v)
          tc[this.termOf[base]] += -el.ratio * is
          tc[this.termOf[base + 1]] += el.ratio * is
          tc[this.termOf[base + 2]] += is
          tc[this.termOf[base + 3]] -= is
          // Readings are the secondary side; the power is what passes through.
          this.record(el, i, dt, is, vs, Math.abs(vs * is))
          break
        }
        case "SW": {
          const closed = switchClosed(el.closed, parts(this.partKeys[i]))
          const arcing = !closed && this.arc[i] !== 0
          const vd = this.vol(el.a, this.v) - this.vol(el.b, this.v)
          const pol = this.arc[i] === 2 ? -1 : 1
          const cur = closed ? vd / el.ron : arcing ? (vd - pol * V_ARC) / R_ARC : 0
          tc[this.termOf[base]] += cur
          tc[this.termOf[base + 1]] -= cur
          // The arc goes out once the load can no longer feed it.
          if (arcing && pol * cur < ARC_HOLD) this.arc[i] = 0
          this.rRegion[i] = closed ? 1 : arcing ? 2 : 0
          this.record(el, i, dt, cur, vd, Math.abs(vd * cur))
          break
        }
        case "GPIO": {
          const st = this.gpioState[i]
          const vn = this.vol(el.node, this.v)
          const rated = el.gndNet === undefined ? vn : vn - this.vol(el.gndNet, this.v)
          if (st === 0) {
            this.record(el, i, dt, 0, vn, 0, rated)
            break
          }
          if (st === GPIO_VOLTS) {
            const cur = (vn - this.gpioVolts[i]) / R_DAC
            tc[this.termOf[base]] += cur
            this.record(el, i, dt, cur, vn, Math.abs(cur * cur * R_DAC), rated)
            break
          }
          const r = st <= 2 ? this.ohms[i] : R_PULL
          const high = st === 1 || st === 3
          const rail = high ? (el.vddNet !== undefined ? this.vol(el.vddNet, this.v) : el.vdd) : el.gndNet !== undefined ? this.vol(el.gndNet, this.v) : 0
          const cur = (vn - rail) / r
          tc[this.termOf[base]] += cur
          if (high && el.vddNet !== undefined) tc[this.termOf[base + 1]] -= cur
          if (!high && el.gndNet !== undefined) tc[this.termOf[base + 2]] -= cur
          this.record(el, i, dt, cur, vn, Math.abs(cur * cur * r), rated)
          break
        }
        case "REG": {
          const cur = x[n + el.index]
          const vin = this.vol(el.in, this.v) - this.vol(el.gnd, this.v)
          const vout = this.vol(el.out, this.v) - this.vol(el.gnd, this.v)
          tc[this.termOf[base]] += cur
          tc[this.termOf[base + 1]] -= cur
          this.record(el, i, dt, cur, vout, Math.max(0, (vin - vout) * cur))
          break
        }
        case "CHG": {
          const ich = x[n + el.index]
          const iprog = Math.max(0, -x[n + el.prog])
          const vin = this.vol(el.in, this.v) - this.vol(el.gnd, this.v)
          const vb = this.vol(el.bat, this.v) - this.vol(el.gnd, this.v)
          const st = this.ctl[i]
          const sink = (pin: number | undefined, on: boolean) => (on && pin !== undefined ? (this.vol(pin, this.v) - this.vol(el.gnd, this.v)) / CHG_OD_R : 0)
          const ichrg = sink(el.chrg, st === CHG_TRICKLING || st === CHG_CHARGING)
          const istdby = sink(el.stdby, st === CHG_DONE)
          tc[this.termOf[base]] += ich
          tc[this.termOf[base + 1]] -= ich
          tc[this.termOf[base + 2]] += iprog - ichrg - istdby
          tc[this.termOf[base + 3]] -= iprog
          tc[this.termOf[base + 4]] += ichrg
          tc[this.termOf[base + 5]] += istdby
          this.rIb[i] = iprog
          this.record(el, i, dt, ich, vb, Math.max(0, (vin - vb) * ich), vin)
          if (this.converged) this.charger(el, i, dt, vin, vb, ich, iprog)
          else if (vin < CHG_UVLO - CHG_UVLO_HYST) this.ctl[i] = CHG_OFF
          break
        }
        case "PROT": {
          const vdd = this.vol(el.vdd, this.v)
          const vss = this.vol(el.vss, this.v)
          const cs = this.vol(el.cs, this.v)
          const st = this.ctl[i]
          const drive = (slot: number, pin: number, rail: number) => {
            const cur = (this.vol(pin, this.v) - this.vol(rail, this.v)) / PROT_DRIVE_R
            tc[this.termOf[base + slot]] += cur
            tc[this.termOf[base + (rail === el.vdd ? 0 : rail === el.vss ? 1 : 2)]] -= cur
          }
          drive(3, el.od, st & (PROT_DISCHARGE_OFF | PROT_OVERCURRENT_OFF) ? el.vss : el.vdd)
          drive(4, el.oc, st & PROT_CHARGE_OFF ? el.cs : el.vdd)
          if (st & PROT_OVERCURRENT_OFF) {
            tc[this.termOf[base + 2]] += (cs - vss) / el.spec.releaseR
            tc[this.termOf[base + 1]] -= (cs - vss) / el.spec.releaseR
          }
          this.rVbe[i] = cs - vss
          this.record(el, i, dt, 0, vdd - vss, 0)
          if (this.converged) this.protection(el, i, dt, vdd - vss, cs - vss)
          break
        }
        case "BOOST": {
          const xo = x[n + el.index]
          const vi = this.vol(el.vcc ?? el.in, this.v) - this.vol(el.gnd, this.v)
          const vo = this.vol(el.out, this.v) - this.vol(el.gnd, this.v)
          const mode = this.rRegion[i]
          const on = mode === BOOST_REGULATE || (mode === BOOST_LIMIT && vi > el.uvlo)
          const iin = on ? Math.max(vo / (el.eff * Math.max(vi, 0.05)), 1) * xo + el.iq : mode === BOOST_IDLE ? el.iq : 0
          const out = on ? xo : 0
          tc[this.termOf[base]] += iin
          tc[this.termOf[base + 1]] -= out
          tc[this.termOf[base + 2]] += out - iin
          this.rIb[i] = iin
          this.record(el, i, dt, out, vo, Math.max(0, vi * iin - vo * out))
          break
        }
        case "TMR":
          this.timerState555(el, i, dt, base)
          break
        case "D": {
          const vd = this.vol(el.anode, this.v) - this.vol(el.cathode, this.v)
          const nvt = el.n * VT
          let cur = el.is * (Math.exp(Math.min(vd / nvt, 80)) - 1)
          if (el.zener) cur -= el.is * (Math.exp(Math.min(-(vd + el.zener) / nvt, 80)) - 1)
          this.diodeI[i] = cur
          // What the eye sees: the current averaged over ~10 ms, so a PWM-dimmed LED reads as
          // dim rather than strobing with the snapshot phase. On AC the RMS window applies.
          this.diodeAvg[i] = !this.msPrimed ? cur : this.ac ? this.ema(this.diodeAvg[i], cur, dt) : this.diodeAvg[i] + (cur - this.diodeAvg[i]) * Math.min(1, dt / LED_EYE_TAU)
          tc[this.termOf[base]] += cur
          tc[this.termOf[base + 1]] -= cur
          // Reverse voltage counts against the rating only for plain diodes; zeners are meant to break down.
          this.record(el, i, dt, cur, vd, Math.abs(vd * cur), el.zener ? 0 : Math.min(0, vd))
          break
        }
        case "Q": {
          const s = el.polarity
          const vbe = this.vol(el.b, this.v) - this.vol(el.e, this.v)
          const vce = this.vol(el.c, this.v) - this.vol(el.e, this.v)
          const ef = Math.exp(Math.min((s * vbe) / VT, 80))
          const er = Math.exp(Math.min((s * (vbe - vce)) / VT, 80))
          const iF = Q_IS * (ef - 1)
          const iR = Q_IS * (er - 1)
          const ic = iF - iR - iR / Q_BR
          const ib = iF / el.beta + iR / Q_BR
          tc[this.termOf[base]] += s * ib
          tc[this.termOf[base + 1]] += s * ic
          tc[this.termOf[base + 2]] += -s * (ic + ib)
          this.rVbe[i] = vbe
          this.rIb[i] = ib
          this.rRegion[i] =
            s * vbe < 0.5 ? 0 : Math.abs(vce) < 0.3 ? 1 : s * (vbe - vce) > 0.5 ? 2 : 3
          // Pin to pin: the drop across the collector resistance is the part's, and so is its heat.
          const vcePin = this.vol(el.cPin, this.v) - this.vol(el.e, this.v)
          this.record(el, i, dt, ic, vcePin, Math.abs(vcePin * ic) + Math.abs(vbe * ib))
          break
        }
        case "M": {
          const s = el.polarity
          const vdsRaw = s * (this.vol(el.d, this.v) - this.vol(el.s, this.v))
          const swap = vdsRaw < 0
          const sn = swap ? el.d : el.s
          const vgs = s * (this.vol(el.g, this.v) - this.vol(sn, this.v))
          const [id, , , region] = this.mosfet(el, vgs, Math.abs(vdsRaw))
          // Current into the drain terminal; it comes out of the source. Gate draws nothing.
          const into = (swap ? -1 : 1) * s * id
          tc[this.termOf[base + 1]] += into
          tc[this.termOf[base + 2]] -= into
          this.rVbe[i] = s * (this.vol(el.g, this.v) - this.vol(el.s, this.v))
          this.rRegion[i] = swap && id > 0 ? 2 : region
          this.record(el, i, dt, into, vdsRaw, Math.abs(vdsRaw * id))
          break
        }
      }
    }
  }

  private timerState555(el: Timer, i: number, dt: number, base: number) {
    const tc = this.termCurrent
    const out = this.branchOut
    const st = this.ctl[i]
    const high = (st & TMR_HIGH) !== 0
    const v = this.v
    const vcc = this.vol(el.vcc, v)
    const gnd = this.vol(el.gnd, v)
    const supply = vcc - gnd
    quiescent(supply, high, out)
    const iq = out[0]
    const vo = this.vol(el.out, v) - gnd
    const vd = this.vol(el.dis, v) - gnd
    const vtrig = this.vol(el.trig, v)
    const vthres = this.vol(el.thres, v) - gnd
    const vreset = this.vol(el.reset, v) - gnd
    let source = 0
    let sink = 0
    let discharge = 0
    let trig = 0
    let thres = 0
    let reset = 0
    if (st & TMR_POWERED) {
      if (high) {
        outputSource(supply - vo, out)
        source = out[0]
      } else {
        outputSink(vo, supply, out)
        sink = out[0]
        dischargeSink(vd, supply, out)
        discharge = out[0]
      }
      bias(NE555.triggerBias * supplyShare(supply), vcc - vtrig, out)
      trig = out[0]
      bias(NE555.thresholdBias * supplyShare(supply), vthres, out)
      thres = out[0]
      reset = NE555.resetGrounded - ((NE555.resetGrounded + NE555.resetAtSupply) / supply) * vreset
    }
    tc[this.termOf[base]] += iq + source + trig + reset
    tc[this.termOf[base + 1]] -= iq + sink + discharge + thres
    tc[this.termOf[base + 2]] += sink - source
    tc[this.termOf[base + 3]] += discharge
    tc[this.termOf[base + 4]] -= trig
    tc[this.termOf[base + 5]] += thres
    tc[this.termOf[base + 6]] -= reset
    const power = iq * supply + source * (supply - vo) + sink * vo + discharge * vd + trig * (vcc - vtrig) + thres * vthres + reset * (supply - vreset)
    this.record(el, i, dt, source - sink, supply, power)
  }

  private charger(el: Extract<Resolved, { kind: "CHG" }>, i: number, dt: number, vin: number, vb: number, ich: number, iprog: number) {
    const st = this.ctl[i]
    const at = (pin: number) => this.vol(pin, this.v) - this.vol(el.gnd, this.v)
    const enabled = el.ce === undefined || at(el.ce) > CHG_CE
    const temp = el.temp === undefined ? 0 : at(el.temp)
    const cool = temp < CHG_TEMP_OFF * vin || (temp > CHG_TEMP_LOW * vin && temp < CHG_TEMP_HIGH * vin)
    const powered = enabled && cool && (st === CHG_OFF ? vin >= CHG_UVLO && vin - vb >= CHG_WAKE : vin >= CHG_UVLO - CHG_UVLO_HYST && vin - vb >= CHG_SLEEP)
    let next = st
    if (!powered) next = CHG_OFF
    else if (st === CHG_OFF) next = vb < CHG_TRICKLE ? CHG_TRICKLING : CHG_CHARGING
    else if (st === CHG_TRICKLING) {
      if (vb >= CHG_TRICKLE) next = CHG_CHARGING
    } else if (st === CHG_CHARGING) {
      if (vb < CHG_TRICKLE - CHG_TRICKLE_HYST) next = CHG_TRICKLING
      else if (this.hold(i * 3, this.rRegion[i] === REG_REGULATE && ich < CHG_TERM * CHG_GAIN * iprog, dt, CHG_TERM_TIME)) next = CHG_DONE
    } else if (vb < el.value - CHG_RECHARGE) next = CHG_CHARGING
    if (next !== st) {
      this.ctl[i] = next
      this.ctlT[i * 3] = 0
    }
  }

  private protection(el: Extract<Resolved, { kind: "PROT" }>, i: number, dt: number, vcell: number, vcs: number) {
    let st = this.ctl[i]
    const t = i * 3
    const s = el.spec
    if (st & PROT_CHARGE_OFF) {
      if (vcell < s.overchargeRelease || (vcs > PROT_LOAD && vcell <= s.overcharge)) st &= ~PROT_CHARGE_OFF
    } else if (this.hold(t, vcell > s.overcharge, dt, s.overchargeDelay)) st |= PROT_CHARGE_OFF
    const charger = vcs < -s.charger
    if (st & PROT_DISCHARGE_OFF) {
      if (vcell > s.overdischargeRelease || (charger && vcell > s.overdischarge)) st &= ~PROT_DISCHARGE_OFF
    } else if (this.hold(t + 1, vcell < s.overdischarge, dt, s.overdischargeDelay)) st |= PROT_DISCHARGE_OFF
    if (st & PROT_OVERCURRENT_OFF) {
      if (vcs < s.overcurrent) st &= ~(PROT_OVERCURRENT_OFF | PROT_SHORTED)
    } else if (st & PROT_DISCHARGE_OFF) this.ctlT[t + 2] = 0
    else if (vcs > s.short && this.hold(t + 2, true, dt, s.shortDelay)) st |= PROT_OVERCURRENT_OFF | PROT_SHORTED
    else if (vcs <= s.short && this.hold(t + 2, vcs > s.overcurrent, dt, s.overcurrentDelay)) st |= PROT_OVERCURRENT_OFF
    this.ctl[i] = st
  }

  private hold(slot: number, cond: boolean, dt: number, delay: number): boolean {
    this.ctlT[slot] = Math.max(0, this.ctlT[slot] + (cond ? dt : -dt))
    if (this.ctlT[slot] < delay) return false
    this.ctlT[slot] = 0
    return true
  }

  /** Record the operating point and check it against the ratings; records a failure when it breaks. */
  private record(el: Resolved, i: number, dt: number, cur: number, v: number, p: number, ratedV = v) {
    this.rCurrent[i] = cur
    this.rVoltage[i] = v
    this.rPower[i] = p
    // A step the solver could not settle is not evidence of anything: an exponential evaluated
    // at a stray iterate reads megawatts. Such a step still shows its (flagged) numbers, but it
    // must not heat a part, break one, or poison the running averages.
    if (!this.converged) return
    let iLoad = Math.abs(cur)
    let pLoad = p
    if (this.ac) {
      if (this.msPrimed) {
        this.msI[i] = this.ema(this.msI[i], cur * cur, dt)
        this.msV[i] = this.ema(this.msV[i], v * v, dt)
        this.msP[i] = this.ema(this.msP[i], p, dt)
      } else {
        this.msI[i] = cur * cur
        this.msV[i] = v * v
        this.msP[i] = p
      }
      iLoad = Math.sqrt(this.msI[i])
      pLoad = this.msP[i]
    }
    const lim = this.limitsOf[i]
    if (!lim) {
      this.rLoad[i] = -1
      this.rRatio[i] = 0
      return
    }
    let load = lim.current !== undefined ? iLoad / lim.current : 0
    if (lim.power !== undefined && pLoad / lim.power > load) load = pLoad / lim.power
    if (lim.voltage !== undefined && Math.abs(ratedV) / lim.voltage > load) load = Math.abs(ratedV) / lim.voltage
    if (lim.reverse !== undefined && -ratedV / lim.reverse > load) load = -ratedV / lim.reverse
    this.rLoad[i] = load

    if (lim.voltage !== undefined && Math.abs(ratedV) > lim.voltage)
      return this.fail(el, lim.fail, "voltage", Math.abs(ratedV), lim.voltage, "V")
    // Polarity: an electrolytic the wrong way round breaks down long before its rating.
    if (lim.reverse !== undefined && -ratedV > lim.reverse)
      return this.fail(el, lim.fail, "reverse voltage", -ratedV, lim.reverse, "V")
    let heating = 0
    let what = "current"
    let actual = 0
    let rated = 0
    let unit = "A"
    if (lim.current !== undefined) {
      if (lim.surge !== undefined ? Math.abs(cur) > lim.surge : iLoad > SURGE * lim.current)
        return lim.surge !== undefined ? this.fail(el, lim.fail, "surge current", Math.abs(cur), lim.surge, "A") : this.fail(el, lim.fail, "current", iLoad, lim.current, "A")
      const r = Math.abs(cur) / lim.current
      heating = this.isDiode[i] ? r : r * r
      actual = iLoad
      rated = lim.current
    }
    if (lim.power !== undefined) {
      if (pLoad > SURGE * lim.power) return this.fail(el, lim.fail, "power", pLoad, lim.power, "W")
      if (Math.abs(p) / lim.power > heating) {
        heating = Math.abs(p) / lim.power
        what = "power"
        actual = pLoad
        rated = lim.power
        unit = "W"
      }
    }
    if (this.heatDt[i] !== dt) {
      this.heatDt[i] = dt
      this.heatShare[i] = -Math.expm1(-dt / lim.tau)
    }
    const heat = this.stress[i] + (heating - this.stress[i]) * this.heatShare[i]
    this.stress[i] = heat
    this.rRatio[i] = heating
    if (heat > 1) this.fail(el, lim.fail, what, actual, rated, unit)
  }

  private fail(el: Resolved, how: "open" | "short", what: string, actual: number, rated: number, unit: string) {
    this.failWith(el, how, `${what} ${formatSI(actual, unit)} exceeds the ${formatSI(rated, unit)} rating`)
  }

  private failWith(el: Resolved, how: "open" | "short", reason: string) {
    for (const f of this.failures) if (f.object === el.object && f.damage.element === el.element) return
    this.failures.push({
      object: el.object,
      ref: el.ref,
      damage: { element: el.element, fail: how, fatal: el.limits?.fatal ?? true, reason },
    })
  }

  /**
   * Voltage ratings against the state at the instant a gap struck: the circuit was there,
   * however briefly, and a junction rated below the spike breaks down on the way up.
   */
  private strikeRatings() {
    const v = this.strikeV
    const elements = this.net.elements
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const lim = el.limits
      if (!lim?.voltage) continue
      let mag: number
      switch (el.kind) {
        case "R":
        case "C":
        case "L":
          mag = Math.abs(this.vol(el.a, v) - this.vol(el.b, v))
          break
        case "D":
          if (el.zener) continue
          mag = Math.max(0, this.vol(el.cathode, v) - this.vol(el.anode, v))
          break
        case "Q":
          mag = Math.abs(this.vol(el.cPin, v) - this.vol(el.e, v))
          break
        case "M":
          mag = Math.abs(this.vol(el.d, v) - this.vol(el.s, v))
          break
        case "GPIO":
          mag = Math.abs(this.vol(el.node, v) - (el.gndNet === undefined ? 0 : this.vol(el.gndNet, v)))
          break
        default:
          continue
      }
      if (mag > lim.voltage) this.fail(el, lim.fail, "voltage", mag, lim.voltage, "V")
    }
  }

  // --- readouts; built on demand, not on every step ---

  /** Operating point of every element, in netlist order. */
  readings(): Reading[] {
    return this.net.elements.map((el, i) => {
      const load = this.rLoad[i]
      const reading: Reading = {
        object: el.object,
        element: el.element,
        kind: el.kind,
        current: this.rCurrent[i],
        voltage: this.rVoltage[i],
        power: this.rPower[i],
        load: load < 0 ? undefined : load,
        limits: el.limits,
        hidden: el.hidden,
      }
      if (el.kind === "Q") {
        reading.extra = {
          Vbe: formatSI(this.rVbe[i], "V"),
          Ib: formatSI(this.rIb[i], "A"),
          region: BJT_REGIONS[this.rRegion[i]],
        }
      } else if (el.kind === "M") {
        reading.extra = { Vgs: formatSI(this.rVbe[i], "V"), region: MOS_REGIONS[this.rRegion[i]] }
      } else if (el.kind === "SW") {
        reading.extra = { state: this.rRegion[i] === 1 ? "closed" : this.rRegion[i] === 2 ? "arcing" : "open" }
      } else if (el.kind === "REG") {
        reading.extra = { mode: REG_MODES[this.rRegion[i]] ?? "off" }
      } else if (el.kind === "CHG") {
        const st = this.ctl[i]
        const vin = this.vol(el.in, this.v) - this.vol(el.gnd, this.v)
        const state =
          st === CHG_TRICKLING
            ? "trickle"
            : st === CHG_CHARGING
              ? this.rRegion[i] === REG_LIMIT
                ? "constant current"
                : "constant voltage"
              : st === CHG_DONE
                ? "charged"
                : vin < CHG_UVLO
                  ? "no input"
                  : "sleep"
        reading.extra = { State: state, "Set current": formatSI(this.rIb[i] * CHG_GAIN, "A") }
      } else if (el.kind === "PROT") {
        const st = this.ctl[i]
        const off = [
          st & PROT_SHORTED ? "short circuit" : st & PROT_OVERCURRENT_OFF ? "overcurrent" : "",
          st & PROT_DISCHARGE_OFF ? "over-discharge" : "",
          st & PROT_CHARGE_OFF ? "overcharge" : "",
        ].filter(Boolean)
        reading.extra = { State: off.length ? off.join(", ") : "normal", "CS drop": formatSI(this.rVbe[i], "V") }
      } else if (el.kind === "BOOST") {
        reading.extra = { mode: BOOST_MODES[this.rRegion[i]], "Input current": formatSI(this.rIb[i], "A") }
      } else if (el.kind === "TMR") {
        reading.extra = this.timerReadout(el, i)
      } else if (el.kind === "V" && el.amplitude > 0) {
        reading.extra = { Frequency: formatSI(el.frequency, "Hz") }
        if (el.shape === "pulse") reading.extra.Duty = `${Math.round(el.duty * 100)} %`
      } else if (el.kind === "XFMR") {
        reading.extra = { Ratio: `1 : ${formatSI(el.ratio, "")}` }
      } else if (el.kind === "BAT") {
        // The pack is as empty as its weakest cell and as full as its strongest.
        const [lo, hi] = this.batteryCells(el, i)
        const [avg, rate] = this.batteryAverage(i)
        let weakest = 0
        let capNow = Infinity
        for (let k = 0; k < el.cells; k++) {
          const c = this.cellCapacity(el, i, k)
          if (c < capNow) {
            capNow = c
            weakest = k
          }
        }
        const nominal = el.capacity * this.cellSize(el, weakest)
        reading.charge = Math.max(0, lo)
        reading.extra = {
          Chemistry: `${el.chem.name}, ${el.cells} × ${formatSI(el.chem.nominal, "V")}`,
          "Open-circuit": formatSI(this.batOcv[i], "V"),
          "Internal R": formatSI(this.batR[i], "Ω"),
          Polarization: formatSI(this.batV1[i] + this.batV2[i], "V"),
          Temperature: `${this.batT[i].toFixed(1)} °C`,
          Capacity: `${formatSI(capNow, "Ah")} (${Math.round((capNow / nominal) * 100)} %)`,
          ...(el.cells > 1 && el.spread > 0 ? { Cells: `${Math.round(Math.max(0, lo) * 100)} – ${Math.round(Math.max(0, hi) * 100)} %` } : {}),
          [avg < 0 ? "Charging (avg)" : "Load (avg)"]: formatSI(Math.abs(avg), "A"),
          "Time left": batteryTimeLeft(lo, hi, rate, avg, el.chem.chargeEfficiency > 0),
        }
      }
      if (this.ac) {
        reading.rms = { current: Math.sqrt(this.msI[i]), voltage: Math.sqrt(this.msV[i]), power: this.msP[i] }
      }
      return reading
    })
  }

  private timerReadout(el: Timer, i: number): Record<string, string> {
    const st = this.ctl[i]
    const gnd = this.vol(el.gnd, this.v)
    const supply = this.vol(el.vcc, this.v) - gnd
    const extra: Record<string, string> = {
      Output: !(st & TMR_POWERED) ? "off" : st & TMR_HIGH ? "high" : "low",
      Discharge: st & TMR_POWERED && !(st & TMR_HIGH) ? "on" : "off",
      Thresholds: `${formatSI(this.vol(el.lo, this.v) - gnd, "V")} / ${formatSI(this.vol(el.ctrl, this.v) - gnd, "V")}`,
    }
    const t = i * 3
    const [rise0, rise1, fall] = [this.ctlT[t], this.ctlT[t + 1], this.ctlT[t + 2]]
    const period = rise1 - rise0
    if (period > 0 && this.time - rise1 < 3 * period) {
      const high = fall > rise0 && fall < rise1 ? fall - rise0 : fall > rise1 ? fall - rise1 : NaN
      extra.Frequency = formatSI(1 / period, "Hz")
      extra.Period = formatSI(period, "s")
      if (high > 0) extra.Duty = `${((high / period) * 100).toFixed(1)} %`
    } else if (fall > rise1) extra["Last pulse"] = formatSI(fall - rise1, "s")
    if (st & TMR_POWERED && supply < NE555.minimum) extra.Supply = `below the ${formatSI(NE555.minimum, "V")} minimum`
    else if (supply > NE555.maximum) extra.Supply = `above the ${formatSI(NE555.maximum, "V")} maximum`
    const outside = (
      [
        ["TRIG", el.trig],
        ["THRES", el.thres],
        ["RESET", el.reset],
        ["CONT", el.ctrl],
      ] as const
    ).filter(([, node]) => this.vol(node, this.v) - gnd > supply + TMR_INPUT_MARGIN || this.vol(node, this.v) - gnd < -TMR_INPUT_MARGIN)
    if (outside.length) extra.Inputs = `${outside.map(([name]) => name).join(", ")} outside 0 V…VCC, the absolute maximum`
    if (this.burstSeen[i]) extra.Timing = "too fast for the solver: transitions were deferred"
    this.burstSeen[i] = 0
    return extra
  }

  /** Current leaving the net into an element, per terminal node key. */
  terminalCurrents(): Map<string, number> {
    const out = new Map<string, number>()
    for (let i = 0; i < this.termKeys.length; i++) out.set(this.termKeys[i], this.termCurrent[i])
    return out
  }

  /** Terminal current slots after the last step, and the slot of a terminal key. */
  get terminalSlots(): { current: Float64Array; index: Map<string, number>; keys: string[] } {
    return { current: this.termCurrent, index: this.termIndex, keys: this.termKeys }
  }

  private cell(row: number, col: number): number {
    const at = row * this.size + col
    this.lu.touch(at)
    return at
  }

  private factorize(): boolean {
    this.luValid = this.lu.factorize(this.A)
    return this.luValid
  }

  private substitute(): boolean {
    return this.luValid && this.lu.solve(this.z, this.x)
  }
}

export type { Resolved }
