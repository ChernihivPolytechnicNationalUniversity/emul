/**
 * Other people's libraries, unmodified, on the tier-0 displays: afiskon/stm32-ssd1306 and u8g2
 * on the I²C OLED, 4ilo/HD44780-Stm32HAL on the parallel 1602 (sources and commits in
 * firmware/hal/Makefile). What each draws must land on the glass with no warning, and where a
 * library breaks a datasheet rule the module breaks as a real one does: 4ilo starts sending
 * 0.1 ms after power-on, inside the HD44780's 10 ms internal reset, so a cold start shows
 * nothing and the RESET button (the module stays powered) brings the text up.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { nucleoOled } from "@/schematic/examples/oled"
import { GRID } from "@/schematic/geometry"
import { partKey, type Schematic } from "@/schematic/types"
import type { LcdSnapshot } from "@/sim/hd44780"
import { SimLoop } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

type Core = { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } }
type Shown = { screen: { width: number; height: number; dots: ArrayLike<number> }; warnings: string[] }

/** The 1602 on 4ilo's pins: RS PF13, E PE9, D4–D7 PE11 PF14 PE13 PF15; R/W grounded; V0 from 10 kΩ / 1.8 kΩ. */
function parallelLcd(): Schematic {
  const { doc, place, wire } = builder(GRID)
  const u = place("nucleo-f429zi", 0, 0)
  const lcd = place("lcd-1602", 40, 0)
  const top = place("resistor", 40, 30, { value: "10 kΩ" })
  const bottom = place("resistor", 40, 36, { value: "1.8 kΩ" })
  for (const [cn, pin] of [["CN10-2", "RS"], ["CN10-4", "E"], ["CN10-6", "D4"], ["CN10-8", "D5"], ["CN10-10", "D6"], ["CN10-12", "D7"]]) wire(u, cn, lcd, pin)
  for (const pin of ["VDD", "A"]) wire(u, "CN8-9", lcd, pin)
  for (const pin of ["VSS", "RW", "K"]) wire(u, "CN8-11", lcd, pin)
  wire(u, "CN8-9", top, "1")
  wire(top, "2", lcd, "V0")
  wire(bottom, "1", lcd, "V0")
  wire(u, "CN8-11", bottom, "2")
  return doc
}

function bench(doc: Schematic, elf: string, display: string) {
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const d = doc.objects.find((o) => o.def === display)!
  u.props = { ...u.props, firmware: elf, firmwareData: exampleBase64(elf) }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(0)
  const warnings = new Set<string>()
  const shown = () => loop.snapshot()!.digital[d.id] as Shown
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 20)
      loop.advance(clock)
      for (const w of shown().warnings) warnings.add(w)
    }
  }
  const press = (pressed: boolean) => loop.setParts(pressed ? { ...doc.parts, [partKey(u.id, "RESET")]: { pressed: true } } : doc.parts)
  const core = () => (loop as unknown as { mcus: Map<string, { mcu: { mcu: Core } }> }).mcus.get(u.id)!.mcu.mcu
  const word = (name: string) => core().bus.read32(core().firmware.symbols.find((x) => x.name === name)!.value)
  return { loop, run, press, shown, word, warnings }
}

const lit = (s: Shown, x: number, y: number) => s.screen.dots[y * s.screen.width + x] > 127
const count = (s: Shown, x0: number, y0: number, x1: number, y1: number) => {
  let n = 0
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (lit(s, x, y)) n++
  return n
}
const line = (s: LcdSnapshot, n: number) => Array.from({ length: 16 }, (_, c) => String.fromCharCode(s.ddram[n * 40 + c])).join("").trimEnd()

describe("third-party libraries on the I²C OLED (128 × 64 at 0x3C)", () => {
  it("afiskon/stm32-ssd1306: its init, a rectangle round the edge and two strings, no warning", () => {
    const b = bench(nucleoOled.build(GRID), "tp-afiskon-ssd1306.elf", "oled-ssd1306-i2c")
    b.run(2.2)
    const s = b.shown()
    expect(b.word("done")).toBe(1)
    expect(b.word("seconds")).toBe(2)
    expect(count(s, 0, 0, 127, 0), "top edge").toBe(128)
    expect(count(s, 0, 63, 127, 63), "bottom edge").toBe(128)
    expect(count(s, 0, 0, 0, 63), "left edge").toBe(64)
    expect(count(s, 4, 4, 74, 13), "\"afiskon OK\" in Font_7x10").toBeGreaterThan(60)
    expect(count(s, 4, 30, 60, 47), "\"t=2\" in Font_11x18").toBeGreaterThan(40)
    expect(count(s, 2, 15, 125, 28), "nothing between the lines").toBe(0)
    expect([...b.warnings]).toEqual([])
  })

  it("u8g2 (ssd1306_i2c_128x64_noname, hardware I²C callbacks): frame, a string, a box, no warning", () => {
    const b = bench(nucleoOled.build(GRID), "tp-u8g2-ssd1306.elf", "oled-ssd1306-i2c")
    b.run(1.5)
    const s = b.shown()
    expect(b.word("done")).toBe(1)
    expect(b.word("errors"), "HAL I²C errors").toBe(0)
    expect(count(s, 0, 0, 127, 0), "frame top").toBe(128)
    expect(count(s, 127, 0, 127, 63), "frame right").toBe(64)
    expect(count(s, 100, 40, 119, 55), "the 20 × 16 box").toBe(320)
    expect(count(s, 4, 5, 60, 15), "\"u8g2 OK\" in ncenB08").toBeGreaterThan(40)
    expect([...b.warnings]).toEqual([])
  })
})

describe("4ilo/HD44780-Stm32HAL on the parallel 1602, 4-bit", () => {
  it("from a cold start it sends inside the 10 ms internal reset: those instructions are lost and the glass stays blank", () => {
    const b = bench(parallelLcd(), "tp-4ilo-hd44780.elf", "lcd-1602")
    b.run(1.5)
    const s = b.shown() as unknown as LcdSnapshot
    expect(b.word("done")).toBe(1)
    expect(s.ignoredWhileBusy).toBe(4)
    expect(line(s, 0)).toBe("")
    expect([...b.warnings].some((w) => w.includes("busy flag was set was ignored"))).toBe(true)
  })

  it("RESET with the module still powered: the same program initialises it and prints", () => {
    const b = bench(parallelLcd(), "tp-4ilo-hd44780.elf", "lcd-1602")
    b.run(1)
    b.press(true)
    b.run(0.1)
    b.press(false)
    b.run(1.1)
    const s = b.shown() as unknown as LcdSnapshot
    expect(line(s, 0)).toBe("4ilo HD44780")
    expect(line(s, 1)).toBe("1")
    expect(s.ignoredWhileBusy, "nothing more lost after the reset").toBe(4)
  })
})
