/**
 * A new image on a running board: Compile while the simulation runs. The core must start over
 * on the new program (time from 0, instructions from 0) while the bench keeps its time — and,
 * in a worker, must actually be asked to run again. Both core arrangements are checked, and so
 * is the first image on a board that has been running without one (an example's sources
 * compiled on a live bench): the core must start the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoBlink } from "@/schematic/examples"
import type { Schematic } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { spawnNodeCore } from "../../scripts/lib/core-threads"
import { exampleBase64 } from "../lib/firmware"

const booted = async (loop: SimLoop) => {
  while (loop.booting) await new Promise((r) => setTimeout(r, 10))
}

function bench(workers: boolean, firmware: string) {
  const doc = nucleoBlink.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  u.props = { ...u.props, firmware, firmwareData: firmware ? exampleBase64(firmware) : "" }
  const loop = new SimLoop()
  let spawned = 0
  if (workers)
    loop.spawnCore = () => {
      spawned++
      return spawnNodeCore()
    }
  let clock = 0
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
    }
  }
  const start = async () => {
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    await booted(loop)
  }
  const flash = async (name: string) => {
    u.props = { ...u.props, firmware: name, firmwareData: exampleBase64(name) }
    loop.setDoc({ ...doc, objects: doc.objects.map((o) => (o.id === u.id ? { ...o, props: { ...u.props } } : o)) } satisfies Schematic)
    await booted(loop)
  }
  return { loop, u, run, start, flash, spawned: () => spawned }
}

describe.each([
  ["this thread", false],
  ["a worker thread", true],
])("reflash with the core in %s", (_, workers) => {
  const b = bench(workers, "nucleo-blink.elf")
  const status = (snap: Snapshot) => snap.mcus[b.u.id]!
  let before: Snapshot
  let after: Snapshot

  beforeAll(async () => {
    await b.start()
    b.run(1.5)
    before = b.loop.snapshot()!
    await b.flash("nucleo-square.elf")
    b.run(1.0)
    after = b.loop.snapshot()!
  })
  afterAll(() => b.loop.dispose())

  it("puts the core where it was asked", () => expect(b.spawned() > 0).toBe(workers))

  it("runs blink before the reflash", () => {
    expect(status(before).running).toBe(true)
    expect(status(before).instructions).toBeGreaterThan(1e5)
  })

  it("puts the new image on the board", () => expect(status(after).firmware).toBe("nucleo-square.elf"))

  it("starts the core over and runs it", () => {
    const s1 = status(after)
    expect(s1.running).toBe(true)
    expect(s1.time).toBeGreaterThan(0.5)
    expect(s1.time).toBeLessThan(1.5)
  })

  it("counts instructions from the reset", () => {
    expect(status(after).instructions).toBeGreaterThan(1e5)
    expect(status(after).instructions).toBeLessThan(status(before).instructions * 3)
  })

  it("keeps the bench time going", () => expect(after.time).toBeGreaterThan(before.time + 0.9))

  it("is still running half a second later", () => {
    b.run(0.5)
    const s2 = status(b.loop.snapshot()!)
    expect(s2.running).toBe(true)
    expect(s2.time).toBeGreaterThan(status(after).time + 0.4)
  })
})

describe.each([
  ["this thread", false],
  ["a worker thread", true],
])("first image on a live board, core in %s", (_, workers) => {
  const b = bench(workers, "")
  let before: Snapshot
  let after: Snapshot

  beforeAll(async () => {
    await b.start()
    b.run(1.0)
    before = b.loop.snapshot()!
    await b.flash("nucleo-blink.elf")
    b.run(1.0)
    after = b.loop.snapshot()!
  })
  afterAll(() => b.loop.dispose())

  it("puts the core where it was asked", () => expect(b.spawned() > 0).toBe(workers))

  it("has no core while the board has no program", () => expect(before.mcus[b.u.id]).toBeUndefined())

  it("puts the image on the board", () => expect(after.mcus[b.u.id]?.firmware).toBe("nucleo-blink.elf"))

  it("runs the core from its reset", () => {
    const s1 = after.mcus[b.u.id]!
    expect(s1.running).toBe(true)
    expect(s1.time).toBeGreaterThan(0.5)
    expect(s1.instructions).toBeGreaterThan(1e5)
  })
})
