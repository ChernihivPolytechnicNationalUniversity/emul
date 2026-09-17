/**
 * The Open746I-C board on its own, running the lab 1 firmware: the USER LEDs step through
 * their staircase behind 1 kΩ, the joystick pulls its pins to ground, WAKEUP lifts PA0, RESET
 * holds the core, and the board is dead with the USART1 USB unplugged (S2 in its USB position).
 *
 *   pnpm open746
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { lab1Board } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

const elf = readFileSync(join(import.meta.dirname, "..", "public", "firmware", "lab1-f746.elf"))
const doc = lab1Board.build(GRID)
const u = doc.objects.find((o) => o.def === "open746i-c")!
u.props = { ...u.props, firmware: "lab1-f746.elf", firmwareData: elf.toString("base64") }

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
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(44)} ${fmt(got).padStart(10)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}

const LEDS = ["LED1", "LED2", "LED3", "LED4"]
const ledOn = (s: Snapshot, id: string) => s.parts[partKey(u.id, id)]?.on ?? false
const ledStr = (s: Snapshot) => LEDS.map((l) => (ledOn(s, l) ? "●" : "○")).join("")
const v = (s: Snapshot, pin: string) => s.pinVoltage[pinKey(u.id, pin)]
const press = (part: string, pressed: boolean) => loop.setParts({ [partKey(u.id, part)]: { pressed } })

const wall0 = performance.now()
console.log("Boot on the USART1 USB (S2 in its USB position)")
run(0.05)
let snap = loop.snapshot()!
const st = snap.mcus[u.id]
expect("MCU loaded", st?.firmware ?? "none", "lab1-f746.elf")
expect("core running", st?.running ? "yes" : `no: ${st?.halted}`, "yes")
expect("SYSCLK", st?.sysclk ?? 0, 50e6)
expect("HSE is the 8 MHz crystal", st?.clock.hse ? `${st.clock.hse.kind} ${st.clock.hse.hz / 1e6} MHz` : "none", "crystal 8 MHz")
expect("3V3 rail (P23)", v(snap, "P23-1"), 3.3, 0.02)
expect("5V rail (P22)", v(snap, "P22-1"), 5, 0.05)
expect("Arduino IOREF on 3.3 V", v(snap, "CN2-2"), 3.3, 0.02)
expect("NRST idles high", v(snap, "P13-17"), 3.3, 0.02)
expect("PWR LED on", snap.parts[partKey(u.id, "PWR")]?.on ? "yes" : "no", "yes")
expect("joystick C (PD4 on P12-8) pulled up", v(snap, "P12-8"), 3.3, 0.05)
expect("WAKEUP PA0 (A0) held down", v(snap, "CN3-1"), 0, 0.02)
expect("LEDs after boot (LED1 on)", ledStr(snap), "●○○○")
// 1.4 mA through 1 kΩ: a dim LED, as on the real board (8 mA counts as full).
expect("LED1 brightness at 1.4 mA", snap.parts[partKey(u.id, "LED1")]?.level ?? 0, 0.18, 0.05)

console.log("\nStaircase: LED2 at 1 s, LED3 at 3 s, LED4 at 6 s, then off from 10 s")
const onAt: Record<string, number> = {}
run(11.5, (s) => {
  for (const l of LEDS) if (onAt[l] === undefined && ledOn(s, l)) onAt[l] = s.time
})
snap = loop.snapshot()!
expect("LED1 lit at", onAt.LED1 ?? NaN, 0.03, 0.05)
expect("LED2 lit at", onAt.LED2 ?? NaN, 1.0, 0.05)
expect("LED3 lit at", onAt.LED3 ?? NaN, 3.0, 0.05)
expect("LED4 lit at", onAt.LED4 ?? NaN, 6.0, 0.05)
expect("LEDs at 11.5 s", ledStr(snap), "○○●●")

console.log("\nJoystick and WAKEUP")
press("JOY_C", true)
run(0.05)
snap = loop.snapshot()!
expect("PD4 while C is pressed", v(snap, "P12-8"), 0, 0.05)
expect("PD5 untouched", v(snap, "P12-10"), 3.3, 0.05)
press("JOY_C", false)
press("WAKEUP", true)
run(0.05)
snap = loop.snapshot()!
expect("PD4 released", v(snap, "P12-8"), 3.3, 0.05)
expect("PA0 high while K1 is pressed (÷2 divider)", v(snap, "CN3-1"), 1.65, 0.05)
press("WAKEUP", false)
run(0.05)
expect("PA0 back down", v(loop.snapshot()!, "CN3-1"), 0, 0.02)

console.log("\nRESET holds the core, releasing restarts it")
press("RESET", true)
run(0.1)
snap = loop.snapshot()!
expect("NRST low", v(snap, "P13-17"), 0, 0.05)
expect("core in reset", snap.mcus[u.id].powered ? "running" : "reset", "reset")
expect("LEDs dark", ledStr(snap), "○○○○")
press("RESET", false)
run(0.1)
snap = loop.snapshot()!
expect("core restarted", snap.mcus[u.id].running ? "yes" : "no", "yes")
expect("staircase from the top", ledStr(snap), "●○○○")

console.log("\nUnplugging the USART1 USB: no 5 V, no 3.3 V, the core stops")
loop.setParts({ [partKey(u.id, "USB")]: { on: false } })
run(0.1)
snap = loop.snapshot()!
expect("5V rail", v(snap, "P22-1"), 0, 0.05)
expect("3V3 rail", v(snap, "P23-1"), 0, 0.05)
expect("core unpowered", snap.mcus[u.id].powered ? "powered" : "off", "off")
expect("LEDs dark", ledStr(snap), "○○○○")

console.log("\nS2 to the jack, 5 V on 5VDC: the board comes back")
{
  const doc2 = lab1Board.build(GRID)
  const u2 = doc2.objects.find((o) => o.def === "open746i-c")!
  u2.props = { ...u2.props, firmware: "lab1-f746.elf", firmwareData: elf.toString("base64") }
  const sup = { id: "sup", def: "supply", x: 5 * GRID, y: -6 * GRID, props: { value: "+5V", voltage: "5 V" } }
  const gnd = { id: "g", def: "ground", x: -6 * GRID, y: 3 * GRID, props: {} }
  doc2.objects.push(sup, gnd)
  doc2.wires.push({ id: "w1", from: { object: sup.id, pin: "V" }, to: { object: u2.id, pin: "5VDC" } }, { id: "w2", from: { object: gnd.id, pin: "GND" }, to: { object: u2.id, pin: "P24-1" } })
  doc2.parts[partKey(u2.id, "USB")] = { on: false }
  doc2.parts[partKey(u2.id, "S2")] = { on: true }
  const loop2 = new SimLoop()
  loop2.setDoc(doc2)
  loop2.setParts(doc2.parts)
  loop2.setRunning(true)
  let t = 0
  loop2.advance(t)
  for (let i = 0; i < 5; i++) loop2.advance((t += 30))
  const s2 = loop2.snapshot()!
  expect("3V3 rail from the jack", s2.pinVoltage[pinKey(u2.id, "P23-1")], 3.3, 0.02)
  expect("core running", s2.mcus[u2.id].running ? "yes" : `no: ${s2.mcus[u2.id].halted}`, "yes")
  expect("LED1 on", s2.parts[partKey(u2.id, "LED1")]?.on ? "yes" : "no", "yes")
}

const wall = (performance.now() - wall0) / 1000
console.log(`\n${snap.time.toFixed(2)} s simulated in ${wall.toFixed(1)} s wall (${(snap.time / wall).toFixed(2)}× real time)`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
