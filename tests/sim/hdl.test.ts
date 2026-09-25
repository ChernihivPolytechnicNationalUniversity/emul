import { describe, expect, it } from "vitest"
import type { HdlNetlist } from "emul-shared/hdl"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { setLibrary } from "@/schematic/registry"
import { partKey, pinKey, type HdlModule, type PlacedObject } from "@/schematic/types"
import { HdlPart } from "@/sim/hdl"
import { SimLoop } from "@/sim/loop"
import counter from "./hdl/counter.json"
import ring from "./hdl/ring.json"
import shreg from "./hdl/shreg.json"
import top from "./hdl/top.json"

const module = (name: string, netlist: unknown): HdlModule => ({ id: `hdl:${name}`, name, files: [], netlist: netlist as unknown as HdlNetlist, built: name })

function part(name: string, netlist: unknown) {
  const m = module(name, netlist)
  setLibrary([m])
  return new HdlPart("U1", m.id, m.netlist!, m.built)
}

const word = (p: HdlPart, name: string, width: number) => Array.from({ length: width }, (_, i) => (p.drive(`${name}[${i}]`) ? 1 << i : 0)).reduce((a, b) => a | b, 0)

describe("hdl netlist simulation", () => {
  it("counts rising edges, resets asynchronously and drives a tri-state pin", () => {
    const p = part("counter", counter)
    let t = 0
    const pulse = () => {
      p.input("clk", true, (t += 1e-6))
      p.input("clk", false, (t += 1e-6))
    }
    p.input("rst", false, t)
    p.input("en", true, t)
    p.input("oe", false, t)
    p.input("clk", false, t)
    expect(word(p, "q", 4)).toBe(0)
    for (let i = 0; i < 5; i++) pulse()
    expect(word(p, "q", 4)).toBe(5)
    expect(p.drive("bus_io")).toBeNull()
    p.input("oe", true, t)
    expect(p.drive("bus_io")).toBe(true)
    p.input("en", false, t)
    pulse()
    expect(word(p, "q", 4)).toBe(5)
    p.input("en", true, t)
    for (let i = 0; i < 10; i++) pulse()
    expect(word(p, "q", 4)).toBe(15)
    expect(p.drive("carry")).toBe(true)
    pulse()
    expect(word(p, "q", 4)).toBe(0)
    for (let i = 0; i < 3; i++) pulse()
    p.input("rst", true, t)
    expect(word(p, "q", 4)).toBe(0)
    pulse()
    expect(word(p, "q", 4)).toBe(0)
    expect(p.out.length).toBeGreaterThan(0)
  })

  it("shifts on the falling edge from its initial value, and clears on an active-low reset", () => {
    const p = part("shreg", shreg)
    let t = 0
    p.prime(new Map([["clr_n", true], ["clk", true], ["d", false]]), t)
    expect(word(p, "q", 4)).toBe(0b1111)
    const fall = () => {
      p.input("clk", false, (t += 1e-6))
      p.input("clk", true, (t += 1e-6))
    }
    fall()
    expect(word(p, "q", 4)).toBe(0b1110)
    p.input("d", true, t)
    fall()
    expect(word(p, "q", 4)).toBe(0b1101)
    expect(p.drive("lat")).toBe(true)
    p.input("clr_n", false, t)
    expect(word(p, "q", 4)).toBe(0)
  })

  it("gives up on a combinational loop that never settles", () => {
    const p = part("ring", ring)
    p.input("en", true, 0)
    expect((p.snapshot() as { oscillating: boolean }).oscillating).toBe(true)
    p.input("en", false, 1e-6)
    expect(p.drive("y")).toBe(true)
  })
})

describe("hdl component on the bench", () => {
  const m = module("gates", top)
  const { doc, place, wire } = builder(GRID)
  doc.library = [m]
  setLibrary(doc.library)
  const vcc = place("supply", 0, 0, { value: "+5V", voltage: "5 V" })
  const u = place(m.id, 10, 0)
  const gnd = place("ground", 10, 20)
  wire(vcc, "V", u, "VCC")
  wire(u, "GND", gnd, "GND")
  const a = place("logic-state", 0, 10, { vdd: "5 V" })
  const b = place("logic-state", 0, 14, { vdd: "5 V" })
  wire(a, "OUT", u, "a")
  wire(b, "OUT", u, "b")
  const led = (pin: string, y: number) => {
    const d = place("led", 30, y, { value: "red" })
    const r = place("resistor", 36, y, { value: "330 Ω", power: "0.25" })
    wire(u, pin, d, "1")
    wire(d, "2", r, "1")
    wire(r, "2", place("ground", 42, y), "GND")
    return d
  }
  const and = led("y[0]", 4)
  const or = led("y[1]", 10)

  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) loop.advance((clock = Math.min(end, clock + 30)))
  }
  const lit = (d: PlacedObject) => (loop.snapshot()!.parts[partKey(d.id, "LED")]?.on ? 1 : 0)

  it.each([0, 1].flatMap((x) => [0, 1].map((y) => [x, y] as const)))("a=%i b=%i lights AND and OR", (x, y) => {
    loop.setParts({ [partKey(a.id, "S")]: { on: !!x }, [partKey(b.id, "S")]: { on: !!y } })
    run(0.02)
    expect([lit(and), lit(or)]).toEqual([x & y, x | y])
  })
})

describe("hdl counter clocked from the analog side", () => {
  const m = module("counter", counter)
  const { doc, place, wire } = builder(GRID)
  doc.library = [m]
  setLibrary(doc.library)
  const vcc = place("supply", 0, 0, { value: "+5V", voltage: "5 V" })
  const u = place(m.id, 10, 0)
  wire(vcc, "V", u, "VCC")
  wire(u, "GND", place("ground", 10, 30), "GND")
  const clk = place("pulse-source", 0, 10, { high: "5 V", low: "0 V", freq: "10 Hz", duty: "50" })
  wire(clk, "+", u, "clk")
  wire(clk, "-", place("ground", 0, 20), "GND")
  const level = (pin: string, on: boolean, y: number) => {
    const s = place("logic-state", 0, y, { vdd: "5 V" })
    wire(s, "OUT", u, pin)
    return [partKey(s.id, "S"), { on }] as const
  }
  const states = Object.fromEntries([level("rst", false, 24), level("en", true, 26), level("oe", false, 28)])
  const leds = [0, 1, 2, 3].map((i) => {
    const d = place("led", 30, 4 * i, { value: "green" })
    const r = place("resistor", 36, 4 * i, { value: "330 Ω", power: "0.25" })
    wire(u, `q[${i}]`, d, "1")
    wire(d, "2", r, "1")
    wire(r, "2", place("ground", 42, 4 * i), "GND")
    return d
  })

  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setProbes(leds.map((_, i) => ({ id: `q${i}`, a: pinKey(u.id, `q[${i}]`), b: null })))
  loop.setParts(states)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) loop.advance((clock = Math.min(end, clock + 30)))
  }
  const value = () => {
    const probes = loop.snapshot()!.probes
    return leds.reduce((n, _, i) => n | (probes[`q${i}`]!.v > 2.5 ? 1 << i : 0), 0)
  }

  it("counts the pulse source's rising edges", () => {
    run(0.125)
    const before = value()
    run(0.5)
    expect((value() - before + 16) % 16).toBe(5)
  })

  it("keeps counting with its inputs as they are after a rebuild mid-run", () => {
    const rebuilt = { ...doc, library: [{ ...m, built: "rebuilt" }] }
    setLibrary(rebuilt.library)
    loop.setDoc(rebuilt)
    run(0.075)
    const before = value()
    run(0.5)
    expect((value() - before + 16) % 16).toBe(5)
  })
})
