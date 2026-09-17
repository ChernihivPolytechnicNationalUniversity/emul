/**
 * Co-simulation check of the "Nucleo ADC and DAC" example: the ADC samples the wiper's net
 * voltage out of the solver, the PWM duty follows the pot, the DAC's sine drives a real LED
 * load through the field.
 *
 *   pnpm nucleo-adc
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { nucleoAdc } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"

const elf = readFileSync(join(import.meta.dirname, "..", "firmware", "examples", "nucleo-adc.elf"))
const doc = nucleoAdc.build(GRID)
const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
const pot = doc.objects.find((o) => o.def === "potentiometer")!
const led = doc.objects.find((o) => o.def === "led")!
u.props = { ...u.props, firmware: "nucleo-adc.elf", firmwareData: elf.toString("base64") }

const loop = new SimLoop()
loop.setDoc(doc)
loop.setParts(doc.parts)
loop.setRunning(true)
let clock = 0
loop.advance(clock)
const dacTrace: number[] = []
function run(seconds: number) {
  const end = clock + seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 2)
    loop.advance(clock)
    const s = loop.snapshot()!
    dacTrace.push(s.pinVoltage[pinKey(u.id, "CN7-17")])
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

const wall0 = performance.now()
run(0.1)
let snap = loop.snapshot()!
expect("core running", snap.mcus[u.id].running ? "yes" : "no", "yes")
expect("no HAL errors", word("errors"), 0)
expect("wiper at 70 % → 0.99 V on A0", snap.pinVoltage[pinKey(u.id, "CN9-1")], 0.99, 0.02)
expect("ADC reads it (counts)", word("adcValue"), 1229, 15)
const ld1 = snap.parts[partKey(u.id, "LD1")]?.level ?? 0
expect("LD1 dimmed (30 % duty)", ld1 > 0.03 && ld1 < 0.15 ? "dim" : ld1 <= 0.03 ? "off" : "full", "dim")

console.log("\nTurn the pot up")
pot.props = { ...pot.props, pos: "0.1" }
loop.setDoc(doc)
run(0.1)
snap = loop.snapshot()!
expect("A0 now near 2.97 V", snap.pinVoltage[pinKey(u.id, "CN9-1")], 2.97, 0.03)
expect("ADC follows", word("adcValue"), 3686, 20)
expect("LD1 brighter", (snap.parts[partKey(u.id, "LD1")]?.level ?? 0) > ld1 ? "yes" : "no", "yes")

console.log("\nDAC sine into the LED")
const recent = dacTrace.slice(-50)
// 100 Ω of DAC output resistance into 1 kΩ + LED drops the peak a little.
expect("DAC pin swings up to ~3.15 V", Math.max(...recent), 3.15, 0.1)
expect("and down to ~0 V", Math.min(...recent), 0, 0.15)
const glow = snap.parts[partKey(led.id, "LED")]?.level ?? 0
expect("the LED glows dimly (average of the sine)", glow > 0.02 && glow < 0.6 ? "dim" : glow <= 0.02 ? "off" : "full", "dim")
expect("nothing unmodelled", snap.mcus[u.id].unmodelled.length, 0)

const wall = (performance.now() - wall0) / 1000
console.log(`\n${snap.time.toFixed(2)} s simulated in ${wall.toFixed(1)} s wall (${(snap.time / wall).toFixed(2)}× real time)`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
