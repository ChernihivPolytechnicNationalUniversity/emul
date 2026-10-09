import { CpuIcon, TimerIcon } from "lucide-react"
import { builder } from "./builder"
import type { Example } from "./examples"
import { nucleoApp } from "./projects"
import type { PlacedObject } from "./types"

type Pin = [PlacedObject, string]

function sheet(grid: number) {
  const b = builder(grid)
  const vert = (def: string, x: number, y: number, props: Record<string, string> = {}) => b.place(def, x, y, props, 90)
  const node = (x: number, y: number) => b.place("junction", x - 1, y - 1)
  const gnd = (x: number, y: number) => b.place("ground", x - 1, y)
  const join = (...pins: Pin[]) => {
    for (let k = 1; k < pins.length; k++) b.wire(pins[k - 1][0], pins[k - 1][1], pins[k][0], pins[k][1])
  }
  const j = (n: PlacedObject): Pin => [n, "J"]
  return { ...b, vert, node, gnd, join, j }
}

export const ne555Flasher: Example = {
  id: "ne555-flasher",
  name: "NE555 flasher",
  description: "A 555 astable at about 1 Hz from a 9 V battery: RA 10 kΩ, RB 68 kΩ, 10 µF. OUT drives two LEDs in turn, one to ground and one from VCC. Select the timer to read its frequency and duty.",
  icon: TimerIcon,
  build(grid) {
    const { doc, place, vert, node, gnd, join, j } = sheet(grid)
    const bat = place("battery", 0, 12, { chem: "alkaline", cells: "6", capacity: "0.6 Ah" })
    const u = place("ne555", 24, 11)
    const ra = vert("resistor", 11, 5, { value: "10 kΩ" })
    const rb = vert("resistor", 11, 16, { value: "68 kΩ" })
    const c = vert("capacitor-polarized", 11, 23, { value: "10 µF", vmax: "16 V" })
    const cc = vert("capacitor", 30, 22, { value: "10 nF" })
    const r1 = vert("resistor", 38, 18, { value: "470 Ω" })
    const led1 = vert("led", 38, 24, { value: "red" })
    const r2 = vert("resistor", 38, 1, { value: "470 Ω" })
    const led2 = vert("led", 38, 7, { value: "green" })
    const rail = [1, 12, 31, 39].map((x) => node(x, 0))
    const dis = node(12, 14)
    const timing = node(12, 22)
    const trig = node(23, 18)
    const out = node(39, 16)
    join(...rail.map(j))
    join([bat, "+"], j(rail[0]))
    join([bat, "-"], [gnd(1, 18), "GND"])
    join(j(rail[1]), [ra, "1"])
    join([ra, "2"], j(dis), [rb, "1"])
    join(j(dis), [u, "DIS"])
    join([rb, "2"], j(timing), [c, "1"])
    join([c, "2"], [gnd(12, 30), "GND"])
    join(j(timing), j(trig))
    join([u, "THRES"], j(trig))
    join(j(trig), [u, "TRIG"])
    join(j(rail[2]), [u, "VCC"])
    join([u, "VCC"], [u, "RESET"])
    join([u, "GND"], [gnd(28, 23), "GND"])
    join([u, "CTRL"], [cc, "1"])
    join([cc, "2"], [gnd(31, 29), "GND"])
    join([u, "OUT"], j(out))
    join(j(out), [r1, "1"])
    join([r1, "2"], [led1, "1"])
    join([led1, "2"], [gnd(39, 31), "GND"])
    join(j(rail[3]), [r2, "1"])
    join([r2, "2"], [led2, "1"])
    join([led2, "2"], j(out))
    return doc
  },
}

export const nucleoShiftRegister: Example = {
  id: "nucleo-74hc595",
  name: "Nucleo + 74HC595 running light",
  description: "SPI1 shifts one lit bit into a 74HC595 every 125 ms: SCK on SRCLK, MOSI on SER, PD14 latches it on RCLK. Eight LEDs through 330 Ω on QA–QH, the chip on the board's 3.3 V.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: nucleoApp("shift") }],
  build(grid) {
    const { doc, place, node, gnd, join, j, wire } = sheet(grid)
    const n = place("nucleo-f429zi", 0, 0)
    const u = place("hc595", 38, 13)
    const supply = node(37, 11)
    const vcc = node(42, 11)
    wire(n, "CN8-7", supply, "J", [
      [-2, 16],
      [-2, -2],
      [37, -2],
    ])
    join(j(supply), j(vcc))
    join(j(vcc), [u, "VCC"])
    wire(supply, "J", u, "SRCLR", [[37, 18]])
    join([n, "CN7-10"], [u, "SRCLK"])
    wire(n, "CN7-14", u, "SER", [
      [31, 19],
      [31, 15],
    ])
    join([n, "CN7-16"], [u, "RCLK"])
    join([u, "OE"], [gnd(37, 24), "GND"])
    join([u, "GND"], [gnd(42, 28), "GND"])
    const outputs = ["QA", "QB", "QC", "QD", "QE", "QF", "QG", "QH"]
    const turns = [48, 49, 50, 51, 52, 51, 50, 49]
    const bus = outputs.map((_, k) => node(70, 5 + 4 * k))
    outputs.forEach((q, k) => {
      const y = 5 + 4 * k
      const r = place("resistor", 56, y - 1, { value: "330 Ω" })
      const led = place("led", 63, y - 1, { value: "red" })
      wire(u, q, r, "1", [
        [turns[k], 15 + k],
        [turns[k], y],
      ])
      join([r, "2"], [led, "1"])
      join([led, "2"], j(bus[k]))
    })
    join(...bus.map(j))
    join(j(bus[bus.length - 1]), [gnd(70, 36), "GND"])
    return doc
  },
}
