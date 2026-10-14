/**
 * The "Nucleo I²C OLED" example co-simulated: unmodified HAL firmware initialises an SSD1306
 * module with Adafruit's sequence over I2C1 at 400 kHz and sends its 1 KB framebuffer once a
 * second; the module's controller model takes the bytes off the wire and lights its glass.
 * The panel must show the firmware's framebuffer pixel for pixel — not mirrored, not flipped —
 * and the module draws the controller's and the lit pixels' current from the board's +3V3.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoOled } from "@/schematic/examples/oled"
import { pinKey, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { SSD1306, type OledSnapshot } from "@/sim/ssd1306"
import { exampleBase64 } from "../lib/firmware"

type Core = { bus: { read8: (a: number) => number; read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } }

function bench() {
  const doc: Schematic = nucleoOled.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const oled = doc.objects.find((o) => o.def === "oled-ssd1306-i2c")!
  u.props = { ...u.props, firmware: "nucleo-oled.elf", firmwareData: exampleBase64("nucleo-oled.elf") }
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
  const addr = (name: string) => core().firmware.symbols.find((x) => x.name === name)!.value
  const word = (name: string) => core().bus.read32(addr(name))
  const fb = () => Array.from({ length: 1024 }, (_, i) => core().bus.read8(addr("fb") + i))
  const panel = () => loop.snapshot()!.digital[oled.id] as OledSnapshot
  return { loop, run, word, fb, panel, oled }
}

/** The glyph of 'H' in the firmware's 5 × 7 font, a byte a column, bit 0 on top. */
const H = [0x7f, 0x08, 0x08, 0x08, 0x7f]
/** "Hello, OLED!" is 12 characters of 6 columns centred on 128: it starts at column 28, row 1. */
const TEXT_X = 28
const TEXT_Y = 1

describe("Nucleo I²C OLED", () => {
  const b = bench()
  b.run(1.5)

  it("the firmware initialises the module and sends whole frames without HAL errors", () => {
    expect(b.word("errors"), "HAL errors").toBe(0)
    expect(b.word("framesSent"), "frames at 0 s and 1 s").toBe(2)
    expect(b.word("seconds")).toBe(1)
    const s = b.panel()
    expect(s.on, "display on (AFh)").toBe(true)
    expect(s.pump, "charge pump on (8Dh 14h)").toBe(true)
    expect(s.contrast).toBe(0xcf)
    expect(s.address).toBe(0x3c)
    expect(s.warnings, "no bus-timing or not-modelled warnings").toEqual([])
  })

  it("draws the frame round the panel's edge, the inside corner dark", () => {
    const { width, height, dots } = b.panel().screen
    expect([width, height]).toEqual([128, 64])
    const at = (x: number, y: number) => dots[y * width + x]
    for (const [x, y] of [[0, 0], [127, 0], [0, 63], [127, 63], [64, 0], [64, 63], [0, 32], [127, 32]]) expect(at(x, y), `border pixel (${x}, ${y})`).toBeGreaterThan(0)
    for (const [x, y] of [[1, 1], [126, 1], [1, 62], [126, 62]]) expect(at(x, y), `inside corner (${x}, ${y})`).toBe(0)
  })

  it("the first character is the font's 'H' column for column", () => {
    const { width, dots } = b.panel().screen
    for (let i = 0; i < 5; i++)
      for (let r = 0; r < 7; r++) {
        const lit = dots[(TEXT_Y + r) * width + TEXT_X + i] > 0
        expect(lit, `'H' column ${i} row ${r}`).toBe(((H[i] >> r) & 1) === 1)
      }
    // The spacing column after it is dark under the frame's edge.
    for (let r = 0; r < 7; r++) expect(dots[(TEXT_Y + r) * width + TEXT_X + 5]).toBe(0)
  })

  it("the glass shows the firmware's framebuffer pixel for pixel (no mirror, no flip)", () => {
    const fb = b.fb()
    const { width, height, dots } = b.panel().screen
    const wrong: string[] = []
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const want = ((fb[(y >> 3) * 128 + x] >> (y & 7)) & 1) === 1
        if ((dots[y * width + x] > 0) !== want) wrong.push(`(${x}, ${y})`)
      }
    expect(wrong.slice(0, 10), `${wrong.length} pixels differ`).toEqual([])
    // The counter line on page 2 reads "t = 1 s": its 't' starts at column (128 − 7 × 6) / 2 = 43.
    const lit = (x: number, y: number) => dots[y * width + x] > 0
    expect(lit(43 + 1, 17 + 1), "'t' stem").toBe(true)
  })

  it("draws the controller's and the lit pixels' current from +3V3", () => {
    const s = b.panel()
    const fb = b.fb()
    let litPixels = 0
    for (const byte of fb) for (let bit = 0; bit < 8; bit++) litPixels += (byte >> bit) & 1
    // Segment current at contrast CFh, each lit pixel conducting for 1/64 of the frame, through
    // the 7.5 V charge pump from the regulated VDD; plus the controller's operating currents.
    const iseg = (0xcf / 256) * SSD1306.isegMax
    const expected = SSD1306.iddOn + SSD1306.iccOn + ((iseg * litPixels) / 64) * (SSD1306.pump / s.vdd)
    expect(s.vdd, "the module's regulated VDD").toBeGreaterThan(3)
    expect(s.vdd).toBeLessThanOrEqual(3.31)
    expect(s.current).toBeCloseTo(expected, 6)
    // About 560 lit pixels: about 2 mA — a small OLED with text, far under the rail's limit.
    expect(s.current).toBeGreaterThan(0.5e-3)
    expect(s.current).toBeLessThan(5e-3)
    const vcc = b.loop.snapshot()!.pinVoltage[pinKey(b.oled.id, "VCC")]
    expect(vcc, "+3V3 at the module").toBeGreaterThan(3.2)
  })
})
