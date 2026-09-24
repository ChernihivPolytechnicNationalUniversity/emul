/**
 * The HAL blink firmware on the STM32F429 model, checked the way a scope on the pads would see
 * it: LD1 (PB0) at 1 Hz from HAL_Delay, LD2 (PB7) at 5 Hz from the SysTick callback, LD3 (PB14)
 * toggling on USER button presses through EXTI, and the core at 180 MHz.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"
import { buffer, hal } from "../lib/firmware"

const PB0 = parsePad("PB0")!
const PB7 = parsePad("PB7")!
const PB14 = parsePad("PB14")!
const PA5 = parsePad("PA5")!
const PC13 = parsePad("PC13")!

describe("HAL blink on the F429", () => {
  const mcu = new Stm32F429()
  mcu.load(buffer(hal("blink.elf")), "blink.elf")

  function record(seconds: number, step = 50e-6, press: ((t: number) => void) | null = null) {
    const edges: Record<string, number[]> = { PB0: [], PB7: [], PB14: [], PA5: [] }
    const last: Record<string, ReturnType<typeof mcu.padDrive>> = { PB0: null, PB7: null, PB14: null, PA5: null }
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

  describe("after boot", () => {
    beforeAll(() => {
      mcu.run(0.01)
    })

    it("runs at 180 MHz from SystemClock_Config", () => {
      expect.soft(mcu.clocks.sysclk, "SYSCLK").toBe(180e6)
      expect.soft(mcu.clocks.pclk1, "PCLK1").toBe(45e6)
      expect.soft(mcu.clocks.pclk2, "PCLK2").toBe(90e6)
      expect.soft(mcu.cpu.scs.systRvr + 1, "SysTick reload (1 kHz at HCLK)").toBe(180000)
      expect.soft(mcu.flash.get("ACR") & 0xf, "flash latency").toBe(5)
      expect.soft((mcu.pwr.get("CR") >>> 16) & 3, "over-drive switched").toBe(3)
    })

    it("keeps the core running", () => {
      expect(mcu.cpu.halted?.message).toBeUndefined()
      expect(mcu.running).toBe(true)
    })
  })

  describe("blinking for 3 s", () => {
    let e: Record<string, number[]>
    beforeAll(() => {
      e = record(3)
    })

    it("toggles LD1 (PB0) every 501 ms", () => {
      // HAL_Delay(n) waits n + 1 ticks, so the 500 ms toggle really is 501 ms.
      expect(period(e.PB0)).toBeNearRel(1.002, 0.001)
    })

    it("has D13 (PA5) follow LD1", () => {
      expect(e.PA5.length).toBe(e.PB0.length)
    })

    it("toggles LD2 (PB7) at 5 Hz", () => {
      expect(period(e.PB7)).toBeNearRel(0.2, 0.002)
    })

    it("leaves LD3 (PB14) quiet without presses", () => {
      expect(e.PB14.length).toBe(0)
    })

    it("drives PB0 push-pull", () => {
      expect(e.PB0.length).toBeGreaterThan(0)
      expect(["high", "low"]).toContain(mcu.padDrive(PB0) ?? "")
    })
  })

  describe("USER button (PC13 → EXTI15_10 → LD3)", () => {
    let e2: Record<string, number[]>
    beforeAll(() => {
      let pressed = false
      e2 = record(0.5, 50e-6, (t) => {
        // Press at 100 ms and 300 ms, release 50 ms later.
        const down = (t > 0.1 && t < 0.15) || (t > 0.3 && t < 0.35)
        if (down !== pressed) {
          pressed = down
          mcu.setPad(PC13, down)
        }
      })
    })

    it("counts two presses", () => {
      const sym = mcu.firmware!.symbols.find((s) => s.name === "button_presses")
      expect(sym ? mcu.bus.read32(sym.value) : -1).toBe(2)
    })

    it("toggles LD3 once per press", () => {
      expect(e2.PB14.length).toBe(2)
    })

    it("clears the EXTI pending bits", () => {
      expect(mcu.exti.get("PR")).toBe(0)
    })
  })
})
