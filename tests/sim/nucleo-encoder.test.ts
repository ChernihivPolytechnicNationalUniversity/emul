/**
 * The "Nucleo rotary encoder" example co-simulated: a KY-040 on TIM4 in encoder mode (x4,
 * PD12/PD13), a detent being a full quadrature cycle through the module's own 10 kΩ pull-ups
 * to the board's +3V3. Turned +3 detents the firmware counts 12 edges and prints each step on
 * the VCP; turned back to −2 it counts down; pressing the shaft (SW, the pad's pull-up) zeroes it.
 * The same with contact bounce on: x4 counting cancels the bounce of each contact, and the
 * firmware's 20 ms quiet window takes the press and the release as one press.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoEncoder } from "@/schematic/examples/encoder"
import { partKey, pinKey, type PartState, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

type Core = { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } }

describe.each(["off", "on"])("Nucleo rotary encoder, bounce %s", (bounce) => {
  const doc: Schematic = nucleoEncoder.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const ky = doc.objects.find((o) => o.def === "ky-040")!
  const term = doc.objects.find((o) => o.def === "serial-terminal")!
  ky.props = { ...ky.props, bounce }
  u.props = { ...u.props, firmware: "nucleo-encoder.elf", firmwareData: exampleBase64("nucleo-encoder.elf") }

  const loop = new SimLoop()
  let clock = 0
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 10)
      loop.advance(clock)
    }
  }
  const core = () => (loop as unknown as { mcus: Map<string, { mcu: { mcu: Core } }> }).mcus.get(u.id)!.mcu.mcu
  const word = (name: string) => core().bus.read32(core().firmware.symbols.find((x) => x.name === name)!.value) | 0
  const lines = () => loop.snapshot()!.terminals[term.id].text.split("\r\n").filter(Boolean)
  const volts = (pin: string) => loop.snapshot()!.pinVoltage[pinKey(ky.id, pin)] ?? 0
  let parts: Record<string, PartState> = {}
  const set = (part: string, state: PartState) => {
    parts = { ...parts, [partKey(ky.id, part)]: state }
    loop.setParts(parts)
  }

  beforeAll(() => {
    parts = { ...doc.parts }
    loop.setDoc(doc)
    loop.setParts(parts)
    loop.setRunning(true)
    loop.advance(clock)
    run(0.05)
  })

  it("rests with CLK and DT pulled up to 3.3 V and SW held high by the pad's pull-up", () => {
    expect(loop.snapshot()!.mcus[u.id].running).toBe(true)
    expect(volts("CLK")).toBeNear(3.3, 0.1)
    expect(volts("DT")).toBeNear(3.3, 0.1)
    expect(volts("SW")).toBeGreaterThan(2.5)
    expect(word("rawCount")).toBe(0)
    expect(lines()).toEqual([])
  })

  it("counts +3 detents (12 edges) turned clockwise and prints each step", () => {
    set("SHAFT", { turns: 3 })
    run(0.25)
    expect(word("rawCount")).toBe(12)
    expect(word("detents")).toBe(3)
    expect(lines()).toEqual(["pos 1", "pos 2", "pos 3"])
  })

  it("counts down turned back to −2", () => {
    set("SHAFT", { turns: -2 })
    run(0.35)
    expect(word("rawCount")).toBe(-8)
    expect(word("detents")).toBe(-2)
    expect(lines().slice(3)).toEqual(["pos 2", "pos 1", "pos 0", "pos -1", "pos -2"])
  })

  it("zeroes on a press of the shaft", () => {
    set("PUSH", { pressed: true })
    run(0.05)
    set("PUSH", { pressed: false })
    run(0.05)
    expect(word("presses")).toBe(1)
    expect(word("rawCount")).toBe(0)
    expect(word("detents")).toBe(0)
    expect(lines().at(-1)).toBe("pos 0")
    expect(lines()).toHaveLength(9)
    expect(loop.snapshot()!.pinVoltage[pinKey(u.id, "CN10-31")], "LD1 (PB0) toggled 9 times: on").toBeGreaterThan(2.5)
    expect(word("errors")).toBe(0)
    expect(loop.snapshot()!.terminals[term.id].framingErrors).toBe(0)
  })
})
