/**
 * Watchdog and RTC: firmware/hal/Src/wdg.c on the F429 model through its three lives — an IWDG
 * timeout reset, a WWDG window-violation reset, then the RTC calendar, alarm and wake-up timer
 * under interrupt — with the backup registers carrying the story across the resets.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { Stm32F429 } from "@/mcu/stm32f429"
import { buffer, hal } from "../lib/firmware"

describe("watchdogs and RTC on the F429", () => {
  const mcu = new Stm32F429()
  mcu.load(buffer(hal("wdg.elf")), "wdg.elf")
  const sym = (name: string) => mcu.firmware!.symbols.find((s) => s.name === name)!.value
  const word = (name: string) => mcu.bus.read32(sym(name))
  const bkp = (n: number) => mcu.rtc.get(`BKP${n}R`)

  const resets: { cause: string; at: number; refreshes: number; ewi: number }[] = []
  const origReset = mcu.reset.bind(mcu)
  mcu.reset = (cause = "por") => {
    resets.push({ cause, at: mcu.time, refreshes: word("refreshes"), ewi: word("ewi") })
    origReset(cause)
  }
  function run(seconds: number) {
    const end = mcu.time + seconds
    while (mcu.time < end && mcu.running) if (!mcu.run(1e-3)) break
  }

  describe("life 0: IWDG", () => {
    it("refreshes 15 times without a reset", () => {
      run(0.35)
      expect(mcu.cpu.halted?.message, "core running").toBeUndefined()
      expect(mcu.running).toBe(true)
      expect.soft((bkp(1) >>> 27) & 1, "life 0 saw a power-on reset (CSR POR flag)").toBe(1)
      expect.soft(word("refreshes"), "15 refreshes done").toBe(15)
      expect.soft(resets.length, "no reset while refreshing").toBe(0)
    })

    it("resets ~100 ms after the last refresh", () => {
      run(0.2)
      expect(resets[0]?.cause ?? "none").toBe("iwdg")
      // 15 × HAL_Delay(20) (21 ms each, HAL adds a tick) + 100 ms of timeout.
      expect(resets[0].at * 1e3).toBeNear(15 * 21 + 100, 6)
    })
  })

  describe("life 1: WWDG", () => {
    it("carries the story in the backup registers", () => {
      run(0.05)
      expect.soft(bkp(0), "life counter carried in BKP0R").toBe(2)
      expect.soft((bkp(2) >>> 29) & 1, "IWDGRSTF seen by life 1").toBe(1)
      expect.soft((bkp(2) >>> 27) & 1, "POR flag cleared by then").toBe(0)
    })

    it("times out after ten in-window refreshes", () => {
      run(0.4)
      expect(resets[1]?.cause ?? "none", "WWDG timeout reset").toBe("wwdg")
      expect.soft(resets[1].refreshes, "ten in-window refreshes before it").toBe(10)
      expect.soft(resets[1].ewi, "early wake-up interrupt fired at 0x40").toBe(1)
      // 10 × 36 ms of refreshes, then 0x7F → 0x3F is 64 ticks of 0.728 ms.
      expect.soft((resets[1].at - resets[0].at) * 1e3, "WWDG reset time after life 1 began (ms)").toBeNear(10 * 36 + 64 * 0.728, 4)
    })
  })

  describe("life 2: RTC on LSE", () => {
    let rtcAt: { sim: number; time: number; sub: number }

    beforeAll(() => {
      run(0.1)
      rtcAt = { sim: mcu.time, time: word("rtcTime"), sub: word("rtcSub") }
    })

    it("sets the calendar", () => {
      expect.soft((bkp(3) >>> 30) & 1, "WWDGRSTF seen by life 2").toBe(1)
      expect.soft(word("errors"), "no HAL errors").toBe(0)
      expect.soft(word("rtcTime"), "time set").toBe(123456)
      expect.soft(word("rtcDate"), "date set (2026-09-16)").toBe(260916)
    })

    it("counts one RTC second per simulated second", () => {
      run(1.0)
      expect.soft(word("rtcTime") - rtcAt.time).toBe(1)
      // The firmware samples every 10 ms (2.5 ticks of 1/256 s), so compare modulo 256 with slack.
      const seen = (rtcAt.sub - word("rtcSub") + 256) % 256
      const want = Math.round(((mcu.time - rtcAt.sim) % 1) * 256) % 256
      const dist = Math.min((seen - want + 256) % 256, (want - seen + 256) % 256)
      expect.soft(dist, "subseconds count 256 per second (ticks off)").toBeNear(0, 3)
    })

    it("fires the alarm and the wake-ups", () => {
      run(1.2)
      expect.soft(word("alarms"), "alarm A fired at 12:34:58").toBe(1)
      expect.soft(word("wakeups"), "wake-ups every 0.5 s").toBeNear(Math.floor((mcu.time - resets[1].at - 0.02) / 0.5), 1)
      expect.soft(bkp(0), "RTC registers survived the resets (BKP0R = 3)").toBe(3)
    })
  })

  describe("life 2 ends with a window violation", () => {
    beforeAll(() => run(0.4))

    it("resets on a refresh above the window", () => {
      expect(resets[2]?.cause ?? "none").toBe("wwdg")
      expect(bkp(0), "life 3 started").toBe(4)
    })

    it("clears the RAM copy but keeps the RTC counting in the backup domain", () => {
      expect.soft(word("rtcTime")).toBe(0)
      expect.soft(mcu.rtc.read(0, 4).toString(16), "TR").toBe("123458")
    })

    it("touches nothing unmodelled", () => {
      expect(mcu.unmodelled.summary()).toEqual([])
    })
  })
})
