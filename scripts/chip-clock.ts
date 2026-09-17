/**
 * Clock sources on the field: the lab 1 stand boots on its 8 MHz crystal (HSE ready 2 ms
 * after the firmware switches it on), and stops in Error_Handler when the crystal is taken
 * away or swapped for an oscillator module the firmware's crystal mode cannot use; a bare
 * F429 runs the Nucleo blink firmware (HSE bypass) from an oscillator module, but only while
 * the module has VCC; the Nucleo's own 32.768 kHz crystal takes 2 s to start.
 *
 *   pnpm chip-clock
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { builder } from "@/schematic/builder"
import { lab1Stand, nucleoBlink } from "@/schematic/examples"
import { partKey, type Schematic } from "@/schematic/types"
import { SimLoop, type McuStatus } from "@/sim/loop"
import type { Stm32 } from "@/mcu/stm32f429"

const lab1 = readFileSync(join(import.meta.dirname, "..", "public", "firmware", "lab1-f746.elf"))
const blink = readFileSync(join(import.meta.dirname, "..", "public", "firmware", "nucleo-blink.elf"))
const wdg = readFileSync(join(import.meta.dirname, "..", "firmware", "hal", "build", "wdg.elf"))

let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0) => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(4)) : String(v))
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(52)} ${fmt(got).padStart(12)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}

/** A loop over a document, with the core of the one MCU on it and a tick-by-tick runner. */
function start(doc: Schematic, mcuId: string) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const core = (loop as unknown as { mcus: Map<string, { mcu: { mcu: Stm32 } }> }).mcus.get(mcuId)!.mcu.mcu
  /** Advance by `seconds` in `tick`-second steps, sampling the status after each. */
  const run = (seconds: number, tick = 0.03, sample?: (st: McuStatus, t: number) => void) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + tick * 1000)
      loop.advance(clock)
      if (sample) sample(loop.snapshot()!.mcus[mcuId], clock / 1000)
    }
  }
  const status = () => loop.snapshot()!.mcus[mcuId]
  const inFunction = (name: string) => {
    const sym = core.firmware?.symbols.find((s) => s.name === name)
    const pc = core.cpu.pc
    return sym ? pc >= sym.value && pc < sym.value + Math.max(sym.size, 16) : false
  }
  return { loop, core, run, status, inFunction }
}
const label = (st: McuStatus) => `${st.clock.source}${st.clock.source === "PLL" ? `←${st.clock.pllSource}` : ""} ${(st.sysclk / 1e6).toFixed(0)} MHz, HSE ${st.clock.hse ? `${st.clock.hse.hz / 1e6} MHz ${st.clock.hse.kind}` : "none"}`

const wall0 = performance.now()
console.log("Lab 1 stand: 8 MHz crystal on PH0/PH1")
{
  const doc = lab1Stand.build(GRID)
  const dd = doc.objects.find((o) => o.def === "stm32f746ig")!
  dd.props = { ...dd.props, firmware: "lab1-f746.elf", firmwareData: lab1.toString("base64") }
  const { core, run, status } = start(doc, dd.id)
  // HSEON and HSERDY as the firmware sees them, sampled every 100 µs of the loop.
  let onAt = -1
  let readyAt = -1
  run(0.02, 1e-4, (_, t) => {
    const cr = core.rcc.get("CR")
    if (onAt < 0 && cr & (1 << 16)) onAt = t
    if (readyAt < 0 && cr & (1 << 17)) readyAt = t
  })
  expect("firmware switched HSE on (ms)", onAt * 1e3, 0.4, 0.5)
  expect("crystal start-up: HSERDY 2 ms later (ms)", (readyAt - onAt) * 1e3, 2, 0.15)
  expect("clock tree", label(status()), "PLL←HSE 50 MHz, HSE 8 MHz crystal")
  expect("no clock problem", status().clock.problems.join("; ") || "none", "none")
  expect("running", status().running ? "yes" : "no", "yes")
}

console.log("\nLab 1 stand without the crystal")
{
  const doc = lab1Stand.build(GRID)
  const dd = doc.objects.find((o) => o.def === "stm32f746ig")!
  dd.props = { ...dd.props, firmware: "lab1-f746.elf", firmwareData: lab1.toString("base64") }
  const zq = doc.objects.find((o) => o.def === "crystal")!
  doc.objects = doc.objects.filter((o) => o !== zq)
  doc.wires = doc.wires.filter((w) => w.from.object !== zq.id && w.to.object !== zq.id)
  const { loop, run, status, inFunction } = start(doc, dd.id)
  run(0.05)
  expect("the inspector says why", status().clock.problems.join("; "), "HSE on: no crystal on OSC_IN/OSC_OUT")
  expect("still on HSI", label(status()), "HSI 16 MHz, HSE none")
  run(0.2)
  expect("HAL timed out into Error_Handler", inFunction("Error_Handler") ? "yes" : `no, pc 0x${status().pc.toString(16)}`, "yes")
  const vd1 = doc.objects.find((o) => o.props?.ref === "VD1")!
  expect("L1 never lit", loop.snapshot()!.parts[partKey(vd1.id, "LED")]?.on ? "lit" : "dark", "dark")
}

console.log("\nLab 1 stand with an oscillator module instead (firmware wants a crystal)")
{
  const doc = lab1Stand.build(GRID)
  const dd = doc.objects.find((o) => o.def === "stm32f746ig")!
  dd.props = { ...dd.props, firmware: "lab1-f746.elf", firmwareData: lab1.toString("base64") }
  const zq = doc.objects.find((o) => o.def === "crystal")!
  doc.objects = doc.objects.filter((o) => o !== zq)
  doc.wires = doc.wires.filter((w) => w.from.object !== zq.id && w.to.object !== zq.id)
  const extra = builder(GRID)
  const g = extra.place("oscillator", 40, 40, { value: "8 MHz" })
  const v = extra.place("supply", 40, 36, { value: "+3V3", voltage: "3.3 V" })
  const gnd = extra.place("ground", 40, 44)
  extra.wire(g, "OUT", dd, "PH0")
  extra.wire(v, "V", g, "VCC")
  extra.wire(g, "GND", gnd, "GND")
  doc.objects.push(...extra.doc.objects)
  doc.wires.push(...extra.doc.wires)
  const { run, status } = start(doc, dd.id)
  run(0.05)
  expect("the inspector says why", status().clock.problems.join("; "), "HSE in crystal mode, but OSC_IN carries an external clock (needs HSEBYP)")
  expect("HSE seen but unusable", label(status()), "HSI 16 MHz, HSE 8 MHz clock")
}

console.log("\nBare STM32F429 on an oscillator module, Nucleo blink firmware (HSE bypass)")
{
  const build = (vccWired: boolean) => {
    const { doc, place, wire } = builder(GRID)
    const dd = place("stm32f429zi", 0, 0, { firmware: "nucleo-blink.elf", firmwareData: blink.toString("base64") })
    const v33 = place("supply", -6, 0, { value: "+3V3", voltage: "3.3 V" })
    const gnd = place("ground", -6, 10)
    wire(v33, "V", dd, "VDD")
    wire(dd, "VSS", gnd, "GND")
    const g = place("oscillator", 20, 0, { value: "8 MHz" })
    wire(g, "OUT", dd, "PH0")
    wire(g, "GND", gnd, "GND")
    if (vccWired) wire(v33, "V", g, "VCC")
    // LD1 as on the board: PB0 → 510 Ω → LED → ground.
    const r = place("resistor", 20, 20, { value: "510 Ω" })
    const led = place("led", 26, 20, { value: "green" })
    wire(dd, "PB0", r, "1")
    wire(r, "2", led, "1")
    wire(led, "2", gnd, "GND")
    return { doc, dd, led }
  }
  const powered = build(true)
  const a = start(powered.doc, powered.dd.id)
  a.run(0.05)
  expect("clock tree", label(a.status()), "PLL←HSE 180 MHz, HSE 8 MHz clock")
  expect("no clock problem", a.status().clock.problems.join("; ") || "none", "none")
  let lit = false
  a.run(0.6, 0.03, () => {
    lit ||= a.loop.snapshot()!.parts[partKey(powered.led.id, "LED")]?.on ?? false
  })
  expect("LD1 blinks", lit ? "yes" : "no", "yes")

  const dead = build(false)
  const b = start(dead.doc, dead.dd.id)
  b.run(0.05)
  expect("module without VCC: no clock", b.status().clock.problems.join("; "), "HSE bypass on: no external clock on OSC_IN")
  expect("core stays on HSI", label(b.status()), "HSI 16 MHz, HSE none")
  b.run(0.2)
  expect("blink's Error_Handler (bkpt 0xEE)", b.status().halted?.replace(/at 0x[0-9a-f]+/, "") ?? "running", "bkpt : bkpt #238")
}

console.log("\nNucleo-144: the X2 32.768 kHz crystal takes 2 s to start (wdg firmware sets up LSE → RTC at every boot)")
{
  const doc = nucleoBlink.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  u.props = { ...u.props, firmware: "wdg.elf", firmwareData: wdg.toString("base64") }
  const { core, run, status } = start(doc, u.id)
  let onAt = -1
  let readyAt = -1
  run(3.2, 0.005, (_, t) => {
    const bdcr = core.rcc.get("BDCR")
    if (onAt < 0 && bdcr & 1) onAt = t
    if (readyAt < 0 && bdcr & 2) readyAt = t
  })
  expect("LSE switched on at boot (s)", onAt, 0.005, 0.01)
  expect("LSERDY 2 s later (s)", readyAt - onAt, 2, 0.02)
  expect("LSE source", status().clock.lse ? `${status().clock.lse!.hz} Hz ${status().clock.lse!.kind}` : "none", "32768 Hz crystal")
  expect("no clock problem once it runs", status().clock.problems.join("; ") || "none", "none")
  expect("RTC clocked from LSE", core.rcc.rtcHz(), 32768)
}

const wall = (performance.now() - wall0) / 1000
console.log(`\n${wall.toFixed(1)} s wall`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
