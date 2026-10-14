/**
 * TowerPro SG90 micro servo (`src/sim/servo.ts` holds the behaviour and its sources): the three
 * wires as the sheet colours them — orange signal, red +, brown ground — and the horn drawn at
 * the angle the model reports. The supply carries the motor's current as a live load.
 */
import { SERVO_SUPPLY_KEY } from "@/sim/servo"
import { ServoIcon } from "../icons"
import type { ComponentDef } from "../types"

const W = 9
const H = 6

export const servoSg90: ComponentDef = {
  id: "servo-sg90",
  name: "Servo SG90",
  description:
    "TowerPro SG90 9 g micro servo: 20 ms (50 Hz) pulses, 1.5 ms the middle, ~1 ms all the way left (−90°), ~2 ms all the way right (+90°); 0.1 s/60° at 4.8 V; dead band 10 µs. Past ±90° the horn stalls on its stop and draws the stall current.",
  category: "Motors",
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
