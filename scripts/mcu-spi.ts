/**
 * SPI master check: runs firmware/hal/Src/spi.c on the F429 model, decodes the SCK/MOSI edges
 * SPI1 puts on PA5/PA7 (with the bit-banged chip select on PD14) and answers on MISO like a
 * slave would, checking that the firmware sees the reply.
 *
 *   pnpm mcu-spi
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"

const path = join(import.meta.dirname, "..", "firmware", "hal", "build", "spi.elf")
const mcu = new Stm32F429()
mcu.load(readFileSync(path).buffer as ArrayBuffer, path)
const SCK = parsePad("PA5")!
const MISO = parsePad("PA6")!
const MOSI = parsePad("PA7")!
const CS = parsePad("PD14")!
const key = (p: { port: number; pin: number }) => p.port * 16 + p.pin
mcu.digitalWatch.add(key(CS))
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
const byte = (name: string, i: number) => mcu.bus.read8(sym(name) + i)

/** The slave at the other end: mode 0 (CPOL 0, CPHA 0), MSB first, replies 0x50 + n. */
const frames: { at: number; mosi: number; risingEdges: number[] }[] = []
let mosi = false
let sck = false
let cs = true
let reply = 0
let replyBit = 0
let cur: (typeof frames)[number] | null = null
function slave(e: { pad: { port: number; pin: number }; level: boolean | null; time: number }) {
  const k = key(e.pad)
  // A released pad (null) reads high here: the bench has a pull-up on the chip select.
  if (k === key(MOSI)) mosi = e.level !== false
  else if (k === key(CS)) {
    if ((e.level !== false) === cs) return
    cs = e.level !== false
    if (!cs) {
      // Selected: the first bit of the reply goes out before any clock.
      reply = 0x50 + (frames.length & 0x0f)
      replyBit = 0
      mcu.setPad(MISO, ((reply >>> 7) & 1) === 1)
      cur = { at: e.time, mosi: 0, risingEdges: [] }
      frames.push(cur)
    } else mcu.setPad(MISO, false)
  } else if (k === key(SCK)) {
    // The pin being claimed at its idle level is not an edge.
    if ((e.level !== false) === sck) return
    sck = e.level !== false
    if (!cur || cs) return
    if (e.level) {
      // Rising: sample MOSI.
      cur.mosi = ((cur.mosi << 1) | (mosi ? 1 : 0)) & 0xff
      cur.risingEdges.push(e.time)
    } else {
      // Falling: shift out the next reply bit.
      replyBit++
      if (replyBit < 8) mcu.setPad(MISO, ((reply >>> (7 - replyBit)) & 1) === 1)
    }
  }
}
function run(seconds: number) {
  const end = mcu.time + seconds
  while (mcu.time < end && mcu.running) {
    if (!mcu.runUntil(end)) break
    for (const e of mcu.digitalOut) slave(e)
    mcu.digitalOut.length = 0
  }
}

const wall0 = performance.now()
console.log("Boot")
run(0.012) // past the master's start-up grace period
expect("core running", mcu.running ? "yes" : `halted: ${mcu.cpu.halted?.message}`, "yes")
const spi1 = mcu.spi.find((s) => s.spec.name === "SPI1")!
expect("SPI1 CR1: master, ÷64, soft NSS, enabled", (spi1.get("CR1") & 0x37c).toString(16), (0x4 | (5 << 3) | 0x40 | 0x300).toString(16))
expect("SCK idles low (AF claimed)", mcu.padDrive(SCK) ?? "float", "low")
expect("chip select idles high", mcu.padDrive(CS) ?? "float", "high")

console.log("\nTransfers every 10 ms (after a 10 ms grace period)")
run(0.051)
expect("transfers counted by the firmware", word("count"), 5, 1)
expect("no HAL errors", word("errors"), 0)
expect("frames seen by the slave", frames.length, word("count"))
expect("first byte on MOSI", frames[0].mosi.toString(16), "a0")
expect("fourth byte on MOSI", frames[3].mosi.toString(16), "a3")
expect("8 clocks per byte", frames[1].risingEdges.length, 8)
const period = (frames[1].risingEdges[7] - frames[1].risingEdges[0]) / 7
expect("SCK period at 90 MHz / 64 (ns)", period * 1e9, 1e9 / (90e6 / 64), 2)
expect("chip select falls before the clock (µs)", (frames[1].risingEdges[0] - frames[1].at) * 1e6, 1.5, 1.5)
expect("reply 0x50 read back by the master", byte("rxLog", 0).toString(16), "50")
expect("reply 0x53 read back by the master", byte("rxLog", 3).toString(16), "53")
// HAL_Delay(10) waits 10 ticks plus one to be safe.
expect("interval between transfers (ms)", (frames[3].at - frames[2].at) * 1e3, 11, 0.2)
expect("no unmodelled features", mcu.unmodelled.summary().length, 0)

const wall = (performance.now() - wall0) / 1000
console.log(`\n${mcu.time.toFixed(3)} s simulated in ${wall.toFixed(2)} s wall, ${(mcu.cpu.instructions / wall / 1e6).toFixed(1)} MIPS`)
if (mcu.unmodelled.hits.size) console.log("unmodelled:", mcu.unmodelled.summary())
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
