import { describe, expect, it } from "vitest"
import { LogicStore } from "@/components/logic/logic-store"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { DT } from "@/sim/speeds"
import { spawnNodeCore } from "../../scripts/lib/core-threads"
import { example } from "../lib/firmware"
import { patchWords } from "../lib/patch-elf"

const ELF = example("open746-sleep.elf")
const SPEED = 10
const WALL_CHUNK_MS = 30
const BOOT = 0.05
const MEASURED = 1
const SLEEPING_NO_SLOWER_THAN = 1.5
const REPEATS = 3
const TICK_TOGGLE = 1e-3
const TICKS_PER_TOGGLE = 10
const TIMER_TOGGLE_HZ = 1000
const QUIET_TICKS_PER_TOGGLE = 1000
const QUIET_TIMER_HZ = 10
const TIMED = 0.4
const TOGGLES_AT_LEAST = 500
const SAME_EDGE = 1e-6
const PRESSES = 3
const HELD = 0.03
const RELEASED = 0.03

type Pad = { port: number; pin: number; name: string }
const pad = (name: string): Pad => ({ port: name.charCodeAt(1) - 65, pin: Number(name.slice(2)), name })

type Board = {
  def: string
  tick: Pad
  echo: Pad
  timer: Pad
  button: Pad
  part: string
  pull: number
  falls: number
}

const BOARDS: Board[] = [
  { def: "open746i-c", tick: pad("PB6"), echo: pad("PB7"), timer: pad("PH4"), button: pad("PI11"), part: "JOY_CTR", pull: 1, falls: 1 },
  { def: "nucleo-f429zi", tick: pad("PB0"), echo: pad("PD14"), timer: pad("PD15"), button: pad("PC13"), part: "B1", pull: 0, falls: 0 },
]

type Run = { wallPerSecond: number; edges: Record<string, number[]>; pressedAt: number[]; status: string }

async function bench(board: Board, wfi: boolean, workers: boolean, quiet: boolean): Promise<Run> {
  const def = getDef(board.def)!
  const pinOf = (p: Pad) => def.pins.find((pin) => pin.mcu === p.name)?.id
  const image = patchWords(ELF, {
    sleep_in_wfi: wfi ? 1 : 0,
    ticks_per_toggle: quiet ? QUIET_TICKS_PER_TOGGLE : TICKS_PER_TOGGLE,
    timer_toggle_hz: quiet ? QUIET_TIMER_HZ : TIMER_TOGGLE_HZ,
    tick_out: board.tick.port,
    "tick_out+4": board.tick.pin,
    button_echo: board.echo.port,
    "button_echo+4": board.echo.pin,
    timer_out: board.timer.port,
    "timer_out+4": board.timer.pin,
    button: board.button.port,
    "button+4": board.button.pin,
    button_pull: board.pull,
    button_falls: board.falls,
  })
  const { doc, place } = builder(GRID)
  const u = place(board.def, 0, 0, { firmware: "open746-sleep.elf", firmwareData: image.toString("base64") })
  const loop = new SimLoop()
  if (workers) loop.spawnCore = spawnNodeCore
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  const watched = [board.tick, board.echo, board.timer, board.button].filter((p) => pinOf(p) !== undefined)
  loop.setProbes(watched.map((p) => ({ id: p.name, a: pinKey(u.id, pinOf(p)!), b: null })))
  loop.setLogic(true)
  loop.speed = SPEED
  loop.setRunning(true)
  const store = new LogicStore()
  let clock = 0
  let now = 0
  loop.advance(clock)
  while (loop.booting) await new Promise((resolve) => setTimeout(resolve, 10))
  const run = (seconds: number) => {
    const target = now + seconds
    while (now < target - DT / 2) {
      clock += Math.min(WALL_CHUNK_MS, ((target - now) * 1000) / SPEED)
      loop.advance(clock)
      const snap = loop.snapshot()!
      if (snap.logic) store.push(snap.logic, snap.traceProbes)
      now = snap.time
    }
  }
  run(BOOT)
  const started = performance.now()
  run(quiet ? MEASURED : TIMED)
  const wallPerSecond = (performance.now() - started) / 1000 / MEASURED
  const pressedAt: number[] = []
  for (let i = 0; i < (quiet ? 0 : PRESSES); i++) {
    loop.setParts({ [partKey(u.id, board.part)]: { pressed: true } })
    pressedAt.push(now)
    run(HELD)
    loop.setParts({})
    run(RELEASED)
  }
  const status = JSON.stringify(loop.snapshot()!.mcus[u.id])
  loop.dispose()
  const edges = Object.fromEntries(watched.map((p) => [p.name, [...(store.edges(p.name)?.times ?? [])]]))
  return { wallPerSecond, edges, pressedAt, status }
}

describe.each([false, true])("a core asleep in WFI between interrupts (workers: %s)", (workers) => {
  describe.each(BOARDS)("on the $def", (board) => {
    const runs: Partial<Record<"busy" | "wfi", Run>> = {}
    const get = async (mode: "busy" | "wfi") => (runs[mode] ??= await bench(board, mode === "wfi", workers, false))

    it("costs no more wall time than the same firmware spinning, woken 10 000 times a second", async () => {
      const fastest = { busy: Infinity, wfi: Infinity }
      for (let i = 0; i < REPEATS; i++)
        for (const mode of ["busy", "wfi"] as const) fastest[mode] = Math.min(fastest[mode], (await bench(board, mode === "wfi", workers, true)).wallPerSecond)
      console.log(`${board.def} workers=${workers}: busy ${fastest.busy.toFixed(3)}, wfi ${fastest.wfi.toFixed(3)} s wall per simulated s`)
      expect(fastest.wfi / fastest.busy).toBeLessThan(SLEEPING_NO_SLOWER_THAN)
    })

    const sameInstants = (wfi: number[], busy: number[]) => {
      expect(wfi.length, "as many edges asleep as spinning").toBe(busy.length)
      expect(Math.max(...wfi.map((t, i) => Math.abs(t - busy[i]))), "the latest any edge comes").toBeLessThan(SAME_EDGE)
    }

    it("wakes for SysTick at the same simulated instants as the spinning core: a toggle every 1 ms", async () => {
      const busy = (await get("busy")).edges[board.tick.name]
      const wfi = (await get("wfi")).edges[board.tick.name]
      expect(wfi.length).toBeGreaterThan(TOGGLES_AT_LEAST)
      for (let i = 1; i < wfi.length; i++) expect.soft(wfi[i] - wfi[i - 1], `interval ${i}`).toBeNear(TICK_TOGGLE, SAME_EDGE)
      sameInstants(wfi, busy)
    })

    it("wakes for TIM2's update at the same instants: a toggle every 1 ms", async () => {
      const busy = (await get("busy")).edges[board.timer.name]
      const wfi = (await get("wfi")).edges[board.timer.name]
      expect(wfi.length).toBeGreaterThan(TOGGLES_AT_LEAST)
      for (let i = 1; i < wfi.length; i++) expect.soft(wfi[i] - wfi[i - 1], `interval ${i}`).toBeNear(1 / TIMER_TOGGLE_HZ, SAME_EDGE)
      sameInstants(wfi, busy)
    })

    it("wakes for the button's EXTI on its first edge, bounce and all, as the spinning core does", async () => {
      const busy = await get("busy")
      const wfi = await get("wfi")
      expect(wfi.edges[board.echo.name].length).toBeGreaterThanOrEqual(PRESSES)
      sameInstants(wfi.edges[board.echo.name], busy.edges[board.echo.name])
      for (const at of wfi.pressedAt) {
        const pressEdge = wfi.edges[board.button.name]?.find((t) => t >= at) ?? at
        const echo = wfi.edges[board.echo.name].find((t) => t >= pressEdge)!
        expect.soft(echo - pressEdge, "the handler answers the press within a step of the pad seeing it").toBeLessThan(2 * DT + SAME_EDGE)
      }
    })
  })
})
