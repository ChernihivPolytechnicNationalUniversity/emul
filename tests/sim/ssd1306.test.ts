/**
 * SSD1306 against Solomon Systech's sheet (Rev 1.1): the COM-to-row-to-RAM mapping of Tables 10-1
 * and 10-2, the addressing modes of 10.1.3, the charge pump that must be on, the module glass
 * upright only with Adafruit's settings (C8h, A1h, DAh 12h/02h) and mirrored, flipped or
 * interlaced without them, the scroll at the frame rate, the I²C control byte and the SPI D/C#.
 */
import { describe, expect, it } from "vitest"
import { OledI2c, OledSpi, SSD1306, Ssd1306Core } from "@/sim/ssd1306"

/** Adafruit_SSD1306's begin() for a 128 × `rows` panel, as commands. */
const adafruitInit = (rows: 64 | 32) => [0xae, 0xd5, 0x80, 0xa8, rows - 1, 0xd3, 0x00, 0x40, 0x8d, 0x14, 0x20, 0x00, 0xa1, 0xc8, 0xda, rows === 64 ? 0x12 : 0x02, 0x81, 0xcf, 0xd9, 0xf1, 0xdb, 0x40, 0xa4, 0xa6, 0x2e, 0xaf]

function core(rows: 64 | 32 = 64, init = adafruitInit(rows)) {
  const c = new Ssd1306Core({ width: 128, height: rows }, "OLED1")
  c.reset()
  c.ram.fill(0)
  for (const b of init) c.command(b, 0)
  return c
}

/** A single lit RAM pixel at (column, row). */
function plot(c: Ssd1306Core, x: number, y: number) {
  c.ram[(y >> 3) * 128 + x] |= 1 << (y & 7)
}

const litAt = (c: Ssd1306Core) => {
  const px = c.pixels(true)
  const out: [number, number][] = []
  px.forEach((v, i) => v && out.push([i % 128, Math.floor(i / 128)]))
  return out
}

describe("SSD1306: COM, row and RAM (Tables 10-1, 10-2)", () => {
  it.each([
    // [mux, remap, offset, start line, COM output j, row, RAM row] — columns (a)–(f) of Table 10-1 and (a)/(b)/(d)/(e) of 10-2.
    [64, false, 0, 0, 10, 10, 10],
    [64, false, 8, 0, 10, 18, 18],
    [64, false, 0, 8, 10, 10, 18],
    [56, false, 0, 0, 56, -1, -1],
    [56, false, 8, 0, 48, -1, -1],
    [56, false, 8, 0, 56, 0, 0],
    [64, true, 0, 0, 10, 53, 53],
    [64, true, 8, 0, 10, 61, 61],
    [48, true, 0, 0, 50, -1, -1],
    [48, true, 8, 0, 50, 5, 5],
  ])("MUX %i, C8h %s, offset %i, start %i: COM%i shows row %i, RAM %i", (mux, remap, offset, start, j, row, ram) => {
    const c = core(64, [0xa8, mux - 1, remap ? 0xc8 : 0xc0, 0xd3, offset, 0x40 | start])
    expect(c.ramRowOfCom(j)).toBe(ram)
    void row
  })
})

describe("SSD1306 on the module's glass", () => {
  it("Adafruit's init: RAM (0, 0) is the top-left pixel, (127, 63) the bottom-right", () => {
    const c = core()
    plot(c, 0, 0)
    plot(c, 127, 63)
    expect(litAt(c)).toEqual([[0, 0], [127, 63]])
  })

  it("the 128 × 32 panel upright with DAh 02h", () => {
    const c = core(32)
    plot(c, 3, 0)
    plot(c, 5, 31)
    expect(litAt(c)).toEqual([[3, 0], [5, 31]])
  })

  it("A0h instead of A1h mirrors it left to right; C0h instead of C8h flips it", () => {
    const mirrored = core(64, adafruitInit(64).map((b) => (b === 0xa1 ? 0xa0 : b)))
    plot(mirrored, 0, 0)
    expect(litAt(mirrored)).toEqual([[127, 0]])
    const flipped = core(64, adafruitInit(64).map((b) => (b === 0xc8 ? 0xc0 : b)))
    plot(flipped, 0, 0)
    expect(litAt(flipped)).toEqual([[0, 63]])
  })

  it("DAh 02h (sequential) on the 64-row glass interlaces: RAM rows land on every other line", () => {
    const c = core(64, adafruitInit(64).map((b, i, a) => (a[i - 1] === 0xda ? 0x02 : b)))
    for (let y = 0; y < 4; y++) plot(c, 0, y)
    const rows = litAt(c).map(([, y]) => y)
    expect(rows).not.toEqual([0, 1, 2, 3])
    expect(new Set(rows.map((y) => y % 2)).size, "all on lines of one parity").toBe(1)
  })

  it("without the charge pump (no 8Dh 14h) the panel stays dark", () => {
    const c = core(64, adafruitInit(64).filter((_, i, a) => a[i] !== 0x8d && a[i - 1] !== 0x8d))
    c.ram.fill(0xff)
    expect(litAt(c)).toEqual([])
    c.command(0x8d, 0)
    c.command(0x14, 0)
    expect(litAt(c).length).toBe(128 * 64)
  })

  it("A5h lights everything regardless of RAM; A7h inverts", () => {
    const c = core()
    c.command(0xa5, 0)
    expect(litAt(c).length).toBe(8192)
    c.command(0xa4, 0)
    c.command(0xa7, 0)
    expect(litAt(c).length).toBe(8192)
  })

  it("brightness follows the contrast (segment current ∝ contrast)", () => {
    const c = core()
    plot(c, 0, 0)
    const at = (contrast: number) => {
      c.command(0x81, 0)
      c.command(contrast, 0)
      return c.pixels(true)[0]
    }
    expect(at(0xff)).toBeGreaterThan(at(0x3f))
    expect(at(0x00)).toBe(0)
  })
})

describe("SSD1306 addressing (10.1.3)", () => {
  it("page mode wraps within the page; horizontal runs on to the next page; vertical down the column", () => {
    const page = core(64, [0x20, 0x02, 0xb2, 0x0e, 0x17])
    page.ram.fill(0)
    page.data(1)
    page.data(2)
    expect(page.ram[2 * 128 + 126]).toBe(1)
    expect(page.ram[2 * 128 + 127]).toBe(2)
    page.data(3)
    expect(page.ram[2 * 128 + 0], "page mode wraps to the column start (0) on the same page").toBe(3)

    const h = core(64, [0x20, 0x00, 0x21, 2, 125, 0x22, 1, 6])
    h.ram.fill(0)
    for (let i = 0; i < 124; i++) h.data(0xaa)
    h.data(0x55)
    expect(h.ram[2 * 128 + 2], "after column 125 the next page from column 2").toBe(0x55)

    const v = core(64, [0x20, 0x01, 0x21, 0, 127, 0x22, 0, 7])
    v.ram.fill(0)
    for (let i = 0; i < 9; i++) v.data(i + 1)
    expect(v.ram[7 * 128 + 0]).toBe(8)
    expect(v.ram[1], "ninth byte: next column, first page").toBe(9)
  })
})

describe("SSD1306 scrolling (10.2)", () => {
  it("right scroll every 5 frames moves the image one column per 5 × the frame period", () => {
    const c = core()
    plot(c, 10, 0)
    // 26h, dummy, start page 0, interval 000b (5 frames), end page 7, dummies; activate.
    for (const b of [0x26, 0x00, 0x00, 0x00, 0x07, 0x00, 0xff, 0x2f]) c.command(b, 0)
    const frame = c.framePeriod()
    // D = 1, K = phase1 1 + phase2 15 (D9h F1h) + 50 = 66, MUX 64 at 370 kHz.
    expect(frame).toBeCloseTo((1 * 66 * 64) / SSD1306.fosc, 12)
    c.advance(5 * frame * 3 + 1e-9)
    expect(litAt(c)).toEqual([[13, 0]])
  })
})

describe("the modules' interfaces", () => {
  it("I²C: a stream of commands after 00h, then data after 40h, at 0x3C", () => {
    const m = new OledI2c("DS1", {}, { width: 128, height: 64 })
    m.sense((pin) => (pin === "VCC" ? 5 : pin === "$vdd" ? 3.3 : 0), 0)
    let t = 1e-3
    let sda = true
    const put = (pin: "SDA" | "SCL", level: boolean) => {
      if (pin === "SDA") sda = level
      const slave = m.drive("SDA")
      m.input(pin, pin === "SDA" ? sda && slave !== false : level, (t += 2.5e-6))
    }
    const send = (bytes: number[]) => {
      put("SDA", false)
      put("SCL", false)
      for (const byte of bytes) {
        for (let i = 7; i >= 0; i--) {
          put("SDA", ((byte >> i) & 1) === 1)
          put("SCL", true)
          put("SCL", false)
        }
        put("SDA", true)
        put("SCL", true)
        put("SCL", false)
      }
      put("SDA", false)
      put("SCL", true)
      put("SDA", true)
    }
    send([0x3c << 1, 0x00, ...adafruitInit(64), 0x21, 0, 127, 0x22, 0, 7])
    send([0x3c << 1, 0x40, 0x01])
    const snap = m.snapshot()
    expect(snap.on).toBe(true)
    expect(snap.pump).toBe(true)
    expect(snap.screen.dots[0], "pixel (0, 0)").toBeGreaterThan(0)
    expect(snap.address).toBe(0x3c)
  })

  it("SPI: D/C# taken with the eighth bit; nothing happens until RES# has pulsed", () => {
    const m = new OledSpi("DS1", {}, { width: 128, height: 64 })
    m.sense((pin) => (pin === "VCC" ? 5 : pin === "$vdd" ? 3.3 : 0), 0)
    let t = 0
    const set = (pin: string, level: boolean) => m.input(pin, level, (t += 50e-9))
    const send = (dc: boolean, byte: number) => {
      set("DC", dc)
      for (let i = 7; i >= 0; i--) {
        set("D1", ((byte >> i) & 1) === 1)
        set("D0", true)
        set("D0", false)
      }
    }
    set("CS", false)
    send(false, 0xaf)
    expect(m.snapshot().on, "RES# never released: held in reset").toBe(false)
    set("RES", false)
    t += 5e-6
    set("RES", true)
    for (const b of adafruitInit(64)) send(false, b)
    send(true, 0xff)
    expect(m.snapshot().on).toBe(true)
    expect(m.snapshot().screen.dots.filter(Boolean).length).toBeGreaterThanOrEqual(8)
  })

  it("draws the panel's current: all lit at FFh is ISEG × 128 × (7.5 V / 3.3 V) plus the controller", () => {
    const c = core()
    c.command(0x81, 0)
    c.command(0xff, 0)
    c.command(0xa5, 0)
    const i = c.current(3.3)
    const expected = SSD1306.iddOn + SSD1306.iccOn + ((255 / 256) * SSD1306.isegMax * 128 * 7.5) / 3.3
    expect(i).toBeCloseTo(expected, 9)
  })
})
