import { expect } from "vitest"
import { LogicStore } from "@/components/logic/logic-store"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { DT } from "@/sim/speeds"
import { levelAt, type EdgeSeries } from "@/sim/protocols"
import { parseElf } from "@/mcu/elf"
import { buffer, example } from "./firmware"
import { patchWords } from "./patch-elf"

export const ELF = example("lab1-variants.elf")
export const COUNTERS_IN_RAM = parseElf(buffer(ELF)).symbols.find((s) => s.name === "counters")!.value
export const LED_PADS = ["PB6", "PB7", "PH4", "PI8"] as const
export const POSITIONS = { A: "JOY_A", B: "JOY_B", C: "JOY_C", D: "JOY_D", CTR: "JOY_CTR" } as const
export type Position = keyof typeof POSITIONS
export const DEBOUNCED_TICKS = 200
export const NAIVE_TICKS = 1
export const HOLD = 0.06
export const BETWEEN_PRESSES = 0.04
export const SAME_WRITE = 50e-6
export const TICK = 1e-4
export const STEP_TOLERANCE = 2 * TICK
export const PWM_SLOT = 5 * TICK
export const COUNTER_SHOWN_FOR = 1
const SPEED = 10
const WALL_CHUNK_MS = 30
const POLL = 0.02
export const DARK = "○○○○"
export const ALL = "●●●●"

export const board = getDef("open746i-c")!
const padPin = (mcu: string) => board.pins.find((p) => p.mcu === mcu)!.id
const ledString = (mask: number) => [0, 1, 2, 3].map((i) => ((mask >> i) & 1 ? "●" : "○")).join("")

export type Change = { time: number; leds: string }

export class Bench {
  readonly loop = new SimLoop()
  readonly store = new LogicStore()
  readonly board: string
  now = 0
  private clock = 0

  constructor(variant: number, debounceTicks = DEBOUNCED_TICKS) {
    const doc = lab1Board.build(GRID)
    const u = doc.objects.find((o) => o.def === "open746i-c")!
    const image = patchWords(ELF, { lab1_variant: variant, lab1_debounce_ticks: debounceTicks })
    u.props = { ...u.props, firmware: "lab1-variants.elf", firmwareData: image.toString("base64") }
    this.board = u.id
    this.loop.setDoc(doc)
    this.loop.setParts(doc.parts)
    this.loop.setProbes(LED_PADS.map((pad) => ({ id: pad, a: pinKey(u.id, padPin(pad)), b: null })))
    this.loop.setLogic(true)
    this.loop.speed = SPEED
    this.loop.setRunning(true)
    this.loop.advance(0)
  }

  run(seconds: number) {
    const target = this.now + seconds
    while (this.now < target - DT / 2) {
      this.clock += Math.min(WALL_CHUNK_MS, ((target - this.now) * 1000) / SPEED)
      this.loop.advance(this.clock)
      const snap = this.loop.snapshot()!
      if (snap.logic) this.store.push(snap.logic, snap.traceProbes)
      this.now = snap.time
    }
    expect(this.store.dropped, "the analyser keeps every edge").toBe(false)
  }

  press(position: Position, times = 1) {
    for (let i = 0; i < times; i++) {
      this.loop.setParts({ [partKey(this.board, POSITIONS[position])]: { pressed: true } })
      this.run(HOLD)
      this.loop.setParts({})
      this.run(BETWEEN_PRESSES)
    }
  }

  series(pad: (typeof LED_PADS)[number] = "PB6"): EdgeSeries {
    return this.store.edges(pad)!
  }

  ledsAt(t: number) {
    return ledString(LED_PADS.reduce((mask, pad, i) => mask | (levelAt(this.series(pad), t) ? 1 << i : 0), 0))
  }

  changes(from: number, to = Infinity): Change[] {
    const times = LED_PADS.flatMap((pad) => [...this.series(pad).times].filter((t) => t > from && t <= to)).sort((a, b) => a - b)
    const out: Change[] = []
    let last = this.ledsAt(from)
    for (let i = 0; i < times.length; ) {
      const start = times[i]
      while (i < times.length && times[i] - start <= SAME_WRITE) i++
      const leds = this.ledsAt(start + SAME_WRITE)
      if (leds !== last) out.push({ time: start, leds })
      last = leds
    }
    return out
  }

  next(count: number, within: number, from = this.now): Change[] {
    while (this.changes(from).length < count && this.now - from < within) this.run(POLL)
    return this.changes(from).slice(0, count)
  }

  quietFor(seconds: number) {
    const from = this.now
    this.run(seconds)
    return this.changes(from)
  }

  dispose() {
    this.loop.dispose()
  }
}

export const intervals = (changes: Change[]) => changes.slice(1).map((c, i) => c.time - changes[i].time)

