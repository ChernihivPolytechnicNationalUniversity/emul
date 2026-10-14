/**
 * AVR USART in asynchronous mode (DS40002061B §20): the baud rate generator, a transmitter
 * that shifts out frames on the grid of its transmit clock, and a receiver that samples RxD
 * 16 (8 with U2X) times per bit, detects the start bit and votes on samples 8/9/10 (4/5/6)
 * of every bit, with the two-character receive FIFO and its error flags.
 *
 * Lazy like the timers: the transmitter's state is a frame with a start cycle, the receiver
 * keeps the RxD edges it has seen and decides a frame once its last sample has passed.
 *
 * Synchronous mode (§20.3.4) clocks the same frames with XCK: the baud rate generator's
 * fosc/(2·(UBRR+1)) as an output (master, DDR_XCK = 1) or the XCK pin through its two-cycle
 * synchronizer (slave); TxD changes on one XCK edge and RxD is sampled on the other (UCPOL).
 * Master SPI mode (§21) shifts eight bits per UDR write with XCK as SCK in the four SPI modes.
 */
import { Peripheral, type AvrBus } from "../io"
import type { AvrMcu } from "../mcu"
import type { PinOverride } from "../port"
import { syncEdge } from "./extint"

export type UsartSpec = {
  name: string
  regs: { ucsrA: number; ucsrB: number; ucsrC: number; ubrrL: number; ubrrH: number; udr: number }
  vectors: { rx: number; udre: number; tx: number }
  pins: { rxd: [number, number]; txd: [number, number]; xck: [number, number] }
  prr: number
  /** DDR_XCK: XCK is an output, the USART the synchronous master (§20.3). */
  xckOutput: () => boolean
}

type Mode = "async" | "master" | "slave" | "mspim"

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

  // Synchronous and MSPIM
  /** XCK as the USART drives it. */
  private xck = false
  /** All XCK output edges up to here are applied. */
  private xckSynced = 0
  /** Slave: XCK input edges after the synchronizer and edge detector, oldest first. */
  private readonly xckIn: { cycle: number; level: boolean }[] = []
  /** Slave transmitter: bit of the frame on TxD (-1: loaded, waiting for the first change edge). */
  private slaveBit = -1
  /** Synchronous receiver: bits of the frame after its start bit, or null between frames. */
  private srx: number[] | null = null
  private lastXckIn = -Infinity
  /** Master receiver: sample edges up to here are taken. */
  private rxSampled = 0

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
      if (port === spec.pins.xck[0] && pin === spec.pins.xck[1]) this.xckEdge(level, cycle)
    })
  }

  // --- configuration -------------------------------------------------------------------------

  /** Operating mode: UMSEL, and DDR_XCK for master or slave (§20.3, Table 20-8). */
  get mode(): Mode {
    const umsel = this.ucsrC >> 6
    if (umsel === 3) return "mspim"
    if (umsel === 1) return this.spec.xckOutput() ? "master" : "slave"
    return "async"
  }
  private get ucpol() {
    return (this.ucsrC & 0x01) !== 0
  }
  private get u2x() {
    // Double speed is an asynchronous-mode setting (§20.3.2).
    return (this.ucsrA & 0x02) !== 0 && this.mode === "async"
  }
  /** Baud ticks per bit: 16, or 8 with U2X (§20.3.2). */
  private get samples() {
    return this.u2x ? 8 : 16
  }
  private get tick() {
    return this.ubrr + 1
  }
  private get bitCycles() {
    // Synchronous master and MSPIM: the transmitter divides the baud clock by 2 (Table 20-1).
    return this.mode === "async" ? this.samples * this.tick : 2 * this.tick
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
    if (head) v |= 0x80 | (this.mode === "mspim" ? 0 : (head.fe ? 0x10 : 0) | (head.dor ? 0x08 : 0) | (head.upe ? 0x04 : 0))
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
    if (!(was & 0x10) && v & 0x10) {
      this.rxFrom = this.now + 1
      this.rxSampled = this.now
      this.srx = null
    }
    this.bus.pinsChanged()
  }
  private writeC(v: number) {
    const before = this.mode
    this.ucsrC = v
    if (v >> 6 === 2) this.mcu.feature(`${this.name}: UMSEL = 10 (reserved)`)
    if (this.mode !== before) this.restartClocked()
    this.xck = this.idleXck()
    this.bus.pinsChanged()
  }
  /** A mode change: synchronous state starts over from this cycle. */
  private restartClocked() {
    this.xckSynced = this.now
    this.rxSampled = this.now
    this.xckIn.length = 0
    this.srx = null
    this.slaveBit = -1
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
    this.xck = false
    this.xckSynced = 0
    this.xckIn.length = 0
    this.slaveBit = -1
    this.srx = null
    this.rxSampled = 0
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
    if (this.frame) return
    if (this.mode === "slave") {
      // Into the shift register now; it goes out from the next XCK change edge.
      this.load(Infinity)
      this.slaveBit = -1
    } else this.load(this.nextBoundary(this.now))
  }

  /** Move the buffer into the shift register at a bit boundary and start the frame there. */
  private load(at: number) {
    const v = this.txBuffer!
    this.txBuffer = null
    if (this.mode === "mspim") {
      // Eight data bits, no start, parity or stop bit; UDORD picks the order (§21.5).
      const lsb = (this.ucsrC & 0x04) !== 0
      this.frame = Array.from({ length: 8 }, (_, i) => (v >> (lsb ? i : 7 - i)) & 1)
      this.frameStart = at
      return
    }
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
      if (this.mode === "mspim") this.mspimReceive(this.frameStart)
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
    this.deliver(data, stop, upe)
    void end
  }
  /** A received frame into the FIFO (or the shift register, or lost to an overrun, §20.7.4). */
  private deliver(data: number, stop: number, upe: boolean) {
    // Multi-processor mode: frames whose type bit (ninth bit, or the first stop bit) is zero are dropped (§20.9).
    if (this.ucsrA & 0x01 && this.mode !== "mspim") {
      const type = this.dataBits === 9 ? (data >> 8) & 1 : stop
      if (!type) return
    }
    const frame: Received = { data, fe: stop === 0, dor: false, upe }
    if (this.fifo.length < 2 && !this.shift) this.fifo.push(frame)
    else if (!this.shift) this.shift = frame
    else this.overrun = true
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

  // --- synchronous and MSPIM clocking -----------------------------------------------------------

  /** XCK when no bit is being clocked: UCPOL in MSPIM (Table 21-2). */
  private idleXck(): boolean {
    return this.mode === "mspim" ? this.ucpol : false
  }
  /** The synchronous master's XCK runs while the transmitter or receiver is on. */
  private get masterClock(): boolean {
    return this.mode === "master" && (this.ucsrB & 0x18) !== 0
  }
  private get xckKey() {
    return this.spec.pins.xck[0] * 16 + this.spec.pins.xck[1]
  }
  /** XCK just after `t`, from the clock grid or the frame being shifted. */
  private xckAt(t: number): boolean {
    const h = this.tick
    if (this.masterClock) {
      // Change edges at base + 2k·h: rising with UCPOL = 0 (Figure 20-3).
      const phase = Math.floor((t - this.base) / h)
      return (phase % 2 === 0) !== this.ucpol
    }
    if (this.mode === "mspim" && this.frame && t >= this.frameStart && t < this.frameStart + 16 * h) {
      const phase = Math.floor((t - this.frameStart) / h)
      const cpha = (this.ucsrC & 0x02) !== 0
      const active = cpha ? phase % 2 === 0 : phase % 2 === 1
      return active !== this.ucpol
    }
    return this.idleXck()
  }
  /** Next XCK output edge after `after` (the free-running master clock only when the pad is watched). */
  private nextXckEdge(after: number): number {
    const h = this.tick
    if (this.masterClock) {
      if (!this.mcu.digitalWatch.has(this.xckKey)) return Infinity
      return this.base + (Math.floor((after - this.base) / h) + 1) * h
    }
    if (this.mode === "mspim" && this.frame && this.frameStart !== Infinity) {
      const cpha = (this.ucsrC & 0x02) !== 0
      const first = cpha ? 0 : 1
      const j = Math.max(first, Math.floor((after - this.frameStart) / h) + 1)
      if (j > first + 15) return Infinity
      return this.frameStart + j * h
    }
    return Infinity
  }
  /** Transmitter and XCK output edges in time order up to `cycle` (master and MSPIM). */
  private syncClocked(cycle: number) {
    for (;;) {
      const a = this.frame ? this.nextTxEvent(this.xckSynced) : Infinity
      const b = this.nextXckEdge(this.xckSynced)
      const t = Math.min(a, b)
      if (t > cycle) break
      if (a <= b) this.syncTx(a)
      const level = this.xckAt(t)
      if (level !== this.xck) {
        this.xck = level
        this.mcu.pinsChangedAt(t)
      }
      this.xckSynced = t
    }
    this.syncTx(cycle)
    // The free-running master clock is followed edge by edge only on a watched pad.
    const level = this.masterClock && !this.mcu.digitalWatch.has(this.xckKey) ? this.xck : this.xckAt(cycle)
    if (level !== this.xck) {
      this.xck = level
      this.mcu.pinsChangedAt(cycle)
    }
    this.xckSynced = Math.max(this.xckSynced, cycle)
  }

  /** MSPIM: the byte whose shifting began at `start` is in; RxD was sampled at start + (2i+1)·h (Figure 21-1). */
  private mspimReceive(start: number) {
    if (!this.rxEnabled) return
    const h = this.tick
    const lsb = (this.ucsrC & 0x04) !== 0
    let data = 0
    for (let i = 0; i < 8; i++) {
      const bit = this.levelAt(start + (2 * i + 1) * h) ? 1 : 0
      data |= bit << (lsb ? i : 7 - i)
    }
    this.deliver(data, 1, false)
  }

  /** Bits after the start bit in a synchronous frame: data, parity, first stop bit. */
  private get syncFrameBits() {
    return this.dataBits + (this.parityMode >= 2 ? 1 : 0) + 1
  }
  /** One RxD sample on a sample edge: start bit, then the frame's bits (§20.3.4). */
  private syncSample(t: number) {
    const bit = this.levelAt(t) ? 1 : 0
    if (!this.srx) {
      if (!bit) this.srx = []
      return
    }
    this.srx.push(bit)
    if (this.srx.length < this.syncFrameBits) return
    const bits = this.srx
    this.srx = null
    const n = this.dataBits
    let data = 0
    for (let k = 0; k < n; k++) data |= bits[k] << k
    let upe = false
    if (this.parityMode >= 2) {
      let x = 0
      for (let k = 0; k < n; k++) x ^= bits[k]
      upe = (x ^ (this.parityMode === 3 ? 1 : 0)) !== bits[n]
    }
    this.deliver(data, bits[bits.length - 1], upe)
  }
  /** Master: sample edges at base + (2k+1)·h. */
  private nextSampleEdge(after: number): number {
    const h = this.tick
    const k = Math.floor((after - this.base - h) / (2 * h)) + 1
    return this.base + (2 * k + 1) * h
  }
  /** Master receiver: the next sample edge that matters (idle: the first one that sees RxD low). */
  private nextMasterSample(): number {
    if (!this.masterClock || !this.rxEnabled) return Infinity
    const t = this.nextSampleEdge(this.rxSampled)
    if (this.srx || !this.levelAt(t)) return t
    const low = this.rxd.find((e) => e.cycle > t && !e.level)
    return low ? this.nextSampleEdge(low.cycle - 1e-9) : Infinity
  }
  private syncMasterRx(cycle: number) {
    for (;;) {
      const t = this.nextMasterSample()
      if (t > cycle) break
      this.syncSample(t)
      this.rxSampled = t
    }
    this.rxSampled = Math.max(this.rxSampled, cycle)
    // MSPIM reads a byte's samples when it ends: keep RxD from the start of the byte being shifted.
    const keep = this.mode === "mspim" ? (this.frame ? Math.min(this.frameStart, cycle) : cycle) - 1 : this.rxSampled - 4 * this.bitCycles
    while (this.rxd.length > 1 && this.rxd[1].cycle < keep) this.rxd.shift()
  }

  /** Slave: an XCK edge on the pin reaches the USART two to three cycles later (§20.3.3). */
  private xckEdge(level: boolean, cycle: number) {
    if (this.mode !== "slave" || !(this.ucsrB & 0x18)) return
    this.sync(this.bus.cpu.cycles)
    const at = syncEdge(cycle) + 2
    // Half a period under two cycles is above fosc/4: the synchronizer misses edges (§20.3.3).
    if (at - this.lastXckIn < 2) this.mcu.feature(`${this.name}: slave XCK above fosc/4 — the edges the synchronizer would miss are not modelled`)
    this.lastXckIn = at
    this.xckIn.push({ cycle: at, level })
    this.plan()
  }
  /** Slave: apply the XCK edges up to `cycle` — change edges move TxD, sample edges take RxD. */
  private syncSlave(cycle: number) {
    while (this.xckIn.length && this.xckIn[0].cycle <= cycle) {
      const e = this.xckIn.shift()!
      const change = e.level !== this.ucpol
      if (change) this.slaveChange(e.cycle)
      else if (this.rxEnabled) this.syncSample(e.cycle)
    }
    while (this.rxd.length > 2 && this.rxd[1].cycle < cycle - 1e6) this.rxd.shift()
  }
  private slaveChange(t: number) {
    if (!this.frame) return
    this.slaveBit++
    if (this.slaveBit >= this.frame.length) {
      this.frame = null
      this.slaveBit = -1
      if (this.txBuffer !== null) {
        this.load(Infinity)
        this.slaveBit = 0
      } else this.txc = true
    }
    const level = this.frame ? this.frame[this.slaveBit] === 1 : true
    if (level !== this.txLevel) {
      this.txLevel = level
      this.mcu.pinsChangedAt(t)
    }
  }

  // --- pins -------------------------------------------------------------------------------------

  /** XCK (Table 14-10 PD4): PVOE = UMSEL, PVOV = the clock output; DDR_XCK decides whether it drives. */
  xckOverride(o: PinOverride) {
    if (this.mode === "async") return
    o.pvoe = true
    o.pvov = this.xck
  }
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
    switch (this.mode) {
      case "async":
        this.syncTx(cycle)
        this.syncRx(cycle)
        return
      case "slave":
        return this.syncSlave(cycle)
      default:
        this.syncClocked(cycle)
        this.syncMasterRx(cycle)
    }
  }
  private changed() {
    this.bus.irq.update()
    this.plan()
  }
  private plan() {
    const c = this.bus.cpu.cycles
    const mode = this.mode
    if (mode !== "async") {
      let due = mode === "slave" ? (this.xckIn[0]?.cycle ?? Infinity) : Math.min(this.frame ? this.nextTxEvent(c) : Infinity, this.nextXckEdge(Math.max(c, this.xckSynced)))
      if (mode === "master") {
        // The receiver's next frame is decided at its last sample edge.
        let t = this.nextMasterSample()
        if (t !== Infinity) t += (this.syncFrameBits - (this.srx ? this.srx.length + 1 : 0)) * 2 * this.tick
        due = Math.min(due, t)
      }
      this.due = Math.ceil(due)
      this.bus.reschedule()
      return
    }
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
