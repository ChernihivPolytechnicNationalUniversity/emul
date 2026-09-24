/**
 * Clock sources on the field: the lab 1 stand boots on its 8 MHz crystal (HSE ready 2 ms
 * after the firmware switches it on), and stops in Error_Handler when the crystal is taken
 * away or swapped for an oscillator module the firmware's crystal mode cannot use; a bare
 * F429 runs the Nucleo blink firmware (HSE bypass) from an oscillator module, but only while
 * the module has VCC; the Nucleo's own 32.768 kHz crystal takes 2 s to start.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { builder } from "@/schematic/builder"
import { lab1Stand, nucleoBlink } from "@/schematic/examples"
import { partKey, type Schematic } from "@/schematic/types"
import { SimLoop, type McuStatus } from "@/sim/loop"
import type { Stm32 } from "@/mcu/stm32f429"
import { exampleBase64, hal } from "../lib/firmware"

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
const problems = (st: McuStatus) => st.clock.problems.join("; ")

function lab1WithoutCrystal() {
  const doc = lab1Stand.build(GRID)
  const dd = doc.objects.find((o) => o.def === "stm32f746ig")!
  dd.props = { ...dd.props, firmware: "lab1-f746.elf", firmwareData: exampleBase64("lab1-f746.elf") }
  const zq = doc.objects.find((o) => o.def === "crystal")!
  doc.objects = doc.objects.filter((o) => o !== zq)
  doc.wires = doc.wires.filter((w) => w.from.object !== zq.id && w.to.object !== zq.id)
  return { doc, dd }
}

describe("clock sources", () => {
  it("lab 1 stand starts its 8 MHz crystal on PH0/PH1", () => {
    const doc = lab1Stand.build(GRID)
    const dd = doc.objects.find((o) => o.def === "stm32f746ig")!
    dd.props = { ...dd.props, firmware: "lab1-f746.elf", firmwareData: exampleBase64("lab1-f746.elf") }
    const { core, run, status } = start(doc, dd.id)
    // HSEON and HSERDY as the firmware sees them, sampled every 100 µs of the loop.
    let onAt = -1
    let readyAt = -1
    run(0.02, 1e-4, (_, t) => {
      const cr = core.rcc.get("CR")
      if (onAt < 0 && cr & (1 << 16)) onAt = t
      if (readyAt < 0 && cr & (1 << 17)) readyAt = t
    })
    expect.soft(onAt * 1e3, "firmware switched HSE on (ms)").toBeNear(0.4, 0.5)
    expect.soft((readyAt - onAt) * 1e3, "crystal start-up: HSERDY 2 ms later (ms)").toBeNear(2, 0.15)
    expect.soft(label(status()), "clock tree").toBe("PLL←HSE 50 MHz, HSE 8 MHz crystal")
    expect.soft(problems(status()), "no clock problem").toBe("")
    expect.soft(status().running, "running").toBe(true)
  })

  it("lab 1 stand without the crystal ends in Error_Handler", () => {
    const { doc, dd } = lab1WithoutCrystal()
    const { loop, run, status, inFunction } = start(doc, dd.id)
    run(0.05)
    expect.soft(problems(status()), "the inspector says why").toBe("HSE on: no crystal on OSC_IN/OSC_OUT")
    expect.soft(label(status()), "still on HSI").toBe("HSI 16 MHz, HSE none")
    run(0.2)
    expect.soft(inFunction("Error_Handler"), `HAL timed out into Error_Handler, pc 0x${status().pc.toString(16)}`).toBe(true)
    const vd1 = doc.objects.find((o) => o.props?.ref === "VD1")!
    expect.soft(loop.snapshot()!.parts[partKey(vd1.id, "LED")]?.on ?? false, "L1 never lit").toBeFalsy()
  })

  it("lab 1 stand with an oscillator module instead (firmware wants a crystal)", () => {
    const { doc, dd } = lab1WithoutCrystal()
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
    expect.soft(problems(status()), "the inspector says why").toBe("HSE in crystal mode, but OSC_IN carries an external clock (needs HSEBYP)")
    expect.soft(label(status()), "HSE seen but unusable").toBe("HSI 16 MHz, HSE 8 MHz clock")
  })

  describe("bare STM32F429 on an oscillator module, Nucleo blink firmware (HSE bypass)", () => {
    const build = (vccWired: boolean) => {
      const { doc, place, wire } = builder(GRID)
      const dd = place("stm32f429zi", 0, 0, { firmware: "nucleo-blink.elf", firmwareData: exampleBase64("nucleo-blink.elf") })
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

    it("runs from the powered module", () => {
      const powered = build(true)
      const a = start(powered.doc, powered.dd.id)
      a.run(0.05)
      expect.soft(label(a.status()), "clock tree").toBe("PLL←HSE 180 MHz, HSE 8 MHz clock")
      expect.soft(problems(a.status()), "no clock problem").toBe("")
      let lit = false
      a.run(0.6, 0.03, () => {
        lit ||= a.loop.snapshot()!.parts[partKey(powered.led.id, "LED")]?.on ?? false
      })
      expect.soft(lit, "LD1 blinks").toBe(true)
    })

    it("has no clock from the module without VCC", () => {
      const dead = build(false)
      const b = start(dead.doc, dead.dd.id)
      b.run(0.05)
      expect.soft(problems(b.status()), "module without VCC: no clock").toBe("HSE bypass on: no external clock on OSC_IN")
      expect.soft(label(b.status()), "core stays on HSI").toBe("HSI 16 MHz, HSE none")
      b.run(0.2)
      expect.soft(b.status().halted?.replace(/at 0x[0-9a-f]+/, "") ?? "running", "blink's Error_Handler (bkpt 0xEE)").toBe("bkpt : bkpt #238")
    })
  })

  it("Nucleo-144: the X2 32.768 kHz crystal takes 2 s to start (wdg firmware sets up LSE → RTC at every boot)", () => {
    const doc = nucleoBlink.build(GRID)
    const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
    u.props = { ...u.props, firmware: "wdg.elf", firmwareData: hal("wdg.elf").toString("base64") }
    const { core, run, status } = start(doc, u.id)
    let onAt = -1
    let readyAt = -1
    run(3.2, 0.005, (_, t) => {
      const bdcr = core.rcc.get("BDCR")
      if (onAt < 0 && bdcr & 1) onAt = t
      if (readyAt < 0 && bdcr & 2) readyAt = t
    })
    expect.soft(onAt, "LSE switched on at boot (s)").toBeNear(0.005, 0.01)
    expect.soft(readyAt - onAt, "LSERDY 2 s later (s)").toBeNear(2, 0.02)
    const lse = status().clock.lse
    expect.soft(lse ? `${lse.hz} Hz ${lse.kind}` : "none", "LSE source").toBe("32768 Hz crystal")
    expect.soft(problems(status()), "no clock problem once it runs").toBe("")
    expect.soft(core.rcc.rtcHz(), "RTC clocked from LSE").toBe(32768)
  })
})
