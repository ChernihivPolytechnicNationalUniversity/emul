import type { DigitalEdge, DigitalPart } from "./digital"
import { DT } from "./speeds"
import { add, complex, exp, leftHalfPlaneSquareRoot, multiply, quadraticRoots, realQuadratics, roots, times } from "./polynomial"
import { parseValue } from "./units"

export type BuzzerKind = "magnetic" | "magnetic-active" | "piezo" | "piezo-active"

export const BUZZER_KINDS: Record<BuzzerKind, string> = {
  magnetic: "passive, magnetic",
  "magnetic-active": "active, magnetic",
  piezo: "passive, piezo",
  "piezo-active": "active, piezo",
}

export type Mode = { relativeFrequency: number; q: number; relativeLevel: number }

export type Cavity = { relativeFrequency: number; q: number }

export type Weighting = "A" | "Z"

type Curve = readonly (readonly [number, number])[]

export type SupplyCurves = { ratedVolts: number; spl: Curve; tone: Curve; current: Curve }

export type BuzzerPreset = {
  id: string
  name: string
  maker: string
  badge: string
  kind: BuzzerKind
  coil?: number
  inductance?: number
  capacitance?: number
  capacitanceMeasuredAt?: number
  ratedCurrent?: number
  ratedVolts: number
  minVolts: number
  maxVolts: number
  frequency: number
  ratedAtFrequency?: number
  ratedSpl: number
  ratedWeighting: Weighting
  q: number
  modes?: readonly Mode[]
  cavity?: Cavity
  supply?: SupplyCurves
}

const CEM_1203_Q = 18
const CEM_1203_MODES: Mode[] = [{ relativeFrequency: 4270 / 2080, q: 17, relativeLevel: 0.7 }]
const PIEZO_Q = 10

const CMI_9650C_030_SUPPLY: SupplyCurves = {
  ratedVolts: 3,
  spl: [[2.02, 81.12], [4.5, 91.56]],
  tone: [[2, 2850], [5, 2850]],
  current: [[2, 0.01498], [2.45, 0.01626], [3.05, 0.01849], [3.5, 0.02045], [4.1, 0.02336], [4.5, 0.02542]],
}

const PKB24SPCH3601_B0_SUPPLY: SupplyCurves = {
  ratedVolts: 12,
  spl: [[2.87, 84.96], [3.6, 86.86], [4.4, 88.45], [5.2, 89.82], [6, 91.04], [7.6, 93.23], [9.2, 95.18], [10.8, 96.95], [12.4, 98.55], [14, 99.96], [15.02, 100.66]],
  tone: [[3, 3600], [15, 3600]],
  current: [[2.9, 0.00245], [4.5, 0.00378], [6.1, 0.0053], [7.7, 0.00698], [9.3, 0.00884], [10.9, 0.01088], [12.5, 0.01315], [14.1, 0.01577], [14.99, 0.0175]],
}

const SDC1610M5_01_SUPPLY: SupplyCurves = {
  ratedVolts: 5,
  spl: [[3.97, 89.27], [4, 89.31], [4.5, 89.78], [5, 90.22], [5.5, 90.65], [6, 91.07], [6.5, 91.46], [7, 91.84], [7.5, 92.17], [7.97, 92.42]],
  tone: [[3.82, 2476], [7.95, 2300]],
  current: [[3.82, 0.015], [4, 0.01585], [4.5, 0.01783], [5, 0.01953], [5.5, 0.02106], [6, 0.02242], [6.5, 0.0236], [7, 0.02455], [7.36, 0.025]],
}

const TMB12A05_SUPPLY: SupplyCurves = {
  ratedVolts: 5,
  spl: [[2.87, 86.6], [3, 86.7], [3.5, 87.96], [4, 88.83], [4.5, 89.64], [5, 90.34], [5.5, 90.87], [6, 91.46], [6.5, 91.77], [7, 92.21], [7.5, 92.35], [8.16, 92.52]],
  tone: SDC1610M5_01_SUPPLY.tone,
  current: [[2.9, 0.01269], [3.5, 0.01583], [4, 0.01779], [4.5, 0.02036], [5, 0.02267], [5.5, 0.02464], [6, 0.02655], [6.5, 0.02845], [7, 0.03015], [7.5, 0.03177], [7.97, 0.03316]],
}

export const BUZZER_PRESETS: BuzzerPreset[] = [
  {
    id: "cem-1203-42",
    name: "CEM-1203(42)",
    maker: "CUI",
    badge: "CEM-1203",
    kind: "magnetic",
    coil: 42,
    inductance: 1.65e-3,
    ratedVolts: 3.5,
    minVolts: 3,
    maxVolts: 5,
    frequency: 2080,
    ratedAtFrequency: 2048,
    ratedSpl: 95,
    ratedWeighting: "A",
    q: CEM_1203_Q,
    modes: CEM_1203_MODES,
  },
  {
    id: "at-1224-twt-5v-2",
    name: "AT-1224-TWT-5V-2-R",
    maker: "PUI Audio",
    badge: "AT-1224",
    kind: "magnetic",
    coil: 47,
    inductance: 2.48e-3,
    ratedVolts: 5,
    minVolts: 3,
    maxVolts: 7,
    frequency: 2422.5,
    ratedAtFrequency: 2400,
    ratedSpl: 95.3,
    ratedWeighting: "Z",
    q: 12.37,
    modes: [{ relativeFrequency: 4303 / 2422.5, q: 11.27, relativeLevel: 0.88 }],
  },
  {
    id: "cmt-0904-83t",
    name: "CMT-0904-83T",
    maker: "CUI",
    badge: "CMT-0904",
    kind: "magnetic",
    coil: 15,
    inductance: 0.28e-3,
    ratedVolts: 3,
    minVolts: 2,
    maxVolts: 5,
    frequency: 2921,
    ratedAtFrequency: 2730,
    ratedSpl: 89.1,
    ratedWeighting: "Z",
    q: 8.15,
    modes: [{ relativeFrequency: 5674 / 2921, q: 13.79, relativeLevel: 0.551 }],
    cavity: { relativeFrequency: 3429 / 2921, q: 3 },
  },
  { id: "tmb12a05", name: "TMB12A05", maker: "Huaneng", badge: "TMB12A05", kind: "magnetic-active", ratedCurrent: 0.02304, ratedVolts: 5, minVolts: 3, maxVolts: 7, frequency: 2407, ratedSpl: 96.6, ratedWeighting: "Z", q: CEM_1203_Q, modes: CEM_1203_MODES, supply: TMB12A05_SUPPLY },
  { id: "sdc1610m5-01", name: "SDC1610M5-01", maker: "TDK", badge: "SDC1610", kind: "magnetic-active", ratedCurrent: 0.01953, ratedVolts: 5, minVolts: 4, maxVolts: 8, frequency: 2426, ratedSpl: 90.2, ratedWeighting: "A", q: CEM_1203_Q, modes: CEM_1203_MODES, supply: SDC1610M5_01_SUPPLY },
  { id: "cmi-9650c-030", name: "CMI-9650C-030", maker: "CUI", badge: "CMI-9650", kind: "magnetic-active", ratedCurrent: 0.0183, ratedVolts: 3, minVolts: 2, maxVolts: 5, frequency: 2850, ratedSpl: 85.25, ratedWeighting: "A", q: CEM_1203_Q, modes: CEM_1203_MODES, supply: CMI_9650C_030_SUPPLY },
  { id: "pkm13epyh4000-a0", name: "PKM13EPYH4000-A0", maker: "Murata", badge: "PKM13", kind: "piezo", capacitance: 5.5e-9, capacitanceMeasuredAt: 1000, ratedVolts: 3, minVolts: 1, maxVolts: 15, frequency: 3996.8, ratedAtFrequency: 4000, ratedSpl: 78, ratedWeighting: "Z", q: 12.86,
    modes: [
      { relativeFrequency: 4801.2 / 3996.8, q: 8.28, relativeLevel: 0.689 },
      { relativeFrequency: 6916.2 / 3996.8, q: 23.84, relativeLevel: 0.122 },
      { relativeFrequency: 8597.5 / 3996.8, q: 12.3, relativeLevel: 0.496 },
    ],
    cavity: { relativeFrequency: 5118 / 3996.8, q: 3 },
  },
  { id: "pkm17epp-2002-b0", name: "PKM17EPP-2002-B0", maker: "Murata", badge: "PKM17", kind: "piezo", capacitance: 34e-9, capacitanceMeasuredAt: 120, ratedVolts: 3, minVolts: 1, maxVolts: 25, frequency: 2746, ratedAtFrequency: 2000, ratedSpl: 82, ratedWeighting: "Z", q: 20.04,
    modes: [
      { relativeFrequency: 2023 / 2746, q: 11.98, relativeLevel: 0.8458 },
      { relativeFrequency: 6101 / 2746, q: 9.97, relativeLevel: 1.2278 },
      { relativeFrequency: 12328 / 2746, q: 80.05, relativeLevel: 0.1016 },
      { relativeFrequency: 14968 / 2746, q: 38.64, relativeLevel: 0.0703 },
    ],
    cavity: { relativeFrequency: 2000 / 2746, q: 1.4 },
  },
  { id: "pkb24spch3601-b0", name: "PKB24SPCH3601-B0", maker: "Murata", badge: "PKB24", kind: "piezo-active", ratedCurrent: 0.01244, ratedVolts: 12, minVolts: 3, maxVolts: 15, frequency: 3600, ratedSpl: 98.15, ratedWeighting: "Z", q: PIEZO_Q, supply: PKB24SPCH3601_B0_SUPPLY },
]

export const buzzerDefId = (preset: BuzzerPreset) => `buzzer-${preset.id}`

export const buzzerOfDef = (defId: string) => BUZZER_PRESETS.find((p) => buzzerDefId(p) === defId)

export const isActive = (kind: BuzzerKind) => kind === "magnetic-active" || kind === "piezo-active"

export function buzzerSpec(preset: BuzzerPreset, props: Record<string, string>): BuzzerPreset {
  const overridden = <T extends number | undefined>(key: string, fallback: T): number | T => {
    const n = parseValue(props[key] ?? "")
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    ...preset,
    coil: overridden("coil", preset.coil),
    inductance: overridden("inductance", preset.inductance),
    capacitance: overridden("capacitance", preset.capacitance),
    ratedCurrent: overridden("current", preset.ratedCurrent),
    ratedVolts: overridden("rated", preset.ratedVolts),
    frequency: overridden(isActive(preset.kind) ? "tone" : "resonance", preset.frequency),
    ratedSpl: overridden("spl", preset.ratedSpl),
  }
}

const MOTIONAL_TO_STATIC_CAPACITANCE = 0.1

export function piezoMotionalBranch(spec: BuzzerPreset) {
  const below = (spec.capacitanceMeasuredAt ?? 1000) / spec.frequency
  const measured = spec.capacitance ?? 1e-8
  const c0 = measured / (1 + MOTIONAL_TO_STATIC_CAPACITANCE / (1 - below * below))
  const cm = c0 * MOTIONAL_TO_STATIC_CAPACITANCE
  const omega = 2 * Math.PI * spec.frequency
  const lm = 1 / (omega * omega * cm)
  return { c0, cm, lm, rm: Math.sqrt(lm / cm) / spec.q }
}

export const coilPowerRating = (spec: BuzzerPreset) => (spec.maxVolts * spec.maxVolts) / (2 * (spec.coil ?? 42))

export const activeSwitchOnOhms = (spec: BuzzerPreset) => spec.ratedVolts / (2 * (spec.ratedCurrent ?? 0.02))

function along(curve: Curve, x: number): number {
  let k = 0
  while (k < curve.length - 2 && x >= curve[k + 1][0]) k++
  const [[x0, y0], [x1, y1]] = [curve[k], curve[k + 1]]
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
}

export type SupplyLaw = { spl: (volts: number) => number; tone: (volts: number) => number; current: (volts: number) => number }

export function supplyLaw(spec: BuzzerPreset): SupplyLaw {
  const ratedCurrent = spec.ratedCurrent ?? 0.02
  const curves = spec.supply
  if (!curves) return { spl: () => spec.ratedSpl, tone: () => spec.frequency, current: (volts) => (ratedCurrent * volts) / spec.ratedVolts }
  const onCurve = (curve: Curve, volts: number) => along(curve, (volts * curves.ratedVolts) / spec.ratedVolts)
  const rated = (curve: Curve) => onCurve(curve, spec.ratedVolts)
  return {
    spl: (volts) => spec.ratedSpl + onCurve(curves.spl, volts) - rated(curves.spl),
    tone: (volts) => (spec.frequency * onCurve(curves.tone, volts)) / rated(curves.tone),
    current: (volts) => Math.max(0, (ratedCurrent * onCurve(curves.current, volts)) / rated(curves.current)),
  }
}

export function activePowerRating(spec: BuzzerPreset) {
  return 1.25 * spec.maxVolts * supplyLaw(spec).current(spec.maxVolts)
}

export const ACTIVE_IDLE_OHMS = 100e3
export const ACTIVE_REVERSED_OHMS = 1e6
export const REVERSE_BREAKDOWN_VOLTS = 7
export const PIEZO_DEPOLES_AT_RATED_MAX = 2
export const REVERSE_CONDUCTS_FROM_VOLTS = REVERSE_BREAKDOWN_VOLTS + 0.7
export const REVERSE_JUNCTION_WATTS = 0.15
export const reversePathOhms = activeSwitchOnOhms
const OSCILLATOR_START_OF_MIN_VOLTS = 0.8
const OSCILLATOR_STOP_OF_START = 0.9

const P_REF = 20e-6
const LEVEL_TAU = 0.005
const DRIVE_TAU = 0.01
const AUDIBLE_DB = 40
const HEARD_HOLD = 1.5
const INDICATOR_DARK_DB = 50
const INDICATOR_FULL_DB = 100
const FREEWHEEL_VF = 0.7
const CROSSINGS_KEPT = 9
const STEADY_PERIOD = 0.03
const EVEN_PERIODS = 0.2
const TONE_LOST_AFTER = 0.05
const WARN_AFTER = 0.05
const DC_WARN_AFTER = 0.5
const GATING_WINDOW = 0.1
const GATINGS_TO_WARN = 10
const REVERSED_BELOW = -0.5
const POWERED_ABOVE = 0.5
const TONE_RESOLUTION_HZ = 0.05
const RANGE_MARGIN = 0.02
const LEVEL_RESOLUTION_VOLTS = 1e-3

export class Section {
  private readonly b0: number
  private readonly b1: number
  private readonly b2: number
  private readonly a1: number
  private readonly a2: number
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = b0
    this.b1 = b1
    this.b2 = b2
    this.a1 = a1
    this.a2 = a2
  }

  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }

  magnitudeAt(hz: number) {
    const w = 2 * Math.PI * hz * DT
    const re = (b0: number, b1: number, b2: number) => b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w)
    const im = (b1: number, b2: number) => -b1 * Math.sin(w) - b2 * Math.sin(2 * w)
    return Math.hypot(re(this.b0, this.b1, this.b2), im(this.b1, this.b2)) / Math.hypot(re(1, this.a1, this.a2), im(this.a1, this.a2))
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0
  }
}

type Quadratic = readonly [number, number]

type AnalogResponse = { gain: number; zeros: Quadratic[]; poles: Quadratic[] }

function analogResponse(spec: BuzzerPreset): AnalogResponse {
  const w1 = 2 * Math.PI * spec.frequency
  const pole = (relativeFrequency: number, q: number): Quadratic => [(w1 * relativeFrequency) / q, (w1 * relativeFrequency) ** 2]
  const atZero: Quadratic = [0, 0]
  const zeros: Quadratic[] = []
  const poles: Quadratic[] = []
  if (spec.cavity) {
    zeros.push(atZero)
    poles.push(pole(spec.cavity.relativeFrequency, spec.cavity.q))
  }
  zeros.push(atZero)
  poles.push(pole(1, spec.q))
  const others = spec.modes ?? []
  if (!others.length) return { gain: 1, zeros, poles }
  const modes = [{ relativeFrequency: 1, q: spec.q, relativeLevel: 1 }, ...others]
  const squared = modes.map(({ relativeFrequency: r, q }) => [1, 2 * r * r - (r * r) / (q * q), r ** 4])
  const powerSum = modes.reduce<number[]>(
    (sum, mode, k) => add(sum, squared.filter((_, j) => j !== k).reduce(multiply, [mode.relativeLevel ** 2])),
    [0],
  )
  for (const [b1, b0] of realQuadratics(roots(powerSum).map(leftHalfPlaneSquareRoot))) zeros.push([b1 * w1, b0 * w1 * w1])
  for (const mode of others) poles.push(pole(mode.relativeFrequency, mode.q))
  return { gain: Math.sqrt(powerSum[0]), zeros, poles }
}

function analogMagnitude(response: AnalogResponse, hz: number): number {
  const w = 2 * Math.PI * hz
  const at = ([b1, b0]: Quadratic) => Math.hypot(b0 - w * w, b1 * w)
  return response.zeros.reduce((m, z, k) => (m * at(z)) / at(response.poles[k]), response.gain)
}

function matchedZ([b1, b0]: Quadratic): [number, number] {
  const [a, b] = quadraticRoots(b1, b0).map((s) => exp(complex(s.re * DT, s.im * DT)))
  return [-(a.re + b.re), times(a, b).re]
}

export function transducer(spec: BuzzerPreset): Section[] {
  const response = analogResponse(spec)
  const shapes = response.poles.map((p, k) => [matchedZ(response.zeros[k]), matchedZ(p)] as const)
  const unscaled = shapes.map(([[n1, n0], [d1, d0]]) => new Section(1, n1, n0, d1, d0))
  const gain = analogMagnitude(response, spec.frequency) / unscaled.reduce((m, s) => m * s.magnitudeAt(spec.frequency), 1)
  return shapes.map(([[n1, n0], [d1, d0]], k) => (k === 0 ? new Section(gain, gain * n1, gain * n0, d1, d0) : unscaled[k]))
}

const bilinear = 2 / DT
const firstOrderHighPass = (hz: number) => {
  const w = 2 * Math.PI * hz
  return new Section(bilinear / (bilinear + w), -bilinear / (bilinear + w), 0, (w - bilinear) / (bilinear + w), 0)
}
const firstOrderLowPass = (hz: number) => {
  const w = 2 * Math.PI * hz
  return new Section(w / (bilinear + w), w / (bilinear + w), 0, (w - bilinear) / (bilinear + w), 0)
}

function aWeighting() {
  const sections = [
    firstOrderHighPass(20.598997),
    firstOrderHighPass(20.598997),
    firstOrderHighPass(107.65265),
    firstOrderHighPass(737.86223),
    firstOrderLowPass(12194.217),
    firstOrderLowPass(12194.217),
  ]
  const unity = 1 / sections.reduce((g, s) => g * s.magnitudeAt(1000), 1)
  return { sections, unity }
}

export class Acoustics {
  private readonly transducer: Section[]
  private readonly weighting = aWeighting()
  private readonly ratedWeighting: Weighting
  private pascalsPerUnit = 1
  private weightedPower = 0
  private flatPower = 0
  private readonly levelShare = -Math.expm1(-DT / LEVEL_TAU)
  pressure = 0

  constructor(spec: BuzzerPreset, ratedDrive: (step: number) => number) {
    this.transducer = transducer(spec)
    this.ratedWeighting = spec.ratedWeighting
    this.calibrate(ratedDrive, spec.ratedSpl)
  }

  private calibrate(ratedDrive: (step: number) => number, ratedSpl: number) {
    const settleSteps = Math.round(0.15 / DT)
    const measureSteps = Math.round(0.1 / DT)
    let sum = 0
    for (let n = 0; n < settleSteps + measureSteps; n++) {
      const [flat, weighted] = this.radiate(ratedDrive(n))
      const rated = this.ratedWeighting === "A" ? weighted : flat
      if (n >= settleSteps) sum += rated * rated
    }
    const rms = Math.sqrt(sum / measureSteps)
    this.pascalsPerUnit = rms > 0 ? (P_REF * 10 ** (ratedSpl / 20)) / rms : 0
    this.reset()
  }

  private radiate(force: number): [number, number] {
    let pressure = force
    for (const s of this.transducer) pressure = s.run(pressure)
    let weighted = pressure * this.weighting.unity
    for (const s of this.weighting.sections) weighted = s.run(weighted)
    return [pressure, weighted]
  }

  push(force: number) {
    const [pressure, weighted] = this.radiate(force)
    this.pressure = pressure * this.pascalsPerUnit
    this.weightedPower += ((weighted * this.pascalsPerUnit) ** 2 - this.weightedPower) * this.levelShare
    this.flatPower += (this.pressure ** 2 - this.flatPower) * this.levelShare
  }

  ratedGainAt(hz: number): number {
    const transducerGain = this.transducer.reduce((gain, s) => gain * s.magnitudeAt(hz), 1)
    if (this.ratedWeighting === "Z") return transducerGain
    return transducerGain * this.weighting.unity * this.weighting.sections.reduce((gain, s) => gain * s.magnitudeAt(hz), 1)
  }

  dBA(): number {
    return toDb(this.weightedPower)
  }

  audible(): boolean {
    return this.weightedPower > AUDIBLE_POWER
  }

  dBZ(): number {
    return toDb(this.flatPower)
  }

  reset() {
    for (const s of this.transducer) s.reset()
    for (const s of this.weighting.sections) s.reset()
    this.weightedPower = 0
    this.flatPower = 0
    this.pressure = 0
  }
}

const AUDIBLE_POWER = P_REF * P_REF * 10 ** (AUDIBLE_DB / 10)

const toDb = (power: number) => (power > 0 ? 10 * Math.log10(power / (P_REF * P_REF)) : -Infinity)

function ratedCoilCurrent(spec: BuzzerPreset): (step: number) => number {
  const r = spec.coil ?? 42
  const l = spec.inductance ?? 1e-3
  const hz = spec.ratedAtFrequency ?? spec.frequency
  const decay = Math.exp((-DT * r) / l)
  let i = 0
  return (step) => {
    const switchOn = (step * DT * hz) % 1 < 0.5
    i = switchOn ? spec.ratedVolts / r + (i - spec.ratedVolts / r) * decay : Math.max(0, -FREEWHEEL_VF / r + (i + FREEWHEEL_VF / r) * decay)
    return i
  }
}

const ratedSquare = (volts: number, hz: number) => (step: number) => ((step * DT * hz) % 1 < 0.5 ? volts : 0)

function shareOfStepHigh(stepEnd: number, squareStart: number, hz: number): number {
  const integralHigh = (cycles: number) => Math.floor(cycles) * 0.5 + Math.min(0.5, cycles - Math.floor(cycles))
  const from = Math.max(0, (stepEnd - DT - squareStart) * hz)
  const to = (stepEnd - squareStart) * hz
  return to > from ? (integralHigh(to) - integralHigh(from)) / (to - from) : 0
}

const formatHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`)

export type BuzzerSnapshot = {
  name: string
  kind: BuzzerKind
  sounding: boolean
  level: number | null
  unweighted: number | null
  tone: number | null
  heard: { level: number; tone: number | null } | null
  drive: number
  state: string
  warnings: string[]
}

export class Buzzer implements DigitalPart {
  readonly object: string
  readonly pins: readonly string[] = []
  readonly out: DigitalEdge[] = []
  senses: readonly string[] = ["1", "2"]
  private readonly preset: BuzzerPreset
  private spec: BuzzerPreset
  private sound!: Acoustics
  private law!: SupplyLaw
  private ratedToneGain = 1
  private toneHz = 0
  private levelFor = { volts: Number.NaN, amplitude: 0 }
  private configuredAs = ""
  private burnt = false
  private time = 0
  private driveMean = 0
  private driveSwing = 0
  private peakAcross = 0
  private peakDrive = 0
  private lastDrive = 0
  private belowMean = false
  private readonly risingCrossings: number[] = []
  private burst: { level: number; tone: number | null; drive: number; at: number } | null = null
  private oscillating = false
  private oscillatingSince = 0
  private ohms = ACTIVE_IDLE_OHMS
  private volts = 0
  private gatings: number[] = []
  private readonly conditionSince = new Map<string, number>()

  constructor(object: string, preset: BuzzerPreset, props: Record<string, string>) {
    this.object = object
    this.preset = preset
    this.spec = preset
    this.configure(props)
  }

  configure(props: Record<string, string>) {
    const spec = buzzerSpec(this.preset, props)
    const as = JSON.stringify(spec)
    if (as === this.configuredAs) return
    this.configuredAs = as
    this.spec = spec
    this.senses = spec.kind === "magnetic" ? ["1", "2", "$m"] : ["1", "2"]
    const ratedDrive =
      spec.kind === "magnetic" ? ratedCoilCurrent(spec) : spec.kind === "piezo" ? ratedSquare(spec.ratedVolts, spec.ratedAtFrequency ?? spec.frequency) : ratedSquare(1, spec.frequency)
    this.sound = new Acoustics(spec, ratedDrive)
    this.law = supplyLaw(spec)
    this.ratedToneGain = this.sound.ratedGainAt(spec.frequency)
    this.reset()
  }

  reset() {
    this.burnt = false
    this.time = 0
    this.driveMean = 0
    this.driveSwing = 0
    this.peakAcross = 0
    this.peakDrive = 0
    this.lastDrive = 0
    this.belowMean = false
    this.risingCrossings.length = 0
    this.burst = null
    this.oscillating = false
    this.ohms = ACTIVE_IDLE_OHMS
    this.volts = 0
    this.toneHz = this.spec.frequency
    this.levelFor = { volts: Number.NaN, amplitude: 0 }
    this.gatings = []
    this.conditionSince.clear()
    this.sound.reset()
  }

  burn() {
    this.burnt = true
    this.oscillating = false
  }

  drive(): boolean | null {
    return null
  }

  input() {}

  analog(key: string): number | undefined {
    return key === "$osc" && isActive(this.spec.kind) ? this.ohms : undefined
  }

  tick(time: number): boolean {
    if (!isActive(this.spec.kind)) return false
    const was = this.ohms
    if (this.oscillating) this.ohms = ((time - this.oscillatingSince) * this.toneHz) % 1 < 0.5 ? this.switchOnOhms() : ACTIVE_IDLE_OHMS
    else this.ohms = this.volts < REVERSED_BELOW ? ACTIVE_REVERSED_OHMS : ACTIVE_IDLE_OHMS
    return this.ohms !== was
  }

  quietUntil(): number {
    if (!isActive(this.spec.kind) || !this.oscillating) return Infinity
    const half = 0.5 / this.toneHz
    return this.oscillatingSince + (Math.floor((this.time - this.oscillatingSince) / half) + 1) * half
  }

  sense(volts: (pin: string) => number, time: number) {
    this.time = time
    const across = volts("1") - volts("2")
    if (isActive(this.spec.kind)) this.senseOscillatorSupply(across, time)
    else this.senseDrive(this.spec.kind === "magnetic" ? (volts("1") - volts("$m")) / (this.spec.coil ?? 42) : across, across, time)
    this.trackBurst(time)
    if (isActive(this.spec.kind)) this.observeActive()
    else this.observePassive()
  }

  private observePassive() {
    const spec = this.spec
    const sounding = !this.burnt && this.sound.audible()
    const steady = this.steadyDrive()
    this.observe("dc", steady && spec.kind === "magnetic")
    this.observe("dc-piezo", steady && spec.kind === "piezo")
    this.observe("over", sounding && this.overVolts() > spec.maxVolts * (1 + RANGE_MARGIN))
  }

  private observeActive() {
    const spec = this.spec
    this.observe("reversed", this.volts < REVERSED_BELOW)
    this.observe("broken-down", this.volts < -REVERSE_CONDUCTS_FROM_VOLTS)
    this.observe("dead", !this.oscillating && this.volts > POWERED_ABOVE)
    this.observe("under", this.oscillating && this.volts < spec.minVolts * (1 - RANGE_MARGIN))
    this.observe("over", this.volts > spec.maxVolts * (1 + RANGE_MARGIN))
  }

  private observe(condition: string, holds: boolean) {
    if (!holds) this.conditionSince.delete(condition)
    else if (!this.conditionSince.has(condition)) this.conditionSince.set(condition, this.time)
  }

  private heldFor(condition: string): number {
    const since = this.conditionSince.get(condition)
    return since === undefined ? 0 : this.time - since
  }

  private senseDrive(drive: number, across: number, time: number) {
    const share = -Math.expm1(-DT / DRIVE_TAU)
    this.driveMean += (drive - this.driveMean) * share
    this.driveSwing += (Math.abs(drive - this.driveMean) - this.driveSwing) * share
    this.peakAcross = Math.max(across, this.peakAcross * (1 - share))
    this.peakDrive = Math.max(drive, this.peakDrive * (1 - share))
    const peakToPeak = 2 * this.driveSwing
    this.countRisingCrossing(drive, peakToPeak / 4, time)
    this.volts = this.spec.kind === "magnetic" ? Math.min(this.peakAcross, this.peakDrive * (this.spec.coil ?? 42)) : peakToPeak
    this.sound.push(this.burnt ? 0 : drive)
    this.lastDrive = drive
  }

  private senseOscillatorSupply(volts: number, time: number) {
    this.volts = volts
    const start = OSCILLATOR_START_OF_MIN_VOLTS * this.spec.minVolts
    const was = this.oscillating
    if (!this.burnt && !this.oscillating && volts >= start) {
      this.oscillating = true
      this.oscillatingSince = time
      this.toneHz = this.law.tone(volts)
    } else if (this.oscillating && (this.burnt || volts < OSCILLATOR_STOP_OF_START * start)) this.oscillating = false
    if (this.oscillating !== was) this.gatings.push(time)
    if (!this.oscillating) {
      this.sound.push(0)
      return
    }
    this.followSupply(volts, time)
    this.sound.push(shareOfStepHigh(time, this.oscillatingSince, this.toneHz) * this.amplitudeAt(volts))
  }

  private followSupply(volts: number, time: number) {
    const hz = this.law.tone(volts)
    if (Math.abs(hz - this.toneHz) < TONE_RESOLUTION_HZ) return
    this.oscillatingSince = time - ((time - this.oscillatingSince) * this.toneHz) / hz
    this.toneHz = hz
  }

  private amplitudeAt(volts: number): number {
    if (!(Math.abs(volts - this.levelFor.volts) <= LEVEL_RESOLUTION_VOLTS)) {
      const onCurve = 10 ** ((this.law.spl(volts) - this.spec.ratedSpl) / 20)
      this.levelFor = { volts, amplitude: (onCurve * this.ratedToneGain) / this.sound.ratedGainAt(this.toneHz) }
    }
    return this.levelFor.amplitude
  }

  private switchOnOhms(): number {
    const volts = Math.max(this.volts, OSCILLATOR_STOP_OF_START * OSCILLATOR_START_OF_MIN_VOLTS * this.spec.minVolts)
    return volts / (2 * Math.max(this.law.current(volts), 1e-6))
  }

  private overVolts(): number {
    return this.spec.kind === "piezo" ? Math.abs(this.driveMean) + this.driveSwing : this.volts
  }

  private countRisingCrossing(drive: number, hysteresis: number, time: number) {
    const x = drive - this.driveMean
    if (x < -hysteresis) this.belowMean = true
    else if (this.belowMean && x > hysteresis) {
      this.belowMean = false
      const before = this.lastDrive - this.driveMean
      this.risingCrossings.push(x !== before ? time - (DT * (x - hysteresis)) / (x - before) : time)
      if (this.risingCrossings.length > CROSSINGS_KEPT) this.risingCrossings.shift()
    }
  }

  private trackBurst(time: number) {
    const level = this.sound.dBA()
    if (level <= AUDIBLE_DB) return
    const was = this.burst !== null && time - this.burst.at <= 1.5 * DT ? this.burst : null
    this.burst = { level: Math.max(level, was?.level ?? -Infinity), tone: this.tone() ?? was?.tone ?? null, drive: Math.max(this.volts, was?.drive ?? 0), at: time }
  }

  private tone(): number | null {
    if (isActive(this.spec.kind)) return this.oscillating ? this.toneHz : null
    const c = this.risingCrossings
    const last = c.length - 1
    if (last < 3 || this.time - c[last] > TONE_LOST_AFTER) return null
    const twoPeriods = c[last] - c[last - 2]
    if (this.time - c[last] > twoPeriods) return null
    if (Math.abs(2 * (c[last] - c[last - 1]) - twoPeriods) > EVEN_PERIODS * twoPeriods) return null
    let first = last - 2
    while (first >= 1 && Math.abs(c[first + 1] - c[first - 1] - twoPeriods) < STEADY_PERIOD * twoPeriods) first--
    return last - first >= 3 ? (last - first) / (c[last] - c[first]) : null
  }

  pressure(): number {
    return this.burnt ? 0 : this.sound.pressure
  }

  pitch(): number | null {
    return this.tone()
  }

  parts(): Record<string, { on: boolean; level: number }> {
    const level = this.burnt ? -Infinity : this.sound.dBA()
    const lit = Math.round(Math.min(1, Math.max(0, (level - INDICATOR_DARK_DB) / (INDICATOR_FULL_DB - INDICATOR_DARK_DB))) * 10) / 10
    return { SOUND: { on: lit > 0, level: lit } }
  }

  snapshot(): BuzzerSnapshot {
    const spec = this.spec
    const level = this.sound.dBA()
    const sounding = !this.burnt && level > AUDIBLE_DB
    const warnings = isActive(spec.kind) ? this.activeWarnings() : this.passiveWarnings()
    const heard = this.burst && this.time - this.burst.at < HEARD_HOLD ? { level: this.burst.level, tone: this.burst.tone } : null
    return {
      name: spec.name,
      kind: spec.kind,
      sounding,
      level: sounding ? level : null,
      unweighted: sounding ? this.sound.dBZ() : null,
      tone: sounding ? this.tone() : null,
      heard,
      drive: this.volts,
      state: this.burnt ? "Burnt out" : this.stateText(sounding),
      warnings,
    }
  }

  private stateText(sounding: boolean): string {
    if (isActive(this.spec.kind)) {
      if (this.volts < REVERSED_BELOW) return "Reversed: silent"
      if (!this.oscillating && this.volts > POWERED_ABOVE) return "Below the voltage its oscillator starts at: silent"
      return this.oscillating ? "Sounding" : "Off"
    }
    if (this.steadyDrive()) return this.spec.kind === "magnetic" ? "DC: a click on and off, no tone" : "DC: no sound"
    return sounding ? "Sounding" : "Silent"
  }

  private steadyDrive(): boolean {
    const threshold = this.spec.kind === "magnetic" ? (0.1 * this.spec.ratedVolts) / (this.spec.coil ?? 42) : 1
    return this.tone() === null && Math.abs(this.driveMean) > threshold
  }

  private passiveWarnings(): string[] {
    const spec = this.spec
    const warnings: string[] = []
    if (this.heldFor("dc") > DC_WARN_AFTER)
      warnings.push("DC through a passive buzzer: no tone, only a click at each edge, and the coil heats. Drive it with a square wave.")
    if (this.heldFor("dc-piezo") > DC_WARN_AFTER)
      warnings.push("DC across a piezo: no sound, and a lasting DC bias degrades it (silver migration). Drive it with a square wave.")
    const lastBurst = this.burst && this.time - this.burst.at < HEARD_HOLD ? this.burst : null
    if (lastBurst && lastBurst.drive < spec.minVolts * (1 - RANGE_MARGIN))
      warnings.push(`Driven with ${lastBurst.drive.toFixed(2)} V, under its ${spec.minVolts}–${spec.maxVolts} V operating range: quieter than rated.`)
    if (this.heldFor("over") > WARN_AFTER) warnings.push(`Driven to ${this.overVolts().toFixed(2)} V, over its ${spec.maxVolts} V maximum.`)
    return warnings
  }

  private activeWarnings(): string[] {
    const spec = this.spec
    const warnings: string[] = []
    const start = OSCILLATOR_START_OF_MIN_VOLTS * spec.minVolts
    if (this.heldFor("broken-down") > WARN_AFTER) {
      const amps = (-this.volts - REVERSE_CONDUCTS_FROM_VOLTS) / reversePathOhms(spec)
      const junction = spec.kind === "magnetic-active" ? "its transistor's emitter–base junction" : "its driver's input protection"
      const fate = REVERSE_BREAKDOWN_VOLTS * amps > REVERSE_JUNCTION_WATTS ? "more than it takes for long: it heats until it dies" : "it warms, and more would kill it"
      warnings.push(`Reversed past ${REVERSE_CONDUCTS_FROM_VOLTS.toFixed(1)} V: ${junction} breaks down and conducts about ${Math.round(amps * 1e3)} mA, ${fate}.`)
    } else if (this.heldFor("reversed") > WARN_AFTER) warnings.push("Reversed: an active buzzer only sounds with + on pin 1.")
    if (this.heldFor("dead") > WARN_AFTER)
      warnings.push(`${this.volts.toFixed(2)} V is below the ${start.toFixed(1)} V its oscillator needs; it is specified for ${spec.minVolts}–${spec.maxVolts} V.`)
    if (this.heldFor("under") > WARN_AFTER)
      warnings.push(`${this.volts.toFixed(2)} V is under its ${spec.minVolts}–${spec.maxVolts} V operating range: quiet and unreliable.`)
    if (this.heldFor("over") > WARN_AFTER) warnings.push(`${this.volts.toFixed(2)} V is over its ${spec.maxVolts} V maximum: it heats.`)
    while (this.gatings.length && this.time - this.gatings[0] > GATING_WINDOW) this.gatings.shift()
    if (this.gatings.length >= GATINGS_TO_WARN)
      warnings.push(
        `Its supply is switched about ${Math.round(this.gatings.length / 2 / GATING_WINDOW)} times a second: an active buzzer gates its own ${formatHz(spec.frequency)} tone and cannot play another pitch. tone() needs a passive one.`,
      )
    return warnings
  }
}
