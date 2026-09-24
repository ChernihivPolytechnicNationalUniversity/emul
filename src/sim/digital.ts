/**
 * Digital parts on the field — chips with a behavioural model rather than an analog one
 * (an I²C EEPROM, a shift register, a display controller). They live on the exact-time
 * digital path next to the MCU cores: the loop hands them every level change on their nets
 * with its timestamp, and they answer with drives of their own that the loop resolves against
 * the other drivers on the net (open-drain wired-AND, push-pull, pull-ups).
 */

import type { PartState } from "@/schematic/types"

export type DigitalEdge = { pin: string; level: boolean | null; time: number }

export interface DigitalPart {
  readonly object: string
  /** Model node names the part listens on and drives. */
  readonly pins: readonly string[]
  /** What the part drives on a pin right now: true/false push-pull, null released. */
  drive(pin: string): boolean | null
  /** The resolved level of a pin's net changed at `time` (seconds, loop clock). */
  input(pin: string, level: boolean, time: number): void
  /** Drives the part changed since the loop last drained them, in order. */
  readonly out: DigitalEdge[]
  /** Power-on state. */
  reset(): void
  /** Props changed on the field. */
  configure(props: Record<string, string>): void
  /** A part of the component was touched on the field (a display's panel): its state, by part id, at loop time `time`. */
  interact?(part: string, state: PartState, time: number): void
  /** Time passes (called every solver step): for parts with a clock of their own (a scan period). */
  tick?(time: number): void
  /** Until when `tick` drives nothing, as long as no input or interaction comes (a part with a `tick` and without this is never skipped over). */
  quietUntil?(): number
  /** What the UI shows about the part, if anything. Plain data: it crosses the worker boundary. */
  snapshot(): unknown
}

// --- 24Cxx I²C EEPROM ------------------------------------------------------------------------

export type EepromSnapshot = { bytes: number[]; size: number; writes: number; busyUntil: number; address: number }

/** Sizes by part number (bytes) and whether the word address is two bytes. */
export const EEPROM_PARTS: Record<string, { size: number; wide: boolean; page: number }> = {
  "24C01": { size: 128, wide: false, page: 8 },
  "24C02": { size: 256, wide: false, page: 8 },
  "24C04": { size: 512, wide: false, page: 16 },
  "24C08": { size: 1024, wide: false, page: 16 },
  "24C16": { size: 2048, wide: false, page: 16 },
  "24C32": { size: 4096, wide: true, page: 32 },
  "24C64": { size: 8192, wide: true, page: 32 },
  "24C128": { size: 16384, wide: true, page: 64 },
  "24C256": { size: 32768, wide: true, page: 64 },
}

/** Internal write cycle after a STOP (datasheet tWR, 5 ms max); the part NACKs meanwhile. */
const EEPROM_TWR = 5e-3

/**
 * Microchip/Atmel 24Cxx behaviour (24AA/24LC datasheets): 7-bit address 1010 A2 A1 A0 (the
 * high address bits double as block-select on 24C04–24C16), byte and page writes with the
 * address wrapping inside the page, current-address and random reads, sequential reads
 * wrapping at the end of memory, acknowledge polling during the write cycle, WP pin.
 */
export class Eeprom24 implements DigitalPart {
  readonly object: string
  readonly pins = ["SDA", "SCL", "A0", "A1", "A2", "WP"] as const
  readonly out: DigitalEdge[] = []
  private bytes = new Uint8Array(256).fill(0xff)
  private size = 256
  private wide = false
  private page = 8
  private baseAddress = 0x50
  private sda = true
  private scl = true
  private a = [false, false, false]
  private wp = false
  /** Bus state machine. */
  private state: "idle" | "addr" | "wordHi" | "wordLo" | "write" | "read" | "ack" | "readAck" | "skip" = "idle"
  private shift = 0
  private bit = 0
  private selected = false
  private reading = false
  private address = 0
  private pageBuffer: { address: number; data: number }[] = []
  private busyUntil = -1
  private writes = 0
  /** Level the part drives on SDA (null released). */
  private sdaDrive: boolean | null = null
  private readByte = 0

  constructor(object: string, props: Record<string, string>) {
    this.object = object
    this.configure(props)
  }

  configure(props: Record<string, string>) {
    const part = EEPROM_PARTS[props.value ?? "24C02"] ?? EEPROM_PARTS["24C02"]
    if (part.size !== this.size) {
      const next = new Uint8Array(part.size).fill(0xff)
      next.set(this.bytes.subarray(0, Math.min(this.size, part.size)))
      this.bytes = next
    }
    this.size = part.size
    this.wide = part.wide
    this.page = part.page
  }

  reset() {
    // Memory is non-volatile: only the bus state goes.
    this.state = "idle"
    this.selected = false
    this.pageBuffer = []
    this.busyUntil = -1
    this.setSda(null, 0)
  }

  drive(pin: string): boolean | null {
    return pin === "SDA" ? this.sdaDrive : null
  }

  snapshot(): EepromSnapshot {
    return { bytes: Array.from(this.bytes), size: this.size, writes: this.writes, busyUntil: this.busyUntil, address: this.baseAddress | (this.a[2] ? 4 : 0) | (this.a[1] ? 2 : 0) | (this.a[0] ? 1 : 0) }
  }

  private setSda(level: boolean | null, time: number) {
    if (this.sdaDrive === level) return
    this.sdaDrive = level
    this.out.push({ pin: "SDA", level, time })
  }

  input(pin: string, level: boolean, time: number) {
    switch (pin) {
      case "A0":
      case "A1":
      case "A2":
        this.a[Number(pin[1])] = level
        return
      case "WP":
        this.wp = level
        return
      case "SDA":
        if (this.scl) {
          // SDA moving while SCL is high: START (falling) or STOP (rising).
          if (!level && this.sda) this.onStart()
          else if (level && !this.sda) this.onStop(time)
        }
        this.sda = level
        return
      case "SCL":
        if (level && !this.scl) this.onSclRise()
        else if (!level && this.scl) this.onSclFall(time)
        this.scl = level
        return
    }
  }

  private onStart() {
    this.state = "addr"
    this.shift = 0
    this.bit = 0
    this.selected = false
  }

  private onStop(time: number) {
    if (this.selected && !this.reading && this.pageBuffer.length && !this.wp) {
      // The write cycle starts at STOP; the part is deaf until it is done.
      for (const w of this.pageBuffer) this.bytes[w.address] = w.data
      this.writes += this.pageBuffer.length
      this.busyUntil = time + EEPROM_TWR
    }
    this.pageBuffer = []
    this.state = "idle"
    this.selected = false
    this.setSda(null, time)
  }

  /** Sample SDA on the rising edge: a data bit, or the master's ACK after a read byte. */
  private onSclRise() {
    switch (this.state) {
      case "addr":
      case "wordHi":
      case "wordLo":
      case "write":
        this.shift = ((this.shift << 1) | (this.sda ? 1 : 0)) & 0xff
        this.bit++
        return
      case "readAck":
        // Master ACKs: send the next byte; NACK: done.
        this.reading = this.sda ? false : true
        if (!this.sda) this.address = (this.address + 1) % this.size
        return
    }
  }

  /** Change SDA on the falling edge: our ACK, or the next read bit. */
  private onSclFall(time: number) {
    switch (this.state) {
      case "addr":
        if (this.bit < 8) return
        this.bit = 0
        this.onAddress(time)
        return
      case "wordHi":
      case "wordLo":
      case "write":
        if (this.bit < 8) return
        this.bit = 0
        this.onDataByte(time)
        return
      case "ack":
        // Our ACK bit was clocked out; release SDA and go on.
        this.setSda(null, time)
        this.state = this.reading ? "read" : this.afterAckState
        if (this.reading) this.startReadByte(time)
        return
      case "read":
        this.bit++
        if (this.bit < 8) {
          this.setSda(((this.readByte >>> (7 - this.bit)) & 1) === 1 ? null : false, time)
        } else {
          // Byte done: release SDA for the master's ACK.
          this.setSda(null, time)
          this.state = "readAck"
        }
        return
      case "readAck":
        if (this.reading) this.startReadByte(time)
        else this.state = "skip"
        return
    }
  }

  private afterAckState: "wordHi" | "wordLo" | "write" = "write"

  private onAddress(time: number) {
    const mine = this.baseAddress | (this.a[2] ? 4 : 0) | (this.a[1] ? 2 : 0) | (this.a[0] ? 1 : 0)
    const addr = this.shift >>> 1
    // 24C04/08/16 use A0..A2 as memory block bits: mask what the pins do not decide.
    const blockBits = this.wide ? 0 : Math.max(0, Math.log2(this.size / 256))
    const mask = 0x7f & ~((1 << blockBits) - 1)
    if ((addr & mask) !== (mine & mask) || (this.busyUntil >= 0 && time < this.busyUntil)) {
      this.state = "skip"
      return
    }
    this.busyUntil = -1
    this.selected = true
    this.reading = (this.shift & 1) === 1
    if (blockBits) this.address = ((addr & ((1 << blockBits) - 1)) << 8) | (this.address & 0xff)
    if (!this.reading) {
      this.pageBuffer = []
      this.afterAckState = this.wide ? "wordHi" : "wordLo"
    }
    this.ack(time)
  }

  private onDataByte(time: number) {
    if (this.state === "wordHi") {
      this.address = ((this.shift << 8) | (this.address & 0xff)) % this.size
      this.afterAckState = "wordLo"
    } else if (this.state === "wordLo") {
      this.address = ((this.address & ~0xff) | this.shift) % this.size
      this.afterAckState = "write"
    } else {
      // Page write: the low bits wrap within the page.
      this.pageBuffer.push({ address: this.address, data: this.shift })
      const pageStart = this.address - (this.address % this.page)
      this.address = pageStart + ((this.address + 1) % this.page)
      this.afterAckState = "write"
    }
    this.ack(time)
  }

  private ack(time: number) {
    this.setSda(false, time)
    this.state = "ack"
  }

  private startReadByte(time: number) {
    this.readByte = this.bytes[this.address]
    this.bit = 0
    this.state = "read"
    this.setSda((this.readByte & 0x80) !== 0 ? null : false, time)
  }
}

// --- I²C slave scaffold ----------------------------------------------------------------------

/**
 * The bit-level side of an I²C slave: START/STOP detection, address match, ACKs, bytes in and
 * out. A part built on it gets whole bytes: `onSelected` when addressed, `onByte` for each
 * byte written, `nextByte` for each byte the master reads, `onStop` at the end.
 */
export abstract class I2cSlave implements DigitalPart {
  readonly object: string
  abstract readonly pins: readonly string[]
  readonly out: DigitalEdge[] = []
  protected readonly sdaPin: string
  protected readonly sclPin: string
  private sda = true
  private scl = true
  private state: "idle" | "addr" | "ack" | "write" | "read" | "readAck" | "skip" = "idle"
  private shift = 0
  private bit = 0
  private reading = false
  private readByte = 0
  private sdaDrive: boolean | null = null

  constructor(object: string, sdaPin: string, sclPin: string) {
    this.object = object
    this.sdaPin = sdaPin
    this.sclPin = sclPin
  }

  /** 7-bit address this part answers, or -1 to stay silent. */
  protected abstract address(): number
  protected abstract onSelected(read: boolean): void
  protected abstract onByte(byte: number): void
  protected abstract nextByte(): number
  protected onStop(_time: number): void {}
  protected onStart(): void {}

  abstract configure(props: Record<string, string>): void
  abstract snapshot(): unknown

  reset() {
    this.state = "idle"
    this.setSda(null, 0)
  }

  drive(pin: string): boolean | null {
    return pin === this.sdaPin ? this.sdaDrive : null
  }

  protected setSda(level: boolean | null, time: number) {
    if (this.sdaDrive === level) return
    this.sdaDrive = level
    this.out.push({ pin: this.sdaPin, level, time })
  }

  input(pin: string, level: boolean, time: number) {
    if (pin === this.sdaPin) {
      if (this.scl) {
        if (!level && this.sda) {
          this.state = "addr"
          this.shift = 0
          this.bit = 0
          this.onStart()
        } else if (level && !this.sda) {
          this.state = "idle"
          this.setSda(null, time)
          this.onStop(time)
        }
      }
      this.sda = level
    } else if (pin === this.sclPin) {
      if (level && !this.scl) this.onSclRise()
      else if (!level && this.scl) this.onSclFall(time)
      this.scl = level
    }
  }

  private onSclRise() {
    switch (this.state) {
      case "addr":
      case "write":
        this.shift = ((this.shift << 1) | (this.sda ? 1 : 0)) & 0xff
        this.bit++
        return
      case "readAck":
        this.reading = !this.sda
        return
    }
  }

  private onSclFall(time: number) {
    switch (this.state) {
      case "addr":
        if (this.bit < 8) return
        this.bit = 0
        if (this.shift >>> 1 !== this.address()) {
          this.state = "skip"
          return
        }
        this.reading = (this.shift & 1) === 1
        this.onSelected(this.reading)
        this.setSda(false, time)
        this.state = "ack"
        return
      case "write":
        if (this.bit < 8) return
        this.bit = 0
        this.onByte(this.shift)
        this.setSda(false, time)
        this.state = "ack"
        return
      case "ack":
        this.setSda(null, time)
        if (this.reading) this.startReadByte(time)
        else this.state = "write"
        return
      case "read":
        this.bit++
        if (this.bit < 8) this.setSda(((this.readByte >>> (7 - this.bit)) & 1) === 1 ? null : false, time)
        else {
          this.setSda(null, time)
          this.state = "readAck"
        }
        return
      case "readAck":
        if (this.reading) this.startReadByte(time)
        else this.state = "skip"
        return
    }
  }

  private startReadByte(time: number) {
    this.readByte = this.nextByte() & 0xff
    this.bit = 0
    this.state = "read"
    this.setSda((this.readByte & 0x80) !== 0 ? null : false, time)
  }
}

// --- GT911 capacitive touch controller ---------------------------------------------------------

export type Gt911Snapshot = { address: number; touches: { x: number; y: number }[]; reads: number; ready: boolean }

/** Register map bases (Goodix GT911 programming guide). */
const GT_COMMAND = 0x8040
const GT_CONFIG = 0x8047
const GT_PRODUCT_ID = 0x8140
const GT_STATUS = 0x814e
const GT_POINTS = 0x814f
/** Coordinate refresh period (the config's default 10 ms). */
const GT_REFRESH = 10e-3
/** Product ID "911", firmware 0x1060, 1024 × 600, vendor 0. */
const GT_INFO = [0x39, 0x31, 0x31, 0x00, 0x60, 0x10, 0x00, 0x04, 0x58, 0x02, 0x00]

/**
 * Goodix GT911 on the 7" panel: 7-bit address 0x5D (INT low at the end of reset) or 0x14
 * (INT high), 16-bit big-endian register addresses with auto-increment, the coordinate
 * registers refreshed while a finger is on the glass. The buffer-ready flag (0x814E bit 7)
 * is raised with the point count whenever new data is there and cleared by the host writing
 * 0; INT is pulled low while a report waits and let go (the module's pull-up takes it high)
 * once it is cleared — the host still drives INT low itself for the first 200 ms after
 * reset, so the controller never drives it high. The 186-byte configuration is stored and
 * echoed back but does not change the behaviour.
 */
export class Gt911 extends I2cSlave {
  readonly pins: readonly string[]
  private readonly rstPin: string
  private readonly intPin: string
  private readonly regs = new Uint8Array(0x200)
  private pointer = 0
  private addrBytes = 0
  private slave = 0x5d
  private rst = true
  private intIn = false
  private intDrive: boolean | null = null
  private touches: { x: number; y: number }[] = []
  private reads = 0
  /** When the next coordinate scan may be reported (the configured refresh period after the last clear). */
  private nextReport = 0

  constructor(object: string, pins: { sda: string; scl: string; rst: string; int: string }) {
    super(object, pins.sda, pins.scl)
    this.pins = [pins.sda, pins.scl, pins.rst, pins.int]
    this.rstPin = pins.rst
    this.intPin = pins.int
    this.powerOn()
  }

  private powerOn() {
    this.regs.fill(0)
    for (let i = 0; i < GT_INFO.length; i++) this.regs[GT_PRODUCT_ID - 0x8000 + i] = GT_INFO[i]
    // Configuration version and the resolution as the config block reports it.
    this.regs[GT_CONFIG - 0x8000] = 0x41
    this.regs[GT_CONFIG - 0x8000 + 1] = 0x00
    this.regs[GT_CONFIG - 0x8000 + 2] = 0x04
    this.regs[GT_CONFIG - 0x8000 + 3] = 0x58
    this.regs[GT_CONFIG - 0x8000 + 4] = 0x02
    this.regs[GT_CONFIG - 0x8000 + 5] = 0x05
  }

  configure() {}

  reset() {
    super.reset()
    this.setInt(null, 0)
  }

  drive(pin: string): boolean | null {
    if (pin === this.intPin) return this.intDrive
    return super.drive(pin)
  }

  private setInt(level: boolean | null, time: number) {
    if (this.intDrive === level) return
    this.intDrive = level
    this.out.push({ pin: this.intPin, level, time })
  }

  input(pin: string, level: boolean, time: number) {
    if (pin === this.rstPin) {
      if (!level && this.rst) {
        // In reset: the bus is dead and INT is an input that picks the address.
        this.setInt(null, time)
        this.setSda(null, time)
        this.powerOn()
      } else if (level && !this.rst) {
        this.slave = this.intIn ? 0x14 : 0x5d
        this.setInt(null, time)
      }
      this.rst = level
      return
    }
    if (pin === this.intPin) {
      this.intIn = level
      return
    }
    if (this.rst) super.input(pin, level, time)
  }

  protected address() {
    return this.rst ? this.slave : -1
  }

  protected onSelected(read: boolean) {
    if (!read) this.addrBytes = 0
  }

  protected onByte(byte: number) {
    if (this.addrBytes === 0) {
      this.pointer = byte << 8
      this.addrBytes = 1
    } else if (this.addrBytes === 1) {
      this.pointer |= byte
      this.addrBytes = 2
    } else {
      this.write(this.pointer, byte)
      this.pointer = (this.pointer + 1) & 0xffff
    }
  }

  protected nextByte() {
    const v = this.read(this.pointer)
    this.pointer = (this.pointer + 1) & 0xffff
    return v
  }

  private read(reg: number) {
    if (reg === GT_STATUS) this.reads++
    return reg >= 0x8000 && reg < 0x8200 ? this.regs[reg - 0x8000] : 0
  }

  private write(reg: number, value: number) {
    if (reg < 0x8000 || reg >= 0x8200) return
    if (reg === GT_STATUS) {
      // The host has taken the report; the next scan (one refresh period on) brings the finger
      // back if it is still there.
      this.regs[GT_STATUS - 0x8000] = 0
      this.setInt(null, this.lastTime)
      this.nextReport = this.lastTime + GT_REFRESH
      return
    }
    if (reg === GT_COMMAND) return
    this.regs[reg - 0x8000] = value
  }

  /** Latch the current touches into the point registers and raise the buffer-ready flag. */
  private report(time: number) {
    const n = Math.min(5, this.touches.length)
    for (let i = 0; i < 5; i++) {
      const o = GT_POINTS - 0x8000 + i * 8
      if (i < n) {
        const t = this.touches[i]
        this.regs[o] = i
        this.regs[o + 1] = t.x & 0xff
        this.regs[o + 2] = t.x >>> 8
        this.regs[o + 3] = t.y & 0xff
        this.regs[o + 4] = t.y >>> 8
        this.regs[o + 5] = 20
        this.regs[o + 6] = 0
        this.regs[o + 7] = 0
      } else this.regs.fill(0, o, o + 8)
    }
    this.regs[GT_STATUS - 0x8000] = 0x80 | n
    this.setInt(false, time)
  }

  /** The panel on the field: a press with coordinates, or a release. */
  interact(part: string, state: PartState, time: number) {
    if (part !== "PANEL") return
    const next = state.pressed && state.x !== undefined && state.y !== undefined ? [{ x: Math.max(0, Math.min(1023, Math.round(state.x))), y: Math.max(0, Math.min(599, Math.round(state.y))) }] : []
    const same = next.length === this.touches.length && next.every((t, i) => t.x === this.touches[i].x && t.y === this.touches[i].y)
    this.touches = next
    this.lastTime = time
    // A change is reported at the next scan; a release is reported too (count 0), once.
    if (!same && this.rst && time >= this.nextReport) this.report(time)
    else if (!same) this.changed = true
  }

  private lastTime = 0
  private changed = false

  /** The controller's own scan: a finger still on the glass is reported every refresh period. */
  tick(time: number) {
    this.lastTime = time
    if (!this.rst || time < this.nextReport) return
    if ((this.touches.length || this.changed) && !(this.regs[GT_STATUS - 0x8000] & 0x80)) {
      this.changed = false
      this.report(time)
    }
  }

  quietUntil() {
    if (!this.rst || !(this.touches.length || this.changed) || this.regs[GT_STATUS - 0x8000] & 0x80) return Infinity
    return this.nextReport
  }

  snapshot(): Gt911Snapshot {
    return { address: this.slave, touches: this.touches.slice(), reads: this.reads, ready: (this.regs[GT_STATUS - 0x8000] & 0x80) !== 0 }
  }
}

/** Parts by component definition id. */
export function createDigitalPart(def: string, object: string, props: Record<string, string>): DigitalPart | null {
  switch (def) {
    case "eeprom-24c":
      return new Eeprom24(object, props)
    case "lcd7-f":
      return new Gt911(object, { sda: "37", scl: "38", rst: "39", int: "40" })
    default:
      return null
  }
}
