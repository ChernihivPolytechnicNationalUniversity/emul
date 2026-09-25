import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawnNodeCore } from "../../scripts/lib/core-threads"
import type { HdlNetlist } from "emul-shared/hdl"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { setLibrary } from "@/schematic/registry"
import { partKey, pinKey, type HdlModule, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { parseFirmware } from "@/mcu/elf"
import { buffer, example, exampleBase64 } from "../lib/firmware"
import ripple from "./hdl/ripple.json"
import counter from "./hdl/counter.json"
import counter2 from "./hdl/counter2.json"

function stepper(loop: SimLoop) {
  let clock = 0
  loop.setRunning(true)
  loop.advance(clock)
  return (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) loop.advance((clock = Math.min(end, clock + 30)))
  }
}

describe.each([
  ["this thread", false],
  ["a worker thread", true],
])("an HDL divider between two pins of a Nucleo, the core in %s", (_, workers) => {
  const m: HdlModule = { id: "hdl:div", name: "div", files: [], netlist: ripple as HdlNetlist, built: "div" }
  const { doc, place, wire } = builder(GRID)
  doc.library = [m]
  const u = place("nucleo-f429zi", 0, 0)
  u.props = { ...u.props, firmware: "nucleo-pwm.elf", firmwareData: exampleBase64("nucleo-pwm.elf") }
  const d = place(m.id, 60, 10)
  const vcc = place("supply", 62, 4, { value: "+3.3V", voltage: "3.3 V" })
  wire(vcc, "V", d, "VCC")
  wire(d, "GND", place("ground", 62, 22), "GND")
  wire(u, "CN10-31", d, "clk")
  wire(d, "q[0]", u, "CN10-13")

  const loop = new SimLoop()
  if (workers) loop.spawnCore = spawnNodeCore
  const failures: string[] = []
  loop.onFailure = (f) => failures.push(`${f.ref}: ${f.damage.reason}`)
  let run: (seconds: number) => void = () => {}
  const symbols = parseFirmware(buffer(example("nucleo-pwm.elf"))).symbols
  const word = async (name: string) => {
    const addr = symbols.find((s) => s.name === name)!.value
    const reply = await loop.inspect(u.id, { ranges: [{ addr, size: 4 }] })
    const b = reply!.memory[0]!.bytes
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0
  }

  beforeAll(async () => {
    setLibrary(doc.library)
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    run = stepper(loop)
    while (loop.booting) await new Promise((r) => setTimeout(r, 10))
    run(0.12)
  })
  afterAll(() => loop.setDoc({ objects: [], wires: [], parts: {} }))

  it("runs the firmware and burns nothing", () => {
    expect(loop.snapshot()!.mcus[u.id]!.running).toBe(true)
    expect(failures).toEqual([])
  })

  it("halves the 1 kHz PWM, and TIM4 capture on the MCU measures the result", async () => {
    expect(await word("captureCount")).toBeGreaterThan(20)
    expect(await word("capturePeriodUs")).toBeNearRel(2000, 0.002)
    expect(await word("captureHighUs")).toBeNearRel(1000, 0.002)
  })
})

describe("two instances of one component, rebuilt narrower while running", () => {
  const m: HdlModule = { id: "hdl:cnt", name: "cnt", files: [], netlist: counter as HdlNetlist, built: "w4" }
  const { doc, place, wire } = builder(GRID)
  doc.library = [m]
  setLibrary(doc.library)
  const vcc = place("supply", 20, 0, { value: "+5V", voltage: "5 V" })
  const clk = place("pulse-source", 0, 4, { high: "5 V", low: "0 V", freq: "20 Hz", duty: "50" })
  wire(clk, "-", place("ground", 0, 10), "GND")
  const en = place("logic-state", 0, 14, { vdd: "5 V" })
  const units = [0, 1].map((k) => {
    const x = place(m.id, 16, 6 + k * 16)
    wire(vcc, "V", x, "VCC")
    wire(x, "GND", place("ground", 20, 18 + k * 16), "GND")
    wire(clk, "+", x, "clk")
    wire(en, "OUT", x, "en")
    for (const i of [0, 3]) {
      const d = place("led", 40, 6 + k * 16 + i * 3, { value: "red" })
      const r = place("resistor", 46, 6 + k * 16 + i * 3, { value: "330 Ω", power: "0.25" })
      wire(x, `q[${i}]`, d, "1")
      wire(d, "2", r, "1")
      wire(r, "2", place("ground", 52, 6 + k * 16 + i * 3), "GND")
    }
    return x
  })
  const loop = new SimLoop()
  const failures: string[] = []
  loop.onFailure = (f) => failures.push(`${f.ref}: ${f.damage.reason}`)
  loop.setDoc(doc)
  loop.setParts({ [partKey(en.id, "S")]: { on: true } })
  const run = stepper(loop)
  const probes = units.flatMap((x, k) => [0, 1, 3].map((i) => ({ id: `u${k}q${i}`, a: pinKey(x.id, `q[${i}]`), b: null })))
  loop.setProbes(probes)
  const q = (k: number, bits: number[]) => bits.reduce((n, i) => n | ((loop.snapshot()!.probes[`u${k}q${i}`]?.v ?? 0) > 2.5 ? 1 << i : 0), 0)

  it("counts in both instances independently of each other's state", () => {
    loop.setDoc(doc)
    run(0.225)
    const a = q(0, [0, 1])
    const b = q(1, [0, 1])
    run(0.1)
    expect((q(0, [0, 1]) - a + 4) % 4).toBe(2)
    expect((q(1, [0, 1]) - b + 4) % 4).toBe(2)
  })

  it("keeps running when the component is rebuilt with fewer pins than its wires reach", () => {
    const narrow: Schematic = { ...doc, library: [{ ...m, netlist: counter2 as HdlNetlist, built: "w2" }] }
    setLibrary(narrow.library)
    expect(() => loop.setDoc(narrow)).not.toThrow()
    run(0.05)
    const a = q(0, [0, 1])
    run(0.1)
    expect((q(0, [0, 1]) - a + 4) % 4).toBe(2)
    expect(loop.snapshot()!.probes.u0q3?.v ?? 0).toBeLessThan(0.5)
    expect(failures).toEqual([])
  })
})
