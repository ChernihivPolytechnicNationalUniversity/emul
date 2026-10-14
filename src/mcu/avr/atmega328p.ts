/**
 * The ATmega328P assembled: core, ports, and the peripheral blocks wired to their pins by the
 * data sheet's port tables (DS40002061B Tables 14-4…14-11) and to their vectors (Table 12-6).
 */
import { ATMEGA328P } from "./chip"
import { AvrMcu, clockKind } from "./mcu"
import type { PinOverride } from "./port"
import { ANALOG_PORT } from "../pads"
import { ExtInt } from "./periph/extint"
import { Usart } from "./periph/usart"
import { Spi } from "./periph/spi"
import { Twi } from "./periph/twi"
import { Adc, AnalogComparator } from "./periph/adc"
import { Eeprom, SelfProgramming, Watchdog } from "./periph/system"
import { Gtccr, Prescaler, TimerCounter, type ClockSelect, type Wgm } from "./periph/timer"

/** CSn2:0 for Timer/Counter0 and 1 (Tables 15-9, 16-5). */
const CLOCK01 = (cs: number): ClockSelect => (cs === 0 ? { kind: "stop" } : cs <= 5 ? { kind: "div", n: [1, 8, 64, 256, 1024][cs - 1] } : { kind: "ext", rising: cs === 7 })
/** CS22:0 for Timer/Counter2 (Table 18-9). */
const CLOCK2 = (cs: number): ClockSelect => (cs === 0 ? { kind: "stop" } : { kind: "div", n: [1, 8, 32, 64, 128, 256, 1024][cs - 1] })

/** Waveform modes of the 8-bit timers (Tables 15-8 and 18-8). */
const MODES8: Wgm[] = [
  { kind: "normal", top: 0xff, update: "immediate", tov: "max" },
  { kind: "pc", top: 0xff, update: "top", tov: "bottom" },
  { kind: "ctc", top: "ocra", update: "immediate", tov: "max" },
  { kind: "fast", top: 0xff, update: "bottom", tov: "max" },
  null,
  { kind: "pc", top: "ocra", update: "top", tov: "bottom" },
  null,
  { kind: "fast", top: "ocra", update: "bottom", tov: "top" },
]
/** Waveform modes of Timer/Counter1 (Table 16-4). */
const MODES16: Wgm[] = [
  { kind: "normal", top: 0xffff, update: "immediate", tov: "max" },
  { kind: "pc", top: 0x00ff, update: "top", tov: "bottom" },
  { kind: "pc", top: 0x01ff, update: "top", tov: "bottom" },
  { kind: "pc", top: 0x03ff, update: "top", tov: "bottom" },
  { kind: "ctc", top: "ocra", update: "immediate", tov: "max" },
  { kind: "fast", top: 0x00ff, update: "bottom", tov: "top" },
  { kind: "fast", top: 0x01ff, update: "bottom", tov: "top" },
  { kind: "fast", top: 0x03ff, update: "bottom", tov: "top" },
  { kind: "pfc", top: "icr", update: "bottom", tov: "bottom" },
  { kind: "pfc", top: "ocra", update: "bottom", tov: "bottom" },
  { kind: "pc", top: "icr", update: "top", tov: "bottom" },
  { kind: "pc", top: "ocra", update: "top", tov: "bottom" },
  { kind: "ctc", top: "icr", update: "immediate", tov: "max" },
  null,
  { kind: "fast", top: "icr", update: "bottom", tov: "top" },
  { kind: "fast", top: "ocra", update: "bottom", tov: "top" },
]

/** Port indices as PadRef numbers them. */
const B = 1
const C = 2
const D = 3

/** I/O addresses by block, so firmware touching a block that is not modelled is reported by name. */
const BLOCKS: [string, number[]][] = [
  ["TIMER0", [0x44, 0x45, 0x46, 0x47, 0x48, 0x6e, 0x35 + 0x20 - 0x20]],
  ["TIMER1", [0x80, 0x81, 0x82, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x6f, 0x36]],
  ["TIMER2", [0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb6, 0x70, 0x37]],
  ["GTCCR", [0x43]],
  ["USART0", [0xc0, 0xc1, 0xc2, 0xc4, 0xc5, 0xc6]],
  ["SPI", [0x4c, 0x4d, 0x4e]],
  ["TWI", [0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd]],
  ["ADC", [0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7e]],
  ["AC", [0x50, 0x7f]],
  ["WDT", [0x60]],
  ["EEPROM", [0x3f, 0x40, 0x41, 0x42]],
]

export function createAtmega328p(): AvrMcu {
  const blocks = new Map<number, string>()
  for (const [name, addrs] of BLOCKS) for (const a of addrs) blocks.set(a, name)
  // TIFR0 is 0x35, the TIMER0 list above names it through the data-space address.
  blocks.set(0x35, "TIMER0")
  const m = new AvrMcu(ATMEGA328P, blocks)
  const ext = m.attach(
    new ExtInt(
      m,
      m,
      {
        int: [
          [D, 2],
          [D, 3],
        ],
        groups: new Map([
          [B, 0],
          [C, 1],
          [D, 2],
        ]),
      },
      { int: [2, 3], pcint: [4, 5, 6] },
    ),
  )

  /** INTRC: an internal RC oscillator is the clock; EXTCK: an external clock on XTAL1 (Table 14-4 note). */
  const intrc = () => {
    const k = clockKind(m.fuses.low & 0x0f)
    return k === "internal-rc" || k === "internal-128k"
  }
  const extck = () => clockKind(m.fuses.low & 0x0f) === "external"
  const ps01 = new Prescaler()
  const ps2 = new Prescaler()
  const t0 = m.attach(
    new TimerCounter(m, m, {
      name: "TIMER0",
      bits: 8,
      regs: { tccrA: 0x44, tccrB: 0x45, tcnt: 0x46, ocrA: 0x47, ocrB: 0x48, timsk: 0x6e, tifr: 0x35 },
      modes: MODES8,
      clock: CLOCK01,
      vectors: { compA: 15, compB: 16, ovf: 17 },
      pins: { ocA: [D, 6], ocB: [D, 5], t: [D, 4] },
      toggleA: [5, 7],
      prr: 5,
      prescaler: ps01,
    }),
  )
  const t1 = m.attach(
    new TimerCounter(m, m, {
      name: "TIMER1",
      bits: 16,
      regs: { tccrA: 0x80, tccrB: 0x81, tccrC: 0x82, tcnt: 0x84, icr: 0x86, ocrA: 0x88, ocrB: 0x8a, timsk: 0x6f, tifr: 0x36 },
      modes: MODES16,
      clock: CLOCK01,
      vectors: { capt: 11, compA: 12, compB: 13, ovf: 14 },
      pins: { ocA: [B, 1], ocB: [B, 2], t: [D, 5], icp: [B, 0] },
      toggleA: [9, 11, 14, 15],
      prr: 3,
      prescaler: ps01,
    }),
  )
  const t2 = m.attach(
    new TimerCounter(m, m, {
      name: "TIMER2",
      bits: 8,
      regs: { tccrA: 0xb0, tccrB: 0xb1, tcnt: 0xb2, ocrA: 0xb3, ocrB: 0xb4, timsk: 0x70, tifr: 0x37 },
      modes: MODES8,
      clock: CLOCK2,
      vectors: { compA: 8, compB: 9, ovf: 10 },
      pins: { ocA: [B, 3], ocB: [D, 3] },
      toggleA: [5, 7],
      prr: 6,
      prescaler: ps2,
      powerSave: true,
      // TOSC1/TOSC2 share PB6/PB7 with XTAL1/XTAL2: free for the timer oscillator only on the internal RC (§14.3.2).
      async: {
        assr: 0xb6,
        tosc: (exclk) => {
          const feed = m.clockFeed
          if (!intrc() || !feed) return null
          // EXCLK enables the input buffer for a clock; the crystal oscillator runs only with EXCLK = 0 (§18.11.8).
          return exclk && feed.kind !== "clock" ? null : feed.hz
        },
        conflict: () => !intrc(),
      },
    }),
  )
  m.attach(new Gtccr(m, ps01, ps2, [t0, t1, t2]))
  const usart = m.attach(
    new Usart(m, m, {
      name: "USART0",
      regs: { ucsrA: 0xc0, ucsrB: 0xc1, ucsrC: 0xc2, ubrrL: 0xc4, ubrrH: 0xc5, udr: 0xc6 },
      vectors: { rx: 19, udre: 20, tx: 21 },
      pins: { rxd: [D, 0], txd: [D, 1], xck: [D, 4] },
      prr: 1,
      xckOutput: () => (m.port("D").ddr & 0x10) !== 0,
    }),
  )

  // Every pin's alternate functions, each adding its override terms (Tables 14-4…14-11).
  const alt = new Map<number, ((o: PinOverride) => void)[]>()
  const wire = (port: number, pin: number, f: (o: PinOverride) => void) => {
    const key = port * 16 + pin
    alt.set(key, [...(alt.get(key) ?? []), f])
  }
  const AS2 = () => t2.async

  for (const [port, pins] of [
    [B, 8],
    [C, 7],
    [D, 8],
  ] as const)
    for (let pin = 0; pin < pins; pin++) {
      wire(port, pin, (o) => {
        if (ext.keepsInput(port, pin)) {
          o.dieoe = true
          o.dieov = true
        }
      })
    }
  // PB6/XTAL1, PB7/XTAL2 belong to the oscillator unless an internal RC clocks the part (PB7 also when an external clock does).
  wire(B, 6, (o) => {
    const osc = !intrc() || AS2()
    o.puoe = o.ddoe = osc
    o.puov = o.ddov = false
    o.dieoe = osc || ext.keepsInput(B, 6)
    o.dieov = intrc() && !AS2() ? true : false
  })
  wire(B, 7, (o) => {
    const osc = (!intrc() && !extck()) || AS2()
    o.puoe = o.ddoe = osc
    o.puov = o.ddov = false
    o.dieoe = osc || ext.keepsInput(B, 7)
    o.dieov = (intrc() || extck()) && !AS2() ? true : false
  })
  // PC6/RESET: with RSTDISBL unprogrammed the pin is RESET, with its pull-up (Table 14-7).
  wire(C, 6, (o) => {
    const reset = (m.fuses.high & 0x80) !== 0
    if (reset) {
      o.puoe = o.puov = true
      o.ddoe = true
      o.ddov = false
      o.dieoe = true
      o.dieov = false
    } else if (ext.keepsInput(C, 6)) o.dieoe = o.dieov = true
  })
  for (const [t, c] of [
    [t0, 0],
    [t0, 1],
    [t1, 0],
    [t1, 1],
    [t2, 0],
    [t2, 1],
  ] as const) {
    const [port, pin] = c === 0 ? t.spec.pins.ocA : t.spec.pins.ocB
    wire(port, pin, (o) => t.ocOverride(c, o))
  }
  const spi = m.attach(new Spi(m, m, { pins: { ss: [B, 2], mosi: [B, 3], miso: [B, 4], sck: [B, 5] }, vector: 18, prr: 2 }))
  const portB = m.port("B")
  const bit = (port: { port: number }, n: number) => ((port.port >> n) & 1) !== 0
  wire(B, 2, (o) => spi.ssOverride(o, bit(portB, 2), portB.pud))
  wire(B, 3, (o) => spi.mosiOverride(o, bit(portB, 3), portB.pud))
  wire(B, 4, (o) => spi.misoOverride(o, bit(portB, 4), portB.pud))
  wire(B, 5, (o) => spi.sckOverride(o, bit(portB, 5), portB.pud))
  const twi = m.attach(new Twi(m, m, { pins: { sda: [C, 4], scl: [C, 5] }, vector: 25, prr: 7 }))
  const portC = m.port("C")
  wire(C, 4, (o) => twi.override(o, "sda", bit(portC, 4), portC.pud))
  wire(C, 5, (o) => twi.override(o, "scl", bit(portC, 5), portC.pud))
  const adc = m.attach(
    new Adc(m, m, {
      // ADC6/ADC7 are analog-only pins of the 32-pin packages; on PDIP-28 nothing is bonded there.
      channels: [...[0, 1, 2, 3, 4, 5].map((pin) => ({ port: C, pin })), { port: ANALOG_PORT, pin: 6 }, { port: ANALOG_PORT, pin: 7 }],
      vector: 22,
      prr: 0,
    }),
  )
  const ac = m.attach(new AnalogComparator(m, m, adc, { ain0: { port: D, pin: 6 }, ain1: { port: D, pin: 7 } }, 24))
  // ADC auto-trigger sources (Table 24-6) and the comparator as Timer1's capture source.
  const TRIGGERS: [number, () => boolean][] = [
    [1, () => false],
    [2, () => (ext.eifr & 1) !== 0],
    [3, () => (t0.tifr & 2) !== 0],
    [4, () => (t0.tifr & 1) !== 0],
    [5, () => (t1.tifr & 4) !== 0],
    [6, () => (t1.tifr & 1) !== 0],
    [7, () => (t1.tifr & 0x20) !== 0],
  ]
  adc.flagOf = (source) => TRIGGERS.find(([s]) => s === source)?.[1]() ?? false
  const fire = (source: number) => (cycle: number) => {
    if (adc.triggerSource === source) adc.trigger(cycle)
  }
  ac.onAci.push(fire(1))
  ext.onInt0.push(fire(2))
  t0.onFlags.push((bits, edge) => {
    if (bits & 2) fire(3)(edge)
    if (bits & 1) fire(4)(edge)
  })
  t1.onFlags.push((bits, edge) => {
    if (bits & 4) fire(5)(edge)
    if (bits & 1) fire(6)(edge)
    if (bits & 0x20) fire(7)(edge)
  })
  t0.watchFlags = () => (adc.triggerSource === 3 ? 2 : adc.triggerSource === 4 ? 1 : 0)
  t1.watchFlags = () => (adc.triggerSource === 5 ? 4 : adc.triggerSource === 6 ? 1 : adc.triggerSource === 7 ? 0x20 : 0)
  t1.captureFromComparator = () => ac.capture
  ac.onOutput.push((level, cycle) => {
    if (ac.capture) t1.comparatorEdge(level, cycle)
  })
  // DIDR0 (PC0–PC5) and DIDR1 (AIN0 PD6, AIN1 PD7) turn the digital input off unless a pin change interrupt keeps it on.
  for (let n = 0; n < 6; n++)
    wire(C, n, (o) => {
      if (adc.digitalInputDisabled(n) && !ext.keepsInput(C, n)) {
        o.dieoe = true
        o.dieov = false
      }
    })
  for (const [n, pin] of [
    [0, 6],
    [1, 7],
  ] as const)
    wire(D, pin, (o) => {
      if (ac.didr1 & (1 << n) && !ext.keepsInput(D, pin)) {
        o.dieoe = true
        o.dieov = false
      }
    })
  const wdt = m.attach(new Watchdog(m, m, 7))
  m.watchdogRunning = () => wdt.on
  m.attach(new Eeprom(m, m, 23))
  m.attach(new SelfProgramming(m, m))
  const portD = m.port("D")
  wire(D, 0, (o) => usart.rxdOverride(o, (portD.port & 1) !== 0, portD.pud))
  wire(D, 1, (o) => usart.txdOverride(o))
  wire(D, 4, (o) => usart.xckOverride(o))
  m.dutySource = (port, pin) => {
    for (const t of [t0, t1, t2])
      for (const c of [0, 1] as const) {
        const [p, b] = c === 0 ? t.spec.pins.ocA : t.spec.pins.ocB
        if (p === port && b === pin && t.drivesPin(c)) return true
      }
    return false
  }
  for (const [key, fs] of alt) m.ports.find((p) => p.index === key >> 4)!.alt[key & 15] = (o) => {
    for (const f of fs) f(o)
  }
  m.pinsChanged()
  return m
}
