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
  piezoMotionalBranch,
  reversePathOhms,
  type BuzzerPreset,
} from "@/sim/buzzer"
import { formatSI } from "@/sim/units"
import { BuzzerIcon } from "../icons"
import type { ComponentDef, ModelElement, PinDef, PropField } from "../types"

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
    category: "Sound",
    keywords: ["buzzer", "beeper", "sounder", "zummer", "transducer", preset.badge, ...BUZZER_KINDS[preset.kind].split(", ")],
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
