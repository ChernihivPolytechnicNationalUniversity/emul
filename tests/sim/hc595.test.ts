import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { ShiftRegister595, type ShiftRegisterSnapshot } from "@/sim/hc595"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { exampleBase64 as fw } from "../lib/firmware"
import { nucleoShiftRegister } from "@/schematic/timers"

const OUTPUTS = ["QA", "QB", "QC", "QD", "QE", "QF", "QG", "QH"]

function chip(part = "74HC595", vcc = 5) {
  const c = new ShiftRegister595("u1", { value: part })
  const levels: Record<string, boolean> = { SER: false, SRCLK: false, RCLK: false, SRCLR: true, OE: false }
  for (const [pin, level] of Object.entries(levels)) c.input(pin, level, 0)
  c.senseSupply(vcc, () => (vcc ? 0 : NaN), 0)
  c.input("SRCLR", false, 1e-6)
  c.input("SRCLR", true, 2e-6)
  let t = 10e-6
  const clock = (pin: "SRCLK" | "RCLK", at = (t += 1e-6)) => {
    c.input(pin, true, at)
    c.input(pin, false, at + 0.5e-6)
  }
  const shiftIn = (bits: number[]) => {
    for (const bit of bits) {
      c.input("SER", bit === 1, (t += 1e-6))
      clock("SRCLK")
    }
  }
  const outputs = () => OUTPUTS.map((q) => c.drive(q))
  const snap = () => c.snapshot()
  const at = () => (t += 1e-6)
  return { c, clock, shiftIn, outputs, snap, at, sense: (v: number, read: (pin: string) => number = () => 0) => c.senseSupply(v, read, at()) }
}

describe("74HC595 logic (TI SCLS041J function table)", () => {
  it("shifts SER into QA on each SRCLK rise and moves the rest on", () => {
    const k = chip()
    const storage = k.snap().storage
    k.shiftIn([1, 0, 1, 1])
    expect.soft(k.snap().shift, "QA holds the last bit in, QD the first").toBe(0b1011)
    expect.soft(k.snap().storage, "storage untouched").toBe(storage)
  })

  it("copies the shift register to QA–QH on RCLK", () => {
    const k = chip()
    k.shiftIn([1, 0, 0, 0, 0, 0, 0, 1])
    k.clock("RCLK")
    expect.soft(k.outputs()).toEqual([true, false, false, false, false, false, false, true])
  })

  it("puts the last stage on QH' at once, not through the latch", () => {
    const k = chip()
    k.shiftIn([1, 0, 0, 0, 0, 0, 0])
    expect.soft(k.c.drive("QHS"), "seven clocks").toBe(false)
    k.shiftIn([0])
    expect.soft(k.c.drive("QHS"), "eighth clock").toBe(true)
  })

  it("clears the shift register on /SRCLR low and leaves the storage register", () => {
    const k = chip()
    k.shiftIn([1, 1, 1, 1, 1, 1, 1, 1])
    k.clock("RCLK")
    k.c.input("SRCLR", false, k.at())
    expect.soft(k.snap().shift).toBe(0)
    expect.soft(k.snap().storage).toBe(0xff)
    k.c.input("SER", true, k.at())
    k.clock("SRCLK")
    expect.soft(k.snap().shift, "SRCLK ignored while cleared").toBe(0)
  })

  it("floats QA–QH with /OE high and keeps QH' driven", () => {
    const k = chip()
    k.shiftIn([1, 1, 1, 1, 1, 1, 1, 1])
    k.clock("RCLK")
    k.c.input("OE", true, k.at())
    expect.soft(k.outputs()).toEqual(OUTPUTS.map(() => null))
    expect.soft(k.c.drive("QHS")).toBe(true)
    k.c.input("OE", false, k.at())
    expect.soft(k.outputs()).toEqual(OUTPUTS.map(() => true))
  })

  it("with the clocks tied together the storage register runs one clock behind", () => {
    const k = chip()
    for (const bit of [1, 1, 0]) {
      k.c.input("SER", bit === 1, k.at())
      const t = k.at()
      k.c.input("SRCLK", true, t)
      k.c.input("RCLK", true, t)
      k.c.input("SRCLK", false, t + 0.5e-6)
      k.c.input("RCLK", false, t + 0.5e-6)
    }
    expect.soft(k.snap().shift).toBe(0b110)
    expect.soft(k.snap().storage, "one behind").toBe(0b11)
  })

  it("samples the level SER had before an edge that arrives at the same instant or later", () => {
    const k = chip()
    const t = k.at()
    k.c.input("SER", true, t + 20e-9)
    k.c.input("SRCLK", true, t)
    expect.soft(k.snap().shift & 1, "SER changed after the clock").toBe(0)
  })

  it("drives its outputs a propagation delay after the clock", () => {
    const k = chip("74HC595", 4.5)
    k.shiftIn([1])
    k.c.out.length = 0
    const t = k.at()
    k.c.input("RCLK", true, t)
    const edge = k.c.out.find((e) => e.pin === "QA")!
    expect.soft((edge.time - t) * 1e9, "RCLK to QA (ns)").toBeNear(17, 1)
  })

  it("comes up with whatever it powers up with, and nothing driven without power", () => {
    const seen = new Set<number>()
    for (let n = 0; n < 6; n++) {
      const c = new ShiftRegister595(`chip-${n}`, {})
      c.input("SRCLR", true, 0)
      c.senseSupply(5, () => 0, 0)
      seen.add(c.snapshot().storage)
    }
    expect.soft(seen.size, "different chips, different contents").toBeGreaterThan(2)
    const k = chip()
    k.sense(0.5)
    expect.soft(k.snap().powered).toBe(false)
    expect.soft(k.c.drive("QHS")).toBe(null)
    expect.soft(k.outputs()).toEqual(OUTPUTS.map(() => null))
  })

  it("powers up cleared while /SRCLR is held low", () => {
    const c = new ShiftRegister595("held", {})
    c.input("SRCLR", false, 0)
    c.senseSupply(5, () => 0, 0)
    expect.soft(c.snapshot().shift).toBe(0)
  })
})

describe("74HC595 timing checks (TI SCLS041J at 25 °C, 4.5 V)", () => {
  const warnings = (k: ReturnType<typeof chip>) => k.snap().warnings.join(" | ")

  it("is quiet at 1 µs per bit", () => {
    const k = chip("74HC595", 4.5)
    k.shiftIn([1, 0, 1, 1, 0, 0, 1, 0])
    k.clock("RCLK")
    expect.soft(warnings(k)).toBe("")
  })

  it("flags SER changing 10 ns before SRCLK, inside the 20 ns set-up time", () => {
    const k = chip("74HC595", 4.5)
    const t = k.at()
    k.c.input("SER", true, t)
    k.c.input("SRCLK", true, t + 10e-9)
    expect.soft(warnings(k)).toMatch(/SER changed 10\.00 ns before SRCLK rose; it needs 20\.00 ns/)
  })

  it("flags SER changing on the clock edge itself", () => {
    const k = chip("74HC595", 4.5)
    const t = k.at()
    k.c.input("SER", true, t)
    k.c.input("SRCLK", true, t)
    expect.soft(warnings(k)).toMatch(/hold time/)
    expect.soft(k.snap().shift & 1, "the old level is shifted").toBe(0)
  })

  it("flags a 10 ns SRCLK pulse, under the 16 ns minimum", () => {
    const k = chip("74HC595", 4.5)
    const t = k.at()
    k.c.input("SRCLK", true, t)
    k.c.input("SRCLK", false, t + 10e-9)
    expect.soft(warnings(k)).toMatch(/SRCLK pulse narrower/)
  })

  it("flags an HCT's SER changing 1 ns after SRCLK, inside its 3 ns hold", () => {
    const k = chip("74HCT595", 5)
    const t = k.at()
    k.c.input("SRCLK", true, t)
    k.c.input("SER", true, t + 1e-9)
    expect.soft(warnings(k)).toMatch(/SER changed 1\.00 ns after SRCLK rose; it must hold 3\.00 ns/)
  })

  it("flags RCLK 5 ns after SRCLK, inside the 15 ns set-up", () => {
    const k = chip("74HC595", 4.5)
    const t = k.at()
    k.c.input("SRCLK", true, t)
    k.c.input("RCLK", true, t + 5e-9)
    expect.soft(warnings(k)).toMatch(/RCLK rose 5\.00 ns after SRCLK/)
  })

  it("flags SRCLK 5 ns after /SRCLR releases, inside the 10 ns recovery", () => {
    const k = chip("74HC595", 4.5)
    const t = k.at()
    k.c.input("SRCLR", false, t)
    k.c.input("SRCLR", true, t + 1e-6)
    k.c.input("SRCLK", true, t + 1e-6 + 5e-9)
    expect.soft(warnings(k)).toMatch(/too soon after \/SRCLR/)
  })

  it("is slower at 2 V: 50 ns from RCLK to the outputs", () => {
    const k = chip("74HC595", 2)
    k.shiftIn([1])
    k.c.out.length = 0
    const t = k.at()
    k.c.input("RCLK", true, t)
    expect.soft((k.c.out.find((e) => e.pin === "QA")!.time - t) * 1e9).toBeNear(50, 1)
  })
})

type Run = { loop: SimLoop; run: (seconds: number, each?: (s: Snapshot) => void) => Snapshot }
function start(doc: Schematic): Run {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  return {
    loop,
    run: (seconds, each) => {
      const end = clock + seconds * 1000
      while (clock < end) {
        clock = Math.min(end, clock + 1)
        loop.advance(clock)
        if (each) each(loop.snapshot()!)
      }
      return loop.snapshot()!
    },
  }
}

function bench(vcc: number, part = "74HC595") {
  const b = builder(GRID)
  const u = b.place("hc595", 20, 10, { value: part })
  const supply = b.place("dc-source", 0, 10, { value: `${vcc} V`, rint: "10 mΩ", imax: "5 A" })
  const gnd = b.place("ground", 0, 40)
  b.wire(supply, "+", u, "VCC")
  b.wire(supply, "-", gnd, "GND")
  b.wire(u, "GND", gnd, "GND")
  let row = 0
  const resistor = (value: string, a: [PlacedObject, string], c: [PlacedObject, string]) => {
    const r = b.place("resistor", 40, 2 + 3 * row++, { value, power: "2" })
    b.wire(a[0], a[1], r, "1")
    b.wire(r, "2", c[0], c[1])
    return r
  }
  const source = (volts: number, pin: [PlacedObject, string], rint = "10 mΩ") => {
    const s = b.place("dc-source", 60, 2 + 3 * row++, { value: `${volts} V`, rint })
    b.wire(s, "+", pin[0], pin[1])
    b.wire(s, "-", gnd, "GND")
    return s
  }
  const clock = (freq: string, pins: string[], high = vcc) => {
    const p = b.place("pulse-source", 60, 2 + 3 * row++, { high: `${high} V`, low: "0 V", freq, rint: "10 Ω" })
    b.wire(p, "-", gnd, "GND")
    for (const pin of pins) b.wire(p, "+", u, pin)
    return p
  }
  return { ...b, u, supply, gnd, resistor, source, clock }
}

const shiftSnap = (s: Snapshot, u: PlacedObject) => s.digital[u.id] as ShiftRegisterSnapshot
const volts = (s: Snapshot, u: PlacedObject, pin: string) => s.pinVoltage[pinKey(u.id, pin)] ?? 0

function filled(vcc: number, ser: "VCC" | "GND", part = "74HC595", oe: "VCC" | "GND" = "GND") {
  const b = bench(vcc, part)
  b.wire(b.u, "SER", ser === "VCC" ? b.u : b.gnd, ser)
  b.wire(b.u, "SRCLR", b.u, "VCC")
  b.wire(b.u, "OE", oe === "VCC" ? b.u : b.gnd, oe)
  b.clock("1 kHz", ["SRCLK", "RCLK"])
  return b
}

describe("74HC595 outputs and inputs on the bench", () => {
  it.each([
    [4.5, "717 Ω", 0.006, 4.3, 3.98],
    [6, "740 Ω", 0.0078, 5.8, 5.48],
  ] as const)("sources at %d V into %s: VOH near typical, over the minimum", (vcc, load, amps, typ, min) => {
    const b = filled(vcc, "VCC")
    b.resistor(load, [b.u, "QA"], [b.gnd, "GND"])
    const s = start(b.doc).run(0.02)
    expect.soft(shiftSnap(s, b.u).storage).toBe(0xff)
    const voh = volts(s, b.u, "QA")
    expect.soft(voh / Number.parseFloat(load) / (load.includes("k") ? 1e3 : 1), "load current").toBeNearRel(amps, 0.05)
    expect.soft(voh, "VOH").toBeGreaterThan(min)
    expect.soft(voh, "VOH").toBeNear(typ, 0.08)
  })

  it.each([
    [4.5, "722 Ω", 0.17, 0.26],
    [6, "750 Ω", 0.15, 0.26],
  ] as const)("sinks at %d V through %s: VOL near typical, under the maximum", (vcc, load, typ, max) => {
    const b = filled(vcc, "GND")
    b.resistor(load, [b.u, "VCC"], [b.u, "QB"])
    const s = start(b.doc).run(0.02)
    expect.soft(shiftSnap(s, b.u).storage).toBe(0)
    const vol = volts(s, b.u, "QB")
    expect.soft(vol, "VOL").toBeLessThan(max)
    expect.soft(vol, "VOL").toBeNear(typ, 0.06)
  })

  it.each([
    [2, 1.1, 1.3, "74HC595"],
    [4.5, 2.3, 2.5, "74HC595"],
    [6, 3.1, 3.3, "74HC595"],
    [5, 1.5, 1.7, "74HCT595"],
  ] as const)("switches its inputs at the typical level at %d V: %d V reads low, %d V high (%s)", (vcc, low, high, part) => {
    for (const [level, want] of [
      [low, 0],
      [high, 0xff],
    ] as const) {
      const b = bench(vcc, part)
      b.source(level, [b.u, "SER"])
      b.wire(b.u, "SRCLR", b.u, "VCC")
      b.wire(b.u, "OE", b.gnd, "GND")
      b.clock("1 kHz", ["SRCLK", "RCLK"])
      expect.soft(shiftSnap(start(b.doc).run(0.02), b.u).storage, `SER at ${level} V`).toBe(want)
    }
  })

  it("warns that 3.3 V logic into an HC at 5 V sits in the undefined band, and not into an HCT", () => {
    for (const [part, warned] of [
      ["74HC595", true],
      ["74HCT595", false],
    ] as const) {
      const b = bench(5, part)
      b.source(3.3, [b.u, "SER"])
      b.wire(b.u, "SRCLR", b.u, "VCC")
      b.wire(b.u, "OE", b.gnd, "GND")
      b.clock("1 kHz", ["SRCLK", "RCLK"], 3.3)
      const w = shiftSnap(start(b.doc).run(0.05), b.u).warnings.join(" | ")
      if (warned) expect.soft(w, part).toMatch(/SER at 3\.30 V sits between VIL 1\.50 V and VIH 3\.50 V/)
      else expect.soft(w, part).toBe("")
    }
  })

  it("warns about a clock edge that takes milliseconds", () => {
    const b = bench(5)
    b.wire(b.u, "SER", b.u, "VCC")
    b.wire(b.u, "SRCLR", b.u, "VCC")
    b.wire(b.u, "OE", b.gnd, "GND")
    const p = b.place("pulse-source", 60, 30, { high: "5 V", low: "0 V", freq: "50 Hz", rint: "10 Ω" })
    b.wire(p, "-", b.gnd, "GND")
    b.resistor("100 kΩ", [p, "+"], [b.u, "SRCLK"])
    const c = b.place("capacitor", 50, 30, { value: "100 nF" })
    b.wire(c, "1", b.u, "SRCLK")
    b.wire(c, "2", b.gnd, "GND")
    let seen = ""
    start(b.doc).run(0.1, (s) => (seen += shiftSnap(s, b.u).warnings.join(" | ")))
    expect.soft(seen).toMatch(/SRCLK spends more than one solver step between VIL and VIH/)
  })

  it("warns about an input left open", () => {
    const b = bench(5)
    b.wire(b.u, "SER", b.u, "VCC")
    b.wire(b.u, "OE", b.gnd, "GND")
    b.clock("1 kHz", ["SRCLK", "RCLK"])
    expect.soft(shiftSnap(start(b.doc).run(0.01), b.u).warnings.join(" | ")).toMatch(/\/SRCLR is not connected/)
  })

  it("lets an external divider set QA with /OE high, while QH' stays driven", () => {
    const b = filled(5, "VCC", "74HC595", "VCC")
    b.resistor("10 kΩ", [b.u, "VCC"], [b.u, "QA"])
    b.resistor("10 kΩ", [b.u, "QA"], [b.gnd, "GND"])
    b.resistor("1 kΩ", [b.u, "QHS"], [b.gnd, "GND"])
    const s = start(b.doc).run(0.02)
    expect.soft(shiftSnap(s, b.u).enabled).toBe(false)
    expect.soft(volts(s, b.u, "QA"), "QA floats to the divider").toBeNear(2.5, 0.01)
    expect.soft(volts(s, b.u, "QHS"), "QH' still high").toBeGreaterThan(4.7)
  })

  it("is unpowered at 0.7 V, and warns under 2 V and for an HCT away from 5 V", () => {
    const off = filled(0.7, "VCC")
    const dead = start(off.doc).run(0.01)
    expect.soft(shiftSnap(dead, off.u).powered).toBe(false)
    expect.soft(volts(dead, off.u, "QA"), "nothing driven").toBeLessThan(0.05)
    const low = filled(1.8, "VCC")
    expect.soft(shiftSnap(start(low.doc).run(0.01), low.u).warnings.join(" | ")).toMatch(/below the 2\.00 V minimum/)
    const hct = filled(3.3, "VCC", "74HCT595")
    expect.soft(shiftSnap(start(hct.doc).run(0.01), hct.u).warnings.join(" | ")).toMatch(/below the 4\.50 V minimum/)
  })

  it("chains through QH' into a second chip: sixteen bits", () => {
    const b = bench(5)
    const u2 = b.place("hc595", 20, 40)
    b.wire(u2, "VCC", b.u, "VCC")
    b.wire(u2, "GND", b.gnd, "GND")
    b.wire(b.u, "SER", b.u, "VCC")
    b.wire(u2, "SER", b.u, "QHS")
    b.clock("1 kHz", ["SRCLK", "RCLK"])
    b.wire(u2, "SRCLK", b.u, "SRCLK")
    b.wire(u2, "RCLK", b.u, "SRCLK")
    b.wire(b.u, "OE", b.gnd, "GND")
    b.wire(u2, "OE", b.gnd, "GND")
    b.resistor("10 kΩ", [b.u, "VCC"], [b.u, "SRCLR"])
    const por = b.place("capacitor", 50, 40, { value: "1 µF" })
    b.wire(por, "1", b.u, "SRCLR")
    b.wire(por, "2", b.gnd, "GND")
    b.wire(u2, "SRCLR", b.u, "SRCLR")
    const ones = (v: number) => v.toString(2).split("").filter((c) => c === "1").length
    const seen: [number, number][] = []
    const last = start(b.doc).run(0.04, (s) => seen.push([shiftSnap(s, b.u).shift, shiftSnap(s, u2).shift]))
    for (const [first, second] of seen.slice(15)) if (first !== 0xff) expect.soft(second, `second chip while the first holds ${first.toString(2)}`).toBe(0)
    expect.soft(seen.some(([first, second]) => first === 0xff && ones(second) > 0 && second !== 0xff), "the second chip filling").toBe(true)
    expect.soft([shiftSnap(last, b.u).shift, shiftSnap(last, u2).shift], "both full").toEqual([0xff, 0xff])
  })
})

describe("74HC595 in company", () => {
  it("latches before a clear that one chip's output sends the other a propagation delay after the shared clock", () => {
    const b = bench(5)
    const u2 = b.place("hc595", 20, 40)
    b.wire(u2, "VCC", b.u, "VCC")
    b.wire(u2, "GND", b.gnd, "GND")
    const control = b.place("pulse-source", 70, 40, { high: "5 V", low: "0 V", freq: "2 Hz", duty: "50", rint: "10 Ω" })
    b.wire(control, "-", b.gnd, "GND")
    b.wire(control, "+", b.u, "SER")
    b.wire(b.u, "SRCLR", b.u, "VCC")
    b.wire(b.u, "OE", b.gnd, "GND")
    b.clock("100 Hz", ["SRCLK", "RCLK"])
    b.wire(u2, "SRCLK", b.u, "SRCLK")
    b.wire(u2, "RCLK", b.u, "SRCLK")
    b.wire(u2, "SER", u2, "VCC")
    b.wire(u2, "OE", b.gnd, "GND")
    b.wire(u2, "SRCLR", b.u, "QA")
    const t = start(b.doc)
    let latched: number | null = null
    let cleared = false
    t.run(0.32, (s) => {
      const a = shiftSnap(s, b.u)
      const c = shiftSnap(s, u2)
      if (s.time > 0.25 && !cleared && c.shift === 0) {
        cleared = true
        latched = c.storage
      }
      void a
    })
    expect.soft(cleared, "QA fell and cleared the second chip").toBe(true)
    expect.soft(latched, "its storage took the full register on the same edge").toBe(0xff)
  })

  it("reads a 2 V chip's high as the low it is on a 6 V supply, and says why", () => {
    const b = bench(6)
    const lowSupply = b.place("dc-source", 70, 40, { value: "2 V", rint: "10 mΩ" })
    b.wire(lowSupply, "-", b.gnd, "GND")
    const u2 = b.place("hc595", 20, 40)
    b.wire(u2, "VCC", lowSupply, "+")
    b.wire(u2, "GND", b.gnd, "GND")
    b.wire(u2, "SER", u2, "VCC")
    b.wire(u2, "SRCLR", u2, "VCC")
    b.wire(u2, "OE", b.gnd, "GND")
    b.clock("1 kHz", ["SRCLK", "RCLK"])
    const lowClock = b.place("pulse-source", 70, 50, { high: "2 V", low: "0 V", freq: "1 kHz", rint: "10 Ω" })
    b.wire(lowClock, "-", b.gnd, "GND")
    b.wire(lowClock, "+", u2, "SRCLK")
    b.wire(lowClock, "+", u2, "RCLK")
    b.wire(b.u, "SER", u2, "QHS")
    b.resistor("680 Ω", [u2, "QHS"], [b.gnd, "GND"])
    b.wire(b.u, "SRCLR", b.u, "VCC")
    b.wire(b.u, "OE", b.gnd, "GND")
    let warned = ""
    const s = start(b.doc).run(0.04, (x) => (warned += shiftSnap(x, b.u).warnings.join(" | ")))
    expect.soft(volts(s, b.u, "SER"), "QH' of the 2 V chip under 680 Ω").toBeLessThan(2)
    expect.soft(shiftSnap(s, b.u).storage, "read as zeros").toBe(0)
    expect.soft(warned).toMatch(/SER is driven high but sits at/)
  })

  it("rates its pins against its own ground: a 5 V supply floating 10 V up is fine", () => {
    const b = builder(GRID)
    const u = b.place("hc595", 20, 10)
    const gnd = b.place("ground", 0, 40)
    const lift = b.place("dc-source", 0, 20, { value: "10 V", rint: "10 mΩ" })
    const supply = b.place("dc-source", 0, 10, { value: "5 V", rint: "10 mΩ" })
    b.wire(lift, "-", gnd, "GND")
    b.wire(lift, "+", supply, "-")
    b.wire(supply, "+", u, "VCC")
    b.wire(supply, "-", u, "GND")
    b.wire(u, "SER", u, "VCC")
    b.wire(u, "SRCLR", u, "VCC")
    b.wire(u, "OE", u, "GND")
    const clk = b.place("pulse-source", 40, 10, { high: "15 V", low: "10 V", freq: "1 kHz", rint: "10 Ω" })
    b.wire(clk, "-", gnd, "GND")
    b.wire(clk, "+", u, "SRCLK")
    b.wire(clk, "+", u, "RCLK")
    const r = b.place("resistor", 50, 10, { value: "10 kΩ" })
    b.wire(u, "QA", r, "1")
    b.wire(r, "2", u, "GND")
    const s = start(b.doc).run(0.02)
    expect.soft(s.damage[u.id], "no damage").toBeUndefined()
    expect.soft(shiftSnap(s, u).storage).toBe(0xff)
    expect.soft(volts(s, u, "QA") - volts(s, u, "GND"), "QA high against its own ground").toBeGreaterThan(4.8)
  })
})

describe("74HC595 physics", () => {
  it("burns an output shorted to ground while it drives high", () => {
    const b = filled(5, "VCC")
    const sw = b.place("switch", 50, 30)
    b.wire(b.u, "QC", sw, "1")
    b.wire(sw, "2", b.gnd, "GND")
    b.doc.parts[partKey(sw.id, "SW")] = { on: true }
    const s = start(b.doc).run(1)
    expect.soft(s.damage[b.u.id]?.reason).toMatch(/current/)
  })

  it("dies at 8 V on VCC, over the 7 V absolute maximum", () => {
    const b = filled(8, "VCC")
    expect.soft(start(b.doc).run(0.01).damage[b.u.id]?.reason).toMatch(/voltage/)
  })

  it("reports more than 70 mA through VCC when eight LEDs take 13 mA each", () => {
    const b = filled(5, "VCC")
    for (const q of OUTPUTS) {
      const led = b.place("led", 70, 2 + 3 * OUTPUTS.indexOf(q), { value: "red" })
      b.resistor("220 Ω", [b.u, q], [led, "1"])
      b.wire(led, "2", b.gnd, "GND")
    }
    const s = start(b.doc).run(0.02)
    const link = s.readings.find((r) => r.object === b.u.id && r.element === 0)!
    expect.soft(Math.abs(link.current), "VCC current").toBeGreaterThan(0.07)
    expect.soft(s.damage[b.u.id], "not destroyed by it").toBeUndefined()
  })

  it("takes 9 V on an input through 1 kΩ on its clamp diode, and burns the clamp through 68 Ω", () => {
    for (const [r, burns] of [
      ["1 kΩ", false],
      ["68 Ω", true],
    ] as const) {
      const b = bench(5)
      b.wire(b.u, "SER", b.u, "VCC")
      b.wire(b.u, "SRCLR", b.u, "VCC")
      b.clock("1 kHz", ["SRCLK", "RCLK"])
      const s9 = b.place("dc-source", 70, 30, { value: "9 V", rint: "10 mΩ" })
      b.wire(s9, "-", b.gnd, "GND")
      b.resistor(r, [s9, "+"], [b.u, "OE"])
      const snap = start(b.doc).run(1.5)
      if (burns) expect.soft(snap.damage[b.u.id]?.reason, r).toMatch(/current/)
      else {
        expect.soft(snap.damage[b.u.id], r).toBeUndefined()
        expect.soft(volts(snap, b.u, "OE"), "clamped near VCC + 0.7 V").toBeLessThan(5.8)
      }
    }
  })

  it("powers up through an input clamp when VCC is left open", () => {
    const b = builder(GRID)
    const u = b.place("hc595", 20, 10)
    const gnd = b.place("ground", 0, 40)
    const s5 = b.place("dc-source", 0, 10, { value: "5 V", rint: "10 mΩ" })
    b.wire(u, "GND", gnd, "GND")
    b.wire(s5, "-", gnd, "GND")
    const r = b.place("resistor", 10, 10, { value: "1 kΩ" })
    b.wire(s5, "+", r, "1")
    b.wire(r, "2", u, "SER")
    const snap = shiftSnap(start(b.doc).run(0.01), u)
    expect.soft(snap.powered, "phantom-powered").toBe(true)
    expect.soft(snap.vcc, "a clamp drop below SER").toBeGreaterThan(4.2)
    expect.soft(snap.vcc, "a clamp drop below SER").toBeLessThan(4.95)
  })
})

describe("74HC595 on an STM32's SPI", () => {
  it("latches the master's bytes: SCK on SRCLK, MOSI on SER, chip select on RCLK", () => {
    const b = builder(GRID)
    const n = b.place("nucleo-f429zi", 0, 0)
    const u = b.place("hc595", 40, 10)
    b.wire(n, "CN8-7", u, "VCC")
    b.wire(n, "CN8-11", u, "GND")
    b.wire(n, "CN7-14", u, "SER")
    b.wire(n, "CN7-10", u, "SRCLK")
    b.wire(n, "CN7-16", u, "RCLK")
    b.wire(u, "SRCLR", u, "VCC")
    b.wire(u, "OE", u, "GND")
    n.props = { ...n.props, firmware: "nucleo-spi-master.elf", firmwareData: fw("nucleo-spi-master.elf") }
    const t = start(b.doc)
    const seen = new Set<number>()
    let warnings = ""
    t.run(0.3, (s) => {
      const k = shiftSnap(s, u)
      if (!k) return
      seen.add(k.storage)
      warnings += k.warnings.join(" | ")
    })
    const bytes = [...seen].filter((v) => v >= 0xa0 && v <= 0xaf)
    expect.soft(bytes.length, "0xA0 + n latched").toBeGreaterThan(5)
    expect.soft(warnings, "1.4 MHz is well inside the timing").toBe("")
  })
})

describe("the Nucleo + 74HC595 example", () => {
  it("runs one lit LED along QA → QH, 125 ms a step", () => {
    const doc = nucleoShiftRegister.build(GRID)
    const n = doc.objects.find((o) => o.def === "nucleo-f429zi")!
    const u = doc.objects.find((o) => o.def === "hc595")!
    const leds = doc.objects.filter((o) => o.def === "led")
    n.props = { ...n.props, firmware: "nucleo-shift.elf", firmwareData: fw("nucleo-shift.elf") }
    const t = start(doc)
    const order: number[] = []
    t.run(1.2, (s) => {
      const lit = leds.map((led) => s.parts[partKey(led.id, "LED")]?.on ?? false)
      const k = lit.indexOf(true)
      if (lit.filter(Boolean).length === 1 && order[order.length - 1] !== k) order.push(k)
    })
    expect.soft(order.length, "steps seen in 1.2 s").toBeGreaterThan(7)
    for (let k = 1; k < order.length; k++) expect.soft(order[k], `step ${k}`).toBe((order[k - 1] + 1) % 8)
    const s = t.run(0.01)
    expect.soft(shiftSnap(s, u).warnings, "3.3 V logic on a 3.3 V chip").toEqual([])
  })
})
