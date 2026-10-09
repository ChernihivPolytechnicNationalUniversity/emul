import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import type { BuzzerSnapshot } from "@/sim/buzzer"
import { SimLoop, type Probe, type Snapshot } from "@/sim/loop"

export function start(doc: Schematic, probes: Probe[] = []) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setProbes(probes)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number, each?: (snap: Snapshot) => void) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 5)
      loop.advance(clock)
      each?.(loop.snapshot()!)
    }
    return loop.snapshot()!
  }
  return { loop, run }
}

export const sound = (snap: Snapshot, buzzer: PlacedObject) => snap.digital[buzzer.id] as BuzzerSnapshot
export const IRLZ44N = { value: "IRLZ44N", vth: "2 V", rdson: "22 mΩ", idmax: "47 A", vdsmax: "55 V", pmax: "110 W", eas: "210 mJ" }
export const N2N7000 = { value: "2N7000", vth: "2.1 V", rdson: "1.8 Ω", idmax: "200 mA", vdsmax: "60 V", pmax: "400 mW", eas: "" }

export function lowSide(opts: { model?: string; supply?: string; hz: string; duty?: string; flyback?: boolean; fet?: Record<string, string>; buzzer?: Record<string, string> }) {
  const { doc, place, wire } = builder(GRID)
  const rail = place("supply", 12, -6, { value: "+V", voltage: opts.supply ?? "3.5 V", imax: "2 A" })
  const bz = place(`buzzer-${opts.model ?? "cem-1203-42"}`, 10, 0, opts.buzzer)
  const q = place("nmos", 12, 8, opts.fet ?? IRLZ44N)
  const gen = place("pulse-source", 4, 8, { high: "5 V", low: "0 V", freq: opts.hz, duty: opts.duty ?? "50" })
  const gnd = place("ground", 15, 16)
  wire(rail, "V", bz, "1")
  wire(bz, "2", q, "D")
  const source = wire(q, "S", gnd, "GND")
  wire(gen, "+", q, "G")
  wire(gen, "-", gnd, "GND")
  if (opts.flyback ?? true) {
    const d = place("diode", 20, 0, { value: "1N4148" }, 270)
    wire(d, "1", q, "D")
    wire(d, "2", rail, "V")
  }
  return { doc, bz, q, rail, source }
}

export type Source = { kind: "dc"; volts: number } | { kind: "square"; volts: number; low?: number; hz: string; duty?: string; rint?: string } | { kind: "sine"; rms: number; hz: number }

export function across(model: string, source: Source) {
  const { doc, place, wire } = builder(GRID)
  const src =
    source.kind === "dc"
      ? place("dc-source", 4, 0, { value: `${Math.abs(source.volts)} V`, rint: "0.1 Ω", imax: "5 A" })
      : source.kind === "sine"
        ? place("ac-source", 4, 0, { value: `${source.rms} V`, freq: `${source.hz} Hz`, rint: "1 Ω" })
        : place("pulse-source", 4, 0, { high: `${source.volts} V`, low: `${source.low ?? 0} V`, freq: source.hz, duty: source.duty ?? "50", rint: source.rint ?? "1 Ω" })
  const bz = place(`buzzer-${model}`, 12, 0)
  const gnd = place("ground", 4, 8)
  const reversed = source.kind === "dc" && source.volts < 0
  const feed = wire(src, "+", bz, reversed ? "2" : "1")
  wire(bz, reversed ? "1" : "2", gnd, "GND")
  wire(src, "-", gnd, "GND")
  return { doc, bz, src, feed }
}

export function levelAt(hz: string, opts: Partial<Parameters<typeof lowSide>[0]> = {}) {
  const bench = lowSide({ hz, ...opts })
  return sound(start(bench.doc).run(0.15), bench.bz)
}

export function meanCurrentOf(doc: Schematic, wireId: string) {
  const t = start(doc)
  t.run(0.05)
  let sum = 0
  let n = 0
  const snap = t.run(0.2, (s) => {
    sum += Math.abs(s.wireCurrent[wireId] ?? 0)
    n++
  })
  return { snap, amps: sum / n }
}
