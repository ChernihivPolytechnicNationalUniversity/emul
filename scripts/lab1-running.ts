/**
 * Lab 1 as completed for variant 1 on the Open746I-C: a running light stepped by the joystick.
 * One LED is lit at a time; C runs it LED1→LED4, B the other way, A and D lengthen and shorten
 * the dwell between 1 and 5 s, the centre stops it. The joystick is read through EXTI on the
 * release edge (the inputs are pulled up and the buttons pull them low), so every press here is
 * a press and a release.
 *
 *   pnpm lab1-running
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { lab1RunningLight } from "@/schematic/examples"
import { partKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

const elf = readFileSync(join(import.meta.dirname, "..", "firmware", "examples", "lab1-running-light.elf"))
const doc = lab1RunningLight.build(GRID)
const u = doc.objects.find((o) => o.def === "open746i-c")!
u.props = { ...u.props, firmware: "lab1-running-light.elf", firmwareData: elf.toString("base64") }

const loop = new SimLoop()
loop.setDoc(doc)
loop.setParts(doc.parts)
loop.setRunning(true)

let clock = 0
loop.advance(clock)
function run(seconds: number, sample?: (snap: Snapshot) => void) {
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
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(46)} ${fmt(got).padStart(10)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}

const LEDS = ["LED1", "LED2", "LED3", "LED4"]
const ledOn = (s: Snapshot, id: string) => s.parts[partKey(u.id, id)]?.on ?? false
const ledStr = (s: Snapshot) => LEDS.map((l) => (ledOn(s, l) ? "●" : "○")).join("")
const leds = () => ledStr(loop.snapshot()!)

/** Press a joystick position and let go of it: the firmware acts on the release. */
function tap(part: string) {
  loop.setParts({ [partKey(u.id, part)]: { pressed: true } })
  run(0.05)
  loop.setParts({})
  run(0.05)
}

/** Simulated seconds until the LEDs read `want`, stopping there, or NaN when they never do within `within` s. */
function until(want: string, within: number) {
  const started = loop.snapshot()!.time
  const end = clock + within * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 30)
    loop.advance(clock)
    const s = loop.snapshot()!
    if (ledStr(s) === want) return s.time - started
  }
  return NaN
}

const wall0 = performance.now()
console.log("Boot: HSI, LED1 lit, nothing running")
run(0.1)
const st = loop.snapshot()!.mcus[u.id]
expect("MCU loaded", st?.firmware ?? "none", "lab1-running-light.elf")
expect("core running", st?.running ? "yes" : `no: ${st?.halted}`, "yes")
expect("SYSCLK = HSI", st?.sysclk ?? 0, 16e6)
expect("LEDs after boot", leds(), "●○○○")
run(2.5)
expect("still LED1 after 2.5 s: stopped until told", leds(), "●○○○")

console.log("\nC: run LED1 → LED4, a second per step, wrapping")
tap("JOY_C")
expect("LED2 after", until("○●○○", 1.5), 1.0, 0.1)
expect("LED3 after another", until("○○●○", 1.5), 1.0, 0.1)
expect("LED4 after another", until("○○○●", 1.5), 1.0, 0.1)
expect("back to LED1 after another", until("●○○○", 1.5), 1.0, 0.1)

console.log("\nCentre stops it where it is")
tap("JOY_CTR")
run(2.5)
expect("LED1 held for 2.5 s", leds(), "●○○○")

console.log("\nA lengthens the dwell to 2 s; B runs the other way")
tap("JOY_A")
tap("JOY_B")
expect("LED4 after 2 s, not 1", until("○○○●", 3), 2.0, 0.15)
expect("LED3 after another 2 s", until("○○●○", 3), 2.0, 0.15)

console.log("\nD three times: the dwell floors at 1 s, and the step in flight keeps its timer")
tap("JOY_D")
tap("JOY_D")
tap("JOY_D")
expect("LED2 arrives", Number.isNaN(until("○●○○", 2)) ? "never" : "yes", "yes")
expect("LED1 after another 1 s", until("●○○○", 2), 1.0, 0.15)

console.log("\nA five times: the dwell caps at 5 s")
tap("JOY_CTR")
for (let i = 0; i < 6; i++) tap("JOY_A")
tap("JOY_C")
expect("LED2 after 5 s", until("○●○○", 6.5), 5.0, 0.15)

console.log(`\n${(performance.now() - wall0) / 1000 | 0} s wall`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
