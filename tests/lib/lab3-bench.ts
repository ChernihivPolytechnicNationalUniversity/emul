import { LogicStore } from "@/components/logic/logic-store"
import { parseElf } from "@/mcu/elf"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { buffer, example } from "./firmware"

export const LAB3_ELF = "lab3-variants.elf"
const PT_LOAD = 1
const STATE_BYTES = 828
const LOG = 64

export const PADS = {
  pot1: "CN3-3",
  pot2: "CN3-4",
  rail: "CN2-4",
  ground: "CN2-6",
  r: "P20-10",
  g: "P20-11",
  b: "P20-12",
  r2: "P21-17",
  g2: "P21-16",
  b2: "P21-19",
  r2Pwm: "P20-21",
  g2Pwm: "P20-22",
  b2Pwm: "P20-23",
  direct: "P21-25",
  inverted: "P21-24",
}

export const BALLAST_AT_2_MA = { R: "750 Ω", G: "270 Ω", B: "300 Ω" }

export function withVariant(elf: Buffer, variant: number): Buffer {
  const out = Buffer.from(elf)
  const at = parseElf(buffer(elf)).symbols.find((s) => s.name === "lab3_variant")!.value
  const phoff = out.readUInt32LE(0x1c)
  const phentsize = out.readUInt16LE(0x2a)
  const phnum = out.readUInt16LE(0x2c)
  for (let i = 0; i < phnum; i++) {
    const h = phoff + i * phentsize
    if (out.readUInt32LE(h) !== PT_LOAD) continue
    const offset = out.readUInt32LE(h + 4)
    const vaddr = out.readUInt32LE(h + 8)
    const filesz = out.readUInt32LE(h + 16)
    if (at >= vaddr && at + 4 <= vaddr + filesz) {
      out.writeUInt32LE(variant, offset + at - vaddr)
      return out
    }
  }
  throw new Error("lab3_variant is in no loaded segment")
}

export type Lab3State = {
  variant: number
  scans: number
  level: [number, number]
  band: [number, number]
  filtered: [number, number]
  measured: [number, number]
  leds: [number, number]
  duty: number
  presses: number
  raw: [number[], number[]]
  filteredLog: [number[], number[]]
}

export type Wiring = "pots" | "pwm-pair"
export type Leds = "one" | "two" | "two-on-timers" | "none"

export class Lab3Bench {
  readonly loop = new SimLoop()
  readonly doc: Schematic
  readonly board: PlacedObject
  readonly pots: PlacedObject[] = []
  readonly rgb: PlacedObject[] = []
  readonly store = new LogicStore()
  clock = 0
  private readonly stateAt: number

  constructor(variant: number, wiring: Wiring, leds: Leds, probes: string[]) {
    const elf = withVariant(example(LAB3_ELF), variant)
    this.stateAt = parseElf(buffer(elf)).symbols.find((s) => s.name === "lab3")!.value
    this.doc = lab1Board.build(GRID)
    this.board = this.doc.objects.find((o) => o.def === "open746i-c")!
    const u = this.board
    u.props = { ...u.props, firmware: LAB3_ELF, firmwareData: elf.toString("base64") }
    const b = builder(GRID)
    if (wiring === "pots")
      [PADS.pot1, PADS.pot2].forEach((pad, i) => {
        const pot = b.place("potentiometer", 90, 4 + 12 * i, { value: "10 kΩ", pos: "0" })
        const series = b.place("resistor", 100, 4 + 12 * i, { value: "2 kΩ" })
        b.wire(pot, "1", u, PADS.ground)
        b.wire(pot, "2", u, PADS.rail)
        b.wire(pot, "W", series, "1")
        b.wire(series, "2", u, pad)
        this.pots.push(pot)
      })
    else {
      b.wire(u, PADS.direct, u, PADS.pot1)
      b.wire(u, PADS.inverted, u, PADS.pot2)
    }
    const second = leds === "two-on-timers" ? [PADS.r2Pwm, PADS.g2Pwm, PADS.b2Pwm] : [PADS.r2, PADS.g2, PADS.b2]
    const dies = leds === "none" ? [] : leds === "one" ? [[PADS.r, PADS.g, PADS.b]] : [[PADS.r, PADS.g, PADS.b], second]
    dies.forEach((pads, n) => {
      const led = b.place("rgb-led", 120, 4 + 14 * n)
      b.wire(led, "K", u, PADS.ground)
      ;(["R", "G", "B"] as const).forEach((die, k) => {
        const ballast = b.place("resistor", 110, 4 + 14 * n + 4 * k, { value: BALLAST_AT_2_MA[die] })
        b.wire(u, pads[k], ballast, "1")
        b.wire(ballast, "2", led, die)
      })
      this.rgb.push(led)
    })
    this.doc.objects.push(...b.doc.objects)
    this.doc.wires.push(...b.doc.wires)
    this.loop.setDoc(this.doc)
    this.loop.setParts(this.doc.parts)
    if (probes.length) {
      this.loop.setProbes(probes.map((pad) => ({ id: pad, a: pinKey(u.id, pad), b: null })))
      this.loop.setLogic(true)
    }
    this.loop.setRunning(true)
    this.loop.advance(this.clock)
  }

  async boot() {
    while (this.loop.booting) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  run(seconds: number): Snapshot {
    const end = this.clock + seconds * 1000
    let snap: Snapshot | null = null
    while (this.clock < end) {
      this.clock = Math.min(end, this.clock + 5)
      this.loop.advance(this.clock)
      snap = this.loop.snapshot()
      if (snap?.logic) this.store.push(snap.logic, snap.traceProbes)
    }
    return snap ?? this.loop.snapshot()!
  }

  turn(pot: number, position: number) {
    const p = this.pots[pot]
    p.props = { ...p.props, pos: String(position) }
    this.loop.setDoc(this.doc)
  }

  press(part: string, seconds = 0.05) {
    this.loop.setParts({ [partKey(this.board.id, part)]: { pressed: true } })
    this.run(seconds)
    this.loop.setParts({})
    this.run(seconds)
  }

  lit(snap: Snapshot, led: number): string {
    return (["R", "G", "B"] as const).filter((die) => snap.parts[partKey(this.rgb[led].id, die)]?.on).join("")
  }

  async state(): Promise<Lab3State> {
    const reply = await this.loop.inspect(this.board.id, { ranges: [{ addr: this.stateAt, size: STATE_BYTES }] })
    const bytes = reply!.memory[0].bytes
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const u32 = (o: number) => view.getUint32(o, true)
    const i32 = (o: number) => view.getInt32(o, true)
    const f32 = (o: number) => view.getFloat32(o, true)
    const pair = <T>(f: (o: number) => T, o: number): [T, T] => [f(o), f(o + 4)]
    const log = <T>(read: (o: number) => T, base: number, size: number): [T[], T[]] => {
      const at = u32(56)
      const ordered = (ch: number) => Array.from({ length: LOG }, (_, i) => read(base + (ch * LOG + ((at + i) % LOG)) * size))
      return [ordered(0), ordered(1)]
    }
    return {
      variant: u32(0),
      scans: u32(4),
      level: pair(u32, 8),
      band: pair(i32, 16),
      filtered: pair(f32, 24),
      measured: pair(f32, 32),
      leds: pair(u32, 40),
      duty: u32(48),
      presses: u32(52),
      raw: log((o) => view.getUint16(o, true), 60, 2),
      filteredLog: log(f32, 316, 4),
    }
  }

  pwm(pad: string, from: number): { hz: number; duty: number; periods: number } {
    const e = this.store.edges(pad)
    if (!e) return { hz: 0, duty: 0, periods: 0 }
    const rises: number[] = []
    const falls: number[] = []
    for (let i = 0; i < e.count; i++) {
      if (e.times[i] < from) continue
      ;(e.levels[i] ? rises : falls).push(e.times[i])
    }
    if (rises.length < 2) return { hz: 0, duty: rises.length ? 1 : 0, periods: 0 }
    const first = rises[0]
    const last = rises[rises.length - 1]
    const periods = rises.length - 1
    let high = 0
    for (let k = 0; k < periods; k++) {
      const fall = falls.find((t) => t > rises[k])
      if (fall !== undefined) high += Math.min(fall, rises[k + 1]) - rises[k]
    }
    return { hz: periods / (last - first), duty: high / (last - first), periods }
  }

  dispose() {
    this.loop.dispose()
  }
}
