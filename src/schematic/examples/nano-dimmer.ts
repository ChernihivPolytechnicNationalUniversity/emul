/**
 * An Arduino Nano dimmer: firmware/arduino/examples/dimmer reads a 10 kΩ pot's wiper on A0 and
 * writes a quarter of it to D9 (Timer1 PWM, 490 Hz) into 220 Ω and a red LED; the USB serial
 * prints the reading and the duty cycle at 9600 baud. The board runs from its USB connector.
 */
import { CpuIcon } from "lucide-react"
import { builder } from "../builder"
import { arduinoSketch } from "../projects"

export const nanoDimmer = {
  id: "nano-dimmer",
  name: "Arduino Nano dimmer",
  description: "A pot on A0 sets an LED's brightness on D9 through analogWrite; the USB serial prints the reading and the duty cycle.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: arduinoSketch("dimmer") }],
  build(grid: number) {
    const { doc, place, wire } = builder(grid)
    const u = place("arduino-nano", 0, 0)
    // The two USB-serial pins end at (2,-1) and (6,-1); each goes up and across to the
    // terminal, TX the higher so the two never cross.
    const term = place("serial-terminal", 10, -8, { baud: "9600" })
    wire(u, "VCP-TX", term, "RX", [[2, -7]])
    wire(u, "VCP-RX", term, "TX", [[6, -5]])
    // Left header: A0 (J2-12) ends at (0,5), 5V (J2-4) at (0,13), GND (J2-2) at (0,15).
    const pot = place("potentiometer", -9, 7, { pos: "0.5" })
    const gPot = place("ground", -6, 10)
    const gBoard = place("ground", -3, 16)
    wire(pot, "W", u, "J2-12", [[-7, 5]])
    wire(pot, "1", u, "J2-4", [[-11, 8], [-11, 13]])
    wire(pot, "2", gPot, "GND")
    wire(u, "J2-2", gBoard, "GND", [[-2, 15]])
    // Right header: D9 (J1-12) ends at (8,5).
    const r = place("resistor", 12, 4, { value: "220 Ω", power: "0.25" })
    const led = place("led", 18, 4, { value: "red", imax: "20 mA" })
    const gLed = place("ground", 23, 8)
    wire(u, "J1-12", r, "1")
    wire(r, "2", led, "1")
    wire(led, "2", gLed, "GND", [[24, 5]])
    return doc
  },
}
