/**
 * Operational amplifiers: one preset per datasheet, and the pieces of the model the solver
 * evaluates on every iteration (`Engine.opamp`). A preset is one amplifier of its package —
 * a dual's two halves are two symbols on the field, each with the supply pins drawn on it, as a
 * schematic draws them — and every figure is the datasheet's typical at 25 °C.
 *
 * The amplifier is a single-pole macro-model. The input stage turns IN+ − IN− + VOS into the
 * output's target, which moves at GBW · 2π · (IN+ − IN−) volts a second, never faster than the
 * slew rate, and settles at the open-loop gain times the input (the dominant pole at GBW / gain);
 * the target stays `swing` short of either rail. The output stage drives the target through
 * `rout` up to the short-circuit current and holds that current past it, taking what it sources
 * from V+ and handing what it sinks to V−, on top of the quiescent current.
 */

/** A figure that depends on the total supply: one value, or [volts, value] points joined by straight lines. */
export type SupplyCurve = number | readonly (readonly [volts: number, value: number])[]

export type OpampSpec = {
  /** Open-loop DC gain, V/V. */
  gain: number
  /** Gain-bandwidth product, Hz: the frequency the open-loop gain falls to 1. */
  gbw: number
  /** Slew rate, V/s. */
  slew: number
  /** Input offset voltage, V, as if in series with IN+. */
  vos: number
  /** Input bias current of each input, A: positive into the pins (NPN or JFET inputs), negative out of them (PNP). */
  ib: number
  /** Input common-mode range: from `cm[0]` above V− up to `cm[1]` below V+; negative reaches past the rail. */
  cm: readonly [number, number]
  /** Absolute maximum input voltage: `inputs[0]` below V−, `inputs[1]` above V+, and `inputMax` above V− in any case. */
  inputs: readonly [number, number]
  inputMax?: number
  /** Unloaded output swing: how far short of V+ and of V− the output stops. */
  swing: readonly [number, number]
  /** Open-loop output resistance, Ω: with `swing`, how far the output sags under a load. */
  rout: number
  /** Output current limits, sourcing and sinking, A. */
  source: SupplyCurve
  sink: SupplyCurve
  /** Quiescent current of the amplifier, A. */
  iq: SupplyCurve
  /** Total supply (V+ − V−) the amplifier is specified for; below `vsMin` its output has less drive, down to none at 0 V. */
  vsMin: number
  vsMax: number
}

export type OpampPreset = {
  id: string
  /** The part number: the palette name and the text on the symbol. */
  part: string
  description: string
  /** More names the palette search finds it by. */
  keywords: string[]
  spec: OpampSpec
  /** Absolute maximum total supply, V: past it the die is destroyed. */
  vsAbs: number
  /** Package dissipation at 25 °C, W. */
  pmax: number
  /** Resistance between the inputs, Ω; left out where it is teraohms. */
  rin?: number
  /** Input protection diodes from V− to each input, with the current the sheet allows through them, A. */
  clamp?: number
  /** The package and the pins of its first amplifier. */
  dip?: { package: string; out: number; inn: number; inp: number; vee: number; vcc: number; others: string }
  source: string
}

/** The palette's own op amp: an ideal amplifier that still cannot leave its rails, every figure settable. */
export const GENERIC_OPAMP = "generic"

export const OPAMP_PRESETS: OpampPreset[] = [
  {
    id: GENERIC_OPAMP,
    part: "",
    description:
      "An op amp close to the textbook's ideal: 120 dB of gain, 10 MHz, 10 V/µs, no offset or bias current, the output from rail to rail and limited to 40 mA. Every figure can be changed in the inspector; the named parts beside it are real ones off their datasheets.",
    keywords: ["op amp", "opamp", "operational amplifier", "ideal", "amplifier", "comparator"],
    spec: {
      gain: 1e6,
      gbw: 10e6,
      slew: 10e6,
      vos: 0,
      ib: 0,
      cm: [0, 0],
      inputs: [0.3, 0.3],
      swing: [0, 0],
      rout: 10,
      source: 0.04,
      sink: 0.04,
      iq: 1e-3,
      vsMin: 1,
      vsMax: 36,
    },
    vsAbs: 36,
    pmax: 1,
    source: "none: an idealised part",
  },
  {
    id: "lm358",
    part: "LM358",
    description:
      "TI's LM358, the single-supply dual op amp: 3–30 V, inputs and output down to the negative rail, the output 1.5 V short of the positive one; 0.7 MHz, 0.3 V/µs, sources 30 mA and sinks 20 mA. One symbol is one of its two amplifiers.",
    keywords: ["LM358", "LM358N", "LM358P", "op amp", "operational amplifier", "single supply"],
    spec: {
      // Table 5.7 at VS = 5 V unless noted; the gain at VS = 15 V, VO = 1–11 V, RL ≥ 2 kΩ.
      gain: 100e3,
      gbw: 0.7e6,
      slew: 0.3e6,
      vos: 2e-3,
      // PNP inputs: the bias current flows out of the pins.
      ib: -20e-9,
      cm: [0, 1.5],
      // Either input may go 0.3 V below V− and up to 32 V whatever V+ is.
      inputs: [0.3, Infinity],
      inputMax: 32,
      // 1.5 V from V+ into 2 kΩ at 5 V (1.4 V unloaded plus 50 Ω × 1.75 mA), 5 mV from V− into 10 kΩ.
      swing: [1.4, 0.005],
      rout: 50,
      // Into a short at VS = 15 V: 30 mA sourced at VO = 0 V, 20 mA sunk at VO = 15 V.
      source: 0.03,
      sink: 0.02,
      iq: [
        [5, 350e-6],
        [30, 500e-6],
      ],
      vsMin: 3,
      vsMax: 30,
    },
    vsAbs: 32,
    // PDIP: RθJA 80.9 °C/W, TJ 150 °C.
    pmax: 1.55,
    dip: { package: "PDIP-8", out: 1, inn: 2, inp: 3, vee: 4, vcc: 8, others: "5 IN+ B, 6 IN− B, 7 OUT B" },
    source: "TI LMx58 datasheet SLOS068AB (October 2024), §5.1, 5.3, 5.4, 5.7",
  },
  {
    id: "lm741",
    part: "LM741",
    description:
      "TI's LM741C, the classic single op amp on a split supply (±5 to ±18 V): 1 MHz, 0.5 V/µs, ±14 V out of ±15 V into 10 kΩ, 25 mA into a short, 80 nA of bias current into its 2 MΩ inputs.",
    keywords: ["LM741", "UA741", "µA741", "741", "op amp", "operational amplifier"],
    spec: {
      // Table 6.7, LM741C at VS = ±15 V.
      gain: 200e3,
      // The LM741C has no bandwidth line; its unity-gain rise time, 0.3 µs, is a single pole at 1.2 MHz, and 1 MHz is its usual figure.
      gbw: 1e6,
      slew: 0.5e6,
      vos: 2e-3,
      ib: 80e-9,
      cm: [2, 2],
      // "For supply voltages less than ±15 V, the absolute maximum input voltage is equal to the supply voltage."
      inputs: [0, 0],
      // ±14 V into 10 kΩ and ±13 V into 2 kΩ: 0.73 V unloaded and 196 Ω.
      swing: [0.73, 0.73],
      rout: 196,
      source: 0.025,
      sink: 0.025,
      iq: 1.7e-3,
      vsMin: 10,
      vsMax: 36,
    },
    vsAbs: 36,
    pmax: 0.5,
    rin: 2e6,
    dip: { package: "PDIP-8", out: 6, inn: 2, inp: 3, vee: 4, vcc: 7, others: "1 and 5 offset null, 8 NC" },
    source: "TI LM741 datasheet SNOSC25D (October 2015), §6.1 and 6.7 (LM741C)",
  },
  {
    id: "tl072",
    part: "TL072",
    description:
      "TI's TL072, the JFET-input dual op amp of audio and filter circuits: ±5 to ±20 V, 3 MHz, 20 V/µs, 65 pA of bias current, ±13.5 V out of ±15 V into 10 kΩ. One symbol is one of its two amplifiers.",
    keywords: ["TL072", "TL071", "TL074", "TL072CP", "JFET", "op amp", "operational amplifier"],
    spec: {
      // Table 5.8 (DC) and 5.9 (AC), TL07xC at VS = ±15 V.
      gain: 200e3,
      gbw: 3e6,
      slew: 20e6,
      vos: 3e-3,
      ib: 65e-12,
      cm: [3, 0],
      inputs: [0.5, 0.5],
      // ±13.5 V into 10 kΩ, ±12 V into 2 kΩ (the earlier revisions' typical): 1.06 V unloaded and 323 Ω.
      swing: [1.06, 1.06],
      rout: 323,
      // No short-circuit line for the TL07xC; the TL07xH's in the same sheet, ±26 mA.
      source: 0.026,
      sink: 0.026,
      iq: 1.4e-3,
      vsMin: 10,
      vsMax: 40,
    },
    vsAbs: 42,
    // PDIP: RθJA 85 °C/W, TJ 150 °C.
    pmax: 1.47,
    dip: { package: "PDIP-8", out: 1, inn: 2, inp: 3, vee: 4, vcc: 8, others: "5 IN+ B, 6 IN− B, 7 OUT B" },
    source: "TI TL07x datasheet SLOS080W (July 2025), §5.1, 5.3, 5.5, 5.8, 5.9",
  },
  {
    id: "mcp6002",
    part: "MCP6002",
    description:
      "Microchip's MCP6002, a CMOS dual op amp for 1.8–6 V with inputs and output from rail to rail: 1 MHz, 0.6 V/µs, 100 µA, 23 mA into a short at 5.5 V (6 mA at 1.8 V), 7 V absolute maximum. One symbol is one of its two amplifiers.",
    keywords: ["MCP6002", "MCP6001", "MCP6004", "rail-to-rail", "CMOS", "op amp", "operational amplifier", "3.3 V"],
    spec: {
      // DC and AC tables at VDD = 5.5 V; the gain 112 dB.
      gain: 398e3,
      gbw: 1e6,
      slew: 0.6e6,
      // Only a ±4.5 mV maximum is given.
      vos: 0,
      ib: 1e-12,
      cm: [-0.3, -0.3],
      inputs: [1, 1],
      // Within 25 mV of either rail into 10 kΩ to VDD / 2 (0.27 mA at 5.5 V).
      swing: [0, 0],
      rout: 75,
      source: [
        [1.8, 0.006],
        [5.5, 0.023],
      ],
      sink: [
        [1.8, 0.006],
        [5.5, 0.023],
      ],
      iq: 100e-6,
      vsMin: 1.8,
      vsMax: 6,
    },
    vsAbs: 7,
    // PDIP: θJA 85 °C/W, TJ 150 °C.
    pmax: 1.47,
    clamp: 2e-3,
    dip: { package: "PDIP-8", out: 1, inn: 2, inp: 3, vee: 4, vcc: 8, others: "5 VINB+, 6 VINB−, 7 VOUTB" },
    source: "Microchip MCP6001/1R/1U/2/4 datasheet DS20001733L (2020), §1.0 and 4.1",
  },
]

const byId = new Map(OPAMP_PRESETS.map((p) => [p.id, p]))

export const opampPreset = (id: string): OpampPreset => byId.get(id) ?? byId.get(GENERIC_OPAMP)!

/** The figures a placed amplifier overrides: open-loop gain (V/V), GBW (Hz), slew rate (V/s), offset (V), the swing short of each rail (V), the current limit (A). */
export type OpampOverrides = { gain?: number; gbw?: number; slew?: number; vos?: number; rail?: number; isc?: number }

const positive = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n > 0

/** A preset's figures with a placed amplifier's own laid over them; nonsense is ignored. */
export function opampSpec(id: string, over: OpampOverrides = {}): OpampSpec {
  const spec = opampPreset(id).spec
  const rail = over.rail !== undefined && Number.isFinite(over.rail) && over.rail >= 0 ? over.rail : undefined
  return {
    ...spec,
    gain: positive(over.gain) ? over.gain! : spec.gain,
    gbw: positive(over.gbw) ? over.gbw! : spec.gbw,
    slew: positive(over.slew) ? over.slew! : spec.slew,
    vos: over.vos !== undefined && Number.isFinite(over.vos) ? over.vos : spec.vos,
    swing: rail !== undefined ? [rail, rail] : spec.swing,
    source: positive(over.isc) ? over.isc! : spec.source,
    sink: positive(over.isc) ? over.isc! : spec.sink,
  }
}

/** A supply curve's value at `volts` and its slope there, held flat past either end. */
export function curveAt(curve: SupplyCurve, volts: number, out: Float64Array) {
  if (typeof curve === "number") {
    out[0] = curve
    out[1] = 0
    return
  }
  const last = curve.length - 1
  if (volts <= curve[0][0]) {
    out[0] = curve[0][1]
    out[1] = 0
    return
  }
  if (volts >= curve[last][0]) {
    out[0] = curve[last][1]
    out[1] = 0
    return
  }
  let k = 0
  while (volts > curve[k + 1][0]) k++
  const [x0, y0] = curve[k]
  const [x1, y1] = curve[k + 1]
  out[1] = (y1 - y0) / (x1 - x0)
  out[0] = y0 + (volts - x0) * out[1]
}

/** How much of its drive an amplifier has on `volts` of total supply: none at 0 V, all of it from `vsMin`. */
export function supplyDrive(spec: OpampSpec, volts: number): number {
  return Math.min(1, Math.max(0, volts / spec.vsMin))
}

/** The share of the output current that comes from V+ (sourcing) and goes to V− (sinking), smoothed over this many amps around zero. */
export const SPLIT_SMOOTHING = 1e-6

/** What V+ supplies of an output current `amps`, and its slope: `amps` sourcing, nothing sinking, smoothly in between. */
export function fromPositive(amps: number, out: Float64Array) {
  const r = Math.hypot(amps, SPLIT_SMOOTHING)
  out[0] = (amps + r) / 2
  out[1] = (1 + amps / r) / 2
}
