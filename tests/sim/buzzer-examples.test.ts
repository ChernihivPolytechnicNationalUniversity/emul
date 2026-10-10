import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { buzzersOnDc, nucleoMelody, toneGenerator, twoToneSiren } from "@/schematic/buzzers"
import { partKey, pinKey, type PartState, type PlacedObject, type Schematic } from "@/schematic/types"
import type { BuzzerSnapshot } from "@/sim/buzzer"
import { SimLoop, type Probe, type Snapshot } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

function start(doc: Schematic, tick = 2, probes: Probe[] = []) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setProbes(probes)
  loop.setRunning(true)
  let clock = 0
  let parts: Record<string, PartState> = { ...doc.parts }
  loop.advance(clock)
  const run = (seconds: number, each?: (snap: Snapshot) => void) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + tick)
      loop.advance(clock)
      each?.(loop.snapshot()!)
    }
    return loop.snapshot()!
  }
  const press = (object: PlacedObject, part: string, state: PartState) => {
    parts = { ...parts, [partKey(object.id, part)]: state }
    loop.setParts(parts)
  }
  return { run, press }
}

const byRef = (doc: Schematic, ref: string) => doc.objects.find((o) => o.props?.ref === ref)!
const sound = (snap: Snapshot, buzzer: PlacedObject) => snap.digital[buzzer.id] as BuzzerSnapshot

describe("example: buzzers on DC", () => {
  const doc = buzzersOnDc.build(GRID)
  const sw = byRef(doc, "SW1")
  const active = byRef(doc, "BZ1")
  const passive = byRef(doc, "BZ2")

  it("the active one beeps while the button is held, the passive one only clicks at each edge", () => {
    const t = start(doc)
    let snap = t.run(0.05)
    expect.soft(sound(snap, active).level, "both silent at rest").toBeNull()
    t.press(sw, "SW", { pressed: true })
    let click = -Infinity
    snap = t.run(0.03, (s) => (click = Math.max(click, sound(s, passive).level ?? -Infinity)))
    expect.soft(click, "BZ2 clicks as the button closes (dBA)").toBeGreaterThan(50)
    snap = t.run(0.3)
    expect.soft(sound(snap, active).tone ?? 0, "BZ1 beeps its own tone, a little above 2.4 kHz on 4.5 V (Hz)").toBeNear(2410, 10)
    expect.soft(sound(snap, active).level ?? 0, "BZ1 at 4.5 V (dBA)").toBeGreaterThan(80)
    expect.soft(sound(snap, passive).level, "BZ2 is silent while DC flows").toBeNull()
    t.press(sw, "SW", { pressed: false })
    click = -Infinity
    snap = t.run(0.03, (s) => (click = Math.max(click, sound(s, passive).level ?? -Infinity)))
    expect.soft(click, "BZ2 clicks again as it opens (dBA)").toBeGreaterThan(50)
    snap = t.run(0.1)
    expect.soft(sound(snap, active).level, "BZ1 stops with its supply").toBeNull()
  })
})

describe("example: buzzers on DC, the button worked like a user works it", () => {
  it("BZ2's coil kicks BZ1's supply below ground at release, never past BZ1's reverse breakdown, and BZ1 survives any rhythm", () => {
    const doc = buzzersOnDc.build(GRID)
    const sw = byRef(doc, "SW1")
    const active = byRef(doc, "BZ1")
    const t = start(doc, 1, [{ id: "node", a: pinKey(active.id, "1"), b: null }])
    let lowest = 0
    const watch = (s: Snapshot) => (lowest = Math.min(lowest, s.probes.node.min))
    const rhythms = [
      [3, 2],
      [7, 5],
      [15, 3],
      [40, 20],
      [120, 60],
      [2, 40],
      [300, 8],
    ]
    for (let round = 0; round < 4; round++)
      for (const [hold, gap] of rhythms) {
        t.press(sw, "SW", { pressed: true })
        t.run(hold / 1000, watch)
        t.press(sw, "SW", { pressed: false })
        t.run(gap / 1000, watch)
      }
    t.press(sw, "SW", { pressed: true })
    const snap = t.run(0.2)
    expect.soft(lowest, "the kick reverses BZ1's supply (V)").toBeLessThan(-1)
    expect.soft(lowest, "and its reverse path holds it above the breakdown (V)").toBeGreaterThan(-9.5)
    expect.soft(snap.damage[active.id], "BZ1 unharmed after 28 presses").toBeFalsy()
    expect.soft(sound(snap, active).tone ?? 0, "and still beeps (Hz)").toBeNear(2410, 10)
  })
})

describe("example: 555 tone generator", () => {
  const heard = (pos: string) => {
    const doc = toneGenerator.build(GRID)
    const vr = byRef(doc, "VR1")
    vr.props = { ...vr.props, pos }
    const snap = start(doc).run(0.3)
    return sound(snap, byRef(doc, "BZ1"))
  }
  const astable = (pos: number) => 1 / (Math.LN2 * (1e3 + 2 * (1e3 + 10e3 * (1 - pos))) * 100e-9)

  it("sounds the 555's frequency, and is loudest where it sits on the buzzer's resonance", () => {
    const middle = heard("0.5")
    const resonance = heard("0.8")
    const top = heard("1")
    expect.soft(middle.tone ?? 0, "VR1 0.5 (Hz)").toBeNearRel(astable(0.5), 0.03)
    expect.soft(resonance.tone ?? 0, "VR1 0.8 (Hz)").toBeNearRel(astable(0.8), 0.03)
    expect.soft((resonance.level ?? 0) - (middle.level ?? 0), "on resonance against 1.1 kHz (dB)").toBeGreaterThan(8)
    expect.soft((resonance.level ?? 0) - (top.level ?? 0), "on resonance against 4.8 kHz (dB)").toBeGreaterThan(8)
    expect.soft(resonance.drive, "22 Ω keeps the coil inside its 3–5 V (V)").toBeNear(3.3, 0.3)
    expect.soft(resonance.warnings, "nothing to warn about").toEqual([])
  })
})

describe("example: two-tone siren", () => {
  it("alternates between 1.4 and 2.1 kHz about once a second, and the high note is the loud one", () => {
    const doc = twoToneSiren.build(GRID)
    const bz = byRef(doc, "BZ1")
    const notes: { time: number; tone: number; level: number }[] = []
    start(doc, 5).run(4, (s) => {
      const b = sound(s, bz)
      if (b.tone && b.level) notes.push({ time: s.time, tone: b.tone, level: b.level })
    })
    const low = notes.filter((n) => n.tone < 1700)
    const high = notes.filter((n) => n.tone >= 1700)
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]
    expect.soft(median(low.map((n) => n.tone)), "low note (Hz)").toBeNearRel(1390, 0.08)
    expect.soft(median(high.map((n) => n.tone)), "high note (Hz)").toBeNearRel(2070, 0.08)
    expect.soft(median(high.map((n) => n.level)) - median(low.map((n) => n.level)), "high note louder (dB)").toBeGreaterThan(5)
    let switches = 0
    for (let k = 1; k < notes.length; k++) if (notes[k].tone >= 1700 !== notes[k - 1].tone >= 1700) switches++
    expect.soft(switches, "changes of note in 3.5 s of siren").toBeGreaterThanOrEqual(5)
  })
})

describe("example: Nucleo melody on a piezo", () => {
  it("plays the toneMelody jingle and Ode to Joy at their pitches", () => {
    const doc = nucleoMelody.build(GRID)
    const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
    u.props = { ...u.props, firmware: "nucleo-melody.elf", firmwareData: exampleBase64("nucleo-melody.elf") }
    const bz = byRef(doc, "BZ1")
    const heard = new Set<number>()
    start(doc, 10).run(9, (s) => {
      const tone = sound(s, bz).tone
      if (tone) heard.add(Math.round(tone))
    })
    const notes = { G3: 196, A3: 220, B3: 247, C4: 262, C5: 523, D5: 587, E5: 659, F5: 698, G5: 784 }
    for (const [name, hz] of Object.entries(notes))
      expect.soft([...heard].some((h) => Math.abs(h - hz) / hz < 0.01), `${name} (${hz} Hz) heard within 1 %`).toBe(true)
    expect.soft([...heard].every((h) => Object.values(notes).some((hz) => Math.abs(h - hz) / hz < 0.03)), `nothing but those notes: ${[...heard].sort((a, b) => a - b).join(", ")}`).toBe(true)
  })
})
