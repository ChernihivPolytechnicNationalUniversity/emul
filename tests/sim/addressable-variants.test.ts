/**
 * The parts of the addressable family the first tests left alone: the 16-bit words, the WS291x
 * gain header (read by every chip and passed on ahead of the rest), OUTW2 following W on the
 * WS2914, the strap pins (SET's 400 kHz timing and an unmodelled mode, POL's inversion), the
 * bidirectional WS2812B-V6, BO repeating the input, and a part swap on the field.
 */
import { describe, expect, it } from "vitest"
import { chainFor, type AddressableChain, type AddressableSnapshot } from "@/sim/addressable/chain"
import { specByPart } from "@/sim/addressable/parts"
import type { ChipSpec, NrzTiming } from "@/sim/addressable/spec"

const spec = (part: string) => specByPart(part)!
const mid = (r: readonly [number, number]) => (r[0] + r[1]) / 2

type Bench = { part: AddressableChain; t: number; out: { pin: string; level: boolean | null; time: number }[] }

/** A chain powered at `supply`, its inputs seen high at `high` volts, `strap` volts on the strap pin. */
function bench(s: ChipSpec, { chips = 1, supply = 5, high = 5, strap = 0 } = {}): Bench {
  const part = chainFor("U1", s, chips)
  part.reset()
  const volts = (pin: string) => (pin === "GND" ? 0 : pin === s.strap?.pin ? strap : pin === "VDD" || pin === "VCC" ? supply : high)
  part.sense(volts, 0)
  // Every data pin seen high once by the analog side.
  for (const pin of part.pins) {
    if (part.outputs.includes(pin) && pin !== "DIN") continue
    part.input(pin, true, 1e-6)
    part.sense(volts, 1e-6)
    part.input(pin, false, 1.5e-6)
  }
  part.tick(1e-3)
  part.out.length = 0
  return { part, t: 2e-3, out: [] }
}

function send(b: Bench, timing: NrzTiming, bits: number[], pin = "DIN") {
  for (const bit of bits) {
    b.part.input(pin, true, b.t)
    b.t += bit ? mid(timing.t1h) : mid(timing.t0h)
    b.part.input(pin, false, b.t)
    b.t += bit ? mid(timing.t1l) : mid(timing.t0l)
    b.out.push(...b.part.out.splice(0))
  }
}

function latch(b: Bench, timing: NrzTiming) {
  b.t += timing.reset + 200e-6
  b.part.tick(b.t)
  return b.part.snapshot() as AddressableSnapshot
}

const bits = (value: number, n: number) => Array.from({ length: n }, (_, i) => (value >>> (n - 1 - i)) & 1)
const nrz = (s: ChipSpec) => (s.input.kind === "nrz" ? s.input.timing : null!)

/** The pulses that came out of a pin, decoded as the next chip would. */
function decoded(b: Bench, pin: string, t: NrzTiming) {
  const edges = b.out.filter((e) => e.pin === pin)
  const out: number[] = []
  for (let i = 0; i + 1 < edges.length; i++) if (edges[i].level === true && edges[i + 1].level === false) out.push(edges[i + 1].time - edges[i].time > (t.t0h[1] + t.t1h[0]) / 2 ? 1 : 0)
  return out
}

describe("16-bit words", () => {
  it("WS2816B: 48 bits GRB, 16 bits a channel", () => {
    const s = spec("WS2816B")
    const b = bench(s)
    send(b, nrz(s), [...bits(0x0100, 16), ...bits(0xffff, 16), ...bits(0x8000, 16)])
    const snap = latch(b, nrz(s))
    expect(snap.words[0].map((f) => f.value)).toEqual([0x0100, 0xffff, 0x8000])
    expect(snap.drive[0][0].duty, "R").toBeCloseTo(1)
    expect(snap.drive[0][1].duty, "G").toBeCloseTo(0x100 / 0xffff, 6)
    expect(snap.drive[0][2].duty, "B").toBeCloseTo(0x8000 / 0xffff, 4)
  })
})

describe("gain header (WS2913)", () => {
  const s = spec("WS2913")
  const t = nrz(s)
  // Header: IR IG IB (5 bits each, RGB order) and a check bit "1"; then 48-bit RGB words.
  const header = [...bits(31, 5), ...bits(15, 5), ...bits(0, 5), 1]
  const word = (r: number, g: number, b: number) => [...bits(r, 16), ...bits(g, 16), ...bits(b, 16)]

  it("reads the gains and scales each channel's current by them", () => {
    const b = bench(s, { strap: 5 })
    send(b, t, [...header, ...word(0xffff, 0xffff, 0xffff)])
    const snap = latch(b, t)
    expect(snap.header.map((f) => f.value)).toEqual([31, 15, 0])
    expect(snap.drive[0].map((d) => d.scale)).toEqual([1, 15 / 31, 0])
    expect(snap.drive[0].every((d) => d.duty === 1)).toBe(true)
    expect(snap.notes, "SET to VDD: the documented 16-bit mode").toEqual([])
  })

  it("passes the header on ahead of the words past its own", () => {
    const b = bench(s, { strap: 5 })
    send(b, t, [...header, ...word(1, 2, 3), ...word(4, 5, 6)])
    latch(b, t)
    expect(decoded(b, "DO", t)).toEqual([...header, ...word(4, 5, 6)])
  })

  it("a chain of two reads the header in both chips and passes it on once", () => {
    const b = bench(s, { chips: 2, strap: 5 })
    send(b, t, [...header, ...word(1, 2, 3), ...word(4, 5, 6), ...word(7, 8, 9)])
    const snap = latch(b, t)
    expect(snap.words.map((w) => w.map((f) => f.value))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ])
    expect(decoded(b, "DO", t)).toEqual([...header, ...word(7, 8, 9)])
  })

  it("SET left open: the 8-bit mode the datasheet does not describe is flagged", () => {
    const b = bench(s, { strap: 0 })
    send(b, t, [...header, ...word(1, 2, 3)])
    expect(latch(b, t).notes[0]).toMatch(/8-bit mode/)
  })
})

describe("WS2914: OUTW2 follows W, four channels of data", () => {
  it("takes R G B W1 after a 32-bit header", () => {
    const s = spec("WS2914")
    const t = nrz(s)
    const b = bench(s)
    const header = [...bits(31, 5), ...bits(31, 5), ...bits(31, 5), ...bits(31, 5), ...bits(0, 12)]
    send(b, t, [...header, ...bits(0, 16), ...bits(0, 16), ...bits(0, 16), ...bits(0xffff, 16)])
    const snap = latch(b, t)
    expect(snap.channels).toEqual(["R", "G", "B", "W"])
    expect(snap.drive[0][3].duty).toBe(1)
    const light = s.light.kind === "sink" ? s.light : null!
    expect(light.outputs.map((o) => o.channel)).toEqual(["R", "G", "B", "W", "W"])
  })
})

describe("strap pins", () => {
  it("WS2811 (2011): SET high takes the 400 kHz timing, open the 800 kHz one", () => {
    const s = spec("WS2811-2011")
    const slow = s.strap?.high?.kind === "timing" ? s.strap.high.timing : null!
    const fast = nrz(s)
    const word = [...bits(0xff, 8), ...bits(0x00, 8), ...bits(0x80, 8)]
    const a = bench(s, { strap: 5 })
    send(a, slow, word)
    const sa = latch(a, slow)
    expect(sa.words[0].map((f) => f.value), "400 kHz data, SET high").toEqual([0xff, 0x00, 0x80])
    expect(sa.faults).toEqual([])
    const b = bench(s, { strap: 0 })
    send(b, fast, word)
    expect(latch(b, fast).words[0].map((f) => f.value), "800 kHz data, SET open").toEqual([0xff, 0x00, 0x80])
    // 400 kHz data into a chip strapped for 800 kHz: every 0 is read as a 1.
    const c = bench(s, { strap: 0 })
    send(c, slow, word)
    expect(latch(c, fast).words[0][2].value).not.toBe(0x80)
  })

  it("WS2801: POL low inverts the outputs (the 2008 datasheet)", () => {
    const s = spec("WS2801")
    const run = (pol: number) => {
      const part = chainFor("U1", s, 1)
      part.reset()
      part.sense((pin) => (pin === "GND" ? 0 : pin === "POL" ? pol : 5), 0)
      part.input("CKI", true, 1e-6)
      part.sense((pin) => (pin === "GND" ? 0 : pin === "POL" ? pol : 5), 1e-6)
      part.input("CKI", false, 2e-6)
      part.tick(2e-3)
      let now = 3e-3
      for (const bit of [...bits(0x00, 8), ...bits(0x40, 8), ...bits(0xff, 8)]) {
        part.input("SDI", bit === 1, now)
        part.input("CKI", true, now + 1e-6)
        part.input("CKI", false, now + 2e-6)
        now += 4e-6
      }
      part.tick(now + 1e-3)
      return part.snapshot() as AddressableSnapshot
    }
    const normal = run(5)
    const inverted = run(0)
    expect(normal.drive[0][0].duty).toBe(0)
    expect(inverted.drive[0][0].duty).toBe(1)
    expect(inverted.drive[0][1].duty).toBeCloseTo(1 - 0x40 / 256)
    expect(inverted.notes[0]).toMatch(/inverted/)
  })
})

describe("WS2812B-V6: DIN and DOUT interchangeable", () => {
  const s = spec("WS2812B-V6")
  const t = nrz(s)
  const word = [...bits(0x11, 8), ...bits(0x22, 8), ...bits(0x33, 8)]
  const next = [...bits(0x44, 8), ...bits(0x55, 8), ...bits(0x66, 8)]

  it("lets both pins go until data comes", () => {
    const part = chainFor("U1", s, 1)
    part.reset()
    part.sense((pin) => (pin === "GND" ? 0 : 5), 0)
    expect(part.drive("DO")).toBe(null)
    expect(part.drive("DIN")).toBe(null)
  })

  it("fed on DOUT, takes its word there and passes the rest out of DIN", () => {
    const b = bench(s)
    // The bench saw both pins high once; start from a fresh power-on so neither is the input yet.
    b.part.reset()
    b.part.sense((pin) => (pin === "GND" ? 0 : 5), b.t)
    send(b, t, [...word, ...next], "DO")
    const snap = latch(b, t)
    expect(snap.input).toBe("DO")
    expect(snap.words[0].map((f) => f.value)).toEqual([0x11, 0x22, 0x33])
    expect(decoded(b, "DIN", t)).toEqual(next)
  })
})

describe("BO repeats the input (WS2813B-V5)", () => {
  it("every pulse the chip takes or passes comes out of BO", () => {
    const s = spec("WS2813B-V5")
    const t = nrz(s)
    const b = bench(s)
    const stream = [...bits(1, 8), ...bits(2, 8), ...bits(3, 8), ...bits(0xa5, 8)]
    send(b, t, stream)
    latch(b, t)
    expect(decoded(b, "BO", t)).toEqual(stream)
    expect(decoded(b, "DO", t)).toEqual(bits(0xa5, 8))
  })
})

describe("part swap", () => {
  it("another part number on the field asks the loop for a new chip", () => {
    const part = chainFor("U1", spec("WS2812B"), 1)
    expect(part.outdated({ value: "WS2812B" })).toBe(false)
    expect(part.outdated({ value: "WS2812B-V5" })).toBe(true)
  })
})
