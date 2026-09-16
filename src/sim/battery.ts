/**
 * Battery chemistries: what the solver needs to make a cell behave like the real thing rather
 * than an ideal source. Per chemistry, the open-circuit voltage against state of charge (the
 * discharge curve every datasheet prints), the internal resistance and how it climbs towards
 * empty, the rate dependence of the capacity (Peukert), self-discharge, and what abuse does
 * to it. Everything is per cell; a pack multiplies by the cells in series.
 */

export type Chemistry = {
  id: string
  name: string
  /** Nameplate cell voltage, for the label. */
  nominal: number
  /** Open-circuit voltage per cell against state of charge: [soc, volts], ascending soc, soc 0 = empty, 1 = full. */
  ocv: [number, number][]
  /** How the open-circuit voltage keeps rising past full when force-charged, V per unit of soc. */
  overSlope: number
  /** Internal resistance of a 1 Ah cell when full, Ω·Ah — a bigger cell has proportionally less. */
  rOhmAh: number
  /** Relative rise of the resistance towards empty: r(soc) = r · (1 + rEmpty · (1 − soc)³). */
  rEmpty: number
  /** Peukert exponent, and the discharge time in hours the nameplate capacity is rated at. */
  peukert: number
  ratedHours: number
  /** Self-discharge, fraction of the capacity per month at room temperature. */
  selfDischarge: number
  /** Coulombic efficiency of charging; 0 for a primary cell, which cannot be charged at all. */
  chargeEfficiency: number
  /**
   * How much past full a rechargeable cell tolerates (soc − 1) before it fails, and what is
   * left: lithium goes into thermal runaway (a short), nickel and lead vent (open).
   */
  overcharge: { soc: number; fail: "open" | "short"; what: string } | null
  /** Rechargeable lithium below its cut-off dissolves the copper current collector: dead when soc drops this far below empty. */
  deepDischarge: { soc: number; what: string } | null
  /**
   * Cold and heat: the usable capacity at −20 °C and at 60 °C relative to 25 °C (linear between),
   * and the internal resistance's factor at those two temperatures (exponential between: the
   * electrolyte's conductivity follows Arrhenius).
   */
  temp: { capCold: number; capHot: number; rCold: number; rHot: number }
  /**
   * Diffusion: two RC pairs behind the ohmic resistance, each `r` as a multiple of it and `tau`
   * in seconds. Under load the terminal voltage keeps sagging for minutes; after the load goes
   * the voltage "rests" back up on the same time constants instead of snapping to open-circuit.
   */
  polarization: { r1: number; tau1: number; r2: number; tau2: number }
  /** Wear: capacity lost and resistance gained per full cycle and per year on the shelf. */
  ageing: { capPerCycle: number; capPerYear: number; rPerCycle: number; rPerYear: number }
  /**
   * Heat: thermal mass in J/K per Ah, thermal resistance to the air in K/W for a 1 Ah cell
   * (scaled by Ah^−⅔ for the surface), and the cell temperature at which it lets go.
   */
  thermal: { cth: number; rth: number; tVent: number; fail: "open" | "short"; what: string }
}

const primary = { chargeEfficiency: 0, overcharge: null, deepDischarge: null } as const

export const CHEMISTRIES: Chemistry[] = [
  {
    id: "alkaline",
    name: "Alkaline",
    nominal: 1.5,
    ocv: [[0, 0.9], [0.05, 1.0], [0.1, 1.1], [0.2, 1.17], [0.3, 1.22], [0.4, 1.26], [0.5, 1.3], [0.6, 1.34], [0.7, 1.38], [0.8, 1.43], [0.9, 1.5], [1, 1.6]],
    overSlope: 1,
    rOhmAh: 0.35,
    rEmpty: 3,
    peukert: 1.2,
    ratedHours: 100,
    selfDischarge: 0.0025,
    temp: { capCold: 0.4, capHot: 1.0, rCold: 4, rHot: 0.7 },
    polarization: { r1: 0.8, tau1: 8, r2: 1.5, tau2: 240 },
    ageing: { capPerCycle: 0, capPerYear: 0.03, rPerCycle: 0, rPerYear: 0.1 },
    thermal: { cth: 8, rth: 45, tVent: 100, fail: "open", what: "vented" },
    ...primary,
  },
  {
    id: "zinc-carbon",
    name: "Zinc–carbon",
    nominal: 1.5,
    ocv: [[0, 0.8], [0.1, 1.0], [0.2, 1.08], [0.4, 1.18], [0.6, 1.28], [0.8, 1.4], [1, 1.55]],
    overSlope: 1,
    rOhmAh: 0.5,
    rEmpty: 4,
    peukert: 1.3,
    ratedHours: 100,
    selfDischarge: 0.01,
    temp: { capCold: 0.15, capHot: 1.0, rCold: 6, rHot: 0.7 },
    polarization: { r1: 1.0, tau1: 8, r2: 2.0, tau2: 300 },
    ageing: { capPerCycle: 0, capPerYear: 0.1, rPerCycle: 0, rPerYear: 0.3 },
    thermal: { cth: 8, rth: 45, tVent: 90, fail: "open", what: "vented" },
    ...primary,
  },
  {
    id: "li-ion",
    name: "Li-ion",
    nominal: 3.7,
    ocv: [[0, 3.0], [0.05, 3.3], [0.1, 3.5], [0.2, 3.6], [0.3, 3.65], [0.4, 3.7], [0.5, 3.75], [0.6, 3.8], [0.7, 3.87], [0.8, 3.95], [0.9, 4.05], [1, 4.2]],
    overSlope: 4,
    rOhmAh: 0.12,
    rEmpty: 1.5,
    peukert: 1.03,
    ratedHours: 5,
    selfDischarge: 0.03,
    chargeEfficiency: 0.99,
    temp: { capCold: 0.65, capHot: 1.0, rCold: 4, rHot: 0.6 },
    polarization: { r1: 0.4, tau1: 5, r2: 0.5, tau2: 120 },
    ageing: { capPerCycle: 0.0004, capPerYear: 0.02, rPerCycle: 0.002, rPerYear: 0.1 },
    thermal: { cth: 13, rth: 22, tVent: 130, fail: "short", what: "thermal runaway" },
    overcharge: { soc: 0.05, fail: "short", what: "thermal runaway" },
    deepDischarge: { soc: 0.001, what: "copper dissolution" },
  },
  {
    id: "lifepo4",
    name: "LiFePO₄",
    nominal: 3.2,
    ocv: [[0, 2.5], [0.03, 3.0], [0.1, 3.2], [0.2, 3.27], [0.5, 3.3], [0.8, 3.33], [0.95, 3.38], [1, 3.45]],
    overSlope: 4,
    rOhmAh: 0.1,
    rEmpty: 1.5,
    peukert: 1.02,
    ratedHours: 2,
    selfDischarge: 0.03,
    chargeEfficiency: 0.99,
    temp: { capCold: 0.6, capHot: 1.02, rCold: 5, rHot: 0.6 },
    polarization: { r1: 0.4, tau1: 5, r2: 0.5, tau2: 120 },
    ageing: { capPerCycle: 0.0001, capPerYear: 0.01, rPerCycle: 0.0005, rPerYear: 0.05 },
    thermal: { cth: 13, rth: 22, tVent: 180, fail: "open", what: "vented" },
    overcharge: { soc: 0.08, fail: "short", what: "thermal runaway" },
    deepDischarge: { soc: 0.001, what: "copper dissolution" },
  },
  {
    id: "nimh",
    name: "NiMH",
    nominal: 1.2,
    ocv: [[0, 1.0], [0.05, 1.1], [0.15, 1.2], [0.3, 1.23], [0.5, 1.26], [0.7, 1.29], [0.9, 1.34], [1, 1.42]],
    overSlope: 0.8,
    rOhmAh: 0.06,
    rEmpty: 1,
    peukert: 1.05,
    ratedHours: 5,
    selfDischarge: 0.2,
    chargeEfficiency: 0.7,
    temp: { capCold: 0.6, capHot: 0.95, rCold: 3, rHot: 0.7 },
    polarization: { r1: 0.5, tau1: 5, r2: 0.6, tau2: 120 },
    ageing: { capPerCycle: 0.0004, capPerYear: 0.02, rPerCycle: 0.002, rPerYear: 0.1 },
    thermal: { cth: 10, rth: 30, tVent: 100, fail: "open", what: "vented" },
    overcharge: { soc: 0.3, fail: "open", what: "vented" },
    deepDischarge: null,
  },
  {
    id: "nicd",
    name: "NiCd",
    nominal: 1.2,
    ocv: [[0, 0.9], [0.05, 1.05], [0.15, 1.18], [0.3, 1.21], [0.5, 1.23], [0.7, 1.26], [0.9, 1.3], [1, 1.38]],
    overSlope: 0.8,
    rOhmAh: 0.04,
    rEmpty: 1,
    peukert: 1.03,
    ratedHours: 5,
    selfDischarge: 0.1,
    chargeEfficiency: 0.75,
    temp: { capCold: 0.75, capHot: 0.95, rCold: 2, rHot: 0.8 },
    polarization: { r1: 0.4, tau1: 5, r2: 0.5, tau2: 120 },
    ageing: { capPerCycle: 0.0002, capPerYear: 0.01, rPerCycle: 0.001, rPerYear: 0.05 },
    thermal: { cth: 10, rth: 30, tVent: 100, fail: "open", what: "vented" },
    overcharge: { soc: 0.3, fail: "open", what: "vented" },
    deepDischarge: null,
  },
  {
    id: "lead-acid",
    name: "Lead-acid",
    nominal: 2,
    ocv: [[0, 1.75], [0.1, 1.87], [0.2, 1.93], [0.4, 1.98], [0.6, 2.03], [0.8, 2.08], [1, 2.13]],
    overSlope: 0.8,
    rOhmAh: 0.06,
    rEmpty: 1.5,
    peukert: 1.2,
    ratedHours: 20,
    selfDischarge: 0.04,
    chargeEfficiency: 0.85,
    temp: { capCold: 0.6, capHot: 1.08, rCold: 2, rHot: 0.8 },
    polarization: { r1: 0.5, tau1: 20, r2: 1.0, tau2: 600 },
    ageing: { capPerCycle: 0.0007, capPerYear: 0.04, rPerCycle: 0.003, rPerYear: 0.15 },
    thermal: { cth: 300, rth: 5, tVent: 80, fail: "open", what: "boiled dry" },
    overcharge: { soc: 0.5, fail: "open", what: "gassed dry" },
    deepDischarge: null,
  },
  {
    id: "li-mno2",
    name: "Lithium coin (CR)",
    nominal: 3,
    ocv: [[0, 2.0], [0.05, 2.6], [0.1, 2.8], [0.3, 2.9], [0.5, 2.95], [0.8, 3.0], [0.95, 3.1], [1, 3.25]],
    overSlope: 2,
    rOhmAh: 3.3,
    rEmpty: 2,
    peukert: 1.25,
    ratedHours: 1000,
    selfDischarge: 0.001,
    temp: { capCold: 0.65, capHot: 1.0, rCold: 5, rHot: 0.6 },
    polarization: { r1: 1.0, tau1: 10, r2: 2.0, tau2: 300 },
    ageing: { capPerCycle: 0, capPerYear: 0.01, rPerCycle: 0, rPerYear: 0.05 },
    thermal: { cth: 11, rth: 100, tVent: 100, fail: "open", what: "vented" },
    ...primary,
  },
  {
    id: "li-socl2",
    name: "Li-SOCl₂",
    nominal: 3.6,
    ocv: [[0, 2.0], [0.03, 3.0], [0.1, 3.4], [0.3, 3.55], [0.9, 3.62], [1, 3.67]],
    overSlope: 2,
    rOhmAh: 24,
    rEmpty: 2,
    peukert: 1.15,
    ratedHours: 1000,
    selfDischarge: 0.0008,
    temp: { capCold: 0.8, capHot: 1.0, rCold: 3, rHot: 0.7 },
    polarization: { r1: 1.0, tau1: 10, r2: 3.0, tau2: 600 },
    ageing: { capPerCycle: 0, capPerYear: 0.01, rPerCycle: 0, rPerYear: 0.3 },
    thermal: { cth: 12, rth: 60, tVent: 100, fail: "open", what: "vented" },
    ...primary,
  },
]

export const DEFAULT_CHEMISTRY = CHEMISTRIES[2]

export function chemistryById(id: string): Chemistry {
  return CHEMISTRIES.find((c) => c.id === id) ?? DEFAULT_CHEMISTRY
}

/** Below empty the cell is exhausted: over this much soc its resistance climbs to `DEAD_RATIO` times, and it stays there. */
export const DEAD_SOC = 0.005
export const DEAD_RATIO = 200
/** Peukert's law overstates the gain at very low rates; a cell never gives more than ~10 % over nameplate. */
const PEUKERT_FLOOR = 0.9
const MONTH = 30 * 86400

/** Open-circuit voltage of one cell at a state of charge (linear between the table points; flat below empty). */
export function cellOcv(chem: Chemistry, soc: number): number {
  const t = chem.ocv
  if (soc <= t[0][0]) return t[0][1]
  const last = t[t.length - 1]
  if (soc >= last[0]) return last[1] + chem.overSlope * (soc - last[0])
  for (let i = 1; i < t.length; i++) {
    if (soc <= t[i][0]) {
      const [s0, v0] = t[i - 1]
      const [s1, v1] = t[i]
      return v0 + ((v1 - v0) * (soc - s0)) / (s1 - s0)
    }
  }
  return last[1]
}

/** Internal resistance of the pack at a state of charge, from its full-charge value. */
export function packResistance(chem: Chemistry, rFull: number, soc: number): number {
  if (soc >= 1) return rFull
  if (soc >= 0) return rFull * (1 + chem.rEmpty * (1 - soc) ** 3)
  const dead = Math.min(1, -soc / DEAD_SOC)
  return rFull * (1 + chem.rEmpty) * (1 + (DEAD_RATIO - 1) * dead)
}

/** Usable capacity at a temperature relative to 25 °C: linear through the −20 °C and 60 °C points, never below 5 %. */
export function capacityAtTemp(chem: Chemistry, t: number): number {
  const { capCold, capHot } = chem.temp
  const f = t <= 25 ? 1 + ((1 - capCold) * (t - 25)) / 45 : 1 + ((capHot - 1) * (t - 25)) / 35
  return Math.max(0.05, Math.min(t > 60 ? capHot : Infinity, f))
}

/** Internal resistance factor at a temperature: Arrhenius-like, `rCold` at −20 °C, `rHot` at 60 °C. */
export function resistanceAtTemp(chem: Chemistry, t: number): number {
  return t <= 25 ? chem.temp.rCold ** ((25 - t) / 45) : chem.temp.rHot ** ((t - 25) / 35)
}

/** Self-discharge roughly doubles every 10 °C. */
export const selfDischargeAtTemp = (t: number) => 2 ** ((t - 25) / 10)

/** Capacity left after wear, relative to nameplate; a cell never reads below 20 %. */
export function capacityAfterAge(chem: Chemistry, cycles: number, years: number): number {
  return Math.max(0.2, 1 - chem.ageing.capPerCycle * cycles - chem.ageing.capPerYear * years)
}

/** Internal resistance growth from wear. */
export function resistanceAfterAge(chem: Chemistry, cycles: number, years: number): number {
  return 1 + chem.ageing.rPerCycle * cycles + chem.ageing.rPerYear * years
}

/** Thermal resistance of a cell to the air, K/W: the 1 Ah figure scaled by the surface a cell of this size has. */
export const thermalResistance = (chem: Chemistry, capacityAh: number) => chem.thermal.rth * Math.max(1e-3, capacityAh) ** (-2 / 3)
/** Thermal mass of a cell, J/K. */
export const thermalMass = (chem: Chemistry, capacityAh: number) => chem.thermal.cth * Math.max(1e-3, capacityAh)

/** Internal resistance of a fresh pack: the chemistry's Ω·Ah over the capacity, per cell in series. */
export const defaultResistance = (chem: Chemistry, cells: number, capacityAh: number) => (chem.rOhmAh * cells) / Math.max(1e-6, capacityAh)

/**
 * Rate at which the state of charge changes, per second, for a discharge current `amps`
 * (negative when charging). Peukert: the charge drawn counts for more at high rates, so a
 * cell rated for 100 h at 25 mA gives far less than its nameplate at 1 A. Self-discharge
 * always runs. Charging a primary cell puts nothing back.
 */
export function drainRate(chem: Chemistry, capacityAh: number, amps: number, tempC = 25): number {
  const q = capacityAh * 3600
  const self = (chem.selfDischarge * selfDischargeAtTemp(tempC)) / MONTH
  if (amps >= 0) {
    const iref = capacityAh / chem.ratedHours
    const factor = amps > 0 ? Math.max(PEUKERT_FLOOR, (amps / iref) ** (chem.peukert - 1)) : 0
    return (amps * factor) / q + self
  }
  return (amps * chem.chargeEfficiency) / q + self
}

/** "42 s", "12 min", "3 h 20 min", "5 d 3 h", "2.3 years". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—"
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  const h = Math.round(seconds / 3600)
  if (h < 60 * 24) return `${Math.floor(h / 24)} d ${h % 24} h`
  const days = seconds / 86400
  if (days < 365.25) return `${Math.round(days)} d`
  return `${(days / 365.25).toFixed(1)} years`
}
