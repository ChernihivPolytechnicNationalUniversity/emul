import { describe, expect, it } from "vitest"
import { STM32F429ZI, STM32F746IG } from "@/mcu/chip"
import { Stm32 } from "@/mcu/stm32f429"
import { GRID } from "@/schematic/geometry"
import { nucleoBlink } from "@/schematic/examples"
import { CTL, LocalCore, RemoteCore, WORKER_STOPPED_ANSWERING, type CoreHost, type CoreTransport, type ToCore } from "@/sim/core-host"
import { SimLoop } from "@/sim/loop"
import { spawnNodeCore } from "../../scripts/lib/core-threads"
import { buffer, example, exampleBase64 } from "../lib/firmware"
import { spawnTrippingCore } from "../lib/tripping-core"

const BLINK = "nucleo-blink.elf"
const OVERFLOW = "exam-overflow.elf"
const STEP = 1e-3
const STEPS_BEFORE_THE_TRIP = 3
const BENCH_SECONDS_BEFORE_THE_TRIP = 0.25
const QUICK_MS = 2000
const SHORT_DEADLINE_MS = 300

const ready = async (core: CoreHost) => {
  while (!core.ready) await new Promise((resolve) => setTimeout(resolve, 10))
}

const runFor = (core: CoreHost, steps: number) => {
  let ok = true
  for (let k = 1; k <= steps; k++) ok = core.runUntil(core.time + STEP)
  return ok
}

function silentWorker(): CoreTransport {
  return {
    post: (msg: ToCore) => {
      if (msg.t === "init") Atomics.store(new Int32Array(msg.shm, 0, CTL.WORDS), CTL.READY, 1)
    },
    onMessage: () => {},
    terminate: () => {},
  }
}

describe("a core that fails inside a run stops with the reason and the bench goes on (BUGS.md, Compile on a running board)", () => {
  it("an error inside the emulator halts a core in this thread instead of escaping the run", () => {
    const core = new LocalCore(STM32F429ZI)
    core.load(buffer(example(BLINK)), BLINK)
    expect(runFor(core, 2), "blink runs").toBe(true)
    core.mcu.cpu.run = () => {
      throw new TypeError("the emulator tripped")
    }
    expect(core.runUntil(core.time + STEP), "the run ends").toBe(false)
    expect(core.halted).toBe(true)
    expect(core.status().halted).toContain("emulator error: the emulator tripped")
  })

  it("a worker whose run throws still answers, with its core halted and the error as the reason", async () => {
    const core = new RemoteCore(STM32F429ZI, [], spawnTrippingCore(STEPS_BEFORE_THE_TRIP * STEP))
    try {
      await ready(core)
      core.load(buffer(example(BLINK)), BLINK)
      runFor(core, STEPS_BEFORE_THE_TRIP)
      expect(core.running, "blink runs in the worker").toBe(true)
      const started = performance.now()
      runFor(core, 3)
      expect(performance.now() - started, "ms until the worker answered").toBeLessThan(QUICK_MS)
      expect(core.halted).toBe(true)
      expect(core.status().halted).toContain("emulator error")
    } finally {
      core.dispose()
    }
  })

  it("a worker that stops answering is given up on: its core halts with that reason and stays halted", () => {
    const core = new RemoteCore(STM32F429ZI, [], silentWorker(), SHORT_DEADLINE_MS)
    expect(core.ready).toBe(true)
    core.load(buffer(example(BLINK)), BLINK)
    const started = performance.now()
    runFor(core, 3)
    expect(performance.now() - started, "ms until the core was given up on").toBeLessThan(QUICK_MS)
    expect(core.halted).toBe(true)
    expect(core.running).toBe(false)
    expect(core.status().halted).toBe(WORKER_STOPPED_ANSWERING)
    core.reset()
    core.load(buffer(example(BLINK)), BLINK)
    expect(core.halted, "a reset or a new image cannot revive a worker that does not answer").toBe(true)
    expect(core.runUntil(core.time + STEP)).toBe(false)
  })

  it.each([
    ["this thread", false],
    ["a worker thread", true],
  ])("a firmware fault in %s halts as the firmware's own lockup, never as an emulator error", async (_, worker) => {
    const core = worker ? new RemoteCore(STM32F746IG, [], spawnNodeCore()) : new LocalCore(STM32F746IG)
    try {
      await ready(core)
      core.load(buffer(example(OVERFLOW)), OVERFLOW)
      runFor(core, 10)
      expect(core.halted, "the recursion ran the stack below RAM").toBe(true)
      expect(core.status().halted).toMatch(/^lockup at 0x[0-9a-f]{8}: /)
      expect(core.status().halted).not.toContain("emulator error")
    } finally {
      core.dispose()
    }
  })

  it.each([
    ["this thread", false],
    ["a worker thread", true],
  ])("the bench keeps its time after the core in %s fails mid-run", async (_, workers) => {
    const doc = nucleoBlink.build(GRID)
    const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
    u.props = { ...u.props, firmware: BLINK, firmwareData: exampleBase64(BLINK) }
    const loop = new SimLoop()
    if (workers) loop.spawnCore = () => spawnTrippingCore(BENCH_SECONDS_BEFORE_THE_TRIP)
    let clock = 0
    const run = (seconds: number) => {
      const end = clock + seconds * 1000
      while (clock < end) {
        clock = Math.min(end, clock + 30)
        loop.advance(clock)
      }
    }
    try {
      loop.setDoc(doc)
      loop.setParts(doc.parts)
      loop.setRunning(true)
      loop.advance(clock)
      while (loop.booting) await new Promise((resolve) => setTimeout(resolve, 10))
      run(0.2)
      expect(loop.snapshot()!.mcus[u.id]?.running, "blink runs").toBe(true)
      const host = (loop as unknown as { mcus: Map<string, { mcu: CoreHost }> }).mcus.get(u.id)!.mcu
      if (host instanceof LocalCore)
        host.mcu.cpu.run = () => {
          throw new TypeError("the emulator tripped")
        }
      const before = loop.snapshot()!.time
      run(0.3)
      const after = loop.snapshot()!
      expect(after.time - before, "bench seconds after the failure").toBeGreaterThan(0.25)
      expect(after.mcus[u.id]?.running).toBe(false)
      expect(after.mcus[u.id]?.halted).toContain("emulator error")
    } finally {
      loop.dispose()
    }
  })
})

describe("a pad the chip does not have", () => {
  it("is ignored by setPad and setPadAt rather than crashing the core", () => {
    const mcu = new Stm32(STM32F746IG)
    const missing = { port: 15, pin: 0 }
    expect(() => mcu.setPad(missing, true)).not.toThrow()
    expect(() => mcu.setPadAt(missing, true, 0)).not.toThrow()
    expect(() => mcu.setPadAt({ port: 0, pin: 16 }, true, 1)).not.toThrow()
    expect(mcu.hasPad(missing)).toBe(false)
    expect(mcu.hasPad({ port: 0, pin: 15 })).toBe(true)
  })
})
