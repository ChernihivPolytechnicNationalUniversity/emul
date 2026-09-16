/**
 * Co-simulation check of the low-power firmware on the "Nucleo blink" schematic: the board's
 * supply load follows the core's power mode (the current through the MCU's VDD element is
 * the scope on the supply), the USER button wakes it from Stop, and the Standby exit is a
 * reset the inspector reports.
 *
 *   pnpm nucleo-lp
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { nucleoBlink } from "@/schematic/examples"
import { getDef } from "@/schematic/registry"
import { partKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

const elf = readFileSync(join(import.meta.dirname, "..", "firmware", "hal", "build", "lowpower.elf"))
const doc = nucleoBlink.build(GRID)
const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
u.props = { ...u.props, firmware: "lowpower.elf", firmwareData: elf.toString("base64") }
const iddElement = getDef(u.def)!.model.findIndex((el) => el.kind === "R" && el.live === "$idd")

const loop = new SimLoop()
loop.setDoc(doc)
loop.setParts(doc.parts)
loop.setRunning(true)

let clock = 0
loop.advance(clock)
type Core = { mcu: { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] }; rcc: { get: (name: string) => number } } }
const core = (loop as unknown as { mcus: Map<string, Core> }).mcus.get(u.id)!.mcu
const word = (name: string) => core.bus.read32(core.firmware.symbols.find((x) => x.name === name)!.value)

/**
 * The scope on the supply: one sample per 2 ms tick of the mode and the VDD current. The
 * ~50 µs the firmware runs between two Stops never lands on a sample, so the Stops are told
 * apart by their regulator ("stop low-power" → "stop main" is a wake-up and a new Stop).
 */
const trace: { t: number; mode: string; amps: number }[] = []
function run(seconds: number) {
  const end = clock + seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 2)
    loop.advance(clock)
    const s = loop.snapshot()!
    const p = s.mcus[u.id].power
    trace.push({ t: s.time, mode: p.mode === "stop" ? `stop ${p.regulator}` : p.mode, amps: s.readings.find((r) => r.object === u.id && r.element === iddElement)?.current ?? NaN })
  }
}
const modeAt = (mode: string, after: number) => trace.find((x) => x.t > after && x.mode === mode)?.t ?? NaN
const average = (from: number, to: number) => {
  const s = trace.filter((x) => x.t > from + 3e-3 && x.t <= to)
  return s.reduce((a, x) => a + Math.abs(x.amps), 0) / s.length
}

let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0) => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(5)) : JSON.stringify(v))
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(44)} ${fmt(got).padStart(14)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}

const wall0 = performance.now()
console.log("Boot: the board's 32.768 kHz crystal takes 2 s to start, the firmware waits for it")
while (clock < 2500 && !(core.rcc.get("BDCR") & 2)) run(0.002)
let snap: Snapshot = loop.snapshot()!
const lseReady = snap.time
expect("LSE ready (s)", lseReady, 2.0, 0.02)
expect("core running", snap.mcus[u.id].running ? "yes" : `no: ${snap.mcus[u.id].halted}`, "yes")
expect("supply element found", iddElement >= 0 ? "yes" : "no", "yes")

console.log("\nSleep between SysTicks")
run(0.03)
snap = loop.snapshot()!
const t0 = snap.time
run(0.15)
snap = loop.snapshot()!
expect("inspector: Sleep", snap.mcus[u.id].power.mode, "sleep")
expect("asleep nearly all the time", snap.mcus[u.id].power.asleep, 1, 0.03)
expect("VDD current ≈ Sleep at 180 MHz (mA)", average(t0, snap.time) * 1e3, 39, 3)

console.log("\nStop on the low-power regulator, RTC wake-up")
run(0.05)
const stop1 = modeAt("stop low-power", t0)
expect("entered Stop ~200 ms after the RTC came up", (stop1 - lseReady) * 1e3, 205, 8)
run(0.1)
snap = loop.snapshot()!
expect("VDD current in Stop (mA)", average(stop1, snap.time) * 1e3, 0.55, 0.02)
expect("inspector: Stop, low-power regulator", `${snap.mcus[u.id].power.mode} ${snap.mcus[u.id].power.regulator}`, "stop low-power")
run(0.2)
const stop2 = modeAt("stop main", stop1)
expect("woke after 300 ms, straight into the next Stop (ms)", (stop2 - stop1) * 1e3, 300, 4)
expect("HAL tick stood still", word("stopTicks"), 0, 1)
expect("clock re-configured onto the PLL in between", word("reclocked"), 8)

console.log("\nStop until the USER button (EXTI13 interrupt)")
run(0.1)
snap = loop.snapshot()!
expect("VDD current in Stop, main regulator (mA)", average(stop2, snap.time) * 1e3, 1.2, 0.02)
expect("no wake-up yet", word("wakes"), 0)
loop.setParts({ [partKey(u.id, "B1")]: { pressed: true } })
run(0.01)
expect("the press woke the core (EXTI callback)", word("wakes"), 1)
loop.setParts({ [partKey(u.id, "B1")]: { pressed: false } })
run(0.05)

console.log("\nStop until the USER button (EXTI13 event, WFE)")
snap = loop.snapshot()!
expect("in Stop again", snap.mcus[u.id].power.mode, "stop")
const beforeEvent = snap.time
loop.setParts({ [partKey(u.id, "B1")]: { pressed: true } })
run(0.01)
snap = loop.snapshot()!
loop.setParts({ [partKey(u.id, "B1")]: { pressed: false } })
const afterButton = snap.time
run(0.05)
expect("the event woke the core: next Stop is under-drive", modeAt("stop under-drive", beforeEvent) < afterButton + 0.01 ? "yes" : "no", "yes")
expect("without an interrupt", word("wakes"), 1)

console.log("\nUnder-drive Stop, then Standby")
run(0.2)
const stop4 = modeAt("stop under-drive", beforeEvent)
snap = loop.snapshot()!
expect("VDD current in under-drive Stop (mA)", average(stop4, Math.min(snap.time, stop4 + 0.19)) * 1e3, 0.13, 0.02)
run(0.05)
const standby = modeAt("standby", stop4 + 0.19)
expect("Standby 200 ms after the under-drive Stop (ms)", (standby - stop4) * 1e3, 200, 4)
run(0.2)
snap = loop.snapshot()!
expect("inspector: Standby", snap.mcus[u.id].power.mode, "standby")
expect("VDD current in Standby (µA)", average(standby, snap.time) * 1e6, 3, 0.2)
run(0.35)
snap = loop.snapshot()!
expect("Standby exit counted as a reset", `${snap.mcus[u.id].resets} by ${snap.mcus[u.id].lastReset}`, "1 by standby")
expect("core back in Standby waiting for WKUP", snap.mcus[u.id].power.mode, "standby")
expect("nothing unmodelled", snap.mcus[u.id].unmodelled.length, 0)

const wall = (performance.now() - wall0) / 1000
console.log(`\n${snap.time.toFixed(2)} s simulated in ${wall.toFixed(1)} s wall (${(snap.time / wall).toFixed(2)}× real time)`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
