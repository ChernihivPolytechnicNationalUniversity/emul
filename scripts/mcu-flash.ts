/**
 * Flash and boot check: runs firmware/hal/Src/flash.c on the F429 model — a boot counter
 * logged into sector 4 across five resets with an erase when the log fills, byte/halfword/
 * word programming, a store while locked, option bytes turning Stop into a reset — then
 * power-cycles the chip (flash persists), reloads the firmware (flash and option bytes go
 * back), and boots with BOOT0 high into the system-memory stub and into SRAM.
 *
 *   pnpm mcu-flash
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"

const path = join(import.meta.dirname, "..", "firmware", "hal", "build", "flash.elf")
const image = readFileSync(path).buffer as ArrayBuffer
const blink = join(import.meta.dirname, "..", "firmware", "hal", "build", "blink.elf")
const mcu = new Stm32F429()
mcu.load(image, path)

let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0) => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(5)) : JSON.stringify(v))
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(46)} ${fmt(got).padStart(14)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}
const sym = (name: string) => mcu.firmware?.symbols.find((s) => s.name === name)?.value
const word = (name: string) => {
  const a = sym(name)
  return a === undefined ? -1 : mcu.bus.read32(a)
}
const LOG = 0x08010000
const logSlot = (i: number) => mcu.bus.read32(LOG + 4 * i)

/** Resets as they happen, with what the dying life had in its variables. */
const resets: { cause: string; at: number; vars: Record<string, number> }[] = []
const origReset = mcu.reset.bind(mcu)
mcu.reset = (cause = "por") => {
  const vars: Record<string, number> = {}
  for (const v of ["boots", "slot", "phase", "patternOk", "lockedError", "obUser", "stopReset", "errors"]) vars[v] = word(v)
  resets.push({ cause, at: mcu.time, vars })
  origReset(cause)
}
function run(seconds: number, step = 1e-3) {
  const end = mcu.time + seconds
  while (mcu.time < end && mcu.running) if (!mcu.run(Math.min(step, end - mcu.time))) break
}
/** Run until `phase` reads `value`; returns the time it did. */
function runUntilPhase(value: number, limit: number): number {
  const end = mcu.time + limit
  while (mcu.time < end && mcu.running && word("phase") !== value) if (!mcu.run(Math.min(1e-4, end - mcu.time))) break
  return mcu.time
}

/** Run until the chip has reset `n` times (or the time runs out). */
function runUntilResets(n: number, limit: number) {
  const end = mcu.time + limit
  while (mcu.time < end && mcu.running && resets.length < n) if (!mcu.run(Math.min(1e-4, end - mcu.time))) break
}

const wall0 = performance.now()
console.log("Boot 1: an empty log, programming, a locked store")
runUntilResets(1, 0.05)
expect("core running", mcu.running ? "yes" : `halted: ${mcu.cpu.halted?.message}`, "yes")
expect("software reset after the tests", resets.length ? resets[0].cause : "none", "system")
expect("boot counter started at 1", resets[0]?.vars.boots ?? 0, 1)
expect("slot 0 holds it", logSlot(0), 1)
expect("byte/halfword/word programmed and AND-ed", resets[0]?.vars.patternOk ?? 0, 1)
expect("a store while locked → PGSERR, nothing written", resets[0]?.vars.lockedError ?? 0, 1)
expect("no HAL errors", resets[0]?.vars.errors ?? -1, 0)

console.log("\nBoot 2: option bytes make Stop a reset")
runUntilResets(2, 0.05)
expect("second reset", resets.length, 2)
expect("boot 2 logged in slot 1", logSlot(1), 2)
expect("factory USER option bytes read back", (resets[1]?.vars.obUser ?? 0).toString(16), "e0")
expect("Stop with nRST_STOP=0 reset the chip", resets[1]?.vars.errors ?? -1, 0)
expect("option bytes survived the reset (nRST_STOP still 0)", mcu.flash.resetOnStop() ? "yes" : "no", "yes")

console.log("\nBoot 3 and 4")
runUntilResets(3, 0.05)
expect("boot 3 saw a software reset flag", resets[2]?.vars.stopReset ?? -1, 1)
expect("boot 3 read nRST_STOP=0 in the user bytes", ((resets[2]?.vars.obUser ?? 0) >>> 0).toString(16), "a0")
expect("nRST_STOP restored", mcu.flash.resetOnStop() ? "still reset" : "no reset", "no reset")
runUntilResets(4, 0.05)
expect("four boots logged", `${logSlot(0)} ${logSlot(1)} ${logSlot(2)} ${logSlot(3)}`, "1 2 3 4")

console.log("\nBoot 5: the log is full, the sector is erased")
// The erase is one stalled instruction: the longest 10 µs step on the way to phase 3 is it.
let stall = 0
while (word("phase") < 3 && mcu.running && mcu.time < 2) {
  const t = mcu.time
  mcu.run(1e-5)
  stall = Math.max(stall, mcu.time - t)
}
expect("sector 4 (64 KB) erase stalled the core (ms)", stall * 1e3, 550, 1)
runUntilPhase(9, 0.05)
expect("log restarted: slot 0 = 5, slot 1 erased", `${logSlot(0)} ${logSlot(1).toString(16)}`, "5 ffffffff")
expect("LD1 on, idle", `${mcu.padDrive(parsePad("PB0")!)} ${mcu.powerMode}`, "high sleep")
expect("no HAL errors in any life", resets.every((r) => r.vars.errors === 0) ? "none" : "some", "none")
expect("reset count and cause", `${mcu.resets} by ${mcu.lastReset}`, "4 by system")

console.log("\nPower cycle: flash persists")
mcu.reset("por")
runUntilPhase(9, 0.05)
expect("boot 6 appended to the surviving log", `${logSlot(0)} ${logSlot(1)}`, "5 6")
expect("option bytes as read from 0x1FFFC000", mcu.bus.read32(0x1fffc000).toString(16), "5513aaec")

console.log("\nReload firmware: a fresh part")
mcu.load(image, path)
run(0.002)
expect("log erased with the flash", `${logSlot(0)} ${logSlot(1).toString(16)}`, "1 ffffffff")

console.log("\nHardware watchdog option byte (with the blink firmware, which never feeds a dog)")
mcu.load(readFileSync(blink).buffer as ArrayBuffer, blink)
run(0.0005)
mcu.bus.write32(0x40023c08, 0x08192a3b)
mcu.bus.write32(0x40023c08, 0x4c5d6e7f)
expect("OPTKEYR unlocked OPTCR", mcu.flash.get("OPTCR") & 1, 0)
mcu.bus.write32(0x40023c14, (mcu.flash.get("OPTCR") & ~(1 << 5)) | 2)
expect("WDG_SW = hardware", mcu.flash.iwdgHardware() ? "hardware" : "software", "hardware")
mcu.reset("system")
const before = resets.length
const t0 = mcu.time
run(0.7)
const bite = resets.slice(before).find((r) => r.cause === "iwdg")
expect("IWDG bit with nobody feeding it", bite ? bite.cause : "none", "iwdg")
expect("512 ms after the reset (4095 ticks of LSI/4)", bite ? (bite.at - t0) * 1e3 : 0, 512, 1)

console.log("\nWait states (blink at 180 MHz: LATENCY 5, ART on)")
mcu.load(readFileSync(blink).buffer as ArrayBuffer, blink)
run(0.01)
expect("ACR as the HAL set it", `${mcu.cpu.flashTiming.latency} ws, prefetch ${mcu.cpu.flashTiming.prefetch ? "on" : "off"}, cache ${mcu.cpu.flashTiming.cache ? "on" : "off"}`, "5 ws, prefetch on, cache on")
const cpi = (seconds: number) => {
  const c0 = mcu.cpu.cycles
  const i0 = mcu.cpu.instructions
  run(seconds)
  return (mcu.cpu.cycles - c0) / (mcu.cpu.instructions - i0)
}
const cached = cpi(0.01)
expect("hot loop runs out of the ART (cycles per instruction)", cached, 1.9, 0.4)
mcu.bus.write32(0x40023c00, 5) // caches and prefetch off, 5 wait states stay
const bare = cpi(0.01)
expect("caches off: 5 wait states per line and per literal (extra CPI)", bare - cached, 2.1, 0.8)
mcu.bus.write32(0x40023c00, 0x105) // prefetch only
const prefetched = cpi(0.01)
expect("prefetch alone hides most of it", prefetched < bare && prefetched > cached ? "yes" : `no (${prefetched.toFixed(2)})`, "yes")

console.log("\nBOOT0")
mcu.load(image, path)
mcu.boot0 = true
mcu.reset("por")
run(0.002)
expect("boots into system memory", `0x${mcu.cpu.scs.vtor.toString(16)}`, "0x1fff0000")
expect("the bootloader stub sleeps", mcu.powerMode, "sleep")
expect("reported as unmodelled", [...mcu.unmodelled.features.keys()].join(","), "system bootloader (BOOT0 high)")
mcu.setPad(parsePad("PB2")!, true)
mcu.reset("por")
run(0.001)
expect("BOOT1 (PB2) high too: SRAM boot", `0x${mcu.cpu.scs.vtor.toString(16)}`, "0x20000000")
expect("nothing there: lockup", mcu.cpu.halted?.reason ?? "running", "fault")
mcu.boot0 = false
mcu.setPad(parsePad("PB2")!, false)
mcu.reset("por")
run(0.01)
expect("BOOT0 low: flash again", `0x${mcu.cpu.scs.vtor.toString(16)} ${mcu.running ? "running" : "halted"}`, "0x8000000 running")

const wall = (performance.now() - wall0) / 1000
console.log(`\n${mcu.time.toFixed(3)} s simulated in ${wall.toFixed(2)} s wall`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
