/**
 * The parts, from their datasheets (read 2026-10-08; revision and date in each `source`).
 * Built from the general to the particular: a timing table and a word layout shared by many
 * parts, a family base (Worldsemi single-wire, 5 V pixel, 12 V pixel, constant-current
 * driver), then each part number with what its datasheet changes.
 *
 * Left out, for want of a datasheet that says enough to model them: WS2808 (its outputs are
 * taps on one series string of LEDs, how they switch is not described), plain WS2814 in SOP-12
 * (no datasheet obtainable), WS2812B-0909 and the 5050 WS2812A (product pages only).
 */
import type { ChipSpec, FieldSpec, NrzTiming } from "./spec"

const ns = 1e-9
const us = 1e-6
const mA = 1e-3

// --- timing tables, as printed ------------------------------------------------------------------

/** WS2812B (2013): 0.4 / 0.8 / 0.85 / 0.45 µs ± 150 ns, RES ≥ 50 µs. */
const T_WS2812B_2013: NrzTiming = { t0h: [250 * ns, 550 * ns], t1h: [650 * ns, 950 * ns], t0l: [700 * ns, 1000 * ns], t1l: [300 * ns, 600 * ns], reset: 50 * us }
/** WS2812 (2012, 6-pin): 0.35 / 0.7 / 0.8 / 0.6 µs ± 150 ns, RES > 50 µs. */
const T_WS2812_2012: NrzTiming = { t0h: [200 * ns, 500 * ns], t1h: [550 * ns, 850 * ns], t0l: [650 * ns, 950 * ns], t1l: [450 * ns, 750 * ns], reset: 50 * us }
/** WS2812D-F8: 0.40 / 0.85 / 0.85 / 0.40 µs ± 150 ns, RES ≥ 50 µs. */
const T_OLD_SYM: NrzTiming = { t0h: [250 * ns, 550 * ns], t1h: [700 * ns, 1000 * ns], t0l: [700 * ns, 1000 * ns], t1l: [250 * ns, 550 * ns], reset: 50 * us }
/** WS2811 (2017) style: T1H and T0L to 1.6 µs, T1L 220–420 ns, RES > 280 µs. */
const T_2811: NrzTiming = { t0h: [220 * ns, 380 * ns], t1h: [580 * ns, 1600 * ns], t0l: [580 * ns, 1600 * ns], t1l: [220 * ns, 420 * ns], reset: 280 * us }
/** The later symmetric table: T1H, T0L, T1L 580 ns – 1 µs, RES > 280 µs. */
const T_SYM: NrzTiming = { t0h: [220 * ns, 380 * ns], t1h: [580 * ns, 1000 * ns], t0l: [580 * ns, 1000 * ns], t1l: [580 * ns, 1000 * ns], reset: 280 * us }
/** WS2812S / WS2812E (2018): the 2811 table with T1H and T0L to 1 µs. */
const T_2811_SHORT: NrzTiming = { ...T_2811, t1h: [580 * ns, 1000 * ns], t0l: [580 * ns, 1000 * ns] }
/** WS2813 (2016): T0H 220–480 ns, T1H 750 ns – 2 µs, RES ≥ 300 µs. */
const T_WS2813_2016: NrzTiming = { t0h: [220 * ns, 480 * ns], t1h: [750 * ns, 2000 * ns], t0l: [750 * ns, 2000 * ns], t1l: [220 * ns, 480 * ns], reset: 300 * us }
/** WS2815B (2023): long lows allowed, T1H to 840 ns. */
const T_WS2815B: NrzTiming = { t0h: [220 * ns, 380 * ns], t1h: [580 * ns, 840 * ns], t0l: [900 * ns, 5000 * ns], t1l: [600 * ns, 5000 * ns], reset: 280 * us }
/** WS2816 and WS2916B: T0H 200–320 ns, T1H 520–800 ns. */
const T_WS2816: NrzTiming = { t0h: [200 * ns, 320 * ns], t1h: [520 * ns, 800 * ns], t0l: [800 * ns, 1200 * ns], t1l: [480 * ns, 1000 * ns], reset: 280 * us }
/** WS2916A. */
const T_WS2916A: NrzTiming = { t0h: [200 * ns, 380 * ns], t1h: [540 * ns, 1000 * ns], t0l: [750 * ns, 1200 * ns], t1l: [460 * ns, 1000 * ns], reset: 280 * us }
/** WS2916A-RGBW. */
const T_WS2916A_RGBW: NrzTiming = { ...T_SYM, t1h: [520 * ns, 1000 * ns] }
/** WS2811 (2011): high-speed mode, half the low-speed times (0.25 / 0.6 / 1.0 / 0.65 µs ± 150 ns), RES > 50 µs. */
const T_WS2811_2011_FAST: NrzTiming = { t0h: [100 * ns, 400 * ns], t1h: [450 * ns, 750 * ns], t0l: [850 * ns, 1150 * ns], t1l: [500 * ns, 800 * ns], reset: 50 * us }
/** WS2811 (2011): low-speed mode (SET to VDD), 0.5 / 1.2 / 2.0 / 1.3 µs ± 150 ns. */
const T_WS2811_2011_SLOW: NrzTiming = { t0h: [350 * ns, 650 * ns], t1h: [1050 * ns, 1350 * ns], t0l: [1850 * ns, 2150 * ns], t1l: [1150 * ns, 1450 * ns], reset: 50 * us }
/** SK6812: 0.3 / 0.6 / 0.9 / 0.6 µs ± 150 ns, Trst 80 µs (the table; the figure says ≥ 50 µs). */
const T_SK6812: NrzTiming = { t0h: [150 * ns, 450 * ns], t1h: [450 * ns, 750 * ns], t0l: [750 * ns, 1050 * ns], t1l: [450 * ns, 750 * ns], reset: 80 * us }

// --- word layouts -----------------------------------------------------------------------------

const level = (channel: FieldSpec["channel"], bits = 8): FieldSpec => ({ channel, bits, role: "level" })
const gain = (channel: FieldSpec["channel"]): FieldSpec => ({ channel, bits: 5, role: "gain" })
const check = (bits: number): FieldSpec => ({ channel: null, bits, role: "check" })

const GRB = [level("G"), level("R"), level("B")]
const RGB = [level("R"), level("G"), level("B")]
const GRBW = [level("G"), level("R"), level("B"), level("W")]
const WRGB = [level("W"), level("R"), level("G"), level("B")]
const RGBW1W2 = [level("R"), level("G"), level("B"), level("W"), level("W2")]
const GRB16 = [level("G", 16), level("R", 16), level("B", 16)]

const rgb = (i: number) => ({ R: i, G: i, B: i })
const rgbw = (i: number, w = i) => ({ R: i, G: i, B: i, W: w })

// --- family bases -------------------------------------------------------------------------------

/** What every Worldsemi single-wire part shares: tPLZ ≤ 300 ns, MSB first. */
const WORLDSEMI = { delay: 300 * ns } as const

/** A 5 V integrated pixel: one supply for die and LEDs. */
const PIXEL_5V = {
  ...WORLDSEMI,
  logic: { pin: "VDD", vih: { ratio: 0.7 } },
  fields: GRB,
  pwmHz: 2e3,
} as const

/** A 12 V integrated pixel: VDD at 12 V, the die on its own 5 V rail. */
const PIXEL_12V = {
  ...WORLDSEMI,
  fields: GRB,
  pwmHz: 2e3,
  inputMax: 5.7,
} as const

/**
 * A constant-current driver: a few hundred µA for the die, VDD held by its shunt regulator
 * so 12 V or 24 V only needs a series resistor. The datasheets give no clamp voltage; it is
 * modelled just under the absolute maximum, above the 5 V rail a direct supply brings.
 */
const DRIVER = {
  ...WORLDSEMI,
  logic: { pin: "VDD", vih: { ratio: 0.7 } },
} as const

const sink3 = (current: number, withstand: number) => ({
  kind: "sink" as const,
  outputs: [
    { pin: "OUTR", channel: "R" as const },
    { pin: "OUTG", channel: "G" as const },
    { pin: "OUTB", channel: "B" as const },
  ],
  current: rgb(current),
  withstand,
})

const sink4 = (current: number, withstand: number, w = current) => ({
  kind: "sink" as const,
  outputs: [
    { pin: "OUTR", channel: "R" as const },
    { pin: "OUTG", channel: "G" as const },
    { pin: "OUTB", channel: "B" as const },
    { pin: "OUTW", channel: "W" as const },
  ],
  current: rgbw(current, w),
  withstand,
})

/** Five outputs OUTR…OUTW2; `w2` names the data channel OUTW2 follows (its own on WS2805, W on WS2914). */
const sink5 = (current: Partial<Record<"R" | "G" | "B" | "W" | "W2", number>>, withstand: number, w2: "W" | "W2") => ({
  kind: "sink" as const,
  outputs: [
    { pin: "OUTR", channel: "R" as const },
    { pin: "OUTG", channel: "G" as const },
    { pin: "OUTB", channel: "B" as const },
    { pin: "OUTW1", channel: "W" as const },
    { pin: "OUTW2", channel: w2 },
  ],
  current,
  withstand,
})

// --- 4-pin integrated pixels (VDD, DOUT, VSS, DIN) ---------------------------------------------

export const PIXELS_4PIN: ChipSpec[] = [
  {
    ...PIXEL_5V,
    part: "WS2812B",
    label: "WS2812B (2013) · 5050",
    input: { kind: "nrz", timing: T_WS2812B_2013 },
    // The 2013 sheet gives no LED or quiescent current: the WS2812's 18.5 mA (2012) and the V5's 0.6 mA.
    light: { kind: "pixel", current: rgb(18.5 * mA) },
    quiescent: 0.6 * mA,
    pwmHz: 400,
    supply: { min: 3.5, max: 5.3, abs: 5.3 },
    inputMax: 5.8,
    source: "Worldsemi WS2812B datasheet (2013): VDD +3.5…+5.3 V, VIH 0.7 VDD, GRB, ≥ 400 Hz scan; LED and quiescent currents not given (WS2812 2012 and WS2812B-V5 values)",
  },
  {
    ...PIXEL_5V,
    part: "WS2812B-V5",
    label: "WS2812B-V5 · 5050",
    input: { kind: "nrz", timing: T_SYM },
    light: { kind: "pixel", current: rgb(12 * mA) },
    quiescent: 0.6 * mA,
    logic: { pin: "VDD", vih: { volts: 2.7 } },
    supply: { min: 3.7, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2812B-V5 V5.0 (2019-03-23): VDD +3.7…+5.3 V, VIH 2.7 V, 12 mA, RES > 280 µs",
  },
  {
    ...PIXEL_5V,
    part: "WS2812B-V6",
    label: "WS2812B-V6 · 5050, DIN/DOUT interchangeable",
    input: { kind: "nrz", timing: T_SYM, bidirectional: true },
    light: { kind: "pixel", current: rgb(12 * mA) },
    quiescent: 1e-6,
    logic: { pin: "VDD", vih: { ratio: 0.55 } },
    supply: { min: 3.3, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2812B-V6 V1.1 (2025-10-21): VDD +3.3…+5.3 V, VIH 0.55 VDD, 12 mA, Iq ≤ 1 µA, input and output may be swapped",
  },
  {
    ...PIXEL_5V,
    part: "WS2812B-V7",
    label: "WS2812B-V7 · 5050",
    input: { kind: "nrz", timing: T_SYM },
    light: { kind: "pixel", current: rgb(16 * mA) },
    quiescent: 1e-6,
    logic: { pin: "VDD", vih: { ratio: 0.55 } },
    supply: { min: 3.3, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2812B-V7 V1.3 (2026-08): VDD +3.3…+5.3 V, VIH 0.55 VDD, 16 mA (the product page says 12 mA), Iq ≤ 1 µA",
  },
  {
    ...PIXEL_5V,
    part: "WS2812B-Mini",
    label: "WS2812B-Mini-V3 · 3535",
    input: { kind: "nrz", timing: T_SYM },
    light: { kind: "pixel", current: rgb(12 * mA) },
    quiescent: 0.6 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.63 } },
    supply: { min: 3.7, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2812B-MINI-V3/W V4.0 (2021-12-02): VDD 3.7–5.3 V, VIH 0.63 VDD, 12 mA",
  },
  {
    ...PIXEL_5V,
    part: "WS2812B-2020",
    label: "WS2812B-2020 · 2020",
    input: { kind: "nrz", timing: T_SYM },
    light: { kind: "pixel", current: rgb(12 * mA) },
    quiescent: 0.6 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.65 } },
    // "the maximum working voltage shall not exceed 7V"
    supply: { min: 3.7, max: 5.3, abs: 7 },
    inputMax: 6,
    source: "Worldsemi WS2812B-2020 V1.5 (2022-08-23): VDD 3.7–5.3 V, never above 7 V, VIH 0.65 VDD, 12 mA",
  },
  {
    ...PIXEL_5V,
    part: "WS2812",
    label: "WS2812 (2020, 4-pin) · 5050",
    input: { kind: "nrz", timing: T_SYM },
    light: { kind: "pixel", current: rgb(12.5 * mA) },
    quiescent: 0.6 * mA,
    supply: { min: 3.7, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2812 V1.1 (2021-12-02): VDD 3.7–5.3 V, VIH 0.7 VDD, 12.5 mA",
  },
  {
    ...PIXEL_5V,
    part: "WS2812C",
    label: "WS2812C · 5050, 5 mA",
    input: { kind: "nrz", timing: T_SYM },
    light: { kind: "pixel", current: rgb(5 * mA) },
    quiescent: 0.6 * mA,
    supply: { min: 3.7, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2812C V1.5 (2021-12-08): VDD 3.7–5.3 V, VIH 0.7 VDD, 5 mA, Iq 0.6 mA",
  },
  {
    ...PIXEL_5V,
    part: "WS2812C-2020",
    label: "WS2812C-2020-V1 · 2020, 5 mA",
    input: { kind: "nrz", timing: T_SYM },
    light: { kind: "pixel", current: rgb(5 * mA) },
    quiescent: 0.5 * mA,
    logic: { pin: "VDD", vih: { volts: 2.7 } },
    supply: { min: 3.7, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2812C-2020-V1 V1.0 (2021-06-24): VDD 3.7–5.3 V, VIH 2.7 V, 5 mA",
  },
  {
    ...PIXEL_5V,
    part: "WS2812D-F5",
    label: "WS2812D-F5 · 5 mm through-hole",
    input: { kind: "nrz", timing: T_SYM },
    // The F5 sheet's LED table is empty: the family table's 12 mA.
    light: { kind: "pixel", current: rgb(12 * mA) },
    quiescent: 0.6 * mA,
    logic: { pin: "VDD", vih: { volts: 2.7 } },
    supply: { min: 3.7, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2812D-F5 V2.0 (2021-09-10): VDD 3.7–5.3 V, VIH 2.7 V; LED current from the Worldsemi family table (12 mA)",
  },
  {
    ...PIXEL_5V,
    part: "WS2812D-F8",
    label: "WS2812D-F8 · 8 mm through-hole, RGB order",
    input: { kind: "nrz", timing: T_OLD_SYM },
    fields: RGB,
    light: { kind: "pixel", current: rgb(12 * mA) },
    quiescent: 0.6 * mA,
    supply: { min: 3.5, max: 5.3, abs: 5.3 },
    inputMax: 5.8,
    source: "Worldsemi WS2812D-F8 (2016): VDD 3.5–5.3 V, VIH 0.7 VDD, RGB order, RES ≥ 50 µs; LED current from the family table (12 mA)",
  },
  {
    ...PIXEL_5V,
    part: "WS2812E",
    label: "WS2812E · 5050",
    input: { kind: "nrz", timing: T_2811_SHORT },
    light: { kind: "pixel", current: rgb(16 * mA) },
    quiescent: 0.7 * mA,
    supply: { min: 3.7, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2812E V1.0 (2018-01-23): VDD 3.7–5.3 V, VIH 0.7 VDD, 16 mA, T1L 220–420 ns",
  },
  {
    ...PIXEL_5V,
    part: "WS2812E-V5",
    label: "WS2812E-V5 · 5050",
    input: { kind: "nrz", timing: T_SYM },
    light: { kind: "pixel", current: rgb(12.5 * mA) },
    quiescent: 0.6 * mA,
    logic: { pin: "VDD", vih: { volts: 2.7 } },
    supply: { min: 3.7, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2812E-V5 V1.0 (2020-11-23): VDD 3.7–5.3 V, VIH 2.7 V, 12.5 mA",
  },
  {
    ...PIXEL_5V,
    part: "WS2812A",
    label: "WS2812A · 5054, 34 mA",
    input: { kind: "nrz", timing: T_SYM },
    light: { kind: "pixel", current: rgb(34 * mA) },
    quiescent: 0.6 * mA,
    supply: { min: 3.7, max: 5.7, abs: 5.7 },
    inputMax: 6.4,
    source: "Worldsemi WS2812A-5054MP-V1 V1.0 (2026-08): VDD +3.7…+5.7 V, VIH 0.7 VDD, tested at 34 mA",
  },
  {
    ...PIXEL_5V,
    part: "SK6812",
    label: "SK6812 · 5050 (compatible)",
    input: { kind: "nrz", timing: T_SK6812 },
    // No current per channel is given; the 12 mA of the WS2812B-V5 it is sold against.
    light: { kind: "pixel", current: rgb(12 * mA) },
    quiescent: 1 * mA,
    logic: { pin: "VDD", vih: { volts: 3.4 } },
    pwmHz: 1.2e3,
    delay: 500 * ns,
    supply: { min: 3.5, max: 5.5, abs: 5.5 },
    inputMax: 6,
    source: "LED COLOR SK6812 Rev 01 (2015): VIH 3.4 V, Trst 80 µs, IDD 1 mA, DIN→DOUT ≤ 500 ns, 1.2 kHz PWM; supply range from the Opsco SK6812RGBW sheet; channel current not given",
  },
  {
    ...PIXEL_5V,
    part: "SK6812RGBW",
    label: "SK6812RGBW · 5050, RGB + white (compatible)",
    input: { kind: "nrz", timing: T_SK6812 },
    fields: GRBW,
    light: { kind: "pixel", current: rgbw(12 * mA) },
    quiescent: 1 * mA,
    logic: { pin: "VDD", vih: { volts: 3.4 } },
    pwmHz: 1.2e3,
    delay: 500 * ns,
    supply: { min: 3.5, max: 5.5, abs: 5.5 },
    inputMax: 6,
    source:
      "Opsco SK6812RGBW Rev 01 (2015-07-31): VDD +3.5…+5.5 V, VIH 3.4 V, Trst 80 µs, 1.2 kHz; the sheet prints RGBW order, parts in the field take GRBW (Adafruit NEO_GRBW), which is modelled; channel current not given",
  },
]

// --- 12 V 4-pin pixels (VDD at 12 V, the die on its own 5 V rail) ----------------------------------

export const PIXELS_4PIN_12V: ChipSpec[] = [
  {
    ...PIXEL_12V,
    part: "WS2815B-4P",
    label: "WS2815B-V1-4P · 5050, 12 V",
    input: { kind: "nrz", timing: T_WS2815B },
    light: { kind: "pixel", current: rgb(12 * mA) },
    quiescent: 2 * mA,
    logic: { pin: "VDD", vih: { volts: 2.7 } },
    supply: { min: 9.5, max: 13.5, abs: 13.5 },
    source: "Worldsemi WS2815B-V1-4P V1.0 (2023-06-26): VDD +9.5…+13.5 V, VIH 2.7 V, inputs ≤ 5.7 V, 12 mA, Iq < 2 mA, 4 kHz refresh",
    pwmHz: 4e3,
  },
  {
    ...PIXEL_12V,
    part: "WS2815B-RGBW-4P",
    label: "WS2815B-RGBW-4P · 5050, 12 V, RGB + white",
    input: { kind: "nrz", timing: T_WS2815B },
    fields: GRBW,
    light: { kind: "pixel", current: rgbw(12 * mA) },
    quiescent: 2 * mA,
    logic: { pin: "VDD", vih: { volts: 2.7 } },
    supply: { min: 9.5, max: 13.5, abs: 13.5 },
    source: "Worldsemi WS2815B-RGBW-4P V1.0 (2023-06-26): VDD +9.5…+13.5 V, VIH 2.7 V, 32-bit GRBW, 12 mA",
  },
]

// --- 6-pin WS2812 / WS2812S (separate VCC for the die, VDD for the LEDs) ------------------------

export const PIXELS_6PIN: ChipSpec[] = [
  {
    ...PIXEL_5V,
    part: "WS2812-6P",
    label: "WS2812 (2012) · 6-pin 5050",
    input: { kind: "nrz", timing: T_WS2812_2012 },
    light: { kind: "pixel", current: rgb(18.5 * mA) },
    quiescent: 0.6 * mA,
    logic: { pin: "VCC", vih: { ratio: 0.7 } },
    // The absolute maximum is printed "+6.0~+7.0": the lower figure is taken.
    supply: { min: 4.5, max: 5.5, abs: 6 },
    inputMax: 6,
    source: "Worldsemi WS2812 (2012, 6-pin): VCC for the die, VDD for the LEDs, operating 4.5–5.5 V, absolute maximum printed \"+6.0~+7.0\" V, IOL 18.5 mA, RES > 50 µs",
  },
  {
    ...PIXEL_5V,
    part: "WS2812S",
    label: "WS2812S · 6-pin 5050",
    input: { kind: "nrz", timing: T_2811_SHORT },
    light: { kind: "pixel", current: rgb(16.5 * mA) },
    quiescent: 0.6 * mA,
    logic: { pin: "VCC", vih: { ratio: 0.7 } },
    supply: { min: 3.7, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2812S V1.4 (2018-07-19): VCC and VDD +3.7…+5.3 V, IOL 16.5 mA, VIH 0.7 VDD",
  },
]

// --- dual-signal pixels with a backup input (VCC, VDD, DO, DIN, GND, BIN) ------------------------

/** WS2813 family: die and LEDs from 5 V; pin 1 is NC or the die's own VCC by revision. */
const WS2813_BASE = { ...PIXEL_5V, supply: { min: 3.7, max: 5.3, abs: 5.3 }, inputMax: 6 } as const

export const PIXELS_BACKUP: ChipSpec[] = [
  {
    ...WS2813_BASE,
    part: "WS2813",
    label: "WS2813 (V1.4, 2018) · VCC through R1",
    input: { kind: "nrz", timing: T_2811, backup: true },
    light: { kind: "pixel", current: rgb(16 * mA) },
    quiescent: 0.7 * mA,
    logic: { pin: "VCC", vih: { ratio: 0.7 } },
    source: "Worldsemi WS2813 V1.4 (2018-07-19): VCC the die's supply (150–390 Ω from 5 V), VDD the LEDs', 3.7–5.3 V, 16 mA (A/B), BIN wired to the previous pixel's DIN",
  },
  {
    ...WS2813_BASE,
    part: "WS2813C",
    label: "WS2813C/D (V1.4, 2018) · 5 mA",
    input: { kind: "nrz", timing: T_2811, backup: true },
    light: { kind: "pixel", current: rgb(5 * mA) },
    quiescent: 0.3 * mA,
    logic: { pin: "VCC", vih: { ratio: 0.7 } },
    source: "Worldsemi WS2813 V1.4 (2018-07-19) family table: WS2813C/D 5 mA, Iq 0.3 mA",
  },
  {
    ...WS2813_BASE,
    part: "WS2813-2016",
    label: "WS2813 (2016) · pin 1 NC",
    input: { kind: "nrz", timing: T_WS2813_2016, backup: true },
    // The table says 15 mA, the text "18mA or 5mA": the table is taken.
    light: { kind: "pixel", current: rgb(15 * mA) },
    quiescent: 0.6 * mA,
    supply: { min: 3.5, max: 5.3, abs: 5.3 },
    source: "Worldsemi WS2813 (2016): pin 1 NC, VDD +3.5…+5.3 V, 15 mA (A/B), RES ≥ 300 µs; prints R-G-B in the table and GRB in the note (GRB modelled)",
  },
  {
    ...WS2813_BASE,
    part: "WS2813E",
    label: "WS2813E · pin 1 NC",
    input: { kind: "nrz", timing: T_2811, backup: true },
    light: { kind: "pixel", current: rgb(16 * mA) },
    quiescent: 0.7 * mA,
    supply: { min: 3.5, max: 5.3, abs: 5.3 },
    source: "Worldsemi WS2813E V1.0 (2017): pin 1 NC, VDD 3.5–5.3 V, 16 mA, Iq 0.7 mA",
  },
  {
    ...WS2813_BASE,
    part: "WS2813-Mini",
    label: "WS2813-Mini · 3535",
    input: { kind: "nrz", timing: T_2811, backup: true },
    light: { kind: "pixel", current: rgb(16 * mA) },
    quiescent: 0.7 * mA,
    logic: { pin: "VCC", vih: { ratio: 0.7 } },
    source: "Worldsemi WS2813-Mini V1.1 (2017-10-10): VCC to VDD or through 100–300 Ω, 3.7–5.3 V, 16 mA",
  },
  {
    ...WS2813_BASE,
    part: "WS2813A-V7",
    label: "WS2813A-V7 · pin 1 NC, VIH 0.55 VCC",
    input: { kind: "nrz", timing: T_SYM, backup: true },
    light: { kind: "pixel", current: rgb(16 * mA) },
    quiescent: 1e-6,
    logic: { pin: "VDD", vih: { ratio: 0.55 } },
    // "Max. operating driving voltage mustn't exceed 7V"
    supply: { min: 3.3, max: 5.3, abs: 7 },
    source: "Worldsemi WS2813A-V7 V1.0 (2026-08): +3.3…+5.3 V, never above 7 V, VIH 0.55 VCC, 16 mA, Iq ≤ 1 µA",
  },
  {
    ...WS2813_BASE,
    part: "WS2813B-RGBW",
    label: "WS2813B-RGBW · RGB + white",
    input: { kind: "nrz", timing: T_SYM, backup: true },
    fields: GRBW,
    light: { kind: "pixel", current: rgbw(15 * mA) },
    quiescent: 0.7 * mA,
    logic: { pin: "VCC", vih: { ratio: 0.7 } },
    source: "Worldsemi WS2813B-RGBW V1.4 (2021-11-05): VCC to VDD or through a resistor, 3.7–5.3 V, 32-bit GRBW, 15 mA; DIN2 has no switching text (the WS2813 rule is modelled)",
  },
  {
    ...WORLDSEMI,
    part: "WS2916A-RGBW",
    label: "WS2916A-RGBW · 16-bit RGB + white, gain header",
    input: { kind: "nrz", timing: T_WS2916A_RGBW, backup: true },
    header: [gain("G"), gain("R"), gain("B"), gain("W"), check(12)],
    fields: [level("G", 16), level("R", 16), level("B", 16), level("W", 16)],
    light: { kind: "pixel", current: rgbw(30.46 * mA, 60.7 * mA) },
    pwmHz: 2e3,
    quiescent: 0.3 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.55 } },
    supply: { min: 3.5, max: 5.7, abs: 5.7 },
    inputMax: 6.4,
    source: "Worldsemi WS2916A-RGBW V1.0: 32-bit gain header (GRBW × 5 bits + 12 check bits) forwarded by every chip, 64-bit GRBW words, gain 0x1F = 30.46 mA (RGB) / 60.7 mA (W)",
  },
]

// --- 12 V dual-signal pixels (VDD 12 V, DO, DIN, GND, BIN; pin 1 NC) ------------------------------

export const PIXELS_BACKUP_12V: ChipSpec[] = [
  {
    ...PIXEL_12V,
    part: "WS2815B",
    label: "WS2815B-V1 · 12 V, DIN1 + DIN2",
    input: { kind: "nrz", timing: T_WS2815B, backup: true },
    light: { kind: "pixel", current: rgb(12 * mA) },
    quiescent: 2 * mA,
    logic: { pin: "VDD", vih: { volts: 2.7 } },
    supply: { min: 9.5, max: 13.5, abs: 13.5 },
    pwmHz: 4e3,
    source: "Worldsemi WS2815B-V1 V2.2 (2023-03-15): VDD +9.5…+13.5 V, VIH 2.7 V, inputs ≤ 5.7 V, 12 mA; DIN2's wiring and switching are not described (the WS2815 rule is modelled)",
  },
  {
    ...PIXEL_12V,
    part: "WS2815B-RGBW",
    label: "WS2815B-RGBW-V1 · 12 V, RGB + white",
    input: { kind: "nrz", timing: T_WS2815B, backup: true },
    fields: GRBW,
    light: { kind: "pixel", current: rgbw(12 * mA) },
    quiescent: 2 * mA,
    logic: { pin: "VDD", vih: { volts: 3 } },
    supply: { min: 9.5, max: 13.5, abs: 13.5 },
    source: "Worldsemi WS2815B-RGBW-V1 V1.3 (2026-08): VDD +9.5…+13.5 V, VIH 3.0 V, 32-bit GRBW, 12 mA",
  },
]

/** WS2815: as above with pin 1 VCC, the die's own regulator output. */
export const PIXELS_WS2815: ChipSpec[] = [
  {
    ...PIXEL_12V,
    part: "WS2815",
    label: "WS2815 · 12 V, VCC from the die's regulator",
    input: { kind: "nrz", timing: T_2811, backup: true },
    light: { kind: "pixel", current: rgb(15 * mA) },
    quiescent: 2.1 * mA,
    // VIH 0.7 × the die's rail; the electrical table is given at 4.5–5.5 V.
    logic: { pin: "VDD", vih: { volts: 3.5 } },
    regulator: 5,
    supply: { min: 9.5, max: 13.5, abs: 13.5 },
    source: "Worldsemi WS2815 V1.1 (2017-10-10): VDD +9.5…+13.5 V, 15 mA, Iq 2.1 mA, VCC \"suspended or a filter capacitor\" (the die's rail, modelled at 5 V, the electrical table's middle)",
  },
]

// --- dual-signal pixels with BI and BO (DI, BI, DO, BO, VDD, GND) --------------------------------

export const PIXELS_RELAY: ChipSpec[] = [
  {
    ...WS2813_BASE,
    part: "WS2813B-V5",
    label: "WS2813B-V5 · BO repeats the input",
    input: { kind: "nrz", timing: T_SYM, backup: true, relay: true },
    light: { kind: "pixel", current: rgb(16 * mA) },
    quiescent: 0.6 * mA,
    source: "Worldsemi WS2813B-V5 V6.0 (2021-12-02): 3.7–5.3 V, VIH 0.7 VDD, 16 mA; BO → next BI in the application circuit, its signal not described (modelled as a copy of the chip's input)",
  },
  {
    ...WS2813_BASE,
    part: "WS2813B-V6",
    label: "WS2813B-V6 · BO, VIH 0.55 VCC",
    input: { kind: "nrz", timing: T_SYM, backup: true, relay: true },
    light: { kind: "pixel", current: rgb(16 * mA) },
    quiescent: 1e-6,
    logic: { pin: "VDD", vih: { ratio: 0.55 } },
    supply: { min: 3.3, max: 5.3, abs: 7 },
    source: "Worldsemi WS2813B-V6 V1.1 (2026-08): +3.3…+5.3 V, never above 7 V, VIH 0.55 VCC, 16 mA; BO \"bypass signal output\" (modelled as a copy of the input)",
  },
  {
    ...WS2813_BASE,
    part: "WS2813C-2121",
    label: "WS2813C-2121 · 2121, 20 mA",
    input: { kind: "nrz", timing: { ...T_SYM, t0h: [220 * ns, 380 * ns] }, backup: true, relay: true },
    light: { kind: "pixel", current: rgb(20 * mA) },
    quiescent: 0.6 * mA,
    source: "Worldsemi WS2813C-2121 V1.0 (2020-05-01): VDD 3.7–5.3 V, 20 mA, first BI to GND",
  },
  {
    ...WORLDSEMI,
    part: "WS2816B",
    label: "WS2816B · 16-bit, 5050",
    input: { kind: "nrz", timing: T_WS2816, backup: true, relay: true },
    fields: GRB16,
    // "Iout (OUTR+OUTG+OUTB) 20 mA": read as each channel's current.
    light: { kind: "pixel", current: rgb(20 * mA) },
    pwmHz: 10e3,
    quiescent: 0.8 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.7 } },
    supply: { min: 3.3, max: 5.5, abs: 5.5 },
    inputMax: 6.2,
    source: "Worldsemi WS2816B V1.0 (2022-04-26): 3.3–5.5 V, VIH 0.7 VDD, 48-bit GRB, 10 kHz PWM, Iout 20 mA (per channel assumed), internal 4-bit gamma not modelled (levels linear)",
  },
  {
    ...WORLDSEMI,
    part: "WS2816C-2121",
    label: "WS2816C-2121 · 16-bit, 2121",
    input: { kind: "nrz", timing: T_WS2816, backup: true, relay: true },
    fields: GRB16,
    light: { kind: "pixel", current: rgb(10.5 * mA) },
    pwmHz: 10e3,
    quiescent: 0.8 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.7 } },
    supply: { min: 3.7, max: 5.5, abs: 5.5 },
    inputMax: 6.2,
    source: "Worldsemi WS2816C-2121 V1.1 (2020-05-19): 3.7–5.5 V, 10.5 mA, 48-bit GRB, 10 kHz",
  },
  {
    ...WORLDSEMI,
    part: "WS2916A",
    label: "WS2916A · 16-bit + current gain",
    input: { kind: "nrz", timing: T_WS2916A, backup: true, relay: true },
    // The gain word's place in the frame is not drawn for the RGB parts; the frame header of
    // WS2913 and WS2916A-RGBW is modelled.
    header: [gain("G"), gain("R"), gain("B"), check(1)],
    fields: GRB16,
    light: { kind: "pixel", current: rgb(16.5 * mA) },
    pwmHz: 10e3,
    quiescent: 0.6 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.55 } },
    supply: { min: 3.7, max: 5.3, abs: 5.3 },
    inputMax: 6,
    source: "Worldsemi WS2916A V1.0 (2026-08-22): 3.7–5.3 V, VIH 0.55 VDD, 16-bit gain word IG-IR-IB + check, 48-bit GRB, gain 0x1F = 16.5 mA; the gain word's place in the frame is not drawn (a header, as on WS2913, is modelled)",
  },
  {
    ...WORLDSEMI,
    part: "WS2916B",
    label: "WS2916B · 16-bit + current gain, 9 mA",
    input: { kind: "nrz", timing: T_WS2816, backup: true, relay: true },
    header: [gain("G"), gain("R"), gain("B"), check(1)],
    fields: GRB16,
    light: { kind: "pixel", current: rgb(9 * mA) },
    pwmHz: 4e3,
    quiescent: 1e-6,
    logic: { pin: "VDD", vih: { ratio: 0.55 } },
    supply: { min: 3.3, max: 5.5, abs: 5.5 },
    inputMax: 6.2,
    source: "Worldsemi WS2916B V1.0 (2026-08-22): 3.3–5.5 V, VIH 0.55 VDD, gain 0x1F = 9 mA (the table's steps are not even; modelled linear), Iq ≤ 1 µA; header placement as WS2916A",
  },
]

// --- constant-current drivers ----------------------------------------------------------------------

/** WS2811-pinout drivers: OUTR, OUTG, OUTB, GND, DO, DIN, pin 7 (NC or SET), VDD. */
export const DRIVERS_3CH: ChipSpec[] = [
  {
    ...DRIVER,
    part: "WS2811",
    label: "WS2811 (V1.1, 2017) · pin 7 NC",
    input: { kind: "nrz", timing: T_2811 },
    fields: GRB,
    light: sink3(16.5 * mA, 12),
    pwmHz: 2e3,
    quiescent: 0.6 * mA,
    supply: { min: 3.5, max: 5.3, abs: 5.3 },
    clamp: 5.2,
    inputMax: 5.8,
    source:
      "Worldsemi WS2811 V1.1 (2017-10-09): VDD +3.5…+5.3 V with a built-in regulator (series resistor up to 24 V; clamp voltage not given, modelled at 5.2 V), outputs 16.5 mA, 12 V withstand, > 2 kHz; prints R-G-B in the table and GRB in the note (GRB modelled); quiescent current not given (0.6 mA)",
  },
  {
    ...DRIVER,
    part: "WS2811-2011",
    label: "WS2811 (2011) · SET: high = 400 kHz",
    input: { kind: "nrz", timing: T_WS2811_2011_FAST },
    strap: { pin: "SET", high: { kind: "timing", timing: T_WS2811_2011_SLOW } },
    fields: RGB,
    light: sink3(18.5 * mA, 12),
    pwmHz: 2e3,
    quiescent: 0.6 * mA,
    supply: { min: 4.5, max: 5.5, abs: 6 },
    clamp: 5.5,
    inputMax: 6,
    source: "Worldsemi WS2811 (2011): pin 7 SET to VDD = 400 kHz, open = 800 kHz, RGB order, IOL 18.5 mA, 12 V outputs, absolute maximum printed \"+6.0~+7.0\" V",
  },
  {
    ...DRIVER,
    part: "WS2913",
    label: "WS2913 · 16-bit + current gain, SET to VDD",
    input: { kind: "nrz", timing: T_SYM },
    strap: { pin: "SET", low: { kind: "unmodelled", what: "SET open selects the 8-bit mode, whose frame the datasheet does not describe: modelled as the 16-bit mode" } },
    header: [gain("R"), gain("G"), gain("B"), check(1)],
    fields: [level("R", 16), level("G", 16), level("B", 16)],
    light: sink3(17.36 * mA, 35),
    pwmHz: 2e3,
    quiescent: 0.8 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.55 } },
    supply: { min: 3.5, max: 5.7, abs: 5.7 },
    clamp: 5.5,
    inputMax: 24,
    source: "Worldsemi WS2913 V1.5/V1.6 (2025): 16-bit gain header IR-IG-IB + check forwarded by every chip, 48-bit RGB, gain 0x1F = 17.36 mA, 35 V outputs, DIN/DOUT 24 V, VIH 0.55 VDD",
  },
]

/** WS2818B / WS2818F: OUTR, OUTG, OUTB, DO, DIN1, GND, DIN2, VDD. */
export const DRIVERS_3CH_BACKUP: ChipSpec[] = [
  {
    ...DRIVER,
    part: "WS2818B",
    label: "WS2818B (V2.3) · 4 kHz, VIH 0.5 VDD",
    input: { kind: "nrz", timing: T_SYM, backup: true },
    fields: RGB,
    light: sink3(16 * mA, 20),
    pwmHz: 4e3,
    quiescent: 0.35 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.5 } },
    supply: { min: 3.5, max: 5.8, abs: 5.8 },
    clamp: 5.6,
    inputMax: 9,
    source: "Worldsemi WS2818B V2.3 (2026-07-14): VDD +3.5…+5.8 V, built-in regulator, IOL 16 mA, 20 V outputs, DIN 9 V, VIH 0.5 VDD, RGB order, 4 kHz; DIN2 to the previous chip's DIN1",
  },
  {
    ...DRIVER,
    part: "WS2818F",
    label: "WS2818F · FSOP8, 2 kHz",
    input: { kind: "nrz", timing: T_SYM, backup: true },
    fields: RGB,
    light: sink3(16.5 * mA, 20),
    pwmHz: 2e3,
    quiescent: 0.35 * mA,
    supply: { min: 3.5, max: 5.5, abs: 5.5 },
    clamp: 5.3,
    inputMax: 9,
    source: "Worldsemi WS2818F V1.0 (2022-10-27): VDD 3.5–5.5 V, IOL 16.5 mA, VIH 0.7 VDD, 2 kHz",
  },
]

/** WS2814A / WS2814F: OUTR, OUTG, OUTB, GND, DOUT, DIN, VDD, OUTW. */
export const DRIVERS_4CH: ChipSpec[] = [
  {
    ...DRIVER,
    part: "WS2814A",
    label: "WS2814A (V2.1) · RGBW, 40 V outputs",
    input: { kind: "nrz", timing: { ...T_SYM, reset: 350 * us } },
    fields: WRGB,
    light: sink4(15.5 * mA, 40),
    pwmHz: 2e3,
    quiescent: 0.6 * mA,
    supply: { min: 3.7, max: 5.8, abs: 5.8 },
    clamp: 5.6,
    inputMax: 9,
    source: "Worldsemi WS2814A V2.1 (2026-07-14): VDD +3.7…+5.8 V, 40 V outputs, IOL 15.5 mA, 32-bit WRGB, RES > 350 µs (the diagram still says 280)",
  },
  {
    ...DRIVER,
    part: "WS2814F",
    label: "WS2814F (V2.1) · RGBW, FSOP8",
    input: { kind: "nrz", timing: T_SYM },
    fields: WRGB,
    light: sink4(15.5 * mA, 40),
    pwmHz: 2e3,
    quiescent: 0.6 * mA,
    supply: { min: 3.7, max: 5.8, abs: 5.8 },
    clamp: 5.6,
    inputMax: 9,
    source: "Worldsemi WS2814F V2.1 (2026-07-14): VDD 3.7–5.8 V, 40 V outputs, IOL 15.5 mA, 32-bit WRGB, RES > 280 µs",
  },
]

/** WS2814B: OUTR, OUTG, OUTB, OUTW, GND, DOUT, GND, DIN, BIN, VDD. */
export const DRIVERS_4CH_BACKUP: ChipSpec[] = [
  {
    ...DRIVER,
    part: "WS2814B",
    label: "WS2814B · RGBW, DIN + BIN",
    input: { kind: "nrz", timing: T_SYM, backup: true },
    fields: WRGB,
    light: sink4(15.5 * mA, 20),
    pwmHz: 4e3,
    quiescent: 0.4 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.55 } },
    supply: { min: 3.7, max: 5.8, abs: 5.8 },
    clamp: 5.6,
    inputMax: 9,
    source: "Worldsemi WS2814B V1.3 (2026-07-14): VDD +3.7…+5.8 V, 20 V outputs, DIN/DOUT 9 V, IOL 15.5 mA, VIH 0.55 VDD, 32-bit WRGB, 4 kHz",
  },
]

/** Five outputs, DIN + BIN: OUTR, OUTG, OUTB, OUTW1, OUTW2, GND, DOUT, BIN, DIN, VDD. */
export const DRIVERS_5CH_BACKUP: ChipSpec[] = [
  {
    ...DRIVER,
    part: "WS2805",
    label: "WS2805 · RGB + two whites",
    input: { kind: "nrz", timing: T_SYM, backup: true },
    fields: RGBW1W2,
    light: sink5({ R: 16 * mA, G: 16 * mA, B: 16 * mA, W: 16 * mA, W2: 16 * mA }, 20, "W2"),
    pwmHz: 4e3,
    quiescent: 0.6 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.55 } },
    supply: { min: 3.5, max: 5.8, abs: 5.8 },
    clamp: 5.6,
    // "DIN/DOUT port withstands 24V" (the table's VDD+0.7 is the operating range)
    inputMax: 24,
    source: "Worldsemi WS2805 V1.6 (2026-07-14): VDD +3.5…+5.8 V, 20 V outputs, IOL 16 mA, VIH 0.55 VDD, 40-bit RGBW1W2, 4 kHz, DIN/DOUT withstand 24 V",
  },
  {
    ...DRIVER,
    part: "WS2914",
    label: "WS2914 · 16-bit RGBW + gain, W on OUTW1 and OUTW2",
    input: { kind: "nrz", timing: T_SYM, backup: true },
    header: [gain("R"), gain("G"), gain("B"), gain("W"), check(12)],
    fields: [level("R", 16), level("G", 16), level("B", 16), level("W", 16)],
    // W1 60 mA; OUTW2 carries the same channel (paralleled for 120 mA).
    light: sink5({ R: 30 * mA, G: 30 * mA, B: 30 * mA, W: 60 * mA }, 35, "W"),
    pwmHz: 2e3,
    quiescent: 0.3 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.6 } },
    supply: { min: 3.5, max: 5.7, abs: 5.7 },
    clamp: 5.5,
    inputMax: 24,
    source: "Worldsemi WS2914 V1.0 (2024-08-01): 32-bit gain header (R-G-B-W1 × 5 bits + 12 check bits) forwarded by every chip, 64-bit RGBW words, IOL R/G/B 30 mA, W 60 mA per pin, 35 V outputs, VIH 0.6 VDD; FDIN (BIN) behaviour not described (the WS2813 rule is modelled)",
  },
]

/** WS2915: OUTR, OUTG, OUTB, OUTW1, OUTW2, GND, DO, SET, DIN, VDD. */
export const DRIVERS_5CH: ChipSpec[] = [
  {
    ...DRIVER,
    part: "WS2915",
    label: "WS2915 · 16-bit RGBW1W2 + gain",
    input: { kind: "nrz", timing: T_SYM },
    header: [gain("R"), gain("G"), gain("B"), gain("W"), gain("W2"), check(1)],
    fields: [level("R", 16), level("G", 16), level("B", 16), level("W", 16), level("W2", 16)],
    light: sink5({ R: 30 * mA, G: 30 * mA, B: 30 * mA, W: 60 * mA, W2: 60 * mA }, 35, "W2"),
    pwmHz: 4e3,
    quiescent: 0.3 * mA,
    logic: { pin: "VDD", vih: { ratio: 0.55 } },
    supply: { min: 3.5, max: 5.7, abs: 5.7 },
    clamp: 5.5,
    inputMax: 24,
    source:
      "Worldsemi WS2915 V1.1 (2024-12-12): 26-bit gain header forwarded by every chip, 80-bit RGBW1W2 words, R/G/B 30 mA, W1/W2 60 mA, 35 V outputs; SET grounded (4-channel mode) is not described and not modelled",
  },
]

/** WS2801: CKI, SDI, POL, RFB, GFB, BFB, GND, BOUT, GOUT, ROUT, NC, SDO, CKO, VCC. */
export const CLOCKED: ChipSpec[] = [
  {
    part: "WS2801",
    label: "WS2801 · clock + data, current set by RFB/GFB/BFB",
    input: { kind: "clocked", timing: { maxHz: 25e6, latch: 500 * us } },
    fields: RGB,
    fullScale: 256,
    light: {
      kind: "sink",
      outputs: [
        { pin: "ROUT", channel: "R", feedback: "RFB" },
        { pin: "GOUT", channel: "G", feedback: "GFB" },
        { pin: "BOUT", channel: "B", feedback: "BFB" },
      ],
      current: rgb(20 * mA),
      withstand: 6,
      feedback: { volts: 0.6, max: 50 * mA },
    },
    strap: { pin: "POL", pullUp: 30e3, low: { kind: "invert" } },
    pwmHz: 2.5e3,
    quiescent: 1 * mA,
    logic: { pin: "VCC", vih: { ratio: 0.8 } },
    supply: { min: 3.3, max: 5.5, abs: 6 },
    inputMax: 6.3,
    delay: 8 * ns,
    source:
      "Worldsemi WS2801S V2.0 (2020) and WS2801 V0.3 (2008): VCC 3.3–5.5 V (abs 6 V), VIH 0.8 VCC, data on CKI rising edges up to 25 MHz, relay after 24 edges, latch after CKI low > 500 µs, I = 0.6 V / RxFB (≤ 50 mA), 0xFF = 255/256, 2.5 kHz PWM; POL low inverts the outputs (the 2008 sheet; the 2020 sheet contradicts itself)",
  },
]

export const ALL_PARTS: ChipSpec[] = [
  ...PIXELS_4PIN,
  ...PIXELS_4PIN_12V,
  ...PIXELS_6PIN,
  ...PIXELS_BACKUP,
  ...PIXELS_BACKUP_12V,
  ...PIXELS_WS2815,
  ...PIXELS_RELAY,
  ...DRIVERS_3CH,
  ...DRIVERS_3CH_BACKUP,
  ...DRIVERS_4CH,
  ...DRIVERS_4CH_BACKUP,
  ...DRIVERS_5CH_BACKUP,
  ...DRIVERS_5CH,
  ...CLOCKED,
]

const byPart = new Map(ALL_PARTS.map((s) => [s.part, s]))

export const specByPart = (part: string) => byPart.get(part)
