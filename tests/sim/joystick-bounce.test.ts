import { describe, expect, it } from "vitest"
import { LogicStore } from "@/components/logic/logic-store"
import { parseElf } from "@/mcu/elf"
import { lab1RunningLight } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey } from "@/schematic/types"
import { bounceFlips, bounceSeed } from "@/sim/bounce"
import { SimLoop } from "@/sim/loop"
import { DT } from "@/sim/speeds"
import { buffer, example, exampleBase64 } from "../lib/firmware"

const BOARD_BOUNCE = 6e-3
const FEWEST_TRANSITIONS_IN_A_BURST = 6
const MOST_TRANSITIONS_IN_A_BURST = 18
const SHORTEST_INTERVAL = 3 * DT
const PRESSES = 6
const HELD = 0.08
const RELEASED = 0.08

const board = getDef("open746i-c")!
const padPin = (mcu: string) => board.pins.find((p) => p.mcu === mcu)!.id

type Recording = { times: number[]; levels: number[]; pressedAt: number[]; releasedAt: number[] }

function record(position: string, mcu: string, props: Record<string, string> = {}): Recording {
  const doc = lab1RunningLight.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, ...props, firmware: "lab1-running-light.elf", firmwareData: exampleBase64("lab1-running-light.elf") }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setProbes([{ id: mcu, a: pinKey(u.id, padPin(mcu)), b: null }])
  loop.setLogic(true)
  loop.setRunning(true)
  const store = new LogicStore()
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 10)
      loop.advance(clock)
      const snap = loop.snapshot()
      if (snap?.logic) store.push(snap.logic, snap.traceProbes)
    }
    return loop.snapshot()!.time
  }
  run(0.1)
  const pressedAt: number[] = []
  const releasedAt: number[] = []
  for (let i = 0; i < PRESSES; i++) {
    loop.setParts({ [partKey(u.id, position)]: { pressed: true } })
    pressedAt.push(loop.snapshot()!.time)
    run(HELD)
    loop.setParts({})
    releasedAt.push(loop.snapshot()!.time)
    run(RELEASED)
  }
  loop.dispose()
  const series = store.edges(mcu)!
  return { times: [...series.times], levels: [...series.levels], pressedAt, releasedAt }
}

const SEEN_WITHIN = 3 * DT
const within = (r: Recording, from: number, span: number) => r.times.map((t, i) => [t, r.levels[i]] as const).filter(([t]) => t >= from && t <= from + span + SEEN_WITHIN)

describe("contact bounce", () => {
  it("is the same burst for the same part and transition, and another for the next", () => {
    const seed = bounceSeed("U1:JOY_C", 0)
    expect(bounceFlips(seed, 1, BOARD_BOUNCE)).toEqual(bounceFlips(bounceSeed("U1:JOY_C", 0), 1, BOARD_BOUNCE))
    expect(bounceFlips(bounceSeed("U1:JOY_C", 1), 1, BOARD_BOUNCE)).not.toEqual(bounceFlips(seed, 1, BOARD_BOUNCE))
    expect(bounceFlips(bounceSeed("U1:JOY_A", 0), 1, BOARD_BOUNCE)).not.toEqual(bounceFlips(seed, 1, BOARD_BOUNCE))
  })

  it("is a burst of re-strikes inside the bounce time, settling on the new state", () => {
    const shapes = Array.from({ length: 200 }, (_, n) => bounceFlips(bounceSeed("U1:JOY_A", n), 0, BOARD_BOUNCE))
    for (const flips of shapes) {
      expect.soft(flips.length % 2, "an even number of flips ends where the contact went").toBe(0)
      expect.soft(flips.length).toBeGreaterThanOrEqual(FEWEST_TRANSITIONS_IN_A_BURST)
      expect.soft(flips.length).toBeLessThanOrEqual(MOST_TRANSITIONS_IN_A_BURST)
      expect.soft(flips.at(-1)!).toBeLessThanOrEqual(BOARD_BOUNCE + 1e-12)
      flips.forEach((t, i) => expect.soft(t - (i ? flips[i - 1] : 0)).toBeGreaterThanOrEqual(SHORTEST_INTERVAL - 1e-12))
    }
    const lengths = shapes.map((f) => f.at(-1)!)
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length
    expect(Math.min(...lengths), "the shortest burst").toBeGreaterThan(0.1 * BOARD_BOUNCE)
    expect(Math.max(...lengths), "the longest burst").toBeGreaterThan(0.8 * BOARD_BOUNCE)
    expect(mean, "Ganssle's average was 1.6 ms, his longest 6.2 ms").toBeNear(2.6e-3, 0.6e-3)
  })

  describe("on the Open746I-C's joystick, on as the board ships", () => {
    const first = record("JOY_C", "PD4")
    const again = record("JOY_C", "PD4")

    it("gives the same edges for the same schematic and presses", () => {
      expect(again.times).toEqual(first.times)
      expect(again.levels).toEqual(first.levels)
    })

    it("bursts on every press and every release, and settles within 6 ms", () => {
      for (let i = 0; i < PRESSES; i++) {
        const press = within(first, first.pressedAt[i], BOARD_BOUNCE)
        const release = within(first, first.releasedAt[i], BOARD_BOUNCE)
        expect.soft(press.length, `press ${i + 1} transitions`).toBeGreaterThanOrEqual(FEWEST_TRANSITIONS_IN_A_BURST + 1)
        expect.soft(release.length, `release ${i + 1} transitions`).toBeGreaterThanOrEqual(FEWEST_TRANSITIONS_IN_A_BURST + 1)
        expect.soft(press.at(-1)?.[1], `press ${i + 1} ends low`).toBe(0)
        expect.soft(release.at(-1)?.[1], `release ${i + 1} ends high`).toBe(1)
        const settled = first.times.filter((t) => t > first.pressedAt[i] + BOARD_BOUNCE + SEEN_WITHIN && t < first.releasedAt[i])
        expect.soft(settled, `press ${i + 1} quiet after 6 ms`).toEqual([])
      }
      const bursts = first.pressedAt.map((t) => within(first, t, BOARD_BOUNCE).map(([at]) => at - t))
      expect(new Set(bursts.map((b) => b.length)).size, "presses differ from each other").toBeGreaterThan(1)
    })

    it("is one clean edge per transition with bounce off", () => {
      const clean = record("JOY_C", "PD4", { bounce: "off" })
      const pressed = clean.levels.filter((_, i) => clean.times[i] >= clean.pressedAt[0])
      expect(pressed).toEqual(Array.from({ length: 2 * PRESSES }, (_, i) => (i % 2 ? 1 : 0)))
    })

    it("leaves the reset button and the jumpers alone", () => {
      expect(board.bounces).toEqual(["JOY_A", "JOY_B", "JOY_C", "JOY_D", "JOY_CTR"])
      expect(board.defaults).toMatchObject({ bounce: "on", tbounce: "6 ms" })
    })
  })
})

const RUNNING_LIGHT = example("lab1-running-light.elf")
const symbolAt = (name: string) => parseElf(buffer(RUNNING_LIGHT)).symbols.find((s) => s.name === name)!.value
const FIRMWARE_DEBOUNCE = 0.02
const BOOTED = 0.1
const MOUSE_CLICK = 0.001
const PULLED_UP_BY = 0.05

function runningLight() {
  const doc = lab1RunningLight.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "lab1-running-light.elf", firmwareData: RUNNING_LIGHT.toString("base64") }
  const fromFlash = { ...doc.parts, [partKey(u.id, "BOOT")]: { on: false } }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(fromFlash)
  loop.setProbes([{ id: "PD4", a: pinKey(u.id, padPin("PD4")), b: null }])
  loop.setLogic(true)
  loop.setRunning(true)
  let store = new LogicStore()
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 10)
      loop.advance(clock)
      const snap = loop.snapshot()
      if (snap?.logic) store.push(snap.logic, snap.traceProbes)
    }
    return loop.snapshot()!.time
  }
  const hold = (part: string | null) => loop.setParts(part ? { ...fromFlash, [partKey(u.id, part)]: { pressed: true } } : fromFlash)
  const restart = () => {
    loop.restart()
    store = new LogicStore()
  }
  const edgesSince = (from: number) => {
    const s = store.edges("PD4")
    if (!s) return []
    return [...s.times].flatMap((t, i) => (t >= from ? [[Math.round((t - from) * 1e9), s.levels[i]] as const] : []))
  }
  const word = async (symbol: string) => {
    const reply = await loop.inspect(u.id, { ranges: [{ addr: symbolAt(symbol), size: 4 }] })
    const bytes = reply!.memory[0].bytes
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
  }
  const click = (part: string) => {
    hold(part)
    run(MOUSE_CLICK)
    hold(null)
  }
  return { loop, run, hold, restart, edgesSince, word, click }
}

describe("contact bounce through a restart of the same loop, as the worker keeps one for the session", () => {
  const pressBurst = (bench: ReturnType<typeof runningLight>) => {
    const pressedAt = bench.run(BOOTED)
    bench.hold("JOY_C")
    bench.run(HELD)
    bench.hold(null)
    bench.run(RELEASED)
    return bench.edgesSince(pressedAt).filter(([t]) => t <= (BOARD_BOUNCE + SEEN_WITHIN) * 1e9)
  }

  it("gives the first press after a restart the burst the first run's first press had", () => {
    const bench = runningLight()
    const first = pressBurst(bench)
    bench.restart()
    const again = pressBurst(bench)
    bench.loop.dispose()
    expect(first.length, "a burst").toBeGreaterThanOrEqual(FEWEST_TRANSITIONS_IN_A_BURST + 1)
    expect(again).toEqual(first)
  })

  it("lets nothing of the old run fire in the new one: a burst under way and a release held back are settled by the restart", () => {
    const bench = runningLight()
    bench.run(BOOTED)
    bench.hold("JOY_C")
    bench.run(MOUSE_CLICK)
    bench.hold(null)
    bench.restart()
    bench.run(4 * BOOTED)
    bench.loop.dispose()
    expect(bench.edgesSince(PULLED_UP_BY), "PD4 once the firmware has its pull-up on").toEqual([])
  })
})

describe("a quick click on the joystick, as a mouse gives it", () => {
  it("lasts long enough for lab 1's 20 ms debounce after the board's bounce: C starts the light, A adds exactly one second, and C's contact holds still past the window", async () => {
    const bench = runningLight()
    bench.run(BOOTED)
    const dwell = await bench.word("_ZL11step_time_s")
    const stopped = await bench.word("_ZL5state")
    bench.click("JOY_A")
    bench.run(0.3)
    expect(await bench.word("_ZL11step_time_s"), "one press of A, seen once").toBe(dwell + 1)
    bench.click("JOY_C")
    bench.run(0.3)
    expect(await bench.word("_ZL5state"), "C seen: the light runs").not.toBe(stopped)
    const clickedAt = bench.run(0.01)
    bench.click("JOY_C")
    bench.run(0.3)
    bench.loop.dispose()
    const edges = bench.edgesSince(clickedAt).map(([t, level]) => [t / 1e9, level] as const)
    const pressBurstEnds = Math.max(...edges.filter(([t]) => t <= BOARD_BOUNCE + SEEN_WITHIN).map(([t]) => t))
    const releaseStarts = Math.min(...edges.filter(([t]) => t > BOARD_BOUNCE + SEEN_WITHIN).map(([t]) => t))
    expect(edges.at(-1)?.[1], "PD4 released again").toBe(1)
    expect(releaseStarts - pressBurstEnds, "the contact holds still for longer than the firmware's window").toBeGreaterThan(FIRMWARE_DEBOUNCE)
  })
})

describe("a second click while the first one's release is still held back", () => {
  it("keeps the contact closed under the new press: the held release is dropped, not applied", () => {
    const bench = runningLight()
    const pressedAt = bench.run(BOOTED)
    bench.click("JOY_C")
    bench.run(0.01)
    bench.hold("JOY_C")
    const releasedAt = bench.run(0.15)
    bench.hold(null)
    bench.run(RELEASED)
    bench.loop.dispose()
    const edges = bench.edgesSince(pressedAt).map(([t, level]) => [t / 1e9, level] as const)
    const quiet = edges.filter(([t]) => t > BOARD_BOUNCE + SEEN_WITHIN && t < releasedAt - pressedAt)
    expect(quiet, "PD4 between the first press's burst and the release").toEqual([])
    expect(edges.at(-1)?.[1], "released at last").toBe(1)
  })
})
