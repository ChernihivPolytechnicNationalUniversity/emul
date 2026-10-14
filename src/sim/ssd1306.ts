/**
 * SSD1306 OLED controller and the 0.96" / 0.91" modules built on it.
 *
 * The controller after Solomon Systech's SSD1306 sheet (Rev 1.1, April 2008): the command table
 * (Table 9-1) with its multi-byte commands, the three addressing modes (10.1.3–10.1.5), start line,
 * segment remap, entire display on, inverse, multiplex ratio, display on/off, COM scan direction,
 * display offset (Tables 10-1 and 10-2: a COM output shows row (j + offset) mod 64 scanning up,
 * (N − 1 − j + offset) mod 64 scanning down, only rows under the multiplex ratio), the COM pins
 * hardware configuration (Table 10-3: sequential or alternative, left/right remap), the charge
 * pump (8Dh, off after reset: without it a module with no external VCC stays dark), contrast
 * (ISEG = contrast / 256 × IREF × 8, 100 µA at FFh with IREF 12.5 µA), the continuous horizontal
 * and vertical scrolls (10.2) at the frame rate F = Fosc / (D × K × MUX), K = phase 1 + phase 2 +
 * 50 DCLKs, Fosc 370 kHz at the reset setting; the I²C (0x3C / 0x3D, control byte Co and D/C#,
 * 400 kHz) and 4-wire SPI (D/C# read with every eighth bit, 10 MHz) interfaces; RES# low for at
 * least 3 µs. GDDRAM holds no defined content at power-on.
 *
 * The glass's row wiring is not in any sheet; it is the one Adafruit's SSD1306 library draws an
 * upright picture on — COM scan C8h, segment remap A1h, and DAh 12h (alternative) for the 64-row
 * panel, 02h (sequential) for the 32-row one — so other settings mirror, flip and interlace it as
 * on the real modules.
 */
import { I2cSlave, type DigitalEdge, type DigitalPart } from "./digital-part"
import type { Screen } from "./screen"
import { srgbEncode } from "@/lib/srgb"

export const SSD1306 = {
  /** Oscillator at the reset setting (D5h A[7:4] = 1000b), Hz. */
  fosc: 370e3,
  /** Segment current at contrast FFh (IREF 12.5 µA × 8), A. */
  isegMax: 100e-6,
  /** Charge pump output, V. */
  pump: 7.5,
  /** Supply currents: sleep 10 µA each of IDD and ICC; operating with all pixels on (no panel), typical. */
  iddSleep: 10e-6,
  iccSleep: 10e-6,
  iddOn: 50e-6,
  iccOn: 430e-6,
  /** Interface limits: I²C clock period ≥ 2.5 µs, SPI clock period ≥ 100 ns, RES# low ≥ 3 µs. */
  i2cPeriod: 2.5e-6,
  spiPeriod: 100e-9,
  resetPulse: 3e-6,
  vddMin: 1.65,
} as const

/** Frames between horizontal scroll steps by the 3-bit interval code (10.2.1). */
const SCROLL_FRAMES = [5, 64, 128, 256, 3, 4, 25, 2]

/** Bytes each multi-byte command takes after its first. */
const ARGS: Record<number, number> = { 0x81: 1, 0x20: 1, 0x21: 2, 0x22: 2, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1, 0x8d: 1, 0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5, 0xa3: 2 }

/** The panel the module carries: rows and how its rows are wired to the COM pads. */
export type Panel = { width: 128; height: 64 | 32 }

export class Ssd1306Core {
  readonly ram = new Uint8Array(128 * 8)
  readonly panel: Panel
  // Registers, at their reset values.
  mode = 2
  colStart = 0
  colEnd = 127
  pageStart = 0
  pageEnd = 7
  col = 0
  page = 0
  startLine = 0
  contrast = 0x7f
  segRemap = false
  entireOn = false
  inverse = false
  mux = 63
  on = false
  comRemap = false
  offset = 0
  clock = 0x80
  precharge = 0x22
  comPins = 0x12
  vcomh = 0x20
  pumpOn = false
  scrolling = false
  scroll: { dir: 1 | -1; start: number; end: number; frames: number; vertical: number } | null = null
  scrollArea: [number, number] = [0, 64]
  private nextScroll = Infinity
  private pending: number[] = []
  version = 0
  unsupported = new Set<string>()

  constructor(panel: Panel, seed: string) {
    this.panel = panel
    // GDDRAM is not defined at power-on: the cells come up as they please.
    let h = 0x811c9dc5
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193)
    for (let i = 0; i < this.ram.length; i++) {
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ i
      this.ram[i] = (h >>> 24) & 0xff
    }
  }

  /** RES# low: every register back to its reset value; the RAM keeps what it holds. */
  reset() {
    this.mode = 2
    this.colStart = 0
    this.colEnd = 127
    this.pageStart = 0
    this.pageEnd = 7
    this.col = 0
    this.page = 0
    this.startLine = 0
    this.contrast = 0x7f
    this.segRemap = false
    this.entireOn = false
    this.inverse = false
    this.mux = 63
    this.on = false
    this.comRemap = false
    this.offset = 0
    this.clock = 0x80
    this.precharge = 0x22
    this.comPins = 0x12
    this.vcomh = 0x20
    this.pumpOn = false
    this.scrolling = false
    this.scroll = null
    this.scrollArea = [0, 64]
    this.pending = []
    this.nextScroll = Infinity
    this.version++
  }

  /** Seconds per frame: Fosc / (D × K × MUX). */
  framePeriod() {
    const d = (this.clock & 0x0f) + 1
    const k = (this.precharge & 0x0f) + ((this.precharge >> 4) & 0x0f) + 50
    return (d * k * (this.mux + 1)) / SSD1306.fosc
  }

  command(byte: number, time: number) {
    if (this.pending.length) {
      this.pending.push(byte)
      if (this.pending.length - 1 < ARGS[this.pending[0]]) return
      this.complete(this.pending, time)
      this.pending = []
      return
    }
    if (ARGS[byte] !== undefined) {
      this.pending = [byte]
      return
    }
    if (byte <= 0x0f) this.col = (this.col & 0xf0) | byte
    else if (byte <= 0x1f) this.col = (this.col & 0x0f) | ((byte & 0x0f) << 4)
    else if (byte === 0x2e) {
      this.scrolling = false
      this.nextScroll = Infinity
    } else if (byte === 0x2f) {
      if (this.scroll) {
        this.scrolling = true
        // The frame rate times only the scroll; the sheet gives Fosc for the reset setting alone.
        if ((this.clock >> 4) !== 0x8) this.unsupported.add("scroll speed with an oscillator setting other than the reset one (the sheet gives Fosc only for it): it scrolls at the reset frequency")
        this.nextScroll = time + this.scroll.frames * this.framePeriod()
      }
    } else if (byte >= 0x40 && byte <= 0x7f) this.startLine = byte & 0x3f
    else if (byte === 0xa0 || byte === 0xa1) this.segRemap = byte === 0xa1
    else if (byte === 0xa4 || byte === 0xa5) this.entireOn = byte === 0xa5
    else if (byte === 0xa6 || byte === 0xa7) this.inverse = byte === 0xa7
    else if (byte === 0xae || byte === 0xaf) this.on = byte === 0xaf
    else if (byte >= 0xb0 && byte <= 0xb7) this.page = byte & 0x07
    else if (byte === 0xc0 || byte === 0xc8) this.comRemap = byte === 0xc8
    else if (byte === 0xe3) {
      // NOP
    } else this.unsupported.add(`command ${byte.toString(16).toUpperCase().padStart(2, "0")}h`)
    this.version++
  }

  private complete(c: number[], time: number) {
    const [op, a = 0, b = 0] = c
    switch (op) {
      case 0x81:
        this.contrast = a
        break
      case 0x20:
        this.mode = a & 0x03
        if (this.mode === 3) this.unsupported.add("addressing mode 11b (invalid)")
        break
      case 0x21:
        this.colStart = a & 0x7f
        this.colEnd = b & 0x7f
        this.col = this.colStart
        break
      case 0x22:
        this.pageStart = a & 0x07
        this.pageEnd = b & 0x07
        this.page = this.pageStart
        break
      case 0xa8:
        // 16 to 64 MUX; 0 to 14 are invalid entries.
        if ((a & 0x3f) >= 15) this.mux = a & 0x3f
        break
      case 0xd3:
        this.offset = a & 0x3f
        break
      case 0xd5:
        this.clock = a
        break
      case 0xd9:
        this.precharge = a
        break
      case 0xda:
        this.comPins = a
        break
      case 0xdb:
        this.vcomh = a
        break
      case 0x8d:
        this.pumpOn = (a & 0x04) !== 0
        break
      case 0x26:
      case 0x27:
        this.scrolling = false
        this.scroll = { dir: op === 0x26 ? 1 : -1, start: c[2] & 7, end: c[4] & 7, frames: SCROLL_FRAMES[c[3] & 7], vertical: 0 }
        break
      case 0x29:
      case 0x2a:
        this.scrolling = false
        this.scroll = { dir: op === 0x29 ? 1 : -1, start: c[2] & 7, end: c[4] & 7, frames: SCROLL_FRAMES[c[3] & 7], vertical: c[5] & 0x3f }
        break
      case 0xa3:
        this.scrollArea = [a & 0x3f, b & 0x7f]
        break
    }
    void time
    this.version++
  }

  data(byte: number) {
    this.ram[this.page * 128 + (this.col & 0x7f)] = byte
    if (this.mode === 2) {
      this.col = this.col >= this.colEnd ? this.colStart : this.col + 1
    } else if (this.mode === 0) {
      if (this.col >= this.colEnd) {
        this.col = this.colStart
        this.page = this.page >= this.pageEnd ? this.pageStart : this.page + 1
      } else this.col++
    } else if (this.mode === 1) {
      if (this.page >= this.pageEnd) {
        this.page = this.pageStart
        this.col = this.col >= this.colEnd ? this.colStart : this.col + 1
      } else this.page++
    }
    this.version++
  }

  /** Scroll steps due by `time`: the pages' columns rotate one place, the start line moves by the vertical offset. */
  advance(time: number) {
    let moved = false
    while (this.scrolling && this.scroll && time >= this.nextScroll) {
      const s = this.scroll
      for (let p = s.start; p <= (s.end >= s.start ? s.end : 7); p++) {
        const row = this.ram.subarray(p * 128, p * 128 + 128)
        const copy = Uint8Array.from(row)
        for (let x = 0; x < 128; x++) row[(x + s.dir + 128) % 128] = copy[x]
      }
      if (s.vertical) {
        const [top, rows] = this.scrollArea
        if (top !== 0 || rows !== 64) this.unsupported.add("vertical scroll area other than the whole RAM")
        this.startLine = (this.startLine + s.vertical) & 0x3f
      }
      this.nextScroll += s.frames * this.framePeriod()
      moved = true
    }
    if (moved) this.version++
    return moved
  }

  nextEvent() {
    return this.scrolling ? this.nextScroll : Infinity
  }

  /** Which COM pad drives logical COM output j (Table 10-3). */
  private pad(j: number) {
    const alternative = (this.comPins & 0x10) !== 0
    const lr = (this.comPins & 0x20) !== 0
    if (!alternative) return lr ? (j + 32) % 64 : j
    const even = j % 2 === 0
    const half = even ? j / 2 : (j - 1) / 2
    return even !== lr ? half : 32 + half
  }

  /** The COM output a pad carries: the inverse of `pad`. */
  private comOfPad(pad: number) {
    for (let j = 0; j < 64; j++) if (this.pad(j) === pad) return j
    return -1
  }

  /** The panel's row y is wired to this pad (the library's upright setting, see the header). */
  private padOfRow(y: number) {
    if (this.panel.height === 32) return 31 - y
    return y % 2 === 0 ? 63 - y / 2 : 31 - (y - 1) / 2
  }

  /** RAM row a panel row shows, or -1 when its COM is not scanned. */
  ramRowOf(y: number) {
    return this.ramRowOfCom(this.comOfPad(this.padOfRow(y)))
  }

  /** The RAM row COM output j shows, or -1 past the multiplex ratio (Tables 10-1, 10-2). */
  ramRowOfCom(j: number) {
    const n = this.mux + 1
    const row = ((((this.comRemap ? n - 1 - j : j) + this.offset) % 64) + 64) % 64
    if (row >= n) return -1
    return (row + this.startLine) % 64
  }

  /** Pixels as the panel shows them: brightness 0–255 by the segment current. */
  pixels(powered: boolean): number[] {
    const { width, height } = this.panel
    const out = new Array<number>(width * height).fill(0)
    if (!powered || !this.on || !this.pumpOn) return out
    const level = Math.round(255 * srgbEncode(this.contrast / 256))
    for (let y = 0; y < height; y++) {
      const r = this.ramRowOf(y)
      if (r < 0) continue
      const page = r >> 3
      const bit = 1 << (r & 7)
      for (let x = 0; x < width; x++) {
        // The panel's column x is SEG(127 − x); SEG s shows RAM column s, or 127 − s remapped (A1h).
        const ramCol = this.segRemap ? x : 127 - x
        const set = this.entireOn || ((this.ram[page * 128 + ramCol] & bit) !== 0) !== this.inverse
        if (set) out[y * width + x] = level
      }
    }
    return out
  }

  /** Lit pixels on scanned rows, for the panel current. */
  litCount(): number {
    if (!this.on || !this.pumpOn) return 0
    let n = 0
    for (let y = 0; y < this.panel.height; y++) {
      const r = this.ramRowOf(y)
      if (r < 0) continue
      const bit = 1 << (r & 7)
      for (let x = 0; x < 128; x++) if (this.entireOn || ((this.ram[(r >> 3) * 128 + x] & bit) !== 0) !== this.inverse) n++
    }
    return n
  }

  /**
   * Supply current at VDD (A): the sleep or operating currents plus the panel's, the segments'
   * current averaged over the frame (each lit pixel conducts ISEG for its row's share of the
   * MUX), carried through the charge pump as an ideal one (current × 7.5 V / VDD).
   */
  current(vdd: number): number {
    if (!this.on) return SSD1306.iddSleep + SSD1306.iccSleep
    const iseg = (this.contrast / 256) * SSD1306.isegMax
    const panel = (iseg * this.litCount()) / (this.mux + 1)
    const pumped = this.pumpOn && vdd > 0 ? (panel * SSD1306.pump) / vdd : 0
    return SSD1306.iddOn + (this.pumpOn ? SSD1306.iccOn : 0) + pumped
  }
}

export type OledSnapshot = {
  screen: Screen
  on: boolean
  pump: boolean
  contrast: number
  address?: number
  current: number
  vdd: number
  warnings: string[]
}

/** Module colours: the light of the OLED and the black of the unlit glass. */
export const OLED_COLOURS: Record<string, { ink: string; bands?: { from: number; ink: string }[] }> = {
  white: { ink: "#f2f6ff" },
  blue: { ink: "#6fd3ff" },
  // The two-colour 128 × 64: the top 16 rows yellow, the rest blue.
  "yellow-blue": { ink: "#6fd3ff", bands: [{ from: 0, ink: "#ffd84a" }, { from: 16, ink: "#6fd3ff" }] },
}

/** Shared face of the I²C and SPI modules: power, the glass, warnings. */
class OledFace {
  readonly core: Ssd1306Core
  vcc = 0
  private rail = 0
  powered = false
  time = 0
  colour = OLED_COLOURS.white
  private dots: number[] = []
  private version = 0
  private warnings = new Map<string, number>()
  private loadCurrent = -1
  loadOhms = 1e9

  constructor(panel: Panel, seed: string) {
    this.core = new Ssd1306Core(panel, seed)
  }

  /** The controller's supply: the module's 3.3 V regulator output. */
  vdd() {
    return this.rail
  }

  warn(text: string, time: number) {
    this.warnings.set(text, time)
  }

  sense(vcc: number, vdd: number, time: number): boolean {
    this.vcc = vcc
    this.rail = vdd
    this.time = Math.max(this.time, time)
    const up = this.vdd() >= SSD1306.vddMin
    let reset = false
    if (up && !this.powered) {
      this.powered = true
      reset = true
    } else if (!up && this.powered) this.powered = false
    return reset
  }

  /** The supply load as ohms from VCC; true when it changed. */
  load(): boolean {
    const i = this.powered ? this.core.current(this.vdd()) : 0
    if (i === this.loadCurrent) return false
    this.loadCurrent = i
    this.loadOhms = i > 0 && this.rail > 0.1 ? this.rail / i : 1e9
    return true
  }

  snapshot(address?: number): OledSnapshot {
    const dots = this.core.pixels(this.powered)
    if (dots.length !== this.dots.length || dots.some((d, i) => d !== this.dots[i])) {
      this.dots = dots
      this.version++
    }
    for (const u of this.core.unsupported) this.warn(`Not modelled: ${u}`, this.time)
    const { width, height } = this.core.panel
    return {
      screen: { width, height, dots: this.dots, glass: "#05070a", ink: this.colour.ink, bands: this.colour.bands, version: this.version },
      on: this.core.on,
      pump: this.core.pumpOn,
      contrast: this.core.contrast,
      address,
      current: this.powered ? this.core.current(this.vdd()) : 0,
      vdd: this.vdd(),
      warnings: [...this.warnings].filter(([, at]) => this.time - at <= 0.5).map(([t]) => t),
    }
  }
}

export const OLED_SUPPLY_KEY = "$oled"

/** The 4-pin I²C module: address 0x3C, or 0x3D with its address resistor moved. */
export class OledI2c extends I2cSlave {
  readonly pins = ["SDA", "SCL"] as const
  readonly senses = ["VCC", "GND", "$vdd"] as const
  readonly face: OledFace
  private address7 = 0x3c
  private control: "control" | "stream-data" | "stream-command" | "one-data" | "one-command" = "control"
  private lastScl = -Infinity
  private now = 0

  constructor(object: string, props: Record<string, string>, panel: Panel) {
    super(object, "SDA", "SCL")
    this.face = new OledFace(panel, object)
    this.configure(props)
  }

  configure(props: Record<string, string>) {
    this.address7 = props.address === "0x3D" ? 0x3d : 0x3c
    this.face.colour = OLED_COLOURS[props.colour] ?? OLED_COLOURS.white
  }

  thresholds(): [falling: number, rising: number] {
    // VIL 0.2 VDD, VIH 0.8 VDD of the controller's 3.3 V.
    const vdd = this.face.vdd()
    return [0.2 * vdd, 0.8 * vdd]
  }

  input(pin: string, level: boolean, time: number) {
    this.now = time
    if (pin === "SCL" && level) {
      if (time - this.lastScl < SSD1306.i2cPeriod - 1e-9) this.face.warn(`SCL period ${Math.round((time - this.lastScl) * 1e9)} ns: the SSD1306 needs 2.5 µs (400 kHz)`, time)
      this.lastScl = time
    }
    super.input(pin, level, time)
  }

  protected address() {
    return this.face.powered ? this.address7 : -1
  }

  protected onSelected() {
    this.control = "control"
  }

  protected onStart() {
    this.control = "control"
  }

  protected onByte(byte: number) {
    switch (this.control) {
      case "control": {
        const co = (byte & 0x80) !== 0
        const dc = (byte & 0x40) !== 0
        this.control = co ? (dc ? "one-data" : "one-command") : dc ? "stream-data" : "stream-command"
        return
      }
      case "one-data":
        this.face.core.data(byte)
        this.control = "control"
        return
      case "one-command":
        this.face.core.command(byte, this.now)
        this.control = "control"
        return
      case "stream-data":
        this.face.core.data(byte)
        return
      case "stream-command":
        this.face.core.command(byte, this.now)
        return
    }
  }

  protected nextByte() {
    // Status register: D6 is 1 while the display is off.
    return this.face.core.on ? 0x00 : 0x40
  }

  sense(volts: (pin: string) => number, time: number) {
    if (this.face.sense(volts("VCC") - volts("GND"), volts("$vdd") - volts("GND"), time)) {
      // The board's RC on RES# (10 kΩ, 100 nF) resets the controller as it powers up.
      this.face.core.reset()
    }
  }

  tick(time: number): boolean {
    this.face.time = Math.max(this.face.time, time)
    this.face.core.advance(time)
    return this.face.load()
  }

  quietUntil() {
    return this.face.core.nextEvent()
  }

  analog(key: string) {
    return key === OLED_SUPPLY_KEY ? this.face.loadOhms : undefined
  }

  snapshot(): OledSnapshot {
    return this.face.snapshot(this.address7)
  }
}

/** The 7-pin SPI module: D0 SCLK, D1 SDIN, RES#, DC, CS#. */
export class OledSpi implements DigitalPart {
  readonly object: string
  readonly pins = ["D0", "D1", "RES", "DC", "CS"] as const
  readonly outputs = [] as const
  readonly senses = ["VCC", "GND", "$vdd"] as const
  readonly out: DigitalEdge[] = []
  readonly face: OledFace
  private level: Record<string, boolean> = { D0: false, D1: false, RES: false, DC: false, CS: true }
  private shift = 0
  private bits = 0
  private lastClock = -Infinity
  private resFell = -Infinity
  private resFloating = true

  constructor(object: string, props: Record<string, string>, panel: Panel) {
    this.object = object
    this.face = new OledFace(panel, object)
    this.configure(props)
  }

  configure(props: Record<string, string>) {
    this.face.colour = OLED_COLOURS[props.colour] ?? OLED_COLOURS.white
  }

  reset() {
    this.shift = 0
    this.bits = 0
  }

  drive(): boolean | null {
    return null
  }

  thresholds(): [falling: number, rising: number] {
    const vdd = this.face.vdd()
    return [0.2 * vdd, 0.8 * vdd]
  }

  prime(levels: Map<string, boolean>) {
    for (const [pin, level] of levels) {
      this.level[pin] = level
      if (pin === "RES") this.resFloating = false
    }
  }

  input(pin: string, level: boolean, time: number) {
    if (this.level[pin] === level) return
    this.level[pin] = level
    this.face.time = Math.max(this.face.time, time)
    if (pin === "RES") {
      this.resFloating = false
      if (!level) this.resFell = time
      else {
        if (time - this.resFell < SSD1306.resetPulse) this.face.warn(`RES# low for ${Math.round((time - this.resFell) * 1e9)} ns; it must be at least 3 µs`, time)
        else this.face.core.reset()
      }
      return
    }
    if (!this.level.RES) return
    if (pin === "CS") {
      this.bits = 0
      this.shift = 0
      return
    }
    if (pin !== "D0" || !level || this.level.CS) return
    if (time - this.lastClock < SSD1306.spiPeriod - 1e-12) this.face.warn(`SCLK period ${Math.round((time - this.lastClock) * 1e9)} ns: the SSD1306 needs 100 ns (10 MHz)`, time)
    this.lastClock = time
    this.shift = ((this.shift << 1) | (this.level.D1 ? 1 : 0)) & 0xff
    if (++this.bits < 8) return
    this.bits = 0
    // D/C# is read with the eighth bit.
    if (this.level.DC) this.face.core.data(this.shift)
    else this.face.core.command(this.shift, time)
  }

  sense(volts: (pin: string) => number, time: number) {
    if (this.face.sense(volts("VCC") - volts("GND"), volts("$vdd") - volts("GND"), time) && this.resFloating) this.face.warn("RES# is not driven: the controller waits in an undefined state until it gets a reset pulse", time)
  }

  tick(time: number): boolean {
    this.face.time = Math.max(this.face.time, time)
    this.face.core.advance(time)
    return this.face.load()
  }

  quietUntil() {
    return this.face.core.nextEvent()
  }

  analog(key: string) {
    return key === OLED_SUPPLY_KEY ? this.face.loadOhms : undefined
  }

  snapshot(): OledSnapshot {
    return this.face.snapshot()
  }
}
