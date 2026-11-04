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
  switch (preset.kind) {
    case "magnetic":
      return "Passive magnetic buzzer"
    case "piezo":
      return "Passive piezo sounder"
    case "magnetic-active":
      return "Active magnetic buzzer"
    case "piezo-active":
      return "Active piezo buzzer"
  }
}

function buzzerDef(preset: BuzzerPreset): ComponentDef {
  return {
    id: buzzerDefId(preset),
    name: preset.name,
    description: describe(preset),
    category: "sound",
    keywords: ["buzzer", "beeper", "sounder", "zummer", "transducer", preset.maker, preset.badge, ...BUZZER_KINDS[preset.kind].split(", "), ...(isActive(preset.kind) ? [] : ["speaker"])],
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
    // info Datasheet (in the datasheet record): `${preset.maker} ${preset.name}`
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
      { what: "Coil as series RL", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Rated 3.5 Vo-p, 2048 Hz", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "95 dB(A) at 10 cm", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "35 mA mean at rating", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Response curve within 3 dB", cite: { page: 2, at: "Frequency response curve" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Warns outside operating range", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "DC only clicks, with warning", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Top-of-range DC opens the coil", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Harmonics on resonance sound loud", test: "tests/sim/buzzer.test.ts" },
      { what: "Coil kick through flyback diode", test: "tests/sim/buzzer.test.ts" },
      { what: "Tone and level reach speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Typical values, not part spread", cite: { page: 1, at: "Specifications" } },
      { what: "Free-air level at 10 cm" },
      { what: "No distance, direction or enclosure" },
      { what: "Polarity ignored, sounds the same" },
      { what: "No temperature drift", cite: { page: 1, at: "Specifications" } },
      { what: "Outside and own magnetic fields" },
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
      { what: "Coil as series RL", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Rated 5 V0-p, 2400 Hz", cite: { page: 2, at: "Typical Frequency Response" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "95.3 dB at 10 cm", cite: { page: 2, at: "Typical Frequency Response" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "40 mA mean at rating", cite: { page: 2, at: "Typical Frequency Response" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Response curve within 3 dB", cite: { page: 2, at: "Typical Frequency Response" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Warns outside operating range", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "DC only clicks, with warning", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Top-of-range DC opens the coil", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Loudest at 2400±500 Hz", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Tone and level reach speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Typical values, not part spread", cite: { page: 1, at: "Specifications" } },
      { what: "Free-air level at 10 cm" },
      { what: "No distance, direction or enclosure" },
      { what: "Polarity ignored, sounds the same" },
      { what: "No temperature drift", cite: { page: 1, at: "Specifications" } },
      { what: "Outside and own magnetic fields" },
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
      { what: "Coil as series RL", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Rated 3 Vo-p, 2730 Hz", cite: { page: 3, at: "Frequency response curve" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "89.1 dB at 10 cm", cite: { page: 3, at: "Frequency response curve" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "90 mA mean at rating", cite: { page: 3, at: "Frequency response curve" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Response curve within 3 dB", cite: { page: 3, at: "Frequency response curve" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Warns outside operating range", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "DC only clicks, with warning", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Top-of-range DC opens the coil", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Tone and level reach speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Typical values, not part spread", cite: { page: 1, at: "Specifications" } },
      { what: "Free-air level at 10 cm" },
      { what: "No distance, direction or enclosure" },
      { what: "Polarity ignored, sounds the same" },
      { what: "No temperature drift", cite: { page: 1, at: "Specifications" } },
      { what: "Outside and own magnetic fields" },
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
      { what: "96.6 dB, 23.0 mA", cite: { page: 6, at: "Test Report" }, test: "tests/sim/buzzer.test.ts" },
      { what: "2407 Hz at 5 V", cite: { page: 6, at: "Test Report" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Follows dB–V and mA–V curves", cite: { page: 3, at: "Frequency response (dB-V, mA-V)" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Warns just outside its range", cite: { page: 2, at: "Specification table" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Lasts 10 s at top", cite: { page: 2, at: "Specification table" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Reversed polarity is silent, warns", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Silent below 0.8 of minimum", test: "tests/sim/buzzer.test.ts" },
      { what: "Reverse breakdown past ~7.7 V", test: "tests/sim/buzzer.test.ts" },
      { what: "tone() gates it, pitch fixed", test: "tests/sim/buzzer.test.ts" },
      { what: "Burns open over its rating", cite: { page: 5, at: "Precautions" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Full sound within 50 ms", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Tone and level reach speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "One typical tone, no spread", cite: { page: 2, at: "Specification table" } },
      { what: "No temperature drift", cite: { page: 2, at: "Specification table" } },
      { what: "Free-air level at 10 cm" },
      { what: "No distance, direction or enclosure" },
      { what: "Supply ripple or interference" },
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
      { what: "Curve values at 5 V", cite: { page: 3, at: "Input voltage vs. characteristics" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "90.2 dB(A) at 10 cm", cite: { page: 3, at: "Input voltage vs. characteristics" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "19.5 mA, 2426 Hz", cite: { page: 3, at: "Input voltage vs. characteristics" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Follows input-voltage curves, 4–7 V", cite: { page: 3, at: "Input voltage vs. characteristics" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Tone falls as voltage rises", cite: { page: 3, at: "Input voltage vs. characteristics" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Warns just outside its range", cite: { page: 3, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Lasts 10 s at top", cite: { page: 3, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Reversed polarity is silent, warns", cite: { page: 6, at: "Reminders" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Silent below 0.8 of minimum" },
      { what: "Reverse breakdown past ~7.7 V" },
      { what: "tone() gates it, pitch fixed" },
      { what: "Burns open over operating voltage", cite: { page: 5, at: "Reminders" } },
      { what: "Tone and level reach speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "One typical tone, no spread", cite: { page: 3, at: "Specifications" } },
      { what: "No temperature drift", cite: { page: 3, at: "Specifications" } },
      { what: "Free-air level at 10 cm" },
      { what: "No distance, direction or enclosure" },
      { what: "Supply ripple or EMI", cite: { page: 5, at: "Reminders" } },
      { what: "Mounting effect on sound pressure", cite: { page: 6, at: "Reminders" } },
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
      { what: "Curve values at 3 V", cite: { page: 2, at: "Performance curves" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "85.25 dB(A) at 10 cm", cite: { page: 2, at: "Performance curves" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "18.3 mA, over table's max", cite: { page: 2, at: "Performance curves" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Follows voltage curves, 2–4.5 V", cite: { page: 2, at: "Performance curves" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Warns just outside its range", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Lasts 10 s at top", cite: { page: 1, at: "Specifications" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Reversed polarity is silent, warns", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Silent below 0.8 of minimum" },
      { what: "Reverse breakdown past ~7.7 V" },
      { what: "tone() gates it, pitch fixed" },
      { what: "Tone and level reach speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "One typical tone, no spread", cite: { page: 1, at: "Specifications" } },
      { what: "No temperature drift", cite: { page: 1, at: "Specifications" } },
      { what: "Free-air level at 10 cm" },
      { what: "No distance, direction or enclosure" },
      { what: "Table's 15 mA max ignored", cite: { page: 1, at: "Specifications" } },
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
      { what: "Static C plus motional branch", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "5.5 nF at 1 kHz", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "3 Vp-p, 4 kHz square", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" }, test: "tests/sim/buzzer.test.ts" },
      { what: "78 dB at 10 cm", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Follows Murata's 1–10 kHz curve", test: "tests/sim/buzzer.test.ts" },
      { what: "3rd-harmonic bumps included", test: "tests/sim/buzzer.test.ts" },
      { what: "Warns above ±15 V", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Depolarises and opens at twice", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "DC gives no sound", cite: { doc: "murata-p37e", page: 17, at: "Notice" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Warns DC bias degrades it", cite: { doc: "murata-p37e", page: 17, at: "Notice" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Transistor drive needs shunt resistor", cite: { doc: "murata-p37e", page: 17, at: "Notice" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "25/75% duty loses ~3 dB", test: "tests/sim/buzzer.test.ts" },
      { what: "Tone and level reach speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Typical capacitance, not ±30 %", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" } },
      { what: "Silver migration warns, no damage", cite: { doc: "murata-p37e", page: 17, at: "Notice" } },
      { what: "Surge when struck or dropped", cite: { doc: "murata-p37e", page: 17, at: "Notice" } },
      { what: "No temperature drift", cite: { doc: "murata-p37e", page: 15, at: "Piezoelectric Sounders External Drive Pin Type Taping" } },
      { what: "Free-air level at 10 cm" },
      { what: "No distance, direction or enclosure" },
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
      { what: "Static C plus motional branch", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "34 nF at 120 Hz", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "3 Vo-p, 2 kHz square", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "82 dB at 10 cm", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Sweep matches catalogue peaks", cite: { page: 12, at: "Freq. Response (Sine Wave 1Vrms, 10cm)" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Warns above 25 Vo-p", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Depolarises and opens at twice", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "DC gives no sound", cite: { page: 14, at: "Notice" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Warns DC bias degrades it", cite: { page: 14, at: "Notice" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Transistor drive needs shunt resistor", cite: { page: 14, at: "Notice" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Tone and level reach speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "Typical capacitance, not ±30 %", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" } },
      { what: "Silver migration warns, no damage", cite: { page: 14, at: "Notice" } },
      { what: "Surge when struck or dropped", cite: { page: 14, at: "Notice" } },
      { what: "No temperature drift", cite: { page: 11, at: "Piezoelectric Sounders External Drive Pin Type" } },
      { what: "Free-air level at 10 cm" },
      { what: "No distance, direction or enclosure" },
      { what: "Marked-terminal polarity ignored", cite: { page: 10, at: "Piezoelectric Sounders External Drive Pin Type, PKM17EPP-2002-B0 drawing" } },
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
      { what: "Curve values at 12 V", cite: { page: 24, at: "Voltage-Sound Pressure Level/Voltage-Consumption Current" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "98.15 dB at 10 cm", cite: { page: 24, at: "Voltage-Sound Pressure Level/Voltage-Consumption Current" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "12.4 mA, 3.6 kHz", cite: { page: 24, at: "Voltage-Sound Pressure Level/Voltage-Consumption Current" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Follows voltage curves, 5–15 V", cite: { page: 24, at: "Voltage-Sound Pressure Level/Voltage-Consumption Current" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Steady 3.6 kHz tone", cite: { page: 24, at: "Voltage-Sound Pressure Level/Voltage-Consumption Current" }, test: "tests/sim/buzzer.test.ts" },
      { what: "Warns just outside its range", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Lasts 10 s at top", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" }, test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Reversed polarity is silent, warns", test: "tests/sim/buzzer-datasheets.test.ts" },
      { what: "Silent below 0.8 of minimum" },
      { what: "Reverse breakdown past ~7.7 V" },
      { what: "tone() gates it, pitch fixed" },
      { what: "Tone and level reach speaker", test: "tests/sim/sound-stream.test.ts" },
    ],
    notModelled: [
      { what: "One typical tone, no spread", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" } },
      { what: "No temperature drift", cite: { page: 24, at: "Piezoelectric Buzzers Pin Type" } },
      { what: "Free-air level at 10 cm" },
      { what: "No distance, direction or enclosure" },
      { what: "Irregular oscillation via series resistor", cite: { page: 25, at: "Notice" } },
      { what: "Covered sound hole", cite: { page: 25, at: "Notice (Handling)" } },
      { what: "Obstacles within 15 mm", cite: { page: 25, at: "Notice (Handling)" } },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
