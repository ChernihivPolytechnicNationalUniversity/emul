/**
 * Digital parts on the field — chips with a behavioural model rather than an analog one
 * (an I²C EEPROM, a shift register, a display controller). They live on the exact-time
 * digital path next to the MCU cores: the loop hands them every level change on their nets
 * with its timestamp, and they answer with drives of their own that the loop resolves against
 * the other drivers on the net (open-drain wired-AND, push-pull, pull-ups).
 */

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

/** Parts by component definition id. */
export function createDigitalPart(def: string, object: string, props: Record<string, string>): DigitalPart | null {
  switch (def) {
    case "eeprom-24c":
      return new Eeprom24(object, props)
    default:
      return null
  }
}
