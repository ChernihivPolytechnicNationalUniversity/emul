/**
 * A new image on a running board: Compile while the simulation runs. The core must start
 * over on the new program (time from 0, instructions from 0) while the bench keeps its time —
 * and, in a worker, must actually be asked to run again. Both core arrangements are checked.
 *
 *   pnpm reflash
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { nucleoBlink } from "@/schematic/examples"
import { SimLoop } from "@/sim/loop"
import { spawnNodeCore } from "./lib/core-threads"

const fw = (name: string) => readFileSync(join(import.meta.dirname, "..", "firmware", "examples", name)).toString("base64")
let failed = 0
const expect = (what: string, ok: boolean, got: string) => {
  if (!ok) failed++
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(48)} ${got}`)
}

for (const workers of [false, true]) {
  console.log(workers ? "\nCore in a worker thread" : "Core in this thread")
  const doc = nucleoBlink.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  u.props = { ...u.props, firmware: "nucleo-blink.elf", firmwareData: fw("nucleo-blink.elf") }
  const loop = new SimLoop()
  if (workers) loop.spawnCore = spawnNodeCore
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
    }
  }
  run(1.5)
  const before = loop.snapshot()!
  const s0 = before.mcus[u.id]!
  expect("blink running before the reflash", s0.running && s0.instructions > 1e5, `${s0.firmware}, t=${s0.time.toFixed(3)} s, ${s0.instructions} instr`)

  // The build lands: the board gets a different image, the document is re-sent as the UI does.
  u.props = { ...u.props, firmware: "nucleo-square.elf", firmwareData: fw("nucleo-square.elf") }
  loop.setDoc({ ...doc, objects: doc.objects.map((o) => (o.id === u.id ? { ...o, props: { ...u.props } } : o)) })
  run(1.0)
  const after = loop.snapshot()!
  const s1 = after.mcus[u.id]!
  expect("new image on the board", s1.firmware === "nucleo-square.elf", s1.firmware)
  expect("core started over and runs", s1.running && s1.time > 0.5 && s1.time < 1.5, `t=${s1.time.toFixed(3)} s`)
  expect("instructions counted from the reset", s1.instructions > 1e5 && s1.instructions < s0.instructions * 3, `${s1.instructions}`)
  expect("bench time kept going", after.time > before.time + 0.9, `${before.time.toFixed(2)} → ${after.time.toFixed(2)} s`)
  run(0.5)
  const s2 = loop.snapshot()!.mcus[u.id]!
  expect("still running half a second later", s2.running && s2.time > s1.time + 0.4, `t=${s2.time.toFixed(3)} s`)
  loop.dispose()
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nreflash OK")
process.exit(failed ? 1 : 0)
