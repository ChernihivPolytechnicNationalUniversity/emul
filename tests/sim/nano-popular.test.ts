/**
 * The circuits people build first on an Arduino Nano, as published, wired as published, with
 * the published sketches and libraries unmodified (fetched and built by `pnpm firmware-arduino`
 * through the build service's own code: firmware/arduino/build.ts lists every source and pin).
 * Each must do on the bench what its tutorial says it does:
 *
 *   Blink, AnalogReadSerial, Fade, Button, Debounce, StateChangeDetection, toneMelody — the
 *     Arduino built-in examples (docs.arduino.cc/built-in-examples)
 *   Servo Sweep and Knob (Servo 1.2.2), LiquidCrystal HelloWorld (1.0.7),
 *   LiquidCrystal_I2C HelloWorld (johnrickman 1.1.3), Adafruit_NeoPixel simple (1.15.5),
 *   Adafruit_SSD1306 ssd1306_128x64_i2c (2.5.17), Keypad HelloKeypad (3.1.1) — the libraries'
 *     own examples
 *   ShftOut11 (docs.arduino.cc guide to shiftOut), the KY-040 sketch of lastminuteengineers.com
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PartState, type PlacedObject, type Schematic } from "@/schematic/types"
import type { AddressableSnapshot } from "@/sim/addressable/chain"
import type { BuzzerSnapshot } from "@/sim/buzzer"
import type { LcdSnapshot } from "@/sim/hd44780"
import { SimLoop } from "@/sim/loop"
import type { ServoSnapshot } from "@/sim/servo"
import { FIRMWARE } from "../lib/firmware"

const BUILD = join(FIRMWARE, "arduino", "build")
function sketch(name: string) {
  const path = join(BUILD, `${name}.elf`)
  if (!existsSync(path)) throw new Error(`${path} is missing — build the sketches with \`pnpm firmware-arduino\``)
  return readFileSync(path).toString("base64")
}

/** Arduino pin names → the Nano's header pins (J1: TX1…D12, J2: VIN…D13). */
const PIN: Record<string, string> = {
  D0: "J1-2", D1: "J1-1", D2: "J1-5", D3: "J1-6", D4: "J1-7", D5: "J1-8", D6: "J1-9", D7: "J1-10", D8: "J1-11", D9: "J1-12",
  D10: "J1-13", D11: "J1-14", D12: "J1-15", D13: "J2-15", A0: "J2-12", A1: "J2-11", A2: "J2-10", A3: "J2-9", A4: "J2-8", A5: "J2-7",
  "5V": "J2-4", GND: "J2-2", "3V3": "J2-14",
}

type Bench = ReturnType<typeof builder> & { nano: PlacedObject; term: PlacedObject; at: (pin: string) => [PlacedObject, string] }

function nanoBench(name: string, wire: (b: Bench) => void) {
  const b = builder(GRID)
  const nano = b.place("arduino-nano", 0, 0, { firmware: `${name}.elf`, firmwareData: sketch(name) })
  const term = b.place("serial-terminal", 4, -10, { baud: "9600" })
  b.wire(nano, "VCP-TX", term, "RX")
  b.wire(nano, "VCP-RX", term, "TX")
  const bench: Bench = { ...b, nano, term, at: (pin) => [nano, PIN[pin]] }
  wire(bench)
  return start(b.doc, bench)
}

function start(initial: Schematic, b: Bench) {
  let doc = initial
  const loop = new SimLoop()
  let parts: Record<string, PartState> = { ...doc.parts }
  loop.setDoc(doc)
  loop.setParts(parts)
  loop.setRunning(true)
  loop.advance(0)
  let clock = 0
  const run = (seconds: number, each?: () => void, stepMs = 10) => {
    const end = clock + seconds * 1000
    while (clock < end - 1e-9) {
      clock = Math.min(end, clock + stepMs)
      loop.advance(clock)
      each?.()
    }
  }
  const set = (object: PlacedObject, part: string, state: PartState) => {
    parts = { ...parts, [partKey(object.id, part)]: state }
    loop.setParts(parts)
  }
  /** A field changed in the inspector: a new document with the object's new props. */
  const setProps = (object: PlacedObject, props: Record<string, string>) => {
    doc = { ...doc, objects: doc.objects.map((o) => (o.id === object.id ? { ...o, props: { ...o.props, ...props } } : o)) }
    loop.setDoc(doc)
  }
  const snap = () => loop.snapshot()!
  const volts = (pin: string) => snap().pinVoltage[pinKey(b.nano.id, PIN[pin])]
  const lines = () => snap().terminals[b.term.id].text.split("\r\n")
  const time = () => clock / 1000
  return { loop, run, set, setProps, snap, volts, lines, time, ...b }
}

/** A part wired between a Nano pin and a part pin, by Arduino pin name. */
const to = (b: Bench, pin: string, part: PlacedObject, partPin: string) => b.wire(...b.at(pin), part, partPin)

/** LED with its series resistor from a pin to ground: the circuit of every LED example. */
function ledOn(b: Bench, pin: string, ohms: string, x: number, y: number) {
  const r = b.place("resistor", x, y, { value: ohms })
  const led = b.place("led", x + 6, y, { value: "red" })
  const g = b.place("ground", x + 12, y + 2)
  to(b, pin, r, "1")
  b.wire(r, "2", led, "1")
  b.wire(led, "2", g, "GND")
  return led
}

/** Button from D2 to 5V with a 10 kΩ pull-down, LED with 220 Ω on D13 (docs: Button, Debounce, StateChangeDetection). */
function buttonCircuit(b: Bench) {
  const sw = b.place("pushbutton", 16, 4)
  const pd = b.place("resistor", 16, 10, { value: "10 kΩ" }, 90)
  const g = b.place("ground", 16, 16)
  to(b, "5V", sw, "1")
  to(b, "D2", sw, "2")
  to(b, "D2", pd, "1")
  b.wire(pd, "2", g, "GND")
  return { sw, led: ledOn(b, "D13", "220 Ω", -16, 4) }
}

/** Edges of a pin's level, from samples every `stepMs`. */
function edges(samples: { t: number; v: number }[], threshold: number) {
  const out: { t: number; high: boolean }[] = []
  for (let i = 1; i < samples.length; i++) {
    const was = samples[i - 1].v > threshold
    const now = samples[i].v > threshold
    if (was !== now) out.push({ t: samples[i].t, high: now })
  }
  return out
}

describe("Blink (built-in example)", () => {
  it("L on D13 is on for a second and off for a second", () => {
    const t = nanoBench("blink", () => {})
    const samples: { t: number; v: number }[] = []
    t.run(5, () => samples.push({ t: t.time(), v: t.volts("D13") }), 5)
    const e = edges(samples, 2.5)
    const gaps = e.slice(1).map((x, i) => x.t - e[i].t)
    expect(gaps.length).toBeGreaterThanOrEqual(3)
    for (const g of gaps) expect(g).toBeCloseTo(1, 1)
    expect(t.snap().parts[partKey(t.nano.id, "L")].level).toBeGreaterThanOrEqual(0)
  })
})

describe("AnalogReadSerial (built-in example): a 10 kΩ pot's wiper on A0", () => {
  it("prints the wiper's position as 0–1023 at 9600 baud", () => {
    let pot!: PlacedObject
    const t = nanoBench("analog-read-serial", (b) => {
      pot = b.place("potentiometer", 16, 4, { pos: "0.5" })
      const g = b.place("ground", 22, 10)
      to(b, "5V", pot, "1")
      b.wire(pot, "2", g, "GND")
      to(b, "A0", pot, "W")
    })
    t.run(0.5)
    // The last line may still be on the wire: the one before it is whole.
    const last = () => Number(t.lines().slice(0, -1).filter((l) => /^\d+$/.test(l)).at(-1))
    expect(last()).toBeGreaterThan(505)
    expect(last()).toBeLessThan(518)
    // The wiper's position counts from pin 1, the 5 V end: a quarter of the way down reads ¾ of full scale.
    t.setProps(pot, { pos: "0.25" })
    t.run(0.2)
    expect(Math.abs(last() - 767)).toBeLessThan(6)
    expect(t.snap().terminals[t.term.id].framingErrors).toBe(0)
  })
})

describe("Fade (built-in example): LED and 220 Ω on D9", () => {
  it("D9's PWM duty climbs and falls in steps of 5/255 every 30 ms", () => {
    let led!: PlacedObject
    const t = nanoBench("fade", (b) => (led = ledOn(b, "D9", "220 Ω", 16, 4)))
    const level: number[] = []
    t.run(3.2, () => level.push(t.snap().parts[partKey(led.id, "LED")]?.level ?? 0), 30)
    const max = Math.max(...level)
    const min = Math.min(...level.slice(10))
    expect(max).toBeGreaterThan(0.5)
    expect(min).toBeLessThan(0.1)
    // One full fade up and down is 2 × 51 steps × 30 ms ≈ 3.06 s: a maximum and a minimum inside 3.2 s.
    const peak = level.indexOf(max) * 0.03
    expect(peak).toBeGreaterThan(1.2)
    expect(peak).toBeLessThan(1.9)
  })
})

describe("Button (built-in example)", () => {
  it("the LED on D13 follows the button", () => {
    let c!: ReturnType<typeof buttonCircuit>
    const t = nanoBench("button", (b) => (c = buttonCircuit(b)))
    t.run(0.1)
    expect(t.volts("D13")).toBeLessThan(0.5)
    t.set(c.sw, "SW", { pressed: true })
    t.run(0.05)
    expect(t.volts("D13")).toBeGreaterThan(4)
    t.set(c.sw, "SW", { pressed: false })
    t.run(0.05)
    expect(t.volts("D13")).toBeLessThan(0.5)
  })
})

describe("Debounce (built-in example)", () => {
  // A press made on the field lasts at least 50 ms (the loop's MIN_PRESS, so a click reaches
  // firmware that polls): the sketch's "shorter than 50 ms" case cannot be clicked, only bounce.
  it("starts lit and toggles once per press held past 50 ms, a bouncing contact included", () => {
    let c!: ReturnType<typeof buttonCircuit>
    const t = nanoBench("debounce", (b) => {
      c = buttonCircuit(b)
      c.sw.props = { ...c.sw.props, bounce: "on", tbounce: "5 ms" }
    })
    t.run(0.1)
    expect(t.volts("D13")).toBeGreaterThan(4)
    for (const expected of [false, true, false]) {
      t.set(c.sw, "SW", { pressed: true })
      t.run(0.15, undefined, 1)
      t.set(c.sw, "SW", { pressed: false })
      t.run(0.15, undefined, 1)
      expect(t.volts("D13") > 2.5).toBe(expected)
    }
  })
})

describe("StateChangeDetection (built-in example)", () => {
  it("counts the pushes over serial and lights the LED every fourth", () => {
    let c!: ReturnType<typeof buttonCircuit>
    const t = nanoBench("state-change", (b) => (c = buttonCircuit(b)))
    t.run(0.1)
    for (let n = 1; n <= 4; n++) {
      t.set(c.sw, "SW", { pressed: true })
      t.run(0.12)
      t.set(c.sw, "SW", { pressed: false })
      t.run(0.12)
      expect(t.volts("D13") > 2.5, `LED after push ${n}: ${JSON.stringify(t.lines())}`).toBe(n % 4 === 0)
    }
    const text = t.lines().filter(Boolean)
    expect(text.slice(0, 3)).toEqual(["on", "number of button pushes: 1", "off"])
    expect(text).toContain("number of button pushes: 4")
  })
})

describe("toneMelody (built-in example): a passive piezo on D8", () => {
  it("plays C4 G3 G3 A3 G3 – B3 C4 once at their pitches", () => {
    let bz!: PlacedObject
    const t = nanoBench("tone-melody", (b) => {
      bz = b.place("buzzer-pkm17epp-2002-b0", 16, 4)
      const g = b.place("ground", 22, 10)
      to(b, "D8", bz, "1")
      b.wire(bz, "2", g, "GND")
    })
    const heard: { t: number; tone: number }[] = []
    t.run(2.8, () => {
      const s = t.snap().digital[bz.id] as BuzzerSnapshot
      if (s.tone) heard.push({ t: t.time(), tone: s.tone })
    })
    // Notes in order, a change counted when the pitch moves by more than 2 %.
    const notes: number[] = []
    for (const h of heard) if (!notes.length || Math.abs(h.tone - notes.at(-1)!) / h.tone > 0.02) notes.push(h.tone)
    const expected = [262, 196, 220, 196, 247, 262]
    expect(notes.length, heard.filter((_, i) => i % 5 === 0).map((h) => `${h.t.toFixed(2)}:${h.tone.toFixed(0)}`).join(" ")).toBe(expected.length)
    notes.forEach((n, i) => expect(Math.abs(n - expected[i]) / expected[i], `note ${i + 1}: ${n.toFixed(1)} Hz`).toBeLessThan(0.01))
    // It plays once, in setup(): silent afterwards.
    t.run(0.5)
    expect((t.snap().digital[bz.id] as BuzzerSnapshot).tone).toBeNull()
  })
})

describe("Servo Sweep and Knob (Servo 1.2.2): an SG90 on D9", () => {
  const servoBench = (name: string, extra?: (b: Bench) => PlacedObject) => {
    let servo!: PlacedObject
    let pot: PlacedObject | undefined
    const t = nanoBench(name, (b) => {
      servo = b.place("servo-sg90", 16, 4)
      to(b, "D9", servo, "SIG")
      to(b, "5V", servo, "VCC")
      to(b, "GND", servo, "GND")
      pot = extra?.(b)
    })
    return { ...t, servo, pot: pot!, s: () => t.snap().digital[servo.id] as ServoSnapshot }
  }

  it("Sweep: 50 Hz pulses from 544 to 2400 µs, the horn swinging end to end", () => {
    const t = servoBench("servo-sweep")
    let lo = Infinity
    let hi = 0
    const periods = new Set<number>()
    // From the second pulse on: the first "period" runs from power-up to the first pulse.
    t.run(0.3)
    t.run(6, () => {
      const s = t.s()
      if (s.pulse) {
        lo = Math.min(lo, s.pulse)
        hi = Math.max(hi, s.pulse)
      }
      if (s.period) periods.add(Math.round(s.period * 1e4) / 10)
    })
    expect(lo * 1e6).toBeCloseTo(544, -1)
    expect(hi * 1e6).toBeCloseTo(2400, -1)
    for (const p of periods) expect(p).toBeCloseTo(20, 0)
  })

  it("Knob: the pot on A0 sets the pulse, 544 µs at one end and 2400 µs at the other", () => {
    const t = servoBench("servo-knob", (b) => {
      const pot = b.place("potentiometer", 30, 4, { pos: "0" })
      const g = b.place("ground", 36, 10)
      to(b, "5V", pot, "1")
      b.wire(pot, "2", g, "GND")
      to(b, "A0", pot, "W")
      return pot
    })
    const at = (pos: string) => {
      t.setProps(t.pot, { pos })
      t.run(0.3)
      return t.s().pulse! * 1e6
    }
    expect(at("0")).toBeCloseTo(2400, -1)
    expect(at("1")).toBeCloseTo(544, -1)
    expect(Math.abs(at("0.5") - (544 + 2400) / 2)).toBeLessThan(15)
  })
})

const row = (s: LcdSnapshot, n: number, from = 0, count = 16) => Array.from({ length: count }, (_, c) => String.fromCharCode(s.ddram[n * 40 + from + c])).join("")

describe("LiquidCrystal HelloWorld (1.0.7): a 1602 on D12, D11, D5–D2", () => {
  it("shows hello, world! and the seconds since reset", () => {
    let lcd!: PlacedObject
    const t = nanoBench("lcd-hello", (b) => {
      lcd = b.place("lcd-1602", 16, 4)
      for (const [pin, lp] of [["D12", "RS"], ["D11", "E"], ["D5", "D4"], ["D4", "D5"], ["D3", "D6"], ["D2", "D7"]]) to(b, pin, lcd, lp)
      for (const lp of ["VDD", "A"]) to(b, "5V", lcd, lp)
      for (const lp of ["VSS", "RW", "K"]) to(b, "GND", lcd, lp)
      const pot = b.place("potentiometer", 16, 20, { pos: "0.8" })
      const g = b.place("ground", 22, 26)
      to(b, "5V", pot, "1")
      b.wire(pot, "2", g, "GND")
      b.wire(pot, "W", lcd, "V0")
    })
    t.run(3.5)
    const s = t.snap().digital[lcd.id] as LcdSnapshot
    expect(row(s, 0)).toBe("hello, world!   ")
    expect(row(s, 1).trim()).toBe("3")
  })
})

describe("LiquidCrystal_I2C HelloWorld (johnrickman 1.1.3): a 1602 I²C backpack at 0x27 on A4/A5", () => {
  it("writes its four 20 × 4 rows: the two a 1602 has show, the other two land past column 16", () => {
    let lcd!: PlacedObject
    const t = nanoBench("lcd-i2c-hello", (b) => {
      lcd = b.place("lcd-1602-i2c", 16, 4)
      to(b, "A4", lcd, "SDA")
      to(b, "A5", lcd, "SCL")
      to(b, "5V", lcd, "VCC")
      to(b, "GND", lcd, "GND")
    })
    // init() twice, each with the library's delay(50) and delay(1000) before it talks to the LCD.
    t.run(2.6)
    const s = t.snap().digital[lcd.id] as LcdSnapshot
    expect(row(s, 0)).toBe("   Hello, world!")
    expect(row(s, 1, 0, 18)).toBe("  Ywrobot Arduino!")
    // A 20 × 4 display's rows 2 and 3 start at DDRAM 0x14 and 0x54: columns 20 on of lines 0 and 1.
    expect(row(s, 0, 20, 20).trimEnd()).toBe("Arduino LCM IIC 2004")
    expect(row(s, 1, 20, 19).trimEnd()).toBe("  Power By Ec-yuan!")
  })
})

describe("Adafruit_NeoPixel simple (1.15.5): a 16-LED ring on D6", () => {
  it("lights one more pixel green (0, 150, 0) every 500 ms", () => {
    let ring!: PlacedObject
    const t = nanoBench("neopixel-simple", (b) => {
      ring = b.place("led-ring-16", 16, 4)
      to(b, "D6", ring, "DIN")
      to(b, "5V", ring, "VDD")
      to(b, "GND", ring, "GND")
    })
    const lit = () => (t.snap().digital[ring.id] as AddressableSnapshot).words.filter((w) => w[0].value === 150 && w[1].value === 0 && w[2].value === 0).length
    t.run(1.25)
    const first = lit()
    t.run(1.0)
    expect(lit() - first).toBe(2)
    const s = t.snap().digital[ring.id] as AddressableSnapshot
    expect(s.faults).toEqual([])
  })
})

describe("Adafruit_SSD1306 ssd1306_128x64_i2c (2.5.17): a 128 × 64 OLED on A4/A5", () => {
  const oledBench = (address: string) => {
    let oled!: PlacedObject
    const t = nanoBench("ssd1306", (b) => {
      oled = b.place("oled-ssd1306-i2c", 16, 4, { address })
      to(b, "A4", oled, "SDA")
      to(b, "A5", oled, "SCL")
      to(b, "5V", oled, "VCC")
      to(b, "GND", oled, "GND")
    })
    type Shown = { screen: { width: number; height: number; dots: ArrayLike<number> }; warnings: string[] }
    return { ...t, shown: () => t.snap().digital[oled.id] as Shown }
  }

  it("at the sketch's 0x3D: the Adafruit splash, then the demo draws", () => {
    const t = oledBench("0x3D")
    t.run(1.2)
    const lit = (s: { screen: { dots: ArrayLike<number> } }) => Array.from(s.screen.dots).filter((d) => d > 127).length
    const splash = lit(t.shown())
    expect(splash).toBeGreaterThan(300)
    expect(t.shown().warnings).toEqual([])
    expect(t.lines().join("")).not.toContain("SSD1306 allocation failed")
  })

  it("left at the module's usual 0x3C nobody answers 0x3D: the screen stays dark, and the sketch cannot tell", () => {
    // Adafruit_SSD1306::begin() fails only when malloc() does (Adafruit_SSD1306.cpp 2.5.17): it
    // never checks the address is acknowledged, so the sketch runs on into a display that is not there.
    const t = oledBench("0x3C")
    t.run(1.5)
    expect(Array.from(t.shown().screen.dots).some((d) => d > 127)).toBe(false)
    expect(t.lines().join("")).not.toContain("SSD1306 allocation failed")
  })
})

describe("Keypad HelloKeypad (3.1.1): rows on D5–D2, columns on D8–D6", () => {
  it("prints each key as it is pressed", () => {
    let kp!: PlacedObject
    const t = nanoBench("keypad-hello", (b) => {
      kp = b.place("keypad-4x4", 16, 4)
      for (const [pin, kpin] of [["D5", "R1"], ["D4", "R2"], ["D3", "R3"], ["D2", "R4"], ["D8", "C1"], ["D7", "C2"], ["D6", "C3"]]) to(b, pin, kp, kpin)
    })
    t.run(0.2)
    // K<row><column>: 1 is K11, 5 K22, 9 K33, * K41, 0 K42, # K43.
    for (const key of ["K11", "K22", "K33", "K41", "K42", "K43"]) {
      t.set(kp, key, { pressed: true })
      t.run(0.1)
      t.set(kp, key, { pressed: false })
      t.run(0.1)
    }
    expect(t.lines().filter(Boolean)).toEqual(["1", "5", "9", "*", "0", "#"])
  })
})

describe("ShftOut11 (docs.arduino.cc): a 74HC595 counting on eight LEDs", () => {
  it("Q0–Q7 count up in binary, one step every 500 ms", () => {
    let sr!: PlacedObject
    const t = nanoBench("shiftout-hello", (b) => {
      sr = b.place("hc595", 16, 4)
      to(b, "D11", sr, "SER")
      to(b, "D12", sr, "SRCLK")
      to(b, "D8", sr, "RCLK")
      to(b, "GND", sr, "OE")
      to(b, "5V", sr, "SRCLR")
      to(b, "5V", sr, "VCC")
      to(b, "GND", sr, "GND")
      ;["QA", "QB", "QC", "QD", "QE", "QF", "QG", "QH"].forEach((q, i) => {
        const r = b.place("resistor", 30, 2 + i * 3, { value: "470 Ω" })
        const led = b.place("led", 36, 2 + i * 3, { value: "green" })
        const g = b.place("ground", 42, 4 + i * 3)
        b.wire(sr, q, r, "1")
        b.wire(r, "2", led, "1")
        b.wire(led, "2", g, "GND")
      })
    })
    const value = () => ["QA", "QB", "QC", "QD", "QE", "QF", "QG", "QH"].reduce((v, q, i) => v | ((t.snap().pinVoltage[pinKey(sr.id, q)] > 2.5 ? 1 : 0) << i), 0)
    t.run(0.25)
    const seen: number[] = []
    for (let k = 0; k < 6; k++) {
      seen.push(value())
      t.run(0.5)
    }
    for (let k = 1; k < seen.length; k++) expect(seen[k]).toBe(seen[k - 1] + 1)
  })
})

describe("KY-040 rotary encoder (lastminuteengineers.com): CLK D2, DT D3, SW D4", () => {
  // Turned clockwise a KY-040's CLK falls first and DT follows a quarter cycle later (Wokwi's
  // KY-040 docs, components101), so CLK also rises first, with DT still low. The tutorial's sketch
  // reads only CLK's rising edge and calls DT ≠ CLK counterclockwise — against its own theory
  // section (B ≠ A is clockwise, which holds on the falling edge). On the real module it counts
  // a clockwise turn down, as here.
  it("counts a clockwise turn as CCW, as the published sketch does on a real module, and the button", () => {
    let ky!: PlacedObject
    const t = nanoBench("rotary-encoder", (b) => {
      ky = b.place("ky-040", 16, 4)
      to(b, "D2", ky, "CLK")
      to(b, "D3", ky, "DT")
      to(b, "D4", ky, "SW")
      to(b, "5V", ky, "VCC")
      to(b, "GND", ky, "GND")
    })
    t.run(0.2)
    t.set(ky, "SHAFT", { turns: 3 })
    t.run(0.3)
    t.set(ky, "SHAFT", { turns: 1 })
    t.run(0.3)
    t.set(ky, "PUSH", { pressed: true })
    t.run(0.1)
    t.set(ky, "PUSH", { pressed: false })
    t.run(0.1)
    expect(t.lines().filter(Boolean)).toEqual([
      "Direction: CCW | Counter: -1",
      "Direction: CCW | Counter: -2",
      "Direction: CCW | Counter: -3",
      "Direction: CW | Counter: -2",
      "Direction: CW | Counter: -1",
      "Button pressed!",
    ])
  })
})
