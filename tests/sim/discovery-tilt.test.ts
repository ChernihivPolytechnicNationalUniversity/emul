/**
 * The "Discovery tilt" example on the board model with each accelerometer the MB997 has carried:
 * the firmware tells the LIS302DL (rev A/B) from the LIS3DSH (rev C–E) by WHO_AM_I over SPI1, reads
 * X/Y/Z in mg, and lights the LED on the side the board tips to as Roll/Pitch change.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { discoveryTilt } from "@/schematic/examples/discovery"
import { GRID } from "@/schematic/geometry"
import { partKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { FIRMWARE } from "../lib/firmware"

const ELF = readFileSync(join(FIRMWARE, "prebuilt", "discovery-tilt.U1.elf")).toString("base64")
type Core = { bus: { read32: (a: number) => number; read: (a: number, n: number) => number }; firmware: { symbols: { name: string; value: number }[] }; cpu: { halted: unknown } }

describe.each([
  ["lis302dl", 0x3b, 18],
  ["lis3dsh", 0x3f, 1],
] as const)("Discovery tilt with the %s", (accel, id, lsbMg) => {
  const doc = discoveryTilt.build(GRID)
  const u = doc.objects.find((o) => o.def === "stm32f4-discovery")!
  u.props = { ...u.props, accel, roll: "0", pitch: "0", firmwareData: ELF }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  const run = (s: number) => {
    const end = clock + s * 1000
    while (clock < end) loop.advance((clock = Math.min(end, clock + 10)))
  }
  const core = () => (loop as unknown as { mcus: Map<string, { mcu: { mcu: Core } }> }).mcus.get(u.id)!.mcu.mcu
  const sym = (name: string) => core().firmware.symbols.find((s) => s.name === name)!.value
  const mg = () => [0, 1, 2].map((i) => core().bus.read32(sym("accel_mg") + 4 * i) | 0)
  const lit = () => ["LD3", "LD4", "LD5", "LD6"].filter((ld) => loop.snapshot()!.parts[partKey(u.id, ld)]?.on || (loop.snapshot()!.parts[partKey(u.id, ld)]?.amps ?? 0) > 0.1e-3)
  const tilt = (roll: number, pitch: number) => {
    u.props = { ...u.props, roll: String(roll), pitch: String(pitch) }
    loop.setDoc(doc)
    run(0.3)
  }

  it("reads WHO_AM_I and 1 g on Z lying flat, all LEDs dark", () => {
    run(0.5)
    expect(core().cpu.halted).toBeNull()
    expect(core().bus.read(sym("who_am_i"), 1)).toBe(id)
    const [x, y, z] = mg()
    expect(Math.abs(x)).toBeLessThanOrEqual(lsbMg)
    expect(Math.abs(y)).toBeLessThanOrEqual(lsbMg)
    expect(z).toBeGreaterThan(1000 - 2 * lsbMg)
    expect(z).toBeLessThan(1000 + 2 * lsbMg)
    expect(lit()).toEqual([])
  })

  it("rolls 30° about X: Y reads sin 30° g and LD3 (orange, +Y) lights", () => {
    tilt(30, 0)
    expect(mg()[1]).toBeGreaterThan(500 - 2 * lsbMg)
    expect(mg()[1]).toBeLessThan(500 + 2 * lsbMg)
    expect(lit()).toEqual(["LD3"])
  })

  it("rolls −30°: LD6 (blue, −Y); pitches 30°: X = −0.5 g, LD4 (green, −X); −30°: LD5 (red, +X)", () => {
    tilt(-30, 0)
    expect(lit()).toEqual(["LD6"])
    tilt(0, 30)
    expect(mg()[0]).toBeLessThan(-500 + 2 * lsbMg)
    expect(lit()).toEqual(["LD4"])
    tilt(0, -30)
    expect(lit()).toEqual(["LD5"])
  })
})
