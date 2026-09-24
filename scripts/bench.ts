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

/** The examples' programs as built ELFs (firmware/examples): the site ships sources, the bench wants images. */
const FIRMWARE: Record<string, Record<string, string>> = {
  "nucleo-blink": { U1: "nucleo-blink.elf" },
  "nucleo-square": { U1: "nucleo-square.elf" },
  "lab1-open746i-c": { U1: "lab1-f746.elf" },
  "open746-lcd": { U1: "open746-lcd.elf" },
  "open746-touch": { U1: "open746-touch.elf" },
  "open746-cube": { U1: "open746-cube.elf" },
  "lab1-f746": { DD1: "lab1-f746.elf" },
  "nucleo-pwm": { U1: "nucleo-pwm.elf" },
  "nucleo-serial": { U1: "nucleo-uart.elf" },
  "nucleo-spi": { U1: "nucleo-spi-master.elf", U2: "nucleo-spi-slave.elf" },
  "nucleo-i2c": { U1: "nucleo-i2c.elf" },
  "nucleo-adc": { U1: "nucleo-adc.elf" },
}

for (const ex of examples) {
  const firmware = FIRMWARE[ex.id]
  if (!firmware || !ex.id.includes(filter)) continue
  const doc = ex.build(GRID)
  for (const [ref, name] of Object.entries(firmware)) {
    const obj = doc.objects.find((o) => o.props?.ref === ref)!
    const elf = readFileSync(join(process.cwd(), "firmware", "examples", name))
    obj.props = { ...obj.props, firmware: name, firmwareData: elf.toString("base64") }
  }
  const loop = new SimLoop()
  if (workers) loop.spawnCore = spawnNodeCore
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.speed = 8
  loop.setRunning(true)
  while (loop.booting) await new Promise((r) => setTimeout(r, 10))
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
