import { CpuIcon, Volume2Icon } from "lucide-react"
import { builder } from "./builder"
import type { Example } from "./examples"
import { nucleoApp } from "./projects"
import type { PlacedObject } from "./types"

type Pin = [PlacedObject, string]
type Cell = [number, number]

function sheet(grid: number) {
  const b = builder(grid)
  const vert = (def: string, x: number, y: number, props: Record<string, string> = {}) => b.place(def, x, y, props, 90)
  const node = (x: number, y: number) => b.place("junction", x - 1, y - 1)
  const gnd = (x: number, y: number): Pin => [b.place("ground", x - 1, y), "GND"]
  const j = (n: PlacedObject): Pin => [n, "J"]
  const join = (...pins: Pin[]) => {
    for (let k = 1; k < pins.length; k++) b.wire(pins[k - 1][0], pins[k - 1][1], pins[k][0], pins[k][1])
  }
  const via = (a: Pin, c: Pin, ...bends: Cell[]) => b.wire(a[0], a[1], c[0], c[1], bends)
  return { ...b, vert, node, gnd, j, join, via }
}

const MAGNETIC = "buzzer-cem-1203-42"
const DRIVER = { value: "2N2222", beta: "150", rc: "0.5 Ω", icmax: "600 mA", vcemax: "40 V", pmax: "500 mW" }

export const buzzersOnDc: Example = {
  id: "buzzers-on-dc",
  name: "Buzzers on DC: active beeps, passive clicks",
  description:
    "Hold SW1: the active TMB12A05 beeps its own 2.4 kHz for as long as it has DC, while the passive CEM-1203(42) only clicks when the button closes and again when it opens — a passive buzzer needs a changing current. Select either buzzer to read what it is doing.",
  icon: Volume2Icon,
  build(grid) {
    const { doc, place, vert, node, gnd, j, join } = sheet(grid)
    const bat = place("battery", 0, 4, { chem: "alkaline", cells: "3", capacity: "2.5 Ah" })
    const sw = place("pushbutton", 4, 0, { ref: "SW1", value: "push switch", imax: "1 A" })
    const active = vert("buzzer-tmb12a05", 13, 4, { ref: "BZ1" })
    const limit = vert("resistor", 24, 2, { value: "47 Ω", power: "0.25" })
    const passive = vert(MAGNETIC, 25, 7, { ref: "BZ2" })
    const split = node(13, 1)
    const right = node(25, 1)
    join([bat, "+"], [sw, "1"])
    join([sw, "2"], j(split), j(right))
    join(j(split), [active, "1"])
    join([active, "2"], gnd(13, 11))
    join(j(right), [limit, "1"])
    join([limit, "2"], [passive, "1"])
    join([passive, "2"], gnd(25, 14))
    join([bat, "-"], gnd(1, 11))
    return doc
  },
}

function toneStage(s: ReturnType<typeof sheet>, at: { x: number; y: number }, rail: Pin, out: Pin) {
  const { place, vert, node, gnd, j, join, via } = s
  const { x, y } = at
  const base = place("resistor", x, y + 4, { value: "1 kΩ", power: "0.25" })
  const q = place("npn", x + 6, y + 3, { ...DRIVER, ref: "Q1" })
  const limit = vert("resistor", x + 9, y - 10, { value: "22 Ω", power: "0.25" })
  const bz = vert(MAGNETIC, x + 10, y - 5, { ref: "BZ1" })
  const flyback = place("diode", x + 16, y - 4, { value: "1N4148" }, 270)
  const coilTop = node(x + 10, y - 5)
  const coilBottom = node(x + 10, y + 2)
  const clampTop = node(x + 17, y - 5)
  const clampBottom = node(x + 17, y + 2)
  via(out, [base, "1"])
  join([base, "2"], [q, "B"])
  join(rail, [limit, "1"])
  join([limit, "2"], j(coilTop), [bz, "1"])
  join([bz, "2"], j(coilBottom), [q, "C"])
  join(j(coilTop), j(clampTop), [flyback, "2"])
  join([flyback, "1"], j(clampBottom), j(coilBottom))
  join([q, "E"], gnd(x + 9, y + 10))
  return bz
}

export const toneGenerator: Example = {
  id: "buzzer-tone-generator",
  name: "Buzzer: 555 tone generator, sweep the resonance",
  description:
    "An NE555 astable from 630 Hz to 4.8 kHz (VR1) switching a passive CEM-1203(42) through a 2N2222 with a 1N4148 across the coil; 22 Ω holds the coil at its rated 3.3 V. Turn VR1 and watch BZ1's level: it peaks near 0.8, where the tone sits on the buzzer's 2.08 kHz resonance, and at low settings the loudest part of the sound is a harmonic of the drive landing on it.",
  icon: Volume2Icon,
  build(grid) {
    const s = sheet(grid)
    const { place, vert, node, gnd, j, join, via } = s
    const src = place("dc-source", 0, 10, { value: "5 V", rint: "0.1 Ω" })
    const u = place("ne555", 18, 9, { ref: "U1" })
    const ra = vert("resistor", 9, 3, { value: "1 kΩ" })
    const rb = vert("resistor", 9, 9, { value: "1 kΩ" })
    const vr = vert("potentiometer", 9, 15, { value: "10 kΩ", ref: "VR1", pos: "0.5" })
    const c = vert("capacitor", 9, 21, { value: "100 nF" })
    const cc = vert("capacitor", 24, 21, { value: "10 nF" })
    const top = [1, 10, 22, 25, 40].map((x) => node(x, 0))
    const dis = node(10, 8)
    const wiper = node(10, 14)
    const timing = node(10, 20)
    const trig = node(17, 16)
    join(...top.map(j))
    join([src, "+"], j(top[0]))
    join([src, "-"], gnd(1, 17))
    join(j(top[1]), [ra, "1"])
    join([ra, "2"], j(dis), [rb, "1"])
    join(j(dis), [u, "DIS"])
    join([rb, "2"], j(wiper), [vr, "1"])
    via([vr, "W"], j(wiper), [12, 14])
    join([vr, "2"], j(timing), [c, "1"])
    join([c, "2"], gnd(10, 28))
    join(j(timing), j(trig))
    join([u, "THRES"], j(trig))
    join(j(trig), [u, "TRIG"])
    join(j(top[2]), [u, "RESET"])
    join(j(top[3]), [u, "VCC"])
    join([u, "GND"], gnd(22, 20))
    join([u, "CTRL"], [cc, "1"])
    join([cc, "2"], gnd(25, 28))
    toneStage(s, { x: 30, y: 13 }, j(top[4]), [u, "OUT"])
    return s.doc
  },
}

export const twoToneSiren: Example = {
  id: "buzzer-siren",
  name: "Buzzer: two-tone siren from two 555s",
  description:
    "U1 runs at about 1 Hz and pulls U2's CONT pin down through 4.7 kΩ every other half second: U2's thresholds drop and its tone jumps from 1.4 kHz to 2.1 kHz, right onto the CEM-1203(42)'s resonance, so the high note is also the loud one. Select BZ1 to watch the tone and level alternate.",
  icon: Volume2Icon,
  build(grid) {
    const s = sheet(grid)
    const { place, vert, node, gnd, j, join } = s
    const src = place("dc-source", 0, 10, { value: "5 V", rint: "0.1 Ω" })
    const u1 = place("ne555", 18, 9, { ref: "U1" })
    const u2 = place("ne555", 42, 9, { ref: "U2" })
    const astable = (u: PlacedObject, x: number, ra: string, rb: string, c: PlacedObject, top: PlacedObject) => {
      const r1 = vert("resistor", x, 3, { value: ra })
      const r2 = vert("resistor", x, 11, { value: rb })
      const dis = node(x + 1, 8)
      const timing = node(x + 1, 18)
      const trig = node(u.x / grid - 1, 16)
      join(j(top), [r1, "1"])
      join([r1, "2"], j(dis), [r2, "1"])
      join(j(dis), [u, "DIS"])
      join([r2, "2"], j(timing), [c, "1"])
      join([c, "2"], gnd(x + 1, 26))
      join(j(timing), j(trig))
      join([u, "THRES"], j(trig))
      join(j(trig), [u, "TRIG"])
    }
    const top = [1, 10, 22, 25, 34, 46, 49, 64].map((x) => node(x, 0))
    join(...top.map(j))
    join([src, "+"], j(top[0]))
    join([src, "-"], gnd(1, 17))
    const c1 = vert("capacitor-polarized", 9, 19, { value: "10 µF", vmax: "16 V" })
    astable(u1, 9, "10 kΩ", "68 kΩ", c1, top[1])
    join(j(top[2]), [u1, "RESET"])
    join(j(top[3]), [u1, "VCC"])
    join([u1, "GND"], gnd(22, 20))
    const cc1 = vert("capacitor", 24, 21, { value: "10 nF" })
    join([u1, "CTRL"], [cc1, "1"])
    join([cc1, "2"], gnd(25, 28))
    const c2 = vert("capacitor", 33, 19, { value: "100 nF" })
    astable(u2, 33, "1 kΩ", "4.7 kΩ", c2, top[4])
    join(j(top[5]), [u2, "RESET"])
    join(j(top[6]), [u2, "VCC"])
    join([u2, "GND"], gnd(46, 20))
    const mod = place("resistor", 30, 30, { value: "4.7 kΩ" })
    const out1 = node(29, 14)
    join([u1, "OUT"], j(out1))
    s.via(j(out1), [mod, "1"], [29, 31])
    s.via([mod, "2"], [u2, "CTRL"], [49, 31])
    toneStage(s, { x: 54, y: 13 }, j(top[7]), [u2, "OUT"])
    return s.doc
  },
}

export const nucleoMelody: Example = {
  id: "nucleo-melody",
  name: "Nucleo melody on a piezo",
  description:
    "STM32 firmware playing tunes the way Arduino's tone() does: TIM2 makes a 50 % square on D13 at each note's frequency (ARR = 1 MHz / f) and silences it between notes. A piezo needs no transistor, so it hangs straight on the pin. Arduino's toneMelody jingle, then Ode to Joy, over and over; select BZ1 to read each note.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: nucleoApp("melody") }],
  build(grid) {
    const { doc, place, vert, join } = sheet(grid)
    const u = place("nucleo-f429zi", 0, 0)
    const bz = Object.assign(vert("buzzer-pkm13epyh4000-a0", 33, 14, { ref: "BZ1" }), { mirror: true })
    join([u, "CN7-10"], [bz, "1"])
    join([u, "CN7-8"], [bz, "2"])
    return doc
  },
}

export const buzzerExamples = [buzzersOnDc, toneGenerator, twoToneSiren, nucleoMelody]
