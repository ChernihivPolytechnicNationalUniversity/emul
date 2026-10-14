/**
 * HD44780-compatible character LCD controller, and the glass it drives.
 *
 * The controller follows the Hitachi HD44780U sheet (ADE-207-272(Z) Rev 0.0): the instruction
 * set and its execution times at 270 kHz (Table 6: 37 µs, return home 1.52 ms, data 37 µs + tADD
 * 4 µs), the busy flag — an instruction sent while busy is not accepted —, 8- and 4-bit buses
 * (the high nibble first), the data register a read returns (loaded by an address set or the
 * previous read, not by a write), the function set that cannot be changed once other
 * instructions have run unless the data length changes, the internal reset (8-bit, one line,
 * display off, increment, 10 ms busy after VCC reaches 4.5 V), the bus timing (Figure 25/27
 * with the 4.5–5.5 V and 2.7–4.5 V columns), the cursor blinking at 409.6 ms intervals at
 * 250 kHz (379 ms at 270 kHz). Clear display's time is not in Hitachi's table; the Sitronix
 * ST7066U sheet (the KS0066-equivalent the modules carry) gives 1.52 ms.
 *
 * The glass is the Vishay LCD-016M002B (document 37217, 01-Oct-02): 16 × 2, 1/16 duty, its
 * recommended VDD − V0 of 4.2 V (3.8–4.6 V) at 25 °C, 4.8 (4.2–5.1) at 0 °C and 4.0 (3.6–4.4)
 * at 50 °C. A dot's darkness follows the RMS voltage across it, which the drive waveform sets
 * from VLCD = VDD − V0, the duty and the bias (1/16 duty 1/5 bias for two lines, 1/8 1/4 for one
 * line of 5 × 8, 1/11 1/4 for 5 × 10). The glass's threshold and saturation are derived from
 * Vishay's window, which is where an "on" dot is fully dark and an "off" dot fully clear: the
 * threshold is an off dot's RMS at the window's top, the saturation an on dot's at its bottom.
 * So one-line mode on the two-line glass blacks out the first line's unlit dots (the familiar
 * row of blocks) and too little VLCD (a 5 V glass on 3.3 V) leaves it blank.
 */
import { HD44780_A00 } from "./hd44780-a00"
import { I2cSlave, type DigitalEdge, type DigitalPart } from "./digital-part"
import type { Screen } from "./screen"

export const HD44780 = {
  /** Execution times at fosc = 270 kHz (s). */
  instruction: 37e-6,
  home: 1.52e-3,
  clear: 1.52e-3,
  data: 37e-6 + 4e-6,
  /** Internal reset: busy for this long after VCC reaches `resetVolts`, if VCC rose within the window. */
  resetBusy: 10e-3,
  resetVolts: 4.5,
  riseFrom: 0.2,
  rise: [0.1e-3, 10e-3] as const,
  /** Cursor blink half-period at 270 kHz: 409.6 ms at 250 kHz. */
  blink: 409.6e-3 * (250 / 270),
  /** Bus timing (s): [4.5–5.5 V, 2.7–4.5 V]. */
  tcycE: [500e-9, 1000e-9],
  pweh: [230e-9, 450e-9],
  tas: [40e-9, 60e-9],
  tdsw: [80e-9, 195e-9],
  th: [10e-9, 10e-9],
  tddr: [160e-9, 360e-9],
  tdhr: [5e-9, 5e-9],
  /** Input thresholds: VIH1/VIL1, 2.2/0.6 V at 4.5–5.5 V; 0.7 VCC/0.55 V at 2.7–4.5 V. */
} as const

/** Vishay LCD-016M002B recommended VDD − V0 (min, typ, max) by ambient. */
export const VISHAY_016M002B_VOP: readonly (readonly [celsius: number, min: number, typ: number, max: number])[] = [
  [0, 4.2, 4.8, 5.1],
  [25, 3.8, 4.2, 4.6],
  [50, 3.6, 4.0, 4.4],
]

const lerpVop = (celsius: number, k: 1 | 2 | 3) => {
  const t = VISHAY_016M002B_VOP
  const c = Math.max(t[0][0], Math.min(t[t.length - 1][0], celsius))
  for (let i = 1; i < t.length; i++)
    if (c <= t[i][0]) {
      const f = (c - t[i - 1][0]) / (t[i][0] - t[i - 1][0])
      return t[i - 1][k] + (t[i][k] - t[i - 1][k]) * f
    }
  return t[t.length - 1][k]
}

/** RMS across a dot (as a fraction of VLCD) for N-way multiplexing at bias 1/a: selected on, selected off, never selected. */
export function dotRms(duty: number, bias: number) {
  const a = bias
  const n = duty
  return { on: Math.sqrt((a * a + n - 1) / n) / a, off: Math.sqrt(((a - 2) * (a - 2) + n - 1) / n) / a, unselected: 1 / a }
}

/** The glass: VLCD → darkness of a dot by its RMS, threshold and saturation from Vishay's window at the ambient. */
export function glassDarkness(vrms: number, celsius: number) {
  const two = dotRms(16, 5)
  const threshold = two.off * lerpVop(celsius, 3)
  const saturation = two.on * lerpVop(celsius, 1)
  return Math.max(0, Math.min(1, (vrms - threshold) / (saturation - threshold)))
}

export type LcdWarning = { text: string; at: number }

/** The controller's registers and RAM, driven a whole byte or instruction at a time. */
export class Hd44780Core {
  readonly cols: number
  readonly rows: number
  readonly ddram = new Uint8Array(80).fill(0x20)
  readonly cgram = new Uint8Array(64)
  ac = 0
  cg = false
  increment = true
  shiftOnWrite = false
  display = false
  cursor = false
  blink = false
  eightBit = true
  twoLines = false
  bigFont = false
  shift = 0
  busyUntil = 0
  /** Function set accepted only until another instruction runs, then only with a change of data length. */
  locked = false
  dataRegister = 0
  ignoredWhileBusy = 0
  version = 0

  constructor(cols = 16, rows = 2) {
    this.cols = cols
    this.rows = rows
  }

  /** Internal reset by the power-on circuit. */
  reset(time: number) {
    this.ddram.fill(0x20)
    this.ac = 0
    this.cg = false
    this.increment = true
    this.shiftOnWrite = false
    this.display = false
    this.cursor = false
    this.blink = false
    this.eightBit = true
    this.twoLines = false
    this.bigFont = false
    this.shift = 0
    this.locked = false
    this.busyUntil = time + HD44780.resetBusy
    this.version++
  }

  busy(time: number) {
    return time < this.busyUntil
  }

  private ddLimit() {
    return this.twoLines ? 40 : 80
  }

  /** DDRAM index of an address: two lines at 00–27 and 40–67, one line 00–4F. */
  private ddIndex(addr: number) {
    if (!this.twoLines) return addr % 80
    return (addr >= 0x40 ? 40 : 0) + ((addr & 0x3f) % 40)
  }

  private step(dir: 1 | -1) {
    if (this.cg) {
      this.ac = (this.ac + dir + 64) & 0x3f
      return
    }
    if (!this.twoLines) {
      this.ac = (this.ac + dir + 80) % 80
      return
    }
    // Two lines: 27 runs on to 40, 67 back to 00 (and the other way going down).
    const line = this.ac >= 0x40 ? 1 : 0
    let col = (this.ac & 0x3f) + dir
    let l = line
    if (col > 0x27) {
      col = 0
      l ^= 1
    } else if (col < 0) {
      col = 0x27
      l ^= 1
    }
    this.ac = l * 0x40 + col
  }

  private shiftDisplay(dir: 1 | -1) {
    const n = this.ddLimit()
    this.shift = (this.shift + dir + n) % n
  }

  /** An instruction (RS = 0, R/W = 0). Returns false if the controller was busy and ignored it. */
  instruction(byte: number, time: number): boolean {
    if (this.busy(time)) {
      this.ignoredWhileBusy++
      return false
    }
    let took: number = HD44780.instruction
    if (byte & 0x80) {
      this.cg = false
      this.ac = byte & 0x7f
      this.dataRegister = this.ddram[this.ddIndex(this.ac)]
    } else if (byte & 0x40) {
      this.cg = true
      this.ac = byte & 0x3f
      this.dataRegister = this.cgram[this.ac]
    } else if (byte & 0x20) {
      const eightBit = (byte & 0x10) !== 0
      if (!this.locked || eightBit !== this.eightBit) {
        this.eightBit = eightBit
        this.twoLines = (byte & 0x08) !== 0
        this.bigFont = (byte & 0x04) !== 0
        this.shift %= this.ddLimit()
      }
    } else if (byte & 0x10) {
      const right = (byte & 0x04) !== 0
      if (byte & 0x08) this.shiftDisplay(right ? -1 : 1)
      else this.step(right ? 1 : -1)
    } else if (byte & 0x08) {
      this.display = (byte & 0x04) !== 0
      this.cursor = (byte & 0x02) !== 0
      this.blink = (byte & 0x01) !== 0
    } else if (byte & 0x04) {
      this.increment = (byte & 0x02) !== 0
      this.shiftOnWrite = (byte & 0x01) !== 0
    } else if (byte & 0x02) {
      this.ac = 0
      this.cg = false
      this.shift = 0
      took = HD44780.home
    } else if (byte & 0x01) {
      this.ddram.fill(0x20)
      this.ac = 0
      this.cg = false
      this.shift = 0
      this.increment = true
      took = HD44780.clear
    }
    if ((byte & 0xe0) !== 0x20 && byte !== 0) this.locked = true
    this.busyUntil = time + took
    this.version++
    return true
  }

  /** Data into DDRAM or CGRAM (RS = 1, R/W = 0). */
  write(byte: number, time: number): boolean {
    if (this.busy(time)) {
      this.ignoredWhileBusy++
      return false
    }
    this.locked = true
    if (this.cg) this.cgram[this.ac & 0x3f] = byte
    else {
      this.ddram[this.ddIndex(this.ac)] = byte
      if (this.shiftOnWrite) this.shiftDisplay(this.increment ? 1 : -1)
    }
    this.step(this.increment ? 1 : -1)
    this.busyUntil = time + HD44780.data
    this.version++
    return true
  }

  /** Busy flag and address counter (RS = 0, R/W = 1): read at any time. */
  status(time: number) {
    return (this.busy(time) ? 0x80 : 0) | (this.ac & 0x7f)
  }

  /** Data read (RS = 1, R/W = 1): the data register, then the next address is loaded into it. */
  read(time: number): number {
    const value = this.dataRegister
    if (this.busy(time)) {
      this.ignoredWhileBusy++
      return value
    }
    this.locked = true
    this.step(this.increment ? 1 : -1)
    this.dataRegister = this.cg ? this.cgram[this.ac & 0x3f] : this.ddram[this.ddIndex(this.ac)]
    this.busyUntil = time + HD44780.data
    return value
  }

  /** The 5 dots of character `code`'s glyph row `row` (0–7; CGRAM for 00–0F, 5 × 8 only). */
  private glyph(code: number, row: number) {
    if (code < 0x10) return this.cgram[((code & 0x07) << 3) | row] & 0x1f
    return HD44780_A00[code * 8 + row]
  }

  /**
   * The glass as the controller drives it: every dot's darkness 0–255. `vlcd` is VDD − V0,
   * `celsius` the ambient, `time` for the cursor blink.
   */
  screen(vlcd: number, celsius: number, time: number, on: boolean): number[] {
    const width = this.cols * 5
    const height = this.rows * 8
    const dots = new Array<number>(width * height).fill(0)
    if (!on || vlcd <= 0) return dots
    // Which COM lines the controller scans: 16 for two lines, 8 (5 × 8) or 11 (5 × 10) for one.
    const duty = this.twoLines ? 16 : this.bigFont ? 11 : 8
    const bias = this.twoLines ? 5 : 4
    const rms = dotRms(duty, bias)
    const level = (v: number) => Math.round(255 * glassDarkness(v * vlcd, celsius))
    const onDot = level(rms.on)
    const offDot = level(rms.off)
    const idle = level(rms.unselected)
    const blinkPhase = Math.floor(time / HD44780.blink) % 2 === 0
    const cursorIndex = this.cg ? -1 : this.ddIndex(this.ac)
    for (let line = 0; line < this.rows; line++)
      for (let col = 0; col < this.cols; col++)
        for (let row = 0; row < 8; row++) {
          const com = line * 8 + row
          let pattern = 0
          const scanned = com < duty
          if (scanned && this.display) {
            if (this.twoLines) {
              const index = line * 40 + ((col + this.shift) % 40)
              pattern = this.cell(index, row, cursorIndex, blinkPhase)
            } else if (line === 0) {
              const index = (col + this.shift) % 80
              pattern = this.cell(index, row, cursorIndex, blinkPhase)
            } else {
              // 5 × 10, one line: COM9–11 carry the glyphs' rows 9–11 into the second line's
              // first three dot rows. The A00 5 × 10 descenders are not in the table: blank,
              // but for the cursor on the 11th row.
              const index = (col + this.shift) % 80
              pattern = row === 2 && this.cursor && index === cursorIndex ? 0x1f : 0
            }
          }
          for (let x = 0; x < 5; x++) {
            const lit = (pattern >> (4 - x)) & 1
            dots[(line * 8 + row) * width + col * 5 + x] = !scanned ? idle : lit ? onDot : offDot
          }
        }
    return dots
  }

  private cell(index: number, row: number, cursorIndex: number, blinkPhase: boolean) {
    const at = index === cursorIndex
    if (at && this.blink && blinkPhase) return 0x1f
    let pattern = this.glyph(this.ddram[index], row)
    if (at && this.cursor && row === 7) pattern = 0x1f
    return pattern
  }
}

export type LcdSnapshot = {
  screen: Screen
  ddram: number[]
  cgram: number[]
  ac: number
  busy: boolean
  display: boolean
  twoLines: boolean
  eightBit: boolean
  vcc: number
  vlcd: number
  ignoredWhileBusy: number
  warnings: string[]
  /** I²C backpack only: the expander's 7-bit address and the last byte on its port. */
  address?: number
  port?: number
}

/**
 * Glass and ink colours by the module's glass, lit and with the backlight off (no sheet gives
 * colours: what the two common modules look like). A blue negative glass is transmissive —
 * dark without its backlight; a yellow-green positive one still reads by reflected light.
 */
export const LCD_GLASS: Record<string, { lit: { glass: string; ink: string }; unlit: { glass: string; ink: string } }> = {
  blue: { lit: { glass: "#2a55d8", ink: "#eef4ff" }, unlit: { glass: "#0b1236", ink: "#1a2350" } },
  "yellow-green": { lit: { glass: "#b7cf2c", ink: "#1b2a06" }, unlit: { glass: "#7d8a3a", ink: "#1b2206" } },
}

// --- the bus: pins with their times ---------------------------------------------------------

const DATA = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const
const WARNING_HOLD = 0.5

/**
 * The controller on its pins: RS, R/W, E and D0–D7 levels as they change, with their times.
 * Writes are latched on E's falling edge; a read drives the bus from tDDR after E rises until
 * tDHR after it falls. In 4-bit mode only D4–D7 carry data, high nibble first.
 */
export class LcdBus {
  readonly core: Hd44780Core
  private level: Record<string, boolean> = { RS: true, RW: true, E: false, D0: true, D1: true, D2: true, D3: true, D4: true, D5: true, D6: true, D7: true }
  private changedAt: Record<string, number> = {}
  private eRise = -Infinity
  private eFall = -Infinity
  private lowNibble = false
  private pending = 0
  private readByte = 0
  /** What the controller drives on D0–D7 (null: released). */
  readonly driven: (boolean | null)[] = DATA.map(() => null)
  readonly out: { pin: string; level: boolean | null; time: number }[] = []
  private warnings = new Map<string, LcdWarning>()
  vcc = 0
  powered = false

  constructor(core: Hd44780Core) {
    this.core = core
  }

  /** The timing column for the supply: 4.5–5.5 V or 2.7–4.5 V. */
  private t(name: "tcycE" | "pweh" | "tas" | "tdsw" | "th" | "tddr" | "tdhr") {
    return HD44780[name][this.vcc >= HD44780.resetVolts ? 0 : 1]
  }

  warn(key: string, text: string, at: number) {
    this.warnings.set(key, { text, at })
  }

  warningsAt(time: number) {
    return [...this.warnings.values()].filter((w) => time - w.at <= WARNING_HOLD).map((w) => w.text)
  }

  reset() {
    this.lowNibble = false
    this.pending = 0
    this.eRise = -Infinity
    this.eFall = -Infinity
    this.release(0)
    this.warnings.clear()
  }

  /** A level as it already stands (the part joins a running net): no edge, nothing done. */
  prime(pin: string, level: boolean, time: number) {
    this.level[pin] = level
    this.changedAt[pin] = time
  }

  input(pin: string, level: boolean, time: number) {
    if (this.level[pin] === level) return
    const was = this.changedAt[pin] ?? -Infinity
    this.level[pin] = level
    this.changedAt[pin] = time
    if (!this.powered) return
    if (pin === "E") {
      if (level) this.rise(time)
      else this.fall(time, was)
      return
    }
    if (pin.startsWith("D") && time > this.eFall && time - this.eFall < this.t("th") && !this.level.RW)
      this.warn(`hold ${pin}`, `${pin} changed ${formatNs(time - this.eFall)} after E fell; it must hold ${formatNs(this.t("th"))} (tH)`, time)
    if ((pin === "RS" || pin === "RW") && this.level.E) this.warn(`rs-${pin}`, `${pin === "RW" ? "R/W" : "RS"} changed while E was high`, time)
  }

  private rise(time: number) {
    if (time - this.eRise < this.t("tcycE")) this.warn("tcycE", `E cycle ${formatNs(time - this.eRise)} is shorter than tcycE ${formatNs(this.t("tcycE"))}`, time)
    for (const p of ["RS", "RW"] as const) {
      const at = this.changedAt[p] ?? -Infinity
      if (time - at < this.t("tas")) this.warn(`tas ${p}`, `${p === "RW" ? "R/W" : "RS"} set up ${formatNs(time - at)} before E rose; tAS is ${formatNs(this.t("tas"))}`, time)
    }
    this.eRise = time
    if (!this.level.RW) return
    // A read: the first (or only) transfer of a byte fetches it.
    if (!this.core.eightBit && this.lowNibble) {
      this.drive((this.readByte << 4) & 0xf0, time + this.t("tddr"))
      return
    }
    this.readByte = this.level.RS ? this.core.read(time) : this.core.status(time)
    this.drive(this.readByte, time + this.t("tddr"))
  }

  private fall(time: number, rose: number) {
    if (time - rose < this.t("pweh")) this.warn("pweh", `E high for ${formatNs(time - rose)}; PWEH is ${formatNs(this.t("pweh"))}`, time)
    this.eFall = time
    if (this.level.RW) {
      if (!this.core.eightBit) this.lowNibble = !this.lowNibble
      this.release(time + this.t("tdhr"))
      return
    }
    const lines = this.core.eightBit ? DATA : DATA.slice(4)
    for (const d of lines) {
      const at = this.changedAt[d] ?? -Infinity
      if (time - at < this.t("tdsw")) this.warn(`tdsw ${d}`, `${d} set up ${formatNs(time - at)} before E fell; tDSW is ${formatNs(this.t("tdsw"))}`, time)
    }
    let byte = 0
    DATA.forEach((d, i) => {
      if (this.level[d]) byte |= 1 << i
    })
    if (!this.core.eightBit) {
      if (!this.lowNibble) {
        this.pending = byte & 0xf0
        this.lowNibble = true
        return
      }
      byte = this.pending | (byte >> 4)
      this.lowNibble = false
    }
    const done = this.level.RS ? this.core.write(byte, time) : this.core.instruction(byte, time)
    if (!done) this.warn("busy", `${this.level.RS ? "Data" : "An instruction"} sent while the busy flag was set was ignored (${this.core.ignoredWhileBusy} so far)`, time)
  }

  private drive(byte: number, time: number) {
    DATA.forEach((d, i) => {
      if (!this.core.eightBit && i < 4) return
      const level = ((byte >> i) & 1) === 1
      if (this.driven[i] === level) return
      this.driven[i] = level
      this.out.push({ pin: d, level, time })
    })
  }

  private release(time: number) {
    DATA.forEach((d, i) => {
      if (this.driven[i] === null) return
      this.driven[i] = null
      this.out.push({ pin: d, level: null, time })
    })
  }
}

const formatNs = (s: number) => (Number.isFinite(s) ? `${Math.round(s * 1e9)} ns` : "never")

// --- power: the internal reset ----------------------------------------------------------------

/** Below this the controller does not run (the bottom of the 2.7–4.5 V range). */
const RUN_VOLTS = 2.7

/**
 * VCC as the power-on reset sees it: rising through 0.2 V starts the clock on the rise, reaching
 * 4.5 V within 0.1–10 ms is the condition for the internal reset. A supply outside that window
 * (an ideal source steps up in one solver step; a 3.3 V supply never reaches 4.5 V) still gets
 * the reset here, with a warning that a real part does not promise it — initialise by
 * instruction, as the sheet says to.
 */
export class LcdPower {
  private riseStart = -Infinity
  private reached = false
  running = false

  sense(vcc: number, time: number, bus: LcdBus) {
    bus.vcc = vcc
    if (vcc < HD44780.riseFrom) {
      this.riseStart = -Infinity
      this.reached = false
      if (this.running) this.stop(bus)
      return
    }
    if (!Number.isFinite(this.riseStart)) this.riseStart = time
    if (!this.running && vcc >= RUN_VOLTS) {
      this.running = true
      bus.powered = true
      bus.core.reset(time)
      bus.reset()
    } else if (this.running && vcc < RUN_VOLTS) this.stop(bus)
    if (this.running && !this.reached && vcc >= HD44780.resetVolts) {
      this.reached = true
      const rise = time - this.riseStart
      bus.core.busyUntil = time + HD44780.resetBusy
      if (rise < HD44780.rise[0] || rise > HD44780.rise[1])
        bus.warn("reset", `VCC rose from 0.2 to 4.5 V in ${(rise * 1e3).toFixed(2)} ms, outside the 0.1–10 ms the internal reset needs: initialise by instruction`, time)
    }
    // Still short of 4.5 V and no longer rising: the reset's condition will not be met.
    if (this.running && !this.reached && vcc <= this.last + 1e-3) bus.warn("reset", `VCC ${vcc.toFixed(2)} V never reached the 4.5 V the internal reset needs: initialise by instruction`, time)
    this.last = vcc
  }
  private last = 0

  private stop(bus: LcdBus) {
    this.running = false
    bus.powered = false
  }
}

// --- the parallel module ------------------------------------------------------------------------

/** Every 16-pin module drawn here: RS, R/W, E, D0–D7; the supply on VDD/VSS, contrast on V0. */
export class LcdParallel implements DigitalPart {
  readonly object: string
  readonly pins = ["RS", "RW", "E", ...DATA] as const
  readonly outputs = DATA
  readonly senses = ["VDD", "VSS", "V0"] as const
  readonly out: DigitalEdge[]
  private readonly core = new Hd44780Core(16, 2)
  private readonly bus = new LcdBus(this.core)
  private readonly power = new LcdPower()
  private vlcd = 0
  private time = 0
  private celsius = 25
  private glass = LCD_GLASS.blue
  private dots: number[] = []
  private version = 0

  constructor(object: string, props: Record<string, string>) {
    this.object = object
    this.out = this.bus.out as DigitalEdge[]
    this.configure(props)
  }

  configure(props: Record<string, string>) {
    const t = Number(props.temp)
    this.celsius = Number.isFinite(t) ? t : 25
    this.glass = LCD_GLASS[props.glass] ?? LCD_GLASS.blue
  }

  reset() {
    this.core.reset(0)
    this.bus.reset()
    this.power.running = false
    this.bus.powered = false
    this.time = 0
  }

  drive(pin: string): boolean | null {
    const i = DATA.indexOf(pin as (typeof DATA)[number])
    return i < 0 ? null : this.bus.driven[i]
  }

  thresholds(): [falling: number, rising: number] {
    // VIL1 / VIH1 by the supply range.
    return this.bus.vcc >= HD44780.resetVolts ? [0.6, 2.2] : [0.55, 0.7 * this.bus.vcc]
  }

  input(pin: string, level: boolean, time: number) {
    this.time = Math.max(this.time, time)
    this.bus.input(pin, level, time)
  }

  prime(levels: Map<string, boolean>, time: number) {
    for (const [pin, level] of levels) this.bus.prime(pin, level, time)
  }

  sense(volts: (pin: string) => number, time: number) {
    const vss = volts("VSS")
    this.time = Math.max(this.time, time)
    this.power.sense(volts("VDD") - vss, time, this.bus)
    this.vlcd = volts("VDD") - volts("V0")
  }

  snapshot(): LcdSnapshot {
    const dots = this.core.screen(this.vlcd, this.celsius, this.time, this.power.running)
    if (dots.length !== this.dots.length || dots.some((d, i) => d !== this.dots[i])) {
      this.dots = dots
      this.version++
    }
    return {
      screen: { width: 80, height: 16, cell: { w: 5, h: 8 }, dots: this.dots, glass: this.glass.lit.glass, ink: this.glass.lit.ink, unlit: this.glass.unlit, version: this.version },
      ddram: Array.from(this.core.ddram),
      cgram: Array.from(this.core.cgram),
      ac: this.core.ac,
      busy: this.core.busy(this.time),
      display: this.core.display,
      twoLines: this.core.twoLines,
      eightBit: this.core.eightBit,
      vcc: this.bus.vcc,
      vlcd: this.vlcd,
      ignoredWhileBusy: this.core.ignoredWhileBusy,
      warnings: this.bus.warningsAt(this.time),
    }
  }
}

// --- the I²C backpack: PCF8574 driving the module in 4-bit mode ---------------------------------

/**
 * The common blue "I2C LCD backpack" (its schematic as playembedded.org redraws it): a PCF8574T
 * (or PCF8574AT) whose port drives the module — P0 RS, P1 R/W, P2 E, P3 the backlight transistor,
 * P4–P7 D4–D7; D0–D3 are left to the controller's own pull-ups. A0–A2 have 10 kΩ pull-ups and
 * open solder pads, so the address is 0x27 (0x3F on an A chip) until a pad is bridged.
 *
 * The expander after NXP PCF8574/74A Rev. 5 (2013) and TI SCPS068K: a quasi-bidirectional port
 * that comes up high, a written 0 sinks hard, a written 1 is a weak pull-up the module can pull
 * down; data written appears on the port after the acknowledge; a read returns the pins; the
 * bus is specified to 100 kHz.
 */
export class LcdBackpack extends I2cSlave {
  readonly pins = ["SDA", "SCL"] as const
  readonly senses = ["VCC", "GND", "$v0"] as const
  private readonly core = new Hd44780Core(16, 2)
  private readonly bus = new LcdBus(this.core)
  private readonly power = new LcdPower()
  private port = 0xff
  private base = 0x20
  private straps = 0x07
  private time = 0
  private vlcd = 0
  private celsius = 25
  private glass = LCD_GLASS.blue
  private dots: number[] = []
  private version = 0
  private lastScl = -Infinity
  private sclPeriods = 0

  constructor(object: string, props: Record<string, string>) {
    super(object, "SDA", "SCL")
    this.configure(props)
    // D0–D3 float on the backpack: the controller's pull-ups hold them high.
    for (const d of ["D0", "D1", "D2", "D3"]) this.bus.prime(d, true, 0)
  }

  configure(props: Record<string, string>) {
    this.base = props.chip === "PCF8574AT" ? 0x38 : 0x20
    // A bridged pad pulls its address line to ground.
    this.straps = (props.a0 === "bridged" ? 0 : 1) | (props.a1 === "bridged" ? 0 : 2) | (props.a2 === "bridged" ? 0 : 4)
    const t = Number(props.temp)
    this.celsius = Number.isFinite(t) ? t : 25
    this.glass = LCD_GLASS[props.glass] ?? LCD_GLASS.blue
  }

  reset() {
    super.reset()
    this.port = 0xff
    this.core.reset(0)
    this.bus.reset()
    this.power.running = false
    this.bus.powered = false
  }

  thresholds(): [falling: number, rising: number] {
    // PCF8574: VIL 0.3 VDD, VIH 0.7 VDD.
    return [0.3 * this.bus.vcc, 0.7 * this.bus.vcc]
  }

  input(pin: string, level: boolean, time: number) {
    this.time = Math.max(this.time, time)
    if (pin === "SCL" && level) {
      // 100 kHz exactly is within the limit: the gap is compared with a nanosecond's slack for rounding.
      if (time - this.lastScl < 10e-6 - 1e-9) {
        this.sclPeriods++
        this.bus.warn("scl", `SCL at ${Math.round(1e-3 / (time - this.lastScl))} kHz: the PCF8574 is specified to 100 kHz`, time)
      }
      this.lastScl = time
    }
    super.input(pin, level, time)
  }

  protected address() {
    return this.power.running ? this.base | this.straps : -1
  }

  protected onSelected() {}

  protected onByte(byte: number) {
    this.writePort(byte, this.time)
  }

  protected nextByte() {
    // The pins: a written 0 holds its line low; a 1 lets the module (D4–D7 when it reads) decide.
    let value = 0
    for (let i = 0; i < 8; i++) {
      if (!((this.port >> i) & 1)) continue
      const driven = i >= 4 ? this.bus.driven[i] : null
      if (driven !== false) value |= 1 << i
    }
    return value
  }

  private writePort(byte: number, time: number) {
    const names = ["RS", "RW", "E", "", "D4", "D5", "D6", "D7"]
    const changed = byte ^ this.port
    this.port = byte
    // RS and R/W first, data next, E last: on one write they change together, and the bus's own
    // setup checks see what a real backpack gives (all eight lines in one port update).
    for (const i of [0, 1, 4, 5, 6, 7, 2]) if ((changed >> i) & 1) this.bus.input(names[i], ((byte >> i) & 1) === 1, time)
  }

  /** The backlight transistor's base follows P3. */
  backlightOn() {
    return this.power.running && ((this.port >> 3) & 1) === 1
  }

  analog(key: string): number | undefined {
    // 8050 saturated: VCE(sat) 0.5 V at 500 mA (CJ S8050), as ohms; off, open.
    if (key === "$bl") return this.backlightOn() ? 1 : 1e9
    return undefined
  }

  sense(volts: (pin: string) => number, time: number) {
    this.time = Math.max(this.time, time)
    const wasRunning = this.power.running
    this.power.sense(volts("VCC") - volts("GND"), time, this.bus)
    if (this.power.running && !wasRunning) this.port = 0xff
    this.vlcd = volts("VCC") - volts("$v0")
  }

  tick(): boolean {
    const on = this.backlightOn()
    if (on === this.lastBacklight) return false
    this.lastBacklight = on
    return true
  }
  private lastBacklight = false

  quietUntil() {
    return Infinity
  }

  snapshot(): LcdSnapshot {
    const dots = this.core.screen(this.vlcd, this.celsius, this.time, this.power.running)
    if (dots.length !== this.dots.length || dots.some((d, i) => d !== this.dots[i])) {
      this.dots = dots
      this.version++
    }
    return {
      screen: { width: 80, height: 16, cell: { w: 5, h: 8 }, dots: this.dots, glass: this.glass.lit.glass, ink: this.glass.lit.ink, unlit: this.glass.unlit, version: this.version },
      ddram: Array.from(this.core.ddram),
      cgram: Array.from(this.core.cgram),
      ac: this.core.ac,
      busy: this.core.busy(this.time),
      display: this.core.display,
      twoLines: this.core.twoLines,
      eightBit: this.core.eightBit,
      vcc: this.bus.vcc,
      vlcd: this.vlcd,
      ignoredWhileBusy: this.core.ignoredWhileBusy,
      warnings: this.bus.warningsAt(this.time),
      address: this.base | this.straps,
      port: this.port,
    }
  }
}
