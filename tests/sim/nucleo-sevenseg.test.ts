/**
 * The "Nucleo 4-digit 7-segment" example co-simulated: unmodified HAL firmware multiplexes a
 * CC56-12EWA from TIM6 at 1 kHz, segments through 220 Ω, each digit's common pulled down by a
 * BC547. After 1.2 s it shows 00.01: the eye model's level of every segment matches the
 * seven-segment code of its digit, nothing burns and no pad goes past its rating.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoSevenSeg } from "@/schematic/examples/sevenseg"
import { partKey, pinKey, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

type Core = { bus: { read32: (a: number) => number; read8: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } }

const SEGMENTS = ["a", "b", "c", "d", "e", "f", "g", "DP"]
/** 0–9, bit 0 = a … bit 6 = g. */
const FONT = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f]

function bench() {
  const doc: Schematic = nucleoSevenSeg.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const ds = doc.objects.find((o) => o.def === "seven-segment-4-cc")!
  u.props = { ...u.props, firmware: "nucleo-sevenseg.elf", firmwareData: exampleBase64("nucleo-sevenseg.elf") }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 10)
      loop.advance(clock)
    }
  }
  const core = () => (loop as unknown as { mcus: Map<string, { mcu: { mcu: Core } }> }).mcus.get(u.id)!.mcu.mcu
  const sym = (name: string) => core().firmware.symbols.find((x) => x.name === name)!.value
  const word = (name: string) => core().bus.read32(sym(name))
  const byte = (name: string, i: number) => core().bus.read32((sym(name) + i) & ~3) >>> (8 * ((sym(name) + i) & 3)) & 0xff
  return { doc, loop, run, word, byte, u, ds }
}

describe("Nucleo 4-digit 7-segment", () => {
  const b = bench()
  b.run(1.2)
  const snap = b.loop.snapshot()!
  const level = (seg: string, digit: number) => snap.parts[partKey(b.ds.id, `${seg}${digit}`)]?.level ?? 0

  it("counts one second and multiplexes at 250 Hz", () => {
    expect(b.word("shown"), "seconds on the display").toBe(1)
    // TIM6 at 1 kHz from about the first millisecond: ~1200 interrupts, ~300 sweeps.
    expect(b.word("ticks")).toBeGreaterThan(1150)
    expect(b.word("ticks")).toBeLessThan(1210)
    expect(b.word("refreshes")).toBeGreaterThan(285)
    expect(b.word("refreshes")).toBeLessThan(305)
    const expected = [FONT[0], FONT[0] | 0x80, FONT[0], FONT[1]]
    for (let d = 0; d < 4; d++) expect(b.byte("patterns", d), `digit ${d + 1} pattern`).toBe(expected[d])
  })

  it("lights exactly the segments of 00.01, digit by digit", () => {
    const expected = [FONT[0], FONT[0] | 0x80, FONT[0], FONT[1]]
    const lit: number[] = []
    const dark: number[] = []
    for (let d = 0; d < 4; d++)
      SEGMENTS.forEach((seg, s) => {
        const on = (expected[d] >> s) & 1
        ;(on ? lit : dark).push(level(seg, d + 1))
        expect.soft(level(seg, d + 1) > 0.05, `${seg}${d + 1} ${on ? "lit" : "dark"} (level ${level(seg, d + 1).toFixed(3)})`).toBe(!!on)
      })
    // Every lit segment carries the same 1/4 duty, so their levels agree; the dark ones see nothing.
    expect(Math.min(...lit), "dimmest lit segment").toBeGreaterThan(0.1)
    expect(Math.max(...lit) / Math.min(...lit), "lit segments alike").toBeLessThan(1.5)
    expect(Math.max(...dark), "brightest dark segment").toBeLessThan(0.01)
  })

  it("burns nothing: no segment, transistor, resistor or pad past its rating", () => {
    expect(snap.damage, "damage anywhere on the bench").toEqual({})
    expect(snap.mcus[b.u.id].faults, "core faults").toEqual([])
    expect(snap.mcus[b.u.id].unmodelled, "peripherals the firmware touched that are not modelled").toEqual([])
  })

  it("keeps every GPIO well inside 25 mA while a digit's common sinks more than a pin could", () => {
    // Instantaneous currents, sampled over two full sweeps a millisecond at a time.
    const segPins = ["CN10-4", "CN10-6", "CN10-8", "CN10-10", "CN10-12", "CN10-14", "CN10-16", "CN10-18"]
    const basePins = ["CN7-12", "CN7-10", "CN7-4", "CN7-2"]
    const peak = new Map<string, number>()
    const note = (key: string, amps: number | undefined) => peak.set(key, Math.max(peak.get(key) ?? 0, Math.abs(amps ?? 0)))
    for (let i = 0; i < 8; i++) {
      b.run(0.001)
      const s = b.loop.snapshot()!
      for (const p of [...segPins, ...basePins]) note(p, s.pinCurrent[pinKey(b.u.id, p)])
      for (let d = 1; d <= 4; d++) note(`D${d}`, s.pinCurrent[pinKey(b.ds.id, `D${d}`)])
    }
    // a, b, c, d, e, f are lit on some digit of 00.01, g never, DP on digit 2.
    for (const p of segPins.filter((p) => p !== "CN10-16")) {
      expect.soft(peak.get(p), `${p} segment current`).toBeGreaterThan(0.004)
      expect.soft(peak.get(p), `${p} segment current`).toBeLessThan(0.008)
    }
    expect.soft(peak.get("CN10-16"), "g, dark throughout").toBeLessThan(1e-6)
    for (const p of basePins) {
      expect.soft(peak.get(p), `${p} base current`).toBeGreaterThan(0.002)
      expect.soft(peak.get(p), `${p} base current`).toBeLessThan(0.003)
    }
    // Digit 2 shows "0." — seven segments, over 25 mA through its common: the BC547 sinks it.
    expect(peak.get("D2"), "digit 2 common current").toBeGreaterThan(0.025)
    expect(peak.get("D4"), "digit 4 common current, two segments").toBeLessThan(0.015)
  })
})
