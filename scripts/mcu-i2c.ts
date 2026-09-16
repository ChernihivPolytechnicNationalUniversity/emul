/**
 * I²C master check: runs firmware/hal/Src/i2c.c on the F429 model with a 24C02 model
 * (src/sim/digital.ts) on PB8/PB9 through a two-line wired-AND bus, and checks that the
 * HAL's memory writes, acknowledge polling and reads all land.
 *
 *   pnpm mcu-i2c
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"
import { Eeprom24 } from "@/sim/digital"

const path = join(import.meta.dirname, "..", "firmware", "hal", "build", "i2c.elf")
const mcu = new Stm32F429()
mcu.load(readFileSync(path).buffer as ArrayBuffer, path)
const SCL = parsePad("PB8")!
const SDA = parsePad("PB9")!
const key = (p: { port: number; pin: number }) => p.port * 16 + p.pin
mcu.yieldOnOutput = true

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

/** The bus: two open-drain lines with pull-ups, the MCU and the EEPROM as drivers. */
const eeprom = new Eeprom24("U2", { value: "24C02" })
const drivers = { scl: { mcu: null as boolean | null }, sda: { mcu: null as boolean | null, mem: null as boolean | null } }
const level = { scl: true, sda: true }
const sclRises: number[] = []
let starts = 0
function resolve(time: number) {
  // Deliveries re-enter here (the EEPROM answers an edge at once), so re-read after each.
  for (;;) {
    const scl = drivers.scl.mcu !== false
    const sda = drivers.sda.mcu !== false && drivers.sda.mem !== false
    if (scl !== level.scl) {
      level.scl = scl
      if (scl) sclRises.push(time)
      mcu.setPadAt(SCL, scl, time)
      eeprom.input("SCL", scl, time)
      drain(time)
    } else if (sda !== level.sda) {
      if (!sda && level.scl) starts++
      level.sda = sda
      mcu.setPadAt(SDA, sda, time)
      eeprom.input("SDA", sda, time)
      drain(time)
    } else return
  }
}
function drain(time: number) {
  while (eeprom.out.length) {
    const e = eeprom.out.shift()!
    if (e.pin === "SDA") drivers.sda.mem = e.level
    resolve(time)
  }
}
function run(seconds: number) {
  const end = mcu.time + seconds
  while (mcu.time < end && mcu.running) {
    if (!mcu.runUntil(end)) break
    for (const e of mcu.digitalOut) {
      if (key(e.pad) === key(SCL)) drivers.scl.mcu = e.level
      else if (key(e.pad) === key(SDA)) drivers.sda.mcu = e.level
      resolve(e.time)
    }
    mcu.digitalOut.length = 0
  }
}

const wall0 = performance.now()
console.log("Boot and greeting")
mcu.setPad(SCL, true)
mcu.setPad(SDA, true)
run(0.04)
expect("core running", mcu.running ? "yes" : `halted: ${mcu.cpu.halted?.message}`, "yes")
const i2c1 = mcu.i2c.find((x) => x.spec.name === "I2C1")!
// 45 MHz / (2 × 100 kHz) = 225.
expect("I2C1 CCR from HAL (100 kHz)", i2c1.get("CCR") & 0xfff, 225)
expect("phase (3 = counter loop)", word("phase"), 3)
expect("no HAL errors", word("errors"), 0)
expect("read-back matched", word("verified"), 1)
const snap = eeprom.snapshot()
expect("EEPROM holds the greeting", String.fromCharCode(...snap.bytes.slice(0, 14)), "Hello, EEPROM!")
expect("acknowledge polling saw NACKs", word("polls") > 0 ? "yes" : "no", "yes")
expect("page writes: 2 pages + the counter", snap.writes, 15 + 1, 2)
const period = sclRises.length > 20 ? (sclRises[19] - sclRises[10]) / 9 : 0
expect("SCL period inside a byte (µs)", period * 1e6, 10, 0.3)

console.log("\nCounter at 0x40")
const c0 = word("counter")
run(0.5)
const c1 = word("counter")
expect("counter advances ~every 105 ms", c1 - c0, 5, 1)
expect("EEPROM byte 0x40 is the counter", eeprom.snapshot().bytes[0x40], c1)
expect("still no HAL errors", word("errors"), 0)
expect("no unmodelled features", mcu.unmodelled.summary().length, 0)

const wall = (performance.now() - wall0) / 1000
console.log(`\n${mcu.time.toFixed(3)} s simulated in ${wall.toFixed(2)} s wall, ${(mcu.cpu.instructions / wall / 1e6).toFixed(1)} MIPS, ${starts} START conditions`)
if (mcu.unmodelled.hits.size) console.log("unmodelled:", mcu.unmodelled.summary())
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
