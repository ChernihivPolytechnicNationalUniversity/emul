/**
 * Microchip ENC28J60 stand-alone 10BASE-T Ethernet controller with SPI (Netduino Plus 2, U5,
 * ENC28J60T-I/SS).
 *
 * Sources: Microchip data sheet DS39662E ("[DS]") and silicon errata DS80349C ("[ERR]"). Section,
 * table, figure and register numbers below refer to them. Board wiring (CW0034 Rev A): SCK PA5,
 * SI PA7, SO PB4, CS PC8, INT PA4, RESET PD2 (SPI1); OSC1 from MCO1 PA8 (25 MHz, no crystal);
 * VDD switched by PC15 low; LEDB sources the ACT LED D7 with R15 10 kΩ across it.
 *
 * The part is modelled at the bus level: SPI mode 0 bits in, SO bits out, INT as a push-pull pin.
 * The Ethernet side is frames: `receive` hands the chip a frame from the wire, `takeTransmitted`
 * gives the frames it sent. Time is the loop clock in seconds (input/tick/quietUntil).
 *
 * The clock: OSC1 cannot be fed edge by edge at 25 MHz by the board's loop, so the integrator
 * tells the part what MCO1 outputs with `setClock(hz, time)` (0 = no clock). Edges on the clkin
 * pin are measured as well (two rising edges give a frequency) for a bench that does toggle it.
 * Power: `setPower(on, time)` (the PC15 load switch); `reset()` is a power-on reset at time 0.
 */
import type { DigitalEdge, DigitalPart } from "./digital-part"

export type Enc28j60Pins = { cs: string; sck: string; mosi: string; miso: string; int: string; reset: string; clkin: string }

export type Enc28j60Snapshot = {
  powered: boolean
  clockHz: number
  clockReady: boolean
  revision: string
  link: boolean
  packetsPending: number
  sent: number
  received: number
  leds: { a: boolean; b: boolean }
  warnings: string[]
}

/** What this model does not do. Kept current: the inspector shows it. */
export const NOT_MODELLED: string[] = [
  "Collisions, deferral, backoff, late collisions and jabber ([DS] §9.1): the medium is always free, so MACLCON1/MACLCON2/MACON4/MABBIPG/MAIPG are stored but have no effect and TSV collision/defer bits are always 0",
  "Flow control: half-duplex jamming (EFLOCON.FCEN) and full-duplex pause frames, sent or obeyed ([DS] §10); RXPAUS does not stop the transmitter",
  "Half-duplex internal loopback (PHCON2.HDLDIS = 0) and full-duplex PLOOPBK loopback ([DS] §9, PHCON1): unreliable on silicon ([ERR] issues 9, 10), not looped here",
  "Built-in self-test controller ([DS] §15): EBST* registers are storage only, BISTST never completes",
  "Receive timing: a frame is written in one go, so ESTAT.RXBUSY and PHSTAT2.RXSTAT stay 0, and DMA checksum during a receive cannot abort it ([ERR] issue 17)",
  "DMA and transmit sharing the buffer port: a DMA started during a transmit does not wait for it ([DS] §13.1)",
  "ESTAT.BUFER is never set (no buffer underrun/overrun source is modelled)",
  "LED blink fast/slow modes (LxCFG = 1010/1011): the rates are not in [DS] (Register 2-2); shown lit",
  "LEDB auto-polarity detection at reset ([DS] §2.6, [ERR] issue 16): taken as configured (prop ledb, default 'source' as on the Netduino Plus 2, where R15 is the errata's workaround)",
  "Link establishment time and link pulses: the link is up as soon as the PHY is ready and a cable is plugged (setLink); PHSTAT1.JBSTAT and PHSTAT2.COLSTAT/PLRITY stay 0",
  "PHY power-down PHCON1.PPWRSV and PHCON2.TXDIS only drop the link; analog PHY, magnetics, RBIAS ([ERR] issue 8) and TPIN polarity ([ERR] issue 7) are not modelled",
  "CLKOUT (pin 3 is not connected on the Netduino Plus 2): ECOCON is storage only ([DS] §2.3, [ERR] issue 4)",
  "MIISCAN of PHIR clears PLNKIF/PGIF only when MIRD is read, not every 10.24 µs",
  "Errata behaviours that need collisions or randomness: transmit-abort stall ([ERR] issue 12), link pulse collisions (13), LATECOL (15), PKTIF unreliability (6, PKTIF here always equals EPKTCNT ≠ 0), ERXST ≠ 0000h corrupting the write pointer (5) and even ERXRDPT corrupting the buffer (14) — 5 and 14 are reported as warnings instead",
  "SPI timing other than the 20 MHz SCK limit (CS setup/hold, the 210 ns MAC/MII CS hold of Table 16-6) is not checked",
  "Supply current and the 3.1–3.6 V supply range (Table 16-1): power is on or off",
]

// --- Data sheet numbers ----------------------------------------------------------------------

/** Table 16-2: FOSC = 25 MHz, ±50 ppm. */
const F_OSC = 25e6
const F_TOLERANCE = 50e-6
/** §2.2: the OST expires 7500 OSC1 cycles (300 µs) after POR or wake-up. */
const OST_CYCLES = 7500
/** §3.3.1–3.3.3: an MIIM read/write takes 10.24 µs = 256 OSC1 cycles. */
const MIIM_CYCLES = 256
/** Table 16-3: RESET low for at least 400 ns triggers a reset; shorter pulses are filtered (§11.2). */
const T_RSTLOW = 400e-9
/** Table 16-6: FSCK max 20 MHz. */
const F_SCK_MAX = 20e6
/** [ERR] issue 1 (B1, B4): MAC registers unreliable with SPI below 8 MHz. */
const F_SCK_MAC_MIN_B1B4 = 8e6
/** 10BASE-T: 10 Mb/s. Preamble + SFD are 8 bytes on the wire ([DS] §5.1, Figure 5-1). */
const BYTE_TIME = 8 * 100e-9
const PREAMBLE = 8
/** Table 2-1: LED stretch TNSTRCH 40 ms, TMSTRCH 70 ms, TLSTRCH 140 ms. */
const STRETCH = [40e-3, 70e-3, 140e-3, 140e-3]
/** [ERR] Table 1: EREVID per silicon revision. B7 is current; which one the Netduino carries is not documented. */
const REVISIONS: Record<string, number> = { B1: 0x02, B4: 0x04, B5: 0x05, B7: 0x06 }

// --- Control register map (Table 3-1, Table 3-2) ---------------------------------------------

const B1 = 32
const B2 = 64
const B3 = 96
const ERDPTL = 0x00, EWRPTL = 0x02, ETXSTL = 0x04, ETXNDL = 0x06, ERXSTL = 0x08, ERXNDL = 0x0a
const ERXRDPTL = 0x0c, ERXRDPTH = 0x0d, ERXWRPTL = 0x0e, EDMASTL = 0x10, EDMANDL = 0x12, EDMADSTL = 0x14, EDMACSL = 0x16
const EHT0 = B1 + 0x00, EPMM0 = B1 + 0x08, EPMCSL = B1 + 0x10, EPMOL = B1 + 0x14, ERXFCON = B1 + 0x18, EPKTCNT = B1 + 0x19
const MACON1 = B2 + 0x00, MACON3 = B2 + 0x02, MAMXFLL = B2 + 0x0a, MICMD = B2 + 0x12, MIREGADR = B2 + 0x14
const MIWRL = B2 + 0x16, MIWRH = B2 + 0x17, MIRDL = B2 + 0x18, MIRDH = B2 + 0x19
const MISTAT = B3 + 0x0a, EREVID = B3 + 0x12, ECOCON = B3 + 0x15, EFLOCON = B3 + 0x17
const EIE = 0x1b, EIR = 0x1c, ESTAT = 0x1d, ECON2 = 0x1e, ECON1 = 0x1f

// ECON1 (Register 3-1), ECON2 (Register 3-2), EIR (Register 12-3), ESTAT (Register 12-1).
const TXRST = 0x80, RXRST = 0x40, DMAST = 0x20, CSUMEN = 0x10, TXRTS = 0x08, RXEN = 0x04
const AUTOINC = 0x80, PKTDEC = 0x40, PWRSV = 0x20
const PKTIF = 0x40, DMAIF = 0x20, LINKIF = 0x10, TXIF = 0x08, TXERIF = 0x02, RXERIF = 0x01
const EIR_STORED = DMAIF | TXIF | TXERIF | RXERIF
const BUFER = 0x40, LATECOL = 0x10, TXABRT = 0x02
const ESTAT_STORED = BUFER | LATECOL | TXABRT

/** [index, reset value, writable bits]. Absent indices are unimplemented or reserved: read 0, writes ignored (§3.1). */
const DEFS: [number, number, number][] = [
  // Bank 0. ERXWRPT is read-only (§3.2.1).
  [0x00, 0xfa, 0xff], [0x01, 0x05, 0x1f], [0x02, 0x00, 0xff], [0x03, 0x00, 0x1f],
  [0x04, 0x00, 0xff], [0x05, 0x00, 0x1f], [0x06, 0x00, 0xff], [0x07, 0x00, 0x1f],
  [0x08, 0xfa, 0xff], [0x09, 0x05, 0x1f], [0x0a, 0xff, 0xff], [0x0b, 0x1f, 0x1f],
  [0x0c, 0xfa, 0xff], [0x0d, 0x05, 0x1f], [0x0e, 0x00, 0x00], [0x0f, 0x00, 0x00],
  [0x10, 0x00, 0xff], [0x11, 0x00, 0x1f], [0x12, 0x00, 0xff], [0x13, 0x00, 0x1f],
  [0x14, 0x00, 0xff], [0x15, 0x00, 0x1f], [0x16, 0x00, 0xff], [0x17, 0x00, 0xff],
  // Bank 1. EPKTCNT changes only through reception and PKTDEC (§7.2.4): read-only (decision, Table 3-2 gives no access type).
  ...Array.from({ length: 16 }, (_, i): [number, number, number] => [B1 + i, 0x00, 0xff]),
  [B1 + 0x10, 0x00, 0xff], [B1 + 0x11, 0x00, 0xff], [B1 + 0x14, 0x00, 0xff], [B1 + 0x15, 0x00, 0x1f],
  [B1 + 0x18, 0xa1, 0xff], [B1 + 0x19, 0x00, 0x00],
  // Bank 2 (MAC/MII). MACON1 r bit 4 "maintain as 0" (Register 6-1); MACON4 bits 1-0 R-0 (Register 6-3); MIRD read-only.
  [B2 + 0x00, 0x00, 0x1f], [B2 + 0x02, 0x00, 0xff], [B2 + 0x03, 0x00, 0x70], [B2 + 0x04, 0x00, 0x7f],
  [B2 + 0x06, 0x00, 0x7f], [B2 + 0x07, 0x00, 0x7f], [B2 + 0x08, 0x0f, 0x0f], [B2 + 0x09, 0x37, 0x3f],
  [B2 + 0x0a, 0x00, 0xff], [B2 + 0x0b, 0x06, 0xff], [B2 + 0x12, 0x00, 0x03], [B2 + 0x14, 0x00, 0x1f],
  [B2 + 0x16, 0x00, 0xff], [B2 + 0x17, 0x00, 0xff], [B2 + 0x18, 0x00, 0x00], [B2 + 0x19, 0x00, 0x00],
  // Bank 3. MISTAT is read-only (Register 3-4); EREVID read-only (Table 3-2 note 2); EFLOCON.FULDPXS read-only (Register 10-1).
  [B3 + 0x00, 0x00, 0xff], [B3 + 0x01, 0x00, 0xff], [B3 + 0x02, 0x00, 0xff], [B3 + 0x03, 0x00, 0xff],
  [B3 + 0x04, 0x00, 0xff], [B3 + 0x05, 0x00, 0xff], [B3 + 0x06, 0x00, 0xff], [B3 + 0x07, 0x00, 0xff],
  [B3 + 0x08, 0x00, 0xff], [B3 + 0x09, 0x00, 0xff], [B3 + 0x0a, 0x00, 0x00], [B3 + 0x12, 0x00, 0x00],
  [B3 + 0x15, 0x04, 0x07], [B3 + 0x17, 0x00, 0x03], [B3 + 0x18, 0x00, 0xff], [B3 + 0x19, 0x10, 0xff],
  // Common. EIR/ESTAT bits are read-only or clear-only (handled in write); ECON2 bits 2-0 unimplemented, PKTDEC self-clearing.
  [EIE, 0x00, 0xff], [EIR, 0x00, 0x00], [ESTAT, 0x00, 0x00], [ECON2, 0x80, 0xb8], [ECON1, 0x00, 0xff],
]
const DEFINED = new Uint8Array(128)
const WRITABLE = new Uint8Array(128)
const RESET = new Uint8Array(128)
for (const [i, reset, rw] of DEFS) {
  DEFINED[i] = 1
  WRITABLE[i] = rw
  RESET[i] = reset
}

/** Register index from bank and 5-bit address: 1Bh–1Fh are the same registers in all banks (§3.1). */
const idx = (bank: number, addr: number) => (addr >= 0x1b ? addr : bank * 32 + addr)
/** MAC and MII registers (bank 2, MAADR1–6 and MISTAT in bank 3): RCR shifts a dummy byte first (§4.2.1), BFS/BFC do not apply (§4.2.5/4.2.6). */
const isMac = (i: number) => (i >= B2 && i < B2 + 0x1a) || (i >= B3 && (i - B3 <= 0x05 || i - B3 === 0x0a))

// PHY registers (Table 3-3).
const PHCON1 = 0x00, PHSTAT1 = 0x01, PHID1 = 0x02, PHID2 = 0x03, PHCON2 = 0x10, PHSTAT2 = 0x11, PHIE = 0x12, PHIR = 0x13, PHLCON = 0x14
const PRST = 0x8000, PPWRSV = 0x0800, PDPXMD = 0x0100
const FRCLNK = 0x4000, TXDIS = 0x2000
const PLNKIE = 0x0010, PGEIE = 0x0002

// --- CRC-32 ([DS] §5.1.7: the IEEE 802.3 FCS) -------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: ArrayLike<number>, from = 0, to = bytes.length): number {
  let c = 0xffffffff
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** The FCS bytes in wire order: x^31 first, which is the low byte of the reflected CRC first (Figure 5-1 note 1). */
function fcsBytes(bytes: ArrayLike<number>, to = bytes.length): number[] {
  const c = crc32(bytes, 0, to)
  return [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24]
}

function fcsValid(bytes: ArrayLike<number>): boolean {
  if (bytes.length < 4) return false
  const want = fcsBytes(bytes, bytes.length - 4)
  return want.every((b, k) => bytes[bytes.length - 4 + k] === b)
}

/** One's complement checksum of big-endian 16-bit words, odd length padded with 00h (§13.2, also the pattern match of §8.2). */
function ipChecksum(bytes: number[]): number {
  let sum = 0
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (bytes[i + 1] ?? 0)
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16)
  return ~sum & 0xffff
}

type Phase = "idle" | "skip" | "cmd" | "rcr" | "rbm" | "wcr" | "wbm" | "bfs" | "bfc"

type Tx = { doneAt: number; frame: Uint8Array | null; tsv: number[]; abort: boolean }

export class Enc28j60 implements DigitalPart {
  readonly object: string
  readonly pins: readonly string[]
  readonly outputs: readonly string[]
  readonly out: DigitalEdge[] = []
  private readonly p: Enc28j60Pins

  // Pins as last seen. CS and RESET have internal weak pull-ups (Table 1-1 note 4).
  private cs = true
  private sck = false
  private mosi = false
  private rstPin = true
  private resetLowAt = -Infinity
  private resetApplied = false
  private soDrive: boolean | null = null
  private intDrive: boolean | null = true

  // Supply and clock.
  private powered = true
  private clockHz = 0
  private clockSince = Infinity
  private ostFrom = 0
  private clkReady = false
  private phyReadyAt = 0
  private lastClkRise = -Infinity
  private now = 0

  // Memory.
  private readonly regs = new Uint8Array(128)
  private readonly mem = new Uint8Array(8192)
  private rdptLow = 0xfa
  private rxWp = 0x05fa
  private dropped = false

  // PHY.
  private phcon1 = 0
  private phcon2 = 0
  private phie = 0
  private phlcon = 0x3422
  private plnkif = false
  private pgif = false
  private llstat = false
  private cable = true

  // MIIM.
  private miiOp: "read" | "write" | "scan" | null = null
  private miiDoneAt = Infinity
  private scanning = false
  private scanValidAt = Infinity

  // Transmit, DMA.
  private tx: Tx | null = null
  private txPending = false
  private dmaDoneAt = Infinity
  private dmaApply: (() => void) | null = null
  private readonly sent: Uint8Array[] = []
  private sentCount = 0
  private receivedCount = 0
  private lastTx = { start: -Infinity, end: -Infinity }
  private lastRx = { start: -Infinity, end: -Infinity }

  // SPI.
  private phase: Phase = "idle"
  private bits = 0
  private shift = 0
  private arg = 0
  private bank = 0
  private dummy = false
  private outPending = false
  private outByte = 0
  private outBit = -1
  private lastSckRise = -Infinity

  private revision = REVISIONS.B7
  private revisionName = "B7"
  private ledbSinks = false
  private readonly warnings = new Map<string, number>()

  constructor(object: string, pins: Enc28j60Pins) {
    this.object = object
    this.p = pins
    this.pins = [pins.cs, pins.sck, pins.mosi, pins.miso, pins.int, pins.reset, pins.clkin]
    this.outputs = [pins.miso, pins.int]
    this.por(0)
  }

  // --- DigitalPart ---------------------------------------------------------------------------

  /** Props: revision B1/B4/B5/B7 (EREVID, [ERR] Table 1); ledb "source" (Netduino) or "sink" — PDPXMD at reset (§2.6). */
  configure(props: Record<string, string>) {
    const rev = props.revision?.toUpperCase()
    if (rev && rev in REVISIONS) {
      this.revision = REVISIONS[rev]
      this.revisionName = rev
    }
    if (props.ledb) this.ledbSinks = props.ledb === "sink"
  }

  /** Power-on state at loop time 0; the power switch and the clock stay as wired. */
  reset() {
    this.out.length = 0
    this.sent.length = 0
    this.sentCount = 0
    this.receivedCount = 0
    this.warnings.clear()
    this.cs = true
    this.sck = false
    this.mosi = false
    this.rstPin = true
    this.resetApplied = false
    this.lastClkRise = -Infinity
    this.lastSckRise = -Infinity
    this.cable = true
    this.now = 0
    this.clockSince = this.clockHz > 0 ? 0 : Infinity
    this.soDrive = null
    this.intDrive = this.powered ? true : null
    if (this.powered) this.por(0)
  }

  prime(levels: Map<string, boolean>) {
    for (const [pin, level] of levels) {
      if (pin === this.p.cs) this.cs = level
      else if (pin === this.p.sck) this.sck = level
      else if (pin === this.p.mosi) this.mosi = level
      else if (pin === this.p.reset) this.rstPin = level
    }
  }

  drive(pin: string): boolean | null {
    if (pin === this.p.miso) return this.soDrive
    if (pin === this.p.int) return this.intDrive
    return null
  }

  input(pin: string, level: boolean, time: number) {
    this.advance(time)
    if (pin === this.p.cs) {
      if (level === this.cs) return
      this.cs = level
      if (!level) this.spiBegin()
      else this.spiEnd(time)
    } else if (pin === this.p.sck) {
      if (level === this.sck) return
      this.sck = level
      if (!this.cs && this.alive()) {
        if (level) this.sckRise(time)
        else this.sckFall(time)
      }
    } else if (pin === this.p.mosi) {
      this.mosi = level
    } else if (pin === this.p.reset) {
      if (level === this.rstPin) return
      this.rstPin = level
      if (!level) {
        this.resetLowAt = time
        this.resetApplied = false
        this.phase = "skip"
        this.setSo(null, time)
      } else if (this.resetApplied) {
        // §11.2: the System Reset ends when RESET is released; the PHY restarts from here ([ERR] issue 2).
        this.phyReadyAt = time + OST_CYCLES / this.oscHz()
      }
    } else if (pin === this.p.clkin) {
      if (level && this.lastClkRise > -Infinity) {
        const hz = 1 / (time - this.lastClkRise)
        if (this.clockHz === 0 || Math.abs(hz - this.clockHz) / this.clockHz > 1e-3) this.setClock(hz, time)
      }
      if (level) this.lastClkRise = time
    }
    this.updateInt(time)
  }

  tick(time: number): boolean {
    this.advance(time)
    this.updateInt(time)
    return false
  }

  quietUntil() {
    return this.nextEvent()
  }

  snapshot(): Enc28j60Snapshot {
    return {
      powered: this.powered,
      clockHz: this.clockHz,
      clockReady: this.clkReady,
      revision: this.revisionName,
      link: this.linkUp(),
      packetsPending: this.regs[EPKTCNT],
      sent: this.sentCount,
      received: this.receivedCount,
      leds: this.leds(this.now),
      warnings: [...this.warnings.keys()],
    }
  }

  // --- Board / bench side --------------------------------------------------------------------

  /** Frames the chip transmitted (destination MAC first, no preamble/FCS), oldest first, since the last call. */
  takeTransmitted(): Uint8Array[] {
    return this.sent.splice(0)
  }

  /**
   * Hand the chip a frame from the wire. Without `fcs` the frame is destination..payload and the
   * chip sees a correct FCS after it; with `fcs: true` the last 4 bytes are the FCS as received.
   * Filters (§8), buffer write (§7.2.2), EPKTCNT/PKTIF (§7.2.1).
   */
  receive(frame: Uint8Array, opts: { fcs?: boolean; time?: number } = {}): void {
    const time = opts.time ?? this.now
    this.advance(time)
    this.receiveFrame(opts.fcs ? Array.from(frame) : [...frame, ...fcsBytes(frame)], time)
    this.updateInt(time)
  }

  /** Cable plugged in or not (PHSTAT1/2 link bits, PHIR.PLNKIF → LINKIF). Default: plugged. */
  setLink(up: boolean, time = this.now): void {
    this.advance(time)
    const before = this.linkUp()
    this.cable = up
    this.linkEvent(before, time)
  }

  /**
   * The clock on OSC1 (MCO1 PA8 on the Netduino Plus 2), 0 = none. Decision ([DS] silent on a
   * missing clock): the SPI host interface and the register file are clocked from OSC1 ([ERR]
   * issue 1 shows the SPI is synchronised to it), so without a clock SO stays high-impedance and
   * nothing is read or written. A clock that stops before the OST expires restarts it (§2.2 counts
   * OSC1 cycles). A clock outside 25 MHz ±50 ppm (Table 16-2) runs the logic but gets no link.
   */
  setClock(hz: number, time = this.now): void {
    this.advance(time)
    const was = this.clockHz > 0
    this.clockHz = hz > 0 ? hz : 0
    if (!was && hz > 0) this.clockSince = time
    if (hz <= 0) {
      this.clockSince = Infinity
      this.setSo(null, time)
    } else if (Math.abs(hz - F_OSC) / F_OSC > F_TOLERANCE)
      this.warn(`OSC1 at ${(hz / 1e6).toFixed(3)} MHz: the ENC28J60 needs 25 MHz ±50 ppm (Table 16-2); no Ethernet link`, time)
    this.updateInt(time)
  }

  /** VDD switched on (power-on reset, §11.1) or off (everything lost, pins released). */
  setPower(on: boolean, time = this.now): void {
    this.advance(time)
    if (on === this.powered) return
    this.powered = on
    if (on) this.por(time)
    else {
      this.clkReady = false
      this.tx = null
      this.txPending = false
      this.dmaApply = null
      this.dmaDoneAt = Infinity
      this.miiOp = null
      this.miiDoneAt = Infinity
      this.scanning = false
      this.phase = "idle"
      this.setSo(null, time)
    }
    this.updateInt(time)
  }

  /** Whether LEDA/LEDB are lit at `time`, per PHLCON (Register 2-2) and the stretch times of Table 2-1. LEDB is the Netduino's ACT. */
  leds(time = this.now): { a: boolean; b: boolean } {
    return { a: this.led((this.phlcon >> 8) & 0xf, time), b: this.led((this.phlcon >> 4) & 0xf, time) }
  }

  // --- Time ----------------------------------------------------------------------------------

  private oscHz() {
    return this.clockHz > 0 ? this.clockHz : F_OSC
  }

  private ostAt() {
    if (this.clkReady || !this.powered || this.pwrsv() || this.clockHz <= 0) return Infinity
    return Math.max(this.ostFrom, this.clockSince) + OST_CYCLES / this.clockHz
  }

  private resetAt() {
    return !this.rstPin && !this.resetApplied && this.powered ? this.resetLowAt + T_RSTLOW : Infinity
  }

  private nextEvent() {
    return Math.min(this.ostAt(), this.resetAt(), this.miiDoneAt, this.tx ? this.tx.doneAt : Infinity, this.dmaDoneAt)
  }

  /** Runs every scheduled event up to `t`, each at its own time. */
  private advance(t: number) {
    if (t < this.now) t = this.now
    for (let guard = 0; guard < 64; guard++) {
      const at = this.nextEvent()
      if (at > t) break
      this.now = at
      if (this.resetAt() <= at) {
        this.resetApplied = true
        this.systemReset(at, false)
      } else if (this.ostAt() <= at) {
        // §2.2: OST expired, CLKRDY set; a transmit requested meanwhile starts now.
        this.clkReady = true
        if (this.txPending && !(this.regs[ECON1] & TXRST)) this.startTx(at)
      } else if (this.miiDoneAt <= at) this.miiDone(at)
      else if (this.tx && this.tx.doneAt <= at) this.finishTx(at, false)
      else if (this.dmaDoneAt <= at) this.finishDma()
      this.updateInt(at)
    }
    this.now = t
  }

  // --- Resets ----------------------------------------------------------------------------------

  /** §11.1: all registers to reset values, CLKRDY 0, OST from now, buffer contents unknown. */
  private por(time: number) {
    this.systemReset(time, true)
    this.clkReady = false
    this.ostFrom = time
    this.phyReadyAt = time
    // Decision: "unknown" (§11.1) as a fixed pseudo-random fill, so firmware that relies on zeros shows it.
    let s = 0x9e3779b9
    for (let i = 0; i < this.object.length; i++) s = Math.imul(s ^ this.object.charCodeAt(i), 0x85ebca6b)
    for (let i = 0; i < this.mem.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      this.mem[i] = s >>> 24
    }
  }

  /** §11.2: registers to reset values; buffer kept; CLKRDY (Table 3-2 note 1) and ECOCON (note 3) kept unless POR. */
  private systemReset(time: number, por: boolean) {
    const ecocon = this.regs[ECOCON]
    const wasAsleep = this.pwrsv()
    this.regs.set(RESET)
    if (!por) this.regs[ECOCON] = ecocon
    this.rdptLow = this.regs[ERXRDPTL]
    this.rxWp = this.get16(ERXSTL)
    this.dropped = false
    this.phyReset()
    this.miiOp = null
    this.miiDoneAt = Infinity
    this.scanning = false
    this.scanValidAt = Infinity
    this.tx = null
    this.txPending = false
    this.dmaApply = null
    this.dmaDoneAt = Infinity
    this.phase = "skip"
    this.setSo(null, time)
    if (!por) {
      // [ERR] issue 2: after a reset command the PHY clock stops while CLKRDY stays set; the 300 µs
      // start-up may pass before the device is ready, so firmware waits 1 ms. Decision: the PHY is
      // unreachable (MIIM reads 0, writes lost) for one OST period, 7500 OSC1 cycles, after the reset.
      this.phyReadyAt = time + OST_CYCLES / this.oscHz()
      // Leaving power save through a reset (ECON2 = 80h) wakes the device: the OST runs again (§14).
      if (wasAsleep) this.ostFrom = time
    }
  }

  /** §11.5 / Table 3-3: PHY registers to their defaults. PDPXMD from the LEDB connection (§2.6). */
  private phyReset() {
    this.phcon1 = this.ledbSinks ? PDPXMD : 0
    this.phcon2 = 0
    this.phie = 0
    this.phlcon = 0x3422
    this.plnkif = false
    this.pgif = false
    this.llstat = false
  }

  // --- State helpers -------------------------------------------------------------------------

  private alive() {
    return this.powered && this.clockHz > 0 && this.rstPin
  }

  private pwrsv() {
    return (this.regs[ECON2] & PWRSV) !== 0
  }

  /** §2.2 and §14: MAC, MII and PHY registers are off limits before the OST expires and in power save. */
  private macReady() {
    return this.clkReady && !this.pwrsv()
  }

  private phyReady() {
    return this.macReady() && this.now >= this.phyReadyAt
  }

  private linkUp() {
    if (!this.powered || this.clockHz <= 0 || !this.phyReady() || !this.rstPin) return false
    if (this.phcon1 & PPWRSV || this.phcon2 & TXDIS) return false
    if (this.phcon2 & FRCLNK) return true
    return this.cable && Math.abs(this.clockHz - F_OSC) / F_OSC <= F_TOLERANCE
  }

  private get16(i: number) {
    return this.regs[i] | ((this.regs[i + 1] & 0x1f) << 8)
  }

  private set16(i: number, v: number) {
    this.regs[i] = v & 0xff
    this.regs[i + 1] = (v >> 8) & 0x1f
  }

  private warn(text: string, time: number) {
    if (!this.warnings.has(text)) this.warnings.set(text, time)
  }

  private setSo(level: boolean | null, time: number) {
    if (this.soDrive === level) return
    this.soDrive = level
    this.out.push({ pin: this.p.miso, level, time })
  }

  /** §12, Figure 12-1: INT low while an enabled flag is set and INTIE; INTIE = 0 drives it high (Register 12-2). */
  private updateInt(time: number) {
    let level: boolean | null = null
    if (this.powered) level = !((this.regs[EIE] & 0x80) !== 0 && this.pendingInt())
    if (this.intDrive === level) return
    this.intDrive = level
    this.out.push({ pin: this.p.int, level, time })
  }

  private pendingInt() {
    return (this.eir() & this.regs[EIE] & 0x7b) !== 0
  }

  /** EIR (Register 12-3): PKTIF mirrors EPKTCNT ≠ 0 (§12.1.7); LINKIF shadows PHIR.PGIF when PHIE enables it (§12.1.5). */
  private eir() {
    let v = this.regs[EIR] & EIR_STORED
    if (this.regs[EPKTCNT] > 0) v |= PKTIF
    if (this.pgif && (this.phie & (PLNKIE | PGEIE)) === (PLNKIE | PGEIE)) v |= LINKIF
    return v
  }

  // --- SPI (§4) ------------------------------------------------------------------------------

  private spiBegin() {
    this.phase = this.alive() ? "cmd" : "skip"
    this.bits = 0
    this.shift = 0
    this.outPending = false
    this.outBit = -1
  }

  /** CS high ends every command; a byte not complete is dropped (§4.2.3–4.2.6); SO back to high-Z (Figure 4-1). */
  private spiEnd(time: number) {
    this.phase = "idle"
    this.setSo(null, time)
  }

  /** §4.1: data is clocked in on the rising edge of SCK, MSb first. */
  private sckRise(time: number) {
    const period = time - this.lastSckRise
    if (period < 1 / F_SCK_MAX - 1e-12) this.warn(`SCK at ${(1 / period / 1e6).toFixed(1)} MHz: the ENC28J60 allows 20 MHz (Table 16-6)`, time)
    this.lastSckRise = time
    if (this.phase === "idle" || this.phase === "skip") return
    this.shift = ((this.shift << 1) | (this.mosi ? 1 : 0)) & 0xff
    if (++this.bits < 8) return
    this.bits = 0
    this.byteDone(this.shift, time, period)
  }

  /** §4.1: data is driven out on the falling edge of SCK. The first bit follows the falling edge after the command byte (Figures 4-3, 4-4). */
  private sckFall(time: number) {
    if (this.phase !== "rcr" && this.phase !== "rbm") return
    if (this.outPending) {
      this.outByte = this.loadOut()
      this.outBit = 7
      this.outPending = false
    } else this.outBit--
    this.setSo(this.outBit >= 0 ? ((this.outByte >> this.outBit) & 1) === 1 : false, time)
  }

  private loadOut(): number {
    if (this.phase === "rbm") return this.mem[this.get16(ERDPTL)]
    if (this.dummy) {
      // Figure 4-4: a dummy byte before MAC/MII data. Its value is not given; decision: 00h.
      this.dummy = false
      return 0x00
    }
    return this.readReg(idx(this.bank, this.arg))
  }

  private byteDone(b: number, time: number, period: number) {
    switch (this.phase) {
      case "cmd":
        return this.decode(b, time)
      case "rcr":
        // Decision ([DS] silent): further bytes repeat the register, read again each time, as RBM repeats ERDPT (§4.2.2).
        this.outPending = true
        return
      case "rbm":
        // §4.2.2: ERDPT advances after the last bit of each byte; ERXND wraps to ERXST, 1FFFh to 0000h.
        if (this.regs[ECON2] & AUTOINC) {
          const rd = this.get16(ERDPTL)
          this.set16(ERDPTL, rd === this.get16(ERXNDL) ? this.get16(ERXSTL) : (rd + 1) & 0x1fff)
        }
        this.outPending = true
        return
      case "wbm": {
        // §4.2.4: write at EWRPT, then EWRPT + 1 with AUTOINC, 1FFFh wrapping to 0000h; no receive-buffer wrap (§3.2.3).
        const wr = this.get16(EWRPTL)
        this.mem[wr] = b
        if (this.regs[ECON2] & AUTOINC) this.set16(EWRPTL, (wr + 1) & 0x1fff)
        return
      }
      case "wcr": {
        // Decision ([DS] silent): bytes after the first are written to the same register again.
        const i = idx(this.bank, this.arg)
        if (isMac(i)) this.checkMacSpi(period, time)
        return this.writeReg(i, b, time)
      }
      case "bfs":
      case "bfc": {
        // §4.2.5/4.2.6: ETH registers only; on a MAC/MII register the command does nothing (decision: the data sheet says it "cannot be used").
        const i = idx(this.bank, this.arg)
        if (isMac(i) || !DEFINED[i]) return
        const old = this.readReg(i)
        return this.writeReg(i, this.phase === "bfs" ? old | b : old & ~b & 0xff, time)
      }
    }
  }

  /** Table 4-1. */
  private decode(b: number, time: number) {
    const op = b >> 5
    this.arg = b & 0x1f
    this.bank = this.regs[ECON1] & 3
    switch (op) {
      case 0:
        this.phase = "rcr"
        this.dummy = isMac(idx(this.bank, this.arg))
        this.outPending = true
        return
      case 1:
        this.phase = this.arg === 0x1a ? "rbm" : "skip"
        this.outPending = this.phase === "rbm"
        return
      case 2:
        this.phase = "wcr"
        return
      case 3:
        this.phase = this.arg === 0x1a ? "wbm" : "skip"
        return
      case 4:
        this.phase = "bfs"
        return
      case 5:
        this.phase = "bfc"
        return
      case 7:
        this.phase = "skip"
        // §4.2.7: FFh is the System Reset Command; [ERR] issue 19: no effect in power save.
        if (this.arg === 0x1f && !this.pwrsv()) this.systemReset(time, false)
        return
      default:
        this.phase = "skip"
    }
  }

  private checkMacSpi(period: number, time: number) {
    if ((this.revisionName === "B1" || this.revisionName === "B4") && period > 1 / F_SCK_MAC_MIN_B1B4)
      this.warn(`MAC register written with SCK below 8 MHz: unreliable on silicon ${this.revisionName} ([ERR] issue 1)`, time)
  }

  // --- Control registers ---------------------------------------------------------------------

  private readReg(i: number): number {
    if (!DEFINED[i]) return 0
    if (isMac(i) && !this.macReady()) return 0
    switch (i) {
      case EIR:
        return this.eir()
      case ESTAT:
        // Register 12-1: INT is set while any enabled interrupt is pending (§12.1); CLKRDY is the OST (§2.2).
        return (this.regs[ESTAT] & ESTAT_STORED) | (this.pendingInt() ? 0x80 : 0) | (this.clkReady ? 0x01 : 0)
      case EFLOCON:
        return (this.regs[EFLOCON] & 0x03) | ((this.regs[MACON3] & 0x01) << 2)
      case EREVID:
        return this.revision
      case MISTAT: {
        // Register 3-4: BUSY while an MIIM operation runs, SCAN while scanning, NVALID until the first scan read.
        const busy = this.miiOp !== null || this.scanning
        return (busy ? 0x01 : 0) | (this.scanning ? 0x02 : 0) | (this.scanning && this.now < this.scanValidAt ? 0x04 : 0)
      }
      case MIRDL:
      case MIRDH:
        // §3.3.3: while scanning, MIRD is refreshed every 10.24 µs; read lazily as the current register.
        if (this.scanning && this.now >= this.scanValidAt) {
          const v = this.phyRead(this.regs[MIREGADR] & 0x1f)
          this.regs[MIRDL] = v & 0xff
          this.regs[MIRDH] = v >> 8
        }
        return this.regs[i]
    }
    return this.regs[i]
  }

  private writeReg(i: number, v: number, time: number) {
    if (!DEFINED[i]) return
    if (isMac(i) && !this.macReady()) return
    switch (i) {
      case EIR:
        // Register 12-3: DMAIF, TXIF, TXERIF, RXERIF are clear-only; PKTIF and LINKIF read-only.
        this.regs[EIR] &= v | ~EIR_STORED
        return
      case ESTAT:
        // Register 12-1: BUFER, LATECOL, TXABRT clear-only. Decision: CLKRDY (marked R/W) reflects the OST and ignores writes.
        this.regs[ESTAT] &= v | ~ESTAT_STORED
        return
      case ECON1:
        return this.writeEcon1(v, time)
      case ECON2:
        return this.writeEcon2(v, time)
      case ERXRDPTL:
        // §7.2.4: the low byte waits in a buffer until ERXRDPTH is written.
        this.rdptLow = v
        return
      case ERXRDPTH: {
        this.regs[ERXRDPTL] = this.rdptLow
        this.regs[ERXRDPTH] = v & 0x1f
        const rd = this.get16(ERXRDPTL)
        if ((rd & 1) === 0) this.warn(`ERXRDPT = ${hex4(rd)} is even: the receive hardware may corrupt the buffer ([ERR] issue 14); write odd values`, time)
        return
      }
      case ERXSTL:
      case ERXSTL + 1:
      case ERXNDL:
      case ERXNDL + 1: {
        this.regs[i] = v & WRITABLE[i]
        // §6.1: writing ERXST or ERXND loads the internal write pointer with ERXST.
        this.rxWp = this.get16(ERXSTL)
        if (this.regs[ECON1] & RXEN) this.warn("ERXST/ERXND changed while RXEN is set: not allowed (§3.2.1)", time)
        return
      }
      case MICMD:
        return this.writeMicmd(v, time)
      case MIWRH:
        this.regs[MIWRH] = v
        // §3.3.2: writing MIWRH starts the MIIM write; BUSY for 10.24 µs.
        if (this.miiOp || this.scanning) this.warn("MIWRH written while MII busy (§3.3.2)", time)
        this.miiOp = "write"
        this.miiDoneAt = time + MIIM_CYCLES / this.oscHz()
        return
    }
    this.regs[i] = (this.regs[i] & ~WRITABLE[i]) | (v & WRITABLE[i])
  }

  private writeEcon1(v: number, time: number) {
    const old = this.regs[ECON1]
    let nv = v & 0xff
    // §11.4: setting RXRST clears RXEN.
    if (nv & RXRST) nv &= ~RXEN
    this.regs[ECON1] = nv
    const rose = nv & ~old
    const fell = old & ~nv
    if (rose & TXRST) {
      // §11.3: a Transmit Only Reset clears TXRTS and aborts. TXIF: TXRTS went 1 → 0 (§12.1.4). Decision: no TSV, the transmit logic is in reset.
      if (this.tx || this.txPending) {
        this.tx = null
        this.txPending = false
        this.regs[ECON1] &= ~TXRTS
        this.regs[EIR] |= TXIF
      }
    }
    if (rose & TXRTS) {
      // §2.2: no transmit before CLKRDY; decision: the request waits (TXRTS is an ETH bit, kept) and starts when the OST expires.
      // Decision: with TXRST held the request likewise waits until TXRST is cleared.
      if (this.macReady() && !(nv & TXRST)) this.startTx(time)
      else this.txPending = true
    } else if (fell & TXRTS && !(rose & TXRST)) {
      // §7.1: the host clears TXRTS to cancel: TSV written, TXIF set; nothing more goes out.
      if (this.tx) this.finishTx(time, true)
      else if (this.txPending) {
        this.txPending = false
        this.regs[EIR] |= TXIF
      }
    }
    if (fell & TXRST && nv & TXRTS && this.txPending && this.macReady()) this.startTx(time)
    if (rose & RXEN) {
      // Checked when reception starts, not per byte: ERXST is written one byte at a time.
      const st = this.get16(ERXSTL)
      if (st !== 0) this.warn(`ERXST = ${hex4(st)}: the receive buffer must start at 0000h ([ERR] issue 5), the write pointer may be loaded with 0000h`, time)
    }
    if (rose & DMAST) this.startDma(time)
    else if (fell & DMAST && this.dmaApply) {
      // §13 / §12.1.6: cancelling the DMA sets DMAIF; no registers change.
      this.dmaApply = null
      this.dmaDoneAt = Infinity
      this.regs[EIR] |= DMAIF
    }
  }

  private writeEcon2(v: number, time: number) {
    const old = this.regs[ECON2]
    // Register 3-2 note 1 / §7.2.4: PKTDEC decrements EPKTCNT (never below 0) and clears itself.
    if (v & PKTDEC && this.regs[EPKTCNT] > 0) this.regs[EPKTCNT]--
    this.regs[ECON2] = v & WRITABLE[ECON2]
    if (!(old & PWRSV) && v & PWRSV) {
      // §14 step 5: power save clears CLKRDY; MAC/MII/PHY become inaccessible.
      this.clkReady = false
      this.tx = null
      this.miiOp = null
      this.miiDoneAt = Infinity
      this.scanning = false
    } else if (old & PWRSV && !(v & PWRSV)) {
      // §2.2 / §14: wake-up restarts the OST.
      this.ostFrom = time
    }
  }

  // --- MII (§3.3) ----------------------------------------------------------------------------

  private writeMicmd(v: number, time: number) {
    const old = this.regs[MICMD]
    this.regs[MICMD] = v & 0x03
    const period = MIIM_CYCLES / this.oscHz()
    if (v & 0x01 && !(old & 0x01)) {
      // §3.3.1: MIIRD starts one read; BUSY until MIRD is loaded 10.24 µs later.
      this.miiOp = "read"
      this.miiDoneAt = time + period
    }
    if (v & 0x02 && !(old & 0x02)) {
      // §3.3.3: MIISCAN: BUSY and SCAN, NVALID until the first read completes after 10.24 µs.
      this.scanning = true
      this.scanValidAt = time + period
    } else if (!(v & 0x02) && old & 0x02 && this.scanning) {
      // §3.3.3: clearing MIISCAN cancels; BUSY clears when the read in flight ends.
      this.scanning = false
      this.miiOp = "scan"
      const k = Math.max(1, Math.ceil((time - (this.scanValidAt - period)) / period))
      this.miiDoneAt = this.scanValidAt - period + k * period
    }
  }

  private miiDone(at: number) {
    const op = this.miiOp
    this.miiOp = null
    this.miiDoneAt = Infinity
    const reg = this.regs[MIREGADR] & 0x1f
    if (op === "read") {
      const v = this.phyRead(reg)
      this.regs[MIRDL] = v & 0xff
      this.regs[MIRDH] = v >> 8
    } else if (op === "write") this.phyWrite(reg, this.regs[MIWRL] | (this.regs[MIWRH] << 8), at)
  }

  /** Table 3-3. */
  private phyRead(a: number): number {
    if (!this.phyReady()) return 0
    switch (a) {
      case PHCON1:
        return this.phcon1
      case PHSTAT1: {
        // Register 3-5: PFDPX, PHDPX always 1; LLSTAT latches low while the link is down, re-arms when read.
        const v = 0x1800 | (this.llstat ? 0x0004 : 0)
        this.llstat = this.linkUp()
        return v
      }
      case PHID1:
        return 0x0083
      case PHID2:
        return 0x1400
      case PHCON2:
        return this.phcon2
      case PHSTAT2: {
        // Register 3-6: TXSTAT while transmitting, LSTAT, DPXSTAT = PHCON1.PDPXMD.
        const txing = this.tx !== null && this.now < this.tx.doneAt
        return (txing ? 0x2000 : 0) | (this.linkUp() ? 0x0400 : 0) | (this.phcon1 & PDPXMD ? 0x0200 : 0)
      }
      case PHIE:
        return this.phie
      case PHIR: {
        // Register 12-5: PLNKIF and PGIF clear when PHIR is read; LINKIF follows PGIF (§12.1.5).
        const v = (this.plnkif ? 0x0010 : 0) | (this.pgif ? 0x0004 : 0)
        this.plnkif = false
        this.pgif = false
        return v
      }
      case PHLCON:
        return this.phlcon
    }
    return 0
  }

  private phyWrite(a: number, v: number, time: number) {
    if (!this.phyReady()) return
    const before = this.linkUp()
    switch (a) {
      case PHCON1:
        // §11.5: PRST resets the PHY registers and clears itself. Decision: done by the end of the 10.24 µs MIIM write.
        if (v & PRST) this.phyReset()
        else this.phcon1 = v & 0x4d80
        break
      case PHCON2:
        this.phcon2 = v & 0x7fff
        break
      case PHIE:
        // Register 12-4: only bits 5, 4, 1, 0 are writable.
        this.phie = v & 0x0033
        break
      case PHLCON:
        this.phlcon = v & 0xffff
        break
    }
    this.linkEvent(before, time)
    const fd = (this.regs[MACON3] & 1) !== 0
    if (fd !== ((this.phcon1 & PDPXMD) !== 0)) this.warn("MACON3.FULDPX and PHCON1.PDPXMD differ: the duplex is indeterminate (§9)", time)
  }

  /** A link change sets PLNKIF, and PGIF when PHIE enables it (Register 12-5, §12.1.5); LLSTAT latches low (Register 3-5). */
  private linkEvent(before: boolean, time: number) {
    const after = this.linkUp()
    if (after === before) return
    this.plnkif = true
    if ((this.phie & (PLNKIE | PGEIE)) === (PLNKIE | PGEIE)) this.pgif = true
    if (!after) this.llstat = false
    this.updateInt(time)
  }

  // --- Transmit (§7.1) -----------------------------------------------------------------------

  private startTx(time: number) {
    this.txPending = false
    const st = this.get16(ETXSTL)
    const nd = this.get16(ETXNDL)
    const count = ((nd - st) & 0x1fff) + 1
    // Figure 7-2: the per-packet control byte at ETXST, the frame up to and including ETXND.
    const control = this.mem[st]
    const raw: number[] = []
    for (let k = 1; k < count; k++) raw.push(this.mem[(st + k) & 0x1fff])
    const macon3 = this.regs[MACON3]
    let pad: number
    let crc: boolean
    let huge: boolean
    if (control & 0x01) {
      // Figure 7-1: POVERRIDE: PPADEN pads to 60, PCRCEN appends the CRC, PHUGEEN lifts MAMXFL.
      pad = control & 0x04 ? 60 : 0
      crc = (control & 0x02) !== 0
      huge = (control & 0x08) !== 0
    } else {
      // Register 6-2: PADCFG 001 → 60, x11 → 64, 101 → 64 for VLAN (8100h) else 60, others none; TXCRCEN appends the CRC.
      const padcfg = macon3 >> 5
      const vlan = raw[12] === 0x81 && raw[13] === 0x00
      pad = [0, 60, 0, 64, 0, vlan ? 64 : 60, 0, 64][padcfg]
      crc = (macon3 & 0x10) !== 0
      huge = (macon3 & 0x04) !== 0
    }
    const body = crc ? raw.slice() : raw.slice(0, Math.max(0, raw.length - 4))
    while (crc && body.length < pad) body.push(0)
    let wire: number[]
    let crcErr = false
    if (crc) wire = [...body, ...fcsBytes(body)]
    else {
      // Register 6-2 / Figure 7-1: without CRC generation the last 4 bytes are checked as the FCS.
      wire = raw.slice()
      crcErr = !fcsValid(wire)
    }
    const maxLen = this.regs[MAMXFLL] | (this.regs[MAMXFLL + 1] << 8)
    // Register 6-2 HFRMEN / §12.1.3 condition 5: longer than MAMXFL without huge frames is aborted after MAMXFL bytes.
    const giant = !huge && wire.length > maxLen
    const onWire = giant ? maxLen : wire.length
    const duration = (PREAMBLE + onWire) * BYTE_TIME
    const tsv = this.statusVector(wire, raw.length - (crc ? 0 : 4), onWire, crcErr, giant)
    this.tx = { doneAt: time + duration, frame: giant ? null : Uint8Array.from(body), tsv, abort: giant }
    this.lastTx = { start: time, end: time + duration }
    const fd = (macon3 & 1) !== 0
    if (fd !== ((this.phcon1 & PDPXMD) !== 0)) this.warn("MACON3.FULDPX and PHCON1.PDPXMD differ: the duplex is indeterminate (§9)", time)
  }

  /** Table 7-1. */
  private statusVector(wire: number[], unpadded: number, onWire: number, crcErr: boolean, giant: boolean): number[] {
    const type = (wire[12] << 8) | wire[13]
    const bcast = wire.slice(0, 6).every((b) => b === 0xff)
    const mcast = (wire[0] & 1) === 1 && !bcast
    const control = type === 0x8808
    let lo = onWire & 0xffff
    if (crcErr) lo |= 1 << 20
    if (this.regs[MACON3] & 0x02 && this.lengthMismatch(type, unpadded - 14)) lo |= 1 << 21
    if (type > 1500) lo |= 1 << 22
    if (!giant) lo |= 1 << 23
    if (mcast) lo |= 1 << 24
    if (bcast) lo |= 1 << 25
    if (giant) lo |= 1 << 30
    let hi = onWire & 0xffff
    if (control) hi |= 1 << 16
    if (control && wire[14] === 0x00 && wire[15] === 0x01) hi |= 1 << 17
    if (type === 0x8100) hi |= 1 << 19
    return [lo & 0xff, (lo >>> 8) & 0xff, (lo >>> 16) & 0xff, (lo >>> 24) & 0xff, hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff]
  }

  /** Register 6-2 FRMLNEN: a length field (≤ 1500) that disagrees with the data; padding (46-byte minimum payload) may follow a shorter length. */
  private lengthMismatch(field: number, payload: number) {
    if (field > 1500) return false
    return field > payload || (payload > 46 && field !== payload)
  }

  /** §7.1: TXRTS cleared, TSV at ETXND + 1, TXIF; on abort TXABRT and TXERIF too (§12.1.3). */
  private finishTx(at: number, cancelled: boolean) {
    const tx = this.tx
    if (!tx) return
    this.tx = null
    if (cancelled) tx.tsv[2] &= ~0x80 // not "Transmit Done"
    const nd = this.get16(ETXNDL)
    tx.tsv.forEach((b, k) => (this.mem[(nd + 1 + k) & 0x1fff] = b))
    this.regs[ECON1] &= ~TXRTS
    this.regs[EIR] |= TXIF
    if (tx.abort) {
      this.regs[ESTAT] |= TXABRT
      this.regs[EIR] |= TXERIF
    }
    if (cancelled) this.lastTx.end = at
    // Decision: with no link the MAC still completes (it sees no carrier, so no deferral), the frame is lost.
    if (!cancelled && !tx.abort && tx.frame && this.linkUp()) {
      this.sent.push(tx.frame)
      this.sentCount++
    }
  }

  // --- Receive (§7.2, §8) --------------------------------------------------------------------

  private receiveFrame(bytes: number[], time: number) {
    if (!this.alive() || !this.linkUp()) return
    this.lastRx = { start: time, end: time + (PREAMBLE + bytes.length) * BYTE_TIME }
    const econ1 = this.regs[ECON1]
    // Register 3-1 RXEN, §11.4 RXRST, Register 6-1 MARXEN.
    if (!(econ1 & RXEN) || econ1 & RXRST || !(this.regs[MACON1] & 0x01)) return
    const len = bytes.length
    // §5.1.6: frames under 18 bytes are rejected outright.
    if (len < 18) return
    const maxLen = this.regs[MAMXFLL] | (this.regs[MAMXFLL + 1] << 8)
    // Register 6-2 HFRMEN: longer than MAMXFL is aborted. Decision: counted as a dropped packet (RSV bit 16).
    if (!(this.regs[MACON3] & 0x04) && len > maxLen) {
      this.dropped = true
      return
    }
    const crcOk = fcsValid(bytes)
    if (!this.accept(bytes, crcOk)) return
    const type = (bytes[12] << 8) | bytes[13]
    // Register 6-1 PASSALL = 0: control frames are consumed by the MAC, not written.
    if (type === 0x8808 && !(this.regs[MACON1] & 0x02)) return
    // §7.2.4: at EPKTCNT = 255, and §7.2.4/§12.1.2 when the ring has no room, the packet is aborted with RXERIF.
    const st = this.get16(ERXSTL)
    const size = ((this.get16(ERXNDL) - st) & 0x1fff) + 1
    const wi = ((this.rxWp - st) & 0x1fff) % size
    const ri = ((this.get16(ERXRDPTL) - st) & 0x1fff) % size
    const n = 6 + len
    const adv = n + (n & 1)
    // §7.2.5: the write pointer may never land on ERXRDPT, so one byte always stays free (Example 7-2).
    const free = (ri - wi - 1 + size) % size
    if (this.regs[EPKTCNT] === 255 || adv > free) {
      this.regs[EIR] |= RXERIF
      this.dropped = true
      return
    }
    const at = (k: number) => (st + ((wi + k) % size)) & 0x1fff
    const next = at(adv)
    const rsv = this.receiveStatus(bytes, crcOk)
    // Figure 7-3: next packet pointer, the receive status vector, then the frame with its FCS.
    const head = [next & 0xff, next >> 8, ...rsv]
    head.forEach((b, k) => (this.mem[at(k)] = b))
    bytes.forEach((b, k) => (this.mem[at(6 + k)] = b))
    // §7.2.2: an odd end is padded so packets start even; ERXWRPT follows (§3.2.1); EPKTCNT + 1, PKTIF (§7.2.1).
    this.rxWp = next
    this.set16(ERXWRPTL, next)
    this.regs[EPKTCNT]++
    this.dropped = false
    this.receivedCount++
  }

  /** Table 7-3. */
  private receiveStatus(bytes: number[], crcOk: boolean): number[] {
    const type = (bytes[12] << 8) | bytes[13]
    const bcast = bytes.slice(0, 6).every((b) => b === 0xff)
    // Decision: "Multicast" for group addresses other than broadcast, which has its own bit.
    const mcast = (bytes[0] & 1) === 1 && !bcast
    const control = type === 0x8808
    const pause = control && bytes[14] === 0x00 && bytes[15] === 0x01
    const pauseDest = [0x01, 0x80, 0xc2, 0x00, 0x00, 0x01].every((b, k) => bytes[k] === b)
    let v = bytes.length & 0xffff
    if (this.dropped) v |= 1 << 16
    if (!crcOk) v |= 1 << 20
    if (this.regs[MACON3] & 0x02 && this.lengthMismatch(type, bytes.length - 18)) v |= 1 << 21
    if (type > 1500) v |= 1 << 22
    if (crcOk) v |= 1 << 23
    if (mcast) v |= 1 << 24
    if (bcast) v |= 1 << 25
    if (control) v |= 1 << 27
    if (pause && pauseDest) v |= 1 << 28
    if (control && !pause) v |= 1 << 29
    if (type === 0x8100) v |= 1 << 30
    return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
  }

  /** Figure 8-1 (OR) and Figure 8-2 (AND), then the post-filter CRC check (Register 8-1 CRCEN). */
  private accept(bytes: number[], crcOk: boolean): boolean {
    const f = this.regs[ERXFCON]
    const filters: [number, () => boolean][] = [
      [0x80, () => this.isUnicast(bytes)],
      [0x10, () => this.patternMatch(bytes)],
      [0x08, () => this.isMagic(bytes)],
      [0x04, () => this.hashMatch(bytes)],
      [0x02, () => (bytes[0] & 1) === 1], // §8.5
      [0x01, () => bytes.slice(0, 6).every((b) => b === 0xff)], // §8.6
    ]
    const on = filters.filter(([bit]) => f & bit)
    let pass: boolean
    if (f & 0x40) pass = on.every(([, test]) => test())
    else if (on.length === 0) pass = true // promiscuous (§8)
    else {
      pass = on.some(([, test]) => test())
      // [ERR] issue 18: OR mode with PMEN and another filter takes frames up to 64 + EPMO bytes that meet nothing.
      const epmo = this.get16(EPMOL)
      if (!pass && f & 0x10 && on.length > 1 && bytes.length <= 64 + epmo) pass = true
    }
    if (pass && f & 0x20 && !crcOk) pass = false
    return pass
  }

  private mac(): number[] {
    // Table 3-1: MAADR1 (first byte on the wire) at bank 3 04h … MAADR6 at 01h.
    return [B3 + 4, B3 + 5, B3 + 2, B3 + 3, B3 + 0, B3 + 1].map((i) => this.regs[i])
  }

  /** §8.1. */
  private isUnicast(bytes: number[]) {
    const mac = this.mac()
    return mac.every((b, k) => bytes[k] === b)
  }

  /** §8.2 / Figure 8-3: masked bytes of the 64-byte window at EPMO, IP checksum against EPMCS; a window past the FCS never matches. */
  private patternMatch(bytes: number[]) {
    const epmo = this.get16(EPMOL)
    if (epmo + 64 > bytes.length) return false
    const sel: number[] = []
    for (let k = 0; k < 64; k++) if (this.regs[EPMM0 + (k >> 3)] & (1 << (k & 7))) sel.push(bytes[epmo + k])
    const want = this.regs[EPMCSL] | (this.regs[EPMCSL + 1] << 8)
    return ipChecksum(sel) === want
  }

  /** §8.3 / Figure 8-4: destination is MAADR and the data holds FFh × 6 then MAADR × 16 somewhere. */
  private isMagic(bytes: number[]) {
    if (!this.isUnicast(bytes)) return false
    const mac = this.mac()
    const pattern = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    for (let k = 0; k < 16; k++) pattern.push(...mac)
    const end = bytes.length - 4
    for (let s = 14; s + pattern.length <= end; s++) if (pattern.every((b, k) => bytes[s + k] === b)) return true
    return false
  }

  /**
   * §8.4: a CRC over the destination picks one of the 64 EHT bits. All clear never matches, all set
   * always does (as the data sheet says). Which 6 CRC bits form the pointer is not in [DS]; decision:
   * bits 28:23 of the FCS CRC, as Microchip's TCP/IP stack driver computes it.
   */
  private hashMatch(bytes: number[]) {
    const ptr = (crc32(bytes, 0, 6) >>> 23) & 0x3f
    return (this.regs[EHT0 + (ptr >> 3)] & (1 << (ptr & 7))) !== 0
  }

  // --- DMA (§13) -----------------------------------------------------------------------------

  private startDma(time: number) {
    const st = this.get16(EDMASTL)
    const nd = this.get16(EDMANDL)
    const rxSt = this.get16(ERXSTL)
    const rxNd = this.get16(ERXNDL)
    const csum = (this.regs[ECON1] & CSUMEN) !== 0
    // §13: the source pointer follows the receive ring (ERXND → ERXST) and stops at EDMAND.
    const src: number[] = []
    let p = st
    for (let guard = 0; guard <= 8192; guard++) {
      src.push(p)
      if (p === nd) break
      p = p === rxNd ? rxSt : (p + 1) & 0x1fff
    }
    const endless = src[src.length - 1] !== nd || (!csum && st === nd)
    if (endless) {
      // §13 notes 1 and 2: an unreachable EDMAND, or a one-byte copy, never ends.
      this.warn("DMA cannot reach EDMAND (or copies one byte): it never ends (§13 notes 1, 2)", time)
      this.dmaApply = () => {}
      this.dmaDoneAt = Infinity
      return
    }
    const hz = this.oscHz()
    if (csum) {
      // §13.2: one main clock per byte; the result goes to EDMACSH:EDMACSL.
      this.dmaDoneAt = time + src.length / hz
      this.dmaApply = () => {
        const sum = ipChecksum(src.map((a) => this.mem[a]))
        this.regs[EDMACSL] = sum & 0xff
        this.regs[EDMACSL + 1] = sum >> 8
      }
    } else {
      // §13.1: two main clocks per byte; the destination is linear, wrapping only 1FFFh → 0000h.
      const dst = this.get16(EDMADSTL)
      this.dmaDoneAt = time + (2 * src.length) / hz
      this.dmaApply = () => {
        const data = src.map((a) => this.mem[a])
        data.forEach((b, k) => (this.mem[(dst + k) & 0x1fff] = b))
      }
    }
  }

  /** §13.1/13.2: DMAST cleared, DMAIF set. */
  private finishDma() {
    this.dmaApply?.()
    this.dmaApply = null
    this.dmaDoneAt = Infinity
    this.regs[ECON1] &= ~DMAST
    this.regs[EIR] |= DMAIF
  }

  // --- LEDs (§2.6, Register 2-2) -------------------------------------------------------------

  private led(cfg: number, t: number): boolean {
    if (!this.powered || this.clockHz <= 0) return false
    const stretch = STRETCH[(this.phlcon >> 2) & 3]
    const stretchable = (this.phlcon & 0x02) !== 0
    const active = (ev: { start: number; end: number }, always: boolean) => t >= ev.start && t < ev.end + (always || stretchable ? stretch : 0)
    const link = this.linkUp()
    const duplex = (this.phcon1 & PDPXMD) !== 0
    switch (cfg) {
      case 0x1:
        return active(this.lastTx, false)
      case 0x2:
        return active(this.lastRx, false)
      case 0x3:
        return false // no collisions are modelled
      case 0x4:
        return link
      case 0x5:
        return duplex
      case 0x7:
        return active(this.lastTx, false) || active(this.lastRx, false)
      case 0x8:
        return true
      case 0x9:
        return false
      case 0xa:
      case 0xb:
        return true // blink rates not documented (NOT_MODELLED)
      case 0xc:
        // Decision: "link status and receive activity": lit with link, dark while activity is shown.
        return link && !active(this.lastRx, true)
      case 0xd:
        return link && !(active(this.lastTx, true) || active(this.lastRx, true))
      case 0xe:
        // [ERR] issue 11: the combined duplex/collision mode shows the duplex status only.
        return duplex
    }
    return false
  }
}

const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, "0") + "h"
