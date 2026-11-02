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
import { basename, join } from "node:path"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import type { Schematic } from "@/schematic/types"
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
  "nucleo-melody": { U1: "nucleo-melody.elf" },
  "nano-dimmer": { U1: "../arduino/build/dimmer.elf" },
}

/** Circuits that are not palette examples: a Nano with a parallel 1602 and its contrast pot, as people wire it. */
function nanoLcd(): Schematic {
  const b = builder(GRID)
  const elf = readFileSync(join(process.cwd(), "firmware", "arduino", "build", "lcd-hello.elf"))
  const nano = b.place("arduino-nano", 0, 0, { firmware: "lcd-hello.elf", firmwareData: elf.toString("base64") })
  const lcd = b.place("lcd-1602", 16, 4)
  const pin: Record<string, string> = { D12: "J1-15", D11: "J1-14", D5: "J1-8", D4: "J1-7", D3: "J1-6", D2: "J1-5", "5V": "J2-4", GND: "J2-2" }
  for (const [p, lp] of [["D12", "RS"], ["D11", "E"], ["D5", "D4"], ["D4", "D5"], ["D3", "D6"], ["D2", "D7"], ["5V", "VDD"], ["5V", "A"], ["GND", "VSS"], ["GND", "RW"], ["GND", "K"]]) b.wire(nano, pin[p], lcd, lp)
  const pot = b.place("potentiometer", 16, 20, { pos: "0.8" })
  const g = b.place("ground", 22, 26)
  b.wire(nano, pin["5V"], pot, "1")
  b.wire(pot, "2", g, "GND")
  b.wire(pot, "W", lcd, "V0")
  return b.doc
}

const scenarios: { id: string; build: () => Schematic }[] = []
for (const ex of examples) {
  const firmware = FIRMWARE[ex.id]
  if (!firmware) continue
  scenarios.push({
    id: ex.id,
    build() {
      const doc = ex.build(GRID)
      for (const [ref, name] of Object.entries(firmware)) {
        const obj = doc.objects.find((o) => o.props?.ref === ref)!
        const elf = readFileSync(join(process.cwd(), "firmware", "examples", name))
        obj.props = { ...obj.props, firmware: basename(name), firmwareData: elf.toString("base64") }
      }
      return doc
    },
  })
}
scenarios.push({ id: "nano-lcd1602", build: nanoLcd })

for (const sc of scenarios) {
  if (!sc.id.includes(filter)) continue
  const doc = sc.build()
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
    `${sc.id.padEnd(22)} ${(snap.time / wall).toFixed(3).padStart(6)}×  sim ${snap.time.toFixed(2)} s in ${wall.toFixed(1)} s wall` +
      `  ${(instr / wall / 1e6).toFixed(1).padStart(5)} MIPS @ ${mhz} MHz  ${(ticks / wall).toFixed(0)} ticks/s  ${hosts}`,
  )
  loop.setRunning(false)
  loop.dispose()
}
