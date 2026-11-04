/**
 * Clock sources for a bare MCU: a quartz crystal across OSC_IN/OSC_OUT (or OSC32_IN/OUT), and
 * a canned oscillator module that feeds a ready-made clock into OSC_IN for bypass mode. Neither
 * is simulated as a waveform — the analog engine steps at 20 µs and a crystal runs at 8 MHz —
 * so the symbols are markers the simulation loop reads: the emulated RCC reports HSE/LSE ready
 * (after the crystal's start-up time) only when the right part sits on the right pins, and
 * the clock tree runs at the frequency written on it. The load capacitors a real crystal
 * needs are drawn or not as the student likes; they change nothing here.
 */
import { CrystalIcon, OscillatorIcon } from "../icons"
import { crystalStartup, RESONATOR_STARTUP } from "../clock-startup"
import type { ComponentDef } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"


export const crystal: ComponentDef = {
  id: "crystal",
  name: "Crystal",
  description: "Quartz crystal for MCU clocks",
  keywords: ["quartz", "XTAL", "HSE", "LSE", "32.768 kHz", "watch crystal"],
  category: "ics",
  icon: CrystalIcon,
  prefix: "ZQ",
  defaults: { value: "8 MHz" },
  fields: [{ key: "value", label: "Frequency", type: "quantity", unit: "Hz" }],
  width: 4,
  height: 2,
  parts: [],
  pins: [
    { id: "1", label: "", x: 0, y: 1, side: "left", labelAt: "top", kind: "digital" },
    { id: "2", label: "", x: 4, y: 1, side: "right", labelAt: "top", kind: "digital" },
  ],
  body: [
    { type: "path", d: "M0 1 H1.3 M2.7 1 H4 M1.3 0.4 V1.6 M2.7 0.4 V1.6" },
    { type: "rect", x: 1.6, y: 0.3, w: 0.8, h: 1.4, fill: "none" },
    { type: "text", x: 2, y: 0.05, text: "{ref}", size: 0.35 },
    { type: "text", x: 2, y: 2.05, text: "{value}", size: 0.3, muted: true },
  ],
  // An open circuit at DC: nothing for the analog engine to solve.
  model: [],
  datasheet: {
    basis: "generic",
    none: "A generic crystal: its frequency is set in the inspector, not taken from one product's datasheet.",
    // Start-up times from the MCU's datasheet (DS9405 Tables 33 and 35), not the crystal's.
    sources: [DOCS["st-ds9405"]],
    modelled: [{ what: "HSE/LSE ready after start-up time" }, { what: "2 ms for MHz crystals" }, { what: "2 s for 32.768 kHz" }, { what: "Clock runs at marked frequency" }],
    notModelled: [{ what: "Oscillation waveform" }, { what: "Analog engine steps 20 µs" }, { what: "Load caps, drive level, tolerance" }],
  },
}

/**
 * Murata CSTCE16M0V53-R0 (product page): 16.000 MHz, ±0.50 % initial tolerance, ±0.3 % over
 * −20…80 °C, ±0.2 % ageing, ESR 40 Ω, the load capacitors built in (15 pF) on the middle pin.
 */
export const RESONATOR_TOLERANCE = { initial: 0.5, temperature: 0.3, ageing: 0.2 }


export const resonator: ComponentDef = {
  id: "resonator",
  name: "Ceramic resonator",
  keywords: ["resonator", "ceramic", "XTAL", "Murata", "CSTCE16M0V53", "16 MHz"],
  description: "Three-pin ceramic resonator",
  category: "ics",
  icon: CrystalIcon,
  prefix: "Y",
  defaults: { value: "16 MHz", deviation: "0" },
  fields: [
    { key: "value", label: "Frequency", type: "quantity", unit: "Hz" },
    { key: "deviation", label: "Deviation (%)", type: "text", placeholder: "±1 % at worst" },
  ],
  width: 4,
  height: 3,
  parts: [],
  pins: [
    { id: "1", label: "", x: 0, y: 1, side: "left", labelAt: "top", kind: "digital", note: "Input or output (pin 1)" },
    { id: "3", label: "", x: 4, y: 1, side: "right", labelAt: "top", kind: "digital", note: "Output or input (pin 3)" },
    { id: "2", label: "", x: 2, y: 3, side: "bottom", labelAt: "right", kind: "gnd", note: "The built-in capacitors' common, to ground (pin 2)" },
  ],
  body: [
    { type: "path", d: "M0 1 H1.3 M2.7 1 H4 M1.3 0.4 V1.6 M2.7 0.4 V1.6 M1 1 V2.2 H3 V1 M2 2.2 V3" },
    { type: "rect", x: 1.6, y: 0.3, w: 0.8, h: 1.4, fill: "none" },
    { type: "text", x: 2, y: 0.05, text: "{ref}", size: 0.35 },
    { type: "text", x: 3.1, y: 2.6, text: "{value}", size: 0.3, muted: true, anchor: "start" },
  ],
  // An open circuit at DC, like the crystal; the built-in 15 pF change nothing at the engine's step.
  model: [],
  info: {
    // Tolerance: `±${RESONATOR_TOLERANCE.initial} % initial, ±${RESONATOR_TOLERANCE.temperature} % over −20…80 °C, ±${RESONATOR_TOLERANCE.ageing} % ageing`
    Tolerance: `±${RESONATOR_TOLERANCE.initial} % initial`,
    "Temperature drift": `±${RESONATOR_TOLERANCE.temperature} % over −20…80 °C`,
    Ageing: `±${RESONATOR_TOLERANCE.ageing} %`,
    // Source (in the datasheet record): "Murata CSTCE16M0V53-R0 product data (murata.com)"
    // "Start-up": "0.5 ms: assumed, to be checked (Murata gives no figure)"
    "Start-up": "0.5 ms, assumed (no figure)",
    // "Not modelled" (in the datasheet record): "the frequency's own drift with temperature and age (set the deviation), the built-in capacitors and ESR"
  },
}

export const oscillator: ComponentDef = {
  id: "oscillator",
  name: "Clock oscillator",
  description: "Canned clock oscillator module",
  keywords: ["oscillator", "clock", "oscillator module", "HSE bypass"],
  category: "ics",
  icon: OscillatorIcon,
  prefix: "G",
  defaults: { value: "8 MHz", vmax: "4 V" },
  fields: [
    { key: "value", label: "Frequency", type: "quantity", unit: "Hz" },
    { key: "vmax", label: "Max supply voltage", type: "quantity", unit: "V" },
  ],
  width: 4,
  height: 3,
  parts: [],
  pins: [
    { id: "VCC", label: "VCC", x: 2, y: 0, side: "top", labelAt: "right", kind: "power", note: "3.3 V supply" },
    { id: "GND", label: "GND", x: 2, y: 3, side: "bottom", labelAt: "right", kind: "gnd" },
    { id: "OUT", label: "OUT", x: 4, y: 1.5, side: "right", labelAt: "top", kind: "digital", note: "Clock output; not drawn as a waveform" },
  ],
  body: [
    { type: "rect", x: 0.5, y: 0.5, w: 3, h: 2, rx: 0.2, fill: "none" },
    { type: "path", d: "M2 0 V0.5 M2 2.5 V3 M3.5 1.5 H4" },
    { type: "path", d: "M1 1.9 H1.4 V1.1 H1.8 V1.9 H2.2 V1.1 H2.6 V1.9 H3", muted: true },
    { type: "text", x: 2.9, y: 0.35, text: "{ref}", size: 0.3, anchor: "end" },
    { type: "text", x: 2, y: 2.25, text: "{value}", size: 0.28, muted: true },
  ],
  // The module draws a few milliamps; OUT drives nothing the engine can follow.
  // A few milliamps from VCC; the 3.3 V part is dead past its absolute maximum supply.
  model: [{ kind: "R", a: "VCC", b: "GND", value: 1e3, limits: { voltage: "{vmax}", fail: "short" } }],
  datasheet: {
    basis: "generic",
    none: "A generic oscillator module: its frequency and supply rating are set in the inspector, not taken from one product's datasheet.",
    sources: [DOCS["sitime-sit8008b"]],
    modelled: [{ what: "HSE or LSE bypass clock" }, { what: "Runs at marked frequency" }, { what: "A few milliamps from VCC" }, { what: "Dead past its supply rating" }],
    notModelled: [{ what: "OUT waveform invisible to analog" }, { what: "Frequency tolerance and jitter" }],
  },
}

export { crystalStartup, RESONATOR_STARTUP }

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = [crystal, resonator, oscillator]

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "resonator": {
    maker: "Murata",
    docs: [DOCS["murata-p16e"], DOCS["murata-cstce16m0v53"]],
    specs: [],
    characteristics: [
      { kind: "frequency", value: { typ: 16e6 }, cite: { doc: "murata-p16e", page: 26, at: "CSTCE_V specifications" } },
      { kind: "tolerance", value: { max: 0.005, sym: true }, cite: { doc: "murata-p16e", page: 26, at: "CSTCE_V specifications" } },
      { kind: "temperature", value: { min: -20, max: 80 }, cite: { doc: "murata-p16e", page: 26, at: "CSTCE_V specifications" } },
      { kind: "capacitance", value: { typ: 15e-12 }, cite: { doc: "murata-p16e", page: 5, at: "Part numbering, load capacity" } },
    ],
    modelled: [
      { what: "MCU runs at 16 MHz", cite: { doc: "murata-p16e", page: 26, at: "CSTCE_V specifications" }, test: "tests/sim/resonator.test.ts" },
      { what: "Works either way round", test: "tests/sim/resonator.test.ts" },
      { what: "Deviation shifts the clock", cite: { doc: "murata-p16e", page: 26, at: "CSTCE_V specifications" }, test: "tests/sim/resonator.test.ts" },
      { what: "Outer pins on XTAL needed", test: "tests/sim/resonator.test.ts" },
      { what: "Ready after 0.5 ms, assumed" },
    ],
    notModelled: [
      { what: "Drift with temperature and age", cite: { doc: "murata-p16e", page: 26, at: "CSTCE_V specifications" } },
      { what: "Deviation is set by hand" },
      { what: "Built-in capacitors and ESR", cite: { doc: "murata-p16e", page: 5, at: "Part numbering, load capacity" } },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
