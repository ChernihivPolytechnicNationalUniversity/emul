/**
 * Runs the first lab's firmware (STM32CubeIDE project for the STM32F746IGT6 teaching stand)
 * on the F746 profile and checks the LEDs L1..L4 (PB6, PB7, PH4, PI8) light up and go out
 * in the 1/2/3/4-second staircase main.c describes, at 50 MHz from the 8 MHz crystal.
 *
 *   pnpm lab1 [path/to/Laba1.elf]
 */
import { readFileSync } from "node:fs"
import { STM32F746IG } from "@/mcu/chip"
import { Stm32, parsePad } from "@/mcu/stm32f429"

const path = process.argv[2] ?? "/mnt/c/Users/vafla/Downloads/Telegram Desktop/Laba1/Laba1/Debug/Laba1.elf"
const mcu = new Stm32(STM32F746IG)
mcu.load(readFileSync(path).buffer as ArrayBuffer, path)

const LEDS = { L1: parsePad("PB6")!, L2: parsePad("PB7")!, L3: parsePad("PH4")!, L4: parsePad("PI8")! }

let failed = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0) => {
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : v)
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(40)} ${fmt(got).padStart(12)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}

const wall0 = performance.now()
console.log(`Boot ${mcu.chip.name} (${mcu.chip.core.name})`)
// Stop at the first HAL_Delay: MPU, clocks and GPIO are set up, L1 has just been switched on.
const halDelay = mcu.firmware!.symbols.find((s) => s.name === "HAL_Delay")!.value & ~1
mcu.cpu.breakpoints.add(halDelay)
mcu.run(0.01)
expect("stopped at HAL_Delay", mcu.cpu.halted?.reason ?? "running", "bkpt")
// ~0.6 ms of init; the coarse 20k-cycle time slices around the HSI→PLL switch blur it by up to a slice.
expect("time to reach the main loop (ms)", mcu.time * 1e3, 0.6, 1)
mcu.cpu.breakpoints.clear()
mcu.cpu.halted = null
const c = mcu.clocks
console.log(`  clocks: ${c.source} sysclk ${(c.sysclk / 1e6).toFixed(1)} MHz, hclk ${(c.hclk / 1e6).toFixed(1)}, pclk1 ${(c.pclk1 / 1e6).toFixed(1)}, pclk2 ${(c.pclk2 / 1e6).toFixed(1)}`)
expect("SYSCLK = 8 MHz / 4 × 50 / 2", c.sysclk, 50e6)
expect("flash latency", mcu.flash.get("ACR") & 0xf, 1)
expect("regulator scale 3", (mcu.pwr.get("CR1") >>> 14) & 3, 1)
expect("over-drive switched", (mcu.pwr.get("CR1") >>> 16) & 3, 3)
expect("SysTick 1 kHz", mcu.cpu.scs.systRvr + 1, 50000)
expect("MPU enabled by MPU_Config", mcu.cpu.scs.mpuCtrl & 1, 1)
// XN, no access, shareable, SRD 0x87, 4 GB, enabled: the background region CubeMX generates.
expect("MPU region 0 as MPU_Config wrote it", mcu.cpu.scs.mpuRasr[0] >>> 0, 0x1004873f)
expect("MPU RBAR region 0 base", mcu.cpu.scs.mpuRbar[0] >>> 0, 0)
for (const [name, pad] of Object.entries(LEDS)) expect(`${name} after MX_GPIO_Init + first write`, mcu.padDrive(pad) ?? "float", name === "L1" ? "high" : "low")
const joy = ["PG2", "PG3", "PD4", "PD5", "PI11"]
for (const p of joy) expect(`joystick ${p} pulled up`, mcu.padDrive(parsePad(p)!) ?? "float", "pullup")

// Record every LED edge from reset over one full 20 s cycle plus the start of the next.
console.log("\nLED staircase (22 s of simulated time from reset)")
mcu.reset()
const edges: Record<string, { t: number; level: string }[]> = {}
const last: Record<string, string> = {}
for (const [n, pad] of Object.entries(LEDS)) {
  edges[n] = []
  last[n] = mcu.padDrive(pad) ?? "float"
}
while (mcu.time < 22 && mcu.running) {
  if (!mcu.run(1e-4)) break
  for (const [name, pad] of Object.entries(LEDS)) {
    const d = mcu.padDrive(pad) ?? "float"
    if (d !== last[name]) edges[name].push({ t: mcu.time, level: d })
    last[name] = d
  }
}
expect("core still running", mcu.running ? "yes" : `halted: ${mcu.cpu.halted?.message}`, "yes")

// main.c: L1 on, +1 s L2 on, +2 s L3 on, +3 s L4 on, +4 s L1 off, +1 s L2 off, +2 s L3 off,
// +3 s L4 off, +4 s and around again. HAL_Delay(n) waits n+1 SysTick ticks, so every step
// runs 1 ms long and the cycle is 20.008 s.
const onAt = { L1: 0, L2: 1.001, L3: 3.002, L4: 6.003 }
const offAt = { L1: 10.004, L2: 11.005, L3: 13.006, L4: 16.007 }
// Times are measured from reset; the main loop starts ~0.6 ms after it (MPU, PLL, GPIO init).
const T_MAIN = 0.0006
const TOL = 0.0005
for (const n of Object.keys(LEDS) as (keyof typeof onAt)[]) {
  const highs = edges[n].filter((x) => x.level === "high").map((x) => x.t)
  const lows = edges[n].filter((x) => x.level === "low").map((x) => x.t)
  expect(`${n} on at`, highs[0] ?? NaN, T_MAIN + onAt[n], TOL)
  expect(`${n} off at`, lows.find((t) => t > (highs[0] ?? 0)) ?? NaN, T_MAIN + offAt[n], TOL)
  if (onAt[n] + 20.008 < 22) expect(`${n} on again at`, highs[1] ?? NaN, T_MAIN + onAt[n] + 20.008, TOL)
}

const wall = (performance.now() - wall0) / 1000
console.log(`\n${mcu.time.toFixed(2)} s simulated in ${wall.toFixed(2)} s wall (${(mcu.time / wall).toFixed(2)}× real time), ${(mcu.cpu.instructions / wall / 1e6).toFixed(1)} MIPS`)
if (mcu.unmodelled.hits.size) {
  console.log("unmodelled blocks touched:")
  for (const [addr, h] of mcu.unmodelled.hits) console.log(`  0x${addr.toString(16)}: ${h.reads} reads, ${h.writes} writes`)
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)
