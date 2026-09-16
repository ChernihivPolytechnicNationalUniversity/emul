/**
 * Co-simulation check of lab 1: the "Lab 1: STM32F746 stand" schematic — a bare STM32F746IGT6
 * with LEDs and a joystick drawn around it — running the lab's firmware through the same
 * SimLoop the worker uses. Checks the LED staircase through the real resistors and diodes,
 * the joystick pull-ups, and the reset button on NRST.
 *
 *   pnpm lab1-sim
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { lab1Stand } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

const elf = readFileSync(join(import.meta.dirname, "..", "public", "firmware", "lab1-f746.elf"))
const doc = lab1Stand.build(GRID)
const dd = doc.objects.find((o) => o.def === "stm32f746ig")!
const byRef = (ref: string) => doc.objects.find((o) => o.props?.ref === ref)!
dd.props = { ...dd.props, firmware: "lab1-f746.elf", firmwareData: elf.toString("base64") }

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

let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0) => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(4)) : String(v))
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(44)} ${fmt(got).padStart(10)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}

const LEDS = ["VD1", "VD2", "VD3", "VD4"]
const ledOn = (s: Snapshot, ref: string) => s.parts[partKey(byRef(ref).id, "LED")]?.on ?? false
const ledStr = (s: Snapshot) => LEDS.map((l) => (ledOn(s, l) ? "●" : "○")).join("")

const wall0 = performance.now()
console.log("Boot")
run(0.05)
let snap = loop.snapshot()!
const st = snap.mcus[dd.id]
expect("MCU loaded", st?.firmware ?? "none", "lab1-f746.elf")
expect("core running", st?.running ? "yes" : `no: ${st?.halted}`, "yes")
expect("SYSCLK", st?.sysclk ?? 0, 50e6)
expect("VDD pin", snap.pinVoltage[pinKey(dd.id, "VDD")], 3.3, 0.01)
expect("NRST idles high on the pull-up", snap.pinVoltage[pinKey(dd.id, "NRST")], 3.3, 0.01)
for (const p of ["PG2", "PG3", "PD4", "PD5", "PI11"]) expect(`joystick ${p} pulled up`, snap.pinVoltage[pinKey(dd.id, p)], 3.3, 0.05)
expect("LEDs after boot (L1 on)", ledStr(snap), "●○○○")
const i1 = snap.pinCurrent[pinKey(byRef("R2").id, "1")]
expect("L1 current through 1 kΩ (mA)", Math.abs(i1) * 1e3, (3.3 - 1.9) / 1e3 * 1e3, 0.3)

console.log("\nStaircase: L2 at 1 s, L3 at 3 s, L4 at 6 s, then off from 10 s")
const onAt: Record<string, number> = {}
run(11.5, (s) => {
  for (const l of LEDS) if (onAt[l] === undefined && ledOn(s, l)) onAt[l] = s.time
})
snap = loop.snapshot()!
expect("VD1 lit at", onAt.VD1 ?? NaN, 0.03, 0.05)
expect("VD2 lit at", onAt.VD2 ?? NaN, 1.0, 0.05)
expect("VD3 lit at", onAt.VD3 ?? NaN, 3.0, 0.05)
expect("VD4 lit at", onAt.VD4 ?? NaN, 6.0, 0.05)
expect("LEDs at 11.5 s (L1, L2 off again)", ledStr(snap), "○○●●")

console.log("\nJoystick: pressing SA4 pulls PD4 to ground")
loop.setParts({ [partKey(byRef("SA4").id, "SW")]: { pressed: true } })
run(0.05)
snap = loop.snapshot()!
expect("PD4 while pressed", snap.pinVoltage[pinKey(dd.id, "PD4")], 0, 0.05)
expect("PD5 untouched", snap.pinVoltage[pinKey(dd.id, "PD5")], 3.3, 0.05)
loop.setParts({ [partKey(byRef("SA4").id, "SW")]: { pressed: false } })
run(0.05)
snap = loop.snapshot()!
expect("PD4 released", snap.pinVoltage[pinKey(dd.id, "PD4")], 3.3, 0.05)

console.log("\nReset button SA1: core held while NRST is low, restarts on release")
loop.setParts({ [partKey(byRef("SA1").id, "SW")]: { pressed: true } })
run(0.1)
snap = loop.snapshot()!
expect("NRST pulled low", snap.pinVoltage[pinKey(dd.id, "NRST")], 0, 0.05)
expect("core in reset", snap.mcus[dd.id].powered ? "running" : "reset", "reset")
expect("all LEDs dark in reset", ledStr(snap), "○○○○")
loop.setParts({ [partKey(byRef("SA1").id, "SW")]: { pressed: false } })
run(0.1)
snap = loop.snapshot()!
expect("core restarted", snap.mcus[dd.id].powered && snap.mcus[dd.id].running ? "yes" : "no", "yes")
expect("core time restarted from 0", snap.mcus[dd.id].time < 0.15 ? "yes" : `no: ${snap.mcus[dd.id].time.toFixed(2)} s`, "yes")
expect("staircase from the top (L1 on)", ledStr(snap), "●○○○")

console.log("\n100 V on the +3V3 rail: the part is destroyed, the core stops")
{
  const doc2 = lab1Stand.build(GRID)
  const dd2 = doc2.objects.find((o) => o.def === "stm32f746ig")!
  dd2.props = { ...dd2.props, firmware: "lab1-f746.elf", firmwareData: elf.toString("base64") }
  const rail = doc2.objects.find((o) => o.def === "supply")!
  rail.props = { ...rail.props, value: "+100V", voltage: "100 V" }
  const loop2 = new SimLoop()
  loop2.setDoc(doc2)
  loop2.setParts(doc2.parts)
  loop2.setRunning(true)
  let t = 0
  loop2.advance(t)
  for (let i = 0; i < 10; i++) loop2.advance((t += 30))
  const s2 = loop2.snapshot()!
  const dmg = s2.damage[dd2.id]
  expect("DD1 burnt out", dmg ? `${dmg.fail}: ${dmg.reason}` : "intact", "short: voltage 100.00 V exceeds the 4.00 V rating")
  expect("core halted", s2.mcus[dd2.id].halted ?? "running", "fault at 0x" + (s2.mcus[dd2.id].pc >>> 0).toString(16).padStart(8, "0") + ": burnt out: voltage 100.00 V exceeds the 4.00 V rating")
  // The dead die shorts its supply, and a bench supply into a short trips.
  const railDmg = s2.damage[rail.id]
  expect("the shorted die trips the +100 V supply", railDmg ? railDmg.reason.replace(/[\d.]+ kA/, "…") : "intact", "current … exceeds the 1.00 A rating")
  expect("nothing else damaged", Object.keys(s2.damage).length, 2)
}

const wall = (performance.now() - wall0) / 1000
console.log(`\n${snap.time.toFixed(2)} s simulated in ${wall.toFixed(1)} s wall (${(snap.time / wall).toFixed(2)}× real time); MCU: ${snap.mcus[dd.id].instructions} instructions, halted: ${snap.mcus[dd.id].halted ?? "no"}`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
