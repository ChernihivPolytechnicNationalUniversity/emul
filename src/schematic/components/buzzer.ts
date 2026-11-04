import {
  ACTIVE_IDLE_OHMS,
  BUZZER_KINDS,
  BUZZER_PRESETS,
  PIEZO_DEPOLES_AT_RATED_MAX,
  REVERSE_BREAKDOWN_VOLTS,
  REVERSE_JUNCTION_WATTS,
  activePowerRating,
  buzzerDefId,
  buzzerOfDef,
  buzzerSpec,
  coilPowerRating,
  isActive,
  piezoMotionalBranch,
  reversePathOhms,
  type BuzzerPreset,
} from "@/sim/buzzer"
import { formatSI } from "@/sim/units"
import { BuzzerIcon } from "../icons"
import type { ComponentDef, ModelElement, PinDef, PropField } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"

const HEATING_TAU = 3


const PINS: PinDef[] = [
  { id: "1", label: "", x: 1, y: 5, side: "bottom", labelAt: "left", kind: "digital", note: "+: the coil's start, or an active part's supply" },
  { id: "2", label: "", x: 3, y: 5, side: "bottom", labelAt: "right", kind: "digital", note: "−" },
]

const quantity = (n: number, unit: string) => formatSI(n, unit, 3).replace(/(\.\d*?)0+(?= )/, "$1").replace(/\. /, " ")

const fromPart = (n: number | undefined, unit: string) => (n === undefined ? "" : `${quantity(n, unit)} from the part`)

function kindFields(preset: BuzzerPreset): PropField[] {
  const resonance: PropField = { key: "resonance", label: "Resonance", type: "quantity", unit: "Hz", placeholder: fromPart(preset.frequency, "Hz") }
  switch (preset.kind) {
    case "magnetic":
      return [
        { key: "coil", label: "Coil resistance", type: "quantity", unit: "Ω", placeholder: fromPart(preset.coil, "Ω") },
        { key: "inductance", label: "Coil inductance", type: "quantity", unit: "H", placeholder: fromPart(preset.inductance, "H") },
        resonance,
      ]
    case "piezo":
      return [{ key: "capacitance", label: "Capacitance", type: "quantity", unit: "F", placeholder: fromPart(preset.capacitance, "F") }, resonance]
    case "magnetic-active":
    case "piezo-active":
      return [
        { key: "current", label: "Current at the rated voltage", type: "quantity", unit: "A", placeholder: fromPart(preset.ratedCurrent, "A") },
        { key: "tone", label: "Tone", type: "quantity", unit: "Hz", placeholder: fromPart(preset.frequency, "Hz") },
      ]
  }
}

const levelUnit = (preset: BuzzerPreset) => (preset.ratedWeighting === "A" ? "dB(A)" : "dB")

const fieldsOf = (preset: BuzzerPreset): PropField[] => [
  ...kindFields(preset),
  { key: "rated", label: "Rated voltage", type: "quantity", unit: "V", placeholder: fromPart(preset.ratedVolts, "V") },
  { key: "spl", label: `Sound level at 10 cm, ${levelUnit(preset)}`, type: "text", placeholder: `${preset.ratedSpl} from the part` },
]

function modelOf(preset: BuzzerPreset): ModelElement[] {
  const spec = (p: Record<string, string>) => buzzerSpec(preset, p)
  switch (preset.kind) {
    case "magnetic":
      return [
        {
          kind: "R",
          a: "1",
          b: "$m",
          value: (p) => spec(p).coil ?? 42,
          label: "Coil",
          limits: { power: (p) => coilPowerRating(spec(p)), tau: HEATING_TAU, fail: "open" },
        },
        { kind: "L", a: "$m", b: "2", value: (p) => spec(p).inductance ?? 1e-3, label: "Coil inductance", hidden: true },
      ]
    case "piezo":
      return [
        { kind: "C", a: "1", b: "2", value: (p) => piezoMotionalBranch(spec(p)).c0, label: "Piezo disc", limits: { voltage: PIEZO_DEPOLES_AT_RATED_MAX * preset.maxVolts, fail: "open" } },
        { kind: "R", a: "1", b: "$p1", value: (p) => piezoMotionalBranch(spec(p)).rm, hidden: true },
        { kind: "L", a: "$p1", b: "$p2", value: (p) => piezoMotionalBranch(spec(p)).lm, hidden: true },
        { kind: "C", a: "$p2", b: "2", value: (p) => piezoMotionalBranch(spec(p)).cm, hidden: true },
      ]
    case "magnetic-active":
    case "piezo-active":
      return [
        {
          kind: "R",
          a: "1",
          b: "2",
          value: ACTIVE_IDLE_OHMS,
          live: "$osc",
          label: "Oscillator",
          limits: { power: (p) => activePowerRating(spec(p)), tau: HEATING_TAU, fail: "open" },
        },
        {
          kind: "D",
          anode: "$b",
          cathode: "2",
          zener: REVERSE_BREAKDOWN_VOLTS,
          label: "Reverse breakdown",
          hidden: true,
          limits: { power: REVERSE_JUNCTION_WATTS, tau: HEATING_TAU, fail: "open" },
        },
        { kind: "D", anode: "$b", cathode: "$c", hidden: true },
        { kind: "R", a: "$c", b: "1", value: (p) => reversePathOhms(spec(p)), hidden: true },
      ]
  }
}

function describe(preset: BuzzerPreset): string {
  const { minVolts, maxVolts, ratedVolts, ratedSpl } = preset
  const resonance = quantity(preset.frequency, "Hz")
  const ratedAt = quantity(preset.ratedAtFrequency ?? preset.frequency, "Hz")
  const level = `${ratedSpl} ${levelUnit(preset)} at 10 cm`
  const supply = `${minVolts}–${maxVolts} V`
  switch (preset.kind) {
    case "magnetic":
      return `Passive magnetic buzzer: ${quantity(preset.coil ?? 0, "Ω")} coil, ${supply} (rated ${ratedVolts} V), resonance ${resonance}, ${level} on its rated square at ${ratedAt}. It sounds the square wave it is driven with, loudest at its resonance; on DC it only clicks. Select it while running for the tone and its level.`
    case "piezo":
      return `Passive piezo sounder: ${quantity(preset.capacitance ?? 0, "F")}, resonance ${resonance}, ${level} on a ${ratedVolts} Vp-p square at ${ratedAt}, ${maxVolts} V at most. Light enough for an MCU pin; silent on DC. Select it while running for the tone and its level.`
    case "magnetic-active":
    case "piezo-active":
      return `Active ${preset.kind === "magnetic-active" ? "magnetic buzzer" : "piezo buzzer"}: its own oscillator beeps ${resonance} on ${supply} DC, ${quantity(preset.ratedCurrent ?? 0, "A")} and ${level} at its rated ${ratedVolts} V, louder and drawing more as the supply rises. + on pin 1; it cannot play another pitch. Select it while running for its level.`
  }
}

function buzzerDef(preset: BuzzerPreset): ComponentDef {
  return {
    id: buzzerDefId(preset),
    name: preset.name,
    description: describe(preset),
    category: "sound",
    keywords: ["buzzer", "beeper", "sounder", "zummer", "transducer", preset.badge, ...BUZZER_KINDS[preset.kind].split(", "), ...(isActive(preset.kind) ? [] : ["speaker"])],
    icon: BuzzerIcon,
    prefix: "BZ",
    width: 4,
    height: 5,
    fields: fieldsOf(preset),
    pins: PINS,
    parts: [{ type: "sound", id: "SOUND", label: "", x: 2, y: 2.45 }],
    body: [
      { type: "path", d: "M0.55 2.45 H3.45 M0.7 2.45 A1.3 1.3 0 0 0 3.3 2.45 M1 3.28 V5 M3 3.28 V5" },
      { type: "text", x: 0.45, y: 4.15, text: "+", size: 0.45 },
      { type: "text", x: 2, y: 0.3, text: "{ref}", size: 0.35 },
      { type: "text", x: 2, y: 1.15, text: preset.badge, size: 0.24, muted: true },
    ],
    model: modelOf(preset),
    info: { Datasheet: `${preset.maker} ${preset.name}` },
  }
}

export const buzzers: ComponentDef[] = BUZZER_PRESETS.map(buzzerDef)

export const isBuzzerDef = (defId: string) => buzzerOfDef(defId) !== undefined

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = buzzers

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "buzzer-cem-1203-42": {
    maker: "CUI Devices / Same Sky",
    docs: [DOCS["samesky-cem-1203-42"]],
    specs: [
      { label: "Rated drive", value: "3.5 Vo-p square, 2048 Hz, ½ duty", cite: { page: 1, at: "Specifications" } },
      { label: "Operating voltage", value: "3.0–5.0 Vo-p", cite: { page: 1, at: "Specifications" } },
      { label: "Current", value: "35 mA max at rated drive", cite: { page: 1, at: "Specifications" } },
      { label: "Sound level", value: "85 dB(A) min, 95 typ at 10 cm", cite: { page: 1, at: "Specifications" } },
      { label: "Coil resistance", value: "42 Ω (36–48)", cite: { page: 1, at: "Specifications" } },
    ],
    modelled: [
      { what: "Coil resistance and inductance in series: 1 V DC reads the sheet's coil resistance", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "On the sheet's rated 3.5 Vo-p 2048 Hz square through a low-side switch: 95 dB(A) at 10 cm and 35 mA mean", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Frequency response follows the published curve within 3 dB rms, the second mode included", cite: { page: 2, at: "Frequency response curve" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Quieter than rated under its operating range, and warns under and over it", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "On DC only a click at each edge, with a warning; DC at the top of its range overheats the coil and opens it, at the bottom it only warms", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "A harmonic of a lower drive landing on the resonance sounds loud: 2080/3 Hz beats its neighbours", test: "tests/sim/buzzer.test.ts" },
      { what: "Its coil's kick goes through a flyback diode when one is fitted", test: "tests/sim/buzzer.test.ts" },
      { what: "The tone and its level go to the computer's speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Tolerances: the coil resistance and sound level are the typical, not a spread over parts", cite: { page: 1, at: "Specifications" } },
      { what: "Sound level is at 10 cm in free air: no distance, direction or enclosure effect" },
      { what: "Polarity: reversed it sounds the same" },
      { what: "Temperature: the operating range and level drift with it", cite: { page: 1, at: "Specifications" } },
      { what: "Outside magnetic fields and the field its magnet makes" },
    ],
  },
  "buzzer-at-1224-twt-5v-2": {
    maker: "PUI Audio",
    docs: [DOCS["pui-at-1224-twt-5v-2-r"]],
    specs: [
      { label: "Rated drive", value: "5 V0-p square, 2400 Hz", cite: { page: 1, at: "Specifications" } },
      { label: "Operating voltage", value: "3–7 V0-p", cite: { page: 1, at: "Specifications" } },
      { label: "Current", value: "40 mA max at rated voltage", cite: { page: 1, at: "Specifications" } },
      { label: "Coil resistance", value: "47 ± 7 Ω", cite: { page: 1, at: "Specifications" } },
      { label: "Resonance", value: "2400 ± 500 Hz", cite: { page: 1, at: "Specifications" } },
      { label: "Sound level", value: "87 dB(A) min at 10 cm", cite: { page: 1, at: "Specifications" } },
    ],
    modelled: [
      { what: "Coil resistance and inductance in series: 1 V DC reads the sheet's coil resistance", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "On its rated 5 V0-p 2400 Hz square: 95.3 dB at 10 cm, the typical curve's value, and 40 mA mean", cite: { page: 2, at: "Typical Frequency Response" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Frequency response follows the published curve within 3 dB rms, the second mode included", cite: { page: 2, at: "Typical Frequency Response" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Quieter than rated under its operating range, and warns under and over it", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "On DC only a click at each edge, with a warning; DC at the top of its range overheats the coil and opens it, at the bottom it only warms", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Loudest inside the sheet's 2400 ± 500 Hz resonance", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "The tone and its level go to the computer's speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Tolerances: the coil resistance and sound level are the typical, not a spread over parts", cite: { page: 1, at: "Specifications" } },
      { what: "Sound level is at 10 cm in free air: no distance, direction or enclosure effect" },
      { what: "Polarity: reversed it sounds the same" },
      { what: "Temperature: the operating range and level drift with it", cite: { page: 1, at: "Specifications" } },
      { what: "Outside magnetic fields and the field its magnet makes" },
    ],
  },
  "buzzer-cmt-0904-83t": {
    maker: "CUI Devices / Same Sky",
    docs: [DOCS["samesky-cmt-0904-83t"]],
    specs: [
      { label: "Rated drive", value: "3.0 Vo-p square, 2730 Hz, ½ duty", cite: { page: 1, at: "Specifications" } },
      { label: "Operating voltage", value: "2.0–5.0 Vo-p", cite: { page: 1, at: "Specifications" } },
      { label: "Current", value: "90 mA max at rated drive", cite: { page: 1, at: "Specifications" } },
      { label: "Sound level", value: "83 dB min at 10 cm", cite: { page: 1, at: "Specifications" } },
      { label: "Coil resistance", value: "15 Ω (13–17)", cite: { page: 1, at: "Specifications" } },
    ],
    modelled: [
      { what: "Coil resistance and inductance in series: 1 V DC reads the sheet's coil resistance", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "On its rated 3 Vo-p 2730 Hz square through a low-side switch: 89.1 dB at 10 cm, the curve's value, and 90 mA mean", cite: { page: 3, at: "Frequency response curve" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Frequency response follows the published curve within 3 dB rms, the second mode included", cite: { page: 3, at: "Frequency response curve" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Quieter than rated under its operating range, and warns under and over it", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "On DC only a click at each edge, with a warning; DC at the top of its range overheats the coil and opens it, at the bottom it only warms", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "The tone and its level go to the computer's speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Tolerances: the coil resistance and sound level are the typical, not a spread over parts", cite: { page: 1, at: "Specifications" } },
      { what: "Sound level is at 10 cm in free air: no distance, direction or enclosure effect" },
      { what: "Polarity: reversed it sounds the same" },
      { what: "Temperature: the operating range and level drift with it", cite: { page: 1, at: "Specifications" } },
      { what: "Outside magnetic fields and the field its magnet makes" },
    ],
  },
  "buzzer-tmb12a05": {
    maker: "Huaneng",
    docs: [DOCS["huaneng-tmb12a05"]],
    specs: [
      { label: "Rated voltage", value: "5 V DC", cite: { page: 2, at: "Specification table" } },
      { label: "Operating voltage", value: "3–7 V DC", cite: { page: 2, at: "Specification table" } },
      { label: "Current", value: "30 mA max", cite: { page: 2, at: "Specification table" } },
      { label: "Sound level", value: "95 dB min at 10 cm", cite: { page: 2, at: "Specification table" } },
      { label: "Tone", value: "2400 ± 300 Hz", cite: { page: 2, at: "Specification table" } },
    ],
    modelled: [
      { what: "On 5 V DC reads the mean of the ten-sample test report: 96.6 dB, 23.0 mA, 2407 Hz", cite: { page: 6, at: "Test Report" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Louder and drawing more as the supply rises, along the dB–V and mA–V curves", cite: { page: 3, at: "Frequency response (dB-V, mA-V)" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Sounds across its operating range without a warning; warns just under and over it, and lasts 10 s at the top", cite: { page: 2, at: "Specification table" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Polarity: + on pin 1; reversed it is silent and says so", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Silent below the voltage its oscillator starts at (0.8 of the operating minimum)", test: "tests/sim/buzzer.test.ts" },
      { what: "Reversed past about 7.7 V its transistor's emitter–base junction breaks down, conducts and heats", test: "tests/sim/buzzer.test.ts" },
      { what: "Switched like tone() it only gates its own tone: the pitch does not follow, and it warns", test: "tests/sim/buzzer.test.ts" },
      { what: "Over its rating it heats and burns open: 12 V kills it in seconds", cite: { page: 5, at: "Precautions" }, test: "tests/sim/buzzer.test.ts" },
      { what: "At full sound within 50 ms of its 5 V being applied", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "The tone and its level go to the computer's speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Tolerance of the tone: one typical frequency, not the spread over parts", cite: { page: 2, at: "Specification table" } },
      { what: "Temperature: the operating range and drift with it", cite: { page: 2, at: "Specification table" } },
      { what: "Sound level is at 10 cm in free air: no distance, direction or enclosure effect" },
      { what: "Supply ripple and interference on its oscillator" },
    ],
  },
  "buzzer-sdc1610m5-01": {
    maker: "TDK",
    docs: [DOCS["tdk-sdc-catalogue"]],
    specs: [
      { label: "Rated voltage", value: "5 V DC", cite: { page: 3, at: "Specifications" } },
      { label: "Operating voltage", value: "4–8 V DC", cite: { page: 3, at: "Specifications" } },
      { label: "Current", value: "30 mA max average", cite: { page: 3, at: "Specifications" } },
      { label: "Sound level", value: "85 dB(A) min at 10 cm", cite: { page: 3, at: "Specifications" } },
      { label: "Tone", value: "2400 Hz ±20 %", cite: { page: 3, at: "Specifications" } },
      { label: "Temperature", value: "−10 to +70 °C", cite: { page: 3, at: "Specifications" } },
    ],
    modelled: [
      { what: "On 5 V DC: 90.2 dB(A) at 10 cm, 19.5 mA and 2426 Hz, the catalogue curves' values", cite: { page: 3, at: "Input voltage vs. characteristics" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Sound pressure, tone and current follow the catalogue's input-voltage curves from 4 to 7 V, the tone falling as the voltage rises", cite: { page: 3, at: "Input voltage vs. characteristics" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Sounds across its operating range without a warning; warns just under and over it, and lasts 10 s at the top", cite: { page: 3, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Polarity: + on pin 1; reversed it is silent and says so", cite: { page: 6, at: "Reminders" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Silent below the voltage its oscillator starts at (0.8 of the operating minimum)" },
      { what: "Reversed past about 7.7 V its transistor's emitter–base junction breaks down, conducts and heats" },
      { what: "Switched like tone() it only gates its own tone: the pitch does not follow, and it warns" },
      { what: "Over its operating voltage it heats and burns open", cite: { page: 5, at: "Reminders" } },
      { what: "The tone and its level go to the computer's speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Tolerance of the tone: one typical frequency, not the spread over parts", cite: { page: 3, at: "Specifications" } },
      { what: "Temperature: the operating range and drift with it", cite: { page: 3, at: "Specifications" } },
      { what: "Sound level is at 10 cm in free air: no distance, direction or enclosure effect" },
      { what: "Supply ripple and electromagnetic interference on its oscillator", cite: { page: 5, at: "Reminders" } },
      { what: "Mounting changes the sound pressure", cite: { page: 6, at: "Reminders" } },
    ],
  },
  "buzzer-cmi-9650c-030": {
    maker: "CUI Devices / Same Sky",
    docs: [DOCS["samesky-cmi-9650c-030"]],
    specs: [
      { label: "Rated voltage", value: "3.0 V DC", cite: { page: 1, at: "Specifications" } },
      { label: "Operating voltage", value: "2.0–5.0 V DC", cite: { page: 1, at: "Specifications" } },
      { label: "Current", value: "15 mA max at rated voltage", cite: { page: 1, at: "Specifications" } },
      { label: "Sound level", value: "78 dB(A) min at 10 cm", cite: { page: 1, at: "Specifications" } },
      { label: "Tone", value: "2700–3000 Hz", cite: { page: 1, at: "Specifications" } },
    ],
    modelled: [
      { what: "On 3 V DC: 85.25 dB(A) at 10 cm and 18.3 mA, the performance curves' values (over the table's 15 mA max)", cite: { page: 2, at: "Performance curves" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Sound level and current follow the voltage curves from 2 to 4.5 V", cite: { page: 2, at: "Performance curves" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Sounds across its operating range without a warning; warns just under and over it, and lasts 10 s at the top", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Polarity: + on pin 1; reversed it is silent and says so", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Silent below the voltage its oscillator starts at (0.8 of the operating minimum)" },
      { what: "Reversed past about 7.7 V its transistor's emitter–base junction breaks down, conducts and heats" },
      { what: "Switched like tone() it only gates its own tone: the pitch does not follow, and it warns" },
      { what: "The tone and its level go to the computer's speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Tolerance of the tone: one typical frequency, not the spread over parts", cite: { page: 1, at: "Specifications" } },
      { what: "Temperature: the operating range and drift with it", cite: { page: 1, at: "Specifications" } },
      { what: "Sound level is at 10 cm in free air: no distance, direction or enclosure effect" },
      { what: "The table's 15 mA maximum: the model draws the curve's 18.3 mA at 3 V", cite: { page: 1, at: "Specifications" } },
    ],
  },
  "buzzer-pkm13epyh4000-a0": {
    maker: "Murata",
    docs: [DOCS["murata-pkm13epyh4000-a0"], DOCS["murata-p37e"]],
    specs: [
      { label: "Sound level", value: "70 dB min at 10 cm, 3 Vp-p 4 kHz square", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" } },
      { label: "Input voltage", value: "30 Vp-p max", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" } },
      { label: "Capacitance", value: "5.5 nF ±30 % at 1 kHz", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" } },
      { label: "Temperature", value: "−40 to +85 °C", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" } },
    ],
    modelled: [
      { what: "A static capacitance with a motional branch at its resonance: 5.5 nF at the pins measured at 1 kHz", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "On a 3 Vp-p 4 kHz square: 78 dB at 10 cm (the 2022 data sheet's typical), above the 70 dB minimum", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Swept 1–10 kHz on a 3 Vp-p square it follows Murata's 2022 response curve, 3rd-harmonic bumps included", test: "tests/sim/buzzer.test.ts" },
      { what: "Up to ±15 V (30 Vp-p) it plays without harm or warning; over it warns; at twice it the ceramic depolarises and opens", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "DC across it: no sound, and a warning that a lasting bias degrades it", cite: { doc: "murata-p37e", page: 17, at: "Notice" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "On a transistor drive it needs a resistor across it to discharge each cycle; without one it hardly sounds", cite: { doc: "murata-p37e", page: 17, at: "Notice" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Loses about 3 dB of fundamental at 25 % or 75 % duty", test: "tests/sim/buzzer.test.ts" },
      { what: "The tone and its level go to the computer's speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Capacitance tolerance (±30 %): the typical only", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" } },
      { what: "Silver migration under DC: it warns, but the part does not degrade", cite: { doc: "murata-p37e", page: 17, at: "Notice" } },
      { what: "Voltage it generates when struck or dropped (the surge the notice warns of)", cite: { doc: "murata-p37e", page: 17, at: "Notice" } },
      { what: "Temperature: the operating range and drift with it", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" } },
      { what: "Sound level is at 10 cm in free air: no distance, direction or enclosure effect" },
    ],
  },
  "buzzer-pkm17epp-2002-b0": {
    maker: "Murata",
    docs: [DOCS["murata-p37e"]],
    specs: [
      { label: "Sound level", value: "70 dB min at 10 cm, 3 Vo-p 2 kHz square", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" } },
      { label: "Input voltage", value: "25 Vo-p max, with polarity", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" } },
      { label: "Capacitance", value: "34 nF ±30 % at 120 Hz", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" } },
      { label: "Temperature", value: "−20 to +70 °C", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" } },
    ],
    modelled: [
      { what: "A static capacitance with a motional branch at its resonance: 34 nF at the pins measured at 120 Hz", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "On a 3 Vo-p 2 kHz square: 82 dB at 10 cm, above the 70 dB minimum", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "On a 1 Vrms sine sweep it peaks where the catalogue's response curve does, by as much", cite: { page: 12, at: "Freq. Response (Sine Wave 1Vrms, 10cm)" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Up to 25 Vo-p it plays without harm or warning; over it warns; at twice it the ceramic depolarises and opens", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "DC across it: no sound, and a warning that a lasting bias degrades it", cite: { page: 14, at: "Notice" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "On a transistor drive it needs a resistor across it to discharge each cycle; without one it hardly sounds", cite: { page: 14, at: "Notice" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "The tone and its level go to the computer's speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Capacitance tolerance (±30 %): the typical only", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" } },
      { what: "Silver migration under DC: it warns, but the part does not degrade", cite: { page: 14, at: "Notice" } },
      { what: "Voltage it generates when struck or dropped (the surge the notice warns of)", cite: { page: 14, at: "Notice" } },
      { what: "Temperature: the operating range and drift with it", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" } },
      { what: "Sound level is at 10 cm in free air: no distance, direction or enclosure effect" },
      { what: "Polarity: the marked terminal should go to the DC hot side; reversed it plays the same", cite: { page: 10, at: "Piezoelectric Sounders External Drive Pin Type, PKM17EPP-2002-B0 drawing" } },
    ],
  },
  "buzzer-pkb24spch3601-b0": {
    maker: "Murata",
    docs: [DOCS["murata-p37e"]],
    specs: [
      { label: "Supply", value: "3.0–15.0 V DC", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" } },
      { label: "Sound level", value: "90 dB min at 10 cm, 12 V DC", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" } },
      { label: "Tone", value: "3.6 ± 0.5 kHz at 12 V", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" } },
      { label: "Current", value: "16 mA max at 12 V", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" } },
      { label: "Temperature", value: "−20 to +70 °C", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" } },
    ],
    modelled: [
      { what: "On 12 V DC: 98.15 dB at 10 cm, 12.4 mA and 3.6 kHz, the curves' values", cite: { page: 24, at: "Voltage-Sound Pressure Level/Voltage-Consumption Current" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Sound level and current follow the voltage curves from 5 to 15 V at a steady 3.6 kHz", cite: { page: 24, at: "Voltage-Sound Pressure Level/Voltage-Consumption Current" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Sounds across its operating range without a warning; warns just under and over it, and lasts 10 s at the top", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Polarity: + on pin 1; reversed it is silent and says so", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Silent below the voltage its oscillator starts at (0.8 of the operating minimum)" },
      { what: "Reversed past about 7.7 V its transistor's emitter–base junction breaks down, conducts and heats" },
      { what: "Switched like tone() it only gates its own tone: the pitch does not follow, and it warns" },
      { what: "The tone and its level go to the computer's speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Tolerance of the tone: one typical frequency, not the spread over parts", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" } },
      { what: "Temperature: the operating range and drift with it", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" } },
      { what: "Sound level is at 10 cm in free air: no distance, direction or enclosure effect" },
      { what: "A resistor in series with the supply makes it oscillate irregularly; the model only sees a lower voltage", cite: { page: 25, at: "Notice" } },
      { what: "Covering the hole or an obstacle within 15 mm upsets the oscillation", cite: { page: 25, at: "Notice (Handling)" } },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
