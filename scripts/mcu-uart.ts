/**
 * USART check: runs firmware/hal/Src/uart.c on the F429 model, decodes what USART3 sends on
 * PD8 at 115200 8N1 and feeds bytes into PD9 to see them received under interrupt and echoed.
 *
 *   pnpm mcu-uart
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"

const path = join(import.meta.dirname, "..", "firmware", "hal", "build", "uart.elf")
const mcu = new Stm32F429()
mcu.load(readFileSync(path).buffer as ArrayBuffer, path)
const TX = parsePad("PD8")!
const RX = parsePad("PD9")!
const BAUD = 115200
const BIT = 1 / BAUD

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

/** A UART receiver on the TX pad: samples every step, decodes 8N1 frames. */
const decoded: string[] = []
let rxState: "idle" | "data" = "idle"
let rxT = 0
let rxByte = 0
let rxBit = 0
let lastTx = true
function watchTx() {
  const level = mcu.padDrive(TX) !== "low"
  const t = mcu.time
  if (rxState === "idle") {
    if (lastTx && !level) {
      rxState = "data"
      rxT = t + BIT * 1.5
      rxByte = 0
      rxBit = 0
    }
  } else if (t >= rxT) {
    if (rxBit < 8) {
      if (level) rxByte |= 1 << rxBit
      rxBit++
      rxT += BIT
    } else {
      if (!level) decoded.push("<framing error>")
      else decoded.push(String.fromCharCode(rxByte))
      rxState = "idle"
    }
  }
  lastTx = level
}
function run(seconds: number, step = BIT / 8) {
  const end = mcu.time + seconds
  while (mcu.time < end && mcu.running) {
    if (!mcu.run(step)) break
    watchTx()
  }
}
/** Send a byte into PD9 at the baud rate. */
function send(byte: number) {
  const bits = [false, ...Array.from({ length: 8 }, (_, i) => ((byte >>> i) & 1) === 1), true]
  for (const b of bits) {
    mcu.setPad(RX, b)
    run(BIT)
  }
}

const wall0 = performance.now()
console.log("Boot")
mcu.setPad(RX, true)
run(0.003)
expect("core running", mcu.running ? "yes" : `halted: ${mcu.cpu.halted?.message}`, "yes")
const u3 = mcu.usart.find((u) => u.spec.name === "USART3")!
// USARTDIV = 45 MHz / (16 × 115200) = 24.41 → BRR = 24.41 × 16 = 391 (0x187): 115 090 baud, 0.1 % off.
expect("USART3 BRR from HAL", u3.get("BRR"), 391)
expect("PD8 idles high (TX claimed)", mcu.padDrive(TX) ?? "float", "high")

console.log("\nTransmit: 'tick N' lines at 115200")
run(0.25)
const text = decoded.join("")
expect("first lines", text.split("\r\n").slice(0, 3).join("|"), "tick 0|tick 1|tick 2")
expect("no framing errors", decoded.filter((c) => c.startsWith("<")).length, 0)
expect("txCount matches decoded bytes", word("txCount"), decoded.length)

console.log("\nReceive under interrupt, echo upper-cased")
decoded.length = 0
send(0x61) // 'a'
run(BIT * 12)
expect("rxCount", word("rxCount"), 1)
expect("lastRx", word("lastRx"), 0x61)
expect("echoed 'A'", decoded.join(""), "A")
decoded.length = 0
for (const c of "hello") send(c.charCodeAt(0))
run(BIT * 12)
expect("rxCount after 'hello'", word("rxCount"), 6)
expect("echo 'HELLO'", decoded.join("").replace(/tick \d+\r\n/g, ""), "HELLO")
expect("no receive errors", word("rxErrors"), 0)

console.log("\nBad frame: a 0 stop bit is a framing error, not data")
mcu.setPad(RX, false)
run(BIT * 10)
mcu.setPad(RX, true)
run(BIT * 12)
expect("rxErrors after a break", word("rxErrors"), 1)

const wall = (performance.now() - wall0) / 1000
console.log(`\n${mcu.time.toFixed(3)} s simulated in ${wall.toFixed(2)} s wall, ${(mcu.cpu.instructions / wall / 1e6).toFixed(1)} MIPS`)
if (mcu.unmodelled.hits.size) console.log("unmodelled:", mcu.unmodelled.summary())
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
