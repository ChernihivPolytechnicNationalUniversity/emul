/**
 * Low power: firmware/hal/Src/lowpower.c on the F429 model with a "current probe" on the supply —
 * the mode and current estimate sampled every 50 µs — through Sleep, four Stops (RTC wake-up, EXTI
 * interrupt, EXTI event, under-drive) and two Standbys (RTC and the WKUP pin), then sleep-on-exit.
 */
import { describe, expect, it } from "vitest"
import { Stm32F429, parsePad, type PowerMode } from "@/mcu/stm32f429"
import { buffer, hal } from "../lib/firmware"

describe("low-power modes on the F429", () => {
  const mcu = new Stm32F429()
  mcu.load(buffer(hal("lowpower.elf")), "lowpower.elf")
  const B1 = parsePad("PC13")!
  const WKUP = parsePad("PA0")!
  const sym = (name: string) => mcu.firmware!.symbols.find((s) => s.name === name)!.value
  const word = (name: string) => mcu.bus.read32(sym(name))

  type Sample = { t: number; mode: PowerMode; amps: number; hz: number }
  const trace: Sample[] = []
  const resets: { cause: string; at: number; vars: Record<string, number> }[] = []
  const origReset = mcu.reset.bind(mcu)
  mcu.reset = (cause = "por") => {
    const vars: Record<string, number> = {}
    for (const v of ["sbf", "wuf", "sleeps", "stopTicks", "stopSws", "stopHse", "stopElapsed", "reclocked", "wakes", "errors", "rtcTime"]) vars[v] = word(v)
    resets.push({ cause, at: mcu.time, vars })
    origReset(cause)
  }
  const sample = () => trace.push({ t: mcu.time, mode: mcu.powerMode, amps: mcu.supplyCurrent(), hz: mcu.clocks.sysclk })
  function run(seconds: number, step = 50e-6) {
    const end = mcu.time + seconds
    while (mcu.time < end && mcu.running) {
      if (!mcu.run(Math.min(step, end - mcu.time))) break
      sample()
    }
  }
  function runUntilMode(mode: PowerMode, limit: number, step = 50e-6): number {
    const end = mcu.time + limit
    while (mcu.time < end && mcu.running && mcu.powerMode !== mode) {
      if (!mcu.run(Math.min(step, end - mcu.time))) break
      sample()
    }
    return mcu.time
  }
  const enteredAt = (mode: PowerMode, after: number) => trace.find((x) => x.t > after && x.mode === mode)?.t ?? NaN
  const mA = (amps: number) => amps * 1e3
  const average = (from: number, to: number) => {
    const s = trace.filter((x) => x.t > from + 60e-6 && x.t <= to)
    return s.reduce((a, x) => a + x.amps, 0) / s.length
  }
  const share = (from: number, to: number, mode: PowerMode) => {
    const s = trace.filter((x) => x.t > from && x.t <= to)
    return s.filter((x) => x.mode === mode).length / s.length
  }

  let sleepFrom = 0
  let wake1 = 0
  let wake2 = 0
  let wake3 = 0
  let wake4 = 0
  let standby1 = 0

  it("life 0: sleeps between SysTicks", () => {
    run(0.03)
    expect(mcu.cpu.halted?.message).toBeUndefined()
    expect(mcu.running).toBe(true)
    sleepFrom = mcu.time
    run(0.15)
    expect.soft(share(sleepFrom, mcu.time, "sleep"), "asleep at every sample (share)").toBeNear(1, 0.03)
    expect.soft(mA(average(sleepFrom, mcu.time)), "supply ≈ Sleep current at 180 MHz (mA)").toBeNear(39, 3)
    expect.soft(word("errors"), "no HAL errors").toBe(0)
  })

  it("stop 1: RTC wake-up timer, low-power regulator", () => {
    runUntilMode("stop", 0.1)
    const stop1 = enteredAt("stop", sleepFrom)
    expect.soft(stop1 * 1e3, "entered Stop after ~200 ms of Sleep").toBeNear(205, 6)
    expect.soft(word("sleeps"), "~200 wake-ups by SysTick").toBeNear(200, 3)
    run(0.01)
    expect.soft(mA(average(stop1, mcu.time)), "supply in Stop, low-power regulator (mA)").toBeNear(0.55, 0.01)
    wake1 = runUntilMode("run", 0.5)
    expect.soft((wake1 - stop1) * 1e3, "woke 300 ms + 21 µs later (ms)").toBeNear(300.02, 0.15)
    run(0.005)
    expect.soft(word("stopTicks"), "HAL tick stood still in Stop").toBeNear(0, 1)
    expect.soft(word("stopElapsed"), "RTC saw the 300 ms (ms)").toBeNear(300, 5)
    expect.soft(word("stopSws"), "woke on HSI (CFGR.SWS)").toBe(0)
    expect.soft(word("stopHse"), "HSE switched off by hardware").toBe(0)
    expect.soft(word("reclocked"), "clock re-configured onto the PLL (CFGR.SWS)").toBe(8)
    const stop2 = enteredAt("stop", wake1)
    expect.soft((stop2 - wake1) * 1e6, "back in Stop within 200 µs of waking (µs)").toBeNear(100, 100)
  })

  it("stop 2: EXTI13 interrupt from the user button", () => {
    expect.soft(mA(mcu.supplyCurrent()), "in Stop, main regulator (mA)").toBeNear(1.2, 0.01)
    run(0.1)
    expect.soft(mcu.powerMode, "still in Stop after 100 ms").toBe("stop")
    mcu.setPad(B1, true)
    const edge2 = mcu.time
    wake2 = runUntilMode("run", 0.01, 5e-6)
    expect.soft((wake2 - edge2) * 1e6, "woke ~13 µs after the edge (µs)").toBeNear(13, 3)
    run(0.005)
    expect.soft(word("wakes"), "EXTI callback ran").toBe(1)
    mcu.setPad(B1, false)
  })

  it("stop 3: EXTI13 event with WFE", () => {
    const stop3 = enteredAt("stop", wake2)
    expect.soft((stop3 - wake2) * 1e3, "entered Stop within 5 ms of the wake-up").toBeLessThan(5)
    run(0.05)
    expect.soft(mcu.powerMode).toBe("stop")
    mcu.setPad(B1, true)
    const edge3 = mcu.time
    wake3 = runUntilMode("run", 0.01, 5e-6)
    expect.soft((wake3 - edge3) * 1e6, "woke on the event (µs after the edge)").toBeNear(13, 3)
    run(0.005)
    expect.soft(word("wakes"), "no interrupt this time").toBe(1)
    mcu.setPad(B1, false)
  })

  it("stop 4: under-drive, RTC after 200 ms", () => {
    const stop4 = enteredAt("stop", wake3)
    run(0.01)
    expect.soft(mA(average(stop4, mcu.time)), "supply in under-drive Stop (mA)").toBeNear(0.13, 0.01)
    wake4 = runUntilMode("run", 0.5)
    expect.soft((wake4 - stop4) * 1e3, "woke 200 ms + 110 µs later (ms)").toBeNear(200.11, 0.15)
  })

  it("standby 1: RTC wake-up after 0.5 s", () => {
    runUntilMode("standby", 0.05)
    standby1 = enteredAt("standby", wake4)
    run(0.01)
    expect.soft(average(standby1, mcu.time) * 1e6, "supply in Standby (µA)").toBeNear(3, 0.1)
    run(0.6)
    expect(resets[0]?.cause ?? "none", "reset out of Standby").toBe("standby")
    expect.soft((resets[0].at - standby1) * 1e3, "after 0.5 s (ms)").toBeNear(500, 2)
    expect.soft(resets[0].vars.sbf, "life 0 had no SBF").toBe(0)
    expect.soft(resets[0].vars.errors, "no HAL errors in life 0").toBe(0)
  })

  it("life 1: Standby until the WKUP pin", () => {
    run(0.02)
    expect.soft(`${word("sbf")}${word("wuf")}`, "SBF set, WUF clear").toBe("10")
    expect.soft(word("rtcTime"), "RTC kept running through Standby (12:34:57)").toBeNear(123457, 1)
    expect.soft(`${mcu.resets} by ${mcu.lastReset}`, "resets counted").toBe("1 by standby")
    runUntilMode("standby", 0.05)
    run(0.1)
    expect.soft(mcu.powerMode).toBe("standby")
    mcu.setPad(WKUP, true)
    const edgeW = mcu.time
    run(0.002)
    expect(resets[1]?.cause ?? "none", "WKUP rising edge → reset").toBe("standby")
    expect.soft((resets[1].at - edgeW) * 1e6, "promptly (µs)").toBeNear(300, 60)
  })

  it("life 2: sleep-on-exit, then idle", () => {
    run(0.02)
    expect.soft(`${word("sbf")}${word("wuf")}`, "SBF and WUF set").toBe("11")
    run(0.06)
    expect.soft(word("soeTicks"), "sleep-on-exit held for 50 SysTicks").toBe(50)
    expect.soft(mcu.padDrive(parsePad("PB0")!), "LD1 on afterwards").toBe("high")
    expect.soft(mcu.powerMode, "core idles in Sleep").toBe("sleep")
    expect.soft(mcu.unmodelled.summary(), "no unmodelled features").toEqual([])
  })

  it("keeps the backup domain and counts the hour on the LSE with VDD off and VBAT up", () => {
    const before = word("rtcTime")
    mcu.runOnBattery(3600)
    origReset("por", { backup: true })
    run(0.03)
    expect.soft(word("life"), "life counter kept in BKP0R (life 3)").toBe(3)
    expect.soft(word("rtcTime"), "RTC an hour on (hhmmss)").toBeNear(before + 10000, 2)
    expect.soft((mcu.rcc.get("CSR") >>> 27) & 1, "POR flagged in RCC CSR").toBe(1)
  })

  it("clears it all on a plain power-on with VDD and VBAT both off", () => {
    origReset("por")
    run(0.03)
    expect.soft(word("life"), "life 0 again").toBe(0)
    expect.soft(mcu.bus.read32(0x40002800).toString(16), "RTC set afresh by life 0 (TR = 0x123456)").toBe("123456")
  })
})
