import type { DigitalEdge, DigitalPart } from "./digital"
import { formatSI } from "./units"

export const HC595_OUTPUTS = ["QA", "QB", "QC", "QD", "QE", "QF", "QG", "QH"] as const
export const HC595_INPUTS = ["SER", "SRCLK", "RCLK", "SRCLR", "OE"] as const
const SERIAL_OUT = "QHS"
const DRIVEN = [...HC595_OUTPUTS, SERIAL_OUT] as const

type Supplied = readonly [atTwo: number, atFourHalf: number, atSix: number]

function across(values: Supplied, vcc: number): number {
  if (vcc <= 4.5) return values[0] + ((values[1] - values[0]) * (vcc - 2)) / 2.5
  return values[1] + ((values[2] - values[1]) * (vcc - 4.5)) / 1.5
}

export type Family = {
  rising: Supplied
  falling: Supplied
  vih: Supplied
  vil: Supplied
  supply: readonly [min: number, max: number]
  edge: Supplied
  clockToOutput: Supplied
  clearToSerial: Supplied
  enable: Supplied
  disable: Supplied
  pulse: Supplied
  clearPulse: Supplied
  dataSetup: Supplied
  latchSetup: Supplied
  recovery: Supplied
  hold: number
}

export const FAMILIES = {
  "74HC595": {
    rising: [1.2, 2.4, 3.2],
    falling: [0.8, 2.1, 2.8],
    vih: [1.5, 3.15, 4.2],
    vil: [0.5, 1.35, 1.8],
    supply: [2, 6],
    edge: [1000e-9, 500e-9, 400e-9],
    clockToOutput: [50e-9, 17e-9, 14e-9],
    clearToSerial: [51e-9, 18e-9, 15e-9],
    enable: [40e-9, 15e-9, 13e-9],
    disable: [42e-9, 23e-9, 20e-9],
    pulse: [80e-9, 16e-9, 14e-9],
    clearPulse: [80e-9, 16e-9, 14e-9],
    dataSetup: [100e-9, 20e-9, 17e-9],
    latchSetup: [75e-9, 15e-9, 13e-9],
    recovery: [50e-9, 10e-9, 9e-9],
    hold: 0,
  },
  "74HCT595": {
    rising: [1.6, 1.6, 1.6],
    falling: [1.2, 1.2, 1.2],
    vih: [2, 2, 2],
    vil: [0.8, 0.8, 0.8],
    supply: [4.5, 5.5],
    edge: [500e-9, 500e-9, 500e-9],
    clockToOutput: [25e-9, 25e-9, 25e-9],
    clearToSerial: [23e-9, 23e-9, 23e-9],
    enable: [30e-9, 30e-9, 30e-9],
    disable: [30e-9, 30e-9, 30e-9],
    pulse: [16e-9, 16e-9, 16e-9],
    clearPulse: [20e-9, 20e-9, 20e-9],
    dataSetup: [16e-9, 16e-9, 16e-9],
    latchSetup: [16e-9, 16e-9, 16e-9],
    recovery: [10e-9, 10e-9, 10e-9],
    hold: 3e-9,
  },
} satisfies Record<string, Family>

export type ShiftRegisterPart = keyof typeof FAMILIES

export const SHIFT_REGISTER_DEFS = { hc595: "74HC595", hct595: "74HCT595" } as const satisfies Record<string, ShiftRegisterPart>

export const shiftRegisterOfDef = (def: string): ShiftRegisterPart | undefined => (Object.hasOwn(SHIFT_REGISTER_DEFS, def) ? SHIFT_REGISTER_DEFS[def as keyof typeof SHIFT_REGISTER_DEFS] : undefined)

const POWER_ON = 1.2
const POWER_OFF = 0.8
const WARNING_HOLD = 0.25
const STUCK_STEPS = 50
const STABLE = 40e-6

export type ShiftRegisterSnapshot = {
  part: string
  powered: boolean
  vcc: number
  shift: number
  storage: number
  enabled: boolean
  warnings: string[]
}

type Input = (typeof HC595_INPUTS)[number]
type Watch = { inBand: number; against: number }

export class ShiftRegister595 implements DigitalPart {
  readonly object: string
  readonly pins = [...HC595_INPUTS, ...DRIVEN]
  readonly supply = { vcc: "$vcc", gnd: "$gnd" }
  readonly out: DigitalEdge[] = []
  private readonly part: ShiftRegisterPart
  private readonly family: Family
  private powered = false
  private vcc = 0
  private shift = 0
  private storage = 0
  private powerUps = 0
  private poweredAt = -Infinity
  private readonly level: Record<Input, boolean> = { SER: false, SRCLK: false, RCLK: false, SRCLR: true, OE: true }
  private readonly changedAt: Record<Input, number> = { SER: -Infinity, SRCLK: -Infinity, RCLK: -Infinity, SRCLR: -Infinity, OE: -Infinity }
  private serBefore = false
  private shiftBefore = 0
  private shiftedAt = -Infinity
  private readonly driven: (boolean | null)[] = DRIVEN.map(() => null)
  private readonly watch = new Map<string, Watch>()
  private readonly warnings = new Map<string, { text: string; at: number }>()
  private time = 0

  constructor(object: string, part: ShiftRegisterPart = "74HC595") {
    this.object = object
    this.part = part
    this.family = FAMILIES[part]
  }

  configure() {}

  reset() {
    this.powered = false
    this.vcc = 0
    this.shift = 0
    this.storage = 0
    this.time = 0
    this.shiftedAt = -Infinity
    for (const pin of HC595_INPUTS) this.changedAt[pin] = -Infinity
    this.driven.fill(null)
    this.out.length = 0
    this.warnings.clear()
    this.watch.clear()
  }

  drive(pin: string): boolean | null {
    const k = DRIVEN.indexOf(pin as (typeof DRIVEN)[number])
    return k < 0 ? null : this.target(k)
  }

  thresholds(): [falling: number, rising: number] {
    const vcc = Math.max(this.vcc, 0)
    return [across(this.family.falling, vcc), across(this.family.rising, vcc)]
  }

  snapshot(): ShiftRegisterSnapshot {
    const warnings: string[] = []
    for (const { text, at } of this.warnings.values()) if (this.time - at <= WARNING_HOLD) warnings.push(text)
    return { part: this.part, powered: this.powered, vcc: this.vcc, shift: this.shift, storage: this.storage, enabled: !this.level.OE, warnings }
  }

  senseSupply(vcc: number, read: (pin: string) => number, time: number) {
    this.time = time
    this.vcc = vcc
    if (!this.powered && vcc >= POWER_ON) this.powerUp(time)
    else if (this.powered && vcc < POWER_OFF) {
      this.powered = false
      this.update(time)
    }
    if (!this.powered) return
    const [min, max] = this.family.supply
    if (vcc < min) this.warn("supply", `VCC ${formatSI(vcc, "V")} is below the ${formatSI(min, "V")} minimum`, time)
    else if (vcc > max) this.warn("supply", `VCC ${formatSI(vcc, "V")} is above the ${formatSI(max, "V")} maximum`, time)
    const vil = across(this.family.vil, vcc)
    const vih = across(this.family.vih, vcc)
    const [falling, rising] = this.thresholds()
    for (const pin of HC595_INPUTS) {
      const v = read(pin)
      if (Number.isNaN(v)) {
        this.warn(`open ${pin}`, `${this.label(pin)} is not connected: a CMOS input left open reads anything`, time)
        continue
      }
      const w = this.watch.get(pin) ?? { inBand: 0, against: 0 }
      w.inBand = v > vil && v < vih ? w.inBand + 1 : 0
      const held = this.level[pin]
      const against = held ? v < falling : v > rising
      w.against = against && time - this.changedAt[pin] >= STABLE ? w.against + 1 : 0
      this.watch.set(pin, w)
      if (w.against >= 2) {
        this.warn(`against ${pin}`, `${this.label(pin)} is driven ${held ? "high" : "low"} but sits at ${formatSI(v, "V")}, which this chip reads as ${held ? "low" : "high"}`, time)
        w.against = 0
        this.input(pin, !held, time)
      }
      if (w.inBand >= STUCK_STEPS)
        this.warn(`band ${pin}`, `${this.label(pin)} at ${formatSI(v, "V")} sits between VIL ${formatSI(vil, "V")} and VIH ${formatSI(vih, "V")}: the level is undefined on a real part`, time)
      else if (w.inBand >= 2)
        this.warn(
          `slow ${pin}`,
          `${this.label(pin)} spends more than one solver step between VIL and VIH; the datasheet allows ${formatSI(across(this.family.edge, vcc), "s")} per edge, and a slow clock edge can clock twice`,
          time,
        )
    }
  }

  input(pin: string, level: boolean, time: number) {
    if (!(HC595_INPUTS as readonly string[]).includes(pin)) return
    const input = pin as Input
    if (this.level[input] === level) return
    if (input === "SER" && this.powered && time >= this.shiftedAt && time - this.shiftedAt <= this.family.hold)
      this.warn("hold", this.family.hold > 0 ? `SER changed ${formatSI(time - this.shiftedAt, "s")} after SRCLK rose; it must hold ${formatSI(this.family.hold, "s")}` : "SER changed on the SRCLK edge itself: hold time violated", time)
    const was = this.changedAt[input]
    if (input === "SER") this.serBefore = this.level.SER
    this.level[input] = level
    this.time = Math.max(this.time, time)
    const settling = !this.powered || time <= this.poweredAt
    this.changedAt[input] = settling ? -Infinity : time
    if (settling) {
      if (input === "SRCLR" && !level) this.shift = 0
      if (input === "SRCLR" || input === "OE") this.update(time)
      return
    }
    const f = this.family
    const vcc = this.vcc
    switch (input) {
      case "SRCLK":
        if (time - was < across(f.pulse, vcc)) this.warn("pulse SRCLK", `SRCLK pulse narrower than the ${formatSI(across(f.pulse, vcc), "s")} minimum`, time)
        if (level) this.clockShift(time)
        break
      case "RCLK":
        if (time - was < across(f.pulse, vcc)) this.warn("pulse RCLK", `RCLK pulse narrower than the ${formatSI(across(f.pulse, vcc), "s")} minimum`, time)
        if (level) this.clockStorage(time)
        break
      case "SRCLR":
        if (level && time - was < across(f.clearPulse, vcc)) this.warn("pulse SRCLR", `/SRCLR low for less than the ${formatSI(across(f.clearPulse, vcc), "s")} minimum`, time)
        if (!level) {
          this.shift = 0
          this.update(time + across(f.clearToSerial, vcc))
        }
        break
      case "OE":
        this.update(time + across(level ? f.disable : f.enable, vcc))
        break
    }
  }

  private clockShift(time: number) {
    const f = this.family
    const vcc = this.vcc
    if (!this.level.SRCLR) return
    if (time - this.changedAt.SRCLR < across(f.recovery, vcc)) this.warn("recovery", "SRCLK rose too soon after /SRCLR went high", time)
    const serAt = this.changedAt.SER
    let ser = this.level.SER
    if (serAt > time) ser = this.serBefore
    else if (serAt >= time - f.hold) {
      ser = this.serBefore
      this.warn("hold", "SER changed on the SRCLK edge itself: hold time violated", time)
    } else if (time - serAt < across(f.dataSetup, vcc)) this.warn("setup SER", `SER changed ${formatSI(time - serAt, "s")} before SRCLK rose; it needs ${formatSI(across(f.dataSetup, vcc), "s")}`, time)
    this.shiftBefore = this.shift
    this.shiftedAt = time
    this.shift = ((this.shift << 1) | (ser ? 1 : 0)) & 0xff
    this.update(time + across(f.clockToOutput, vcc))
  }

  private clockStorage(time: number) {
    const f = this.family
    const vcc = this.vcc
    const gap = time - this.shiftedAt
    if (gap > 0 && gap < across(f.latchSetup, vcc)) this.warn("setup RCLK", `RCLK rose ${formatSI(gap, "s")} after SRCLK; the storage register needs ${formatSI(across(f.latchSetup, vcc), "s")}`, time)
    this.storage = gap <= 0 ? this.shiftBefore : this.shift
    this.update(time + across(f.clockToOutput, vcc))
  }

  private powerUp(time: number) {
    this.powered = true
    this.poweredAt = time
    this.powerUps++
    let h = 0x811c9dc5 ^ this.powerUps
    for (let i = 0; i < this.object.length; i++) h = Math.imul(h ^ this.object.charCodeAt(i), 0x01000193)
    this.shift = h & 0xff
    this.storage = (h >>> 8) & 0xff
    if (!this.level.SRCLR) this.shift = 0
    this.update(time)
  }

  private target(k: number): boolean | null {
    if (!this.powered) return null
    if (k === HC595_OUTPUTS.length) return (this.shift & 0x80) !== 0
    if (this.level.OE) return null
    return ((this.storage >> k) & 1) !== 0
  }

  private update(time: number) {
    for (let k = 0; k < DRIVEN.length; k++) {
      const level = this.target(k)
      if (level === this.driven[k]) continue
      this.driven[k] = level
      this.out.push({ pin: DRIVEN[k], level, time })
    }
  }

  private label(pin: string) {
    return pin === "SRCLR" || pin === "OE" ? `/${pin}` : pin
  }

  private warn(key: string, text: string, time: number) {
    this.warnings.set(key, { text, at: time })
  }
}
