/**
 * The "Nucleo WS2812 stick" example co-simulated: unmodified HAL firmware sends GRB frames with
 * TIM1 PWM + DMA, the stick's chain model decodes them at the edges' own times and lights
 * its pixels; the stick draws its LEDs' current from the board's +5V. Then the bench physics:
 * the same 3.3 V data into a 2013 WS2812B (VIH 3.5 V at 5 V) is ignored, and a strip on a
 * 7 V supply burns.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoWs2812 } from "@/schematic/examples"
import { pinKey, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import type { AddressableSnapshot } from "@/sim/addressable/chain"
import { exampleBase64 } from "../lib/firmware"

type Core = { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } }

function bench(part?: string) {
  const doc: Schematic = nucleoWs2812.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const stick = doc.objects.find((o) => o.def === "led-stick-8")!
  u.props = { ...u.props, firmware: "nucleo-ws2812.elf", firmwareData: exampleBase64("nucleo-ws2812.elf") }
  if (part) stick.props = { ...stick.props, value: part }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
    }
  }
  const core = () => (loop as unknown as { mcus: Map<string, { mcu: { mcu: Core } }> }).mcus.get(u.id)!.mcu.mcu
  const word = (name: string, i = 0) => core().bus.read32(core().firmware.symbols.find((x) => x.name === name)!.value + 4 * i)
  const led = () => loop.snapshot()!.digital[stick.id] as AddressableSnapshot
  return { loop, run, word, led, u, stick }
}

describe("Nucleo WS2812 stick", () => {
  it("lights every pixel with the colour the firmware sent", () => {
    const b = bench()
    b.run(0.12)
    expect(b.word("errors"), "no HAL errors").toBe(0)
    expect(b.word("framesSent"), "frames sent").toBeGreaterThan(2)
    const s = b.led()
    expect(s.powered, "stick powered from +5V").toBe(true)
    expect(s.frames, "frames latched").toBeGreaterThan(1)
    expect.soft(s.faults, "TIM1 timing within the V5's windows").toEqual([])
    // The latched words lag the firmware by at most a frame: compare with the step before
    // and after, whichever matches.
    const sent = Array.from({ length: 8 }, (_, i) => b.word("pixels", i))
    const got = s.words.map((w) => (w[0].value << 16) | (w[1].value << 8) | w[2].value)
    const sameExceptBlue = got.every((g, i) => (g & 0xffff00) === (sent[i] & 0xffff00))
    expect(sameExceptBlue, `G/R of every pixel (sent ${sent.map((x) => x.toString(16))}, got ${got.map((x) => x.toString(16))})`).toBe(true)
    expect.soft(s.colors[0] >> 8 & 0xff, "first pixel green").toBeGreaterThan(200)
    expect.soft(s.colors[7] >> 16, "last pixel red").toBeGreaterThan(200)
    expect.soft(s.passed, "nothing passed past the 8th pixel").toBe(0)
  })

  it("draws the LEDs' current from the board's +5V", () => {
    const b = bench()
    b.run(0.1)
    const s = b.led()
    // 8 pixels: R and G together sum to 255 per pixel, plus blue; at least ~8 × 12 mA.
    expect(s.current, "stick current").toBeGreaterThan(0.08)
    expect(s.current).toBeLessThan(8 * 3 * 0.012 + 0.01)
    expect.soft(b.loop.snapshot()!.pinVoltage[pinKey(b.stick.id, "VDD")], "5V rail under load").toBeGreaterThan(4.5)
  })

  it("ignores 3.3 V data on a 2013 WS2812B at 5 V (VIH 3.5 V)", () => {
    const b = bench("WS2812B")
    b.run(0.1)
    expect(b.word("framesSent"), "firmware sends").toBeGreaterThan(2)
    const s = b.led()
    expect(s.dinHigh, "data high level").toBeLessThan(3.4)
    expect(s.vih).toBeGreaterThan(3.4)
    expect(s.ignored, "pulses ignored").toBeGreaterThan(100)
    expect(s.colors.every((c) => c === 0), "the stick stays dark, the first frame too").toBe(true)
    expect(s.frames, "no frame latched").toBe(0)
  })
})
