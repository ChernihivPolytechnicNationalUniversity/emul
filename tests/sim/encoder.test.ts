/**
 * Rotary encoders on the bench: the shaft turned a detent walks the contacts through the code
 * the maker draws — ALPS EC11E: A before B clockwise, half a cycle per detent, a quarter-cycle per
 * 1/(4 × pulses) s (the 360°/s it is measured at); KY-040: a full cycle per detent through its
 * own 10 kΩ pull-ups — and with bounce switched on, every make and break comes as a burst.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PartState, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"

type Sample = { t: number; a: boolean; b: boolean }

/** Steps the bench in 0.1 ms slices from `turnAt` ms, the shaft turned to `turns` there; logs A and B (high = open). */
function record(doc: Schematic, obj: string, a: string, b: string, turns: number, ms: number) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const read = () => {
    const s = loop.snapshot()!
    return { a: (s.pinVoltage[pinKey(obj, a)] ?? 0) > 1.65, b: (s.pinVoltage[pinKey(obj, b)] ?? 0) > 1.65 }
  }
  while (clock < 20) loop.advance((clock += 1))
  const parts: Record<string, PartState> = { ...doc.parts, [partKey(obj, "SHAFT")]: { turns } }
  loop.setParts(parts)
  const samples: Sample[] = []
  const start = clock
  while (clock < start + ms) {
    loop.advance((clock += 0.1))
    samples.push({ t: clock - start, ...read() })
  }
  loop.dispose()
  return samples
}

/** The distinct (a, b) states in order, and when each began. */
function code(samples: Sample[]) {
  const out: { t: number; ab: string }[] = []
  for (const s of samples) {
    const ab = `${s.a ? 1 : 0}${s.b ? 1 : 0}`
    if (!out.length || out[out.length - 1].ab !== ab) out.push({ t: s.t, ab })
  }
  return out
}

function ec11(props: Record<string, string> = {}) {
  const { doc, place, wire } = builder(GRID)
  const rail = place("supply", 0, 0, { value: "+3V3", voltage: "3.3 V" })
  const enc = place("encoder-ec11", 10, 4, props)
  const gnd = place("ground", 4, 14)
  const ra = place("resistor", 4, 2, { value: "10 kΩ", power: "0.25" }, 90)
  const rb = place("resistor", 6, 2, { value: "10 kΩ", power: "0.25" }, 90)
  wire(rail, "V", ra, "1")
  wire(rail, "V", rb, "1")
  wire(ra, "2", enc, "A")
  wire(rb, "2", enc, "B")
  wire(enc, "C", gnd, "GND")
  return { doc, enc }
}

describe("ALPS EC11E", () => {
  it("one detent clockwise: A closes, then B, a quarter-cycle (1/60 s at 15 pulses) apart; rests both closed", () => {
    const { doc, enc } = ec11()
    const c = code(record(doc, enc.id, "A", "B", 1, 60))
    expect(c.map((x) => x.ab)).toEqual(["11", "01", "00"])
    expect(c[1].t, "A at one quarter").toBeNear(1000 / 60, 0.2)
    expect(c[2].t - c[1].t, "B a quarter later").toBeNear(1000 / 60, 0.2)
  })

  it("one detent anticlockwise: B closes first", () => {
    const { doc, enc } = ec11()
    const c = code(record(doc, enc.id, "A", "B", -1, 60))
    expect(c.map((x) => x.ab)).toEqual(["11", "10", "00"])
  })

  it("two detents clockwise: a full cycle, back to both open", () => {
    const { doc, enc } = ec11()
    const c = code(record(doc, enc.id, "A", "B", 2, 100))
    expect(c.map((x) => x.ab)).toEqual(["11", "01", "00", "10", "11"])
  })

  it("36 detents / 18 pulses turns faster per quarter (1/72 s)", () => {
    const { doc, enc } = ec11({ value: "EC11E18244AU" })
    const c = code(record(doc, enc.id, "A", "B", 1, 60))
    expect(c[1].t).toBeNear(1000 / 72, 0.2)
  })

  it("bounce on: each make comes as a burst, settling within the 2 ms bounce time", () => {
    const { doc, enc } = ec11({ bounce: "on", tbounce: "2 ms" })
    const c = code(record(doc, enc.id, "A", "B", 1, 60))
    expect(c.length, "more transitions than the clean code").toBeGreaterThan(3)
    expect(c[c.length - 1].ab).toBe("00")
    const firstA = c.find((x) => x.ab[0] === "0")!.t
    const lastA = Math.max(...c.filter((x, i) => i > 0 && x.ab[0] !== c[i - 1].ab[0]).map((x) => x.t).filter((t) => t < firstA + 10))
    expect(lastA - firstA).toBeLessThanOrEqual(2.1)
  })
})

describe("KY-040", () => {
  it("one detent clockwise is a full cycle through its own pull-ups, back to both high", () => {
    const { doc, place, wire } = builder(GRID)
    const rail = place("supply", 0, 0, { value: "+3V3", voltage: "3.3 V" })
    const ky = place("ky-040", 10, 4)
    const gnd = place("ground", 4, 14)
    wire(rail, "V", ky, "VCC")
    wire(ky, "GND", gnd, "GND")
    const c = code(record(doc, ky.id, "CLK", "DT", 1, 60))
    expect(c.map((x) => x.ab)).toEqual(["11", "01", "00", "10", "11"])
    expect(c[1].t).toBeNear(1000 / 80, 0.2)
  })

  it("SW has no pull-up on the board: unpulled it floats, not high", () => {
    const { doc, place, wire } = builder(GRID)
    const rail = place("supply", 0, 0, { value: "+3V3", voltage: "3.3 V" })
    const ky = place("ky-040", 10, 4)
    const gnd = place("ground", 4, 14)
    wire(rail, "V", ky, "VCC")
    wire(ky, "GND", gnd, "GND")
    const loop = new SimLoop()
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    for (let t = 0; t <= 20; t++) loop.advance(t)
    expect(loop.snapshot()!.pinVoltage[pinKey(ky.id, "SW")] ?? 0).toBeLessThan(1)
    loop.dispose()
  })
})
