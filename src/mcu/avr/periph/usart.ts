/**
 * AVR USART in asynchronous mode (DS40002061B §20): the baud rate generator, a transmitter
 * that shifts out frames on the grid of its transmit clock, and a receiver that samples RxD
 * 16 (8 with U2X) times per bit, detects the start bit and votes on samples 8/9/10 (4/5/6)
 * of every bit, with the two-character receive FIFO and its error flags.
 *
 * Lazy like the timers: the transmitter's state is a frame with a start cycle, the receiver
 * keeps the RxD edges it has seen and decides a frame once its last sample has passed.
 * Synchronous mode and Master SPI mode are reported as not modelled.
 */
import { Peripheral, type AvrBus } from "../io"
import type { AvrMcu } from "../mcu"
import type { PinOverride } from "../port"
import { syncEdge } from "./extint"

export type UsartSpec = {
  name: string
  regs: { ucsrA: number; ucsrB: number; ucsrC: number; ubrrL: number; ubrrH: number; udr: number }
  vectors: { rx: number; udre: number; tx: number }
  pins: { rxd: [number, number]; txd: [number, number] }
  prr: number
}

type Received = { data: number; fe: boolean; dor: boolean; upe: boolean }

export class Usart extends Peripheral {
  readonly name: string
  readonly spec: UsartSpec
  private readonly mcu: AvrMcu
  ucsrA = 0x20
  ucsrB = 0
  ucsrC = 0x06
  ubrr = 0
  /** Cycle the baud rate generator was (re)loaded at: baud ticks fall at base + k·(UBRR+1). */
  private base = 0

  // Transmitter
  private txBuffer: number | null = null
  private frame: number[] | null = null
  private frameStart = 0
  private txLevel = true
  private txc = false

  // Receiver
  private readonly fifo: Received[] = []
  /** A complete frame waiting in the shift register because the FIFO is full. */
  private shift: Received | null = null
  private overrun = false
  /** RxD as the receiver sees it: visible cycle and level of each change, oldest first. */
  private readonly rxd: { cycle: number; level: boolean }[] = []
  /** Frame being received: the baud tick of its first low sample. */
  private rxStart: number | null = null
  /** Earliest cycle a falling edge may start the next frame (after the previous frame's last vote). */
  private rxFrom = 0

  constructor(bus: AvrBus, mcu: AvrMcu, spec: UsartSpec) {
    super(bus)
    this.mcu = mcu
    this.spec = spec
    this.name = spec.name
    const r = spec.regs
    const reg = (addr: number, name: string, read: () => number, write: (v: number, m: number) => void) =>
      bus.register(addr, {
        name,
        read: () => (bus.powerReduced(spec.prr) ? 0 : (this.sync(this.now), read())),
        write: (v, m) => {
          if (bus.powerReduced(spec.prr)) return
          this.sync(this.now)
          write(v, m)
          this.changed()
        },
      })
    reg(r.ucsrA, "UCSR0A", () => this.statusA(), (v, m) => this.writeA(v, m))
    reg(r.ucsrB, "UCSR0B", () => this.statusB(), (v, m) => this.writeB((this.ucsrB & ~m) | (v & m)))
    reg(r.ucsrC, "UCSR0C", () => this.ucsrC, (v) => this.writeC(v))
    reg(r.ubrrL, "UBRR0L", () => this.ubrr & 0xff, (v) => {
      this.ubrr = (this.ubrr & 0xf00) | v
      // Writing UBRRnL reloads the baud rate down-counter (§20.3.1).
      this.base = this.now + 1
    })
    reg(r.ubrrH, "UBRR0H", () => this.ubrr >> 8, (v) => (this.ubrr = ((v & 0x0f) << 8) | (this.ubrr & 0xff)))
    reg(r.udr, "UDR0", () => this.readUdr(), (v) => this.writeUdr(v))
    bus.irq.add({ vector: spec.vectors.rx, pending: () => (this.ucsrB & 0x80) !== 0 && this.fifo.length > 0 })
    bus.irq.add({ vector: spec.vectors.udre, pending: () => (this.ucsrB & 0x20) !== 0 && this.udre })
    bus.irq.add({
      vector: spec.vectors.tx,
      pending: () => (this.ucsrB & 0x40) !== 0 && this.txc,
      acknowledge: () => {
        this.txc = false
      },
    })
    mcu.inputListeners.push((port, pin, level, cycle) => {
      if (port === spec.pins.rxd[0] && pin === spec.pins.rxd[1]) this.rxEdge(level, cycle)
    })
  }

  // --- configuration -------------------------------------------------------------------------

  private get u2x() {
    return (this.ucsrA & 0x02) !== 0
  }
  /** Baud ticks per bit: 16, or 8 with U2X (§20.3.2). */
  private get samples() {
    return this.u2x ? 8 : 16
  }
  private get tick() {
    return this.ubrr + 1
  }
  private get bitCycles() {
    return this.samples * this.tick
  }
  private get dataBits() {
    const sz = ((this.ucsrB & 0x04) | ((this.ucsrC >> 1) & 3)) & 7
    return [5, 6, 7, 8, 8, 8, 8, 9][sz]
  }
  private get parityMode() {
    return (this.ucsrC >> 4) & 3
  }
  private get txEnabled() {
    return (this.ucsrB & 0x08) !== 0
  }
  private get rxEnabled() {
    return (this.ucsrB & 0x10) !== 0
  }
  private get udre() {
    return this.txBuffer === null
  }

  private statusA() {
    const head = this.fifo[0]
    let v = this.ucsrA & 0x03
    if (head) v |= 0x80 | (head.fe ? 0x10 : 0) | (head.dor ? 0x08 : 0) | (head.upe ? 0x04 : 0)
    if (this.txc) v |= 0x40
    if (this.udre) v |= 0x20
    return v
  }
  private statusB() {
    const head = this.fifo[0]
    return (this.ucsrB & ~0x02) | (head && head.data & 0x100 ? 0x02 : 0)
  }
  private writeA(v: number, m: number) {
    // TXC clears by writing one; U2X and MPCM are plain bits; the rest is read-only (§20.11.2).
    if (v & m & 0x40) this.txc = false
    this.ucsrA = (this.ucsrA & ~(m & 0x03)) | (v & m & 0x03)
  }
  private writeB(v: number) {
    const was = this.ucsrB
    this.ucsrB = v & 0xfd
    // Disabling the receiver is immediate and flushes the FIFO (§20.7.6).
    if (was & 0x10 && !(v & 0x10)) {
      this.fifo.length = 0
      this.shift = null
      this.overrun = false
      this.rxStart = null
    }
    if (!(was & 0x10) && v & 0x10) this.rxFrom = this.now + 1
    this.bus.pinsChanged()
  }
  private writeC(v: number) {
    this.ucsrC = v
    const umsel = v >> 6
    if (umsel === 1) this.mcu.feature(`${this.name}: synchronous mode`)
    if (umsel === 3) this.mcu.feature(`${this.name}: master SPI mode (MSPIM)`)
  }

  reset() {
    this.ucsrA = 0x20
    this.ucsrB = 0
    this.ucsrC = 0x06
    this.ubrr = 0
    this.base = 0
    this.txBuffer = null
    this.frame = null
    this.txLevel = true
    this.txc = false
    this.fifo.length = 0
    this.shift = null
    this.overrun = false
    this.rxd.length = 0
    this.rxStart = null
    this.rxFrom = 0
    this.due = Infinity
  }

  // --- transmitter -----------------------------------------------------------------------------

  /** First transmit clock edge (bit boundary) strictly after `cycle`. */
  private nextBoundary(cycle: number) {
    const b = this.bitCycles
    return this.base + (Math.floor((cycle - this.base) / b) + 1) * b
  }

  private writeUdr(v: number) {
    if (!this.txEnabled) return
    const ninth = this.ucsrB & 0x01 ? 0x100 : 0
    this.txBuffer = (v & 0xff) | ninth
    if (!this.frame) this.load(this.nextBoundary(this.now))
  }

  /** Move the buffer into the shift register at a bit boundary and start the frame there. */
  private load(at: number) {
    const v = this.txBuffer!
    this.txBuffer = null
    const n = this.dataBits
    const data = Array.from({ length: n }, (_, i) => (v >> i) & 1)
    const bits = [0, ...data]
    const pm = this.parityMode
    if (pm >= 2) bits.push(data.reduce((a, b) => a ^ b, 0) ^ (pm === 3 ? 1 : 0))
    bits.push(1)
    if (this.ucsrC & 0x08) bits.push(1)
    this.frame = bits
    this.frameStart = at
  }

  private syncTx(cycle: number) {
    while (this.frame) {
      const b = this.bitCycles
      const end = this.frameStart + this.frame.length * b
      const i = Math.floor((cycle - this.frameStart) / b)
      if (cycle < this.frameStart) {
        // Waiting for the first bit boundary: the line stays idle.
        return
      }
      if (cycle < end) {
        const level = this.frame[i] === 1
        if (level !== this.txLevel) {
          this.txLevel = level
          this.mcu.pinsChangedAt(this.frameStart + i * b)
        }
        return
      }
      // Frame over at `end`: the next byte follows at once, else TXC.
      this.frame = null
      if (this.txBuffer !== null) this.load(end)
      else {
        this.txc = true
        if (!this.txLevel) {
          this.txLevel = true
          this.mcu.pinsChangedAt(end)
        }
      }
    }
  }

  /** Edges of the transmit line between now and the frame's end: the next one that changes something. */
  private nextTxEvent(cycle: number): number {
    if (!this.frame) return Infinity
    const b = this.bitCycles
    if (cycle < this.frameStart) return this.frameStart
    const end = this.frameStart + this.frame.length * b
    const i = Math.floor((cycle - this.frameStart) / b)
    for (let j = i + 1; j < this.frame.length; j++) if ((this.frame[j] === 1) !== this.txLevel) return this.frameStart + j * b
    return end
  }

  // --- receiver --------------------------------------------------------------------------------

  private rxEdge(level: boolean, cycle: number) {
    if (!this.rxEnabled) return
    this.sync(this.bus.cpu.cycles)
    this.rxd.push({ cycle: syncEdge(cycle), level })
    this.plan()
  }

  /** Level of RxD at a sample tick. */
  private levelAt(cycle: number): boolean {
    let level = true
    for (const e of this.rxd) {
      if (e.cycle > cycle) break
      level = e.level
    }
    return level
  }
  /** Majority of three consecutive samples starting at baud tick `t`. */
  private vote(t: number): number {
    const p = this.tick
    const n = (this.levelAt(t) ? 1 : 0) + (this.levelAt(t + p) ? 1 : 0) + (this.levelAt(t + 2 * p) ? 1 : 0)
    return n >= 2 ? 1 : 0
  }
  /** First baud tick at or after `cycle`. */
  private baudTick(cycle: number) {
    const p = this.tick
    return this.base + Math.ceil((cycle - this.base) / p) * p
  }
  /** Sample number s (1-based) of bit k of a frame whose first low sample is at `start`. */
  private sample(start: number, k: number, s: number) {
    return start + (k * this.samples + s - 1) * this.tick
  }
  private get firstVote() {
    return this.u2x ? 4 : 8
  }
  private frameBits() {
    return this.dataBits + (this.parityMode >= 2 ? 1 : 0)
  }
  /** When the frame being received is decided: its stop bit's last voting sample. */
  private frameEnd(start: number) {
    return this.sample(start, this.frameBits() + 1, this.firstVote + 2)
  }

  /** Find the next start of a frame: a falling edge at or after `rxFrom`. */
  private findStart() {
    if (this.rxStart !== null) return
    let prev = this.levelAt(this.rxFrom - 1)
    for (const e of this.rxd) {
      if (e.cycle < this.rxFrom) continue
      if (prev && !e.level) {
        this.rxStart = this.baudTick(e.cycle)
        return
      }
      prev = e.level
    }
  }

  private syncRx(cycle: number) {
    for (;;) {
      this.findStart()
      const start = this.rxStart
      if (start === null) break
      const fv = this.firstVote
      const startDecided = this.sample(start, 0, fv + 2)
      if (cycle < startDecided) break
      if (this.vote(this.sample(start, 0, fv)) === 1) {
        // A spike, not a start bit: look for the next falling edge (§20.8.1).
        this.rxStart = null
        this.rxFrom = startDecided + 1
        continue
      }
      const end = this.frameEnd(start)
      if (cycle < end) break
      this.rxStart = null
      this.rxFrom = end + 1
      this.receiveFrame(start, end)
    }
    // Forget edges no frame needs any more.
    while (this.rxd.length > 1 && this.rxd[1].cycle < this.rxFrom - 4 * this.bitCycles) this.rxd.shift()
  }

  private receiveFrame(start: number, end: number) {
    const fv = this.firstVote
    const n = this.dataBits
    let data = 0
    for (let k = 0; k < n; k++) data |= this.vote(this.sample(start, k + 1, fv)) << k
    let upe = false
    let next = n + 1
    if (this.parityMode >= 2) {
      const p = this.vote(this.sample(start, next, fv))
      let x = 0
      for (let k = 0; k < n; k++) x ^= (data >> k) & 1
      upe = (x ^ (this.parityMode === 3 ? 1 : 0)) !== p
      next++
    }
    const stop = this.vote(this.sample(start, next, fv))
    // Multi-processor mode: frames whose type bit (ninth bit, or the first stop bit) is zero are dropped (§20.9).
    if (this.ucsrA & 0x01) {
      const type = n === 9 ? (data >> 8) & 1 : stop
      if (!type) return
    }
    const frame: Received = { data, fe: stop === 0, dor: false, upe }
    if (this.fifo.length < 2 && !this.shift) this.fifo.push(frame)
    else if (!this.shift) this.shift = frame
    else this.overrun = true
    void end
  }

  private readUdr(): number {
    const head = this.fifo.shift()
    if (this.shift && this.fifo.length < 2) {
      // The waiting frame moves in; it carries the overrun that happened while it waited (§20.7.4).
      this.fifo.push({ ...this.shift, dor: this.overrun })
      this.shift = null
      this.overrun = false
    }
    return head ? head.data & 0xff : 0
  }

  // --- pins -------------------------------------------------------------------------------------

  /** TxD (Table 14-11 PD1): TXEN makes it an output carrying the transmitter's line (idle high). */
  txdOverride(o: PinOverride) {
    if (!this.txEnabled && !this.frame) return
    o.puoe = true
    o.puov = false
    o.ddoe = true
    o.ddov = true
    o.pvoe = true
    o.pvov = this.txLevel
  }
  /** RxD (PD0): RXEN makes it an input, pull-up per PORTD0 and PUD. */
  rxdOverride(o: PinOverride, portBit: boolean, pud: boolean) {
    if (!this.rxEnabled) return
    o.puoe = true
    o.puov = portBit && !pud
    o.ddoe = true
    o.ddov = false
  }

  // --- scheduling --------------------------------------------------------------------------------

  override sync(cycle: number) {
    this.syncTx(cycle)
    this.syncRx(cycle)
  }
  private changed() {
    this.bus.irq.update()
    this.plan()
  }
  private plan() {
    const c = this.bus.cpu.cycles
    let due = this.nextTxEvent(c)
    if (this.rxStart !== null || this.rxd.some((e) => e.cycle >= this.rxFrom)) {
      this.findStart()
      if (this.rxStart !== null) {
        const fv = this.firstVote
        const startDecided = this.sample(this.rxStart, 0, fv + 2)
        due = Math.min(due, c < startDecided ? startDecided : this.frameEnd(this.rxStart))
      }
    }
    this.due = due
    this.bus.reschedule()
  }
  override service(cycle: number) {
    this.sync(cycle)
    this.bus.irq.update()
    this.plan()
  }
}
