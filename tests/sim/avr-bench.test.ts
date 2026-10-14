/**
 * A bare ATmega328P on the bench, wired as an Arduino Uno's chip: +5 V into VCC and AVCC, a
 * 16 MHz crystal with 22 pF load capacitors across XTAL1/XTAL2, 10 kΩ pull-up on RESET, an
 * LED through 220 Ω on PB5, a serial terminal on RXD/TXD. The firmware (firmware/avr/examples/
 * blink.c, fuses from its .fuse section) blinks the LED at 1 Hz from Timer1, prints a tick a
 * second at 9600 baud and echoes what is typed upper-cased. Then the bench is changed the
 * way a student would: the crystal taken out, the fuses set for the internal RC, the RESET
 * pin pulled low.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { builder } from "@/schematic/builder"
import { getDef } from "@/schematic/registry"
import { pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

function bench(opts: { crystal?: boolean } = {}) {
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
  const led = place("led", R + 12, y("PB5") - 1, { value: "red", imax: "20 mA" })
  const r2 = place("resistor", R + 5, y("PB5") - 1, { ref: "R2", value: "220 Ω", power: "0.25" })
  const g2 = place("ground", R + 18, y("PB5"))
  wire(dd, "PB5", r2, "1")
  wire(r2, "2", led, "1")
  wire(led, "2", g2, "GND")
  if (opts.crystal !== false) {
    const zq = place("crystal", R + 6, y("PB6") - 2, { ref: "ZQ1", value: "16 MHz" }, 90)
    const c1 = place("capacitor", R + 10, y("PB6") - 4, { ref: "C1", value: "22 pF" })
    const c2 = place("capacitor", R + 10, y("PB7") + 2, { ref: "C2", value: "22 pF" })
    const gx = place("ground", R + 16, y("PB7") + 4)
    wire(dd, "PB6", zq, "1")
    wire(dd, "PB7", zq, "2")
    wire(zq, "1", c1, "1")
    wire(zq, "2", c2, "1")
    wire(c1, "2", gx, "GND")
    wire(c2, "2", gx, "GND")
  }
  const term = place("serial-terminal", R + 6, y("PD0") - 1, { baud: "9600" })
  wire(dd, "PD1", term, "RX")
  wire(dd, "PD0", term, "TX")
  return { doc, dd, term, led }
}

function run(loop: SimLoop, state: { clock: number }, seconds: number) {
  const end = state.clock + seconds * 1000
  while (state.clock < end) {
    state.clock = Math.min(end, state.clock + 30)
    loop.advance(state.clock)
  }
}
function start(doc: ReturnType<typeof bench>["doc"]) {
  const loop = new SimLoop()
  const state = { clock: 0 }
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  loop.advance(0)
  return { loop, state }
}

describe("ATmega328P on the bench: 16 MHz crystal, LED, serial terminal", () => {
  const b = bench()
  const { loop, state } = start(b.doc)
  const pb5 = () => loop.snapshot()!.pinVoltage[pinKey(b.dd.id, "PB5")]

  beforeAll(() => run(loop, state, 2.3))

  it("runs at 16 MHz from the crystal with the fuses from the .fuse section", () => {
    const st = loop.snapshot()!.mcus[b.dd.id]
    expect(st.running).toBe(true)
    expect(st.sysclk).toBe(16e6)
    expect(st.labels?.clock).toBe("crystal")
  })

  it("prints a tick a second at 9600 baud without framing errors", () => {
    const t = loop.snapshot()!.terminals[b.term.id]
    expect(t.text).toMatch(/^tick 0\r\ntick 1\r\n/)
    expect(t.framingErrors).toBe(0)
  })

  it("blinks the LED: PB5 spends about half of each second high", () => {
    let high = 0
    let n = 0
    for (let i = 0; i < 100; i++) {
      run(loop, state, 0.01)
      n++
      if (pb5() > 2.5) high++
    }
    expect(high / n).toBeGreaterThan(0.3)
    expect(high / n).toBeLessThan(0.7)
  })

  it("echoes typed text upper-cased", () => {
    loop.sendSerial(b.term.id, "avr")
    run(loop, state, 0.05)
    expect(loop.snapshot()!.terminals[b.term.id].text.replace(/tick \d+\r\n/g, "")).toBe("AVR")
  })

  it("idles in SLEEP between interrupts: the supply current is well under the active figure", () => {
    const st = loop.snapshot()!.mcus[b.dd.id]
    // Table 29-8: active ≈ 10.4 mA at 16 MHz, Idle ≈ 2.4 mA.
    expect(st.power.current).toBeLessThan(5e-3)
    expect(st.power.asleep).toBeGreaterThan(0.9)
  })

  it("holding RESET low stops the core; releasing it restarts the program", () => {
    const before = loop.snapshot()!.mcus[b.dd.id].resets
    // RESET to ground instead of through R1 to +5 V.
    const doc = structuredClone(b.doc)
    const gnd = doc.objects.find((o) => o.def === "ground")!
    doc.wires = doc.wires.map((w) => (w.from.object === b.dd.id && w.from.pin === "PC6" ? { ...w, to: { object: gnd.id, pin: "GND" } } : w))
    loop.setDoc(doc)
    run(loop, state, 0.05)
    const held = loop.snapshot()!.mcus[b.dd.id]
    expect(held.powered).toBe(false)
    run(loop, state, 0.05)
    expect(loop.snapshot()!.mcus[b.dd.id].instructions).toBe(held.instructions)
    loop.setDoc(b.doc)
    run(loop, state, 0.2)
    const st = loop.snapshot()!.mcus[b.dd.id]
    expect(st.powered).toBe(true)
    expect(st.resets).toBeGreaterThan(before)
    expect(st.labels?.reset).toBe("RESET pin")
  })
})

describe("the same chip without its crystal", () => {
  it("does not run, and says why: the fuses select the crystal oscillator", () => {
    const b = bench({ crystal: false })
    const { loop, state } = start(b.doc)
    run(loop, state, 0.3)
    const st = loop.snapshot()!.mcus[b.dd.id]
    expect(st.sysclk).toBe(0)
    expect(st.clock.problems.join(" ")).toMatch(/no crystal on XTAL1\/XTAL2/)
    expect(loop.snapshot()!.terminals[b.term.id].text).toBe("")
  })

  it("runs on the internal RC once the fuse field selects it (low 0xE2: 8 MHz)", () => {
    const b = bench({ crystal: false })
    b.dd.props = { ...b.dd.props, fuseLow: "E2" }
    const { loop, state } = start(b.doc)
    run(loop, state, 0.5)
    const st = loop.snapshot()!.mcus[b.dd.id]
    expect(st.running).toBe(true)
    expect(st.sysclk).toBe(8e6)
    expect(st.labels?.clock).toBe("internal RC")
  })
})

describe("RESET as I/O or dW line: grounding PC6 does not reset the part", () => {
  it.each([
    ["59", "RSTDISBL programmed: PC6 is an I/O pin (Table 28-7)"],
    ["99", "DWEN programmed: the pin is the debugWIRE line (§25.5)"],
  ])("high fuse 0x%s — %s", (high) => {
    const b = bench()
    b.dd.props = { ...b.dd.props, fuseHigh: high }
    const gnd = b.doc.objects.find((o) => o.def === "ground")!
    b.doc.wires = b.doc.wires.map((w) => (w.from.object === b.dd.id && w.from.pin === "PC6" ? { ...w, to: { object: gnd.id, pin: "GND" } } : w))
    const { loop, state } = start(b.doc)
    run(loop, state, 1.2)
    const st = loop.snapshot()!.mcus[b.dd.id]
    expect(st.powered).toBe(true)
    expect(loop.snapshot()!.terminals[b.term.id].text).toMatch(/^tick 0\r\n/)
  })
})

describe("ATmega328P in TQFP-32: the analog-only ADC6 reads its net", () => {
  it("a 10 k / 10 k divider on ADC6 and 5 V on ADC0 read 512 and 1023 against AVCC", () => {
    const { doc, place, wire } = builder(GRID)
    const chip = getDef("atmega328p-au")!
    const y = (pin: string) => chip.pins.find((p) => p.id === pin)!.y
    const R = chip.width
    const dd = place("atmega328p-au", 0, 0, { firmware: "avr-adc.elf", firmwareData: exampleBase64("avr-adc.elf") })
    const v5 = place("supply", -9, y("VCC") - 3, { value: "+5V", voltage: "5 V" })
    const gnd = place("ground", -9, y("GND") + 2)
    wire(v5, "V", dd, "VCC")
    wire(v5, "V", dd, "AVCC")
    wire(dd, "GND", gnd, "GND")
    wire(v5, "V", dd, "PC0")
    const top = place("resistor", -12, y("ADC6") - 3, { ref: "R1", value: "10 kΩ", power: "0.25" }, 90)
    const bottom = place("resistor", -12, y("ADC6") + 1, { ref: "R2", value: "10 kΩ", power: "0.25" }, 90)
    wire(v5, "V", top, "1")
    wire(top, "2", dd, "ADC6")
    wire(dd, "ADC6", bottom, "1")
    wire(bottom, "2", gnd, "GND")
    const zq = place("crystal", R + 6, y("PB6") - 2, { ref: "ZQ1", value: "16 MHz" }, 90)
    wire(dd, "PB6", zq, "1")
    wire(dd, "PB7", zq, "2")
    const term = place("serial-terminal", R + 6, y("PD1") + 2, { baud: "9600" })
    wire(dd, "PD1", term, "RX")
    const { loop, state } = start(doc)
    run(loop, state, 0.5)
    const lines = loop.snapshot()!.terminals[term.id].text.split("\r\n").filter((l) => l.startsWith("A0="))
    expect(lines.length).toBeGreaterThan(2)
    const last = lines[lines.length - 1]
    const [, a0, a6] = /^A0=(\d+) A6=(\d+)$/.exec(last)!.map(Number)
    expect(a0).toBe(1023)
    // ±2 LSB: the divider's own resistance against the ADC's sample-and-hold and the 10-bit step.
    expect(Math.abs(a6 - 512)).toBeLessThanOrEqual(2)
  })
})
