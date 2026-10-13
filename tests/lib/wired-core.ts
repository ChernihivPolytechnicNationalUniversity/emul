import { STM32F746IG } from "@/mcu/chip"
import { parsePad, Stm32, type PadRef } from "@/mcu/stm32f429"
import { buffer, example } from "./firmware"

export type Edge = { time: number; level: boolean }

const key = (p: PadRef) => p.port * 16 + p.pin

export class WiredCore {
  readonly mcu = new Stm32(STM32F746IG)
  private readonly watched = new Map<number, Edge[]>()
  private readonly wires = new Map<number, PadRef[]>()

  constructor(elf: string, options: { watch?: string[]; wires?: [string, string][] } = {}) {
    this.mcu.load(buffer(example(elf)), elf)
    for (const name of options.watch ?? []) this.watched.set(key(parsePad(name)!), [])
    for (const [from, to] of options.wires ?? []) {
      const a = key(parsePad(from)!)
      this.wires.set(a, [...(this.wires.get(a) ?? []), parsePad(to)!])
    }
    for (const k of [...this.watched.keys(), ...this.wires.keys()]) this.mcu.digitalWatch.add(k)
    this.mcu.yieldOnOutput = true
  }

  get time() {
    return this.mcu.time
  }

  edges(pad: string): Edge[] {
    return this.watched.get(key(parsePad(pad)!)) ?? []
  }

  runUntil(end: number) {
    while (this.mcu.time < end) {
      if (!this.mcu.runUntil(end) && !this.mcu.running) throw new Error(`core stopped: ${this.mcu.cpu.halted?.message ?? "?"}`)
      this.deliver()
    }
    this.deliver()
  }

  run(seconds: number) {
    this.runUntil(this.mcu.time + seconds)
  }

  until(condition: () => boolean, within: number, step = 1e-4) {
    const end = this.mcu.time + within
    while (!condition()) {
      if (this.mcu.time >= end) throw new Error("condition never met")
      this.run(step)
    }
  }

  private deliver() {
    for (const out of this.mcu.digitalOut.splice(0)) {
      if (out.level === null) continue
      const k = key(out.pad)
      this.watched.get(k)?.push({ time: out.time, level: out.level })
      for (const to of this.wires.get(k) ?? []) this.mcu.setPadAt(to, out.level, out.time)
    }
  }

  drive(pad: string, level: boolean, time: number) {
    this.mcu.setPadAt(parsePad(pad)!, level, time)
  }

  pulses(pad: string, start: number, high: number, low: number, count: number) {
    for (let i = 0; i < count; i++) {
      const t = start + i * (high + low)
      this.drive(pad, true, t)
      this.drive(pad, false, t + high)
    }
    return start + count * (high + low)
  }

  address(symbol: string) {
    const s = this.mcu.firmware!.symbols.find((x) => x.name === symbol)
    if (!s) throw new Error(`no symbol ${symbol}`)
    return s.value
  }

  word(symbol: string, index = 0) {
    return this.mcu.bus.read32(this.address(symbol) + index * 4) >>> 0
  }

  timer(name: string) {
    const t = this.mcu.tim.find((x) => x.spec.name === name)
    if (!t) throw new Error(`no ${name}`)
    return {
      read: (register: string) => t.read(t.registerList().find((d) => d.name === register)!.offset, 4) >>> 0,
      tim: t,
    }
  }
}
