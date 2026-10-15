import { buildMetronome } from "@/schematic/metronome"
import { GRID } from "@/schematic/geometry"
import { partKey, type Schematic } from "@/schematic/types"
import type { BuzzerSnapshot } from "@/sim/buzzer"
import type { Engine } from "@/sim/engine"
import { SimLoop } from "@/sim/loop"

export function metronome(tempo = "0.5", pitch = "0.5", volume = "0.8") {
  const { doc, parts } = buildMetronome(GRID, { tempo, pitch, volume })
  return { doc, ...parts }
}

export function run(doc: Schematic, seconds: number, each: (loop: SimLoop) => void) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  while (clock < seconds * 1000) {
    clock += 2
    loop.advance(clock)
    each(loop)
  }
  return loop
}

export const engineOf = (loop: SimLoop) => (loop as unknown as { engine: Engine }).engine

export function record(doc: Schematic, m: ReturnType<typeof metronome>, seconds: number) {
  const edges = new Map<string, { high: boolean; time: number }[]>([m.u1, m.u2, m.u3].map((u) => [u.id, []]))
  let hooked: Engine | null = null
  const flashes: { led: number; time: number }[] = []
  const sounds: { time: number; level: number | null; tone: number | null; warnings: string[] }[] = []
  let lit = -1
  const loop = run(doc, seconds, (l) => {
    const e = engineOf(l)
    if (e !== hooked) {
      hooked = e
      e.onTimer = (object, high, time) => edges.get(object)?.push({ high, time })
    }
    const s = l.snapshot()!
    const bz = s.digital[m.buzzer.id] as BuzzerSnapshot | undefined
    if (bz) sounds.push({ time: s.time, level: bz.level, tone: bz.tone, warnings: bz.warnings })
    const on = m.leds.findIndex((led) => s.parts[partKey(led.id, "LED")]?.on)
    if (on >= 0 && on !== lit) flashes.push({ led: on, time: s.time })
    lit = on
  })
  return { loop, edges, flashes, sounds }
}

export const rises = (xs: { high: boolean; time: number }[]) => xs.filter((x) => x.high).map((x) => x.time)
