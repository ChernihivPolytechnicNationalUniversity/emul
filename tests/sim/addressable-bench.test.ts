/**
 * Addressable LEDs on the bench, fed by the Nucleo WS2812 firmware (TIM1 PWM + DMA on D6, 8
 * GRB words a frame): a WS2818B driving LED strings from 12 V through its VDD resistor, a
 * WS2815B chain riding over a dead pixel on its backup line, a stick burnt by 7 V, and the
 * constant-current sinks holding their current whatever the supply.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { pinKey, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import type { AddressableSnapshot } from "@/sim/addressable/chain"
import { exampleBase64 } from "../lib/firmware"

function start(doc: Schematic) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  return {
    loop,
    run(seconds: number) {
      const end = clock + seconds * 1000
      while (clock < end) {
        clock = Math.min(end, clock + 30)
        loop.advance(clock)
      }
      return loop.snapshot()!
    },
  }
}

/** A Nucleo running the WS2812 firmware, D6 (CN10-4) the data, CN10-22 a ground. */
function nucleo(place: ReturnType<typeof builder>["place"]) {
  const u = place("nucleo-f429zi", 0, 0)
  u.props = { ...u.props, firmware: "nucleo-ws2812.elf", firmwareData: exampleBase64("nucleo-ws2812.elf") }
  return u
}

const led = (snap: ReturnType<SimLoop["snapshot"]>, id: string) => snap!.digital[id] as AddressableSnapshot

describe("addressable LEDs on the bench", () => {
  it("a WS2818B from 12 V through 3.3 kΩ sinks 16 mA through a string of three red LEDs", () => {
    const { doc, place, wire } = builder(GRID)
    const u = nucleo(place)
    const supply = place("dc-source", 60, 0, { value: "12 V", imax: "3 A" })
    const rd = place("resistor", 50, 10, { value: "3.3 kΩ", power: "0.25" })
    const ic = place("ws2818", 36, 22, { value: "WS2818B" })
    const leds = [0, 1, 2].map((i) => place("led", 50 + 6 * i, 30, { value: "red", imax: "30 mA" }))
    const gnd = place("ground", 40, 40)
    wire(u, "CN10-4", ic, "DIN")
    wire(u, "CN10-22", gnd, "GND")
    wire(ic, "BIN", gnd, "GND")
    wire(ic, "GND", gnd, "GND")
    wire(supply, "-", gnd, "GND")
    wire(supply, "+", rd, "1")
    wire(rd, "2", ic, "VDD")
    // +12 V → LED → LED → LED → OUTR: the datasheet's 12 V string.
    wire(supply, "+", leds[2], "1")
    wire(leds[2], "2", leds[1], "1")
    wire(leds[1], "2", leds[0], "1")
    wire(leds[0], "2", ic, "OUTR")
    const t = start(doc)
    const snap = t.run(0.15)
    const s = led(snap, ic.id)
    expect(snap.damage[ic.id], "the driver survives 12 V through its resistor").toBeUndefined()
    expect.soft(s.vdd, "VDD held by the built-in regulator").toBeGreaterThan(5)
    expect.soft(s.vdd).toBeLessThan(5.8)
    expect(s.frames, "frames latched (3.3 V data clears 0.5 × VDD)").toBeGreaterThan(1)
    // The firmware's first word is G=0xFF, R=0, B=step: on an RGB-order WS2818B, OUTR is full on.
    expect.soft(s.drive[0][0].duty, "OUTR duty").toBeCloseTo(1)
    const id = snap.readings.find((r) => r.object === leds[0].id && r.element === 0)
    expect(id, `LED reading (damage: ${JSON.stringify(snap.damage)})`).toBeDefined()
    expect.soft(Math.abs(id!.current) * 1e3, "string current, mA (IOL 14.5–17.5)").toBeNear(16, 1)
    expect.soft(snap.damage[leds[0].id], "LEDs not overdriven").toBeUndefined()
  })

  it("a WS2815B chain rides over a dead pixel on its backup line", () => {
    const { doc, place, wire } = builder(GRID)
    const u = nucleo(place)
    const supply = place("dc-source", 70, 0, { value: "12 V", imax: "3 A" })
    const gnd = place("ground", 50, 44)
    const px = [0, 1, 2].map((i) => place("ws2815b", 36 + 9 * i, 22, { value: "WS2815B" }))
    px[1].props = { ...px[1].props, fault: "dead" }
    wire(u, "CN10-4", px[0], "DIN")
    wire(u, "CN10-22", gnd, "GND")
    wire(supply, "-", gnd, "GND")
    wire(px[0], "BIN", gnd, "GND")
    for (const p of px) {
      wire(supply, "+", p, "VDD")
      wire(p, "GND", gnd, "GND")
    }
    // DO → next DIN; each BIN taps the previous pixel's DIN.
    wire(px[0], "DO", px[1], "DIN")
    wire(px[1], "DO", px[2], "DIN")
    wire(px[0], "DIN", px[1], "BIN")
    wire(px[1], "DIN", px[2], "BIN")
    const snap = start(doc).run(0.15)
    const [a, , c] = px.map((p) => led(snap, p.id))
    expect.soft(a.frames, "the first pixel lights").toBeGreaterThan(1)
    expect(c.input, "the third pixel moved to BIN").toBe("BIN")
    expect(c.frames, "and lights from it").toBeGreaterThan(0)
    // Word 2 of the firmware's frame: R = 64, G = 191 — the dead pixel's word 1 skipped.
    expect.soft(c.words[0][0].value, "G of word 2").toBe(191)
    expect.soft(c.words[0][1].value, "R of word 2").toBe(64)
  })

  it("the same chain without a backup line goes dark after the dead pixel", () => {
    const { doc, place, wire } = builder(GRID)
    const u = nucleo(place)
    const supply = place("dc-source", 70, 0, { value: "12 V", imax: "3 A" })
    const gnd = place("ground", 50, 44)
    const px = [0, 1, 2].map((i) => place("ws2815b-4pin", 36 + 9 * i, 22, { value: "WS2815B-4P" }))
    px[1].props = { ...px[1].props, fault: "dead" }
    wire(u, "CN10-4", px[0], "DIN")
    wire(u, "CN10-22", gnd, "GND")
    wire(supply, "-", gnd, "GND")
    for (const p of px) {
      wire(supply, "+", p, "VDD")
      wire(p, "GND", gnd, "GND")
    }
    wire(px[0], "DO", px[1], "DIN")
    wire(px[1], "DO", px[2], "DIN")
    const snap = start(doc).run(0.15)
    expect.soft(led(snap, px[0].id).frames, "the first pixel lights").toBeGreaterThan(1)
    expect(led(snap, px[2].id).frames, "the third never gets a frame").toBe(0)
  })

  it("a 5 V stick on 7 V burns: past the WS2812B-V5's 5.3 V the die shorts", () => {
    const { doc, place, wire } = builder(GRID)
    const supply = place("dc-source", 0, 0, { value: "7 V", imax: "3 A" })
    const stick = place("led-stick-8", 10, 0, { value: "WS2812B-V5" })
    const gnd = place("ground", 4, 8)
    wire(supply, "+", stick, "VDD")
    wire(supply, "-", gnd, "GND")
    wire(stick, "GND", gnd, "GND")
    const snap = start(doc).run(0.01)
    expect(snap.damage[stick.id]?.fail).toBe("short")
    expect(led(snap, stick.id).burnt).toBe(true)
  })

  it("the same stick on 5 V idles at its quiescent current", () => {
    const { doc, place, wire } = builder(GRID)
    const supply = place("dc-source", 0, 0, { value: "5 V", imax: "3 A" })
    const stick = place("led-stick-8", 10, 0, { value: "WS2812B-V5" })
    const gnd = place("ground", 4, 8)
    wire(supply, "+", stick, "VDD")
    wire(supply, "-", gnd, "GND")
    wire(stick, "GND", gnd, "GND")
    const snap = start(doc).run(0.01)
    expect(snap.damage[stick.id]).toBeUndefined()
    const s = led(snap, stick.id)
    expect(s.powered).toBe(true)
    expect(s.current * 1e3, "8 × 0.6 mA").toBeNear(4.8, 0.1)
  })

  it("a WS2801's outputs sink 0.6 V / RFB: 30 Ω sets 20 mA through a red LED from 5 V", () => {
    const { doc, place, wire } = builder(GRID)
    const supply = place("dc-source", 0, 0, { value: "5 V", imax: "3 A" })
    const ic = place("ws2801", 10, 0)
    const rfb = place("resistor", 24, 10, { value: "30 Ω", power: "0.25" })
    const red = place("led", 24, 0, { value: "red", imax: "30 mA" })
    const gnd = place("ground", 4, 20)
    wire(supply, "+", ic, "VCC")
    wire(supply, "-", gnd, "GND")
    wire(ic, "GND", gnd, "GND")
    wire(ic, "RFB", rfb, "1")
    wire(rfb, "2", gnd, "GND")
    wire(supply, "+", red, "1")
    wire(red, "2", ic, "ROUT")
    const t = start(doc)
    t.run(0.005)
    // Clock 24 bits in straight into the chip: R = 0xFF, G = B = 0.
    const part = (t.loop as unknown as { digitalParts: Map<string, { input: (pin: string, level: boolean, time: number) => void }> }).digitalParts.get(ic.id)!
    let now = (t.loop.snapshot()!.time ?? 0.005) + 1e-4
    for (let i = 0; i < 24; i++) {
      part.input("SDI", i < 8, now)
      part.input("CKI", true, now + 1e-6)
      part.input("CKI", false, now + 2e-6)
      now += 4e-6
    }
    const snap = t.run(0.02)
    const s = led(snap, ic.id)
    expect(s.drive[0][0].duty, "0xFF = 255/256").toBeCloseTo(255 / 256)
    const id = snap.readings.find((r) => r.object === red.id && r.element === 0)!
    expect(Math.abs(id.current) * 1e3, "LED current, mA (0.6 V / 30 Ω × 255/256)").toBeNear(20 * (255 / 256), 0.5)
  })

  it("a WS2815 makes its own 5 V on VCC and drives DO from it", () => {
    const { doc, place, wire } = builder(GRID)
    const supply = place("dc-source", 0, 0, { value: "12 V", imax: "3 A" })
    const px = place("ws2815", 10, 0)
    const next = place("ws2815", 22, 0)
    const gnd = place("ground", 4, 20)
    wire(supply, "+", px, "VDD")
    wire(supply, "+", next, "VDD")
    wire(supply, "-", gnd, "GND")
    wire(px, "GND", gnd, "GND")
    wire(next, "GND", gnd, "GND")
    wire(px, "DIN", gnd, "GND")
    wire(px, "BIN", gnd, "GND")
    wire(px, "DO", next, "DIN")
    const snap = start(doc).run(0.01)
    expect(snap.damage).toEqual({})
    expect(snap.pinVoltage[pinKey(px.id, "VCC")], "VCC").toBeNear(5, 0.05)
    expect(snap.pinVoltage[pinKey(px.id, "DO")], "DO idles low").toBeLessThan(0.2)
    expect(led(snap, px.id).powered).toBe(true)
  })

  it("a 6-pin WS2812 runs only with its VCC up, whatever VDD does", () => {
    const { doc, place, wire } = builder(GRID)
    const supply = place("dc-source", 0, 0, { value: "5 V", imax: "3 A" })
    const px = place("ws2812-6pin", 10, 0)
    const gnd = place("ground", 4, 20)
    wire(supply, "+", px, "VDD")
    wire(supply, "-", gnd, "GND")
    wire(px, "GND", gnd, "GND")
    let snap = start(doc).run(0.01)
    expect(led(snap, px.id).powered, "VDD only").toBe(false)
    wire(supply, "+", px, "VCC")
    snap = start(doc).run(0.01)
    expect(led(snap, px.id).powered, "VCC and VDD").toBe(true)
  })

  it("a WS2818B from 24 V through the datasheet's 7.5 kΩ settles at its regulator, and dies on 24 V direct", () => {
    const build = (direct: boolean) => {
      const { doc, place, wire } = builder(GRID)
      const supply = place("dc-source", 0, 0, { value: "24 V", imax: "3 A" })
      const ic = place("ws2818", 20, 0, { value: "WS2818B" })
      const gnd = place("ground", 4, 20)
      wire(supply, "-", gnd, "GND")
      wire(ic, "GND", gnd, "GND")
      wire(ic, "DIN", gnd, "GND")
      wire(ic, "BIN", gnd, "GND")
      if (direct) wire(supply, "+", ic, "VDD")
      else {
        const r = place("resistor", 10, 0, { value: "7.5 kΩ", power: "0.25" })
        wire(supply, "+", r, "1")
        wire(r, "2", ic, "VDD")
      }
      return { snap: start(doc).run(0.05), ic }
    }
    const ok = build(false)
    expect(ok.snap.damage[ok.ic.id]).toBeUndefined()
    expect(led(ok.snap, ok.ic.id).vdd).toBeGreaterThan(5)
    expect(led(ok.snap, ok.ic.id).vdd).toBeLessThan(5.8)
    const dead = build(true)
    expect(dead.snap.damage[dead.ic.id], "24 V straight on VDD").toBeDefined()
  })

  it("a series resistor in the data line (330 Ω, as the datasheets advise) keeps the bits exact", () => {
    const { doc, place, wire } = builder(GRID)
    const u = nucleo(place)
    const r = place("resistor", 30, 24, { value: "330 Ω", power: "0.25" })
    const stick = place("led-stick-8", 36, 22, { value: "WS2812B-V5" })
    wire(u, "CN10-4", r, "1")
    wire(r, "2", stick, "DIN")
    wire(u, "CN8-9", stick, "VDD", [[-2, 17], [-2, -3], [43, -3]])
    wire(u, "CN10-22", stick, "GND")
    const s = led(start(doc).run(0.12), stick.id)
    expect(s.faults, "no pulse quantised to the 20 µs solver step").toEqual([])
    expect(s.frames).toBeGreaterThan(2)
    expect(s.words[0][0].value, "first pixel green as sent").toBe(0xff)
  })

  it("a resistor to an LED keeps the pin's net apart: the LED side stays analog", () => {
    const { doc, place, wire } = builder(GRID)
    const u = nucleo(place)
    const r = place("resistor", 30, 24, { value: "330 Ω", power: "0.25" })
    const red = place("led", 36, 24, { value: "red" })
    const gnd = place("ground", 40, 30)
    wire(u, "CN10-4", r, "1")
    wire(r, "2", red, "1")
    wire(red, "2", gnd, "GND")
    const snap = start(doc).run(0.02)
    expect(snap.damage).toEqual({})
  })
})
