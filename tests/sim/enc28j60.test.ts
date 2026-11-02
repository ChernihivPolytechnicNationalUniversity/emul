/**
 * ENC28J60 (Netduino Plus 2, U5), driven pin by pin as the STM32's SPI1 would: SCK PA5, MOSI PA7,
 * MISO PB4, CS PC8, INT PA4, RESET PD2, OSC1 from MCO1 PA8. Expected values come from Microchip
 * DS39662E (section/table/figure noted per test) and the silicon errata DS80349C.
 */
import { describe, expect, it } from "vitest"
import { Enc28j60, NOT_MODELLED } from "@/sim/enc28j60"

const P = { cs: "PC8", sck: "PA5", mosi: "PA7", miso: "PB4", int: "PA4", reset: "PD2", clkin: "PA8" }
/** Half an SCK period: 10 MHz SPI. */
const HALF = 50e-9

type Reg = { bank: number; addr: number; mac?: boolean }
const r = (bank: number, addr: number, mac = false): Reg => ({ bank, addr, mac })
// Table 3-1. MAC/MII registers (bank 2, MAADR and MISTAT in bank 3) answer RCR after a dummy byte (§4.2.1).
const REG = {
  ERDPTL: r(0, 0x00), ERDPTH: r(0, 0x01), EWRPTL: r(0, 0x02), EWRPTH: r(0, 0x03),
  ETXSTL: r(0, 0x04), ETXSTH: r(0, 0x05), ETXNDL: r(0, 0x06), ETXNDH: r(0, 0x07),
  ERXSTL: r(0, 0x08), ERXSTH: r(0, 0x09), ERXNDL: r(0, 0x0a), ERXNDH: r(0, 0x0b),
  ERXRDPTL: r(0, 0x0c), ERXRDPTH: r(0, 0x0d), ERXWRPTL: r(0, 0x0e), ERXWRPTH: r(0, 0x0f),
  EDMASTL: r(0, 0x10), EDMANDL: r(0, 0x12), EDMADSTL: r(0, 0x14), EDMACSL: r(0, 0x16), EDMACSH: r(0, 0x17),
  EHT0: r(1, 0x00), EPMM0: r(1, 0x08), EPMM1: r(1, 0x09), EPMCSL: r(1, 0x10), EPMCSH: r(1, 0x11),
  EPMOL: r(1, 0x14), EPMOH: r(1, 0x15), ERXFCON: r(1, 0x18), EPKTCNT: r(1, 0x19),
  MACON1: r(2, 0x00, true), MACON3: r(2, 0x02, true), MACON4: r(2, 0x03, true), MABBIPG: r(2, 0x04, true),
  MACLCON1: r(2, 0x08, true), MACLCON2: r(2, 0x09, true), MAMXFLL: r(2, 0x0a, true), MAMXFLH: r(2, 0x0b, true),
  MICMD: r(2, 0x12, true), MIREGADR: r(2, 0x14, true), MIWRL: r(2, 0x16, true), MIWRH: r(2, 0x17, true),
  MIRDL: r(2, 0x18, true), MIRDH: r(2, 0x19, true),
  MAADR5: r(3, 0x00, true), MAADR6: r(3, 0x01, true), MAADR3: r(3, 0x02, true), MAADR4: r(3, 0x03, true),
  MAADR1: r(3, 0x04, true), MAADR2: r(3, 0x05, true), MISTAT: r(3, 0x0a, true), EREVID: r(3, 0x12),
  ECOCON: r(3, 0x15), EFLOCON: r(3, 0x17), EPAUSL: r(3, 0x18), EPAUSH: r(3, 0x19),
  EIE: r(-1, 0x1b), EIR: r(-1, 0x1c), ESTAT: r(-1, 0x1d), ECON2: r(-1, 0x1e), ECON1: r(-1, 0x1f),
} as const

// EIE/EIR bits (Registers 12-2, 12-3), ECON1/ECON2 (Registers 3-1, 3-2).
const INTIE = 0x80, PKTIE = 0x40, TXIE = 0x08
const PKTIF = 0x40, DMAIF = 0x20, LINKIF = 0x10, TXIF = 0x08, TXERIF = 0x02, RXERIF = 0x01
const TXRST = 0x80, DMAST = 0x20, CSUMEN = 0x10, TXRTS = 0x08, RXEN = 0x04
const AUTOINC = 0x80, PKTDEC = 0x40, PWRSV = 0x20
const CLKRDY = 0x01, TXABRT = 0x02

const MAC = [0x02, 0x00, 0x5e, 0x10, 0x20, 0x30]
const OTHER = [0x02, 0x11, 0x22, 0x33, 0x44, 0x55]
const BCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]

/** IEEE 802.3 CRC-32 (reflected 0xEDB88320), the reference the FCS is checked against. */
function crc32(bytes: ArrayLike<number>): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}
/** The FCS as it goes on the wire and into the receive buffer, least significant byte first. */
const fcs = (bytes: number[]) => {
  const c = crc32(bytes)
  return [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24]
}

/** A frame without FCS: destination, source, type/length, payload. */
function frame(dest: number[], type: number, payloadLen: number, src = OTHER): number[] {
  const payload = Array.from({ length: payloadLen }, (_, i) => (i * 7 + 3) & 0xff)
  return [...dest, ...src, type >> 8, type & 0xff, ...payload]
}

class Host {
  t = 0
  readonly m: Enc28j60
  constructor(opts: { clock?: number } = {}) {
    this.m = new Enc28j60("U5", P)
    this.m.reset()
    if ((opts.clock ?? 25e6) > 0) this.m.setClock(opts.clock ?? 25e6, 0)
  }
  pin(name: string, level: boolean) {
    this.t += HALF
    this.m.input(name, level, this.t)
  }
  wait(s: number) {
    this.t += s
    this.m.tick(this.t)
  }
  /** Past the oscillator start-up timer and errata 2's 1 ms. */
  ready() {
    this.wait(1.1e-3)
    return this
  }
  /** One CS-framed SPI mode-0 transfer. SO sampled on SCK rising; an undriven SO reads 1 (pull-up). */
  xfer(bytes: number[]): { rx: number[]; driven: boolean[] } {
    this.pin(P.cs, false)
    const rx: number[] = []
    const driven: boolean[] = []
    for (const b of bytes) {
      let v = 0
      let d = false
      for (let i = 7; i >= 0; i--) {
        this.m.input(P.mosi, ((b >> i) & 1) === 1, this.t)
        this.pin(P.sck, true)
        const so = this.m.drive(P.miso)
        if (so !== null) d = true
        v = (v << 1) | (so === false ? 0 : 1)
        this.pin(P.sck, false)
      }
      rx.push(v)
      driven.push(d)
    }
    this.pin(P.cs, true)
    return { rx, driven }
  }
  bank(b: number) {
    if (b < 0) return
    this.xfer([0xa0 | 0x1f, 0x03])
    if (b) this.xfer([0x80 | 0x1f, b])
  }
  read(reg: Reg): number {
    this.bank(reg.bank)
    return reg.mac ? this.xfer([reg.addr, 0, 0]).rx[2] : this.xfer([reg.addr, 0]).rx[1]
  }
  write(reg: Reg, v: number) {
    this.bank(reg.bank)
    this.xfer([0x40 | reg.addr, v])
  }
  bfs(reg: Reg, v: number) {
    this.bank(reg.bank)
    this.xfer([0x80 | reg.addr, v])
  }
  bfc(reg: Reg, v: number) {
    this.bank(reg.bank)
    this.xfer([0xa0 | reg.addr, v])
  }
  /** A pointer pair, low byte then high (§6.1: ERXRDPT needs L first). */
  write16(low: Reg, v: number) {
    this.write(low, v & 0xff)
    this.write({ ...low, addr: low.addr + 1 }, v >> 8)
  }
  read16(low: Reg) {
    return this.read(low) | (this.read({ ...low, addr: low.addr + 1 }) << 8)
  }
  src() {
    this.xfer([0xff])
  }
  wbm(bytes: number[]) {
    this.xfer([0x7a, ...bytes])
  }
  rbm(n: number) {
    return this.xfer([0x3a, ...new Array(n).fill(0)]).rx.slice(1)
  }
  rbmAt(addr: number, n: number) {
    this.write16(REG.ERDPTL, addr)
    return this.rbm(n)
  }
  /** §3.3.1: MIREGADR, MICMD.MIIRD, wait 10.24 µs, poll BUSY, clear MIIRD, read MIRD. */
  phyRead(a: number) {
    this.write(REG.MIREGADR, a)
    this.write(REG.MICMD, 0x01)
    this.wait(11e-6)
    expect(this.read(REG.MISTAT) & 1, "MISTAT.BUSY after 10.24 µs").toBe(0)
    this.write(REG.MICMD, 0x00)
    return this.read(REG.MIRDL) | (this.read(REG.MIRDH) << 8)
  }
  /** §3.3.2: MIREGADR, MIWRL, MIWRH (starts the write), BUSY for 10.24 µs. */
  phyWrite(a: number, v: number) {
    this.write(REG.MIREGADR, a)
    this.write(REG.MIWRL, v & 0xff)
    this.write(REG.MIWRH, v >> 8)
    this.wait(11e-6)
  }
  setMac(mac = MAC) {
    const order = [REG.MAADR1, REG.MAADR2, REG.MAADR3, REG.MAADR4, REG.MAADR5, REG.MAADR6]
    order.forEach((reg, i) => this.write(reg, mac[i]))
  }
  /** §6.1 + errata 5 and 14: RX at 0000h, ERXND odd, ERXRDPT = ERXND; MARXEN, RXEN. */
  initRx(end = 0x0fff) {
    this.write16(REG.ERXSTL, 0x0000)
    this.write16(REG.ERXNDL, end)
    this.write16(REG.ERXRDPTL, end)
    this.setMac()
    this.write(REG.MACON1, 0x01)
    this.bfs(REG.ECON1, RXEN)
  }
  /** §7.1 steps 1–3: control byte + frame at ETXST, ETXND at the last byte. */
  loadTx(bytes: number[], control = 0x00, start = 0x1000) {
    this.write16(REG.ETXSTL, start)
    this.write16(REG.EWRPTL, start)
    this.wbm([control, ...bytes])
    this.write16(REG.ETXNDL, start + bytes.length)
  }
}

describe("ENC28J60: identity and the gaps list", () => {
  it("exports NOT_MODELLED", () => {
    expect(NOT_MODELLED.length).toBeGreaterThan(5)
    expect(NOT_MODELLED.every((s) => typeof s === "string" && s.length > 0)).toBe(true)
  })

  it("EREVID = 06h (errata Table 1, B7), other revisions by prop; PHID1 = 0083h, PHID2 = 1400h (Table 3-3)", () => {
    const h = new Host().ready()
    expect(h.read(REG.EREVID)).toBe(0x06)
    expect(h.phyRead(0x02)).toBe(0x0083)
    expect(h.phyRead(0x03)).toBe(0x1400)
    h.m.configure({ revision: "B5" })
    expect(h.read(REG.EREVID)).toBe(0x05)
  })
})

describe("ENC28J60: SPI (§4, Table 4-1)", () => {
  it("SO is high-impedance with CS high and during the opcode; ETH data follows at once (Figure 4-3)", () => {
    const h = new Host().ready()
    expect(h.m.drive(P.miso)).toBeNull()
    const { rx, driven } = h.xfer([REG.ECON2.addr, 0])
    expect(driven).toEqual([false, true])
    expect(rx[1]).toBe(0x80)
    expect(h.m.drive(P.miso), "released when CS rises").toBeNull()
  })

  it("MAC/MII registers shift a dummy byte out first (§4.2.1, Figure 4-4)", () => {
    const h = new Host().ready()
    h.bank(2)
    const eth = h.xfer([REG.MACLCON2.addr, 0])
    expect(eth.rx[1], "without the dummy the first byte is not the register").not.toBe(0x37)
    const mac = h.xfer([REG.MACLCON2.addr, 0, 0])
    expect(mac.driven).toEqual([false, true, true])
    expect(mac.rx[2]).toBe(0x37)
  })

  it("reset values of Table 3-2, in every bank", () => {
    const h = new Host().ready()
    const expected: [Reg, number][] = [
      [REG.ERDPTL, 0xfa], [REG.ERDPTH, 0x05], [REG.EWRPTL, 0x00], [REG.EWRPTH, 0x00],
      [REG.ERXSTL, 0xfa], [REG.ERXSTH, 0x05], [REG.ERXNDL, 0xff], [REG.ERXNDH, 0x1f],
      [REG.ERXRDPTL, 0xfa], [REG.ERXRDPTH, 0x05], [REG.ERXWRPTL, 0x00], [REG.ERXWRPTH, 0x00],
      [REG.ERXFCON, 0xa1], [REG.EPKTCNT, 0x00], [REG.EHT0, 0x00],
      [REG.MACON1, 0x00], [REG.MACON3, 0x00], [REG.MACON4, 0x00], [REG.MACLCON1, 0x0f],
      [REG.MACLCON2, 0x37], [REG.MAMXFLL, 0x00], [REG.MAMXFLH, 0x06], [REG.MICMD, 0x00], [REG.MISTAT, 0x00],
      [REG.MAADR1, 0x00], [REG.ECOCON, 0x04], [REG.EFLOCON, 0x00], [REG.EPAUSL, 0x00], [REG.EPAUSH, 0x10],
      [REG.EIE, 0x00], [REG.EIR, 0x00], [REG.ESTAT, CLKRDY], [REG.ECON2, 0x80],
    ]
    for (const [reg, v] of expected) expect(h.read(reg), `bank ${reg.bank} ${reg.addr.toString(16)}h`).toBe(v)
    expect(h.read(REG.ECON1) & 0xfc, "ECON1 apart from BSEL, which the reads above moved").toBe(0x00)
  })

  it("unimplemented addresses read 0 and ignore writes; pointer high bytes keep 5 bits (§3.1, Table 3-2)", () => {
    const h = new Host().ready()
    h.write(r(0, 0x18), 0xff)
    expect(h.read(r(0, 0x18))).toBe(0)
    h.write(REG.ERDPTH, 0xff)
    expect(h.read(REG.ERDPTH)).toBe(0x1f)
    h.write(REG.EREVID, 0x1f)
    expect(h.read(REG.EREVID), "EREVID is read-only").toBe(0x06)
  })

  it("BSEL picks the bank; EIE..ECON1 are in all four (§3.1)", () => {
    const h = new Host().ready()
    h.write(REG.EIE, 0x5a)
    for (const b of [0, 1, 2, 3]) {
      h.bank(b)
      expect(h.xfer([REG.EIE.addr, 0]).rx[1]).toBe(0x5a)
      expect(h.xfer([REG.ECON1.addr, 0]).rx[1] & 3).toBe(b)
    }
  })

  it("BFS ORs, BFC clears (F1h BFC 17h = E0h, §4.2.6); neither touches MAC registers (§4.2.5)", () => {
    const h = new Host().ready()
    h.write(REG.EIE, 0xf1)
    h.bfc(REG.EIE, 0x17)
    expect(h.read(REG.EIE)).toBe(0xe0)
    h.bfs(REG.EIE, 0x03)
    expect(h.read(REG.EIE)).toBe(0xe3)
    h.write(REG.MACON3, 0x30)
    h.bfs(REG.MACON3, 0x01)
    h.bfc(REG.MACON3, 0x10)
    expect(h.read(REG.MACON3)).toBe(0x30)
  })

  it("WCR is dropped if CS rises before eight data bits (§4.2.3)", () => {
    const h = new Host().ready()
    h.write(REG.EIE, 0x11)
    h.pin(P.cs, false)
    for (const bit of [0, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1]) {
      h.m.input(P.mosi, bit === 1, h.t)
      h.pin(P.sck, true)
      h.pin(P.sck, false)
    }
    h.pin(P.cs, true)
    expect(h.read(REG.EIE)).toBe(0x11)
  })
})

describe("ENC28J60: clock, start-up and resets (§2.2, §11, Table 16-2/16-3)", () => {
  it("no OSC1 clock: SO is never driven and CLKRDY never comes", () => {
    const h = new Host({ clock: 0 })
    h.wait(10e-3)
    const { driven } = h.xfer([REG.ESTAT.addr, 0])
    expect(driven).toEqual([false, false])
    expect(h.m.snapshot().clockReady).toBe(false)
  })

  it("CLKRDY sets 7500 OSC1 cycles (300 µs) after the clock starts", () => {
    const h = new Host({ clock: 0 })
    h.wait(1e-3)
    h.m.setClock(25e6, h.t)
    const t0 = h.t
    h.wait(296e-6)
    expect(h.read(REG.ESTAT) & CLKRDY).toBe(0)
    h.t = t0 + 301e-6
    expect(h.read(REG.ESTAT) & CLKRDY).toBe(CLKRDY)
  })

  it("clock edges on CLKIN are measured as the clock (MCO1 at 25 MHz)", () => {
    const h = new Host({ clock: 0 })
    let t = 1e-6
    for (let i = 0; i < 2 * 7600; i++) h.m.input(P.clkin, i % 2 === 0, (t += 20e-9))
    h.t = t
    expect(h.m.snapshot().clockHz).toBeCloseTo(25e6, -3)
    expect(h.read(REG.ESTAT) & CLKRDY).toBe(CLKRDY)
  })

  it("ETH registers work during the OST, MAC/MII writes are lost (§2.2)", () => {
    const h = new Host()
    h.wait(10e-6)
    h.write(REG.EIE, 0x42)
    h.write(REG.MAMXFLL, 0x12)
    h.ready()
    expect(h.read(REG.EIE)).toBe(0x42)
    expect(h.read(REG.MAMXFLL)).toBe(0x00)
  })

  it("SRC: registers to reset values, buffer kept, CLKRDY stays set while the PHY restarts (§11.2, errata 2)", () => {
    const h = new Host().ready()
    h.write16(REG.EWRPTL, 0x0100)
    h.wbm([0xde, 0xad])
    h.write(REG.EIE, 0x55)
    h.write(REG.ERXFCON, 0x00)
    h.src()
    expect(h.read(REG.ESTAT) & CLKRDY, "CLKRDY unaffected (Table 3-2 note 1)").toBe(CLKRDY)
    expect(h.read(REG.EIE)).toBe(0x00)
    expect(h.read(REG.ERXFCON)).toBe(0xa1)
    expect(h.phyRead(0x02), "errata 2: PHY not ready right after SRC").toBe(0x0000)
    h.wait(1e-3)
    expect(h.phyRead(0x02)).toBe(0x0083)
    expect(h.rbmAt(0x0100, 2)).toEqual([0xde, 0xad])
  })

  it("RESET pin: pulses up to 400 ns are filtered (tRSTLOW), longer ones reset; SPI ignored while low", () => {
    const h = new Host().ready()
    h.write(REG.EIE, 0x55)
    h.m.input(P.reset, false, (h.t += 1e-6))
    h.m.input(P.reset, true, (h.t += 300e-9))
    expect(h.read(REG.EIE)).toBe(0x55)
    h.m.input(P.reset, false, (h.t += 1e-6))
    expect(h.xfer([REG.EIE.addr, 0]).driven).toEqual([false, false])
    h.m.input(P.reset, true, (h.t += 1e-6))
    h.wait(1e-3)
    expect(h.read(REG.EIE)).toBe(0x00)
  })

  it("power: off releases SO and INT; on is a POR with CLKRDY cleared until the OST expires (§11.1)", () => {
    const h = new Host().ready()
    h.write(REG.EIE, 0x55)
    h.m.setPower(false, (h.t += 1e-6))
    expect(h.m.drive(P.int)).toBeNull()
    expect(h.xfer([REG.EIE.addr, 0]).driven).toEqual([false, false])
    h.m.setPower(true, (h.t += 1e-3))
    h.wait(10e-6)
    expect(h.read(REG.ESTAT) & CLKRDY).toBe(0)
    expect(h.read(REG.EIE)).toBe(0x00)
    expect(h.m.drive(P.int), "INTIE = 0: INT driven high (Register 12-2)").toBe(true)
    h.wait(300e-6)
    expect(h.read(REG.ESTAT) & CLKRDY).toBe(CLKRDY)
  })

  it("PWRSV clears CLKRDY (§14), SRC is ignored in power save (errata 19), wake takes the OST again", () => {
    const h = new Host().ready()
    h.write(REG.EIE, 0x55)
    h.bfs(REG.ECON2, PWRSV)
    expect(h.read(REG.ESTAT) & CLKRDY).toBe(0)
    h.src()
    expect(h.read(REG.EIE)).toBe(0x55)
    h.bfc(REG.ECON2, PWRSV)
    const t0 = h.t
    h.wait(290e-6)
    expect(h.read(REG.ESTAT) & CLKRDY).toBe(0)
    h.t = t0 + 302e-6
    expect(h.read(REG.ESTAT) & CLKRDY).toBe(CLKRDY)
  })
})

describe("ENC28J60: buffer memory (§3.2, §4.2.2, §4.2.4)", () => {
  it("WBM then RBM with AUTOINC; EWRPT wraps 1FFFh → 0000h", () => {
    const h = new Host().ready()
    h.write16(REG.EWRPTL, 0x1ffe)
    h.wbm([1, 2, 3])
    expect(h.read16(REG.EWRPTL)).toBe(0x0001)
    expect(h.rbmAt(0x1ffe, 2)).toEqual([1, 2])
    expect(h.rbmAt(0x0000, 1)).toEqual([3])
  })

  it("ERDPT wraps from ERXND to ERXST, and from 1FFFh to 0 when ERXND is elsewhere", () => {
    const h = new Host().ready()
    h.write16(REG.ERXSTL, 0x0000)
    h.write16(REG.ERXNDL, 0x0fff)
    h.write16(REG.EWRPTL, 0x0ffe)
    h.wbm([0xa1, 0xa2])
    h.write16(REG.EWRPTL, 0x0000)
    h.wbm([0xa3])
    expect(h.rbmAt(0x0ffe, 3)).toEqual([0xa1, 0xa2, 0xa3])
    expect(h.read16(REG.ERDPTL)).toBe(0x0001)
    h.write16(REG.EWRPTL, 0x1fff)
    h.wbm([0xb1])
    expect(h.rbmAt(0x1fff, 2)).toEqual([0xb1, 0xa3])
  })

  it("AUTOINC clear: the same byte again, pointers unchanged", () => {
    const h = new Host().ready()
    h.write16(REG.EWRPTL, 0x0200)
    h.wbm([7, 8])
    h.bfc(REG.ECON2, AUTOINC)
    expect(h.rbmAt(0x0200, 3)).toEqual([7, 7, 7])
    expect(h.read16(REG.ERDPTL)).toBe(0x0200)
  })
})

describe("ENC28J60: PHY registers through MII (§3.3, Table 3-3)", () => {
  it("MISTAT.BUSY for 10.24 µs after MIIRD", () => {
    const h = new Host().ready()
    h.write(REG.MIREGADR, 0x14)
    h.write(REG.MICMD, 0x01)
    expect(h.read(REG.MISTAT) & 1).toBe(1)
    h.wait(10e-6)
    expect(h.read(REG.MISTAT) & 1).toBe(0)
    h.write(REG.MICMD, 0x00)
    expect(h.read(REG.MIRDL) | (h.read(REG.MIRDH) << 8)).toBe(0x3422)
  })

  it("reset values: PHCON1 0000h (LEDB sources, §2.6), PHSTAT1 1800h|LLSTAT, PHSTAT2 LSTAT, PHCON2/PHIE 0", () => {
    const h = new Host().ready()
    expect(h.phyRead(0x00)).toBe(0x0000)
    expect(h.phyRead(0x01) & ~0x0004).toBe(0x1800)
    expect(h.phyRead(0x11)).toBe(0x0400)
    expect(h.phyRead(0x10)).toBe(0x0000)
    expect(h.phyRead(0x12)).toBe(0x0000)
    expect(h.phyRead(0x05), "unimplemented").toBe(0x0000)
  })

  it("write through MIWRL/MIWRH: BUSY, then the register holds it", () => {
    const h = new Host().ready()
    h.write(REG.MIREGADR, 0x14)
    h.write(REG.MIWRL, 0x76)
    h.write(REG.MIWRH, 0x34)
    expect(h.read(REG.MISTAT) & 1).toBe(1)
    h.wait(11e-6)
    expect(h.read(REG.MISTAT) & 1).toBe(0)
    expect(h.phyRead(0x14)).toBe(0x3476)
  })

  it("MIISCAN: SCAN and NVALID until the first read, then MIRD follows the register (§3.3.3)", () => {
    const h = new Host().ready()
    h.write(REG.MIREGADR, 0x11)
    h.write(REG.MICMD, 0x02)
    expect(h.read(REG.MISTAT) & 0x07).toBe(0x07)
    h.wait(11e-6)
    expect(h.read(REG.MISTAT) & 0x04).toBe(0)
    expect(h.read(REG.MIRDH)).toBe(0x04)
    h.m.setLink(false)
    h.wait(11e-6)
    expect(h.read(REG.MIRDH)).toBe(0x00)
    h.write(REG.MICMD, 0x00)
    h.wait(11e-6)
    expect(h.read(REG.MISTAT) & 0x03).toBe(0)
  })
})

describe("ENC28J60: transmit (§7.1, Figure 7-1/7-2, Table 7-1)", () => {
  function txSetup(macon3 = 0x32) {
    const h = new Host().ready()
    h.write(REG.MACON3, macon3)
    return h
  }

  it("pads to 60 + CRC, keeps TXRTS for the wire time, then TXIF, INT and the status vector at ETXND+1", () => {
    const h = txSetup()
    const f = frame(BCAST, 0x0806, 28)
    h.loadTx(f)
    h.write(REG.EIE, INTIE | TXIE)
    h.bfs(REG.ECON1, TXRTS)
    expect(h.read(REG.ECON1) & TXRTS).toBe(TXRTS)
    h.wait(48e-6)
    expect(h.read(REG.ECON1) & TXRTS, "(8 + 64) bytes × 0.8 µs = 57.6 µs").toBe(TXRTS)
    expect(h.m.drive(P.int)).toBe(true)
    h.wait(10e-6)
    expect(h.read(REG.ECON1) & TXRTS).toBe(0)
    expect(h.read(REG.EIR) & TXIF).toBe(TXIF)
    expect(h.read(REG.ESTAT) & TXABRT).toBe(0)
    expect(h.m.drive(P.int)).toBe(false)
    expect(h.m.out.some((e) => e.pin === P.int && e.level === false)).toBe(true)
    const sent = h.m.takeTransmitted()
    expect(sent.length).toBe(1)
    expect([...sent[0]]).toEqual([...f, ...new Array(60 - f.length).fill(0)])
    expect(h.m.takeTransmitted()).toEqual([])
    const tsv = h.rbmAt(0x1000 + f.length + 1, 7)
    expect(tsv).toEqual([64, 0, 0xc0, 0x02, 64, 0, 0])
    h.bfc(REG.EIR, TXIF)
    expect(h.m.drive(P.int)).toBe(true)
  })

  it("per-packet override without CRC: the last 4 bytes are the FCS, checked into TSV bit 20", () => {
    const h = txSetup()
    const f = frame(OTHER, 0x0800, 50, MAC)
    h.loadTx([...f, ...fcs(f)], 0x01)
    h.bfs(REG.ECON1, TXRTS)
    h.wait(100e-6)
    expect([...h.m.takeTransmitted()[0]]).toEqual(f)
    const ok = h.rbmAt(0x1000 + f.length + 4 + 1, 7)
    expect(ok[2] & 0x10).toBe(0)
    const bad = [...f, 1, 2, 3, 4]
    h.loadTx(bad, 0x01)
    h.bfs(REG.ECON1, TXRTS)
    h.wait(100e-6)
    expect(h.rbmAt(0x1000 + bad.length + 1, 7)[2] & 0x10).toBe(0x10)
  })

  it("larger than MAMXFL without HFRMEN: aborted, TXABRT + TXERIF + TXIF, TSV giant, nothing on the wire", () => {
    const h = txSetup()
    const f = frame(OTHER, 0x0800, 1600)
    h.loadTx(f)
    h.bfs(REG.ECON1, TXRTS)
    h.wait(2e-3)
    expect(h.read(REG.ECON1) & TXRTS).toBe(0)
    expect(h.read(REG.ESTAT) & TXABRT).toBe(TXABRT)
    expect(h.read(REG.EIR) & (TXIF | TXERIF)).toBe(TXIF | TXERIF)
    expect(h.rbmAt(0x1000 + f.length + 1, 7)[3] & 0x40).toBe(0x40)
    expect(h.m.takeTransmitted()).toEqual([])
  })

  it("clearing TXRTS cancels: TXIF, no frame; TXRST aborts likewise (§7.1, §11.3)", () => {
    const h = txSetup()
    h.loadTx(frame(BCAST, 0x0800, 200))
    h.bfs(REG.ECON1, TXRTS)
    h.wait(20e-6)
    h.bfc(REG.ECON1, TXRTS)
    h.wait(300e-6)
    expect(h.read(REG.EIR) & TXIF).toBe(TXIF)
    expect(h.m.takeTransmitted()).toEqual([])
    h.bfc(REG.EIR, TXIF)
    h.bfs(REG.ECON1, TXRTS)
    h.wait(20e-6)
    h.bfs(REG.ECON1, TXRST)
    expect(h.read(REG.ECON1) & TXRTS).toBe(0)
    h.bfc(REG.ECON1, TXRST)
    h.wait(300e-6)
    expect(h.m.takeTransmitted()).toEqual([])
  })

  it("TXRTS set during the OST waits for CLKRDY (§2.2)", () => {
    const h = new Host()
    h.wait(5e-6)
    h.loadTx(frame(BCAST, 0x0800, 46))
    h.bfs(REG.ECON1, TXRTS)
    h.wait(250e-6)
    expect(h.m.takeTransmitted()).toEqual([])
    h.wait(200e-6)
    expect(h.m.takeTransmitted().length).toBe(1)
  })

  it("cable unplugged: the MAC still completes (TXIF), the frame goes nowhere", () => {
    const h = txSetup()
    h.m.setLink(false)
    h.loadTx(frame(BCAST, 0x0800, 46))
    h.bfs(REG.ECON1, TXRTS)
    h.wait(100e-6)
    expect(h.read(REG.EIR) & TXIF).toBe(TXIF)
    expect(h.m.takeTransmitted()).toEqual([])
  })
})

describe("ENC28J60: receive (§7.2, Figure 7-3, Table 7-3)", () => {
  it("writes next-packet pointer + status vector + frame + FCS, bumps EPKTCNT, raises PKTIF and INT; PKTDEC undoes it", () => {
    const h = new Host().ready()
    h.initRx()
    h.write(REG.EIE, INTIE | PKTIE)
    const f = frame(MAC, 0x0800, 46)
    h.m.receive(Uint8Array.from(f))
    expect(h.read(REG.EPKTCNT)).toBe(1)
    expect(h.read(REG.EIR) & PKTIF).toBe(PKTIF)
    expect(h.m.drive(P.int)).toBe(false)
    expect(h.read16(REG.ERXWRPTL)).toBe(0x0046)
    const head = h.rbmAt(0x0000, 6)
    expect(head).toEqual([0x46, 0x00, 64, 0, 0xc0, 0x00])
    expect(h.rbm(64)).toEqual([...f, ...fcs(f)])
    h.bfs(REG.ECON2, PKTDEC)
    expect(h.read(REG.EPKTCNT)).toBe(0)
    expect(h.read(REG.EIR) & PKTIF).toBe(0)
    expect(h.m.drive(P.int)).toBe(true)
    h.bfs(REG.ECON2, PKTDEC)
    expect(h.read(REG.EPKTCNT), "never below 0 (§7.2.4)").toBe(0)
  })

  it("an odd-length packet is padded so the next starts even (§7.2.2)", () => {
    const h = new Host().ready()
    h.initRx()
    h.m.receive(Uint8Array.from(frame(MAC, 0x0800, 47)))
    expect(h.rbmAt(0, 2)).toEqual([0x48, 0x00])
  })

  it("default filter A1h: own unicast and broadcast in, other unicast and multicast out (§8, Figure 8-1)", () => {
    const h = new Host().ready()
    h.initRx()
    h.m.receive(Uint8Array.from(frame(OTHER, 0x0800, 46)))
    h.m.receive(Uint8Array.from(frame([0x01, 0x00, 0x5e, 0, 0, 1], 0x0800, 46)))
    expect(h.read(REG.EPKTCNT)).toBe(0)
    h.m.receive(Uint8Array.from(frame(BCAST, 0x0806, 46)))
    expect(h.read(REG.EPKTCNT)).toBe(1)
    expect(h.rbmAt(0, 6)[5] & 0x02, "RSV bit 25 broadcast").toBe(0x02)
    h.write(REG.ERXFCON, 0x00)
    h.m.receive(Uint8Array.from(frame(OTHER, 0x0800, 46)))
    expect(h.read(REG.EPKTCNT), "promiscuous").toBe(2)
  })

  it("CRC: bad FCS dropped with CRCEN, kept with RSV bit 20 set and bit 23 clear without (§5.1.7)", () => {
    const h = new Host().ready()
    h.initRx()
    const bad = [...frame(MAC, 0x0800, 46), 0, 0, 0, 0]
    h.m.receive(Uint8Array.from(bad), { fcs: true })
    expect(h.read(REG.EPKTCNT)).toBe(0)
    h.write(REG.ERXFCON, 0x81)
    h.m.receive(Uint8Array.from(bad), { fcs: true })
    expect(h.read(REG.EPKTCNT)).toBe(1)
    const rsv = h.rbmAt(0, 6)
    expect(rsv[4] & 0x10).toBe(0x10)
    expect(rsv[4] & 0x80).toBe(0)
  })

  it("frames under 18 bytes, RXEN clear or MARXEN clear are not received (§5.1.6, Register 3-1, 6-1)", () => {
    const h = new Host().ready()
    h.initRx()
    h.write(REG.ERXFCON, 0x00)
    h.m.receive(Uint8Array.from([...MAC, ...OTHER, 0x08, 0x00]), { fcs: true })
    expect(h.read(REG.EPKTCNT)).toBe(0)
    h.bfc(REG.ECON1, RXEN)
    h.m.receive(Uint8Array.from(frame(MAC, 0x0800, 46)))
    expect(h.read(REG.EPKTCNT)).toBe(0)
    h.bfs(REG.ECON1, RXEN)
    h.write(REG.MACON1, 0x00)
    h.m.receive(Uint8Array.from(frame(MAC, 0x0800, 46)))
    expect(h.read(REG.EPKTCNT)).toBe(0)
  })

  it("pattern match: the Figure 8-3 example matches, a wrong checksum does not (§8.2)", () => {
    const h = new Host().ready()
    h.initRx()
    h.write16(REG.EPMOL, 0x0006)
    h.write(REG.EPMM0, 0x0a)
    h.write(REG.EPMM1, 0x1f)
    h.write16(REG.EPMCSL, 0x563f)
    h.write(REG.ERXFCON, 0x10)
    const f = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0x00, 0x5a, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]
    while (f.length < 76) f.push(f.length)
    h.m.receive(Uint8Array.from(f))
    expect(h.read(REG.EPKTCNT)).toBe(1)
    h.write16(REG.EPMCSL, 0x5640)
    h.m.receive(Uint8Array.from(f))
    expect(h.read(REG.EPKTCNT)).toBe(1)
  })

  it("errata 18: OR mode with PMEN and another filter takes short frames it should reject", () => {
    const h = new Host().ready()
    h.initRx()
    h.write16(REG.EPMCSL, 0x1234)
    h.write(REG.EPMM0, 0x01)
    h.write(REG.ERXFCON, 0x11)
    h.m.receive(Uint8Array.from(frame(OTHER, 0x0800, 46)))
    expect(h.read(REG.EPKTCNT), "64 bytes ≤ 64 + EPMO").toBe(1)
    h.m.receive(Uint8Array.from(frame(OTHER, 0x0800, 100)))
    expect(h.read(REG.EPKTCNT)).toBe(1)
  })

  it("magic packet and hash table filters (§8.3, §8.4)", () => {
    const h = new Host().ready()
    h.initRx()
    h.write(REG.ERXFCON, 0x08)
    const magic = [...MAC, ...OTHER, 0x08, 0x42, 1, 2, 3, ...BCAST]
    for (let i = 0; i < 16; i++) magic.push(...MAC)
    h.m.receive(Uint8Array.from(magic))
    expect(h.read(REG.EPKTCNT)).toBe(1)
    h.m.receive(Uint8Array.from(frame(MAC, 0x0842, 120)))
    expect(h.read(REG.EPKTCNT)).toBe(1)
    h.write(REG.ERXFCON, 0x04)
    const mcast = frame([0x01, 0x00, 0x5e, 0, 0, 0xfb], 0x0800, 46)
    h.m.receive(Uint8Array.from(mcast))
    expect(h.read(REG.EPKTCNT), "all hash bits clear: never").toBe(1)
    for (let i = 0; i < 8; i++) h.write(r(1, i), 0xff)
    h.m.receive(Uint8Array.from(mcast))
    expect(h.read(REG.EPKTCNT), "all hash bits set: always").toBe(2)
  })

  it("full ring: packet dropped with RXERIF, the next one flags the drop (RSV bit 16) and wraps ERXND → ERXST", () => {
    const h = new Host().ready()
    h.initRx(0x00ff)
    const f = frame(MAC, 0x0800, 46)
    for (let i = 0; i < 4; i++) h.m.receive(Uint8Array.from(f))
    expect(h.read(REG.EPKTCNT)).toBe(3)
    expect(h.read(REG.EIR) & RXERIF).toBe(RXERIF)
    h.write16(REG.ERXRDPTL, 0x0045)
    h.m.receive(Uint8Array.from(f))
    expect(h.read(REG.EPKTCNT)).toBe(4)
    const head = h.rbmAt(0x00d2, 6)
    expect(head[0] | (head[1] << 8)).toBe((0xd2 + 70) & 0xff)
    expect(head[4] & 0x01, "drop event since last receive").toBe(0x01)
    expect(h.rbm(64), "RBM follows the wrap").toEqual([...f, ...fcs(f)])
  })

  it("EPKTCNT at 255 aborts new packets with RXERIF (§7.2.4)", () => {
    const h = new Host().ready()
    h.initRx(0x1fff)
    // 256 minimum (18-byte) frames take 256 × 24 bytes: room for all of them in the 8 KB ring.
    const f = frame(MAC, 0x0800, 0)
    for (let i = 0; i < 255; i++) h.m.receive(Uint8Array.from(f))
    expect(h.read(REG.EIR) & RXERIF).toBe(0)
    h.m.receive(Uint8Array.from(f))
    expect(h.read(REG.EPKTCNT)).toBe(255)
    expect(h.read(REG.EIR) & RXERIF).toBe(RXERIF)
  })

  it("ERXRDPTL is buffered until ERXRDPTH is written (§7.2.4); ERXST writes reset the write pointer (§6.1)", () => {
    const h = new Host().ready()
    h.initRx()
    h.write(REG.ERXRDPTL, 0x45)
    expect(h.read(REG.ERXRDPTL)).toBe(0xff)
    h.write(REG.ERXRDPTH, 0x00)
    expect(h.read16(REG.ERXRDPTL)).toBe(0x0045)
    h.write16(REG.ERXRDPTL, 0x0fff)
    h.m.receive(Uint8Array.from(frame(MAC, 0x0800, 46)))
    h.bfc(REG.ECON1, RXEN)
    h.write16(REG.ERXSTL, 0x0000)
    h.bfs(REG.ECON1, RXEN)
    h.bfs(REG.ECON2, PKTDEC)
    h.m.receive(Uint8Array.from(frame(MAC, 0x0800, 47)))
    expect(h.rbmAt(0, 2), "written at ERXST again").toEqual([0x48, 0x00])
  })

  it("errata 5 and 14 are flagged: ERXST not at 0000h, even ERXRDPT", () => {
    const h = new Host().ready()
    h.write16(REG.ERXSTL, 0x0800)
    h.write16(REG.ERXRDPTL, 0x0800)
    h.bfs(REG.ECON1, RXEN)
    const w = h.m.snapshot().warnings.join("\n")
    expect(w).toMatch(/\[ERR\] issue 5\b/)
    expect(w).toMatch(/\[ERR\] issue 14\b/)
  })
})

describe("ENC28J60: interrupts and link (§12, Register 3-5/3-6, 12-4/12-5)", () => {
  it("flags set whatever EIE says; INT follows INTIE (§12 note)", () => {
    const h = new Host().ready()
    h.initRx()
    h.m.receive(Uint8Array.from(frame(MAC, 0x0800, 46)))
    expect(h.read(REG.EIR) & PKTIF).toBe(PKTIF)
    expect(h.m.drive(P.int)).toBe(true)
    h.write(REG.EIE, PKTIE)
    expect(h.m.drive(P.int)).toBe(true)
    h.bfs(REG.EIE, INTIE)
    expect(h.m.drive(P.int)).toBe(false)
    expect(h.read(REG.ESTAT) & 0x80, "ESTAT.INT").toBe(0x80)
    h.bfc(REG.EIE, INTIE)
    expect(h.m.drive(P.int)).toBe(true)
  })

  it("LSTAT and the latching LLSTAT (Registers 3-5, 3-6)", () => {
    const h = new Host().ready()
    h.phyRead(0x01)
    expect(h.phyRead(0x01) & 0x0004).toBe(0x0004)
    h.m.setLink(false)
    expect(h.phyRead(0x11) & 0x0400).toBe(0)
    h.m.setLink(true)
    expect(h.phyRead(0x11) & 0x0400).toBe(0x0400)
    expect(h.phyRead(0x01) & 0x0004, "was down since the last read").toBe(0)
    expect(h.phyRead(0x01) & 0x0004).toBe(0x0004)
  })

  it("LINKIF only with PHIE.PGEIE and PLNKIE; reading PHIR clears it (§12.1.5)", () => {
    const h = new Host().ready()
    h.m.setLink(false)
    expect(h.read(REG.EIR) & LINKIF).toBe(0)
    h.phyRead(0x13)
    h.phyWrite(0x12, 0x0012)
    h.write(REG.EIE, INTIE | 0x10)
    h.m.setLink(true)
    expect(h.read(REG.EIR) & LINKIF).toBe(LINKIF)
    expect(h.m.drive(P.int)).toBe(false)
    expect(h.phyRead(0x13) & 0x0014).toBe(0x0014)
    expect(h.read(REG.EIR) & LINKIF).toBe(0)
    expect(h.m.drive(P.int)).toBe(true)
    expect(h.phyRead(0x13) & 0x0014).toBe(0)
  })
})

describe("ENC28J60: DMA (§13)", () => {
  it("checksum of {89h, ABh, CDh} is A953h (§13.2), DMAIF at the end", () => {
    const h = new Host().ready()
    h.write16(REG.EWRPTL, 0x1000)
    h.wbm([0x89, 0xab, 0xcd])
    h.write16(REG.EDMASTL, 0x1000)
    h.write16(REG.EDMANDL, 0x1002)
    h.bfs(REG.ECON1, CSUMEN | DMAST)
    h.wait(2e-6)
    expect(h.read(REG.ECON1) & DMAST).toBe(0)
    expect(h.read(REG.EIR) & DMAIF).toBe(DMAIF)
    expect(h.read(REG.EDMACSH)).toBe(0xa9)
    expect(h.read(REG.EDMACSL)).toBe(0x53)
  })

  it("copy to a linear destination (§13.1)", () => {
    const h = new Host().ready()
    h.write16(REG.EWRPTL, 0x1000)
    h.wbm([1, 2, 3, 4])
    h.write16(REG.EDMASTL, 0x1000)
    h.write16(REG.EDMANDL, 0x1003)
    h.write16(REG.EDMADSTL, 0x1800)
    h.bfc(REG.ECON1, CSUMEN)
    h.bfs(REG.ECON1, DMAST)
    h.wait(2e-6)
    expect(h.read(REG.ECON1) & DMAST).toBe(0)
    expect(h.rbmAt(0x1800, 4)).toEqual([1, 2, 3, 4])
  })
})

describe("ENC28J60: LEDs (§2.6, Register 2-2, Table 2-1)", () => {
  it("PHLCON 3422h: LEDA shows link, LEDB receive activity stretched 40 ms (the Netduino's ACT)", () => {
    const h = new Host().ready()
    h.initRx()
    expect(h.m.leds(h.t)).toEqual({ a: true, b: false })
    h.m.receive(Uint8Array.from(frame(BCAST, 0x0806, 46)))
    expect(h.m.leds(h.t + 30e-3).b).toBe(true)
    expect(h.m.leds(h.t + 41e-3).b).toBe(false)
    h.m.setLink(false)
    expect(h.m.leds(h.t).a).toBe(false)
  })
})
