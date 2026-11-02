/**
 * The F405 boards' examples on their board models, from the prebuilt images: the Olimex
 * STM32-H405's starting project and the Netduino Plus 2's (firmware/netduino), both at 168 MHz,
 * the H405 from 8 MHz and the Netduino from its 25 MHz crystal.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STM32F405RG } from "@/mcu/chip"
import { builder } from "@/schematic/builder"
import { h405Blink, netduinoBlink } from "@/schematic/examples/discovery"
import type { Example } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { FIRMWARE } from "../lib/firmware"
import { EYE_SETTLED } from "../lib/eye"

function bench(example: Example, def: string, bridges: Record<string, { on: boolean }> = {}) {
  const doc = example.build(GRID)
  const u = doc.objects.find((o) => o.def === def)!
  for (const [id, state] of Object.entries(bridges)) doc.parts[partKey(u.id, id)] = state
  u.props = { ...u.props, firmwareData: readFileSync(join(FIRMWARE, "prebuilt", `${example.id}.U1.elf`)).toString("base64") }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  type Core = {
    clocks: { hclk: number }
    cpu: { halted: { reason?: string } | null; pc: number; sleeping: boolean }
    bus: { read: (a: number, n: number) => number; memoryAt: (a: number) => { name: string } | null }
    firmware: { symbols: { name: string; value: number }[] }
    unmodelled: { features: Map<string, number> }
  }
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

describe("STM32-H405 blink", () => {
  const b = bench(h405Blink, "olimex-stm32-h405")
  it("runs at 168 MHz and blinks STAT with a 1 s period", () => {
    const on = b.onsets("STAT", 3.2)
    expect(on.length).toBeGreaterThanOrEqual(3)
    expect(b.core().cpu.halted).toBeNull()
    expect(b.core().clocks.hclk).toBe(168e6)
    for (const p of periods(on.slice(1))) expect(p).toBeCloseTo(1, 1)
  })
  it("blinks every 200 ms while BUT is held", () => {
    b.press("BUT", true)
    const on = b.onsets("STAT", 1.3)
    expect(on.length).toBeGreaterThanOrEqual(5)
    b.press("BUT", false)
    for (const p of periods(on.slice(1))) expect(p).toBeCloseTo(0.2, 1)
  })
})

describe("STM32-H405 boot bridges, sampled at RESET (the first start after programming is the programmer's own)", () => {
  function afterReset(bridges: Record<string, { on: boolean }>, seconds: number) {
    const b = bench(h405Blink, "olimex-stm32-h405", bridges)
    b.onsets("STAT", 0.1)
    b.press("RESET", true)
    b.onsets("STAT", EYE_SETTLED)
    b.press("RESET", false)
    const blinks = b.onsets("STAT", seconds)
    const core = b.core()
    return { blinks, atZero: core.bus.memoryAt(0)?.name, pc: core.cpu.pc, sleeping: core.cpu.sleeping, halted: core.cpu.halted, features: [...core.unmodelled.features.keys()], system: STM32F405RG.flash.system }
  }
  it("boots system memory with B0 on B0_H: system memory aliased at 0, the core asleep in the stub that stands in for ST's bootloader (not modelled, and said so), STAT dark", () => {
    const got = afterReset({ B0: { on: true } }, 1.5)
    expect.soft(got.atZero, "aliased at 0").toBe("SYSTEM")
    expect.soft(got.pc >= got.system.base && got.pc < got.system.base + got.system.size, `PC 0x${got.pc.toString(16)} in system memory`).toBe(true)
    expect.soft(got.halted, "not halted").toBeNull()
    expect.soft(got.sleeping, "asleep on the stub's WFI").toBe(true)
    expect.soft(got.features, "reported").toContain("system bootloader (BOOT0 high)")
    expect.soft(got.blinks, "STAT dark").toEqual([])
  })
  it("boots SRAM with both bridges high: SRAM aliased at 0, its empty vector table stops the core, STAT dark", () => {
    const got = afterReset({ B0: { on: true }, B1: { on: true } }, 1.5)
    expect.soft(got.atZero, "aliased at 0").toBe("SRAM")
    expect.soft(got.halted, "stopped on SRAM's empty vectors").not.toBeNull()
    expect.soft(got.features, "not the bootloader").not.toContain("system bootloader (BOOT0 high)")
    expect.soft(got.blinks, "STAT dark").toEqual([])
  })
  it("ignores B1 while B0 is low: flash aliased at 0, and STAT blinks", () => {
    const got = afterReset({ B1: { on: true } }, 2.2)
    expect.soft(got.atZero, "aliased at 0").toBe("FLASH")
    expect.soft(got.blinks.length, "STAT blinks").toBeGreaterThanOrEqual(2)
  })
})

describe("STM32-H405 losing its LM1117 on VIN (TI LM1117 §7.1: 20 V absolute maximum)", () => {
  const { doc, place, wire } = builder(GRID)
  const u = place("olimex-stm32-h405", 0, 0)
  doc.parts[partKey(u.id, "USB")] = { on: false }
  u.props = { ...u.props, firmwareData: readFileSync(join(FIRMWARE, "prebuilt", `${h405Blink.id}.U1.elf`)).toString("base64") }
  const vin = place("dc-source", 80, 0, { value: "5 V" })
  const gnd = place("ground", 80, 10)
  wire(vin, "+", u, "EXT2-26")
  wire(vin, "-", gnd, "GND")
  wire(gnd, "GND", u, "EXT2-25")
  const loop = new SimLoop()
  const failures: { fatal: boolean; reason: string }[] = []
  loop.onFailure = (f) => failures.push({ fatal: f.damage.fatal, reason: f.damage.reason })
  let clock = 0
  const restart = () => {
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
  }
  const core = () => (loop as unknown as { mcus: Map<string, { burnt: boolean; mcu: { mcu: { cpu: { halted: { reason?: string } | null } } } }> }).mcus.get(u.id)!
  function onsets(seconds: number) {
    const out: number[] = []
    let was = false
    for (let t = 0; t < seconds * 200; t++) {
      clock += 5
      loop.advance(clock)
      const on = !!loop.snapshot()!.parts[partKey(u.id, "STAT")]?.on
      if (on && !was) out.push(clock / 1000)
      was = on
    }
    return out
  }
  const rail = () => loop.snapshot()!.pinVoltage[pinKey(u.id, "EXT1-5")]!

  it("blinks from 5 V on VIN", () => {
    restart()
    expect(onsets(2.2).length).toBeGreaterThanOrEqual(2)
  })

  it("at 24 V the regulator fails open and the rail goes dead, but the F405 is unpowered, not burnt", () => {
    vin.props = { ...vin.props, value: "24 V" }
    restart()
    onsets(0.1)
    const blinks = onsets(1)
    expect.soft(failures, "one non-fatal failure, the regulator's").toEqual([{ fatal: false, reason: expect.stringMatching(/^voltage 2[34]\.\d+ V exceeds the 20\.00 V rating$/) }])
    expect.soft(rail(), "the rail").toBeLessThan(0.5)
    expect.soft(blinks, "STAT dark").toEqual([])
    expect.soft(core().burnt, "the die is not dead").toBe(false)
    expect.soft(core().mcu.mcu.cpu.halted, "not halted").toBeNull()
  })

  it("runs the firmware again once a bench supply feeds the 3.3V rail past the dead regulator", () => {
    const bench = place("dc-source", 80, 30, { value: "3.3 V", rint: "0.01 Ω" })
    const benchGnd = place("ground", 80, 40)
    wire(bench, "+", u, "EXT1-5")
    wire(bench, "-", benchGnd, "GND")
    wire(benchGnd, "GND", u, "EXT1-6")
    restart()
    const blinks = onsets(2.2)
    expect.soft(rail(), "the rail").toBeNear(3.3, 0.01)
    expect.soft(blinks.length, "STAT blinks again").toBeGreaterThanOrEqual(2)
    expect.soft(core().mcu.mcu.cpu.halted, "not halted").toBeNull()
    expect.soft(loop.snapshot()!.damage[u.id]?.fatal, "the board's damage stays the regulator's").toBe(false)
  })

  it("burns the F405 out once that supply goes to 6 V, past VDD's 4.0 V absolute maximum (DS8626 Table 11), on top of the regulator", () => {
    const bench = doc.objects.filter((o) => o.def === "dc-source").at(-1)!
    bench.props = { ...bench.props, value: "6 V" }
    restart()
    onsets(0.2)
    const damage = loop.snapshot()!.damage[u.id]
    expect.soft(damage?.fatal, "fatal now").toBe(true)
    expect.soft(failures[1], "the F405's own failure, after the regulator's").toEqual({ fatal: true, reason: "voltage 6.00 V exceeds the 4.00 V rating" })
    expect.soft(core().burnt, "the die is dead").toBe(true)
    expect.soft(String(core().mcu.mcu.cpu.halted), "halted as burnt out").toMatch(/burnt out: voltage 6\.00 V exceeds the 4\.00 V rating/)
  })
})

describe("Netduino Plus 2 blink", () => {
  const b = bench(netduinoBlink, "netduino-plus-2")
  it("runs at 168 MHz from 25 MHz, switches the header rails on and blinks the blue LED with a 1 s period", () => {
    const on = b.onsets("LED", 3.2)
    expect(on.length).toBeGreaterThanOrEqual(3)
    expect(b.core().cpu.halted).toBeNull()
    expect(b.core().clocks.hclk).toBe(168e6)
    expect(b.volts("3V3")).toBeGreaterThan(3.2)
    expect(b.volts("5V")).toBeGreaterThan(4.8)
    for (const p of periods(on.slice(1))) expect(p).toBeCloseTo(1, 1)
  })
  it("powers the ENC28J60 (PC15 low), waits for CLKRDY and reads EREVID = 06h, silicon B7 (DS80349C Table 1)", () => {
    expect(b.byte("enc_estat") & 1).toBe(1)
    expect(b.byte("enc_revid")).toBe(0x06)
  })

  it("blinks every 200 ms while BTN is held", () => {
    b.press("BTN", true)
    const on = b.onsets("LED", 1.3)
    expect(on.length).toBeGreaterThanOrEqual(5)
    b.press("BTN", false)
    for (const p of periods(on.slice(1))) expect(p).toBeCloseTo(0.2, 1)
  })
})
