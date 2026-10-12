import { describe, expect, it } from "vitest"
import { Usart, USART_SPECS, type UsartFlavour } from "@/mcu/periph/usart"

const USART3 = USART_SPECS[2]
const BIT_CYCLES = 64
const V2 = { CR1: 0x00, CR2: 0x04, CR3: 0x08, BRR: 0x0c, RQR: 0x18, ISR: 0x1c, ICR: 0x20, RDR: 0x24, TDR: 0x28 }
const V1 = { SR: 0x00, DR: 0x04, BRR: 0x08, CR1: 0x0c, CR2: 0x10, CR3: 0x14 }
const CR1 = { UE: 1 << 0, RE: 1 << 2, TE: 1 << 3, PCE: 1 << 10, M0: 1 << 12, CMIE: 1 << 14 }
const CR1_V1 = { RE: 1 << 2, TE: 1 << 3, PCE: 1 << 10, UE: 1 << 13 }
const CR2 = { RXINV: 1 << 16, TXINV: 1 << 17, DATAINV: 1 << 18, MSBFIRST: 1 << 19, ADD: (c: number) => c << 24 }
const CR3 = { DMAR: 1 << 6, OVRDIS: 1 << 12, DDRE: 1 << 13 }
const ISR = { FE: 1 << 1, ORE: 1 << 3, RXNE: 1 << 5, CMF: 1 << 17 }
const ICR = { FECF: 1 << 1, CMCF: 1 << 17 }
const ON = CR1.UE | CR1.RE | CR1.TE

type Options = { cr1?: number; cr2?: number; cr3?: number }

function v2({ cr1 = 0, cr2 = 0, cr3 = 0 }: Options = {}) {
  const u = new Usart(USART3, "v2")
  u.setClock(16e6, 16e6)
  let pin: boolean | null = null
  let pad = true
  const interrupts: number[] = []
  const dmaRequests: string[] = []
  u.onTx = (level) => (pin = level)
  u.raiseIrq = (irq) => interrupts.push(irq)
  u.onDmaRequest = (line) => dmaRequests.push(line)
  u.write(V2.BRR, BIT_CYCLES, 4)
  u.write(V2.CR2, cr2, 4)
  u.write(V2.CR3, cr3, 4)
  u.write(V2.CR1, cr1 | ON, 4)
  const setPad = (level: boolean) => {
    if (level === pad) return
    pad = level
    u.rxEdge(level)
  }
  return {
    u,
    interrupts,
    dmaRequests,
    pin: () => pin,
    read: (reg: keyof typeof V2) => u.read(V2[reg], 4) >>> 0,
    write: (reg: keyof typeof V2, value: number) => u.write(V2[reg], value, 4),
    transmit(word: number, bits: number) {
      const levels: (boolean | null)[] = []
      u.write(V2.TDR, word, 4)
      for (let i = 0; i < bits; i++) {
        levels.push(pin)
        u.tick(BIT_CYCLES)
      }
      return levels
    },
    receive(line: boolean[]) {
      for (const level of line) {
        setPad(level)
        u.tick(BIT_CYCLES)
      }
    },
    idle(level: boolean) {
      setPad(level)
      u.tick(BIT_CYCLES * 12)
    },
  }
}

const frame = (word: number, dataBits: number, { msbFirst = false, inverted = false, parity = null as boolean | null } = {}) => {
  const data = Array.from({ length: dataBits }, (_, i) => ((word >>> (msbFirst ? dataBits - 1 - i : i)) & 1) === 1)
  return [false, ...data.map((b) => b !== inverted), ...(parity === null ? [] : [parity !== inverted]), true]
}
const invertLine = (line: boolean[]) => line.map((b) => !b)

describe("STM32F746 USART line options (RM0385 §31.8.2–31.8.3)", () => {
  it("TXINV drives the TX pin inverted, idle included", () => {
    const t = v2({ cr2: CR2.TXINV })
    expect(t.pin(), "idle level").toBe(false)
    expect(t.transmit(0x55, 10)).toEqual(invertLine(frame(0x55, 8)))
  })

  it("RXINV receives an inverted line, which idles low", () => {
    const t = v2({ cr2: CR2.RXINV })
    t.idle(false)
    t.receive(invertLine(frame(0xa5, 8)))
    t.idle(false)
    expect.soft(t.read("ISR") & (ISR.FE | ISR.RXNE), "flags").toBe(ISR.RXNE)
    expect.soft(t.read("RDR")).toBe(0xa5)
  })

  it("DATAINV inverts the data bits and the parity bit, not start and stop", () => {
    const t = v2({ cr1: CR1.M0 | CR1.PCE, cr2: CR2.DATAINV })
    expect(t.transmit(0x0f, 11)).toEqual(frame(0x0f, 8, { inverted: true, parity: false }))
    const r = v2({ cr1: CR1.M0 | CR1.PCE, cr2: CR2.DATAINV })
    r.receive(frame(0x0f, 8, { inverted: true, parity: false }))
    r.idle(true)
    expect.soft(r.read("ISR") & 1, "no parity error").toBe(0)
    expect.soft(r.read("RDR")).toBe(0x0f)
  })

  it("MSBFIRST sends and takes the most significant bit first", () => {
    const t = v2({ cr2: CR2.MSBFIRST })
    expect(t.transmit(0x01, 10)).toEqual(frame(0x01, 8, { msbFirst: true }))
    t.receive(frame(0xc4, 8, { msbFirst: true }))
    t.idle(true)
    expect(t.read("RDR")).toBe(0xc4)
  })

  it("OVRDIS: a word that arrives over an unread one replaces it and raises no overrun", () => {
    const flagged = v2()
    const quiet = v2({ cr3: CR3.OVRDIS })
    for (const t of [flagged, quiet]) {
      t.receive(frame(0x11, 8))
      t.receive(frame(0x22, 8))
      t.idle(true)
    }
    expect.soft(flagged.read("ISR") & ISR.ORE, "overrun without OVRDIS").toBe(ISR.ORE)
    expect.soft(flagged.read("RDR"), "the first word stays without OVRDIS").toBe(0x11)
    expect.soft(quiet.read("ISR") & ISR.ORE, "overrun with OVRDIS").toBe(0)
    expect.soft(quiet.read("RDR"), "the second word with OVRDIS").toBe(0x22)
  })

  it("DDRE=0 with DMA: a framing error keeps RXNE low, so the DMA never takes the bad word", () => {
    const t = v2({ cr3: CR3.DMAR })
    t.receive([false, ...Array(8).fill(true), false])
    t.idle(true)
    expect.soft(t.read("ISR") & (ISR.FE | ISR.RXNE), "FE without RXNE").toBe(ISR.FE)
    expect.soft(t.u.dmaLevel("rx"), "DMA request").toBe(false)
    t.receive(frame(0x42, 8))
    t.idle(true)
    expect.soft(t.u.dmaLevel("rx"), "the next good word is requested").toBe(true)
  })

  it("DDRE=1 with DMA: RXNE rises with the error but the request waits until the error flag is cleared", () => {
    const t = v2({ cr3: CR3.DMAR | CR3.DDRE })
    t.receive([false, ...Array(8).fill(true), false])
    t.idle(true)
    expect.soft(t.read("ISR") & (ISR.FE | ISR.RXNE), "FE and RXNE").toBe(ISR.FE | ISR.RXNE)
    expect.soft(t.u.dmaLevel("rx"), "request while FE is up").toBe(false)
    expect.soft(t.dmaRequests, "no request while FE is up").toEqual([])
    t.write("ICR", ICR.FECF)
    expect.soft(t.u.dmaLevel("rx"), "request after FECF").toBe(true)
    expect.soft(t.dmaRequests, "the request goes out on FECF").toEqual(["rx"])
  })

  it("flags a received character equal to ADD with CMF and interrupts on it with CMIE", () => {
    const t = v2({ cr1: CR1.CMIE, cr2: CR2.ADD(0x0a) })
    t.receive(frame(0x0b, 8))
    t.idle(true)
    expect.soft(t.read("ISR") & ISR.CMF, "another character").toBe(0)
    expect.soft(t.interrupts, "no interrupt for another character").toEqual([])
    t.read("RDR")
    t.receive(frame(0x0a, 8))
    t.idle(true)
    expect.soft(t.read("ISR") & ISR.CMF, "the match").toBe(ISR.CMF)
    expect.soft(t.interrupts, "CMIE").toContain(USART3.irq)
    t.write("ICR", ICR.CMCF)
    expect.soft(t.read("ISR") & ISR.CMF, "after CMCF").toBe(0)
  })
})

describe.each(["v1", "v2"] as UsartFlavour[])("USART %s: the received parity bit reads back in the word's MSB (RM0090 §30.6.2, RM0385 §31.8.10)", (flavour) => {
  it.each([
    ["'A', two ones, even parity 0", 0x41, false, 0x41],
    ["'C', three ones, even parity 1", 0x43, true, 0xc3],
  ])("%s", (_, data, parityBit, readBack) => {
    const u = new Usart(USART3, flavour)
    u.setClock(16e6, 16e6)
    const regs = flavour === "v1" ? { BRR: V1.BRR, CR1: V1.CR1, DATA: V1.DR } : { BRR: V2.BRR, CR1: V2.CR1, DATA: V2.RDR }
    const on = flavour === "v1" ? CR1_V1.UE | CR1_V1.RE | CR1_V1.TE | CR1_V1.PCE : ON | CR1.PCE
    u.write(regs.BRR, BIT_CYCLES, 4)
    u.write(regs.CR1, on, 4)
    let pad = true
    for (const level of frame(data, 7, { parity: parityBit })) {
      if (level !== pad) u.rxEdge((pad = level))
      u.tick(BIT_CYCLES)
    }
    u.tick(BIT_CYCLES * 12)
    expect(u.read(regs.DATA, 4)).toBe(readBack)
  })
})
