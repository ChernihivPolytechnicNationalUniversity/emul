/**
 * The Arduino UNO Rev3 against its Rev3e schematic and the parts' data sheets: where +5V comes
 * from (USB through F1 and T1, or the jack through D1 and the NCP1117, the LMV358 handing over at
 * VIN ≈ 6.6 V), the LP2985's 3.3 V, the L LED behind U5B, the 16U2's serial, the RESET button.
 * Firmware: firmware/avr/examples/blink.c (L on PB5 at 1 Hz, "tick n" a second at 9600 baud).
 */
import { describe, expect, it } from "vitest"
import { arduinoUno } from "@/schematic/components/arduino-uno"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

function bench(opts: { usb?: boolean; jack?: number; load5v?: string; firmware?: boolean } = {}) {
  const { doc, place, wire } = builder(GRID)
  const uno = place("arduino-uno", 10, 10, opts.firmware === false ? {} : { firmware: "avr-blink.elf", firmwareData: exampleBase64("avr-blink.elf") })
  doc.parts[partKey(uno.id, "USB")] = { on: opts.usb !== false }
  let jack: PlacedObject | undefined
  if (opts.jack) {
    jack = place("dc-source", -10, 40, { value: `${opts.jack} V`, rint: "0.1 Ω", imax: "3 A" })
    wire(jack, "+", uno, "JACK")
    wire(jack, "-", uno, "POWER-6")
  }
  if (opts.load5v) {
    const r = place("resistor", 30, 60, { value: opts.load5v, power: "100" })
    wire(uno, "POWER-5", r, "1")
    wire(r, "2", uno, "POWER-7")
  }
  const term = place("serial-terminal", -20, 5, { baud: "9600" })
  wire(uno, "VCP-TX", term, "RX")
  wire(uno, "VCP-RX", term, "TX")
  return { doc, uno, term, jack }
}

function start(doc: Schematic) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(0)
  return {
    loop,
    run(seconds: number): Snapshot {
      const end = clock + seconds * 1000
      while (clock < end) {
        clock = Math.min(end, clock + 20)
        loop.advance(clock)
      }
      return loop.snapshot()!
    },
  }
}

const volts = (s: Snapshot, obj: PlacedObject, pin: string) => s.pinVoltage[pinKey(obj.id, pin)] ?? 0
const model = arduinoUno.model!
/** A model element's reading, by its label in the board's model. */
const reading = (s: Snapshot, obj: PlacedObject, label: string) => s.readings.find((r) => r.object === obj.id && r.element === model.findIndex((e) => e.label === label))
const D13_PAD = model.findIndex((e) => e.kind === "GPIO" && e.node === "IOH-6")

describe("Arduino UNO Rev3: power", () => {
  it("on USB alone: +5V within 0.1 V of the port (F1 and T1, no Schottky), 3.3V from the LP2985, VIN near 0", () => {
    const { doc, uno } = bench()
    const s = start(doc).run(0.3)
    expect.soft(volts(s, uno, "POWER-5"), "5V").toBeGreaterThan(4.9)
    expect.soft(volts(s, uno, "POWER-5"), "5V").toBeLessThanOrEqual(5.0)
    expect.soft(volts(s, uno, "POWER-4"), "3.3V").toBeNear(3.3, 0.02)
    expect.soft(volts(s, uno, "POWER-2"), "IOREF").toBeNear(volts(s, uno, "POWER-5"), 1e-6)
    expect.soft(volts(s, uno, "POWER-8"), "VIN").toBeLessThan(0.5)
    expect.soft(reading(s, uno, "T1 FDN340P")?.extra?.region, "T1").not.toBe("off")
  })

  it("with nothing plugged in it is dead", () => {
    const { doc, uno } = bench({ usb: false })
    const s = start(doc).run(0.2)
    expect(volts(s, uno, "POWER-5")).toBeLessThan(0.1)
  })

  it("on a 9 V jack alone: VIN is 9 V less D1's drop, +5V and 3.3V hold", () => {
    const { doc, uno } = bench({ usb: false, jack: 9 })
    const s = start(doc).run(0.3)
    expect.soft(volts(s, uno, "POWER-8"), "VIN").toBeNear(9 - 0.85, 0.15)
    expect.soft(volts(s, uno, "POWER-5"), "5V").toBeNear(5, 0.05)
    expect.soft(volts(s, uno, "POWER-4"), "3.3V").toBeNear(3.3, 0.02)
  })

  it("on USB and a 9 V jack: VIN / 2 is above 3.3 V, so U5A turns T1 off and USB carries nothing", () => {
    const { doc, uno } = bench({ jack: 9 })
    const s = start(doc).run(0.3)
    expect.soft(reading(s, uno, "T1 FDN340P")?.extra?.region, "T1").toBe("off")
    expect.soft(Math.abs(reading(s, uno, "F1 MF-MSMF050-2")!.current) * 1e3, "USB current (mA)").toBeLessThan(1)
    expect.soft(volts(s, uno, "POWER-5"), "5V from the NCP1117").toBeNear(5, 0.05)
  })

  it("on USB and a 7 V jack: VIN ≈ 6.15 V, under 6.6 V, so U5A keeps T1 on (the NCP1117 at 5.0 V and USB share +5V)", () => {
    const { doc, uno } = bench({ jack: 7 })
    const s = start(doc).run(0.3)
    expect.soft(volts(s, uno, "POWER-8"), "VIN").toBeLessThan(6.6)
    expect.soft(reading(s, uno, "T1 FDN340P")?.extra?.region, "T1").not.toBe("off")
    expect.soft(volts(s, uno, "POWER-5"), "5V").toBeNear(5, 0.05)
  })

  it("a 2.5 A load on the 5V pin from USB trips F1, and +5V collapses", () => {
    const { doc, uno } = bench({ load5v: "2 Ω" })
    const t = start(doc)
    t.run(0.05)
    const s = t.run(3)
    expect.soft(reading(s, uno, "F1 MF-MSMF050-2")?.extra?.state, "F1").toBe("tripped")
    expect.soft(volts(s, uno, "POWER-5"), "5V").toBeLessThan(1)
    expect.soft(s.damage[uno.id], "nothing on the board damaged").toBeUndefined()
  })
})

describe("Arduino UNO Rev3: the sketch", () => {
  const { doc, uno, term } = bench()
  const t = start(doc)

  it("runs at 16 MHz with Arduino's fuses (high 0xDE)", () => {
    const s = t.run(0.2)
    const st = s.mcus[uno.id]
    expect.soft(st.running).toBe(true)
    expect.soft(st.sysclk).toBe(16e6)
  })

  it("prints a tick a second through the 16U2 to the terminal", () => {
    const s = t.run(2.2)
    expect.soft(s.terminals[term.id].text).toMatch(/^tick 0\r\ntick 1\r\n/)
    expect.soft(s.terminals[term.id].framingErrors).toBe(0)
  })

  it("L follows D13 through U5B, D13 itself carrying under a microamp", () => {
    let on = 0
    let off = 0
    let maxPin = 0
    for (let i = 0; i < 100; i++) {
      const s = t.run(0.01)
      if (s.parts[partKey(uno.id, "L")]?.on) on++
      else off++
      const pad = s.readings.find((r) => r.object === uno.id && r.element === D13_PAD)
      if (pad) maxPin = Math.max(maxPin, Math.abs(pad.current))
    }
    expect.soft(on, "on samples").toBeGreaterThan(30)
    expect.soft(off, "off samples").toBeGreaterThan(30)
    expect.soft(maxPin * 1e6, "D13 current (µA)").toBeLessThan(1)
  })

  it("holding RESET stops the sketch: the terminal goes quiet", () => {
    doc.parts[partKey(uno.id, "RESET")] = { pressed: true }
    t.loop.setParts(doc.parts)
    const before = t.run(0.1).terminals[term.id].text
    const s = t.run(1.5)
    expect.soft(s.terminals[term.id].text, "no new ticks").toBe(before)
    expect.soft(volts(s, uno, "POWER-3"), "RESET").toBeLessThan(0.1)
  })
})
