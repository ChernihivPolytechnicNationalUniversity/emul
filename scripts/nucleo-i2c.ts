/**
 * Co-simulation check of the "Nucleo I²C EEPROM" example: the open-drain bus resolved on the
 * field (pull-ups from the rail, the MCU and the EEPROM both pulling low), the EEPROM model
 * answering at the edges' own times, and its contents visible in the snapshot.
 *
 *   pnpm nucleo-i2c
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { nucleoI2c } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import type { EepromSnapshot } from "@/sim/digital"

const elf = readFileSync(join(import.meta.dirname, "..", "public", "firmware", "nucleo-i2c.elf"))
const doc = nucleoI2c.build(GRID)
const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
const mem = doc.objects.find((o) => o.def === "eeprom-24c")!
u.props = { ...u.props, firmware: "nucleo-i2c.elf", firmwareData: elf.toString("base64") }

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
type Core = { mcu: { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } } }
const core = (loop as unknown as { mcus: Map<string, { mcu: Core }> }).mcus.get(u.id)!.mcu.mcu
const word = (name: string) => core.bus.read32(core.firmware.symbols.find((x) => x.name === name)!.value)
const eeprom = () => loop.snapshot()!.digital[mem.id] as EepromSnapshot

const wall0 = performance.now()
run(0.06)
let snap = loop.snapshot()!
expect("core running", snap.mcus[u.id].running ? "yes" : "no", "yes")
expect("greeting verified by the firmware", word("verified"), 1)
expect("no HAL errors", word("errors"), 0)
expect("EEPROM contents in the snapshot", String.fromCharCode(...eeprom().bytes.slice(0, 14)), "Hello, EEPROM!")
expect("SCL idles high on the wire (pull-up)", snap.pinVoltage[pinKey(mem.id, "SCL")] > 3 ? "high" : "low", "high")
expect("SDA idles high on the wire (pull-up)", snap.pinVoltage[pinKey(mem.id, "SDA")] > 3 ? "high" : "low", "high")
expect("LD1 lit (match)", snap.parts[partKey(u.id, "LD1")]?.on ? "on" : "off", "on")
expect("LD3 dark (no error)", snap.parts[partKey(u.id, "LD3")]?.on ? "on" : "off", "off")

console.log("\nCounter survives a reset of the core")
run(0.3)
const before = eeprom().bytes[0x40]
expect("counter written to 0x40", before >= 2 ? "yes" : "no", "yes")
// Power-cycle the board: the EEPROM keeps its bytes, the firmware picks the count up.
loop.setRunning(false)
loop.setRunning(true)
loop.restart()
loop.setDoc(doc)
clock = 0
loop.advance(0)
run(0.15)
snap = loop.snapshot()!
expect("EEPROM kept the greeting through the restart", String.fromCharCode(...eeprom().bytes.slice(0, 5)), "Hello")
expect("counter continued from the stored value", eeprom().bytes[0x40] > before ? "yes" : "no", "yes")
expect("no HAL errors after restart", word("errors"), 0)
expect("nothing unmodelled", snap.mcus[u.id].unmodelled.length, 0)

const wall = (performance.now() - wall0) / 1000
const simulated = 0.36 + snap.time
console.log(`\n${simulated.toFixed(2)} s simulated in ${wall.toFixed(1)} s wall (${(simulated / wall).toFixed(2)}× real time)`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
