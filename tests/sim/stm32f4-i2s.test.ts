/**
 * I²S mode of the STM32F4 SPI (RM0090 Rev 22 §28.4, registers §28.5; clock RCC §7.3.23 / Table 127)
 * on a bare STM32F407VG: registers poked over the bus, pads observed through `digitalOut`. Every
 * expectation names the section, figure or table it comes from; the few that pin down an
 * undocumented point say so ("decision").
 */
import { describe, expect, it } from "vitest"
import { STM32F407VG } from "@/mcu/chip"
import { parsePad, Stm32 } from "@/mcu/stm32f429"
import { buffer, example } from "../lib/firmware"

const RCC = 0x40023800
const RCC_CR = RCC + 0x00
const RCC_PLLCFGR = RCC + 0x04
const RCC_CFGR = RCC + 0x08
const RCC_AHB1ENR = RCC + 0x30
const RCC_APB1ENR = RCC + 0x40
const RCC_PLLI2SCFGR = RCC + 0x84
const GPIO = (port: number) => 0x40020000 + 0x400 * port
const SPI2 = 0x40003800
const SPI3 = 0x40003c00
const CR2 = 0x04
const SR = 0x08
const DR = 0x0c
const I2SCFGR = 0x1c
const I2SPR = 0x20
const DMA1 = 0x40026000
const ISPR1 = 0xe000e204

// SPI_SR (§28.5.3)
const RXNE = 1 << 0
const TXE = 1 << 1
const CHSIDE = 1 << 2
const UDR = 1 << 3
const OVR = 1 << 6
const BSY = 1 << 7
// SPI_CR2 (§28.5.2)
const RXDMAEN = 1 << 0
const TXDMAEN = 1 << 1
const ERRIE = 1 << 5
const TXEIE = 1 << 7
// SPI_I2SCFGR (§28.5.8)
const I2SMOD = 1 << 11
const I2SE = 1 << 10
const SLAVE_TX = 0 << 8
const MASTER_TX = 2 << 8
const MASTER_RX = 3 << 8
const PCMSYNC = 1 << 7
const PHILIPS = 0 << 4
const MSB = 1 << 4
const LSB = 2 << 4
const PCM = 3 << 4
const CKPOL = 1 << 3
const DAT16 = 0 << 1
const DAT24 = 1 << 1
const DAT32 = 2 << 1
const CH32 = 1
// SPI_I2SPR (§28.5.9)
const ODD = 1 << 8
const MCKOE = 1 << 9

const HSI = 16e6
const CORE_CYCLE = 1 / HSI // the bare chip runs on HSI: edge times land on core cycles

type Pad = { port: number; pin: number }
type Edge = { pad: Pad; level: boolean | null; time: number }
const key = (p: Pad) => p.port * 16 + p.pin
const pad = (name: string) => parsePad(name)!

/** adc-idle.elf (a WFI loop) with its initial SP moved to the top of the F40x's 128 KB SRAM (as tests/sim/rm0090-f40x.test.ts). */
function idleImage(): ArrayBuffer {
  const image = buffer(example("adc-idle.elf")).slice(0)
  const view = new DataView(image)
  view.setUint32(0x1000, 0x20020000, true)
  return image
}

function bare() {
  const mcu = new Stm32(STM32F407VG)
  mcu.load(idleImage(), "adc-idle.elf")
  mcu.run(1e-5)
  expect(mcu.cpu.halted).toBeNull()
  const w = (addr: number, value: number) => mcu.bus.write(addr, value >>> 0, 4)
  const r = (addr: number) => mcu.bus.read(addr, 4) >>> 0
  w(RCC_AHB1ENR, r(RCC_AHB1ENR) | 0x1ff | (1 << 21)) // GPIOA–I, DMA1
  w(RCC_APB1ENR, r(RCC_APB1ENR) | (1 << 14) | (1 << 15)) // SPI2, SPI3
  /** Pad to an alternate function (GPIO MODER = 10, AFRL/AFRH, RM0090 §8.4). */
  const af = (name: string, n: number) => {
    const p = pad(name)
    const g = GPIO(p.port)
    w(g, (r(g) & ~(3 << (2 * p.pin))) | (2 << (2 * p.pin)))
    const afr = g + (p.pin < 8 ? 0x20 : 0x24)
    const s = 4 * (p.pin & 7)
    w(afr, (r(afr) & ~(0xf << s)) | (n << s))
  }
  /** HSE 8 MHz / PLLM 8 = 1 MHz VCO input (Table 127's premise), PLLI2S N and R (§7.3.23); the core stays on HSI. */
  const plli2s = (n: number, rr: number) => {
    w(RCC_CR, r(RCC_CR) | (1 << 16))
    expect(r(RCC_CR) & (1 << 17), "HSERDY").not.toBe(0)
    w(RCC_PLLCFGR, (r(RCC_PLLCFGR) & ~0x3f) | 8 | (1 << 22))
    w(RCC_PLLI2SCFGR, (rr << 28) | (n << 6))
    w(RCC_CR, r(RCC_CR) | (1 << 26))
    expect(r(RCC_CR) & (1 << 27), "PLLI2SRDY").not.toBe(0)
  }
  /**
   * Run, collecting the pad edges. `react` sees each edge as it comes (the core yields on every
   * one); `poll` runs at least every 2 µs, as firmware servicing the block would.
   */
  const capture = (seconds: number, react?: (e: Edge) => void, poll?: () => void) => {
    const out: Edge[] = []
    mcu.yieldOnOutput = react !== undefined
    const end = mcu.time + seconds
    poll?.()
    while (mcu.time < end) {
      if (!mcu.runUntil(poll ? Math.min(end, mcu.time + 2e-6) : end)) break
      for (const e of mcu.digitalOut) {
        out.push(e)
        react?.(e)
      }
      mcu.digitalOut.length = 0
      poll?.()
    }
    return out
  }
  return { mcu, w, r, af, plli2s, capture }
}

/** Edges of one pad, in order, minus repeats of the same level. */
function on(edges: Edge[], p: Pad) {
  const out: { level: boolean | null; time: number }[] = []
  for (const e of edges) if (key(e.pad) === key(p) && (out.length === 0 || out[out.length - 1].level !== e.level)) out.push({ level: e.level, time: e.time })
  return out
}
/** Level of a pad at time t from its edge list (the last edge at or before t). */
function levelAt(list: { level: boolean | null; time: number }[], t: number) {
  let v: boolean | null = null
  for (const e of list) {
    if (e.time > t + 1e-15) break
    v = e.level
  }
  return v
}
/**
 * Bit slots as a receiver sees them: SD and WS at every sample edge of CK (rising for CKPOL = 0,
 * Figure 264; falling for CKPOL = 1), plus the time of each.
 */
function slots(edges: Edge[], ck: Pad, ws: Pad, sd: Pad, ckpol = false) {
  const c = on(edges, ck)
  const wsl = on(edges, ws)
  const sdl = on(edges, sd)
  return c
    .filter((e) => e.level === !ckpol)
    .map((e) => ({ time: e.time, ws: levelAt(wsl, e.time) === true, sd: levelAt(sdl, e.time) === true }))
}
const word = (bits: boolean[]) => bits.reduce((v, b) => v * 2 + (b ? 1 : 0), 0)

/** I2S3 as on the F4-Discovery's CS43L22 link: MCK PC7, CK PC10, SD PC12, WS PA4 (AF6, DS8626 Table 9). */
function i2s3() {
  const b = bare()
  b.af("PC7", 6)
  b.af("PC10", 6)
  b.af("PC12", 6)
  b.af("PA4", 6)
  return { ...b, MCK: pad("PC7"), CK: pad("PC10"), SD: pad("PC12"), WS: pad("PA4") }
}

/** Keep the transmit buffer fed from a list while TXE is set (what an ISR would do); returns the poll hook. */
function feeder(r: (a: number) => number, w: (a: number, v: number) => void, base: number, data: number[]) {
  let i = 0
  return () => {
    while (r(base + SR) & TXE) w(base + DR, data[i++ % data.length])
  }
}

describe("I²S clock generator (RM0090 §28.4.4, Table 127)", () => {
  it("48 kHz, 16-bit, MCK off: PLLI2SN 192, PLLI2SR 5, I2SDIV 12, ODD 1 gives a 48 kHz WS and CK = 32 × Fs", () => {
    const { mcu, w, r, plli2s, capture, CK, WS } = i2s3()
    plli2s(192, 5)
    w(SPI3 + I2SPR, ODD | 12)
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16)
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16 | I2SE)
    const spi3 = mcu.spi[2]
    expect(spi3.fsHz()).toBeCloseTo(48000, 6)
    expect(spi3.ckHz()).toBeCloseTo(48000 * 32, 3)
    expect(spi3.mckHz(), "MCKOE = 0: no master clock").toBe(0)
    const edges = capture(0.0012, undefined, feeder(r, w, SPI3, [0x1234, 0xabcd]))
    // WS falls once per frame (Philips: low = left, §28.4.3).
    const falls = on(edges, WS).filter((e) => e.level === false).map((e) => e.time).slice(2)
    expect(falls.length).toBeGreaterThan(40)
    const periods = falls.slice(1).map((t, i) => t - falls[i])
    for (const p of periods) expect(Math.abs(p - 1 / 48000)).toBeLessThanOrEqual(CORE_CYCLE + 1e-12)
    expect((falls[falls.length - 1] - falls[0]) / periods.length).toBeCloseTo(1 / 48000, 9)
    const rises = on(edges, CK).filter((e) => e.level === true).map((e) => e.time).slice(10)
    expect((rises[rises.length - 1] - rises[0]) / (rises.length - 1)).toBeCloseTo(1 / (48000 * 32), 10)
  })

  it("48 kHz with MCK: PLLI2SN 258, PLLI2SR 3, I2SDIV 3, ODD 1 gives 47991.07 Hz, MCK = 256 × Fs, MCK pad held high", () => {
    const { mcu, w, r, plli2s, capture, MCK, WS } = i2s3()
    plli2s(258, 3)
    w(SPI3 + I2SPR, MCKOE | ODD | 3)
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16 | I2SE)
    const spi3 = mcu.spi[2]
    expect(spi3.fsHz()).toBeCloseTo(47991.07031, 2) // the table's figure is single precision
    expect(spi3.mckHz()).toBeCloseTo(256 * 47991.07031, 0)
    const edges = capture(0.0006, undefined, feeder(r, w, SPI3, [0x0f0f, 0xf0f0]))
    const falls = on(edges, WS).filter((e) => e.level === false).map((e) => e.time).slice(2)
    expect((falls[falls.length - 1] - falls[0]) / (falls.length - 1)).toBeCloseTo(1 / 47991.07031, 9)
    // The one documented deviation: MCK is not toggled at 256·Fs, it is driven high while output.
    expect(on(edges, MCK).map((e) => e.level)).toEqual([true])
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16)
    expect(spi3.mckHz()).toBe(0)
    expect(mcu.gpio[MCK.port].driveOf(MCK.pin), "released with I2SE").not.toBe("high")
  })

  it("32-bit channel with MCK: Fs = I2SxCLK / (64 × (2·I2SDIV + ODD) × 4), the same MCK = 256 × Fs", () => {
    const { mcu, w, plli2s } = i2s3()
    plli2s(258, 3) // 86 MHz
    w(SPI3 + I2SPR, MCKOE | ODD | 3)
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT32 | I2SE)
    expect(mcu.spi[2].fsHz()).toBeCloseTo(86e6 / (64 * 7 * 4), 6)
    expect(mcu.spi[2].ckHz()).toBeCloseTo(86e6 / (7 * 4), 3)
    expect(mcu.spi[2].mckHz()).toBeCloseTo(86e6 / 7, 3)
  })

  it("follows the PLLI2S: no PLLI2SON, no clock (I2SxCLK = VCO / PLLI2SR, §7.3.23)", () => {
    const { mcu, w, r } = i2s3()
    w(SPI3 + I2SPR, ODD | 12)
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16 | I2SE)
    expect(r(RCC_CR) & (1 << 26)).toBe(0)
    expect(mcu.spi[2].ckHz()).toBe(0)
    expect(mcu.rcc.i2sHz()).toBe(0)
  })

  it("reports the external I2S_CKIN source (RCC_CFGR.I2SSRC = 1) as not modelled", () => {
    const { mcu, w, r } = i2s3()
    w(RCC_CFGR, r(RCC_CFGR) | (1 << 23))
    expect([...mcu.unmodelled.features.keys()].some((k) => /I2S_CKIN/.test(k))).toBe(true)
    expect(mcu.rcc.i2sHz()).toBeNull()
  })
})

describe("I²S audio standards (RM0090 §28.4.3)", () => {
  function run(cfg: number, data: number[], seconds = 0.0004) {
    const b = i2s3()
    b.plli2s(192, 5)
    b.w(SPI3 + I2SPR, ODD | 12)
    b.w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | cfg | I2SE)
    const edges = b.capture(seconds, undefined, feeder(b.r, b.w, SPI3, data))
    return { ...b, edges, s: slots(edges, b.CK, b.WS, b.SD, (cfg & CKPOL) !== 0) }
  }
  /** Index of the first slot of a channel that starts with WS going to `level` (after the first few frames). */
  const wsStart = (s: { ws: boolean }[], level: boolean, from = 40) => {
    for (let i = from; i < s.length; i++) if (s[i].ws === level && s[i - 1].ws !== level) return i
    throw new Error("no WS transition")
  }

  it("Philips, 16-bit: WS changes one CK before the MSB, on the falling edge (Figure 264)", () => {
    const { s, edges, CK, WS } = run(PHILIPS | DAT16, [0xc3a5, 0x5a3c])
    const i = wsStart(s, false) // WS low = left
    expect(word(s.slice(i + 1, i + 17).map((x) => x.sd))).toBe(0xc3a5)
    expect(s[i + 16].ws, "WS rises in the left channel's LSB slot, one CK before the right MSB").toBe(true)
    expect(word(s.slice(i + 17, i + 33).map((x) => x.sd))).toBe(0x5a3c)
    // WS is latched on the falling edge of CK.
    const falls = new Set(on(edges, CK).filter((e) => e.level === false).map((e) => e.time))
    for (const e of on(edges, WS).slice(2)) expect(falls.has(e.time)).toBe(true)
  })

  it("Philips, 24-bit: 0x8EAA then 0x33XX send 0x8EAA33 and 8 forced zeros (Figures 265, 266)", () => {
    const { s } = run(PHILIPS | DAT24, [0x8eaa, 0x33ff, 0x1234, 0x56ff])
    const i = wsStart(s, false)
    expect(word(s.slice(i + 1, i + 33).map((x) => x.sd))).toBe(0x8eaa3300)
    expect(word(s.slice(i + 33, i + 65).map((x) => x.sd))).toBe(0x12345600)
  })

  it("Philips, 32-bit: two halfwords, high first (§28.4.3)", () => {
    const { s } = run(PHILIPS | DAT32, [0xdead, 0xbeef, 0x0123, 0x4567])
    const i = wsStart(s, false)
    expect(word(s.slice(i + 1, i + 33).map((x) => x.sd))).toBe(0xdeadbeef)
    expect(word(s.slice(i + 33, i + 65).map((x) => x.sd))).toBe(0x01234567)
  })

  it("Philips, 16-bit data in a 32-bit channel: data then 16 forced zeros (Figures 268, 269)", () => {
    const { s } = run(PHILIPS | DAT16 | CH32, [0x76a3, 0x1bcd])
    const i = wsStart(s, false)
    expect(word(s.slice(i + 1, i + 33).map((x) => x.sd))).toBe(0x76a30000)
    expect(word(s.slice(i + 33, i + 65).map((x) => x.sd))).toBe(0x1bcd0000)
  })

  it("MSB-justified, 16-bit in 32: WS changes with the MSB, data first (Figure 272); left is WS high (decision from §28.4.8 FRE recovery levels)", () => {
    const { s } = run(MSB | DAT16 | CH32, [0x76a3, 0x1bcd])
    const i = wsStart(s, true)
    expect(word(s.slice(i, i + 32).map((x) => x.sd))).toBe(0x76a30000)
    expect(word(s.slice(i + 32, i + 64).map((x) => x.sd))).toBe(0x1bcd0000)
    expect(s[i + 32].ws).toBe(false)
  })

  it("LSB-justified, 16-bit in 32: 16 forced zeros then the data (Figures 277, 278)", () => {
    const { s } = run(LSB | DAT16 | CH32, [0x76a3, 0x1bcd])
    const i = wsStart(s, true)
    expect(word(s.slice(i, i + 32).map((x) => x.sd))).toBe(0x000076a3)
    expect(word(s.slice(i + 32, i + 64).map((x) => x.sd))).toBe(0x00001bcd)
  })

  it("LSB-justified, 24-bit: 0xXX34 then 0x78AE send 8 zeros and 0x3478AE (Figures 274, 275)", () => {
    const { s } = run(LSB | DAT24, [0xff34, 0x78ae, 0xee12, 0x3456])
    const i = wsStart(s, true)
    expect(word(s.slice(i, i + 32).map((x) => x.sd))).toBe(0x003478ae)
    expect(word(s.slice(i + 32, i + 64).map((x) => x.sd))).toBe(0x00123456)
  })

  it("MSB-justified, 16-bit in 16: the full-accuracy frame (Figure 270)", () => {
    const { s } = run(MSB | DAT16, [0xa001, 0x8005])
    const i = wsStart(s, true)
    expect(word(s.slice(i, i + 16).map((x) => x.sd))).toBe(0xa001)
    expect(word(s.slice(i + 16, i + 32).map((x) => x.sd))).toBe(0x8005)
  })

  it("PCM short frame: a one-CK WS pulse just before each MSB (Figure 279)", () => {
    const { s } = run(PCM | DAT16, [0x9234, 0xc678])
    const pulses = s.map((x, i) => (x.ws ? i : -1)).filter((i) => i >= 40)
    expect(pulses.length).toBeGreaterThan(4)
    for (let k = 1; k < pulses.length; k++) expect(pulses[k] - pulses[k - 1]).toBe(16)
    const i = pulses[0]
    const words = [word(s.slice(i + 1, i + 17).map((x) => x.sd)), word(s.slice(i + 17, i + 33).map((x) => x.sd))]
    expect(words.sort()).toEqual([0x9234, 0xc678])
  })

  it("PCM long frame: WS high for 13 CK starting with the MSB (Figure 279)", () => {
    const { s } = run(PCM | PCMSYNC | DAT16, [0x9234, 0xc678])
    const i = wsStart(s, true)
    expect(s.slice(i, i + 16).map((x) => x.ws)).toEqual([...Array(13).fill(true), false, false, false])
    expect([0x9234, 0xc678]).toContain(word(s.slice(i, i + 16).map((x) => x.sd)))
  })

  it("CKPOL = 1: CK idles high, data changes on the rising edge and is read on the falling one (§28.5.8; decision: the CKPOL = 0 waveform inverted)", () => {
    const { s, edges, CK, SD } = run(MSB | DAT16 | CKPOL, [0xa001, 0x8005])
    expect(on(edges, CK)[0].level, "steady state high").toBe(true)
    const rises = new Set(on(edges, CK).filter((e) => e.level === true).map((e) => e.time))
    for (const e of on(edges, SD).slice(2)) expect(rises.has(e.time)).toBe(true)
    const i = wsStart(s, true)
    expect(word(s.slice(i, i + 16).map((x) => x.sd))).toBe(0xa001)
  })
})

describe("I²S flags, interrupts and DMA (RM0090 §28.4.5, §28.4.7–§28.4.10)", () => {
  function master(cfg = PHILIPS | DAT16) {
    const b = i2s3()
    b.plli2s(192, 5)
    b.w(SPI3 + I2SPR, ODD | 12)
    b.w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | cfg)
    return b
  }

  it("TXE is clear while I2SE is off, set once enabled with an empty buffer; CHSIDE starts Left (§28.4.7)", () => {
    const { w, r } = master()
    expect(r(SPI3 + SR) & TXE).toBe(0)
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16 | I2SE)
    expect(r(SPI3 + SR) & (TXE | CHSIDE)).toBe(TXE)
  })

  it("master transmit starts with the first DR write; CK idles until then (§28.4.5 transmission sequence)", () => {
    const { w, capture, CK } = master()
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16 | I2SE)
    expect(on(capture(5e-5), CK).map((e) => e.level)).toEqual([false])
    w(SPI3 + DR, 0x1111)
    expect(on(capture(5e-5), CK).length).toBeGreaterThan(100)
  })

  it("CHSIDE says which channel the next write is for: Left, Right, Left… (§28.4.5)", () => {
    const { w, r, capture } = master()
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16 | I2SE)
    const sides: number[] = []
    capture(0.0002, undefined, () => {
      const sr = r(SPI3 + SR)
      if (sr & TXE) {
        sides.push(sr & CHSIDE ? 1 : 0)
        w(SPI3 + DR, 0x5555)
      }
    })
    expect(sides.slice(0, 8)).toEqual([0, 1, 0, 1, 0, 1, 0, 1])
  })

  it("software stops feeding: TXE stays set, BSY stays set, UDR stays clear in master mode (UDR is slave-only, §28.4.8), CK keeps running", () => {
    const { w, r, capture, CK, WS, SD } = master()
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16 | I2SE)
    w(SPI3 + DR, 0xa5a5)
    w(SPI3 + DR, 0x3c3c)
    const edges = capture(0.0003)
    const sr = r(SPI3 + SR)
    expect(sr & (TXE | BSY | UDR)).toBe(TXE | BSY)
    expect(on(edges, CK).length).toBeGreaterThan(800)
    // Decision (undocumented): the shift register reloads the stale buffer, so the last word repeats.
    const s = slots(edges, CK, WS, SD)
    const tail = s.slice(-64)
    let i = 1
    while (!(tail[i].ws === false && tail[i - 1].ws === true)) i++
    expect(word(tail.slice(i + 1, i + 17).map((x) => x.sd))).toBe(0x3c3c)
  })

  it("TXEIE raises SPI3's interrupt (IRQ 51) while TXE is set (Table 128)", () => {
    const { w, r } = master()
    w(SPI3 + CR2, TXEIE)
    expect(r(ISPR1) & (1 << (51 - 32))).toBe(0)
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16 | I2SE)
    expect(r(ISPR1) & (1 << (51 - 32))).not.toBe(0)
  })

  it("TXDMAEN: the TX request line follows TXE (§28.4.10, §28.5.2)", () => {
    const { mcu, w, capture } = master()
    const spi3 = mcu.spi[2]
    w(SPI3 + CR2, TXDMAEN)
    expect(spi3.dmaLevel("tx"), "disabled: TXE clear").toBe(false)
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16 | I2SE)
    expect(spi3.dmaLevel("tx")).toBe(true)
    w(SPI3 + DR, 0x1111)
    expect(spi3.dmaLevel("tx"), "buffer full").toBe(false)
    capture(2e-6) // the first halfword moves to the shift register with its MSB (§28.4.5)
    expect(spi3.dmaLevel("tx")).toBe(true)
    w(SPI3 + DR, 0x2222)
    expect(spi3.dmaLevel("tx")).toBe(false)
    capture(1 / 48000 / 2 + 2e-6) // past the next channel start
    expect(spi3.dmaLevel("tx")).toBe(true)
  })

  it("HAL_I2S_Transmit_DMA's path: DMA1 Stream 5 channel 0 (SPI3_TX) feeds DR and the samples come out in order", () => {
    const { mcu, w, r, capture, CK, WS, SD } = master()
    const samples = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888]
    const BUF = 0x20001000
    samples.forEach((v, i) => mcu.bus.write(BUF + 2 * i, v, 2))
    const S5 = DMA1 + 0x10 + 0x18 * 5
    w(S5 + 4, samples.length) // NDTR
    w(S5 + 8, SPI3 + DR) // PAR
    w(S5 + 12, BUF) // M0AR
    w(S5, (1 << 13) | (1 << 11) | (1 << 10) | (1 << 6) | 1) // MSIZE/PSIZE 16-bit, MINC, memory→peripheral, EN
    w(SPI3 + I2SCFGR, I2SMOD | MASTER_TX | PHILIPS | DAT16 | I2SE)
    w(SPI3 + CR2, TXDMAEN)
    const edges = capture(0.0002)
    expect(r(S5 + 4)).toBe(0)
    expect(r(DMA1 + 0x04) & (1 << 11), "HISR.TCIF5").not.toBe(0)
    const s = slots(edges, CK, WS, SD)
    const got: number[] = []
    // WS rests high before the first frame (decision, see spi.ts), so the first left channel starts with a fall.
    for (let i = 0; i + 16 < s.length && got.length < 8; i++) if (s[i].ws !== (i ? s[i - 1].ws : true)) got.push(word(s.slice(i + 1, i + 17).map((x) => x.sd)))
    expect(got).toEqual(samples)
  })
})

describe("I²S master receive (RM0090 §28.4.5 reception sequence)", () => {
  /** I2S2 as the F4-Discovery's MP45DT02 link: CK PB10, SD PC3 (AF5); WS on PB12 here so the frame can be checked. */
  function receiver(cfg: number) {
    const b = bare()
    b.af("PB10", 5)
    b.af("PC3", 5)
    b.af("PB12", 5)
    b.plli2s(192, 5)
    b.w(SPI2 + I2SPR, ODD | 12)
    b.w(SPI2 + I2SCFGR, I2SMOD | MASTER_RX | cfg)
    return { ...b, CK: pad("PB10"), SD: pad("PC3"), WS: pad("PB12") }
  }
  /** A transmitter at the other end: puts the next bit of `bits` on SD at every CK falling edge. */
  function transmitter(mcu: Stm32, CK: Pad, SD: Pad, bits: (k: number) => boolean) {
    let k = 0
    let ck = false
    const fallTimes: number[] = []
    mcu.setPad(SD, bits(k++))
    const react = (e: Edge) => {
      if (key(e.pad) !== key(CK) || e.level === null || e.level === ck) return
      ck = e.level
      if (!ck) {
        fallTimes.push(e.time)
        mcu.setPadAt(SD, bits(k++), e.time)
      }
    }
    return { react, fallTimes }
  }
  const pattern = (k: number) => ((0x9b5e3a71 >>> (31 - (k % 32))) & 1) === 1 !== ((k >> 5) % 3 === 2)

  it("Philips 16-bit: receives the bits a transmitter puts after each WS change, Left/Right in CHSIDE, BSY low", () => {
    const { mcu, w, r, capture, CK, SD, WS } = receiver(PHILIPS | DAT16)
    const tx = transmitter(mcu, CK, SD, pattern)
    w(SPI2 + I2SCFGR, I2SMOD | MASTER_RX | PHILIPS | DAT16 | I2SE)
    const got: { v: number; side: number }[] = []
    let bsy = 0
    const edges = capture(0.0003, tx.react, () => {
      const sr = r(SPI2 + SR)
      bsy |= sr & BSY
      if (sr & RXNE) got.push({ v: r(SPI2 + DR), side: sr & CHSIDE ? 1 : 0 })
    })
    expect(bsy, "BSY is kept low in master receive (§28.4.7)").toBe(0)
    expect(r(SPI2 + SR) & OVR).toBe(0)
    // Reference: the bit on SD in the slot that starts at falls[k] is pattern(k); falls[0] is CK
    // taking its steady state at I2SE, the start of slot 0.
    const falls = on(edges, CK).filter((e) => e.level === false).map((e) => e.time)
    const wsChanges = on(edges, WS).slice(1)
    const expected: { v: number; side: number }[] = []
    for (const c of wsChanges) {
      const k = falls.indexOf(c.time) + 1 // WS changes at the start of slot k-1, the MSB follows one CK later
      if (k <= 0 || k + 16 > falls.length) continue
      let v = 0
      for (let j = 0; j < 16; j++) v = v * 2 + (pattern(k + j) ? 1 : 0)
      expected.push({ v, side: c.level ? 1 : 0 })
    }
    expect(expected.length).toBeGreaterThan(20)
    expect(got.slice(0, expected.length - 1)).toEqual(expected.slice(0, expected.length - 1))
  })

  it("MSB-justified 16-bit in 32 (the PDM library's set-up): one halfword per channel, the 16 LSB slots ignored", () => {
    const { mcu, w, r, capture, CK, SD, WS } = receiver(MSB | DAT16 | CH32)
    const tx = transmitter(mcu, CK, SD, pattern)
    w(SPI2 + I2SCFGR, I2SMOD | MASTER_RX | MSB | DAT16 | CH32 | I2SE)
    const got: number[] = []
    const edges = capture(0.0004, tx.react, () => {
      if (r(SPI2 + SR) & RXNE) got.push(r(SPI2 + DR))
    })
    const falls = on(edges, CK).filter((e) => e.level === false).map((e) => e.time)
    const expected: number[] = []
    for (const c of on(edges, WS).slice(1)) {
      const k = falls.indexOf(c.time) // MSB in the slot that starts with the WS change
      if (k < 0 || k + 16 > falls.length) continue
      let v = 0
      for (let j = 0; j < 16; j++) v = v * 2 + (pattern(k + j) ? 1 : 0)
      expected.push(v)
    }
    expect(expected.length).toBeGreaterThan(10)
    expect(got.slice(0, expected.length - 1)).toEqual(expected.slice(0, expected.length - 1))
  })

  it("OVR when DR is not read: the newer data is lost, DR returns the older, DR then SR read clears it; ERRIE raises IRQ 36 (§28.4.8)", () => {
    const { mcu, w, r, capture, CK, SD } = receiver(MSB | DAT16)
    const tx = transmitter(mcu, CK, SD, (k) => k < 16) // first halfword 0xFFFF, then zeros
    w(SPI2 + CR2, ERRIE)
    w(SPI2 + I2SCFGR, I2SMOD | MASTER_RX | MSB | DAT16 | I2SE)
    capture(0.0001, tx.react)
    const sr = r(SPI2 + SR)
    expect(sr & (OVR | RXNE)).toBe(OVR | RXNE)
    expect(r(ISPR1) & (1 << (36 - 32))).not.toBe(0)
    expect(r(SPI2 + DR), "the first, correctly received halfword").toBe(0xffff)
    expect(r(SPI2 + SR) & OVR).toBe(OVR) // the SR read that armed nothing yet (DR read first, then SR)
    expect(r(SPI2 + SR) & OVR).toBe(0)
  })

  it("RXDMAEN: the RX request line follows RXNE", () => {
    const { mcu, w, r, capture, CK, SD } = receiver(MSB | DAT16)
    const tx = transmitter(mcu, CK, SD, () => false)
    w(SPI2 + CR2, RXDMAEN)
    w(SPI2 + I2SCFGR, I2SMOD | MASTER_RX | MSB | DAT16 | I2SE)
    expect(mcu.spi[1].dmaLevel("rx")).toBe(false)
    capture(2e-5, tx.react)
    expect(mcu.spi[1].dmaLevel("rx")).toBe(true)
    r(SPI2 + DR)
    expect(mcu.spi[1].dmaLevel("rx")).toBe(false)
  })
})

describe("I²S limits", () => {
  it("slave modes are reported as not modelled and keep the pads released", () => {
    const { mcu, w, capture, CK } = i2s3()
    w(SPI3 + I2SCFGR, I2SMOD | SLAVE_TX | PHILIPS | DAT16 | I2SE)
    expect([...mcu.unmodelled.features.keys()]).toContain("SPI3 I²S slave mode")
    expect(on(capture(1e-5), CK).filter((e) => e.level !== null)).toEqual([])
  })

  it("SPI1 has no I²S (RM0090 §28.2.2: I2S2 and I2S3 only)", () => {
    const { mcu, w } = bare()
    w(RCC + 0x44, 1 << 12)
    w(0x40013000 + I2SCFGR, I2SMOD)
    expect([...mcu.unmodelled.features.keys()]).toContain("SPI1 I²S")
  })
})
