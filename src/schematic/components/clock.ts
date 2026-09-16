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
import type { ComponentDef } from "../types"

/** DS9405 Table 33/35 typical start-up times: 2 ms for a MHz crystal, 2 s for a 32 kHz watch crystal. */
export const crystalStartup = (hz: number) => (hz < 1e6 ? 2 : 2e-3)

export const crystal: ComponentDef = {
  id: "crystal",
  name: "Crystal",
  description: "Quartz crystal for the MCU's HSE (OSC_IN/OSC_OUT) or LSE (OSC32_IN/OSC32_OUT). Starts in 2 ms; a 32.768 kHz watch crystal in 2 s.",
  category: "Clock",
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
}

export const oscillator: ComponentDef = {
  id: "oscillator",
  name: "Clock oscillator",
  description: "Canned oscillator module: a ready clock into OSC_IN for HSE bypass mode (or OSC32_IN for LSE bypass). Needs VCC.",
  category: "Clock",
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
    { type: "text", x: 2, y: 2.9, text: "{value}", size: 0.3, muted: true },
  ],
  // The module draws a few milliamps; OUT drives nothing the engine can follow.
  // A few milliamps from VCC; the 3.3 V part is dead past its absolute maximum supply.
  model: [{ kind: "R", a: "VCC", b: "GND", value: 1e3, limits: { voltage: "{vmax}", fail: "short" } }],
}
