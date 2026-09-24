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
const MAX_ITER = 60
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
/**
 * Overload before a current/power rating breaks the part: the excess ratio integrates over
 * simulated time and the part fails once it exceeds this (10 ms at 2× the rating, 1 ms at 11×).
 */
const STRESS_LIMIT = 0.01
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
const Q_BR = 3
const BJT_REGIONS = ["cut-off", "saturation", "reverse", "active"] as const
const MOS_REGIONS = ["off", "ohmic", "reverse", "saturation"] as const

export type PartReader = (key: string) => PartState

/** Whether a switch element conducts given its part's state. */
function switchClosed(closed: "on" | "pressed" | "off", st: PartState): boolean {
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
  /** LU factors of `A` with the pivot order that produced them. */
  private readonly lu: Float64Array
  private readonly pivot: Int32Array
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
  /** Vbe and Ib of a BJT, and its region as an index into BJT_REGIONS. */
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
  /** RMS averaging time constant, seconds. */
  private readonly tau: number
  /** Switch/pad hash of the current step, and how many steps in a row ended at a fixed point. */
  private stepMask = 0
  private settledRun = 0
  private readonly hasBattery: boolean
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
    this.lu = new Float64Array(this.size * this.size)
    this.pivot = new Int32Array(this.size)

    let minFreq = Infinity
    let linear = true
    for (const el of net.elements) {
      if (el.kind === "V" && el.amplitude > 0 && el.frequency < minFreq) minFreq = el.frequency
      if (el.kind === "D" || el.kind === "Q" || el.kind === "M" || el.kind === "REG") linear = false
    }
    this.ac = minFreq < Infinity
    this.tau = this.ac ? Math.max(RMS_MIN_TAU, RMS_PERIODS / minFreq) : 0
    this.linear = linear
    this.partKeys = net.elements.map((el) => (el.kind === "SW" ? partKey(el.object, el.part) : ""))
    this.padElements = Int32Array.from(net.elements.flatMap((el, i) => (el.kind === "GPIO" || (el.kind === "R" && el.live) ? [i] : [])))
    this.diodeElements = Int32Array.from(net.elements.flatMap((el, i) => (el.kind === "D" ? [i] : [])))
    this.liveElements = Int32Array.from(net.elements.flatMap((el, i) => (el.kind === "GPIO" || (el.kind === "R" && el.live) ? [i] : [])))
    this.stateless = !net.elements.some((el) => el.kind === "C" || el.kind === "L" || el.kind === "BAT")
    this.hasBattery = net.elements.some((el) => el.kind === "BAT")

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
    this.termOf = new Int32Array(m * 4).fill(-1)
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
        this.termOf[i * 4 + k] = slot
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
    for (const [key, to] of this.net.pinNet) {
      const from = prev.net.pinNet.get(key)
      if (from !== undefined && to !== GROUND && from !== GROUND) this.v[to] = prev.v[from]
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
    const { A, size } = this
    if (a !== GROUND) A[a * size + a] += val
    if (b !== GROUND) A[b * size + b] += val
    if (a !== GROUND && b !== GROUND) {
      A[a * size + b] -= val
      A[b * size + a] -= val
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
    const { A, size } = this
    if (at === GROUND) return
    if (p !== GROUND) A[at * size + p] += gk
    if (q !== GROUND) A[at * size + q] -= gk
  }

  private vol(i: number, from: Float64Array) {
    return i === GROUND ? 0 : from[i]
  }

  /**
   * Stamp everything whose contribution to `A` does not depend on the solution. `withZ` also
   * fills the right-hand side; a reused factorization needs the right-hand side alone.
   */
  private stampLinear(dt: number, parts: PartReader, withA: boolean, withZ: boolean) {
    const { A, z, size } = this
    const n = this.net.nodes
    if (withA) for (let i = 0; i < n; i++) A[i * size + i] += GMIN
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
          const geq = el.value / (THETA * dt)
          if (withA) this.addG(el.a, el.b, geq)
          if (withZ) this.addI(el.a, el.b, -geq * this.capV[i] - ((1 - THETA) / THETA) * this.capI[i])
          break
        }
        case "L":
          if (withA) this.addG(el.a, el.b, (THETA * dt) / el.value)
          if (withZ) this.addI(el.a, el.b, this.indI[i] + (((1 - THETA) * dt) / el.value) * this.indV[i])
          break
        case "V": {
          const r = n + el.index
          if (withA) {
            if (el.plus !== GROUND) {
              A[el.plus * size + r] += 1
              A[r * size + el.plus] += 1
            }
            if (el.minus !== GROUND) {
              A[el.minus * size + r] -= 1
              A[r * size + el.minus] -= 1
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
              A[el.plus * size + r] += 1
              A[r * size + el.plus] += 1
            }
            if (el.minus !== GROUND) {
              A[el.minus * size + r] -= 1
              A[r * size + el.minus] -= 1
            }
            A[r * size + r] -= this.batR[i]
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
            A[node * size + r] += val
            A[r * size + node] += val
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
          const r = st <= 2 ? R_GPIO : R_PULL
          const high = st === 1 || st === 3
          if (high && el.vddNet !== undefined) {
            if (withA) this.addG(el.node, el.vddNet, 1 / r)
            break
          }
          if (withA) this.addG(el.node, GROUND, 1 / r)
          if (withZ && high) this.addI(GROUND, el.node, el.vdd / r)
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
    for (let j = 0; j < loaded.length; j++) {
      const i = loaded[j]
      const ratio = this.rRatio[i]
      const stress = ratio > 20 ? Infinity : Math.max(0, this.stress[i] + dt * (ratio - 1))
      if (stress > STRESS_LIMIT) return false
      this.stress[i] = stress
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
    for (let j = 0; j < loaded.length; j++) {
      const i = loaded[j]
      const ratio = this.rRatio[i]
      if (ratio > 20) return 0
      if (ratio > 1) steps = Math.min(steps, Math.floor((STRESS_LIMIT - this.stress[i]) / (dt * (ratio - 1))) - 1)
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
    if (!this.converged || this.struck || this.ac || this.hasBattery) return false
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
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      if (el.kind === "SW") mask = (mask * 31 + (switchClosed(el.closed, parts(this.partKeys[i])) ? 1 : this.arc[i] ? 2 : 0)) | 0
      else if (el.kind === "GPIO") mask = (mask * 31 + this.gpioState[i]) | 0
      else if (el.kind === "R" && el.live) mask = (mask * 31 + (this.ohms[i] | 0)) | 0
      else if (el.kind === "BAT") mask = (mask * 31 + this.batStep[i]) | 0
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
    const mask = this.switchMask(parts)
    if (mask !== this.stepMask) disturbed = true
    this.stepMask = mask
    if (disturbed) this.settledRun = 0

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
    this.prevV.set(this.v)
    // A gap that strikes changes the circuit within the step: solve the step again, from the
    // same start, with the arc in.
    for (let strike = 0; strike <= MAX_STRIKES; strike++) {
      if (strike > 0) this.v.set(this.prevV)
      this.converged = this.solve(dt, parts)
      if (strike === MAX_STRIKES || !this.checkStrikes(parts)) break
      // The arc is a switch state too: the next solve must not reuse the gap's factorization.
      this.stepMask = this.switchMask(parts)
    }

    this.updateState(dt, parts)
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
    this.time += dt
  }

  /**
   * An open switch whose gap voltage reached its strike voltage arcs over. The solution the
   * gap reached is kept at the instant of the strike — the circuit did pass through it — so
   * the probes see the spike and anything rated below it breaks; then the step is re-solved
   * with the arc conducting. Returns whether anything struck.
   */
  private checkStrikes(parts: PartReader): boolean {
    const elements = this.net.elements
    let struck = false
    let worst = 1
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      if (el.kind !== "SW" || this.arc[i] || el.strike === Infinity) continue
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
    for (let k = 0; k < n; k++) this.strikeV[k] = this.prevV[k] + (this.v[k] - this.prevV[k]) * worst
    this.struck = true
    return true
  }

  /** One solve of the step from the current state; returns whether Newton settled. */
  private solve(dt: number, parts: PartReader): boolean {
    const { A, z, x, guess, size } = this
    const n = this.net.nodes
    const elements = this.net.elements
    // Junction voltages start from the previous solution.
    if (!this.linear) {
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i]
        if (el.kind === "D") {
          this.jA[i] = this.vol(el.anode, this.v) - this.vol(el.cathode, this.v)
          this.jB[i] = 0
        } else if (el.kind === "Q") {
          const s = el.polarity
          this.jA[i] = s * (this.vol(el.b, this.v) - this.vol(el.e, this.v))
          this.jB[i] = s * (this.vol(el.b, this.v) - this.vol(el.c, this.v))
        }
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
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i]
        if (el.kind === "D") this.jA[i] = this.vol(el.anode, this.v) - this.vol(el.cathode, this.v)
        else if (el.kind === "Q") {
          const sg = el.polarity
          this.jA[i] = sg * (this.vol(el.b, this.v) - this.vol(el.e, this.v))
          this.jB[i] = sg * (this.vol(el.b, this.v) - this.vol(el.c, this.v))
        }
      }
    }
    guess.set(this.v)
    if (this.linear && this.luValid && this.luDt === dt && this.luSwitches === mask) {
      z.fill(0)
      this.stampLinear(dt, parts, false, true)
      converged = this.substitute()
    } else {
      for (let iter = 0; iter < MAX_ITER; iter++) {
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

        for (let i = 0; i < elements.length; i++) {
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
            const vcrit = VT * Math.log(VT / (Math.SQRT2 * Q_IS))
            const vbe = limit(s * (g(el.b) - g(el.e)), this.jA[i], VT, vcrit)
            const vbc = limit(s * (g(el.b) - g(el.c)), this.jB[i], VT, vcrit)
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
            // Piecewise-linear regulator: the row for its through current x[r] depends on the
            // operating mode, chosen from the previous iterate. A mode change is not convergence.
            const r = n + el.index
            const vin = g(el.in) - g(el.gnd)
            const vout = g(el.out) - g(el.gnd)
            const iPrev = x[r]
            const avail = vin - el.dropout
            const target = Math.min(el.value, avail)
            const prev = this.rRegion[i]
            const regOrDrop = avail >= el.value - 1e-9 ? REG_REGULATE : REG_DROPOUT
            let mode: number
            // Limiting is left only once the output recovers: its saturating law already gives
            // nothing when the input collapses, and it must not flip to "off" on the way there.
            if (prev === REG_LIMIT) mode = vout >= el.value - 1e-3 ? regOrDrop : REG_LIMIT
            else if (avail <= 0.02) mode = REG_OPEN
            else if (prev === REG_OPEN) mode = vout < target - 2e-3 ? regOrDrop : REG_OPEN
            else if (iPrev > el.imax) mode = REG_LIMIT
            // Sourcing: stay on, picking regulate/dropout by what the input can give. Only a
            // regulator asked to sink, or one idle under an output held higher, switches off.
            else if (iPrev > 1e-6) mode = regOrDrop
            else if (iPrev < -1e-6 || vout > target + 2e-3) mode = REG_OPEN
            else mode = regOrDrop
            if (mode !== prev) clamped = true
            this.rRegion[i] = mode
            // Through current x[r] leaves `in` and arrives at `out`.
            if (el.in !== GROUND) A[el.in * size + r] += 1
            if (el.out !== GROUND) A[el.out * size + r] -= 1
            switch (mode) {
              // vout = Vset − R·x (regulating) or vout = vin − dropout − R·x (dropout): a little
              // sag with load, so two regulators on one rail share instead of fighting.
              case REG_REGULATE:
                if (el.out !== GROUND) A[r * size + el.out] += 1
                if (el.gnd !== GROUND) A[r * size + el.gnd] -= 1
                A[r * size + r] += R_REG
                z[r] = el.value
                break
              case REG_DROPOUT:
                if (el.out !== GROUND) A[r * size + el.out] += 1
                if (el.in !== GROUND) A[r * size + el.in] -= 1
                A[r * size + r] += R_REG
                z[r] = -el.dropout
                break
              case REG_LIMIT: {
                // The pass element saturating: x = imax·(1 − e^(−d/vsat)) of the headroom
                // d = vin − vout, linearized at the previous headroom and stepped at most vsat at
                // a time, the way junctions are limited. Smooth, so a limiter fed by an upstream
                // limiter settles on passing what it gets instead of demanding the impossible.
                const vsat = Math.max(el.dropout, 0.2)
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
                  gk = (el.imax / vsat) * 0.01
                } else {
                  const e = Math.exp(-d / vsat)
                  f = el.imax * (1 - e)
                  gk = Math.max(1e-6, (el.imax / vsat) * e)
                }
                A[r * size + r] = 1
                if (el.in !== GROUND) A[r * size + el.in] -= gk
                if (el.out !== GROUND) A[r * size + el.out] += gk
                z[r] = f - gk * d
                break
              }
              default:
                A[r * size + r] = 1
                z[r] = 0
            }
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

  /** The operating points by switch/pad state, a few of the last distinct ones. */
  private readonly memo = new Map<number, OperatingPoint>()
  private remember(mask: number) {
    const live = this.liveElements
    const point: OperatingPoint = {
      v: Float64Array.from(this.v),
      x: Float64Array.from(this.x),
      region: Uint8Array.from(this.rRegion),
      jA: Float64Array.from(this.jA),
      jB: Float64Array.from(this.jB),
      live: Float64Array.from(live, (i) => (this.net.elements[i].kind === "GPIO" ? this.gpioVolts[i] : this.ohms[i])),
    }
    this.memo.delete(mask)
    this.memo.set(mask, point)
    if (this.memo.size > MEMO_POINTS) this.memo.delete(this.memo.keys().next().value!)
  }
  /** The mask rounds live resistances and leaves DAC voltages out: those must match exactly. */
  private memoMatches(point: OperatingPoint): boolean {
    const live = this.liveElements
    for (let k = 0; k < live.length; k++) {
      const i = live[k]
      const now = this.net.elements[i].kind === "GPIO" ? this.gpioVolts[i] : this.ohms[i]
      if (point.live[k] !== now) return false
    }
    return true
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
    this.failures.length = 0
    if (this.struck) this.strikeRatings()

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const base = i * 4
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
          const cur = (el.value / (THETA * dt)) * (vNow - this.capV[i]) - ((1 - THETA) / THETA) * this.capI[i]
          tc[this.termOf[base]] += cur
          tc[this.termOf[base + 1]] -= cur
          this.capV[i] = vNow
          this.capI[i] = cur
          this.record(el, i, dt, cur, vNow, 0)
          break
        }
        case "L": {
          const vd = this.vol(el.a, this.v) - this.vol(el.b, this.v)
          const cur = this.indI[i] + (dt / el.value) * (THETA * vd + (1 - THETA) * this.indV[i])
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
          if (st === 0) {
            this.record(el, i, dt, 0, vn, 0)
            break
          }
          if (st === GPIO_VOLTS) {
            const cur = (vn - this.gpioVolts[i]) / R_DAC
            tc[this.termOf[base]] += cur
            this.record(el, i, dt, cur, vn, Math.abs(cur * cur * R_DAC))
            break
          }
          const r = st <= 2 ? R_GPIO : R_PULL
          const high = st === 1 || st === 3
          const vdd = high ? (el.vddNet !== undefined ? this.vol(el.vddNet, this.v) : el.vdd) : 0
          const cur = (vn - vdd) / r
          tc[this.termOf[base]] += cur
          if (high && el.vddNet !== undefined) tc[this.termOf[base + 1]] -= cur
          this.record(el, i, dt, cur, vn, Math.abs(cur * cur * r))
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
      // Heating ratings compare against RMS values on AC, which also rides out the inrush into a
      // filter capacitor; voltage breakdown is always instantaneous.
      iLoad = Math.sqrt(this.msI[i])
      pLoad = this.msP[i]
    }
    const lim = el.limits
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
    let ratio = 0
    let what = "current"
    let actual = 0
    let rated = 0
    let unit = "A"
    if (lim.current !== undefined) {
      ratio = iLoad / lim.current
      actual = iLoad
      rated = lim.current
    }
    if (lim.power !== undefined && pLoad / lim.power > ratio) {
      ratio = pLoad / lim.power
      what = "power"
      actual = pLoad
      rated = lim.power
      unit = "W"
    }
    // Below the rating the part cools at the same pace it heats above it, so the peaks of an
    // AC cycle only add up when the average load is over the limit.
    // Far beyond the rating there is no thermal grace period.
    const stress = ratio > 20 ? Infinity : Math.max(0, this.stress[i] + dt * (ratio - 1))
    this.stress[i] = stress
    this.rRatio[i] = ratio
    if (stress > STRESS_LIMIT) this.fail(el, lim.fail, what, actual, rated, unit)
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
          mag = Math.abs(this.vol(el.node, v))
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

  // --- dense linear algebra ---

  /** LU factorization of `A` with partial pivoting, into `lu`. False if singular. */
  private factorize(): boolean {
    const { A, lu, pivot, size: N } = this
    lu.set(A)
    for (let col = 0; col < N; col++) {
      let piv = col
      let best = Math.abs(lu[col * N + col])
      for (let r = col + 1; r < N; r++) {
        const val = Math.abs(lu[r * N + col])
        if (val > best) {
          best = val
          piv = r
        }
      }
      if (best < 1e-18) {
        this.luValid = false
        return false
      }
      pivot[col] = piv
      if (piv !== col) {
        for (let c = 0; c < N; c++) {
          const t = lu[col * N + c]
          lu[col * N + c] = lu[piv * N + c]
          lu[piv * N + c] = t
        }
      }
      const d = lu[col * N + col]
      for (let r = col + 1; r < N; r++) {
        const f = lu[r * N + col] / d
        // Stored in the eliminated slot: the multiplier the right-hand side needs later.
        lu[r * N + col] = f
        if (f === 0) continue
        for (let c = col + 1; c < N; c++) lu[r * N + c] -= f * lu[col * N + c]
      }
    }
    this.luValid = true
    return true
  }

  /** Forward and back substitution of `z` through the stored factors, into `x`. */
  private substitute(): boolean {
    const { lu, pivot, z, x, size: N } = this
    if (!this.luValid) return false
    // Every interchange first: the stored multipliers sit in their final, permuted rows,
    // so eliminating before the later swaps would mix rows that no longer belong together.
    for (let col = 0; col < N; col++) {
      const piv = pivot[col]
      if (piv !== col) {
        const t = z[col]
        z[col] = z[piv]
        z[piv] = t
      }
    }
    for (let col = 0; col < N; col++) {
      const b = z[col]
      for (let r = col + 1; r < N; r++) z[r] -= lu[r * N + col] * b
    }
    for (let r = N - 1; r >= 0; r--) {
      let s = z[r]
      for (let c = r + 1; c < N; c++) s -= lu[r * N + c] * x[c]
      x[r] = s / lu[r * N + r]
    }
    return true
  }
}

export type { Resolved }
