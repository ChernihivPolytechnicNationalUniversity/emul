/**
 * AVR ADC and analog comparator (DS40002061B §24, §23).
 *
 * ADC: a 7-bit prescaler that runs while ADEN is set (reset by an auto-trigger), conversions
 * that start on the next ADC clock edge, sample at 1.5 ADC clocks (13.5 for the first, 2 when
 * auto-triggered) and finish after 13 (25, 13.5) — Table 24-1. MUX/REFS are latched at the
 * start, the result goes to ADCL/ADCH unless ADCL was read and ADCH not yet (§24.2), ADIF
 * sets regardless. The input is the circuit's voltage on the pad at the sample instant (the
 * loop solves the circuit every step), the bandgap (1.1 V), the temperature sensor (Table
 * 24-2) or GND.
 *
 * Comparator: AIN0 or the bandgap against AIN1 or an ADC channel (Table 23-1), re-evaluated
 * whenever the circuit's voltages change; ACO follows one to two cycles later (§23.3.2).
 */
import { Peripheral, type AvrBus } from "../io"
import type { AvrMcu } from "../mcu"
import type { PadRef } from "../../pads"

const ADEN = 0x80
const ADSC = 0x40
const ADATE = 0x20
const ADIF = 0x10
const ADIE = 0x08

/** Temperature sensor output, mV, by temperature (Table 24-2, typical), linear between the points. */
const TEMP_POINTS: [number, number][] = [
  [-45, 242],
  [25, 314],
  [85, 380],
]
export function temperatureSensorVolts(celsius: number): number {
  const p = TEMP_POINTS
  const i = celsius <= p[1][0] ? 0 : 1
  const [t0, v0] = p[i]
  const [t1, v1] = p[i + 1]
  return (v0 + ((celsius - t0) * (v1 - v0)) / (t1 - t0)) / 1000
}

export type AdcSpec = {
  /** ADC0… pads; channels without a pin on the package are null. */
  channels: (PadRef | null)[]
  vector: number
  prr: number
}

export class Adc extends Peripheral {
  readonly name = "ADC"
  override readonly domain = "adc" as const
  private readonly mcu: AvrMcu
  readonly spec: AdcSpec
  adcsra = 0
  adcsrb = 0
  admux = 0
  didr0 = 0
  private result = 0
  private locked = false
  /** Edge the prescaler counts from (ADEN set, or an auto-trigger reset). */
  private base = 0
  private first = true
  /** Conversion in flight: start edge, sample instant, completion; latched MUX/REFS. */
  private conv: { sample: number; done: number; mux: number; refs: number; held: number | null } | null = null

  constructor(bus: AvrBus, mcu: AvrMcu, spec: AdcSpec) {
    super(bus)
    this.mcu = mcu
    this.spec = spec
    const reg = (addr: number, name: string, read: () => number, write: (v: number, m: number) => void) =>
      bus.register(addr, {
        name,
        read: () => (bus.powerReduced(spec.prr) ? 0 : (this.sync(this.now), read())),
        write: (v, m) => {
          if (bus.powerReduced(spec.prr)) return
          this.sync(this.now)
          write(v, m)
          this.plan()
        },
      })
    reg(0x7a, "ADCSRA", () => this.adcsra | (this.conv ? ADSC : 0), (v, m) => this.writeA(v, m))
    reg(0x7b, "ADCSRB", () => this.adcsrb, (v) => this.writeB(v))
    reg(0x7c, "ADMUX", () => this.admux, (v) => {
      this.admux = v & 0xef
      if ((v >> 6) === 2) this.mcu.feature("ADC: reserved reference selection REFS = 10")
      this.mcu.analogChanged()
    })
    reg(0x7e, "DIDR0", () => this.didr0, (v) => {
      this.didr0 = v & 0x3f
      this.bus.pinsChanged()
    })
    reg(0x78, "ADCL", () => {
      this.locked = true
      return this.admux & 0x20 ? (this.result << 6) & 0xc0 : this.result & 0xff
    }, () => {})
    reg(0x79, "ADCH", () => {
      this.locked = false
      return this.admux & 0x20 ? this.result >> 2 : this.result >> 8
    }, () => {})
    bus.irq.add({
      vector: spec.vector,
      pending: () => (this.adcsra & (ADIE | ADIF)) === (ADIE | ADIF),
      acknowledge: () => {
        this.adcsra &= ~ADIF
      },
    })
  }

  private get enabled() {
    return (this.adcsra & ADEN) !== 0
  }
  private get div() {
    return [2, 2, 4, 8, 16, 32, 64, 128][this.adcsra & 7]
  }
  /** First ADC clock rising edge strictly after `cycle`. */
  private nextClock(cycle: number) {
    const d = this.div
    return this.base + (Math.floor((cycle - this.base) / d) + 1) * d
  }

  private writeA(v: number, m: number) {
    const at = this.now
    const was = this.adcsra
    // ADIF clears by writing one; ADSC is set by writing one, never cleared by writing zero.
    const flagClear = v & m & ADIF
    this.adcsra = ((this.adcsra & ~m) | (v & m)) & ~ADIF & ~ADSC
    this.adcsra |= was & ADIF & ~flagClear
    if (!(this.adcsra & ADEN)) {
      // Off: any conversion is abandoned; the prescaler is held in reset.
      this.conv = null
      this.first = true
      return
    }
    if (!(was & ADEN)) {
      this.base = at + 1
      this.first = true
    }
    if (v & m & ADSC && !this.conv) this.start(this.nextClock(at), false)
    this.mcu.analogChanged()
  }
  /** Silicon erratum 2.4.1 (DS80000855C): ACME set while MUX3 = 1 turns every analog MUX off until ACME is cleared. */
  muxOff = false
  private writeB(v: number) {
    const before = this.triggerFlagSet()
    if (v & 0x40 && !(this.adcsrb & 0x40) && this.admux & 0x08 && this.mcu.hasErratum("2.4.1")) {
      this.muxOff = true
      this.mcu.feature("ADC/AC: analog MUX off — silicon erratum 2.4.1 (ACME set while MUX3 = 1)")
    }
    if (!(v & 0x40)) this.muxOff = false
    this.adcsrb = v & 0x47
    // Switching to a source whose flag is already set is a rising edge (§24.9.4); not for free running.
    if ((this.adcsrb & 7) !== 0 && !before && this.triggerFlagSet()) this.trigger(this.now + 1)
    this.mcu.analogChanged()
  }

  /** Begin a conversion whose first ADC clock is `edge`. */
  private start(edge: number, triggered: boolean) {
    const d = this.div
    const first = this.first
    this.first = false
    const sampleAfter = first ? 13.5 : triggered ? 2 : 1.5
    const length = first ? 25 : triggered ? 13.5 : 13
    this.conv = {
      sample: edge + sampleAfter * d,
      done: edge + length * d,
      mux: this.admux & 0x0f,
      refs: this.admux >> 6,
      held: null,
    }
  }

  /** An auto-trigger source's flag rose at `edge` (Table 24-6). */
  trigger(edge: number) {
    if (!this.enabled || !(this.adcsra & ADATE) || this.conv) return
    // The prescaler is reset at the trigger, and three CPU cycles go to synchronization (§24.4).
    this.base = edge + 3
    this.start(this.base, true)
    this.plan()
  }
  /** The selected auto-trigger source (ADTS), for the SoC to route flags. */
  get triggerSource() {
    return this.adcsra & ADATE ? this.adcsrb & 7 : -1
  }
  /** Whether the selected source's flag is set now (asked through `flagOf`). */
  flagOf: (source: number) => boolean = () => false
  private triggerFlagSet() {
    const s = this.adcsrb & 7
    return s !== 0 && this.flagOf(s)
  }

  /** Voltage the multiplexer passes for a channel. */
  channelVolts(mux: number): number {
    if (mux === 14) return this.mcu.chip.electrical.bandgap
    if (mux === 15) return 0
    if (mux === 8) return temperatureSensorVolts(this.mcu.temperature)
    const pad = this.spec.channels[mux]
    if (!pad || this.muxOff) return 0
    return this.mcu.analogRead(pad) ?? 0
  }
  private referenceVolts(refs: number): number {
    if (refs === 1) return this.mcu.vcc
    if (refs === 3) return this.mcu.chip.electrical.bandgap
    return this.mcu.aref ?? 0
  }

  override sync(cycle: number) {
    while (this.conv) {
      const c = this.conv
      if (c.held === null) {
        if (cycle < c.sample) return
        const vin = this.channelVolts(c.mux)
        const vref = this.referenceVolts(c.refs)
        c.held = vref <= 0 ? (vin > 0 ? 1023 : 0) : Math.max(0, Math.min(1023, Math.floor((vin * 1024) / vref)))
      }
      if (cycle < c.done) return
      const done = c.done
      this.conv = null
      if (!this.locked) this.result = c.held
      this.adcsra |= ADIF
      this.bus.irq.update()
      // Free running: the next conversion starts at once (ADIF as trigger, whether or not it was cleared).
      if (this.adcsra & ADATE && (this.adcsrb & 7) === 0) this.start(Math.ceil(done), false)
    }
  }

  override onSleep(mode: string, cycle: number) {
    // Idle and ADC Noise Reduction start a conversion if the ADC is on and idle (§24.6).
    if ((mode === "idle" || mode === "adc-noise") && this.enabled && !this.conv) {
      this.start(this.nextClock(cycle), false)
      this.plan()
    }
  }

  reset() {
    this.adcsra = this.adcsrb = this.admux = this.didr0 = 0
    this.result = 0
    this.locked = false
    this.first = true
    this.conv = null
    this.due = Infinity
  }

  /** DIDR0 terms for PC0–PC5 (Table 14-8: DIEOE = … + ADCnD, DIEOV = PCINTn·PCIE1). */
  digitalInputDisabled(channel: number): boolean {
    return (this.didr0 & (1 << channel)) !== 0
  }

  private plan() {
    this.due = this.conv ? (this.conv.held === null ? this.conv.sample : this.conv.done) : Infinity
    this.due = Math.ceil(this.due)
    this.bus.reschedule()
  }
  override service(cycle: number) {
    this.sync(cycle)
    this.plan()
  }
}

/** The analog comparator (§23). */
export class AnalogComparator extends Peripheral {
  readonly name = "AC"
  override readonly domain = "none" as const
  private readonly mcu: AvrMcu
  private readonly adc: Adc
  private readonly ain0: PadRef
  private readonly ain1: PadRef
  acsr = 0
  didr1 = 0
  private aco = false
  private aci = false
  /** Pending output change: the level and the cycle it shows in ACO (after the synchronizer). */
  private pending: { level: boolean; at: number } | null = null
  readonly onOutput: ((level: boolean, cycle: number) => void)[] = []
  readonly onAci: ((cycle: number) => void)[] = []

  constructor(bus: AvrBus, mcu: AvrMcu, adc: Adc, pins: { ain0: PadRef; ain1: PadRef }, vector: number) {
    super(bus)
    this.mcu = mcu
    this.adc = adc
    this.ain0 = pins.ain0
    this.ain1 = pins.ain1
    bus.register(0x50, {
      name: "ACSR",
      read: () => {
        this.sync(this.bus.cpu.at)
        return (this.acsr & 0xdf) | (this.aco ? 0x20 : 0) | (this.aci ? 0x10 : 0)
      },
      write: (v, m) => {
        this.sync(this.bus.cpu.at)
        if (v & m & 0x10) this.aci = false
        this.acsr = ((this.acsr & ~m) | (v & m)) & 0xcf
        this.evaluate()
        this.bus.irq.update()
      },
    })
    bus.register(0x7f, {
      name: "DIDR1",
      read: () => this.didr1,
      write: (v) => {
        this.didr1 = v & 3
        this.bus.pinsChanged()
      },
    })
    bus.irq.add({
      vector,
      pending: () => this.aci && (this.acsr & 0x08) !== 0,
      acknowledge: () => {
        this.aci = false
      },
    })
    mcu.analogListeners.push(() => this.evaluate())
  }

  /** Comparator output now: positive input above negative (Table 23-1 for the negative input). */
  private compare(): boolean {
    const pos = this.acsr & 0x40 ? this.mcu.chip.electrical.bandgap : this.mcu.analogRead(this.ain0) ?? 0
    const acme = (this.adc.adcsrb & 0x40) !== 0 && !(this.adc.adcsra & 0x80)
    const neg = acme ? this.adc.channelVolts(this.adc.admux & 7) : this.mcu.analogRead(this.ain1) ?? 0
    return pos > neg
  }

  private evaluate() {
    if (this.acsr & 0x80) return
    const level = this.compare()
    const target = this.pending ? this.pending.level : this.aco
    if (level === target) return
    // Synchronized into ACO with a delay of one to two cycles (§23.3.2).
    this.pending = { level, at: this.bus.cpu.cycles + 2 }
    this.due = this.pending.at
    this.bus.reschedule()
  }

  override sync(cycle: number) {
    const p = this.pending
    if (!p || cycle < p.at) return
    this.pending = null
    this.due = Infinity
    if (p.level === this.aco) return
    this.aco = p.level
    const mode = this.acsr & 3
    if (mode === 0 || (mode === 3 && p.level) || (mode === 2 && !p.level)) {
      this.aci = true
      for (const f of this.onAci) f(p.at)
    }
    for (const f of this.onOutput) f(p.level, p.at)
    this.bus.irq.update()
  }
  override service(cycle: number) {
    this.sync(cycle)
    this.bus.reschedule()
  }

  /** Whether ACSR.ACIC routes the output to Timer1's input capture. */
  get capture() {
    return (this.acsr & 0x04) !== 0
  }

  reset() {
    this.acsr = 0
    this.didr1 = 0
    this.aci = false
    this.pending = null
    this.due = Infinity
  }
}
