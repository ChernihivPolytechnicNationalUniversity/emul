/**
 * Rotary encoders with detents. The shaft (a knob on the field, turned a detent at a time) works
 * two contacts to the common C in quadrature; each turn walks the code a quarter-cycle at a time
 * at the speed the maker measures at, and each make and break can bounce.
 *
 * ALPS EC11E (catalogue "Update 2510"; the output wave, sliding noise and switch data from the
 * EC11B15242AE product page of the same series, as Farnell keeps it): turning clockwise, A makes
 * before B; the detents sit alternately at both contacts open and both closed, half a cycle apart
 * (30 detents / 15 pulses, 18/9, 36/18); measured at 360°/s; chattering 3 ms max, bounce 2 ms max;
 * rated 10 mA 5 V DC (1–10 mA resistive); sliding noise at most 1.5 V across 5 kΩ pull-ups from
 * 5 V, which bounds a closed contact at 2.14 kΩ. The push switch: 0.1 A 5 V DC, 100 mΩ max.
 *
 * KY-040 module: no maker's schematic exists. As forum and Wokwi descriptions draw it: a
 * 20-detent / 20-pulse encoder (a full cycle per detent, at rest both open), 10 kΩ pull-ups on CLK
 * and DT to +, and the SW pull-up's footprint left empty — SW floats until the MCU pulls it up.
 */
import { EncoderIcon } from "../icons"
import type { ComponentDef, PartDef, PinDef } from "../types"
import { BOUNCE_FIELDS } from "./basic"

/** 360°/s, the ALPS measuring speed: a quarter-cycle takes a quarter of 360° / pulses. */
const quarterAt360 = (pulses: number) => 1 / (4 * pulses)

export const EC11E_PARTS: Record<string, { detents: number; pulses: number; push: boolean }> = {
  EC11E15244G1: { detents: 30, pulses: 15, push: true },
  EC11E09244BS: { detents: 18, pulses: 9, push: true },
  EC11E18244AU: { detents: 36, pulses: 18, push: true },
}

const ec11Of = (props: Record<string, string>) => EC11E_PARTS[props.value] ?? EC11E_PARTS.EC11E15244G1

/** Closed-contact resistance bound from the sliding-noise spec: V1 ≤ 1.5 V of 5 V across 5 kΩ. */
export const EC11_CONTACT_MAX = (5e3 * 1.5) / (5 - 1.5)

/** The encoder contacts' switching rating; as every switch here, a contact carrying more reads over 100 % and does not break. */
const ENCODER_CONTACT = { current: "10 mA" } as const
const PUSH_CONTACT = { current: "100 mA" } as const

const knob = (x: number, y: number, phases: number, quarter: (props: Record<string, string>) => number): PartDef => ({
  type: "knob",
  id: "SHAFT",
  label: "Shaft",
  x,
  y,
  r: 1.1,
  contacts: ["A", "B"],
  phases,
  quarter,
})

const W = 7
const H = 6

const ec11Pins: PinDef[] = [
  { id: "A", label: "A", x: 0, y: 2, side: "left", labelAt: "right", kind: "digital", note: "Phase A: closes to C first turning clockwise" },
  { id: "C", label: "C", x: 0, y: 3, side: "left", labelAt: "right", kind: "gnd", note: "Common of A and B" },
  { id: "B", label: "B", x: 0, y: 4, side: "left", labelAt: "right", kind: "digital", note: "Phase B" },
  { id: "D", label: "D", x: W, y: 2, side: "right", labelAt: "left", kind: "digital", note: "Push-on switch (SPST), closes D to E" },
  { id: "E", label: "E", x: W, y: 4, side: "right", labelAt: "left", kind: "digital", note: "Push-on switch" },
]

export const encoderEc11: ComponentDef = {
  id: "encoder-ec11",
  name: "Rotary encoder (ALPS EC11E)",
  description:
    "Incremental encoder with detents and a push switch: A and B close to C in quadrature, A first turning clockwise, half a cycle per detent (rest alternately both open, both closed). 10 mA 5 V rating; bounce 2 ms max when switched on. Pull A, B and D up yourself.",
  category: "Switches",
  keywords: ["encoder", "rotary", "quadrature", "EC11", "ALPS", ...Object.keys(EC11E_PARTS)],
  icon: EncoderIcon,
  prefix: "SW",
  width: W,
  height: H,
  defaults: { value: "EC11E15244G1", rcontact: "2.14 kΩ", bounce: "off", tbounce: "2 ms" },
  derive: (props) => ({ detents: String(ec11Of(props).detents) }),
  fields: [
    { key: "value", label: "Part", type: "select", options: Object.entries(EC11E_PARTS).map(([id, p]) => ({ value: id, label: `${id} · ${p.detents} detents / ${p.pulses} pulses` })) },
    { key: "rcontact", label: "Contact resistance (spec bound)", type: "quantity", unit: "Ω" },
    ...BOUNCE_FIELDS,
  ],
  pins: ec11Pins,
  body: [
    { type: "rect", x: 1, y: 0.4, w: W - 2, h: H - 0.4, rx: 0.3, fill: "board" },
    { type: "text", x: W / 2, y: H - 0.35, text: "{value}", size: 0.26, muted: true },
    { type: "text", x: W - 0.6, y: 0.2, text: "{ref}", size: 0.32, muted: true, anchor: "end" },
  ],
  parts: [
    knob(W / 2, 2.1, 2, (props) => quarterAt360(ec11Of(props).pulses)),
    { type: "button", id: "PUSH", label: "Push", face: "⏎", x: W / 2, y: 4.3, size: 0.8, printed: true },
  ],
  bounces: ["PUSH"],
  model: [
    { kind: "SW", a: "A", b: "C", part: "A", closed: "on", ron: "{rcontact}", limits: ENCODER_CONTACT },
    { kind: "SW", a: "B", b: "C", part: "B", closed: "on", ron: "{rcontact}", limits: ENCODER_CONTACT },
    { kind: "SW", a: "D", b: "E", part: "PUSH", closed: "pressed", ron: "100 mΩ", limits: PUSH_CONTACT },
  ],
  info: { Source: "ALPS EC11E catalogue (Update 2510); EC11B15242AE product page (output wave, sliding noise)" },
}

const KY_W = 8
const KY_H = 7

/** As the forum descriptions have it: no maker documents the board. */
const KY040_PULSES = 20

export const ky040: ComponentDef = {
  id: "ky-040",
  name: "Rotary encoder module KY-040",
  description:
    "Encoder board: 20 detents / 20 pulses (a full cycle per detent, at rest both open), 10 kΩ pull-ups on CLK and DT to +, SW straight to the switch with no pull-up fitted — enable the MCU's. No maker's schematic exists: built from the forum and Wokwi descriptions.",
  category: "Switches",
  keywords: ["encoder", "rotary", "KY-040", "KY040", "quadrature", "module"],
  icon: EncoderIcon,
  prefix: "SW",
  width: KY_W,
  height: KY_H,
  defaults: { rcontact: "2.14 kΩ", bounce: "off", tbounce: "2 ms" },
  derive: () => ({ detents: String(KY040_PULSES) }),
  fields: [{ key: "rcontact", label: "Contact resistance", type: "quantity", unit: "Ω" }, ...BOUNCE_FIELDS],
  pins: [
    { id: "GND", label: "GND", x: KY_W, y: 1, side: "right", labelAt: "left", kind: "gnd" },
    { id: "VCC", label: "+", x: KY_W, y: 2, side: "right", labelAt: "left", kind: "power", note: "Feeds only the CLK and DT pull-ups" },
    { id: "SW", label: "SW", x: KY_W, y: 3, side: "right", labelAt: "left", kind: "digital", note: "Push switch to GND; no pull-up on the board" },
    { id: "DT", label: "DT", x: KY_W, y: 4, side: "right", labelAt: "left", kind: "digital", note: "Phase B, 10 kΩ to +" },
    { id: "CLK", label: "CLK", x: KY_W, y: 5, side: "right", labelAt: "left", kind: "digital", note: "Phase A, 10 kΩ to +" },
  ],
  body: [
    { type: "rect", x: 0.4, y: 0.3, w: KY_W - 1.2, h: KY_H - 0.6, rx: 0.3, fill: "board" },
    { type: "text", x: 0.8, y: KY_H - 0.75, text: "KY-040", size: 0.3, muted: true, anchor: "start" },
    { type: "text", x: KY_W - 0.9, y: 0.0, text: "{ref}", size: 0.32, muted: true, anchor: "end" },
  ],
  parts: [
    knob(3.3, 2.5, 4, () => quarterAt360(KY040_PULSES)),
    { type: "button", id: "PUSH", label: "Push", face: "⏎", x: 3.3, y: 4.7, size: 0.8, printed: true },
  ],
  bounces: ["PUSH"],
  model: [
    { kind: "SW", a: "CLK", b: "GND", part: "A", closed: "on", ron: "{rcontact}", limits: ENCODER_CONTACT },
    { kind: "SW", a: "DT", b: "GND", part: "B", closed: "on", ron: "{rcontact}", limits: ENCODER_CONTACT },
    { kind: "SW", a: "SW", b: "GND", part: "PUSH", closed: "pressed", ron: "100 mΩ", limits: PUSH_CONTACT },
    { kind: "R", a: "VCC", b: "CLK", value: "10 kΩ", label: "R2 CLK pull-up" },
    { kind: "R", a: "VCC", b: "DT", value: "10 kΩ", label: "R3 DT pull-up" },
  ],
  info: { Source: "Community descriptions (Wokwi KY-040 docs, DroneBot Workshop forum); no manufacturer schematic" },
}

export const encoderComponents: ComponentDef[] = [encoderEc11, ky040]
