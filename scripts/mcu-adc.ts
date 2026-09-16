/**
 * ADC/DAC check: runs firmware/hal/Src/adc.c on the F429 model with a scripted voltage on
 * PA3, watching the PWM duty on PB0 follow it, VREFINT read through the internal channel,
 * and the DAC on PA4 playing its sine through TIM6 + DMA.
 *
 *   pnpm mcu-adc
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"

const path = join(import.meta.dirname, "..", "firmware", "hal", "build", "adc.elf")
const mcu = new Stm32F429()
mcu.load(readFileSync(path).buffer as ArrayBuffer, path)
const A0 = parsePad("PA3")!
const LD1 = parsePad("PB0")!
const DAC1 = parsePad("PA4")!
let a0Volts = 1.0
mcu.analogRead = (pad) => (pad.port === A0.port && pad.pin === A0.pin ? a0Volts : null)

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

/** Run in fine steps, sampling the DAC pad and the PWM duty. */
const dacSamples: { t: number; v: number }[] = []
function run(seconds: number, step = 50e-6) {
  const end = mcu.time + seconds
  while (mcu.time < end && mcu.running) {
    if (!mcu.run(step)) break
    const d = mcu.padDrive(DAC1)
    if (typeof d === "number") dacSamples.push({ t: mcu.time, v: d })
  }
}
function duty(seconds: number) {
  mcu.takeDuty(LD1, 0)
  const t0 = mcu.time
  run(seconds)
  return mcu.takeDuty(LD1, mcu.time - t0) ?? -1
}

const wall0 = performance.now()
console.log("ADC1 on A0 → PWM duty on LD1")
run(0.03)
expect("core running", mcu.running ? "yes" : `halted: ${mcu.cpu.halted?.message}`, "yes")
expect("no HAL errors", word("errors"), 0)
// 1.21 V / 3.3 V × 4095
expect("VREFINT reads 1.21 V", word("vrefint"), 1502, 2)
expect("A0 at 1.0 V → 1241 counts", word("adcValue"), 1241, 2)
expect("PWM duty follows (30 %)", duty(0.02), 0.303, 0.01)
a0Volts = 2.5
run(0.02)
expect("A0 at 2.5 V → 3102 counts", word("adcValue"), 3102, 2)
expect("PWM duty follows (76 %)", duty(0.02), 0.757, 0.01)
a0Volts = 3.6
run(0.02)
expect("above VREF clips at 4095", word("adcValue"), 4095)
expect("samples every ~11 ms", word("samples"), 8, 2)

console.log("\nDAC1 sine via TIM6 TRGO + DMA")
const recent = dacSamples.filter((s) => s.t > mcu.time - 0.06)
const vmax = Math.max(...recent.map((s) => s.v))
const vmin = Math.min(...recent.map((s) => s.v))
expect("peak near VREF (V)", vmax, 3.3, 0.05)
expect("trough near 0 (V)", vmin, 0, 0.05)
// Period: time between successive upward crossings of mid-scale.
const crossings: number[] = []
for (let i = 1; i < recent.length; i++) if (recent[i - 1].v < 1.65 && recent[i].v >= 1.65) crossings.push(recent[i].t)
const period = crossings.length >= 2 ? (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1) : 0
expect("sine period 20 ms (50 Hz)", period * 1e3, 20, 0.2)
// A 32-point sine has 17 distinct levels (it is symmetric about its peaks).
expect("distinct DAC levels seen", new Set(recent.map((s) => Math.round(s.v * 1000))).size, 17)
expect("no unmodelled features", mcu.unmodelled.summary().length, 0)

const wall = (performance.now() - wall0) / 1000
console.log(`\n${mcu.time.toFixed(3)} s simulated in ${wall.toFixed(2)} s wall, ${(mcu.cpu.instructions / wall / 1e6).toFixed(1)} MIPS`)
if (mcu.unmodelled.hits.size) console.log("unmodelled:", mcu.unmodelled.summary())
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
