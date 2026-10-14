/**
 * Mid-range PIC chip profiles: what tells one PIC16F62x from another once the core and the
 * peripheral classes are shared — memory sizes, the RAM map, the configuration word, the
 * oscillators and the electrical ratings. Data only; `PicMcu` assembles the part. Every number
 * cites the row of docs/pic16-checklist.md it comes from.
 *
 * PIC16F627A/628A/648A: DS40044G (2009). PIC16F627/628: DS40300C (2003), the differences in the
 * checklist's P6 rows.
 */

/** Typical / guaranteed figures as the tables give them. */
export type Spec = { min?: number; typ: number; max?: number }

export type PicElectrical = {
  /** Nominal supply the circuit's load model starts from, V. */
  vdd: number
  /** Fallback input thresholds as fractions of VDD (Schmitt, D031/D041); per-pad ones come from `PicMcu.inputThresholds`. */
  inputThresholdsOfVdd: { rising: number; falling: number }
  /** Operating VDD range of the F part (the LF part goes down to `vddMinLf`), V (D001). */
  vddMin: number
  vddMinLf: number
  vddMax: number
  /** Absolute maximum VDD, V (§17.0). */
  vddAbsMax: number
  /** Any pin but MCLR and RA4: VDD + this, V (§17.0). */
  pinAboveVdd: number
  /** MCLR and RA4 withstand this, V (§17.0). */
  mclrMax: number
  ra4Max: number
  /** Output current per pin, either way, A; all of PORTA and PORTB together, A; VSS out / VDD in, A (§17.0). */
  pinCurrentMax: number
  portsCurrentMax: number
  vssCurrentMax: number
  vddCurrentMax: number
  /** Driver resistance from VOL 0.6 V at 8.5 mA and VOH VDD − 0.7 V at 3.0 mA, VDD 4.5 V (D080, D090), Ω. */
  sinkOhms: number
  sourceOhms: number
  /** RA4 open-drain high voltage in operation, V (D150). */
  ra4OpenDrainMax: number
  /** PORTB weak pull-up current at VDD 5 V, pin at VSS (D070), A. */
  pullUpCurrent: Spec
  /** TTL input (PORTB): VIL max / VIH min at VDD 4.5–5.5 V, else 0.15 VDD / 0.25 VDD + 0.8 V (D030, D040). */
  ttl: { vil: number; vih: number }
  /** Schmitt inputs (PORTA, INT, T0CKI, MCLR): fractions of VDD (D031, D041, D042). */
  schmittOfVdd: { vil: number; vih: number }
  /** Programming voltage on MCLR/VPP that enters Program/Verify (DS41196G Table 4-1 VIHH; DS30034D: VDD + 3.5 V min, `aboveVdd`). */
  vihh: { min: number; max: number; aboveVdd?: number }
  /** VDD rise detected by the power-on reset (§14.4.1: 1.2–1.7 V; decision D9 takes the middle). */
  por: number
  /** Brown-out reset voltage, V (D005), and the minimum time below it that resets, s (param 35). */
  bor: Spec
  borTime: number
  /** Power-up timer, watchdog period without postscaler, MCLR low pulse width, s (Table 17-7 params 33, 31, 30). */
  pwrt: Spec
  wdt: Spec
  mclrPulse: number
  /** Internal oscillator fast/slow, Hz (Table 17-4, F10; DS40300C: 37 kHz). */
  intosc: number
  intoscSlow: number
  /** Oscillator wake-up from Sleep in INTOSC mode by VDD, s (Table 17-5 F14 typ: 2.0/3.0/5.0 V). */
  intoscWake: [number, number][]
  /** Wake-up delay in RC (ER) mode, s (Fig 14-17 note 2: "approximately 1 µs"). */
  rcWake: number
  /** Supply current, A (§17.2): INTOSC 4 MHz by VDD (D012A), power-down base (D020), WDT (D021), BOR (D022). */
  iddIntosc: [number, number][]
  ipd: [number, number][]
  iwdt: [number, number][]
  ibor: number
  /** Data EEPROM erase/write cycle time, s (D122 TDEW: typ 4, max 8 ms); per-byte endurance, E/W cycles (D120 min). */
  eeWrite: Spec
  eeEndurance: number
}

export type OscMode = "LP" | "XT" | "HS" | "EC" | "INTOSC" | "RC"

export type PicProfile = {
  family: "pic"
  id: string
  name: string
  /** The "A" silicon (DS40044G) or the original PIC16F627/628 (DS40300C). */
  revisionA: boolean
  /** Program memory, 14-bit words: the PC wraps there (§4.1). */
  flashWords: number
  eepromBytes: number
  /** General purpose RAM ranges, 9-bit file addresses, inclusive (Table 4-1). */
  gpr: [number, number][]
  /** 16 bytes of common RAM at 70h–7Fh, seen again at these addresses (Table 4-1). */
  commonMirrors: number[]
  /** Device ID word at 2006h (DS41196G §3.1.4): ID bits <13:5>, revision <4:0>. */
  deviceId: number
  /** BOREN/BODEN set forces the power-up timer on (DS40300C Register 14-1 note 1; not on the A parts, P4-027). */
  borForcesPwrt: boolean
  /** RC (A) or ER (original) oscillator on RA7 for FOSC = 11x (P6-006). */
  rcKind: "RC" | "ER"
  /** Comparator mode 001 is defective on the original silicon (DS40300C Fig 9-1, P6-019). */
  comparator001Defective: boolean
  /** The LF part: VDD from `vddMinLf`, 4 MHz under 3.0 V (Figure 17-2). */
  lowVoltage: boolean
  /** The ordering grade's top FOSC, Hz: 20 MHz, or 4 MHz for the original's -04 and LF parts (Table 4-1; D38). */
  grade: number
  electrical: PicElectrical
}

/** FOSC<2:0> = config bits 4, 1, 0 (Register 14-1). */
export function fosc(config: number): number {
  return ((config >> 2) & 4) | (config & 3)
}
export function oscMode(config: number): OscMode {
  return (["LP", "XT", "HS", "EC", "INTOSC", "INTOSC", "RC", "RC"] as const)[fosc(config)]
}
/** RA6 carries CLKOUT (FOSC/4) in FOSC = 101 and 111 (Register 14-1, Figure 5-6). */
export function clkoutOnRa6(config: number): boolean {
  const f = fosc(config)
  return f === 5 || f === 7
}

/**
 * ER oscillator frequency from the resistor to VSS (DS40300C Table 14-3, VDD 5 V, 25 °C),
 * interpolated on log R between the printed points; past 1 MΩ on the last segment's slope, and
 * stopped (null) where that falls under Table 17-4's 10 kHz (decision D39).
 */
const ER_TABLE: [number, number][] = [
  [1e3, 10e6],
  [10e3, 7.4e6],
  [20e3, 5.3e6],
  [47e3, 3e6],
  [100e3, 1.6e6],
  [220e3, 800e3],
  [470e3, 300e3],
  [1e6, 200e3],
]
export const ER_MIN_HZ = 10e3
export function erFrequency(ohms: number): number | null {
  if (ohms <= 0) return 10.4e6
  if (ohms <= ER_TABLE[0][0]) return 10.4e6 + (10e6 - 10.4e6) * (ohms / 1e3)
  for (let i = 1; i < ER_TABLE.length; i++) {
    const [r1, f1] = ER_TABLE[i]
    if (ohms <= r1) {
      const [r0, f0] = ER_TABLE[i - 1]
      const k = Math.log(ohms / r0) / Math.log(r1 / r0)
      return f0 + (f1 - f0) * k
    }
  }
  const [r0, f0] = ER_TABLE[ER_TABLE.length - 2]
  const [r1, f1] = ER_TABLE[ER_TABLE.length - 1]
  const f = f1 + ((f1 - f0) * Math.log(ohms / r1)) / Math.log(r1 / r0)
  return f < ER_MIN_HZ ? null : f
}

/**
 * RC oscillator frequency of the A parts from REXT (to VDD) and CEXT (to VSS) on RA7/OSC1. DS40044G
 * gives no figures (§14.2.6: VDD, R, C, temperature, process); DS33023A Table 31-1 gives the family's
 * typical values at 5 V, 25 °C. Inside its grid (3.3–100 kΩ, 22–300 pF) log f is interpolated
 * bilinearly on log R and log C; outside, the fit period = 1.246·R·(C + 6.3 pF) + 79 ns of the same
 * table (within 8 % of every point) carries on (decision D46).
 */
const RC_R = [3.3e3, 5e3, 10e3, 100e3]
const RC_C = [22e-12, 100e-12, 300e-12]
const rcModel = (r: number, c: number) => 1 / (1.2458 * r * (c + 6.33e-12) + 79.2e-9)
const RC_F: number[][] = [
  // 22 pF (3.3 kΩ not in the table: the fit), 100 pF, 300 pF; columns follow RC_R.
  [rcModel(3.3e3, 22e-12), 4.12e6, 2.35e6, 268e3],
  [1.8e6, 1.27e6, 688e3, 77.2e3],
  [707e3, 501e3, 269e3, 28.3e3],
]
export function rcFrequency(ohms: number, farads: number): number {
  if (ohms < RC_R[0] || ohms > RC_R[3] || farads < RC_C[0] || farads > RC_C[2]) return rcModel(ohms, farads)
  const seg = (xs: number[], x: number) => {
    let i = 0
    while (i < xs.length - 2 && x > xs[i + 1]) i++
    return { i, k: Math.log(x / xs[i]) / Math.log(xs[i + 1] / xs[i]) }
  }
  const r = seg(RC_R, ohms)
  const c = seg(RC_C, farads)
  const lf = (ci: number, ri: number) => Math.log(RC_F[ci][ri])
  const row = (ci: number) => lf(ci, r.i) + (lf(ci, r.i + 1) - lf(ci, r.i)) * r.k
  return Math.exp(row(c.i) + (row(c.i + 1) - row(c.i)) * c.k)
}

/** Lowest VDD the part is specified for, V (D001: F 3.0 V, LF 2.0 V). */
export function vddMin(p: PicProfile): number {
  return p.lowVoltage ? p.electrical.vddMinLf : p.electrical.vddMin
}

/**
 * The highest FOSC the voltage–frequency graph allows at `vdd` (Figures 17-1/17-2 of either sheet,
 * read from the PDF: 10 MHz at 3.0 V rising linearly to 20 MHz at 4.5 V; LF 4 MHz from 2.0 V), capped
 * by the ordering grade; 0 under the part's VDD minimum (decision D38).
 */
export function maxFosc(p: PicProfile, vdd: number): number {
  if (vdd < vddMin(p) - 1e-9) return 0
  let f: number
  if (vdd < 3.0) f = 4e6
  else if (vdd >= 4.5) f = 20e6
  else f = 10e6 + ((vdd - 3.0) / 1.5) * 10e6
  return Math.min(f, p.grade)
}

/** Why a clock is outside the part's ratings (Table 17-4, the V–F graph, the grade), or null (D38). */
export function clockRating(p: PicProfile, config: number, hz: number, kind: "crystal" | "clock" | "rc" | "internal", vdd: number): string | null {
  const mhz = (f: number) => (f >= 1e6 ? `${+(f / 1e6).toFixed(3)} MHz` : `${+(f / 1e3).toFixed(3)} kHz`)
  const mode = oscMode(config)
  const crystal = kind === "crystal"
  const range: Record<OscMode, [number, number] | null> = {
    LP: [0, 200e3],
    XT: crystal ? [0.1e6, 4e6] : [0, 4e6],
    HS: crystal ? [1e6, 20e6] : [0, 20e6],
    EC: [0, 20e6],
    RC: [0, 4e6],
    INTOSC: null,
  }
  const r = range[mode]
  const name = mode === "RC" && p.rcKind === "ER" ? "ER" : mode
  if (r && (hz < r[0] || hz > r[1]))
    return `FOSC ${mhz(hz)} outside the ${name} mode's ${r[0] ? `${mhz(r[0])}–` : "DC–"}${mhz(r[1])} (Table 17-4; decision D38) — it runs as configured`
  const grade = mode === "LP" ? Math.min(p.grade, 200e3) : p.grade
  if (hz > grade) return `FOSC ${mhz(hz)} above the ${p.name}'s ${mhz(grade)} rating (${p.grade < 20e6 ? (p.lowVoltage ? "LF part" : "-04 grade") : "Table 4-1"}; decision D38) — it runs as configured`
  const vf = maxFosc(p, vdd)
  if (vf > 0 && hz > vf + 1)
    return `FOSC ${mhz(hz)} at VDD ${vdd.toFixed(2)} V: outside the voltage–frequency region (${p.lowVoltage ? "Figure 17-2/17-3" : "Figure 17-1"}, ${mhz(vf)} here; decision D38) — it runs as configured`
  return null
}

/** Piecewise-linear lookup in a (VDD, value) table, clamped at its ends. */
export function byVdd(table: [number, number][], vdd: number): number {
  if (vdd <= table[0][0]) return table[0][1]
  for (let i = 1; i < table.length; i++)
    if (vdd <= table[i][0]) {
      const [v0, y0] = table[i - 1]
      const [v1, y1] = table[i]
      return y0 + ((y1 - y0) * (vdd - v0)) / (v1 - v0)
    }
  return table[table.length - 1][1]
}

/** DS40044G §17 (P5 rows). */
const ELECTRICAL_A: PicElectrical = {
  vdd: 5,
  inputThresholdsOfVdd: { rising: 0.8, falling: 0.2 },
  vddMin: 3.0,
  vddMinLf: 2.0,
  vddMax: 5.5,
  vddAbsMax: 6.5,
  pinAboveVdd: 0.3,
  mclrMax: 14,
  ra4Max: 14,
  pinCurrentMax: 25e-3,
  portsCurrentMax: 200e-3,
  vssCurrentMax: 300e-3,
  vddCurrentMax: 250e-3,
  sinkOhms: 0.6 / 8.5e-3,
  sourceOhms: 0.7 / 3.0e-3,
  ra4OpenDrainMax: 8.5,
  pullUpCurrent: { min: 50e-6, typ: 200e-6, max: 400e-6 },
  ttl: { vil: 0.8, vih: 2.0 },
  schmittOfVdd: { vil: 0.2, vih: 0.8 },
  vihh: { min: 10.0, max: 13.5 },
  por: 1.45,
  bor: { min: 3.65, typ: 4.0, max: 4.35 },
  borTime: 100e-6,
  pwrt: { min: 28e-3, typ: 72e-3, max: 132e-3 },
  wdt: { min: 7e-3, typ: 18e-3, max: 33e-3 },
  mclrPulse: 2e-6,
  intosc: 4e6,
  intoscSlow: 48e3,
  intoscWake: [
    [2.0, 6e-6],
    [3.0, 4e-6],
    [5.0, 3e-6],
  ],
  rcWake: 1e-6,
  iddIntosc: [
    [2.0, 395e-6],
    [3.0, 565e-6],
    [5.0, 895e-6],
  ],
  ipd: [
    [2.0, 0.01e-6],
    [3.0, 0.01e-6],
    [5.0, 0.02e-6],
  ],
  iwdt: [
    [2.0, 1e-6],
    [3.0, 2e-6],
    [5.0, 9e-6],
  ],
  ibor: 30e-6,
  eeWrite: { typ: 4e-3, max: 8e-3 },
  eeEndurance: 100_000,
}

/** DS40300C §17: where the original differs (P6 rows). */
const ELECTRICAL_ORIGINAL: PicElectrical = {
  ...ELECTRICAL_A,
  intoscSlow: 37e3,
  vihh: { min: 0, max: 13.5, aboveVdd: 3.5 },
  // Fig 14-17 note 2 gives ~1 µs for ER; Table 14-4 gives no delay for INTRC (P6-013).
  intoscWake: [[5.0, 0]],
  ipd: [
    [3.0, 0.2e-6],
    [5.5, 0.2e-6],
  ],
  iwdt: [
    [3.0, 6e-6],
    [4.0, 6e-6],
  ],
  ibor: 75e-6,
  // D120: 1M min at 25 °C, 5 V (P6-030).
  eeEndurance: 1_000_000,
}

const GPR_224: [number, number][] = [
  [0x20, 0x7f],
  [0xa0, 0xef],
  [0x120, 0x14f],
]
const GPR_256: [number, number][] = [
  [0x20, 0x7f],
  [0xa0, 0xef],
  [0x120, 0x16f],
]
const COMMON = [0xf0, 0x170, 0x1f0]

const A = { family: "pic", revisionA: true, lowVoltage: false, grade: 20e6, commonMirrors: COMMON, borForcesPwrt: false, rcKind: "RC", comparator001Defective: false, electrical: ELECTRICAL_A } as const
const ORIGINAL = { family: "pic", revisionA: false, lowVoltage: false, grade: 20e6, commonMirrors: COMMON, borForcesPwrt: true, rcKind: "ER", comparator001Defective: true, electrical: ELECTRICAL_ORIGINAL } as const

// Device IDs: DS41196G Table 3-2 (P7-092) and DS30034D Table 3-1 (P10-015); revision bits <4:0> not given (0 here).
export const PIC16F627A: PicProfile = { ...A, id: "PIC16F627A", name: "PIC16F627A", flashWords: 1024, eepromBytes: 128, gpr: GPR_224, deviceId: 0x1040 }
export const PIC16F628A: PicProfile = { ...A, id: "PIC16F628A", name: "PIC16F628A", flashWords: 2048, eepromBytes: 128, gpr: GPR_224, deviceId: 0x1060 }
export const PIC16F648A: PicProfile = { ...A, id: "PIC16F648A", name: "PIC16F648A", flashWords: 4096, eepromBytes: 256, gpr: GPR_256, deviceId: 0x1100 }
export const PIC16F627: PicProfile = { ...ORIGINAL, id: "PIC16F627", name: "PIC16F627", flashWords: 1024, eepromBytes: 128, gpr: GPR_224, deviceId: 0x07a0 }
export const PIC16F628: PicProfile = { ...ORIGINAL, id: "PIC16F628", name: "PIC16F628", flashWords: 2048, eepromBytes: 128, gpr: GPR_224, deviceId: 0x07c0 }

export const PIC16LF627A: PicProfile = { ...PIC16F627A, id: "PIC16LF627A", name: "PIC16LF627A", lowVoltage: true }
export const PIC16LF628A: PicProfile = { ...PIC16F628A, id: "PIC16LF628A", name: "PIC16LF628A", lowVoltage: true }
export const PIC16LF648A: PicProfile = { ...PIC16F648A, id: "PIC16LF648A", name: "PIC16LF648A", lowVoltage: true }
// The original's ordering grades (P6-034): -20 (20 MHz, the plain profiles above), -04 (4 MHz; 200 kHz in LP); LF parts are 4 MHz.
export const PIC16F627_04: PicProfile = { ...PIC16F627, id: "PIC16F627-04", name: "PIC16F627-04", grade: 4e6 }
export const PIC16F628_04: PicProfile = { ...PIC16F628, id: "PIC16F628-04", name: "PIC16F628-04", grade: 4e6 }
export const PIC16LF627: PicProfile = { ...PIC16F627, id: "PIC16LF627", name: "PIC16LF627", lowVoltage: true, grade: 4e6 }
export const PIC16LF628: PicProfile = { ...PIC16F628, id: "PIC16LF628", name: "PIC16LF628", lowVoltage: true, grade: 4e6 }

export const PIC_CHIPS: PicProfile[] = [
  PIC16F627,
  PIC16F627_04,
  PIC16F628,
  PIC16F628_04,
  PIC16LF627,
  PIC16LF628,
  PIC16F627A,
  PIC16F628A,
  PIC16F648A,
  PIC16LF627A,
  PIC16LF628A,
  PIC16LF648A,
]

export function picChipById(id: string): PicProfile | undefined {
  return PIC_CHIPS.find((c) => c.id === id)
}
