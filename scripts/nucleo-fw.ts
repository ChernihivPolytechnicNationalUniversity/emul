/**
 * Co-simulation check: the "Nucleo blink" schematic with the HAL blink firmware loaded into
 * U1, run through the same SimLoop the worker uses. The firmware drives PA5 (D13) into the
 * external LED and PB0/PB7 into the on-board ones; the USER button goes back in through EXTI.
 *
 *   pnpm nucleo-fw
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { nucleoBlink } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

const elf = readFileSync(join(import.meta.dirname, "..", "firmware", "hal", "build", "blink.elf"))
const doc = nucleoBlink.build(GRID)
const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
const led = doc.objects.find((o) => o.def === "led")!
u.props = { ...u.props, firmware: "blink.elf", firmwareData: elf.toString("base64") }

const loop = new SimLoop()
loop.setDoc(doc)
loop.setParts(doc.parts)
loop.setRunning(true)

let clock = 0
loop.advance(clock)
/** Advance by `seconds` of simulated time in 30 ms wall ticks, sampling after each. */
function run(seconds: number, sample?: (snap: Snapshot) => void) {
  const end = clock + seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 30)
    loop.advance(clock)
    if (sample) sample(loop.snapshot()!)
  }
}

type Check = { what: string; got: number | string; want: number | string; tol?: number }
let failed = 0
let total = 0
const expect = (c: Check) => {
  total++
  const ok = typeof c.got === "number" && typeof c.want === "number" ? (c.want === 0 ? Math.abs(c.got) <= (c.tol ?? 0) : Math.abs(c.got - c.want) / Math.abs(c.want) <= (c.tol ?? 0)) : c.got === c.want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(5)) : String(v))
  console.log(`  ${ok ? "✓" : "✗"} ${c.what.padEnd(40)} ${fmt(c.got).padStart(12)}  expected ${fmt(c.want)}${c.tol ? ` ±${c.tol * 100}%` : ""}`)
}

const wall0 = performance.now()
console.log("Boot")
run(0.02)
let snap = loop.snapshot()!
const st = snap.mcus[u.id]
expect({ what: "MCU loaded", got: st?.firmware ?? "none", want: "blink.elf" })
expect({ what: "core running", got: st?.running ? "yes" : `no: ${st?.halted}`, want: "yes" })
expect({ what: "SYSCLK", got: st?.sysclk ?? 0, want: 180e6 })

console.log("\n3 s of blinking")
const d13 = pinKey(u.id, "CN7-10")
const edges: number[] = []
let lastLevel: boolean | null = null
const ld2Levels: number[] = []
run(3, (s) => {
  const v = s.pinVoltage[d13]
  const level = v > 1.65
  if (lastLevel !== null && level !== lastLevel) edges.push(s.time)
  lastLevel = level
  ld2Levels.push(s.parts[partKey(u.id, "LD2")]?.level ?? 0)
})
snap = loop.snapshot()!
const period = edges.length >= 3 ? (2 * (edges[edges.length - 1] - edges[0])) / (edges.length - 1) : 0
expect({ what: "D13 toggles seen in 3 s", got: edges.length, want: 6, tol: 0.2 })
expect({ what: "D13 toggle period (HAL_Delay 500 → 501 ms)", got: period, want: 1.002, tol: 0.01 })
const ledOn = snap.parts[partKey(led.id, "LED")]
const d13High = snap.pinVoltage[d13] > 1.65
expect({ what: "external LED follows D13", got: ledOn?.on === d13High ? "yes" : "no", want: "yes" })
expect({ what: "LD1 (PB0) state matches D13", got: (snap.parts[partKey(u.id, "LD1")]?.on ?? false) === d13High ? "yes" : "no", want: "yes" })
const ld2Toggles = ld2Levels.reduce((n, l, i) => (i > 0 && (l > 0.05) !== (ld2Levels[i - 1] > 0.05) ? n + 1 : n), 0)
expect({ what: "LD2 (PB7) toggles in 3 s (5 Hz)", got: ld2Toggles, want: 30, tol: 0.1 })
expect({ what: "D13 high level", got: Math.max(...edges.map(() => 0), snap.pinVoltage[d13] > 1.65 ? snap.pinVoltage[d13] : 3.15), want: 3.15, tol: 0.03 })

console.log("\nUSER button through the analog switch into EXTI")
const before = snap.parts[partKey(u.id, "LD3")]?.on ?? false
loop.setParts({ [partKey(u.id, "B1")]: { pressed: true } })
run(0.05)
loop.setParts({ [partKey(u.id, "B1")]: { pressed: false } })
run(0.05)
snap = loop.snapshot()!
expect({ what: "LD3 toggled by the press", got: (snap.parts[partKey(u.id, "LD3")]?.on ?? false) !== before ? "yes" : "no", want: "yes" })

console.log("\nUSB unplugged: the core loses power and restarts when it is plugged back in")
loop.setParts({ [partKey(u.id, "USB")]: { on: false } })
run(0.1)
snap = loop.snapshot()!
expect({ what: "core reports no power", got: snap.mcus[u.id].powered ? "powered" : "no power", want: "no power" })
expect({ what: "+3V3 collapsed", got: snap.pinVoltage[pinKey(u.id, "CN8-7")], want: 0, tol: 1e-3 })
expect({ what: "LD1 dark", got: snap.parts[partKey(u.id, "LD1")]?.on ? "on" : "off", want: "off" })
loop.setParts({ [partKey(u.id, "USB")]: { on: true } })
run(0.05)
snap = loop.snapshot()!
expect({ what: "core powered again", got: snap.mcus[u.id].powered ? "powered" : "no power", want: "powered" })
expect({ what: "core restarted from t = 0", got: snap.mcus[u.id].time < 0.06 ? "yes" : `no: ${snap.mcus[u.id].time.toFixed(3)} s`, want: "yes" })
expect({ what: "core running", got: snap.mcus[u.id].running ? "yes" : "no", want: "yes" })

const wall = (performance.now() - wall0) / 1000
console.log(`\n${snap.time.toFixed(2)} s simulated in ${wall.toFixed(1)} s wall (${(snap.time / wall).toFixed(2)}× real time); MCU: ${snap.mcus[u.id].instructions} instructions, halted: ${snap.mcus[u.id].halted ?? "no"}`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
