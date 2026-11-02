/**
 * Murata CSTCE16M0V53-R0, the Arduino Uno's 16 MHz ceramic resonator, on a bare ATmega328P:
 * its outer pins across XTAL1/XTAL2, the middle one (its two built-in load capacitors) to ground.
 * The product page gives ±0.5 % initial tolerance, ±0.3 % over −20…80 °C and ±0.2 % ageing; the
 * inspector's deviation puts a part anywhere in (or outside) that and the chip runs off it.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { builder } from "@/schematic/builder"
import { getDef } from "@/schematic/registry"
import { SimLoop } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

function bench(props: Record<string, string> = {}, swapped = false) {
  const { doc, place, wire } = builder(GRID)
  const chip = getDef("atmega328p")!
  const y = (pin: string) => chip.pins.find((p) => p.id === pin)!.y
  const R = chip.width
  const dd = place("atmega328p", 0, 0, { firmware: "avr-blink.elf", firmwareData: exampleBase64("avr-blink.elf") })
  const v5 = place("supply", -9, y("VCC") - 3, { value: "+5V", voltage: "5 V" })
  const gnd = place("ground", -9, y("GND") + 2)
  wire(v5, "V", dd, "VCC")
  wire(v5, "V", dd, "AVCC")
  wire(dd, "GND", gnd, "GND")
  const rr = place("resistor", -8, y("PC6") - 1, { ref: "R1", value: "10 kΩ", power: "0.25" }, 90)
  wire(dd, "PC6", rr, "2")
  wire(rr, "1", v5, "V")
  const y2 = place("resonator", R + 6, y("PB6") - 2, { ref: "Y2", ...props }, 90)
  const gx = place("ground", R + 12, y("PB7") + 4)
  wire(dd, "PB6", y2, swapped ? "3" : "1")
  wire(dd, "PB7", y2, swapped ? "1" : "3")
  wire(y2, "2", gx, "GND")
  const term = place("serial-terminal", R + 6, y("PD0") - 1, { baud: "9600" })
  wire(dd, "PD1", term, "RX")
  wire(dd, "PD0", term, "TX")
  return { doc, dd, term }
}

function run(doc: ReturnType<typeof bench>["doc"], seconds: number) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  for (let ms = 0; ms <= seconds * 1000; ms += 30) loop.advance(ms)
  return loop.snapshot()!
}

describe("CSTCE16M0V53 ceramic resonator", () => {
  it("clocks the chip at 16 MHz in crystal mode, either way round", () => {
    for (const swapped of [false, true]) {
      const b = bench({}, swapped)
      const st = run(b.doc, 0.1).mcus[b.dd.id]
      expect.soft(st.sysclk, swapped ? "swapped" : "as drawn").toBe(16e6)
      expect.soft(st.labels?.clock).toBe("crystal")
    }
  })

  it.each([
    ["0.5", 16.08e6],
    ["-0.5", 15.92e6],
    ["-1", 15.84e6],
  ])("a part %s %% off runs the chip at that frequency", (deviation, hz) => {
    const b = bench({ deviation })
    expect(run(b.doc, 0.1).mcus[b.dd.id].sysclk).toBeNearRel(hz, 1e-9)
  })

  it("at the worst of its tolerances (±1 % in all) still talks to a 9600-baud terminal", () => {
    const b = bench({ deviation: "1" })
    const t = run(b.doc, 2.3).terminals[b.term.id]
    expect.soft(t.text).toMatch(/^tick 0\r\ntick 1\r\n/)
    expect.soft(t.framingErrors).toBe(0)
  })

  it("without its outer pins on XTAL1/XTAL2 gives the chip no clock", () => {
    const { doc, place, wire } = builder(GRID)
    const dd = place("atmega328p", 0, 0, { firmware: "avr-blink.elf", firmwareData: exampleBase64("avr-blink.elf") })
    const v5 = place("supply", -9, 0, { value: "+5V", voltage: "5 V" })
    const gnd = place("ground", -9, 20)
    wire(v5, "V", dd, "VCC")
    wire(dd, "GND", gnd, "GND")
    const y2 = place("resonator", 30, 0, {})
    wire(dd, "PB6", y2, "1")
    wire(dd, "PB7", y2, "2")
    expect(run(doc, 0.1).mcus[dd.id].sysclk).toBe(0)
  })
})
