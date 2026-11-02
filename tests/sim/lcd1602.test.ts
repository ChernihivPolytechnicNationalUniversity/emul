/**
 * The 16 × 2 HD44780 module against its sheets: the controller driven pin by pin as a 4-bit
 * library would (Hitachi Figure 24's initialisation by instruction), the busy flag losing what is
 * sent too early, the data register reads, the glass's darkness from VDD − V0 by Vishay's window
 * (the row of blocks in one-line mode, a blank glass on 3.3 V), and the PCF8574 backpack.
 */
import { describe, expect, it } from "vitest"
import { dotRms, glassDarkness, HD44780, Hd44780Core, LcdBackpack, LcdParallel, type LcdSnapshot, VISHAY_016M002B_VOP } from "@/sim/hd44780"
import { HD44780_A00 } from "@/sim/hd44780-a00"

/** A 4-bit host on the parallel module: levels with times, as a firmware's GPIO writes would land. */
function host(vdd = 5, v0 = 0.8) {
  const lcd = new LcdParallel("DS1", { glass: "blue", temp: "25" })
  let t = 0
  const volts = (pin: string) => (pin === "VDD" ? vdd : pin === "V0" ? v0 : 0)
  // The supply rises over 1 ms, inside the reset's 0.1–10 ms window.
  for (let k = 1; k <= 50; k++) lcd.sense((pin) => (pin === "VDD" ? (vdd * k) / 50 : pin === "V0" ? (v0 * k) / 50 : 0), (k * 1e-3) / 50)
  t = 1e-3
  const set = (pin: string, level: boolean) => lcd.input(pin, level, (t += 1e-6))
  const nibble = (rs: boolean, value: number) => {
    set("RS", rs)
    set("RW", false)
    for (let i = 0; i < 4; i++) set(`D${4 + i}`, ((value >> i) & 1) === 1)
    set("E", true)
    set("E", false)
  }
  const wait = (s: number) => {
    t += s
    lcd.sense(volts, t)
  }
  const byte = (rs: boolean, value: number) => {
    nibble(rs, value >> 4)
    nibble(rs, value & 0x0f)
    wait(rs ? HD44780.data : value <= 3 ? HD44780.clear : HD44780.instruction)
  }
  const init = () => {
    wait(15e-3)
    nibble(false, 0x3)
    wait(4.1e-3)
    nibble(false, 0x3)
    wait(100e-6)
    nibble(false, 0x3)
    wait(100e-6)
    nibble(false, 0x2)
    wait(HD44780.instruction)
    byte(false, 0x28) // 4-bit, two lines, 5 × 8
    byte(false, 0x0c) // display on
    byte(false, 0x01) // clear
    byte(false, 0x06) // increment
  }
  const print = (text: string) => {
    for (const ch of text) byte(true, ch.charCodeAt(0))
  }
  const snap = () => lcd.snapshot() as LcdSnapshot
  return { lcd, set, nibble, byte, init, print, wait, snap, time: () => t }
}

const row = (s: LcdSnapshot, line: number) =>
  Array.from({ length: 16 }, (_, c) => String.fromCharCode(s.ddram[line * 40 + c]))
    .join("")
    .trimEnd()

/** The dots of one character cell, as 0/1 by whether a dot is darker than half. */
function cellDots(s: LcdSnapshot, line: number, col: number) {
  const out: number[] = []
  for (let r = 0; r < 8; r++) {
    let bits = 0
    for (let x = 0; x < 5; x++) if (s.screen.dots[(line * 8 + r) * 80 + col * 5 + x] > 127) bits |= 1 << (4 - x)
    out.push(bits)
  }
  return out
}

const glyph = (code: number) => Array.from(HD44780_A00.subarray(code * 8, code * 8 + 8))

describe("HD44780 controller", () => {
  it("initialised by instruction in 4-bit mode, prints on both lines and shows the A00 glyphs", () => {
    const h = host()
    h.init()
    h.print("Hello")
    h.byte(false, 0xc0)
    h.print("World 25\xdfC")
    const s = h.snap()
    expect(s.eightBit).toBe(false)
    expect(s.twoLines).toBe(true)
    expect(row(s, 0)).toBe("Hello")
    expect(row(s, 1)).toBe("World 25\xdfC")
    expect(cellDots(s, 0, 0), "H on the glass").toEqual(glyph(0x48))
    expect(cellDots(s, 1, 8), "degree sign").toEqual(glyph(0xdf))
    expect(s.warnings).toEqual([])
  })

  it("an instruction sent while busy is ignored, and the inspector says so", () => {
    const h = host()
    h.init()
    // Clear takes 1.52 ms; the data right after it is lost.
    h.nibble(false, 0x0)
    h.nibble(false, 0x1)
    h.nibble(true, 0x4)
    h.nibble(true, 0x1)
    h.wait(2e-3)
    const s = h.snap()
    // Both halves of the "A" land while busy: two transfers lost, the next nibble a high one again.
    expect(s.ignoredWhileBusy).toBe(2)
    expect(row(s, 0)).toBe("")
    expect(s.warnings.join(" ")).toMatch(/busy flag/)
  })

  it("the busy flag reads back on D7 while an instruction runs", () => {
    const h = host()
    h.init()
    h.nibble(false, 0x0)
    h.nibble(false, 0x1)
    // Read the status: RS 0, R/W 1, E high — D7 is driven high tDDR later.
    h.set("RS", false)
    h.set("RW", true)
    h.set("E", true)
    const out = h.lcd.out.splice(0).filter((e) => e.pin === "D7")
    expect(out.at(-1)?.level).toBe(true)
    h.set("E", false)
  })

  it("custom characters from CGRAM", () => {
    const h = host()
    h.init()
    h.byte(false, 0x40)
    const smile = [0x00, 0x0a, 0x0a, 0x00, 0x11, 0x0e, 0x00, 0x00]
    for (const b of smile) h.byte(true, b)
    h.byte(false, 0x80)
    h.byte(true, 0x00)
    expect(cellDots(h.snap(), 0, 0)).toEqual(smile)
  })

  it("function set is fixed once other instructions ran, unless the data length changes", () => {
    const core = new Hd44780Core()
    core.reset(0)
    let t = 0.02
    core.instruction(0x38, (t += 1e-3))
    expect(core.twoLines).toBe(true)
    core.instruction(0x0c, (t += 1e-3))
    core.instruction(0x30, (t += 1e-3))
    expect(core.twoLines, "same data length: ignored").toBe(true)
    core.instruction(0x20, (t += 1e-3))
    expect(core.eightBit).toBe(false)
    expect(core.twoLines, "data length changed: taken").toBe(false)
  })

  it("a read after a write returns the stale data register; after an address set, the RAM", () => {
    const core = new Hd44780Core()
    core.reset(0)
    let t = 0.02
    core.instruction(0x38, (t += 1e-3))
    core.instruction(0x80, (t += 1e-3))
    core.write(0x41, (t += 1e-3))
    expect(core.read((t += 1e-3)), "stale register (address set loaded the blank)").toBe(0x20)
    core.instruction(0x80, (t += 1e-3))
    expect(core.read((t += 1e-3))).toBe(0x41)
  })
})

describe("the parallel module's bus direction", () => {
  it("drives D0–D7 only to answer a read: with R/W on ground it never drives, so a core feeding it need not stop at each edge", () => {
    const lcd = new LcdParallel("DS1", {})
    expect(lcd.outputsWhenGrounded((pin) => pin === "RW")).toEqual([])
    expect(lcd.outputsWhenGrounded((pin) => pin === "VSS")).toEqual(["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"])
  })
})

describe("the glass (Vishay LCD-016M002B)", () => {
  it("threshold and saturation come from the recommended window at each temperature", () => {
    const two = dotRms(16, 5)
    for (const [c, min, , max] of VISHAY_016M002B_VOP) {
      expect(glassDarkness(two.on * min, c), `${c} °C: an on dot at the window's bottom is fully dark`).toBeCloseTo(1, 9)
      expect(glassDarkness(two.off * max, c), `${c} °C: an off dot at the window's top is clear`).toBeCloseTo(0, 9)
    }
  })

  it("at the typical 4.2 V the text is crisp: lit dots full, unlit clear", () => {
    const h = host(5, 0.8)
    h.init()
    h.print("8")
    const s = h.snap()
    expect(Math.max(...s.screen.dots)).toBe(255)
    expect(cellDots(s, 0, 0)).toEqual(glyph(0x38))
    expect(s.screen.dots[5 * 5], "an unlit dot of a blank cell").toBe(0)
  })

  it("never initialised (one line after the reset, display off): the first line is a row of blocks, the second blank", () => {
    const h = host(5, 0.8)
    h.wait(20e-3)
    const s = h.snap()
    expect(s.twoLines).toBe(false)
    expect(s.display).toBe(false)
    const first = s.screen.dots.slice(0, 8 * 80)
    const second = s.screen.dots.slice(8 * 80)
    expect(Math.min(...first), "line 1: every dot dark").toBe(255)
    expect(Math.max(...second), "line 2: nothing").toBe(0)
  })

  it("a 5 V module on 3.3 V shows nothing even with V0 on ground", () => {
    const h = host(3.3, 0)
    h.init()
    h.print("Hello")
    expect(row(h.snap(), 0)).toBe("Hello")
    expect(Math.max(...h.snap().screen.dots)).toBe(0)
  })

  it("V0 on ground at 5 V: past the window's top the unlit dots darken too", () => {
    const h = host(5, 0)
    h.init()
    h.print("A")
    const s = h.snap()
    expect(s.screen.dots[5 * 5 + 0], "an unlit dot").toBeGreaterThan(127)
  })

  it("the same contrast that is right at 25 °C is too light at 0 °C (the window moves up as it gets cold)", () => {
    const warm = glassDarkness(dotRms(16, 5).on * 4.2, 25)
    const cold = glassDarkness(dotRms(16, 5).on * 4.0, 0)
    expect(warm).toBe(1)
    expect(cold).toBeLessThan(1)
  })
})

describe("PCF8574 backpack", () => {
  /** Bit-bangs I²C into the backpack at 100 kHz: START, address, bytes, STOP. */
  function i2c(lcd: LcdBackpack, start: number) {
    let t = start
    const half = 5e-6
    let sda = true
    let scl = true
    const put = (pin: "SDA" | "SCL", level: boolean) => {
      if (pin === "SDA") sda = level
      else scl = level
      // The slave's own drive wins on SDA (wired-AND).
      const slave = lcd.drive("SDA")
      lcd.input(pin, pin === "SDA" ? sda && slave !== false : level, (t += half))
    }
    const bit = (b: boolean) => {
      put("SDA", b)
      put("SCL", true)
      put("SCL", false)
    }
    const send = (bytes: number[]) => {
      put("SDA", false)
      put("SCL", false)
      for (const byte of bytes) {
        for (let i = 7; i >= 0; i--) bit(((byte >> i) & 1) === 1)
        put("SDA", true)
        put("SCL", true)
        put("SCL", false)
      }
      put("SDA", false)
      put("SCL", true)
      put("SDA", true)
      void scl
    }
    return { send, now: () => t, wait: (s: number) => (t += s) }
  }

  it("answers at 0x27, drives the module in 4-bit mode and prints", () => {
    const lcd = new LcdBackpack("DS1", { chip: "PCF8574T" })
    for (let k = 1; k <= 50; k++) lcd.sense((pin) => (pin === "VCC" ? (5 * k) / 50 : pin === "$v0" ? (0.8 * k) / 50 : 0), (k * 1e-3) / 50)
    const bus = i2c(lcd, 1e-3)
    const settle = () => lcd.sense((pin) => (pin === "VCC" ? 5 : pin === "$v0" ? 0.8 : 0), bus.now())
    const BL = 0x08
    const E = 0x04
    const RS = 0x01
    const nibble = (rs: boolean, n: number) => {
      const v = (n << 4) | BL | (rs ? RS : 0)
      bus.send([0x27 << 1, v | E, v])
    }
    const byte = (rs: boolean, b: number) => {
      nibble(rs, b >> 4)
      nibble(rs, b & 15)
      bus.wait(b <= 3 && !rs ? 2e-3 : 50e-6)
      settle()
    }
    bus.wait(50e-3)
    settle()
    for (const [n, w] of [[3, 4.5e-3], [3, 4.5e-3], [3, 150e-6], [2, 100e-6]] as const) {
      nibble(false, n)
      bus.wait(w)
    }
    for (const b of [0x28, 0x0c, 0x01, 0x06]) byte(false, b)
    for (const ch of "I2C ok") byte(true, ch.charCodeAt(0))
    const s = lcd.snapshot()
    expect(s.address).toBe(0x27)
    expect(row(s, 0)).toBe("I2C ok")
    expect(lcd.backlightOn()).toBe(true)
  })

  /** A powered backpack at 0x27 and its bus, the supply up over 1 ms. */
  function powered() {
    const lcd = new LcdBackpack("DS1", { chip: "PCF8574T" })
    for (let k = 1; k <= 50; k++) lcd.sense((pin) => (pin === "VCC" ? (5 * k) / 50 : pin === "$v0" ? (0.8 * k) / 50 : 0), (k * 1e-3) / 50)
    const bus = i2c(lcd, 1e-3)
    const wait = (s: number) => {
      bus.wait(s)
      lcd.sense((pin) => (pin === "VCC" ? 5 : pin === "$v0" ? 0.8 : 0), bus.now())
    }
    return { lcd, bus, wait }
  }

  it("E comes up high with the PCF8574's ports: the first write's falling E latches an instruction, with no timing reported for it", () => {
    const { lcd, bus, wait } = powered()
    wait(50e-3)
    expect(lcd.snapshot().twoLines, "one line after the internal reset").toBe(false)
    // 0x38: D7–D4 = 3, backlight, E low. In 8-bit mode D3–D0 (unwired, pulled up) make it 3Fh.
    bus.send([0x27 << 1, 0x38])
    const s = lcd.snapshot()
    expect(s.twoLines, "3Fh: function set, two lines").toBe(true)
    expect(s.warnings).toEqual([])
  })

  it("instructions sent as two nibbles from the start (30h ×3, 20h, 28h…): the half sent while the return home runs is lost and the pairing comes back", () => {
    const { lcd, bus, wait } = powered()
    const BL = 0x08
    const E = 0x04
    // Each instruction or character in one transfer: high nibble with E high, E low, low nibble likewise.
    const send = (rs: boolean, b: number) => {
      const hi = (b & 0xf0) | BL | (rs ? 1 : 0)
      const lo = ((b << 4) & 0xf0) | BL | (rs ? 1 : 0)
      bus.send([0x27 << 1, hi | E, hi, lo | E, lo])
    }
    wait(50e-3)
    for (const [b, w] of [[0x30, 5e-3], [0x30, 1e-3], [0x30, 10e-3], [0x20, 10e-3], [0x28, 1e-3], [0x08, 1e-3], [0x01, 2e-3], [0x06, 1e-3], [0x0c, 1e-3], [0x80, 1e-3]] as const) {
      send(false, b)
      wait(w)
    }
    for (const ch of "HELLO") {
      send(true, ch.charCodeAt(0))
      wait(100e-6)
    }
    const s = lcd.snapshot()
    // 20h's low 0 pairs with 28h's 2 into 02h (return home, 1.52 ms); 28h's 8 lands while it runs.
    expect(s.ignoredWhileBusy).toBe(1)
    expect(row(s, 0)).toBe("HELLO")
    expect(s.display).toBe(true)
  })

  it("a PCF8574AT with A0 bridged is 0x3E", () => {
    const lcd = new LcdBackpack("DS1", { chip: "PCF8574AT", a0: "bridged" })
    expect(lcd.snapshot().address).toBe(0x3e)
  })
})
