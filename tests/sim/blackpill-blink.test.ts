/**
 * The WeAct Black Pill's starting projects (src/project/template.ts) on the board models, from the prebuilt
 * images: the F411 at 100 MHz (PLL M 25, N 200, P 2), the F401CC/CE at 84 MHz (M 25, N 336, P 4, WeAct's own F401
 * examples), all from the 25 MHz crystal; C13 (PC13, lit when low) toggling every 500 ms, every 100 ms while KEY
 * (PA0, internal pull-up) is held.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { blackpillBlink, blackpillF401ccBlink, blackpillF401ceBlink } from "@/schematic/examples/discovery"
import { builder } from "@/schematic/builder"
import type { Example } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { FIRMWARE } from "../lib/firmware"

function bench(example: Example, def: string) {
  const doc = example.build(GRID)
  const u = doc.objects.find((o) => o.def === def)!
  u.props = { ...u.props, firmwareData: readFileSync(join(FIRMWARE, "prebuilt", `${example.id}.U1.elf`)).toString("base64") }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  type Core = { clocks: { hclk: number }; cpu: { halted: unknown }; bus: { read: (a: number, n: number) => number }; firmware: { symbols: { name: string; value: number }[] } }
  const core = () => (loop as unknown as { mcus: Map<string, { mcu: { mcu: Core } }> }).mcus.get(u.id)!.mcu.mcu
  const byte = (name: string) => core().bus.read(core().firmware.symbols.find((s) => s.name === name)!.value, 1)
  /** Times (s) the LED part went from dark to lit over `seconds`, sampled every 5 ms. */
  function onsets(led: string, seconds: number) {
    const out: number[] = []
    let was = false
    for (let t = 0; t < seconds * 200; t++) {
      clock += 5
      loop.advance(clock)
      const on = !!loop.snapshot()!.parts[partKey(u.id, led)]?.on
      if (on && !was) out.push(clock / 1000)
      was = on
    }
    return out
  }
  const press = (button: string, pressed: boolean) => {
    doc.parts[partKey(u.id, button)] = { pressed }
    loop.setParts(doc.parts)
  }
  const volts = (pin: string) => loop.snapshot()!.pinVoltage[pinKey(u.id, pin)]!
  return { core, onsets, press, volts, byte }
}
const periods = (t: number[]) => t.slice(1).map((x, i) => x - t[i])

describe.each([
  { example: blackpillBlink, def: "weact-blackpill-f411", hz: 100e6 },
  { example: blackpillF401ccBlink, def: "weact-blackpill-f401cc", hz: 84e6 },
  { example: blackpillF401ceBlink, def: "weact-blackpill-f401ce", hz: 84e6 },
])("$def blink", ({ example, def, hz }) => {
  const b = bench(example, def)
  it("runs at its clock from the 25 MHz HSE and blinks C13 with a 1 s period", () => {
    const on = b.onsets("C13", 3.2)
    expect(b.core().cpu.halted).toBeNull()
    expect(b.core().clocks.hclk).toBe(hz)
    expect(on.length).toBeGreaterThanOrEqual(3)
    for (const p of periods(on.slice(1))) expect(p).toBeCloseTo(1, 1)
  })
  it("reads KEY high through the internal pull-up and blinks every 200 ms while it is held", () => {
    expect(b.volts("P1-15")).toBeGreaterThan(3)
    b.press("KEY", true)
    const on = b.onsets("C13", 1.3)
    expect(on.length).toBeGreaterThanOrEqual(5)
    b.press("KEY", false)
    for (const p of periods(on.slice(1))) expect(p).toBeCloseTo(0.2, 1)
  })
})

describe("Black Pill P3 (SWD) as it comes out of reset", () => {
  it("has SWDIO (PA13) on its 40 kΩ pull-up and SWCLK (PA14) on its pull-down (RM0383 §8.3.2, §8.4.4 GPIOA_PUPDR 0x6400 0000; DS10314 Table 53 RPU/RPD 40 kΩ)", () => {
    const { place, wire, doc } = builder(GRID)
    const u = place("weact-blackpill-f411", 0, 0)
    u.props = { ...u.props, firmwareData: readFileSync(join(FIRMWARE, "prebuilt", "blackpill-blink.U1.elf")).toString("base64") }
    // 1 MΩ loads against the pulls: SWDIO to GND, SWCLK to 3V3.
    const rDio = place("resistor", 30, 2, { value: "1 MΩ" })
    const rSck = place("resistor", 30, 6, { value: "1 MΩ" })
    wire(rDio, "1", u, "P3-2")
    wire(rDio, "2", u, "P3-4")
    wire(rSck, "1", u, "P3-3")
    wire(rSck, "2", u, "P3-1")
    const loop = new SimLoop()
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    for (let t = 30; t <= 300; t += 30) loop.advance(t)
    const v = (pin: string) => loop.snapshot()!.pinVoltage[pinKey(u.id, pin)]!
    expect.soft(v("P3-2"), "SWDIO: 3.3 V × 1 M / (1 M + 40 k)").toBeNearRel((3.3 * 1e6) / 1.04e6, 0.02)
    expect.soft(v("P3-3"), "SWCLK: 3.3 V × 40 k / (1 M + 40 k)").toBeNear((3.3 * 40e3) / 1.04e6, 0.02)
  })
})

describe("Black Pill PC13 sinks at most 3 mA (DS10314 Table 8 note 2, DS9716/DS10086 the same)", () => {
  /** The blink firmware with an extra LED from 3V3 through `ohms` into C13 (PC13), which it pulls low every second. */
  function run(ohms: string) {
    const { place, wire, doc } = builder(GRID)
    const u = place("weact-blackpill-f411", 0, 0)
    u.props = { ...u.props, firmwareData: readFileSync(join(FIRMWARE, "prebuilt", "blackpill-blink.U1.elf")).toString("base64") }
    const r = place("resistor", 30, 0, { value: ohms })
    const led = place("led", 36, 0, { value: "red" })
    wire(r, "1", u, "P1-3")
    wire(r, "2", led, "1")
    wire(led, "2", u, "P1-19")
    const loop = new SimLoop()
    const failures: string[] = []
    loop.onFailure = (f) => failures.push(`${f.ref}: ${f.damage.reason}`)
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    for (let t = 30; t <= 1500; t += 30) loop.advance(t)
    return failures
  }
  it("takes a red LED through 1 kΩ (≈1.4 mA)", () => {
    expect(run("1 kΩ")).toEqual([])
  })
  it("is destroyed by one through 68 Ω (≈15 mA with the pad's own drop)", () => {
    expect(run("68 Ω")).toEqual([expect.stringMatching(/^U1: current 1\d\.\d+ mA exceeds the 3\.00 mA rating$/)])
  })
})
