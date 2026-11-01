/**
 * The "Discovery running light" example on the board model, from its prebuilt image (the board's
 * starting project, src/project/template.ts): 168 MHz from the 8 MHz crystal, LD4 → LD3 → LD5 → LD6
 * one at a time every 150 ms, B1 USER on PA0 reversing the order.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { discoveryRunningLight } from "@/schematic/examples/discovery"
import { GRID } from "@/schematic/geometry"
import { partKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { FIRMWARE } from "../lib/firmware"

const ELF = readFileSync(join(FIRMWARE, "prebuilt", "discovery-running-light.U1.elf")).toString("base64")
const ORDER = ["LD4", "LD3", "LD5", "LD6"]
/**
 * LD6 (blue, VF 2.5–3.1 V at 5 mA) runs at a few hundred µA from the 2.9 V VDD through 680 Ω,
 * below the field's "lit" threshold; it counts here by its current.
 */
const GLOWING = 0.1e-3

describe("Discovery running light", () => {
  const doc = discoveryRunningLight.build(GRID)
  const u = doc.objects.find((o) => o.def === "stm32f4-discovery")!
  u.props = { ...u.props, firmware: "discovery-running-light.elf", firmwareData: ELF }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  /** The one carrying the most current: as one LED goes out and the next lights, both glow for a moment. */
  const lit = () => {
    const parts = loop.snapshot()!.parts
    const levels = ORDER.map((id) => ({ id, level: (parts[partKey(u.id, id)]?.amps ?? 0) > GLOWING ? (parts[partKey(u.id, id)]?.amps ?? 0) : 0 }))
    const top = levels.reduce((a, b) => (b.level > a.level ? b : a))
    return top.level > 0 ? [top.id] : []
  }
  /** The LED lit at each 10 ms step for `seconds`, consecutive repeats folded. */
  function sequence(seconds: number) {
    const seen: string[] = []
    for (let t = 0; t < seconds * 100; t++) {
      clock += 10
      loop.advance(clock)
      const now = lit().join("+")
      if (now && seen.at(-1) !== now) seen.push(now)
    }
    return seen
  }

  it("runs at 168 MHz and lights one LED at a time, LD4 → LD3 → LD5 → LD6, 150 ms each", () => {
    const seen = sequence(1.5)
    const core = (loop as unknown as { mcus: Map<string, { mcu: { mcu: { clocks: { hclk: number } } } }> }).mcus.get(u.id)!.mcu.mcu
    expect(core.clocks.hclk).toBe(168e6)
    const start = seen.indexOf("LD4", 1)
    expect(seen.slice(start, start + 5)).toEqual(["LD4", "LD3", "LD5", "LD6", "LD4"])
    expect(seen.length).toBeGreaterThanOrEqual(9)
    expect(seen.length).toBeLessThanOrEqual(11)
  })

  it("turns the other way after a press of B1", () => {
    doc.parts[partKey(u.id, "B1")] = { pressed: true }
    loop.setParts(doc.parts)
    sequence(0.1)
    doc.parts[partKey(u.id, "B1")] = { pressed: false }
    loop.setParts(doc.parts)
    const seen = sequence(1.2)
    const start = seen.indexOf("LD6", 1)
    expect(seen.slice(start, start + 5), seen.join(" ")).toEqual(["LD6", "LD5", "LD3", "LD4", "LD6"])
  })
})
