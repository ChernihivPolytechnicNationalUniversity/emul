/**
 * Throughput of the simulation loop on every MCU example: simulated seconds per wall second
 * with the loop driven as fast as it can go (speed 8×, so the gauge is never the cap), plus the
 * bare-core instruction rate. The goal is 1× real time for a single board.
 *
 *   pnpm bench                 all examples, 3 s wall each
 *   pnpm bench cube 10         one example (substring of its id), 10 s wall
 *   pnpm bench "" 3 --workers  every core in a worker thread (the browser's arrangement)
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { examples } from "@/schematic/examples"
import { SimLoop } from "@/sim/loop"
import { spawnNodeCore } from "./lib/core-threads"

const filter = process.argv[2] ?? ""
const seconds = Number(process.argv[3] ?? 3)
const workers = process.argv.includes("--workers")

for (const ex of examples) {
  if (!ex.firmware || !ex.id.includes(filter)) continue
  const doc = ex.build(GRID)
  for (const fw of ex.firmware) {
    const obj = doc.objects.find((o) => o.props?.ref === fw.ref)!
    const elf = readFileSync(join(process.cwd(), "public", fw.url))
    obj.props = { ...obj.props, firmware: fw.url.split("/").pop(), firmwareData: elf.toString("base64") }
  }
  const loop = new SimLoop()
  if (workers) loop.spawnCore = spawnNodeCore
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.speed = 8
  loop.setRunning(true)
  loop.advance(performance.now())
  const wall0 = performance.now()
  let now = wall0
  let ticks = 0
  while (now - wall0 < seconds * 1000) {
    loop.advance(now)
    now = performance.now()
    ticks++
  }
  const snap = loop.snapshot()!
  const wall = (now - wall0) / 1000
  const mcus = Object.values(snap.mcus)
  const instr = mcus.reduce((s, m) => s + (m.instructions ?? 0), 0)
  const mhz = mcus.map((m) => ((m.sysclk ?? 0) / 1e6).toFixed(0)).join("+")
  const hosts = [...new Set(mcus.map((m) => m.host))].join(", ")
  console.log(
    `${ex.id.padEnd(22)} ${(snap.time / wall).toFixed(3).padStart(6)}×  sim ${snap.time.toFixed(2)} s in ${wall.toFixed(1)} s wall` +
      `  ${(instr / wall / 1e6).toFixed(1).padStart(5)} MIPS @ ${mhz} MHz  ${(ticks / wall).toFixed(0)} ticks/s  ${hosts}`,
  )
  loop.setRunning(false)
  loop.dispose()
}
