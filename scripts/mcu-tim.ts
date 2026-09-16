/**
 * Timer check: runs firmware/hal/Src/pwm.c on the F429 model and measures the pads.
 *   TIM3 CH3 PWM 1 kHz on PB0, duty stepping 10 % → 90 % every 100 ms
 *   TIM2 update interrupt at 200 Hz toggling PB7 (100 Hz square)
 *   TIM4 CH1 input capture on PB6, fed from PB0 here the way a wire would
 *   TIM1 CH1 / CH1N 20 kHz on PE9 / PE8, 30 % duty, complementary
 *
 *   pnpm mcu-tim
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"

const path = join(import.meta.dirname, "..", "firmware", "hal", "build", "pwm.elf")
const mcu = new Stm32F429()
mcu.load(readFileSync(path).buffer as ArrayBuffer, path)

const PB0 = parsePad("PB0")!
const PB6 = parsePad("PB6")!
const PB7 = parsePad("PB7")!
const PE8 = parsePad("PE8")!
const PE9 = parsePad("PE9")!

let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0) => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol * Math.max(1, Math.abs(want)) : got === want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(5)) : String(v))
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(44)} ${fmt(got).padStart(12)}  expected ${fmt(want)}${tol ? ` ±${tol * 100}%` : ""}`)
}
const sym = (name: string) => mcu.firmware!.symbols.find((s) => s.name === name)!.value
const word = (name: string) => mcu.bus.read32(sym(name))

type Edges = { t: number; level: boolean }[]
/** Run for `seconds`, sampling every `step`; PB0 is looped back into PB6. */
function record(seconds: number, step = 1e-6) {
  const edges: Record<string, Edges> = { PB0: [], PB7: [], PE8: [], PE9: [] }
  const last: Record<string, boolean | null> = { PB0: null, PB7: null, PE8: null, PE9: null }
  const pads = { PB0, PB7, PE8, PE9 }
  const end = mcu.time + seconds
  while (mcu.time < end && mcu.running) {
    if (!mcu.run(step)) break
    for (const [name, pad] of Object.entries(pads)) {
      const d = mcu.padDrive(pad)
      const level = d === "high" || d === "pullup"
      if (last[name] !== null && level !== last[name]) edges[name].push({ t: mcu.time, level })
      last[name] = level
    }
    mcu.setPad(PB6, last.PB0 === true)
  }
  return edges
}
const stats = (e: Edges) => {
  const rises = e.filter((x) => x.level).map((x) => x.t)
  const falls = e.filter((x) => !x.level).map((x) => x.t)
  if (rises.length < 3) return { period: 0, duty: 0, n: rises.length }
  const periods = rises.slice(1).map((t, i) => t - rises[i])
  const period = periods.reduce((a, b) => a + b, 0) / periods.length
  const highs = rises.slice(0, -1).map((r) => {
    const f = falls.find((t) => t > r)
    return f === undefined ? NaN : f - r
  }).filter((x) => !Number.isNaN(x))
  const duty = highs.reduce((a, b) => a + b, 0) / highs.length / period
  return { period, duty, n: rises.length }
}

const wall0 = performance.now()
console.log("Boot")
mcu.run(0.002)
expect("core running", mcu.running ? "yes" : `halted: ${mcu.cpu.halted?.message}`, "yes")
expect("SYSCLK", mcu.clocks.sysclk, 180e6)
expect("APB1 timer clock (2 × PCLK1)", mcu.clocks.timclk1, 90e6)
expect("APB2 timer clock (2 × PCLK2)", mcu.clocks.timclk2, 180e6)
expect("timers running", mcu.tim.filter((t) => t.running).length, 4)
expect("PB0 claimed by TIM3", mcu.padDrive(PB0) === null ? "floating" : "driven", "driven")

console.log("\nFirst 50 ms (duty 10 %)")
let e = record(0.05)
let s = stats(e.PB0)
expect("TIM3 PWM period on PB0 (µs)", s.period * 1e6, 1000, 0.002)
expect("TIM3 PWM duty", s.duty, 0.1, 0.02)
s = stats(e.PB7)
expect("TIM2 IRQ square period on PB7 (ms)", s.period * 1e3, 10, 0.002)
expect("TIM2 update count", word("tim2Ticks"), 10, 0.1)
s = stats(e.PE9)
expect("TIM1 PWM period on PE9 (µs)", s.period * 1e6, 50, 0.002)
expect("TIM1 PWM duty", s.duty, 0.3, 0.02)
s = stats(e.PE8)
expect("TIM1 CH1N duty (complement)", s.duty, 0.7, 0.02)
const complementary = e.PE8.every((x) => {
  const at = e.PE9.filter((y) => Math.abs(y.t - x.t) < 1e-9)
  return at.length === 1 && at[0].level !== x.level
})
expect("CH1N is the inverse of CH1 edge for edge", complementary ? "yes" : "no", "yes")
expect("TIM4 capture: period of PB0 (µs)", word("capturePeriodUs"), 1000, 0.002)
expect("TIM4 capture: high time of PB0 (µs)", word("captureHighUs"), 100, 0.02)

console.log("\nDuty ramp: 100 ms steps")
for (const want of [20, 30, 40]) {
  // Skip to the middle of the next step and measure 20 ms there.
  const stepStart = Math.floor(mcu.time / 0.1 + 1) * 0.1 + 0.0011
  while (mcu.time < stepStart + 0.03) mcu.run(0.0005)
  e = record(0.02)
  s = stats(e.PB0)
  expect(`duty at ${(mcu.time * 1e3).toFixed(0)} ms`, s.duty * 100, want, 0.03)
  if (want === 40) expect("TIM4 capture follows (high time µs)", word("captureHighUs"), 400, 0.01)
}

const wall = (performance.now() - wall0) / 1000
console.log(`\n${mcu.time.toFixed(3)} s simulated in ${wall.toFixed(2)} s wall (${(mcu.time / wall).toFixed(2)}× real time), ${(mcu.cpu.instructions / wall / 1e6).toFixed(1)} MIPS`)
if (mcu.unmodelled.hits.size) console.log("unmodelled:", mcu.unmodelled.summary())
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
