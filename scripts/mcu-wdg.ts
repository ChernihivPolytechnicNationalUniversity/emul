/**
 * Watchdog and RTC check: runs firmware/hal/Src/wdg.c on the F429 model through its three
 * lives — an IWDG timeout reset, a WWDG window-violation reset, then the RTC calendar,
 * alarm and wake-up timer under interrupt — with the backup registers carrying the story
 * across the resets.
 *
 *   pnpm mcu-wdg
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Stm32F429 } from "@/mcu/stm32f429"

const path = join(import.meta.dirname, "..", "firmware", "hal", "build", "wdg.elf")
const mcu = new Stm32F429()
mcu.load(readFileSync(path).buffer as ArrayBuffer, path)

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
const bkp = (n: number) => mcu.rtc.get(`BKP${n}R`)

/** Resets as they happen: cause, time, and what the dying life had counted. */
const resets: { cause: string; at: number; refreshes: number; ewi: number }[] = []
const origReset = mcu.reset.bind(mcu)
mcu.reset = (cause = "por") => {
  resets.push({ cause, at: mcu.time, refreshes: word("refreshes"), ewi: word("ewi") })
  origReset(cause)
}
function run(seconds: number) {
  const end = mcu.time + seconds
  while (mcu.time < end && mcu.running) if (!mcu.run(1e-3)) break
}

const wall0 = performance.now()
console.log("Life 0: IWDG")
run(0.35)
expect("core running", mcu.running ? "yes" : `halted: ${mcu.cpu.halted?.message}`, "yes")
expect("life 0 saw a power-on reset (CSR POR flag)", (bkp(1) >>> 27) & 1, 1)
expect("15 refreshes done", word("refreshes"), 15)
expect("no reset while refreshing", resets.length, 0)
run(0.2)
expect("IWDG reset ~100 ms after the last refresh", resets.length ? resets[0].cause : "none", "iwdg")
// 15 × HAL_Delay(20) (21 ms each, HAL adds a tick) + 100 ms of timeout.
expect("at (ms)", resets.length ? resets[0].at * 1e3 : 0, 15 * 21 + 100, 6)

console.log("\nLife 1: WWDG")
run(0.05)
expect("life counter carried in BKP0R", bkp(0), 2)
expect("IWDGRSTF seen by life 1", (bkp(2) >>> 29) & 1, 1)
expect("POR flag cleared by then", (bkp(2) >>> 27) & 1, 0)
run(0.4)
expect("WWDG timeout reset", resets.length >= 2 ? resets[1].cause : "none", "wwdg")
expect("ten in-window refreshes before it", resets[1]?.refreshes ?? 0, 10)
expect("early wake-up interrupt fired at 0x40", resets[1]?.ewi ?? 0, 1)
// 10 × 36 ms of refreshes, then 0x7F → 0x3F is 64 ticks of 0.728 ms.
expect("WWDG reset time (ms after life 1 began)", resets.length >= 2 ? (resets[1].at - resets[0].at) * 1e3 : 0, 10 * 36 + 64 * 0.728, 4)

console.log("\nLife 2: RTC on LSE")
run(0.1)
expect("WWDGRSTF seen by life 2", (bkp(3) >>> 30) & 1, 1)
expect("no HAL errors", word("errors"), 0)
expect("time set", word("rtcTime"), 123456)
expect("date set (2026-09-16)", word("rtcDate"), 260916)
const rtcAt = { sim: mcu.time, time: word("rtcTime"), sub: word("rtcSub") }
run(1.0)
expect("one RTC second per simulated second", word("rtcTime") - rtcAt.time, 1, 0)
{
  // The firmware samples every 10 ms (2.5 ticks of 1/256 s), so compare modulo 256 with slack.
  const seen = (rtcAt.sub - word("rtcSub") + 256) % 256
  const want = Math.round(((mcu.time - rtcAt.sim) % 1) * 256) % 256
  const dist = Math.min((seen - want + 256) % 256, (want - seen + 256) % 256)
  expect("subseconds count 256 per second (ticks off)", dist, 0, 3)
}
run(1.2)
expect("alarm A fired at 12:34:58", word("alarms"), 1)
expect("wake-ups every 0.5 s", word("wakeups"), Math.floor((mcu.time - resets[1].at - 0.02) / 0.5), 1)
expect("RTC registers survived the resets (BKP0R = 3)", bkp(0), 3)

console.log("\nLife 2 ends with a window violation")
run(0.4)
expect("WWDG reset on a refresh above the window", resets.length >= 3 ? resets[2].cause : "none", "wwdg")
expect("life 3 started", bkp(0), 4)
expect("RTC still running through it (seconds advanced)", word("rtcTime") === 0 ? "cleared with RAM" : "kept", "cleared with RAM")
expect("RTC keeps counting in the backup domain (TR)", mcu.rtc.read(0, 4).toString(16), "123458")
expect("no unmodelled features", mcu.unmodelled.summary().length, 0)

const wall = (performance.now() - wall0) / 1000
console.log(`\n${mcu.time.toFixed(3)} s simulated in ${wall.toFixed(2)} s wall, ${(mcu.cpu.instructions / wall / 1e6).toFixed(1)} MIPS`)
if (mcu.unmodelled.hits.size) console.log("unmodelled:", mcu.unmodelled.summary())
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
