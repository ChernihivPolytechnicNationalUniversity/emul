import { AudioWaveformIcon, LightbulbIcon } from "lucide-react"
import { builder } from "../builder"
import type { Example } from "../examples"
import type { PlacedObject, Rotation } from "../types"

type Pin = [PlacedObject, string]

function sheet(grid: number) {
  const b = builder(grid)
  /** A two-pin part standing up: pin 1 at (x + 1, y), pin 2 at (x + 1, y + 4). */
  const vert = (def: string, x: number, y: number, props: Record<string, string> = {}, rotation: Rotation = 90) => b.place(def, x, y, props, rotation)
  /** A junction whose pin sits at (x, y). */
  const node = (x: number, y: number) => b.place("junction", x - 1, y - 1)
  /** A ground symbol whose pin sits at (x, y). */
  const gnd = (x: number, y: number) => b.place("ground", x - 1, y)
  /** A supply rail whose pin sits at (x, y): above it, or hanging below it for a negative rail. */
  const rail = (x: number, y: number, volts: number) =>
    volts >= 0 ? b.place("supply", x - 1, y - 2, { value: `+${volts}V`, voltage: `${volts} V` }) : b.place("supply", x - 1, y, { value: `−${-volts}V`, voltage: `${volts} V` }, 180)
  const join = (...pins: Pin[]) => {
    for (let k = 1; k < pins.length; k++) b.wire(pins[k - 1][0], pins[k - 1][1], pins[k][0], pins[k][1])
  }
  const j = (n: PlacedObject): Pin => [n, "J"]
  return { ...b, vert, node, gnd, rail, join, j }
}

/**
 * The inverting amplifier: a TL072 on ±12 V, 10 kΩ in, 100 kΩ back, so a 1 kHz sine of 0.5 V
 * peak comes out ten times larger and upside down into a 10 kΩ load. IN+ sits on ground, and
 * the feedback holds IN− there too — the virtual ground the inspector reads within microvolts.
 * Turned up past about 1.1 V peak the output runs into the TL072's swing, a volt and more short
 * of each rail, and clips. `tests/sim/opamp-examples.test.ts` checks the gain and the clipping.
 */
export const opampAmplifier: Example = {
  id: "opamp-amplifier",
  name: "Op amp inverting amplifier",
  description:
    "A TL072 on ±12 V with 10 kΩ in and 100 kΩ of feedback: a 1 kHz sine of 0.5 V peak comes out ×10 and inverted. Probe G1 and the output with the oscilloscope; raise G1 past 1.1 V peak to see the output clip short of the rails.",
  icon: AudioWaveformIcon,
  build(grid) {
    const { doc, place, vert, node, gnd, rail, join, j } = sheet(grid)
    const g1 = place("ac-source", 0, 9, { value: "350 mV", freq: "1 kHz", rint: "50 Ω", imax: "100 mA" })
    const r1 = place("resistor", 5, 7, { value: "10 kΩ" })
    const rf = place("resistor", 17, -1, { value: "100 kΩ" })
    const u1 = place("opamp-tl072", 18, 6)
    const rl = vert("resistor", 24, 10, { value: "10 kΩ" })
    const vin = node(13, 8)
    const out = node(25, 9)
    join([g1, "+"], [r1, "1"])
    join([r1, "2"], j(vin), [u1, "IN-"])
    join(j(vin), [rf, "1"])
    join([rf, "2"], j(out))
    join([u1, "OUT"], j(out), [rl, "1"])
    join([rl, "2"], [gnd(25, 15), "GND"])
    join([u1, "IN+"], [gnd(16, 11), "GND"])
    join([g1, "-"], [gnd(1, 14), "GND"])
    join([rail(21, 4, 12), "V"], [u1, "V+"])
    join([rail(21, 14, -12), "V"], [u1, "V-"])
    return doc
  },
}

/**
 * The astable multivibrator: the op amp's output charges C1 through R1 towards whichever rail it
 * sits at, R2 and R3 put half the output on IN+, and each time C1 crosses that the output flips
 * to the other rail. The generic op amp swings rail to rail on ±9 V, so the period is the
 * textbook's 2 R1 C1 ln((1 + β) / (1 − β)) with β = R2 / (R2 + R3) = ½: 2 × 47 kΩ × 10 µF × ln 3,
 * 1.03 s. The output lights LED1 while high and LED2, the other way round, while low.
 */
export const opampFlasher: Example = {
  id: "opamp-flasher",
  name: "Op amp flasher",
  description:
    "The textbook astable on ±9 V: R1 and C1 time it, R2 and R3 feed half the output back to IN+, so it flips every R1·C1·ln 3 — a period of 1.03 s — and lights LED1 and LED2 in turn. Select U1 to watch it held at a rail by its own positive feedback.",
  icon: LightbulbIcon,
  build(grid) {
    const { doc, place, vert, node, gnd, rail, join, j } = sheet(grid)
    const u1 = place("opamp-generic", 18, 6)
    const r1 = place("resistor", 17, -1, { value: "47 kΩ" })
    const c1 = vert("capacitor", 12, 9, { value: "10 µF", vmax: "25 V" })
    const r2 = vert("resistor", 15, 19, { value: "100 kΩ" })
    const r3 = place("resistor", 21, 17, { value: "100 kΩ" })
    const r4 = place("resistor", 27, 8, { value: "1 kΩ" })
    const led1 = vert("led", 32, 10, { value: "red", imax: "20 mA" })
    const led2 = vert("led", 35, 10, { value: "green", imax: "20 mA" }, 270)
    const minus = node(13, 8)
    const plus = node(16, 10)
    const divider = node(16, 18)
    const out = node(25, 9)
    const leds = node(33, 9)
    join([u1, "IN-"], j(minus), [r1, "1"])
    join(j(minus), [c1, "1"])
    join([c1, "2"], [gnd(13, 14), "GND"])
    join([r1, "2"], j(out))
    join([u1, "OUT"], j(out), [r4, "1"])
    join([r4, "2"], j(leds), [led1, "1"])
    join(j(leds), [led2, "2"])
    join([led1, "2"], [gnd(33, 15), "GND"])
    join([led2, "1"], [gnd(36, 15), "GND"])
    join([u1, "IN+"], j(plus), j(divider), [r3, "1"])
    join([r3, "2"], j(out))
    join(j(divider), [r2, "1"])
    join([r2, "2"], [gnd(16, 24), "GND"])
    join([rail(21, 4, 9), "V"], [u1, "V+"])
    join([rail(21, 14, -9), "V"], [u1, "V-"])
    return doc
  },
}

export const opampExamples = [opampAmplifier, opampFlasher]
