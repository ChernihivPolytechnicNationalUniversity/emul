/**
 * DMA check: runs firmware/hal/Src/dma.c on the F429 model — a memory-to-memory copy, USART3
 * transmit and receive through DMA1 with the HAL's interrupt chain, and a TIM3-paced circular
 * stream toggling PB7 through GPIOB->BSRR with no CPU involved.
 *
 *   pnpm mcu-dma
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"
import { UartDecoder, uartFrameEdges } from "@/sim/serial"

const path = join(import.meta.dirname, "..", "firmware", "hal", "build", "dma.elf")
const mcu = new Stm32F429()
mcu.load(readFileSync(path).buffer as ArrayBuffer, path)
const TX = parsePad("PD8")!
const RX = parsePad("PD9")!
const LD2 = parsePad("PB7")!
const BAUD = 115200
const key = (p: { port: number; pin: number }) => p.port * 16 + p.pin
mcu.digitalWatch.add(key(LD2))

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

const decoder = new UartDecoder(BAUD)
const ld2Edges: number[] = []
function run(seconds: number) {
  const end = mcu.time + seconds
  while (mcu.time < end && mcu.running) {
    if (!mcu.runUntil(end)) break
    for (const e of mcu.digitalOut) {
      if (key(e.pad) === key(TX)) decoder.edge({ time: e.time, level: e.level !== false })
      else if (key(e.pad) === key(LD2)) ld2Edges.push(e.time)
    }
    mcu.digitalOut.length = 0
    decoder.poll(mcu.time)
  }
}
const text = () => String.fromCharCode(...decoder.bytes)

const wall0 = performance.now()
console.log("Memory to memory, then the first DMA line")
mcu.setPad(RX, true)
run(0.03)
expect("core running", mcu.running ? "yes" : `halted: ${mcu.cpu.halted?.message}`, "yes")
expect("memory-to-memory copy verified", word("m2mOk"), 1)
expect("first line arrived by DMA", text().split("\r\n")[0], "dma line 0 abcdefghijklmnopqrstuvwxy")
expect("TxCplt callbacks so far", word("txDone"), 1)
expect("no HAL errors", word("errors"), 0)

console.log("\nTimer-paced circular stream on PB7")
const toggles = ld2Edges.filter((t) => t > 0.01 && t < 0.03).length
expect("PB7 toggles at 100 Hz (in 20 ms)", toggles, 2, 1)
run(0.25)
expect("lines keep coming every ~101 ms", word("txDone"), 3, 1)
const intervals = ld2Edges.slice(-10).map((t, i, a) => (i ? t - a[i - 1] : 0)).slice(1)
expect("toggle interval (ms)", (intervals.reduce((a, b) => a + b, 0) / intervals.length) * 1e3, 10, 0.05)

console.log("\nReceive by DMA: an 8-byte frame is echoed")
const frame = "ABCDEFGH"
let at = mcu.time + 1e-3
const edges = [...frame].flatMap((c) => {
  const e = uartFrameEdges(c.charCodeAt(0), at, BAUD)
  at += 10 / BAUD
  return e
})
for (const e of edges) mcu.setPadAt(RX, e.level, e.time)
const before = decoder.bytes.length
run(0.12)
expect("RxCplt callbacks", word("rxDone"), 1)
expect("frame landed in rxBuf", String.fromCharCode(...Array.from({ length: 8 }, (_, i) => mcu.bus.read8(sym("rxBuf") + i))), frame)
expect("echoed back through DMA", text().slice(before).includes(frame) ? "yes" : "no", "yes")
expect("still no HAL errors", word("errors"), 0)
expect("no unmodelled features", mcu.unmodelled.summary().length, 0)

const wall = (performance.now() - wall0) / 1000
console.log(`\n${mcu.time.toFixed(3)} s simulated in ${wall.toFixed(2)} s wall, ${(mcu.cpu.instructions / wall / 1e6).toFixed(1)} MIPS`)
if (mcu.unmodelled.hits.size) console.log("unmodelled:", mcu.unmodelled.summary())
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
