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
  /** Programming voltage on MCLR/VPP that enters Program/Verify (DS41196G Table 4-1 VIHH). */
  vihh: { min: number; max: number }
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
 * interpolated on log R between the printed points.
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
export function erFrequency(ohms: number): number {
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
  return 200e3
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
}

/** DS40300C §17: where the original differs (P6 rows). */
const ELECTRICAL_ORIGINAL: PicElectrical = {
  ...ELECTRICAL_A,
  intoscSlow: 37e3,
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

const A = { family: "pic", revisionA: true, commonMirrors: COMMON, borForcesPwrt: false, rcKind: "RC", comparator001Defective: false, electrical: ELECTRICAL_A } as const
const ORIGINAL = { family: "pic", revisionA: false, commonMirrors: COMMON, borForcesPwrt: true, rcKind: "ER", comparator001Defective: true, electrical: ELECTRICAL_ORIGINAL } as const

// Device IDs: DS41196G Table 3-2 (P7-092), revision bits <4:0> not given (0 here). The original parts' IDs are in their own
// programming specification, not among the documents: 0 (P6-045).
export const PIC16F627A: PicProfile = { ...A, id: "PIC16F627A", name: "PIC16F627A", flashWords: 1024, eepromBytes: 128, gpr: GPR_224, deviceId: 0x1040 }
export const PIC16F628A: PicProfile = { ...A, id: "PIC16F628A", name: "PIC16F628A", flashWords: 2048, eepromBytes: 128, gpr: GPR_224, deviceId: 0x1060 }
export const PIC16F648A: PicProfile = { ...A, id: "PIC16F648A", name: "PIC16F648A", flashWords: 4096, eepromBytes: 256, gpr: GPR_256, deviceId: 0x1100 }
export const PIC16F627: PicProfile = { ...ORIGINAL, id: "PIC16F627", name: "PIC16F627", flashWords: 1024, eepromBytes: 128, gpr: GPR_224, deviceId: 0 }
export const PIC16F628: PicProfile = { ...ORIGINAL, id: "PIC16F628", name: "PIC16F628", flashWords: 2048, eepromBytes: 128, gpr: GPR_224, deviceId: 0 }

export const PIC_CHIPS: PicProfile[] = [PIC16F627, PIC16F628, PIC16F627A, PIC16F628A, PIC16F648A]

export function picChipById(id: string): PicProfile | undefined {
  return PIC_CHIPS.find((c) => c.id === id)
}
