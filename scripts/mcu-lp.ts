/**
 * Low-power check: runs firmware/hal/Src/lowpower.c on the F429 model with a "current probe"
 * on the supply — the mode and current estimate sampled every 50 µs — through Sleep, four
 * Stops (RTC wake-up, EXTI interrupt, EXTI event, under-drive) and two Standbys (RTC and the
 * WKUP pin), then sleep-on-exit.
 *
 *   pnpm mcu-lp
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Stm32F429, parsePad, type PowerMode } from "@/mcu/stm32f429"

const path = join(import.meta.dirname, "..", "firmware", "hal", "build", "lowpower.elf")
const mcu = new Stm32F429()
mcu.load(readFileSync(path).buffer as ArrayBuffer, path)
const B1 = parsePad("PC13")!
const WKUP = parsePad("PA0")!

let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0) => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(5)) : JSON.stringify(v))
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(44)} ${fmt(got).padStart(14)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}
const sym = (name: string) => mcu.firmware!.symbols.find((s) => s.name === name)!.value
const word = (name: string) => mcu.bus.read32(sym(name))

/** The probe: one sample per step of the mode and the supply current. */
type Sample = { t: number; mode: PowerMode; amps: number; hz: number }
const trace: Sample[] = []
const resets: { cause: string; at: number; vars: Record<string, number> }[] = []
const origReset = mcu.reset.bind(mcu)
mcu.reset = (cause = "por") => {
  const vars: Record<string, number> = {}
  for (const v of ["sbf", "wuf", "sleeps", "stopTicks", "stopSws", "stopHse", "stopElapsed", "reclocked", "wakes", "errors", "rtcTime"]) vars[v] = word(v)
  resets.push({ cause, at: mcu.time, vars })
  origReset(cause)
}
function run(seconds: number, step = 50e-6) {
  const end = mcu.time + seconds
  while (mcu.time < end && mcu.running) {
    if (!mcu.run(Math.min(step, end - mcu.time))) break
    trace.push({ t: mcu.time, mode: mcu.powerMode, amps: mcu.supplyCurrent(), hz: mcu.clocks.sysclk })
  }
}
/** Run until the mode becomes `mode` (or the time runs out); returns the time it did. */
function runUntilMode(mode: PowerMode, limit: number, step = 50e-6): number {
  const end = mcu.time + limit
  while (mcu.time < end && mcu.running && mcu.powerMode !== mode) {
    if (!mcu.run(Math.min(step, end - mcu.time))) break
    trace.push({ t: mcu.time, mode: mcu.powerMode, amps: mcu.supplyCurrent(), hz: mcu.clocks.sysclk })
  }
  return mcu.time
}
/** When the probe first saw `mode` after `after` (to within one 50 µs sample). */
const enteredAt = (mode: PowerMode, after: number) => trace.find((x) => x.t > after && x.mode === mode)?.t ?? NaN
const mA = (amps: number) => amps * 1e3
const average = (from: number, to: number) => {
  const s = trace.filter((x) => x.t > from + 60e-6 && x.t <= to)
  return s.reduce((a, x) => a + x.amps, 0) / s.length
}
const share = (from: number, to: number, mode: PowerMode) => {
  const s = trace.filter((x) => x.t > from && x.t <= to)
  return s.filter((x) => x.mode === mode).length / s.length
}

const wall0 = performance.now()
console.log("Life 0: Sleep between SysTicks")
run(0.03)
expect("core running", mcu.running ? "yes" : `halted: ${mcu.cpu.halted?.message}`, "yes")
const sleepFrom = mcu.time
run(0.15)
expect("asleep at every sample (share)", share(sleepFrom, mcu.time, "sleep"), 1, 0.03)
expect("supply ≈ Sleep current at 180 MHz (mA)", mA(average(sleepFrom, mcu.time)), 39, 3)
expect("no HAL errors", word("errors"), 0)

console.log("\nStop 1: RTC wake-up timer, low-power regulator")
runUntilMode("stop", 0.1)
const stop1 = enteredAt("stop", sleepFrom)
expect("entered Stop after ~200 ms of Sleep", stop1 * 1e3, 205, 6)
expect("~200 wake-ups by SysTick", word("sleeps"), 200, 3)
run(0.01)
expect("supply in Stop, low-power regulator (mA)", mA(average(stop1, mcu.time)), 0.55, 0.01)
const wake1 = runUntilMode("run", 0.5)
expect("woke 300 ms + 21 µs later (ms)", (wake1 - stop1) * 1e3, 300.02, 0.15)
run(0.005)
expect("HAL tick stood still in Stop", word("stopTicks"), 0, 1)
expect("RTC saw the 300 ms (ms)", word("stopElapsed"), 300, 5)
expect("woke on HSI (CFGR.SWS)", word("stopSws"), 0)
expect("HSE switched off by hardware", word("stopHse"), 0)
expect("clock re-configured onto the PLL (CFGR.SWS)", word("reclocked"), 8)
const stop2 = enteredAt("stop", wake1)
expect("back in Stop within 200 µs of waking (µs)", (stop2 - wake1) * 1e6, 100, 100)

console.log("\nStop 2: EXTI13 interrupt from the user button")
expect("in Stop, main regulator (mA)", mA(mcu.supplyCurrent()), 1.2, 0.01)
run(0.1)
expect("still in Stop after 100 ms", mcu.powerMode, "stop")
mcu.setPad(B1, true)
const edge2 = mcu.time
const wake2 = runUntilMode("run", 0.01, 5e-6)
expect("woke ~13 µs after the edge (µs)", (wake2 - edge2) * 1e6, 13, 3)
run(0.005)
expect("EXTI callback ran", word("wakes"), 1)
mcu.setPad(B1, false)

console.log("\nStop 3: EXTI13 event with WFE")
const stop3 = enteredAt("stop", wake2)
expect("entered Stop within 5 ms of the wake-up", (stop3 - wake2) * 1e3 < 5 ? "yes" : "no", "yes")
run(0.05)
expect("in Stop", mcu.powerMode, "stop")
mcu.setPad(B1, true)
const edge3 = mcu.time
const wake3 = runUntilMode("run", 0.01, 5e-6)
expect("woke on the event (µs after the edge)", (wake3 - edge3) * 1e6, 13, 3)
run(0.005)
expect("no interrupt this time", word("wakes"), 1)
mcu.setPad(B1, false)

console.log("\nStop 4: under-drive, RTC after 200 ms")
const stop4 = enteredAt("stop", wake3)
run(0.01)
expect("supply in under-drive Stop (mA)", mA(average(stop4, mcu.time)), 0.13, 0.01)
const wake4 = runUntilMode("run", 0.5)
expect("woke 200 ms + 110 µs later (ms)", (wake4 - stop4) * 1e3, 200.11, 0.15)

console.log("\nStandby 1: RTC wake-up after 0.5 s")
runUntilMode("standby", 0.05)
const standby1 = enteredAt("standby", wake4)
run(0.01)
expect("supply in Standby (µA)", average(standby1, mcu.time) * 1e6, 3, 0.1)
run(0.6)
expect("reset out of Standby", resets.length ? resets[0].cause : "none", "standby")
expect("after 0.5 s (ms)", resets.length ? (resets[0].at - standby1) * 1e3 : 0, 500, 2)
expect("life 0 had no SBF", resets[0]?.vars.sbf ?? -1, 0)
expect("no HAL errors in life 0", resets[0]?.vars.errors ?? -1, 0)

console.log("\nLife 1: Standby until the WKUP pin")
run(0.02)
expect("SBF set, WUF clear", `${word("sbf")}${word("wuf")}`, "10")
expect("RTC kept running through Standby (12:34:57)", word("rtcTime"), 123457, 1)
expect("resets counted", `${mcu.resets} by ${mcu.lastReset}`, "1 by standby")
runUntilMode("standby", 0.05)
run(0.1)
expect("in Standby", mcu.powerMode, "standby")
mcu.setPad(WKUP, true)
const edgeW = mcu.time
run(0.002)
expect("WKUP rising edge → reset", resets.length >= 2 ? resets[1].cause : "none", "standby")
expect("promptly (µs)", resets.length >= 2 ? (resets[1].at - edgeW) * 1e6 : 0, 300, 60)

console.log("\nLife 2: sleep-on-exit, then idle")
run(0.02)
expect("SBF and WUF set", `${word("sbf")}${word("wuf")}`, "11")
run(0.06)
expect("sleep-on-exit held for 50 SysTicks", word("soeTicks"), 50)
expect("LD1 on afterwards", mcu.padDrive(parsePad("PB0")!) === "high" ? "on" : "off", "on")
expect("core idles in Sleep", mcu.powerMode, "sleep")
expect("no unmodelled features", mcu.unmodelled.summary().length, 0)

const wall = (performance.now() - wall0) / 1000
console.log(`\n${mcu.time.toFixed(3)} s simulated in ${wall.toFixed(2)} s wall, ${(mcu.cpu.instructions / wall / 1e6).toFixed(1)} MIPS`)
if (mcu.unmodelled.hits.size) console.log("unmodelled:", mcu.unmodelled.summary())
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
