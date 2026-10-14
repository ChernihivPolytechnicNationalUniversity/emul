/**
 * The "Nucleo I²C LCD 1602" example co-simulated: unmodified HAL firmware on I2C1 at 100 kHz
 * drives a PCF8574 backpack at 0x27, which drives the HD44780 in 4-bit mode. After the
 * initialisation by instruction the controller holds both lines in DDRAM with no busy-flag or
 * bus-timing warnings, the glass shows the text as dark dots at the backpack's default
 * contrast, and the backlight is lit through P3.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoLcdI2c } from "@/schematic/examples/lcd-i2c"
import { partKey, pinKey, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import type { LcdSnapshot } from "@/sim/hd44780"
import { exampleBase64 } from "../lib/firmware"

type Core = { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } }

function bench() {
  const doc: Schematic = nucleoLcdI2c.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const lcd = doc.objects.find((o) => o.def === "lcd-1602-i2c")!
  u.props = { ...u.props, firmware: "nucleo-lcd-i2c.elf", firmwareData: exampleBase64("nucleo-lcd-i2c.elf") }
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
  const word = (name: string) => core().bus.read32(core().firmware.symbols.find((x) => x.name === name)!.value)
  const display = () => loop.snapshot()!.digital[lcd.id] as LcdSnapshot
  return { loop, run, word, display, u, lcd }
}

const line = (s: LcdSnapshot, n: number) =>
  Array.from({ length: 16 }, (_, c) => String.fromCharCode(s.ddram[n * 40 + c]))
    .join("")
    .trimEnd()

/** A cell's dots as 0/1 by whether a dot is darker than half. */
const cellDark = (s: LcdSnapshot, row: number, col: number) => {
  let n = 0
  for (let r = 0; r < 8; r++) for (let x = 0; x < 5; x++) if (s.screen.dots[(row * 8 + r) * 80 + col * 5 + x] > 127) n++
  return n
}

describe("Nucleo I²C LCD 1602", () => {
  it("initialises the HD44780 over the PCF8574 and shows both lines with no busy or timing warnings", () => {
    const b = bench()
    b.run(1.5)
    expect(b.word("errors"), "HAL I²C errors").toBe(0)
    expect(b.word("nacks"), "address NACKs").toBe(0)
    expect(b.word("initDone"), "initialisation finished").toBe(1)
    expect(b.word("seconds"), "seconds counter").toBe(1)
    const s = b.display()
    expect(s.address).toBe(0x27)
    expect(line(s, 0)).toBe("Hello, Nucleo!")
    expect(line(s, 1)).toBe("t = 1 s")
    expect(s.warnings, "no busy-flag, bus-timing or SCL-rate warnings").toEqual([])
    expect(s.ignoredWhileBusy, "nothing sent while busy").toBe(0)
    expect(s.display, "display on").toBe(true)
    expect(s.twoLines, "two lines").toBe(true)
    expect(s.eightBit, "4-bit bus").toBe(false)
    // P3 high: backlight bit kept on in every port byte.
    expect(((s.port ?? 0) >> 3) & 1, "backlight bit").toBe(1)
  })

  it("the glass shows the text as dark dots at the default contrast, with the backlight lit", () => {
    const b = bench()
    b.run(1.5)
    const s = b.display()
    expect(s.screen.width).toBe(80)
    expect(s.screen.height).toBe(16)
    expect(s.screen.cell).toEqual({ w: 5, h: 8 })
    // Default contrast pot (16 %): V0 ≈ 0.8 V, VLCD = VDD − V0 ≈ 4.2 V, Vishay's typical at 25 °C.
    expect(s.vcc, "module supply from +5V").toBeGreaterThan(4.7)
    expect(s.vlcd).toBeGreaterThan(3.8)
    expect(s.vlcd).toBeLessThan(4.6)
    // "H" in the first cell and "t" on line 2 have dark dots; a space has none.
    expect(cellDark(s, 0, 0), "H").toBeGreaterThan(8)
    expect(cellDark(s, 1, 0), "t").toBeGreaterThan(5)
    expect(cellDark(s, 0, 15), "blank cell").toBe(0)
    let dark = 0
    for (const d of s.screen.dots) if (d > 127) dark++
    expect(dark, "dark dots on the glass").toBeGreaterThan(100)
    const bl = b.loop.snapshot()!.parts[partKey(b.lcd.id, "BL")]
    // 5 V through R8 (100 Ω) and the LED (4.2 V at 20 mA) and the saturated 8050: some 8 mA.
    expect(bl?.amps ?? 0, "backlight current (A)").toBeGreaterThan(0.005)
    expect(bl?.amps ?? 0, "backlight current (A)").toBeLessThan(0.012)
  })

  it("keeps counting seconds on line 2", () => {
    const b = bench()
    b.run(3.2)
    expect(b.word("seconds")).toBe(3)
    expect(line(b.display(), 1)).toBe("t = 3 s")
    expect(b.display().warnings).toEqual([])
  })

  it("the bus idles at the module's 5 V, inside the FT pads' rating", () => {
    const b = bench()
    b.run(0.02)
    const v = b.loop.snapshot()!.pinVoltage
    expect.soft(v[pinKey(b.u.id, "CN7-2")], "SCL idle").toBeGreaterThan(4.7)
    expect.soft(v[pinKey(b.u.id, "CN7-4")], "SDA idle").toBeGreaterThan(4.7)
    expect.soft(v[pinKey(b.u.id, "CN7-2")]).toBeLessThan(5.5)
    expect(Object.keys(b.loop.snapshot()!.damage ?? {}), "nothing damaged").toEqual([])
  })
})
