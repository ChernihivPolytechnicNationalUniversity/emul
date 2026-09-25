/**
 * The first lab's firmware (STM32CubeIDE project for the STM32F746IGT6 teaching stand) on the
 * F746 profile: the LEDs L1..L4 (PB6, PB7, PH4, PI8) light up and go out in the 1/2/3/4-second
 * staircase main.c describes, at 50 MHz from the 8 MHz crystal.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { STM32F746IG } from "@/mcu/chip"
import { Stm32, parsePad } from "@/mcu/stm32f429"
import { buffer, example } from "../lib/firmware"

const LEDS = { L1: parsePad("PB6")!, L2: parsePad("PB7")!, L3: parsePad("PH4")!, L4: parsePad("PI8")! }

describe("lab 1 on the bare F746", () => {
  const mcu = new Stm32(STM32F746IG)
  mcu.load(buffer(example("lab1-f746.elf")), "lab1-f746.elf")

  describe("at the first HAL_Delay", () => {
    beforeAll(() => {
      const halDelay = mcu.firmware!.symbols.find((s) => s.name === "HAL_Delay")!.value & ~1
      mcu.cpu.breakpoints.add(halDelay)
      mcu.run(0.01)
    })

    it("stops at the breakpoint about 0.6 ms after reset", () => {
      expect(mcu.cpu.halted?.reason ?? "running").toBe("bkpt")
      // The coarse 20k-cycle time slices around the HSI→PLL switch blur it by up to a slice.
      expect(mcu.time * 1e3).toBeNear(0.6, 1)
    })

    it("runs from the PLL at 50 MHz", () => {
      expect(mcu.clocks.sysclk, "SYSCLK = 8 MHz / 4 × 50 / 2").toBe(50e6)
      expect(mcu.flash.get("ACR") & 0xf, "flash latency").toBe(1)
      expect((mcu.pwr.get("CR1") >>> 14) & 3, "regulator scale 3").toBe(1)
      expect((mcu.pwr.get("CR1") >>> 16) & 3, "over-drive switched").toBe(3)
      expect(mcu.cpu.scs.systRvr + 1, "SysTick 1 kHz").toBe(50000)
    })

    it("has the MPU background region CubeMX generates", () => {
      expect(mcu.cpu.scs.mpuCtrl & 1).toBe(1)
      // XN, no access, shareable, SRD 0x87, 4 GB, enabled.
      expect(mcu.cpu.scs.mpuRasr[0] >>> 0).toBe(0x1004873f)
      expect(mcu.cpu.scs.mpuRbar[0] >>> 0).toBe(0)
    })

    it("has only L1 on after MX_GPIO_Init and the first write", () => {
      const drives = Object.fromEntries(Object.entries(LEDS).map(([n, pad]) => [n, mcu.padDrive(pad) ?? "float"]))
      expect(drives).toEqual({ L1: "high", L2: "low", L3: "low", L4: "low" })
    })

    it("pulls the joystick up", () => {
      for (const p of ["PG2", "PG3", "PD4", "PD5", "PI11"]) expect(mcu.padDrive(parsePad(p)!) ?? "float", p).toBe("pullup")
    })
  })

  describe("over 22 s from reset", () => {
    const edges: Record<string, { t: number; level: unknown }[]> = {}

    beforeAll(() => {
      mcu.cpu.breakpoints.clear()
      mcu.cpu.halted = null
      mcu.reset()
      const last: Record<string, unknown> = {}
      for (const [n, pad] of Object.entries(LEDS)) {
        edges[n] = []
        last[n] = mcu.padDrive(pad) ?? "float"
      }
      while (mcu.time < 22 && mcu.running) {
        if (!mcu.run(1e-4)) break
        for (const [name, pad] of Object.entries(LEDS)) {
          const d = mcu.padDrive(pad) ?? "float"
          if (d !== last[name]) edges[name].push({ t: mcu.time, level: d })
          last[name] = d
        }
      }
    })

    it("keeps the core running", () => {
      expect(mcu.cpu.halted?.message).toBeUndefined()
      expect(mcu.running).toBe(true)
    })

    // L1 on, +1 s L2 on, +2 s L3 on, +3 s L4 on, +4 s L1 off, +1 s L2 off, +2 s L3 off, +3 s L4 off,
    // +4 s and around again. HAL_Delay(n) waits n+1 SysTick ticks, so every step runs 1 ms long and
    // the cycle is 20.008 s; the main loop starts ~0.6 ms after reset.
    const onAt = { L1: 0, L2: 1.001, L3: 3.002, L4: 6.003 }
    const offAt = { L1: 10.004, L2: 11.005, L3: 13.006, L4: 16.007 }
    const T_MAIN = 0.0006
    const TOL = 0.0005

    it.each(Object.keys(LEDS) as (keyof typeof onAt)[])("steps %s through the staircase", (n) => {
      const highs = edges[n].filter((x) => x.level === "high").map((x) => x.t)
      const lows = edges[n].filter((x) => x.level === "low").map((x) => x.t)
      expect.soft(highs[0] ?? NaN, "on at").toBeNear(T_MAIN + onAt[n], TOL)
      expect.soft(lows.find((t) => t > (highs[0] ?? 0)) ?? NaN, "off at").toBeNear(T_MAIN + offAt[n], TOL)
      if (onAt[n] + 20.008 < 22) expect.soft(highs[1] ?? NaN, "on again at").toBeNear(T_MAIN + onAt[n] + 20.008, TOL)
    })
  })
})
