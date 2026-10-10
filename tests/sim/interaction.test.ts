import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { examples, type Example } from "@/schematic/examples"
import { getDef } from "@/schematic/registry"
import { partKey, type PartState, type PlacedObject, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

const FIRMWARE: Record<string, Record<string, string>> = {
  "nucleo-blink": { U1: "nucleo-blink.elf" },
  "nucleo-square": { U1: "nucleo-square.elf" },
  "nucleo-pwm": { U1: "nucleo-pwm.elf" },
  "nucleo-serial": { U1: "nucleo-uart.elf" },
  "nucleo-spi": { U1: "nucleo-spi-master.elf", U2: "nucleo-spi-slave.elf" },
  "nucleo-i2c": { U1: "nucleo-i2c.elf" },
  "nucleo-74hc595": { U1: "nucleo-shift.elf" },
  "nucleo-ws2812": { U1: "nucleo-ws2812.elf" },
  "nucleo-adc": { U1: "nucleo-adc.elf" },
  "nucleo-melody": { U1: "nucleo-melody.elf" },
  "lab1-open746i-c": { U1: "lab1-f746.elf" },
  "lab1-running-light": { U1: "lab1-running-light.elf" },
  "open746-lcd": { U1: "open746-lcd.elf" },
  "open746-touch": { U1: "open746-touch.elf" },
  "open746-cube": { U1: "open746-cube.elf" },
  "lab1-f746": { DD1: "lab1-f746.elf" },
}

const HANDLING_SECONDS = Number(process.env.HANDLING_SECONDS ?? 3)
const SEED = process.env.HANDLING_SEED ?? ""

type Control =
  | { kind: "button"; key: string; name: string }
  | { kind: "toggle"; key: string; name: string; initial: boolean }
  | { kind: "touch"; key: string; name: string }
  | { kind: "pot"; object: PlacedObject; name: string }

type Burn = { ref: string; element: number; reason: string; at: number; doing: string }

const BENCH_WOULD_BURN_TOO: Record<string, Record<string, string>> = {
  "system-exam": { R12: "the overload block: 100 Ω ¼ W straight across 12 V is 1.44 W, 5.8 × its rating, and burns open in seconds on a real bench too" },
}

function mulberry32(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const seedOf = (text: string) => [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261)

function withFirmware(ex: Example, doc: Schematic): boolean {
  const images = FIRMWARE[ex.id]
  for (const { ref } of ex.projects ?? []) {
    const name = images?.[ref]
    if (!name) return false
    const obj = doc.objects.find((o) => o.props?.ref === ref)!
    obj.props = { ...obj.props, firmware: name, firmwareData: exampleBase64(name) }
  }
  return true
}

function controlsOf(doc: Schematic): Control[] {
  const controls: Control[] = []
  for (const obj of doc.objects) {
    const def = getDef(obj.def)
    if (!def) continue
    const ref = obj.props?.ref ?? def.id
    for (const p of def.parts) {
      const key = partKey(obj.id, p.id)
      const name = `${ref}:${p.id}`
      if (p.type === "button") controls.push({ kind: "button", key, name })
      else if (p.type === "switch" || p.type === "usb") controls.push({ kind: "toggle", key, name, initial: doc.parts[key]?.on ?? p.initial?.on ?? false })
      else if (p.type === "logic") controls.push({ kind: "toggle", key, name, initial: doc.parts[key]?.on ?? false })
      else if (p.type === "display") controls.push({ kind: "touch", key, name })
    }
    if (def.fields?.some((f) => f.key === "pos")) controls.push({ kind: "pot", object: obj, name: ref })
  }
  return controls
}

function handleLikeAStudent(ex: Example, doc: Schematic, seconds: number) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const burns: Burn[] = []
  const seen = new Set<string>()
  const refOf = new Map(doc.objects.map((o) => [o.id, o.props?.ref ?? o.def]))
  let doing = "start-up"
  loop.onFailure = (f) => {
    const id = `${f.object}/${f.damage.element}`
    if (seen.has(id)) return
    seen.add(id)
    burns.push({ ref: refOf.get(f.object) ?? f.object, element: f.damage.element, reason: f.damage.reason, at: clock / 1000, doing })
  }
  const run = (s: number) => {
    const end = clock + s * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 2)
      loop.advance(clock)
    }
  }
  let parts: Record<string, PartState> = { ...doc.parts }
  const set = (key: string, state: PartState) => {
    parts = { ...parts, [key]: state }
    loop.setParts(parts)
  }
  const setPos = (pot: PlacedObject, pos: string) => {
    pot.props = { ...pot.props, pos }
    loop.setDoc({ ...doc, objects: doc.objects.map((o) => (o.id === pot.id ? { ...pot } : o)) })
  }
  const controls = controlsOf(doc)
  const buttons = controls.filter((c) => c.kind === "button")
  const rnd = mulberry32(seedOf(ex.id + SEED))
  const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)]
  const between = (lo: number, hi: number) => lo + (hi - lo) * rnd()
  let actions = 0
  run(0.3)
  const start = loop.snapshot()!.time
  while (controls.length && loop.snapshot()!.time - start < seconds) {
    actions++
    const c = pick(controls)
    doing = c.name
    if (c.kind === "button") {
      if (rnd() < 0.3) {
        doing = `${c.name} tapped fast`
        const taps = 3 + Math.floor(rnd() * 8)
        for (let i = 0; i < taps; i++) {
          set(c.key, { pressed: true })
          run(between(0.002, 0.03))
          set(c.key, { pressed: false })
          run(between(0.002, 0.04))
        }
      } else {
        const together = rnd() < 0.2 ? pick(buttons) : c
        doing = together === c ? c.name : `${c.name} with ${together.name}`
        set(c.key, { pressed: true })
        set(together.key, { pressed: true })
        run(between(0.01, 0.8))
        set(c.key, { pressed: false })
        set(together.key, { pressed: false })
      }
    } else if (c.kind === "toggle") {
      const now = parts[c.key]?.on ?? c.initial
      set(c.key, { on: !now })
      run(between(0.005, 0.6))
      if (rnd() < 0.8) set(c.key, { on: now })
    } else if (c.kind === "touch") {
      set(c.key, { pressed: true, x: Math.floor(rnd() * 1024), y: Math.floor(rnd() * 600) })
      run(between(0.02, 0.4))
      set(c.key, { pressed: false })
    } else {
      const was = c.object.props?.pos ?? getDef(c.object.def)?.defaults?.pos ?? "0.5"
      doing = `${c.name} to 0`
      setPos(c.object, "0")
      run(between(0.05, 0.4))
      doing = `${c.name} to 1`
      setPos(c.object, "1")
      run(between(0.05, 0.4))
      doing = `${c.name} back`
      setPos(c.object, was)
    }
    run(between(0.005, 0.3))
  }
  loop.setRunning(false)
  loop.dispose()
  return { burns, actions, controls: controls.length }
}

describe("a student at every example burns only what a real bench would", () => {
  it.for(examples.map((ex) => [ex.id, ex] as const))("%s", ([, ex], { skip }) => {
    const doc = ex.build(GRID)
    if (!withFirmware(ex, doc)) return skip(`no image in firmware/examples for ${ex.id}`)
    const { burns, actions, controls } = handleLikeAStudent(ex, doc, HANDLING_SECONDS)
    if (controls) expect.soft(actions, "the student did something").toBeGreaterThan(3)
    for (const b of burns)
      expect.soft(BENCH_WOULD_BURN_TOO[ex.id]?.[b.ref], `${b.ref} (element ${b.element}) burnt at ${b.at.toFixed(3)} s while ${b.doing}: ${b.reason}`).toBeDefined()
  })
})
