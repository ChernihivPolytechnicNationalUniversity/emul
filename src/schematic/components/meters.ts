/**
 * Bench meters: a voltmeter placed across a part (a high resistance that reads the voltage
 * over it) and an ammeter placed in series (a low-burden shunt that reads the current through
 * it). Both show the live value on the component itself, RMS in an AC circuit. Drawn as the
 * IEC circle-with-a-letter symbol; the reading sits under it.
 */
import { AmmeterIcon, VoltmeterIcon } from "../icons"
import type { ComponentDef } from "../types"

const W = 4
const H = 3
const LEADS = "M0 1 H1.1 M2.9 1 H4"

/** Two leads and the meter circle with a letter, plus the ref above and the reading below. */
const face = (letter: string): ComponentDef["body"] => [
  { type: "path", d: LEADS },
  { type: "circle", cx: 2, cy: 1, r: 0.9 },
  { type: "text", x: 2, y: 1.15, text: letter, size: 0.6 },
  { type: "text", x: 2, y: -0.15, text: "{ref}", size: 0.3, muted: true },
]

const pins = (): ComponentDef["pins"] => [
  { id: "+", label: "+", x: 0, y: 1, side: "left", labelAt: "top", kind: "analog" },
  { id: "-", label: "−", x: W, y: 1, side: "right", labelAt: "top", kind: "analog" },
]

/**
 * Voltmeter: a 10 MΩ input across its terminals (a real DMM's load), read as the voltage over
 * that resistor. Placed in parallel with whatever is measured; it draws next to nothing.
 */
export const voltmeter: ComponentDef = {
  id: "voltmeter",
  name: "Voltmeter",
  description: "DC/AC voltmeter across two points; 10 MΩ input, reads RMS in an AC circuit. Past its range the input divider burns and the meter reads nothing.",
  category: "Instruments",
  icon: VoltmeterIcon,
  prefix: "PV",
  defaults: { vmax: "600 V" },
  fields: [{ key: "vmax", label: "Max voltage", type: "quantity", unit: "V" }],
  width: W,
  height: H,
  parts: [],
  pins: pins(),
  body: face("V"),
  model: [{ kind: "R", a: "+", b: "-", value: 10e6, limits: { voltage: "{vmax}" } }],
  meter: { read: "voltage", unit: "V", x: 2, y: 2.6, size: 0.42 },
}

/**
 * Ammeter: a 0.01 Ω shunt in series, read as the current through it. Placed in the wire whose
 * current is wanted; the burden voltage it adds is a real DMM's (a few mV at an amp).
 */
export const ammeter: ComponentDef = {
  id: "ammeter",
  name: "Ammeter",
  description: "DC/AC ammeter in series; 0.01 Ω burden, reads RMS in an AC circuit. Its fuse blows past the rated current and the circuit opens.",
  category: "Instruments",
  icon: AmmeterIcon,
  prefix: "PA",
  defaults: { imax: "10 A" },
  fields: [{ key: "imax", label: "Fuse", type: "quantity", unit: "A" }],
  width: W,
  height: H,
  parts: [],
  pins: pins(),
  body: face("A"),
  model: [{ kind: "R", a: "+", b: "-", value: 0.01, limits: { current: "{imax}" } }],
  meter: { read: "current", unit: "A", x: 2, y: 2.6, size: 0.42 },
}

export const meterComponents: ComponentDef[] = [voltmeter, ammeter]
