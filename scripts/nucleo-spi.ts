/**
 * Co-simulation check of the "Nucleo SPI link" example: two cores in lockstep, the SPI1
 * master on U1 clocking bytes into the SPI4 slave on U2 over the field's wires, and the
 * slave's replies coming back within the same frame.
 *
 *   pnpm nucleo-spi
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { nucleoSpi } from "@/schematic/examples"
import { pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"

const fw = (name: string) => readFileSync(join(import.meta.dirname, "..", "public", "firmware", name)).toString("base64")
const doc = nucleoSpi.build(GRID)
const u1 = doc.objects.find((o) => o.props?.ref === "U1")!
const u2 = doc.objects.find((o) => o.props?.ref === "U2")!
u1.props = { ...u1.props, firmware: "nucleo-spi-master.elf", firmwareData: fw("nucleo-spi-master.elf") }
u2.props = { ...u2.props, firmware: "nucleo-spi-slave.elf", firmwareData: fw("nucleo-spi-slave.elf") }

const loop = new SimLoop()
loop.setDoc(doc)
loop.setParts(doc.parts)
loop.setRunning(true)
let clock = 0
loop.advance(clock)
function run(seconds: number) {
  const end = clock + seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 30)
    loop.advance(clock)
  }
}
let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0) => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(44)} ${JSON.stringify(got).padStart(14)}  expected ${JSON.stringify(want)}${tol ? ` ±${tol}` : ""}`)
}
type Core = { mcu: { bus: { read32: (a: number) => number; read8: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } } }
const core = (id: string) => (loop as unknown as { mcus: Map<string, { mcu: Core }> }).mcus.get(id)!.mcu.mcu
const sym = (c: ReturnType<typeof core>, name: string) => c.firmware.symbols.find((x) => x.name === name)!.value
const word = (c: ReturnType<typeof core>, name: string) => c.bus.read32(sym(c, name))
const log = (c: ReturnType<typeof core>, n: number) => Array.from({ length: n }, (_, i) => c.bus.read8(sym(c, "rxLog") + i).toString(16)).join(" ")

const wall0 = performance.now()
run(0.1)
const snap = loop.snapshot()!
const m = core(u1.id)
const s = core(u2.id)
expect("master running", snap.mcus[u1.id].running ? "yes" : "no", "yes")
expect("slave running", snap.mcus[u2.id].running ? "yes" : "no", "yes")
expect("bytes sent by the master", word(m, "count"), 9, 1)
expect("bytes received by the slave", word(s, "count"), word(m, "count"))
expect("master reports no HAL errors", word(m, "errors"), 0)
expect("slave reports no HAL errors", word(s, "errors"), 0)
expect("slave's log: a0 a1 a2 ...", log(s, 6), "a0 a1 a2 a3 a4 a5")
expect("master's log: 50 51 52 ...", log(m, 6), "50 51 52 53 54 55")
expect("SCK idles low on the wire", snap.pinVoltage[pinKey(u1.id, "CN7-10")] < 0.5 ? "low" : "high", "low")
expect("chip select idles high on the wire", snap.pinVoltage[pinKey(u2.id, "CN9-16")] > 3 ? "high" : "low", "high")
expect("nothing unmodelled on either core", snap.mcus[u1.id].unmodelled.length + snap.mcus[u2.id].unmodelled.length, 0)

const wall = (performance.now() - wall0) / 1000
console.log(`\n${snap.time.toFixed(2)} s simulated in ${wall.toFixed(1)} s wall (${(snap.time / wall).toFixed(2)}× real time)`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
