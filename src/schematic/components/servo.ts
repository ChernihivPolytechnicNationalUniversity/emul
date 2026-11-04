/**
 * TowerPro SG90 micro servo (`src/sim/servo.ts` holds the behaviour and its sources): the three
 * wires as the sheet colours them — orange signal, red +, brown ground — and the horn drawn at
 * the angle the model reports. The supply carries the motor's current as a live load.
 */
import { SERVO_SUPPLY_KEY } from "@/sim/servo"
import { ServoIcon } from "../icons"
import type { ComponentDef } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"

const W = 9
const H = 6

export const servoSg90: ComponentDef = {
  id: "servo-sg90",
  name: "Servo SG90",
  description:
    "TowerPro SG90 9 g micro servo: 20 ms (50 Hz) pulses, 1.5 ms the middle, ~1 ms all the way left (−90°), ~2 ms all the way right (+90°); 0.1 s/60° at 4.8 V; dead band 10 µs. Past ±90° the horn stalls on its stop and draws the stall current.",
  category: "sound",
  keywords: ["servo", "SG90", "TowerPro", "Tower Pro", "micro servo", "PWM"],
  icon: ServoIcon,
  prefix: "M",
  width: W,
  height: H,
  pins: [
    { id: "GND", label: "GND", x: 0, y: 2, side: "left", labelAt: "right", kind: "gnd", note: "Brown wire" },
    { id: "VCC", label: "+", x: 0, y: 3, side: "left", labelAt: "right", kind: "power", note: "Red wire; the sheet's operating voltage is 4.8 V (~5 V)" },
    { id: "SIG", label: "SIG", x: 0, y: 4, side: "left", labelAt: "right", kind: "digital", note: "Orange wire: 1–2 ms pulses every 20 ms" },
  ],
  body: [
    { type: "rect", x: 1.4, y: 1.6, w: W - 2, h: H - 2.2, rx: 0.2, fill: "board" },
    { type: "rect", x: 1, y: 2.6, w: 0.4, h: 1.8, rx: 0.1, fill: "connector" },
    { type: "circle", cx: 6, cy: 2.6, r: 1.15, fill: "zone" },
    { type: "text", x: 2.2, y: H - 1.05, text: "SG90", size: 0.34, anchor: "start" },
    { type: "text", x: W - 0.6, y: 0.2, text: "{ref}", size: 0.32, muted: true, anchor: "end" },
  ],
  parts: [{ type: "horn", id: "HORN", label: "Horn", x: 6, y: 2.6, r: 2.2 }],
  model: [
    { kind: "R", a: "VCC", b: "GND", value: 1e9, live: SERVO_SUPPLY_KEY, label: "Motor and electronics" },
    { kind: "GPIO", node: "SIG", vddNode: "VCC", gndNode: "GND" },
  ],
  info: { Source: "TowerPro SG90 sheet (components101 / FriendlyWire copies); Rapid 37-1330 (Version 1, October 2013); currents: vendor spec sheet and RobotShop" },
}

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = [servoSg90]

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "servo-sg90": {
    maker: "TowerPro",
    docs: [DOCS["towerpro-sg90"], DOCS["rapid-37-1330"]],
    specs: [
      { label: "Supply", value: "4.8 V (~5 V)", cite: { page: 1, at: "Specifications" } },
      { label: "Pulse width", value: "~1 ms −90°, 1.5 ms 0°, ~2 ms +90°", cite: { page: 2 } },
      { label: "Speed", value: "0.1 s/60° at 4.8 V", cite: { doc: "rapid-37-1330", page: 1 } },
      { label: "Stall torque", value: "1.8 kgf·cm at 4.8 V", cite: { doc: "rapid-37-1330", page: 1 } },
      { label: "Dead band", value: "10 µs", cite: { page: 1, at: "Specifications" } },
      { label: "Temperature", value: "0–55 °C", cite: { page: 1, at: "Specifications" } },
    ],
    modelled: [
      { what: "Pulse width sets the angle: 1.5 ms the middle, 1 ms −90°, 2 ms +90°, linear between", cite: { page: 2 }, test: "tests/sim/servo.test.ts" },
      { what: "The horn travels at 0.1 s/60°, not at once", cite: { page: 1, at: "Specifications" }, test: "tests/sim/servo.test.ts" },
      { what: "A change inside the 10 µs dead band does not move it", cite: { page: 1, at: "Specifications" }, test: "tests/sim/servo.test.ts" },
      { what: "A pulse asking past ±90° drives the horn onto its stop, where it stalls and draws 750 mA (a vendor figure; these sheets give no current)", test: "tests/sim/servo.test.ts" },
      { what: "Supply current as a live load: 4 mA at rest, 90 mA moving", test: "tests/sim/servo.test.ts" },
      { what: "Follows the pulses a firmware's timer PWM makes on a Nucleo", test: "tests/sim/nucleo-servo.test.ts" },
      { what: "Without pulses the motor is off and the horn stays where it is", test: "tests/sim/servo.test.ts" },
      { what: "Below 3 V the electronics do not answer (the sheets give no minimum; 3 V is the SG92R's)" },
    ],
    notModelled: [
      { what: "Torque and load: nothing pushes on the horn, and the 1.8 kgf·cm stall torque plays no part", cite: { page: 1, at: "Specifications" } },
      { what: "Speed and current change with supply voltage: the 4.8 V figures hold at any voltage", cite: { doc: "rapid-37-1330", page: 1 } },
      { what: "Acceleration, overshoot and hunting: the horn moves at a constant speed and stops dead" },
      { what: "The motor's pulsed current and the noise it puts on the supply: three steady levels only" },
      { what: "Overheating or wear from a long stall or an over-voltage supply" },
      { what: "The pulse period is not checked: any repetition rate up to about 40 ms is followed" },
      { what: "Operating temperature range", cite: { page: 1, at: "Specifications" } },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
