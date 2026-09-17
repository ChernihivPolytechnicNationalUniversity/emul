/**
 * Co-simulation check of the "Nucleo serial console" example: USART3 at 115200 through the
 * VCP pins into the serial terminal, decoded from exact-time edges despite the 20 µs analog
 * step; text typed into the terminal reaches the firmware and comes back echoed + 1.
 *
 *   pnpm nucleo-serial
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { nucleoSerial } from "@/schematic/examples"
import { pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"

const elf = readFileSync(join(import.meta.dirname, "..", "public", "firmware", "nucleo-uart.elf"))
const doc = nucleoSerial.build(GRID)
const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
const term = doc.objects.find((o) => o.def === "serial-terminal")!
u.props = { ...u.props, firmware: "nucleo-uart.elf", firmwareData: elf.toString("base64") }

const loop = new SimLoop()
loop.setDoc(doc)
loop.setParts(doc.parts)
loop.setRunning(true)
let clock = 0
loop.advance(clock)
function run(seconds: number) {
  const end = clock + seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 30)
    loop.advance(clock)
  }
}
let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string) => {
  total++
  const ok = got === want
  if (!ok) failed++
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(44)} ${JSON.stringify(got).padStart(14)}  expected ${JSON.stringify(want)}`)
}
const text = () => loop.snapshot()!.terminals[term.id].text

const wall0 = performance.now()
run(0.35)
let snap = loop.snapshot()!
expect("core running", snap.mcus[u.id].running ? "yes" : "no", "yes")
expect("VCP TX pin idles high", snap.pinVoltage[pinKey(u.id, "VCP-TX")] > 3 ? "high" : "low", "high")
expect("terminal shows the ticks", text().split("\r\n").slice(0, 3).join("|"), "tick 0|tick 1|tick 2")
expect("no framing errors", snap.terminals[term.id].framingErrors, 0)

console.log("\nTyping into the terminal")
loop.sendSerial(term.id, "hi")
run(0.12)
snap = loop.snapshot()!
const after = text().replace(/tick \d+\r\n/g, "")
expect("echo of 'hi' upper-cased", after.slice(-2), "HI")
expect("terminal TX pin back high", snap.pinVoltage[pinKey(term.id, "TX")] > 3 ? "high" : "low", "high")

console.log("\nNon-ASCII goes out as UTF-8 bytes (and CP1251 when asked)")
const mcu = (loop as unknown as { mcus: Map<string, { mcu: { mcu: { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } } } }> }).mcus.get(u.id)!.mcu.mcu
const rxCount = () => mcu.bus.read32(mcu.firmware.symbols.find((x) => x.name === "rxCount")!.value)
let before = rxCount()
loop.sendSerial(term.id, "Привет")
run(0.03)
expect("'Привет' is 12 bytes in UTF-8", rxCount() - before, 12)
expect("and comes back readable", text().replace(/tick \d+\r\n/g, "").slice(-6), "Привет")
run(0.7)
expect("firmware's own UTF-8 line decoded", /Крок 9\r\n/.test(text()) ? "Крок 9" : "not found", "Крок 9")
term.props = { ...term.props, charset: "windows-1251" }
loop.setDoc(doc)
before = rxCount()
loop.sendSerial(term.id, "Привет")
run(0.03)
expect("'Привет' is 6 bytes in CP1251", rxCount() - before, 6)
term.props = { ...term.props, charset: "utf-8" }
loop.setDoc(doc)

console.log("\nBaud mismatch is garbage, not silence")
term.props = { ...term.props, baud: "9600" }
loop.setDoc(doc)
run(0.25)
snap = loop.snapshot()!
const tail = text().slice(-40)
expect("no clean 'tick' lines at the wrong baud", /tick \d+\r\n$/.test(tail) ? "clean" : "garbage or errors", "garbage or errors")

const wall = (performance.now() - wall0) / 1000
console.log(`\n${snap.time.toFixed(2)} s simulated in ${wall.toFixed(1)} s wall (${(snap.time / wall).toFixed(2)}× real time)`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
