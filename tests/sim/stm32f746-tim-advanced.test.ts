import { beforeAll, describe, expect, it } from "vitest"
import { parsePad } from "@/mcu/stm32f429"
import { WiredCore, type Edge } from "../lib/wired-core"

const TICK = 1 / 16e6
const US = 1e-6
const PERIOD = 1600 * TICK
const HIGH = 400 * TICK
const DEAD_TIME = 32 * TICK
const BREAK_FILTER = 8 * TICK
const MOE = 1 << 15

describe("STM32F746 TIM1 dead time and break", () => {
  const core = new WiredCore("timers-advanced.elf", { watch: ["PE9", "PE8", "PE11"] })
  const bdtr = () => core.timer("TIM1").read("BDTR")
  const breaks = () => core.word("advanced_bench", 1)
  const after = (edges: Edge[], t: number, level: boolean) => edges.find((e) => e.time > t && e.level === level)!.time
  let firstUpdate = 0
  const nextUpdate = (from: number) => firstUpdate + Math.ceil((from - firstUpdate) / PERIOD) * PERIOD

  beforeAll(() => {
    core.until(() => core.word("advanced_bench") === 1, 0.01)
    core.run(10 * PERIOD)
    firstUpdate = core.edges("PE8").filter((e) => !e.level)[1].time
  })

  it("delays each output's rising edge by the dead time on CH1/CH1N (DTG = 32 → 2 µs at 16 MHz)", () => {
    const p = core.edges("PE9")
    const n = core.edges("PE8")
    const update = n.filter((e) => !e.level)[3].time
    expect(after(p, update, true) - update).toBeNear(DEAD_TIME, TICK / 10)
    expect(after(p, update, false) - update).toBeNear(HIGH, TICK / 10)
    expect(after(n, update + HIGH, true) - update).toBeNear(HIGH + DEAD_TIME, TICK / 10)
    expect(n.filter((e) => !e.level)[4].time - update).toBeNear(PERIOD, TICK / 10)
  })

  it("keeps the dead time locked: DTG written after LOCK level 1 reads back unchanged", () => {
    expect(core.word("advanced_bench", 2)).toBe(32)
    expect(bdtr() & 0xff).toBe(32)
  })

  it("drives CH2N to its inactive level with only CC2E set and OSSR = 1, and CH2 without dead time", () => {
    expect(core.mcu.padDrive(parsePad("PE10")!)).toBe("low")
    const e = core.edges("PE11")
    const rise = e.filter((x) => x.level)[2].time
    expect(after(e, rise, false) - rise).toBeNear(HIGH, TICK / 10)
  })

  it("ignores a BKIN pulse shorter than the filter (BKF: fCK_INT, N = 8)", () => {
    const at = core.time + 10 * US
    core.drive("PE15", true, at)
    core.drive("PE15", false, at + 5 * TICK)
    core.runUntil(at + 10 * US)
    expect(breaks()).toBe(0)
    expect(bdtr() & MOE).toBe(MOE)
  })

  it("on a break clears MOE, sets OC1 to its idle level OIS1 = 1 after the dead time and OC1N to OIS1N = 0, then AOE restores MOE at the next update", () => {
    const at = nextUpdate(core.time + 10 * US) + 50 * US
    core.drive("PE15", true, at)
    core.drive("PE15", false, at + 2 * US)
    core.runUntil(at + 10 * US)
    expect(breaks()).toBe(1)
    const hit = at + BREAK_FILTER
    expect(after(core.edges("PE8"), at, false)).toBeNear(hit, 1.5 * TICK)
    expect(after(core.edges("PE9"), at, true)).toBeNear(hit + DEAD_TIME, 1.5 * TICK)
    expect(bdtr() & MOE, "MOE cleared").toBe(0)
    const resumed = nextUpdate(at)
    core.runUntil(resumed + PERIOD / 2)
    expect(bdtr() & MOE, "set again by AOE").toBe(MOE)
    expect(after(core.edges("PE9"), resumed, false)).toBeNear(resumed + HIGH, TICK)
  })

  it("on BKIN2 holds both outputs at their inactive levels instead of the idle ones", () => {
    const at = nextUpdate(core.time + 10 * US) + 10 * US
    core.drive("PE6", true, at)
    core.runUntil(at + 20 * US)
    expect(breaks()).toBe(2)
    expect(core.mcu.padDrive(parsePad("PE9")!)).toBe("low")
    expect(core.mcu.padDrive(parsePad("PE8")!)).toBe("low")
    core.drive("PE6", false, core.time + 1 * US)
    core.run(2 * PERIOD)
    expect(bdtr() & MOE).toBe(MOE)
  })
})
