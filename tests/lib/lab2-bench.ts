import { LogicStore } from "@/components/logic/logic-store"
import { parseElf } from "@/mcu/elf"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { buffer, example } from "./firmware"

export const JOYSTICK = ["JOY_A", "JOY_B", "JOY_C", "JOY_D", "JOY_CTR"] as const
export type Joy = (typeof JOYSTICK)[number]

const STRIPS = /^P(18|19|20|21)-\d+$/
const STRIP_GND = "P18-35"
const PT_LOAD = 1
const PRESS_HELD = 0.06
const RELEASED = 0.06
const STEP_MS = 1

const board = getDef("open746i-c")!

export const stripPin = (pad: string) => {
  const pins = board.pins.filter((p) => STRIPS.test(p.id) && p.mcu === pad)
  if (pins.length !== 1) throw new Error(`${pad} reaches ${pins.length} strip contacts`)
  return pins[0].id
}

export function patchWord(elf: Buffer, symbol: string, value: number): Buffer {
  const image = Buffer.from(elf)
  const address = parseElf(buffer(image)).symbols.find((s) => s.name === symbol)?.value
  if (address === undefined) throw new Error(`no ${symbol}`)
  const phoff = image.readUInt32LE(28)
  const phentsize = image.readUInt16LE(42)
  const phnum = image.readUInt16LE(44)
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize
    if (image.readUInt32LE(p) !== PT_LOAD) continue
    const offset = image.readUInt32LE(p + 4)
    const paddr = image.readUInt32LE(p + 12)
    const filesz = image.readUInt32LE(p + 16)
    if (address >= paddr && address + 4 <= paddr + filesz) {
      image.writeUInt32LE(value >>> 0, offset + address - paddr)
      return image
    }
  }
  throw new Error(`${symbol} is in no loaded segment`)
}

export type Wire = { from: string; to: string }
export type BenchOptions = {
  elf: string
  image?: Buffer
  probes?: string[]
  wires?: Wire[]
  rgb?: { R: string; G: string; B: string }
  pulse?: { pad: string; props: Record<string, string> }
  bounce?: boolean
}

export const RGB_BALLAST = { R: "270 Ω", G: "51 Ω", B: "75 Ω" }

export class Lab2Bench {
  readonly loop = new SimLoop()
  readonly store = new LogicStore()
  readonly u: string
  readonly led: string | null
  private clock = 0
  private parts: Record<string, Record<string, unknown>>
  private readonly symbols: Map<string, number>

  constructor(options: BenchOptions) {
    const image = options.image ?? example(options.elf)
    this.symbols = new Map(parseElf(buffer(image)).symbols.map((s) => [s.name, s.value]))
    const doc = lab1Board.build(GRID)
    const u = doc.objects.find((o) => o.def === "open746i-c")!
    this.u = u.id
    u.props = { ...u.props, firmware: options.elf, firmwareData: image.toString("base64"), ...(options.bounce === false ? { bounce: "off" } : {}) }
    const added = builder(GRID)
    let led: string | null = null
    if (options.rgb) {
      const part = added.place("rgb-led", 100, 10)
      led = part.id
      ;(["R", "G", "B"] as const).forEach((die, i) => {
        const r = added.place("resistor", 92, 6 + 4 * i, { value: RGB_BALLAST[die] })
        added.wire(u, stripPin(options.rgb![die]), r, "1")
        added.wire(r, "2", part, die)
      })
      added.wire(part, "K", u, STRIP_GND)
    }
    for (const w of options.wires ?? []) added.wire(u, stripPin(w.from), u, stripPin(w.to))
    if (options.pulse) {
      const source = added.place("pulse-source", 110, 30, { high: "3.3 V", low: "0 V", ...options.pulse.props })
      added.wire(source, "+", u, stripPin(options.pulse.pad))
      added.wire(source, "-", u, STRIP_GND)
    }
    doc.objects.push(...added.doc.objects)
    doc.wires.push(...added.doc.wires)
    this.led = led
    this.parts = { ...doc.parts }
    this.loop.setDoc(doc)
    this.loop.setParts(this.parts)
    this.loop.setProbes((options.probes ?? []).map((pad) => ({ id: pad, a: pinKey(u.id, stripPin(pad)), b: null })))
    this.loop.setLogic((options.probes ?? []).length > 0)
    this.loop.setRunning(true)
  }

  async boot() {
    this.loop.advance(this.clock)
    while (this.loop.booting) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  get time() {
    return this.loop.snapshot()?.time ?? 0
  }

  run(seconds: number): Snapshot {
    const end = this.clock + seconds * 1000
    let snap: Snapshot | null = null
    while (this.clock < end) {
      this.clock = Math.min(end, this.clock + STEP_MS)
      this.loop.advance(this.clock)
      snap = this.loop.snapshot()
      if (snap?.logic) this.store.push(snap.logic, snap.traceProbes)
    }
    if (this.store.dropped) throw new Error("the analyser dropped edges")
    return snap ?? this.loop.snapshot()!
  }

  snapshot() {
    return this.loop.snapshot()!
  }

  async words(symbol: string, count: number): Promise<number[]> {
    const addr = this.symbols.get(symbol)
    if (addr === undefined) throw new Error(`no ${symbol}`)
    const reply = await this.loop.inspect(this.u, { ranges: [{ addr, size: count * 4 }] })
    const bytes = reply!.memory[0].bytes
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return Array.from({ length: count }, (_, i) => view.getUint32(i * 4, true))
  }

  async write(symbol: string, words: number[], at = 0) {
    const addr = this.symbols.get(symbol)
    if (addr === undefined) throw new Error(`no ${symbol}`)
    const bytes = new Uint8Array(new Uint32Array(words).buffer)
    await this.loop.inspect(this.u, { write: [{ kind: "memory", addr: addr + at * 4, bytes }] })
  }

  async press(joy: Joy) {
    this.loop.setParts({ ...this.parts, [partKey(this.u, joy)]: { pressed: true } })
    this.run(PRESS_HELD)
    this.loop.setParts(this.parts)
    this.run(RELEASED)
  }

  edges(pad: string) {
    const series = this.store.edges(pad)
    if (!series) throw new Error(`the analyser has no ${pad}`)
    const out: { time: number; level: boolean }[] = []
    for (let i = 0; i < series.times.length; i++) out.push({ time: series.times[i], level: series.levels[i] === 1 })
    return out
  }

  pwm(pad: string, from: number) {
    const edges = this.edges(pad).filter((e) => e.time >= from)
    const rises = edges.filter((e) => e.level).map((e) => e.time)
    if (rises.length < 3) return { periods: rises.length - 1, period: NaN, high: NaN, duty: NaN }
    const period = (rises[rises.length - 1] - rises[0]) / (rises.length - 1)
    const highs: number[] = []
    for (let i = 0; i < rises.length - 1; i++) {
      const fall = edges.find((e) => !e.level && e.time > rises[i])
      if (fall && fall.time < rises[i + 1]) highs.push(fall.time - rises[i])
    }
    const high = highs.reduce((a, b) => a + b, 0) / highs.length
    return { periods: rises.length - 1, period, high, duty: high / period }
  }

  lit(die: "R" | "G" | "B") {
    if (!this.led) throw new Error("no RGB LED on the bench")
    return this.snapshot().parts[partKey(this.led, die)]?.on ?? false
  }

  dispose() {
    this.loop.dispose()
  }
}
