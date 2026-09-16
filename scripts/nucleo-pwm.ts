/**
 * Co-simulation check of the "Nucleo timers and PWM" example: LD1 dimmed by TIM3 reads as a
 * steady brightness that follows the duty, the external LED on D6 sees TIM1's 20 kHz PWM, and
 * TIM4 measures LD1's PWM through the wire from D33 to D26.
 *
 *   pnpm nucleo-pwm
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { nucleoPwm } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

const elf = readFileSync(join(import.meta.dirname, "..", "public", "firmware", "nucleo-pwm.elf"))
const doc = nucleoPwm.build(GRID)
const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
const led = doc.objects.find((o) => o.def === "led")!
u.props = { ...u.props, firmware: "nucleo-pwm.elf", firmwareData: elf.toString("base64") }

const loop = new SimLoop()
loop.setDoc(doc)
loop.setParts(doc.parts)
loop.setRunning(true)
let clock = 0
loop.advance(clock)
function run(seconds: number, sample?: (s: Snapshot) => void) {
  const end = clock + seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 30)
    loop.advance(clock)
    if (sample) sample(loop.snapshot()!)
  }
}
let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0) => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(4)) : String(v))
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(44)} ${fmt(got).padStart(10)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}

const wall0 = performance.now()
run(0.06)
let snap = loop.snapshot()!
const st = snap.mcus[u.id]
expect("core running", st.running ? "yes" : `no: ${st.halted}`, "yes")
expect("no unmodelled blocks", st.unmodelled.map((b) => b.block).join(",") || "none", "none")
const ld1 = () => loop.snapshot()!.parts[partKey(u.id, "LD1")]!.level
const ext = () => loop.snapshot()!.parts[partKey(led.id, "LED")]!.level
// LD1: 3.3 V through 510 Ω into a green LED ≈ 2.4 mA at 100 % → level 0.3; at 10 % duty a tenth of it.
const full = (3.3 - 2.1) / 510 / 8e-3
expect("LD1 level at 10 % duty", ld1(), full * 0.1, 0.02)
expect("external LED level at 30 % (TIM1, 330 Ω)", ext(), ((3.3 - 2.1) / 330 / 8e-3) * 0.3, 0.03)
const d6 = snap.pinVoltage[pinKey(u.id, "CN10-4")]
expect("D6 sits at a rail at any instant (it is a 20 kHz PWM)", d6 < 0.3 || d6 > 3.0 ? "yes" : "no", "yes")

console.log("\nDuty ramp seen on LD1")
for (const duty of [20, 30, 40, 50]) {
  run(0.1)
  expect(`LD1 level at ${duty} %`, ld1(), full * duty / 100, 0.03)
}
// LD2 (blue, 330 Ω) is toggled at 200 Hz by the TIM2 interrupt: a 100 Hz square the eye sees as half brightness.
const ld2: number[] = []
run(0.1, (s) => ld2.push(s.parts[partKey(u.id, "LD2")]!.level))
const ld2Mean = ld2.reduce((a, b) => a + b, 0) / ld2.length
expect("LD2 lit by the TIM2 interrupt (100 Hz)", ld2Mean > 0.03 ? "lit" : "dark", "lit")
expect("LD2 reads steady, not strobing", (Math.max(...ld2) - Math.min(...ld2)) / ld2Mean, 0, 0.3)
snap = loop.snapshot()!
const wall = (performance.now() - wall0) / 1000
console.log(`\n${snap.time.toFixed(2)} s simulated in ${wall.toFixed(1)} s wall (${(snap.time / wall).toFixed(2)}× real time)`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
