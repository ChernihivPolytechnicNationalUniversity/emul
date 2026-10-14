/**
 * The USART (DS40044G §12, DS33023A §18; checklist P3-073…P3-170, P9-123…P9-176, decisions D24–D32).
 *
 * One BRG, free-running from its last restart (an SPBRG write; in sync master mode also TXEN/CREN/SREN
 * leaving the all-clear state). Asynchronous: x16 ticks of (SPBRG + 1)·(BRGH ? 1 : 4) TOSC, a bit every
 * 16 of them; the transmitter starts a frame on the next bit tick after the TSR is loaded; the receiver
 * starts its x16 count at the first tick after a falling edge on RX and votes three samples on x16
 * clocks 7, 8 and 9 of each bit (Figure 18-6, D25). Synchronous master: a CK period of (SPBRG + 1) TCY,
 * bits out on rising edges and sampled on falling ones (D30); slave: the same on the edges of the CK pin.
 *
 * Times are fractional instruction cycles. Everything inside is an event list walked in order by
 * `advance`; edges on RB1/RB2 come in through `rxEdge`/`ckEdge` after the block is brought up to them,
 * so the RX/DT level between two edges is the pin's level at the earlier one.
 */
import { Peripheral, type PicBus } from "../io"

export interface UsartHost {
  /** Set or clear RCIF (20h) / TXIF (10h) in PIR1 at `cycle`. */
  flag(mask: number, on: boolean, cycle: number): void
  /** RB1/RB2 level at a past fractional cycle. */
  pinAt(pin: number, at: number): boolean
  /** The USART's pin outputs changed at `cycle`. */
  pinsChanged(cycle: number): void
}

const TXIF = 0x10
const RCIF = 0x20

/** The TSR's word on its way out: async — bit boundaries `k` (0 start, 1…n data, n + 1 stop, n + 2 end); sync — CK edges. */
type Shift = { value: number; n: number; start: number; k: number }
type Received = { data: number; bit9: boolean; ferr: boolean }

export class Usart extends Peripheral {
  readonly name = "USART"
  private readonly host: UsartHost
  txsta = 0x02
  /** SPEN, RX9, SREN, CREN, ADEN as written; FERR, OERR and RX9D come from the receiver. */
  private rcstaBits = 0
  spbrg = 0
  txreg = 0
  private txFull = false
  private txifAt = Infinity
  private tsr: Shift | null = null
  /** Async receiver: x16 tick 1 of the frame and the next sample's index (3 per bit). */
  private rx: { s0: number; i: number; ones: number; value: number } | null = null
  private lastFall = -Infinity
  /** Sync master reception in progress, and the slave's bit counts. */
  private srx: Shift | null = null
  private slaveRx = { n: 0, value: 0 }
  private readonly fifo: Received[] = []
  private oerr = false
  private ferr = false
  private rx9d = false
  private lastRead = 0
  private brgOrigin = 0
  /** The time the block has been brought up to. */
  private t = 0
  private frozenAt: number | null = null
  /** Pin outputs: TX (async), CK and DT (sync). */
  txOut = true
  ckOut = false
  dtOut = false

  constructor(bus: PicBus, host: UsartHost) {
    super(bus)
    this.host = host
  }

  // --- modes -------------------------------------------------------------------------------------

  get spen() {
    return (this.rcstaBits & 0x80) !== 0
  }
  private get rx9() {
    return (this.rcstaBits & 0x40) !== 0
  }
  private get sren() {
    return (this.rcstaBits & 0x20) !== 0
  }
  private get cren() {
    return (this.rcstaBits & 0x10) !== 0
  }
  private get aden() {
    return (this.rcstaBits & 0x08) !== 0
  }
  get isSync() {
    return (this.txsta & 0x10) !== 0
  }
  private get master() {
    return this.isSync && (this.txsta & 0x80) !== 0
  }
  private get slave() {
    return this.isSync && !(this.txsta & 0x80)
  }
  private get txen() {
    return (this.txsta & 0x20) !== 0
  }
  private get tx9() {
    return (this.txsta & 0x40) !== 0
  }
  /** SREN/CREN override TXEN in sync mode (Register 12-1 note 1). */
  private get receiving() {
    return this.isSync && (this.cren || this.sren)
  }
  /** x16 tick and bit time (async), CK period (sync), in cycles (Table 12-1). */
  private get t16() {
    return ((this.spbrg + 1) * (this.txsta & 0x04 ? 1 : 4)) / 4
  }
  private get tbit() {
    return this.isSync ? this.spbrg + 1 : 16 * this.t16
  }
  private tickAfter(t: number, period: number) {
    return this.brgOrigin + Math.max(0, Math.ceil((t - this.brgOrigin) / period - 1e-9)) * period
  }

  /** What the USART does to RB1 (DT) and RB2 (TX/CK) with SPEN set (Figures 5-9/5-10, D28). */
  pinOut(pin: 1 | 2): { enable: boolean; value: boolean } {
    if (pin === 2) {
      if (!this.isSync) return { enable: this.txen, value: this.txOut }
      return { enable: this.master && (this.txen || this.cren || this.sren), value: this.ckOut }
    }
    return { enable: this.isSync && this.txen && !this.receiving, value: this.isSync ? this.dtOut : true }
  }

  // --- registers ---------------------------------------------------------------------------------

  readTxsta() {
    this.advance(this.now)
    return this.peekTxsta()
  }
  peekTxsta() {
    return (this.txsta & 0xf5) | (this.tsr ? 0 : 0x02)
  }
  readRcsta() {
    this.advance(this.now)
    return this.peekRcsta()
  }
  peekRcsta() {
    return this.rcstaBits | (this.ferr ? 0x04 : 0) | (this.oerr ? 0x02 : 0) | (this.rx9d ? 1 : 0)
  }
  /** A read of RCREG takes the head of the FIFO; the next word's FERR and RX9D show (P3-129, P3-134; D29). */
  readRcreg() {
    const at = this.now
    this.advance(at)
    const w = this.fifo.shift()
    if (w) this.lastRead = w.data
    const head = this.fifo[0]
    if (head) {
      this.ferr = head.ferr
      this.rx9d = head.bit9
    }
    if (!this.fifo.length) this.host.flag(RCIF, false, at)
    return this.lastRead
  }
  peekRcreg() {
    return this.fifo[0]?.data ?? this.lastRead
  }

  writeTxsta(v: number) {
    const at = this.now
    this.advance(at)
    const was = this.txsta
    const runWas = this.brgRunning
    this.txsta = v & 0xf5
    if ((was ^ v) & 0x90) this.abortAll(at)
    if (!this.isSync || this.master) this.restartIfStarting(runWas, at)
    if ((was & 0x20) && !this.txen) {
      // Clearing TXEN resets the transmitter: the TSR's word is dropped, TXREG keeps its word (D27).
      this.tsr = null
      this.txifAt = Infinity
      this.txOut = true
      this.host.flag(TXIF, false, at)
    } else if (!(was & 0x20) && this.txen) {
      if (!this.txFull) this.host.flag(TXIF, true, at)
      else this.tryLoad(at)
    }
    this.changed(at)
  }
  writeRcsta(v: number) {
    const at = this.now
    this.advance(at)
    const was = this.rcstaBits
    const runWas = this.brgRunning
    this.rcstaBits = v & 0xf8
    if ((was & 0x10) && !this.cren) {
      // Clearing CREN resets the receive logic: OERR clears, the word being shifted is dropped (P3-132; D29).
      this.oerr = false
      this.rx = null
      this.slaveRx = { n: 0, value: 0 }
      if (!this.sren) this.srx = null
    }
    if ((was & 0x80) && !this.spen) this.rx = null
    if (this.master) {
      this.restartIfStarting(runWas, at)
      if (this.receiving && !(((was & 0x30) !== 0))) {
        // CREN/SREN during a transmission abort it (D31) and start the clock for reception.
        this.tsr = null
        this.startReceive(at)
      }
      if (!this.receiving) {
        this.srx = null
        this.tryLoad(at)
      }
    }
    this.changed(at)
  }
  writeSpbrg(v: number) {
    const at = this.now
    this.advance(at)
    this.spbrg = v & 0xff
    // A write clears the BRG timer: the new rate starts now (P3-100).
    this.brgOrigin = at
    this.changed(at)
  }
  writeTxreg(v: number) {
    const at = this.now
    this.advance(at)
    this.txreg = v & 0xff
    this.txFull = true
    this.txifAt = Infinity
    this.host.flag(TXIF, false, at)
    this.tryLoad(at)
    this.changed(at)
  }

  /** Sync master: the BRG runs while TXEN, CREN or SREN is set. */
  private get brgRunning() {
    return this.txen || this.cren || this.sren
  }
  private restartIfStarting(wasRunning: boolean, at: number) {
    if (this.master && !wasRunning && this.brgRunning) this.brgOrigin = at
  }

  /** TXREG → TSR with the present TX9D when the TSR is empty (P3-114, P3-122; D27); TXIF one TCY later. */
  private tryLoad(at: number) {
    if (!this.txFull || this.tsr || !this.txen || this.receiving) return
    const n = this.tx9 ? 9 : 8
    const value = this.txreg | (this.txsta & 1 ? 0x100 : 0)
    const start = this.tickAfter(at, this.tbit)
    this.tsr = { value, n, start, k: 0 }
    this.txFull = false
    this.txifAt = at + 1
  }
  private startReceive(at: number) {
    if (this.srx) return
    this.srx = { value: 0, n: this.rx9 ? 9 : 8, start: this.tickAfter(at, this.tbit), k: 0 }
  }
  private abortAll(at: number) {
    this.tsr = null
    this.rx = null
    this.srx = null
    this.slaveRx = { n: 0, value: 0 }
    this.txifAt = Infinity
    this.txOut = true
    this.ckOut = false
    void at
  }
  private changed(at: number) {
    this.host.pinsChanged(at)
    this.plan()
    this.bus.reschedule()
  }

  // --- the event walk ------------------------------------------------------------------------------

  /** The BRG and the shifters stop with the core clock in async and master modes (P3-112; D30). */
  private get stopped() {
    return this.frozenAt !== null && !this.slave
  }
  private nextEvent(): number {
    if (this.stopped) return Infinity
    let e = this.txifAt
    if (this.tsr && !this.slave) e = Math.min(e, this.shiftTime(this.tsr))
    if (this.srx) e = Math.min(e, this.shiftTime(this.srx))
    if (this.rx) e = Math.min(e, this.sampleTime(this.rx))
    return e
  }
  private shiftTime(s: Shift) {
    return s.start + s.k * (this.isSync ? this.tbit / 2 : this.tbit)
  }
  private sampleTime(r: { s0: number; i: number }) {
    return r.s0 + (16 * Math.floor(r.i / 3) + 6 + (r.i % 3)) * this.t16
  }
  private plan() {
    const e = this.nextEvent()
    this.due = e === Infinity ? Infinity : Math.max(Math.ceil(e - 1e-9), this.bus.cpu.cycles)
  }

  private advance(to: number) {
    for (let guard = 0; guard < 1e6; guard++) {
      const e = this.nextEvent()
      if (e > to + 1e-9) break
      this.t = Math.max(this.t, e)
      if (e === this.txifAt) {
        this.txifAt = Infinity
        if (this.txen && !this.txFull) this.host.flag(TXIF, true, e)
      } else if (this.tsr && !this.slave && e === this.shiftTime(this.tsr)) this.txStep(this.tsr, e)
      else if (this.srx && e === this.shiftTime(this.srx)) this.masterRxStep(this.srx, e)
      else if (this.rx) this.rxSample(this.rx, e)
    }
    this.t = Math.max(this.t, to)
  }

  /** One bit boundary (async) or CK edge (sync master) of the word going out. */
  private txStep(s: Shift, e: number) {
    if (!this.isSync) {
      const k = s.k++
      this.txOut = k === 0 ? false : k <= s.n ? ((s.value >> (k - 1)) & 1) === 1 : true
      if (k === s.n + 2) this.wordSent(e)
      this.host.pinsChanged(e)
      return
    }
    const k = s.k++
    if (k % 2 === 0) {
      this.ckOut = true
      this.dtOut = ((s.value >> (k / 2)) & 1) === 1
    } else {
      this.ckOut = false
      if (k === 2 * s.n - 1) this.wordSent(e)
    }
    this.host.pinsChanged(e)
  }
  private wordSent(e: number) {
    this.tsr = null
    this.tryLoad(e)
  }

  private masterRxStep(s: Shift, e: number) {
    const k = s.k++
    if (k % 2 === 0) {
      this.ckOut = true
    } else {
      this.ckOut = false
      if (this.host.pinAt(1, e)) s.value |= 1 << ((k - 1) / 2)
      if (k === 2 * s.n - 1) {
        this.received(s.value & 0xff, (s.value & 0x100) !== 0, false, e)
        // SREN alone: one word, then it clears (P3-088); CREN goes on (P3-157).
        if (!this.cren) {
          this.rcstaBits &= ~0x20
          this.srx = null
          // TXEN still set: the transmitter takes DT again (P3-152).
          this.tryLoad(e)
        } else this.srx = { value: 0, n: this.rx9 ? 9 : 8, start: e + this.tbit / 2, k: 0 }
      }
    }
    this.host.pinsChanged(e)
  }

  /** One of the three samples of an async bit (D25, D26). */
  private rxSample(r: { s0: number; i: number; ones: number; value: number }, e: number) {
    if (this.host.pinAt(1, e)) r.ones++
    r.i++
    if (r.i % 3) return
    const bit = r.i / 3 - 1
    const one = r.ones >= 2
    r.ones = 0
    const n = this.rx9 ? 9 : 8
    if (bit === 0) {
      if (one) this.rx = null // a glitch, not a start bit
      return
    }
    if (bit <= n) {
      if (one) r.value |= 1 << (bit - 1)
      return
    }
    this.rx = null
    this.received(r.value & 0xff, (r.value & 0x100) !== 0, !one, e)
    // A start bit already under way (its falling edge came during this frame's stop bit).
    if (this.lastFall > r.s0 && !this.host.pinAt(1, e)) this.startRx(this.lastFall)
  }

  /** RSR → FIFO at the end of a word (P3-128, P3-131, P3-137; D29). */
  private received(data: number, bit9: boolean, ferr: boolean, e: number) {
    if (this.oerr) return
    if (!this.isSync && this.rx9 && this.aden && !bit9) return
    if (this.fifo.length >= 2) {
      this.oerr = true
      return
    }
    this.fifo.push({ data, bit9, ferr })
    if (this.fifo.length === 1) {
      this.ferr = ferr
      this.rx9d = bit9
    }
    this.host.flag(RCIF, true, e)
  }

  private startRx(e: number) {
    this.rx = { s0: this.tickAfter(e, this.t16), i: 0, ones: 0, value: 0 }
  }

  // --- pins ------------------------------------------------------------------------------------------

  /** RB1 changed (RX in async). */
  rxEdge(level: boolean, at: number) {
    const e = Math.max(at, this.t)
    this.advance(e - 1e-9)
    if (level) return
    this.lastFall = e
    if (!this.isSync && this.spen && this.cren && !this.rx && !this.stopped) this.startRx(e)
    this.plan()
    this.bus.reschedule()
  }

  /** RB2 changed: a slave's clock (§12.5). */
  ckEdge(level: boolean, at: number) {
    if (!this.slave || !this.spen) return
    const e = Math.max(at, this.t)
    this.advance(e - 1e-9)
    if (this.cren) {
      if (!level) {
        const n = this.rx9 ? 9 : 8
        if (this.host.pinAt(1, e)) this.slaveRx.value |= 1 << this.slaveRx.n
        if (++this.slaveRx.n === n) {
          this.received(this.slaveRx.value & 0xff, (this.slaveRx.value & 0x100) !== 0, false, e)
          this.slaveRx = { n: 0, value: 0 }
        }
      }
    } else if (this.tsr && this.txen && !this.sren) {
      const s = this.tsr
      if (level) {
        if (s.k < s.n) this.dtOut = ((s.value >> s.k) & 1) === 1
        s.k++
        this.host.pinsChanged(e)
      } else if (s.k >= s.n) this.wordSent(e)
    }
    this.plan()
    this.bus.reschedule()
  }

  // --- Peripheral ------------------------------------------------------------------------------------

  reset(por: boolean) {
    this.txsta = 0
    this.rcstaBits = 0
    this.spbrg = 0
    this.txreg = 0
    this.txFull = false
    this.txifAt = Infinity
    this.tsr = null
    this.rx = null
    this.srx = null
    this.slaveRx = { n: 0, value: 0 }
    this.fifo.length = 0
    this.oerr = false
    this.ferr = false
    if (por) this.rx9d = this.bus.random() < 0.5
    this.lastRead = 0
    this.lastFall = -Infinity
    this.brgOrigin = this.bus.cpu.cycles
    this.t = this.bus.cpu.cycles
    this.frozenAt = null
    this.txOut = true
    this.ckOut = false
    this.dtOut = false
    this.due = Infinity
  }
  sync(cycle: number) {
    this.advance(cycle)
  }
  service(cycle: number) {
    this.advance(cycle)
    this.plan()
  }
  setClockRunning(running: boolean, cycle: number) {
    if (!running) {
      this.advance(cycle)
      this.frozenAt = cycle
      this.plan()
      this.bus.reschedule()
      return
    }
    if (this.frozenAt === null) return
    // The asynchronous and master timings resume where they stopped (D30).
    const shift = this.slave ? 0 : cycle - this.frozenAt
    this.frozenAt = null
    this.brgOrigin += shift
    if (this.tsr) this.tsr.start += shift
    if (this.srx) this.srx.start += shift
    if (this.rx) this.rx.s0 += shift
    if (this.txifAt !== Infinity && !this.slave) this.txifAt += shift
    this.t = cycle
    this.plan()
    this.bus.reschedule()
  }
}
