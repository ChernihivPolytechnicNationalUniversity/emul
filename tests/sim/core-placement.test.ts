/**
 * Where a core runs when cores may run in workers (the browser's arrangement). A core with
 * nothing on its nets to answer its edges runs in its worker, pipelined a step ahead. One that
 * must run in step (a part answering on its pins, two of its own pads coupled) runs in the loop's
 * thread when it starts that way: a worker in step waits on the loop every step and ran 2–3 times
 * slower than the same core here (nucleo-pwm 0.49× → 0.16×, open746-lcd 1.65× → 0.82× in Chrome).
 * A core already running stays where it is when a part is wired to it: a move would reload it.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { builder } from "@/schematic/builder"
import { examples } from "@/schematic/examples"
import type { Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { spawnNodeCore } from "../../scripts/lib/core-threads"
import { FIRMWARE, exampleBase64 } from "../lib/firmware"

function withFirmware(id: string, ref: string, name: string, data: string): Schematic {
  const doc = examples.find((e) => e.id === id)!.build(GRID)
  const obj = doc.objects.find((o) => o.props?.ref === ref)!
  obj.props = { ...obj.props, firmware: name, firmwareData: data }
  return doc
}

function dimmerElf() {
  const elf = join(FIRMWARE, "arduino", "build", "dimmer.elf")
  if (!existsSync(elf)) throw new Error(`${elf} is missing — build the sketches with \`pnpm firmware-arduino\``)
  return readFileSync(elf).toString("base64")
}

async function start(doc: Schematic) {
  const loop = new SimLoop()
  loop.spawnCore = () => spawnNodeCore()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  while (loop.booting) await new Promise((r) => setTimeout(r, 10))
  let clock = 0
  const run = (ms: number) => {
    const end = clock + ms
    while (clock < end) {
      clock = Math.min(end, clock + 10)
      loop.advance(clock)
    }
  }
  return { loop, run }
}

const host = (loop: SimLoop, id: string) => loop.snapshot()!.mcus[id].host

describe("where a core runs", () => {
  it("a Nano dimming an LED (nothing answers on its pins): in its worker, pipelined", async () => {
    const doc = withFirmware("nano-dimmer", "U1", "dimmer.elf", dimmerElf())
    const { loop, run } = await start(doc)
    run(50)
    expect(host(loop, doc.objects.find((o) => o.def === "arduino-nano")!.id)).toBe("worker (pipelined)")
    loop.dispose()
  })

  it("the Nucleo PWM example, which runs in step: in this thread from the start", async () => {
    const doc = withFirmware("nucleo-pwm", "U1", "nucleo-pwm.elf", exampleBase64("nucleo-pwm.elf"))
    const { loop, run } = await start(doc)
    run(50)
    expect(host(loop, doc.objects.find((o) => o.props?.ref === "U1")!.id)).toBe("in-process")
    loop.dispose()
  })

  it("a running Nano that gets an LCD 1602 on its pins stays in its worker, in step, and runs on unreloaded", async () => {
    const doc = withFirmware("nano-dimmer", "U1", "dimmer.elf", dimmerElf())
    const { loop, run } = await start(doc)
    const nano = doc.objects.find((o) => o.def === "arduino-nano")!
    run(300)
    const before = loop.snapshot()!.mcus[nano.id]
    const b = builder(GRID)
    const lcd = b.place("lcd-1602", 30, 20)
    for (const [p, lp] of [["J1-15", "RS"], ["J1-14", "E"], ["J1-8", "D4"], ["J1-7", "D5"], ["J1-6", "D6"], ["J1-5", "D7"]]) b.wire(nano, p, lcd, lp)
    loop.setDoc({ ...doc, objects: [...doc.objects, ...b.doc.objects], wires: [...doc.wires, ...b.doc.wires] })
    run(300)
    const after = loop.snapshot()!.mcus[nano.id]
    expect(after.host).toBe("worker (in step)")
    expect(after.time).toBeGreaterThan(before.time)
    expect(after.instructions).toBeGreaterThan(before.instructions)
    loop.dispose()
  })
})
