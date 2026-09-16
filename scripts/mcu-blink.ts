/**
 * Runs the HAL blink firmware on the STM32F429 model and checks what a scope on the pads
 * would show: LD1 (PB0) at 1 Hz from HAL_Delay, LD2 (PB7) at 5 Hz from the SysTick callback,
 * LD3 (PB14) toggling on USER button presses through EXTI, and the core at 180 MHz.
 *
 *   pnpm mcu-blink [path/to/firmware.elf]
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"
import { symbolAt } from "@/mcu/elf"

const path = process.argv[2] ?? join(import.meta.dirname, "..", "firmware", "hal", "build", "blink.elf")
const mcu = new Stm32F429()
mcu.load(readFileSync(path).buffer as ArrayBuffer, path)

const PB0 = parsePad("PB0")!
const PB7 = parsePad("PB7")!
const PB14 = parsePad("PB14")!
const PA5 = parsePad("PA5")!
const PC13 = parsePad("PC13")!

type Check = { what: string; got: number | string; want: number | string; tol?: number }
const checks: Check[] = []
let failed = 0
const expect = (c: Check) => {
  checks.push(c)
  const ok =
    typeof c.got === "number" && typeof c.want === "number"
      ? c.want === 0
        ? Math.abs(c.got) <= (c.tol ?? 0)
        : Math.abs(c.got - c.want) / Math.abs(c.want) <= (c.tol ?? 0)
      : c.got === c.want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(6)) : v)
  console.log(`  ${ok ? "✓" : "✗"} ${c.what.padEnd(36)} ${fmt(c.got).padStart(14)}  expected ${fmt(c.want)}${c.tol ? ` ±${c.tol * 100}%` : ""}`)
}

/** Sample the pads every `step` seconds for `seconds`, recording toggle times per pad. */
function record(seconds: number, step = 50e-6, press: ((t: number) => void) | null = null) {
  const edges: Record<string, number[]> = { PB0: [], PB7: [], PB14: [], PA5: [] }
  const last: Record<string, string | null> = { PB0: null, PB7: null, PB14: null, PA5: null }
  const pads = { PB0, PB7, PB14, PA5 }
  const start = mcu.time
  while (mcu.time < start + seconds && mcu.running) {
    if (!mcu.run(step)) break
    press?.(mcu.time - start)
    for (const [name, pad] of Object.entries(pads)) {
      const d = mcu.padDrive(pad)
      if (last[name] !== null && d !== last[name]) edges[name].push(mcu.time)
      last[name] = d
    }
  }
  return edges
}
const period = (edges: number[]) => {
  if (edges.length < 3) return 0
  const diffs = edges.slice(1).map((t, i) => t - edges[i])
  return (2 * diffs.reduce((a, b) => a + b, 0)) / diffs.length
}

const wall0 = performance.now()
console.log("Boot")
mcu.run(0.01)
console.log(`  clocks: ${mcu.clocks.source} sysclk ${(mcu.clocks.sysclk / 1e6).toFixed(1)} MHz, hclk ${(mcu.clocks.hclk / 1e6).toFixed(1)}, pclk1 ${(mcu.clocks.pclk1 / 1e6).toFixed(1)}, pclk2 ${(mcu.clocks.pclk2 / 1e6).toFixed(1)}`)
expect({ what: "SYSCLK after SystemClock_Config", got: mcu.clocks.sysclk, want: 180e6 })
expect({ what: "PCLK1", got: mcu.clocks.pclk1, want: 45e6 })
expect({ what: "PCLK2", got: mcu.clocks.pclk2, want: 90e6 })
expect({ what: "SysTick reload (1 kHz at HCLK)", got: mcu.cpu.scs.systRvr + 1, want: 180000 })
expect({ what: "flash latency", got: mcu.flash.get("ACR") & 0xf, want: 5 })
expect({ what: "over-drive switched", got: (mcu.pwr.get("CR") >>> 16) & 3, want: 3 })
expect({ what: "core running", got: mcu.running ? "yes" : `halted: ${mcu.cpu.halted?.message}`, want: "yes" })

console.log("\nBlink (3 s of simulated time)")
const e = record(3)
// HAL_Delay(n) waits n + 1 ticks, so the 500 ms toggle really is 501 ms.
expect({ what: "LD1 (PB0) toggle period", got: period(e.PB0), want: 1.002, tol: 0.001 })
expect({ what: "D13 (PA5) follows LD1", got: e.PA5.length, want: e.PB0.length })
expect({ what: "LD2 (PB7) toggle period", got: period(e.PB7), want: 0.2, tol: 0.002 })
expect({ what: "LD3 (PB14) quiet without presses", got: e.PB14.length, want: 0 })
expect({ what: "PB0 drive is push-pull", got: e.PB0.length > 0 && ["high", "low"].includes(mcu.padDrive(PB0) ?? "") ? "yes" : "no", want: "yes" })

console.log("\nUSER button (PC13 → EXTI15_10 → LD3)")
let pressed = false
const e2 = record(0.5, 50e-6, (t) => {
  // Press at 100 ms and 300 ms, release 50 ms later.
  const down = (t > 0.1 && t < 0.15) || (t > 0.3 && t < 0.35)
  if (down !== pressed) {
    pressed = down
    mcu.setPad(PC13, down)
  }
})
const sym = mcu.firmware!.symbols.find((s) => s.name === "button_presses")
expect({ what: "button_presses counter", got: sym ? mcu.bus.read32(sym.value) : -1, want: 2 })
expect({ what: "LD3 toggles per press", got: e2.PB14.length, want: 2 })
expect({ what: "EXTI pending cleared", got: mcu.exti.get("PR"), want: 0 })

const wall = (performance.now() - wall0) / 1000
console.log(`\n${mcu.time.toFixed(3)} s simulated in ${wall.toFixed(2)} s wall (${(mcu.time / wall).toFixed(2)}× real time), ${(mcu.cpu.instructions / wall / 1e6).toFixed(1)} MIPS, ${mcu.cpu.instructions} instructions`)
if (mcu.unmodelled.hits.size) {
  console.log("unmodelled peripheral accesses:")
  for (const [addr, h] of mcu.unmodelled.hits) console.log(`  0x${addr.toString(16)}: ${h.reads} reads, ${h.writes} writes`)
}
if (mcu.cpu.scs.faults.length) {
  console.log("faults:")
  for (const f of mcu.cpu.scs.faults) {
    const s = symbolAt(mcu.firmware!.symbols, f.pc)
    console.log(`  ${f.detail} at 0x${f.pc.toString(16)} (${s ? s.symbol.name + "+" + s.offset : "?"})`)
  }
}
for (const p of mcu.bus.peripherals) {
  const u = (p as { unknown?: Map<number, number> }).unknown
  if (u && u.size) console.log(`${p.name}: unknown register offsets ${[...u.keys()].map((o) => "0x" + o.toString(16)).join(", ")}`)
}
console.log(`\n${checks.length - failed}/${checks.length}`)
process.exit(failed ? 1 : 0)
