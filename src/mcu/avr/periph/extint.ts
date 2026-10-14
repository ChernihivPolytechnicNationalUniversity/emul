/**
 * External interrupts INT0/INT1 and the pin change interrupts PCINT0–2 (DS40002061B §13).
 *
 * Flags rise after the pin's own synchronizer: the change is seen at the first clock edge at
 * least half a cycle after it (as PINx is, Figure 14-3); a pin change flag then takes two more
 * edges (pcint_syn, pcint_setflag in Figure 13-1). For INTn edges the data sheet gives no
 * figure: one edge after the synchronizer is assumed. Edges on INTn need the I/O clock;
 * pin changes and the INTn low level are detected asynchronously and wake the part from
 * every sleep mode (§13, Table 10-1).
 */
import { Peripheral, type AvrBus } from "../io"
import type { AvrMcu } from "../mcu"

/** First clock edge that sees a change at (fractional) cycle `t` through a synchronizer. */
export const syncEdge = (t: number) => Math.ceil(t + 0.5)

export type ExtIntPins = {
  /** INT0, INT1 as [port index, pin]. */
  int: [number, number][]
  /** Pin change group by port index: group number and the PCINT bit of pin 0 within the group's mask. */
  groups: Map<number, number>
}

export class ExtInt extends Peripheral {
  readonly name = "EXINT"
  override readonly domain = "none" as const
  eicra = 0
  eimsk = 0
  eifr = 0
  pcicr = 0
  pcifr = 0
  readonly pcmsk = [0, 0, 0]
  private readonly queue: { cycle: number; set: () => void }[] = []
  /** INTF0 rises (ADC auto trigger source 2). */
  readonly onInt0: ((cycle: number) => void)[] = []
  private readonly mcu: AvrMcu
  private readonly pins: ExtIntPins

  constructor(bus: AvrBus, mcu: AvrMcu, pins: ExtIntPins, vectors: { int: number[]; pcint: number[] }) {
    super(bus)
    this.mcu = mcu
    this.pins = pins
    bus.register(0x69, { name: "EICRA", read: () => this.eicra, write: (v) => this.set(() => (this.eicra = v & 0x0f)) })
    bus.register(0x3d, { name: "EIMSK", read: () => this.eimsk, write: (v, m) => this.set(() => (this.eimsk = ((this.eimsk & ~m) | (v & m)) & 0x03)) })
    bus.register(0x3c, { name: "EIFR", read: () => this.eifrValue(), write: (v, m) => this.set(() => (this.eifr &= ~(v & m))) })
    bus.register(0x68, { name: "PCICR", read: () => this.pcicr, write: (v) => this.set(() => (this.pcicr = v & 0x07), true) })
    bus.register(0x3b, { name: "PCIFR", read: () => this.pcifr, write: (v, m) => this.set(() => (this.pcifr &= ~(v & m))) })
    for (let g = 0; g < 3; g++) bus.register(0x6b + g, { name: `PCMSK${g}`, read: () => this.pcmsk[g], write: (v) => this.set(() => (this.pcmsk[g] = v), true) })
    vectors.int.forEach((vector, n) =>
      bus.irq.add({
        vector,
        pending: () => (this.eimsk & (1 << n) ? (this.isc(n) === 0 ? this.levelLow(n) : (this.eifr & (1 << n)) !== 0) : false),
        acknowledge: () => {
          this.eifr &= ~(1 << n)
        },
        // Edges need the I/O clock (Table 10-1 note: INT0/INT1 wake from the deep modes on level only).
        wakes: () => this.isc(n) === 0 || this.mcu.sleepMode === "idle",
      }),
    )
    vectors.pcint.forEach((vector, g) =>
      bus.irq.add({
        vector,
        pending: () => (this.pcicr & (1 << g)) !== 0 && (this.pcifr & (1 << g)) !== 0,
        acknowledge: () => {
          this.pcifr &= ~(1 << g)
        },
      }),
    )
    mcu.inputListeners.push((port, pin, level, cycle) => this.input(port, pin, level, cycle))
  }

  private isc(n: number) {
    return (this.eicra >> (2 * n)) & 3
  }
  private levelLow(n: number) {
    const [port, pin] = this.pins.int[n]
    return !this.mcu.ports.find((p) => p.index === port)!.di(pin)
  }
  /** INTFn reads zero while INTn is configured as a level interrupt (§13.2.3). */
  private eifrValue() {
    let v = this.eifr
    for (let n = 0; n < 2; n++) if (this.isc(n) === 0) v &= ~(1 << n)
    return v
  }

  private set(change: () => void, pins = false) {
    change()
    if (pins) this.bus.pinsChanged()
    this.bus.irq.update()
  }

  reset() {
    this.eicra = this.eimsk = this.eifr = this.pcicr = this.pcifr = 0
    this.pcmsk.fill(0)
    this.queue.length = 0
    this.due = Infinity
  }

  private input(port: number, pin: number, level: boolean, cycle: number) {
    const seen = syncEdge(cycle)
    this.pins.int.forEach(([p, b], n) => {
      if (p !== port || b !== pin) return
      const isc = this.isc(n)
      if (isc === 0) {
        // Level: requested while low, no flag; the core re-evaluates now.
        this.bus.irq.update()
        return
      }
      if (!this.mcu.ioClock) return
      if (isc === 1 || (isc === 2 && !level) || (isc === 3 && level))
        this.after(seen + 1, () => {
          const rising = !(this.eifr & (1 << n))
          this.eifr |= 1 << n
          if (rising && n === 0) for (const f of this.onInt0) f(seen + 1)
        })
    })
    const group = this.pins.groups.get(port)
    if (group !== undefined && this.pcmsk[group] & (1 << pin)) this.after(seen + 2, () => (this.pcifr |= 1 << group))
  }

  private after(cycle: number, set: () => void) {
    this.queue.push({ cycle, set })
    this.queue.sort((a, b) => a.cycle - b.cycle)
    this.due = this.queue[0].cycle
    this.bus.reschedule()
  }

  override service(cycle: number) {
    while (this.queue.length && this.queue[0].cycle <= cycle) this.queue.shift()!.set()
    this.due = this.queue.length ? this.queue[0].cycle : Infinity
    this.bus.irq.update()
  }

  /** DIEOE terms this block contributes: the pin's input stays on in sleep when its interrupt is enabled (Tables 14-4…14-11). */
  keepsInput(port: number, pin: number): boolean {
    const group = this.pins.groups.get(port)
    if (group !== undefined && this.pcicr & (1 << group) && this.pcmsk[group] & (1 << pin)) return true
    return this.pins.int.some(([p, b], n) => p === port && b === pin && (this.eimsk & (1 << n)) !== 0)
  }
}
