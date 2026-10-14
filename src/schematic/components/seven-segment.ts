/**
 * Kingbright 0.56" seven-segment displays: the single-digit SA56-11 (common anode) and
 * SC56-11 (common cathode), and the four-digit CA56-12 / CC56-12, each colour its own sheet.
 * Every segment is one LED die with the sheet's I–V curve (fitted to the digitised curve,
 * `tests/data/kingbright-56-seven-segment/`), its DC current derated with the ambient as the
 * sheet's derating curve draws it, its peak current (1/10 duty, 0.1 ms) as the surge limit, its
 * dissipation and its 5 V reverse rating. A segment that burns goes open and the rest of the
 * display keeps working, as on the bench.
 */
import { SevenSegmentIcon } from "../icons"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef } from "../types"
import { chromaticityColor } from "./rgb-led"

type Knot = readonly [celsius: number, milliamps: number]

/** One sheet: what it prints and what was fitted to its curves. */
export type SegmentSheet = {
  part: string
  spec: string
  rev: string
  date: string
  colour: string
  material: string
  /** Dominant wavelength at 10 mA, nm, and its point on the CIE 1931 spectral locus (CIE 018:2019, Table 6). */
  dominantNm: number
  chromaticity: readonly [x: number, y: number]
  /** VF at 10 mA, typical and maximum, as printed. */
  vf: readonly [typ: number, max: number]
  /** The engine's diode fitted to the digitised I–V curve (0.5–20 mA). */
  fit: { junctionVoltsAt10mA: number; emission: number; seriesOhms: number }
  /** Absolute maximum ratings at 25 °C: DC and peak current (A), dissipation (W), reverse voltage. */
  ratings: { current: number; peakCurrent: number; power: number; reverseVolts: number }
  /** Permissible forward current against ambient, digitised from the derating curve. */
  derating: readonly Knot[]
}

const RED_617: Pick<SegmentSheet, "colour" | "material" | "dominantNm" | "chromaticity"> = { colour: "High Efficiency Red", material: "GaAsP/GaP", dominantNm: 617, chromaticity: [0.68497, 0.31486] }
const RED_640: Pick<SegmentSheet, "colour" | "material" | "dominantNm" | "chromaticity"> = { colour: "Super Bright Red", material: "GaAlAs", dominantNm: 640, chromaticity: [0.71903, 0.28094] }
const GREEN_568: Pick<SegmentSheet, "colour" | "material" | "dominantNm" | "chromaticity"> = { colour: "Green", material: "GaP", dominantNm: 568, chromaticity: [0.42999, 0.56865] }
const YELLOW_590: Pick<SegmentSheet, "colour" | "material" | "dominantNm" | "chromaticity"> = { colour: "Super Bright Yellow", material: "AlGaInP", dominantNm: 590, chromaticity: [0.57515, 0.42423] }
const GREEN_570: Pick<SegmentSheet, "colour" | "material" | "dominantNm" | "chromaticity"> = { colour: "Green", material: "AlGaInP", dominantNm: 570, chromaticity: [0.44406, 0.55472] }

const EWA_RATINGS = { current: 0.03, peakCurrent: 0.16, power: 0.075, reverseVolts: 5 }
const SRWA_RATINGS = { current: 0.03, peakCurrent: 0.155, power: 0.075, reverseVolts: 5 }
const GWA_RATINGS = { current: 0.025, peakCurrent: 0.14, power: 0.0625, reverseVolts: 5 }
const SYKWA_RATINGS = { current: 0.03, peakCurrent: 0.175, power: 0.075, reverseVolts: 5 }
const CGKWA_RATINGS = { current: 0.03, peakCurrent: 0.15, power: 0.075, reverseVolts: 5 }

const EWA_DERATING: Knot[] = [[-40.1, 29.99], [25.2, 29.99], [84.8, 5.13]]
const SRWA_DERATING: Knot[] = [[-40.0, 29.99], [25.3, 29.99], [84.9, 5.13]]
const GWA_DERATING: Knot[] = [[-40.1, 24.89], [25.2, 24.89], [84.8, 5.13]]
const AlGaInP_DERATING: Knot[] = [[-40.0, 29.99], [0.3, 29.99], [25.3, 29.99], [50.2, 20.11], [75.3, 9.97], [84.9, 6.48]]

export const SEGMENT_SHEETS: Record<string, SegmentSheet> = {
  "SA56-11EWA": { part: "SA56-11EWA", spec: "DSAP8372", rev: "V.1A", date: "03/09/2020", ...RED_617, vf: [1.9, 2.3], fit: { junctionVoltsAt10mA: 1.8197, emission: 3.04, seriesOhms: 7.085 }, ratings: EWA_RATINGS, derating: EWA_DERATING },
  "SC56-11EWA": { part: "SC56-11EWA", spec: "DSAP6671", rev: "V.1A", date: "03/04/2019", ...RED_617, vf: [1.9, 2.3], fit: { junctionVoltsAt10mA: 1.8253, emission: 3.102, seriesOhms: 6.647 }, ratings: EWA_RATINGS, derating: [[-40.2, 29.98], [25.1, 29.98], [84.8, 5.15]] },
  "SA56-11SRWA": { part: "SA56-11SRWA", spec: "DSAP8375", rev: "V.1A", date: "03/10/2020", ...RED_640, vf: [1.8, 2.3], fit: { junctionVoltsAt10mA: 1.7887, emission: 2.212, seriesOhms: 1.15 }, ratings: SRWA_RATINGS, derating: SRWA_DERATING },
  "SC56-11SRWA": { part: "SC56-11SRWA", spec: "DSAP4629", rev: "V.1A", date: "04/23/2018", ...RED_640, vf: [1.8, 2.3], fit: { junctionVoltsAt10mA: 1.7854, emission: 2.127, seriesOhms: 1.44 }, ratings: SRWA_RATINGS, derating: [[-40.2, 29.95], [25.1, 29.95], [84.8, 5.06]] },
  "SA56-11GWA": { part: "SA56-11GWA", spec: "DSAP8374", rev: "V.1A", date: "03/10/2020", ...GREEN_568, vf: [2.0, 2.4], fit: { junctionVoltsAt10mA: 1.8739, emission: 0.601, seriesOhms: 15.767 }, ratings: GWA_RATINGS, derating: GWA_DERATING },
  "SC56-11GWA": { part: "SC56-11GWA", spec: "DSAP6672", rev: "V.1A", date: "03/04/2019", ...GREEN_568, vf: [2.0, 2.4], fit: { junctionVoltsAt10mA: 1.8734, emission: 0.59, seriesOhms: 15.82 }, ratings: GWA_RATINGS, derating: [[-40.2, 24.92], [25.1, 24.92], [84.8, 5.15]] },
  "SA56-11SYKWA": { part: "SA56-11SYKWA", spec: "DSAM8434", rev: "V.3A", date: "03/10/2020", ...YELLOW_590, vf: [1.95, 2.35], fit: { junctionVoltsAt10mA: 1.9084, emission: 1.101, seriesOhms: 4.103 }, ratings: SYKWA_RATINGS, derating: [[-40.0, 29.9], [0.3, 29.9], [25.3, 29.9], [50.2, 20.02], [75.3, 9.87], [84.9, 6.44]] },
  "SC56-11SYKWA": { part: "SC56-11SYKWA", spec: "DSAM8450", rev: "V.3A", date: "03/12/2020", ...YELLOW_590, vf: [1.95, 2.35], fit: { junctionVoltsAt10mA: 1.9082, emission: 1.107, seriesOhms: 4.099 }, ratings: SYKWA_RATINGS, derating: [[-40.1, 29.99], [0.1, 29.99], [25.2, 29.99], [50.1, 20.11], [75.0, 9.97], [84.8, 6.48]] },
  "SA56-11CGKWA": { part: "SA56-11CGKWA", spec: "DSAM8559", rev: "V.3A", date: "03/09/2020", ...GREEN_570, vf: [2.0, 2.45], fit: { junctionVoltsAt10mA: 1.9488, emission: 1.991, seriesOhms: 4.935 }, ratings: CGKWA_RATINGS, derating: AlGaInP_DERATING },
  "SC56-11CGKWA": { part: "SC56-11CGKWA", spec: "DSAM8448", rev: "V.3A", date: "03/12/2020", ...GREEN_570, vf: [2.0, 2.45], fit: { junctionVoltsAt10mA: 1.9488, emission: 1.991, seriesOhms: 4.934 }, ratings: CGKWA_RATINGS, derating: AlGaInP_DERATING },
  "CA56-12EWA": { part: "CA56-12EWA", spec: "DSAP8253", rev: "V.1A", date: "02/26/2020", ...RED_617, vf: [1.9, 2.3], fit: { junctionVoltsAt10mA: 1.8197, emission: 3.04, seriesOhms: 7.085 }, ratings: EWA_RATINGS, derating: EWA_DERATING },
  "CC56-12EWA": { part: "CC56-12EWA", spec: "DSAP8261", rev: "V.1A", date: "02/26/2020", ...RED_617, vf: [1.9, 2.3], fit: { junctionVoltsAt10mA: 1.8197, emission: 3.04, seriesOhms: 7.085 }, ratings: EWA_RATINGS, derating: EWA_DERATING },
  "CA56-12SRWA": { part: "CA56-12SRWA", spec: "DSAP8254", rev: "V.1A", date: "02/26/2020", ...RED_640, vf: [1.8, 2.3], fit: { junctionVoltsAt10mA: 1.7887, emission: 2.212, seriesOhms: 1.148 }, ratings: SRWA_RATINGS, derating: SRWA_DERATING },
  "CC56-12SRWA": { part: "CC56-12SRWA", spec: "DSAP4626", rev: "V.2A", date: "02/26/2020", ...RED_640, vf: [1.8, 2.3], fit: { junctionVoltsAt10mA: 1.7887, emission: 2.212, seriesOhms: 1.148 }, ratings: SRWA_RATINGS, derating: SRWA_DERATING },
}

export const AMBIENT = { min: -40, max: 85, reference: 25 }

/** Permissible DC current per segment at an ambient, by the sheet's derating curve (amps). */
export function deratedCurrent(sheet: SegmentSheet, celsius: number): number {
  const k = sheet.derating
  if (celsius <= k[0][0]) return k[0][1] / 1000
  for (let i = 1; i < k.length; i++) {
    const [t0, i0] = k[i - 1]
    const [t1, i1] = k[i]
    if (celsius <= t1) return (i0 + ((i1 - i0) * (celsius - t0)) / (t1 - t0)) / 1000
  }
  return k[k.length - 1][1] / 1000
}

const SEGMENTS = ["a", "b", "c", "d", "e", "f", "g", "DP"] as const
type Segment = (typeof SEGMENTS)[number]

/** Lead of each segment's anode (CA) or cathode (CC) side, as the sheets' internal circuit diagrams number them. */
const SINGLE_LEADS: Record<Segment, number> = { a: 7, b: 6, c: 4, d: 2, e: 1, f: 9, g: 10, DP: 5 }
const SINGLE_COMMONS = [3, 8]
const QUAD_LEADS: Record<Segment, number> = { a: 11, b: 7, c: 4, d: 2, e: 1, f: 10, g: 5, DP: 3 }
/** Digit commons, Dig1–Dig4. */
const QUAD_COMMONS = [12, 9, 8, 6]

// --- the glyph: segments drawn as the sheet's package drawing has them, leaning 8° ---------------

const LEAN = Math.tan((8 * Math.PI) / 180)
const DIGIT_W = 2.6
const DIGIT_H = 4.6
const BAR = 0.42
const GAP = 0.06

const f2 = (v: number) => Math.round(v * 1000) / 1000

/** Outline of one bar from (x1, y1) to (x2, y2) (horizontal or vertical), pointed ends, leaned about the digit's middle. */
function bar(ox: number, oy: number, x1: number, y1: number, x2: number, y2: number): string {
  const h = BAR / 2
  const horizontal = y1 === y2
  const pts: [number, number][] = horizontal
    ? [[x1 + GAP, y1], [x1 + GAP + h, y1 - h], [x2 - GAP - h, y1 - h], [x2 - GAP, y1], [x2 - GAP - h, y1 + h], [x1 + GAP + h, y1 + h]]
    : [[x1, y1 + GAP], [x1 + h, y1 + GAP + h], [x1 + h, y2 - GAP - h], [x1, y2 - GAP], [x1 - h, y2 - GAP - h], [x1 - h, y1 + GAP + h]]
  return "M" + pts.map(([x, y]) => `${f2(ox + x + (DIGIT_H / 2 - y) * LEAN)} ${f2(oy + y)}`).join(" L") + " Z"
}

function circle(cx: number, cy: number, r: number) {
  return `M${f2(cx - r)} ${f2(cy)} A${r} ${r} 0 1 0 ${f2(cx + r)} ${f2(cy)} A${r} ${r} 0 1 0 ${f2(cx - r)} ${f2(cy)} Z`
}

/** The eight lit areas of one digit whose top-left is (ox, oy). */
function digitOutlines(ox: number, oy: number): Record<Segment, string> {
  const w = DIGIT_W
  const h = DIGIT_H
  return {
    a: bar(ox, oy, 0, 0, w, 0),
    b: bar(ox, oy, w, 0, w, h / 2),
    c: bar(ox, oy, w, h / 2, w, h),
    d: bar(ox, oy, 0, h, w, h),
    e: bar(ox, oy, 0, h / 2, 0, h),
    f: bar(ox, oy, 0, 0, 0, h / 2),
    g: bar(ox, oy, 0, h / 2, w, h / 2),
    DP: circle(ox + w + 0.55, oy + h, 0.26),
  }
}

// --- the components ---------------------------------------------------------------------------

type Polarity = "anode" | "cathode"

const sheetOf = (props: Record<string, string>, fallback: string) => SEGMENT_SHEETS[props.value] ?? SEGMENT_SHEETS[fallback]

const ambientOf = (props: Record<string, string>) => {
  const t = Number(props.temp)
  return Number.isFinite(t) ? t : AMBIENT.reference
}

function segmentElement(polarity: Polarity, segmentNode: string, common: string, part: string, fallback: string): Element {
  const pick = <T>(f: (s: SegmentSheet) => T) => (props: Record<string, string>) => f(sheetOf(props, fallback)) as unknown as number
  return {
    kind: "D",
    anode: polarity === "anode" ? common : segmentNode,
    cathode: polarity === "anode" ? segmentNode : common,
    vf: pick((s) => s.fit.junctionVoltsAt10mA),
    emission: pick((s) => s.fit.emission),
    rs: pick((s) => s.fit.seriesOhms),
    part,
    limits: {
      current: (props) => deratedCurrent(sheetOf(props, fallback), ambientOf(props)),
      surge: pick((s) => s.ratings.peakCurrent),
      power: pick((s) => s.ratings.power),
      voltage: pick((s) => s.ratings.reverseVolts),
      fail: "open",
      fatal: false,
    },
  }
}

const segmentPartId = (digit: number | null, s: Segment) => (digit === null ? s : `${s}${digit + 1}`)

function display({ id, name, polarity, digits, parts }: { id: string; name: string; polarity: Polarity; digits: 1 | 4; parts: string[] }): ComponentDef {
  const fallback = parts[0]
  const leads = digits === 1 ? SINGLE_LEADS : QUAD_LEADS
  const pitch = DIGIT_W + 1.6
  const glyphX = 2.2
  const glyphY = 2
  const width = digits === 1 ? 7 : Math.ceil(glyphX + pitch * 4 + 0.6)
  const height = 9
  const segPins: PinDef[] = SEGMENTS.map((s, k) => ({
    id: s,
    label: s,
    x: 0,
    y: k + 1,
    side: "left",
    labelAt: "right",
    kind: "digital",
    connector: digits === 1 ? "DIP-10" : "DIP-12",
    connectorPin: leads[s],
    note: `Segment ${s}: the ${polarity === "anode" ? "cathode" : "anode"} of its LED in every digit`,
  }))
  const commonPins: PinDef[] =
    digits === 1
      ? SINGLE_COMMONS.map((lead, i) => ({ id: `COM${lead}`, label: "COM", x: i === 0 ? 4 : 4, y: i === 0 ? 0 : height, side: i === 0 ? "top" : "bottom", labelAt: i === 0 ? "bottom" : "top", kind: polarity === "anode" ? "power" : "gnd", connector: "DIP-10", connectorPin: lead, note: `Common ${polarity}; leads 3 and 8 are joined inside` }) as PinDef)
      : QUAD_COMMONS.map((lead, d) => ({ id: `D${d + 1}`, label: `D${d + 1}`, x: Math.round(glyphX + pitch * d + DIGIT_W / 2), y: 0, side: "top", labelAt: "bottom", kind: polarity === "anode" ? "power" : "gnd", connector: "DIP-12", connectorPin: lead, note: `Digit ${d + 1} common ${polarity}` }) as PinDef)
  const pins = [...segPins, ...commonPins]
  const digitList = digits === 1 ? [null] : [0, 1, 2, 3]
  const partsList: PartDef[] = []
  const model: Element[] = []
  digitList.forEach((d, k) => {
    const outlines = digitOutlines(glyphX + pitch * k, glyphY)
    const common = d === null ? "COM3" : `D${d + 1}`
    for (const s of SEGMENTS) {
      const partId = segmentPartId(d, s)
      partsList.push({ type: "led", id: partId, label: d === null ? s : `${s} (digit ${d + 1})`, x: 0, y: 0, color: "{segmentColor}", style: "segment", d: outlines[s] })
      model.push(segmentElement(polarity, s, common, partId, fallback))
    }
  })
  if (digits === 1) model.push({ kind: "SHORT", nodes: ["COM3", "COM8"] })
  const leadsText = digits === 1 ? "a–g, DP on 7 6 4 2 1 9 10 5, common on 3 and 8" : "a–g, DP on 11 7 4 2 1 10 5 3, digit commons 12 9 8 6"
  return {
    id,
    name,
    description: `Kingbright 0.56" ${digits === 1 ? "single" : "four"}-digit display, common ${polarity} (${leadsText}). Each segment follows its sheet's I–V curve and burns open on its own past its DC rating (derated with the ambient), its peak rating (1/10 duty, 0.1 ms) or 5 V reversed.`,
    category: "Displays",
    keywords: ["7-segment", "seven segment", "7seg", "LED display", "Kingbright", `common ${polarity}`, ...parts],
    icon: SevenSegmentIcon,
    prefix: "DS",
    width,
    height,
    defaults: { value: fallback, temp: String(AMBIENT.reference) },
    derive: (props) => ({ segmentColor: chromaticityColor(sheetOf(props, fallback).chromaticity) }),
    fields: [
      { key: "value", label: "Part", type: "select", options: parts.map((p) => ({ value: p, label: `${p} · ${SEGMENT_SHEETS[p].colour}` })) },
      { key: "temp", label: "Ambient temperature", type: "range", min: AMBIENT.min, max: AMBIENT.max, step: 1, unit: "°C" },
    ],
    pins,
    body: [
      // "Standard: gray face, white segment" (every sheet's features list).
      { type: "rect", x: 1.2, y: 0.6, w: width - 1.6, h: height - 1.2, rx: 0.15, fill: "zone" } as BodyShape,
      { type: "text", x: width - 0.6, y: height - 0.95, text: "{value}", size: 0.28, anchor: "end", muted: true },
      { type: "text", x: width - 0.6, y: 0.25, text: "{ref}", size: 0.32, muted: true, anchor: "end" },
    ],
    parts: partsList,
    model,
    info: { Source: "Kingbright sheets as listed in tests/data/kingbright-56-seven-segment/README.md" },
  }
}

const SINGLE_CA = ["SA56-11EWA", "SA56-11SRWA", "SA56-11GWA", "SA56-11SYKWA", "SA56-11CGKWA"]
const SINGLE_CC = ["SC56-11EWA", "SC56-11SRWA", "SC56-11GWA", "SC56-11SYKWA", "SC56-11CGKWA"]

export const sevenSegmentComponents: ComponentDef[] = [
  display({ id: "seven-segment-ca", name: "7-segment display, common anode", polarity: "anode", digits: 1, parts: SINGLE_CA }),
  display({ id: "seven-segment-cc", name: "7-segment display, common cathode", polarity: "cathode", digits: 1, parts: SINGLE_CC }),
  display({ id: "seven-segment-4-ca", name: "4-digit 7-segment display, common anode", polarity: "anode", digits: 4, parts: ["CA56-12EWA", "CA56-12SRWA"] }),
  display({ id: "seven-segment-4-cc", name: "4-digit 7-segment display, common cathode", polarity: "cathode", digits: 4, parts: ["CC56-12EWA", "CC56-12SRWA"] }),
]
