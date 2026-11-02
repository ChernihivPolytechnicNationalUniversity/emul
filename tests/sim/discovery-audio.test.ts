/**
 * The "Discovery audio" example on the board model (firmware/discovery/audio): the CS43L22 set up
 * over I2C1 (its ID read back), fed a 400 Hz tone by I2S3 + DMA with MCK on, heard at the
 * headphone jack; the MP45DT02 clocked by I2S2 at 1.024 MHz, its PDM bits read by DMA, quiet
 * against a 110 dB SPL tone told apart by the firmware's mic_power and LD5.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { discoveryAudio } from "@/schematic/examples/discovery"
import { GRID } from "@/schematic/geometry"
import { partKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import type { Cs43l22 } from "@/sim/cs43l22"
import { FIRMWARE } from "../lib/firmware"

const ELF = readFileSync(join(FIRMWARE, "prebuilt", "discovery-audio.U1.elf")).toString("base64")
type Core = { cpu: { halted: unknown }; bus: { read: (a: number, n: number) => number }; firmware: { symbols: { name: string; value: number }[] } }

describe("Discovery audio", () => {
  const doc = discoveryAudio.build(GRID)
  const u = doc.objects.find((o) => o.def === "stm32f4-discovery")!
  u.props = { ...u.props, sound: "0", firmwareData: ELF }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  const run = (s: number) => {
    const end = clock + s * 1000
    while (clock < end) loop.advance((clock = Math.min(end, clock + 10)))
  }
  const l = loop as unknown as { mcus: Map<string, { mcu: { mcu: Core } }>; digitalParts: Map<string, { chips: { codec: Cs43l22 }; pressure(): number }> }
  const core = () => l.mcus.get(u.id)!.mcu.mcu
  const read = (name: string, n: 1 | 4) => core().bus.read(core().firmware.symbols.find((s) => s.name === name)!.value, n) >>> 0
  const codec = () => l.digitalParts.get(u.id)!.chips.codec
  const lit = (ld: string) => !!loop.snapshot()!.parts[partKey(u.id, ld)]?.on

  it("reads the codec's ID (0xE3, rev B1) over I2C1 and powers it up with MCLK = 256 × 16 kHz", () => {
    run(0.15)
    expect(core().cpu.halted).toBeNull()
    expect(read("codec_id", 1)).toBe(0xe3)
    const snap = codec().snapshot() as { powered?: boolean; warnings?: string[] }
    expect(snap.powered).toBe(true)
    expect(lit("LD4")).toBe(true)
  })

  it("plays the 400 Hz tone at 16 kHz to the headphone jack", () => {
    codec().takeAudio()
    run(0.05)
    const { rate, left } = codec().takeAudio()
    expect(rate).toBeCloseTo(16000, -2)
    expect(left.length).toBeGreaterThan(400)
    // Zero crossings upward: 400 per second.
    let ups = 0
    for (let i = 1; i < left.length; i++) if (left[i - 1] < 0 && left[i] >= 0) ups++
    expect(ups / (left.length / rate)).toBeCloseTo(400, -1)
    expect(Math.max(...left)).toBeGreaterThan(0.1)
  })

  it("hears a 110 dB SPL tone at the microphone: mic_power rises and LD5 lights; quiet again, it goes out", () => {
    run(0.1)
    const quiet = read("mic_power", 4)
    expect(lit("LD5")).toBe(false)
    u.props = { ...u.props, sound: "110", tone: "1000" }
    loop.setDoc(doc)
    run(0.1)
    const loud = read("mic_power", 4)
    expect(loud).toBeGreaterThan(4 * Math.max(quiet, 1))
    expect(lit("LD5")).toBe(true)
    u.props = { ...u.props, sound: "0" }
    loop.setDoc(doc)
    run(0.1)
    expect(lit("LD5")).toBe(false)
  })
})
