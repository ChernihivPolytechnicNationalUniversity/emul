import { beforeAll, describe, expect, it } from "vitest"
import { WiredCore } from "../lib/wired-core"

const TICK = 1 / 16e6
const US = 1e-6
const ONE_SHOT = { delay: 160 * TICK, end: 800 * TICK }

describe("STM32F746 timers as slaves", () => {
  const core = new WiredCore("timers-slave.elf", { watch: ["PH9"] })
  const cnt = (tim: string) => core.timer(tim).read("CNT")
  beforeAll(() => {
    core.until(() => core.word("slave_bench") === 1, 0.01)
  })

  it("chains TIM3's update events into TIM4's clock (ITR2, external clock mode 1): one 32-bit counter from two 16-bit ones", () => {
    const total = () => cnt("TIM4") * 65536 + cnt("TIM3")
    const before = total()
    core.run(0.01)
    const after = total()
    expect(after - before).toBeNear(0.01 / TICK, 2)
    expect(cnt("TIM4"), "TIM4 counts TIM3's wraps, not the clock").toBe(Math.floor(after / 65536))
    expect(cnt("TIM4")).toBeGreaterThanOrEqual(2)
  })

  it("starts TIM5 in trigger mode on TIM2's counter enable (TRGO = CNT_EN, ITR0): both count in step", () => {
    expect(core.timer("TIM5").read("CR1") & 1, "CEN set by the trigger").toBe(1)
    expect(cnt("TIM5")).toBe(cnt("TIM2"))
  })

  it("counts TIM1 only while PE9 (TI1FP1) is high in gated mode, flagging TIF at every start and stop", () => {
    const start = cnt("TIM1")
    const at = core.time + 100 * US
    core.drive("PE9", true, at)
    core.drive("PE9", false, at + 1000 * US)
    core.drive("PE9", true, at + 2000 * US)
    core.drive("PE9", false, at + 2250 * US)
    core.runUntil(at + 3000 * US)
    expect(cnt("TIM1") - start).toBeNear(1250 * US / TICK, 1)
    expect(core.word("slave_bench", 1), "trigger interrupts").toBe(4)
  })

  it("counts TIM8 on ETR (PI3) falling edges, divided by 4 (external clock mode 2, ETP, ETPS)", () => {
    const at = core.time + 10 * US
    core.drive("PI3", true, at)
    for (let i = 0; i < 400; i++) {
      core.drive("PI3", false, at + 20 * US + i * 2 * US)
      core.drive("PI3", true, at + 21 * US + i * 2 * US)
    }
    core.runUntil(at + 900 * US)
    expect(cnt("TIM8")).toBe(100)
  })

  it("counts TIM9 on TI2FP2 falling edges (PE6, CC2P) in external clock mode 1", () => {
    const at = core.time + 10 * US
    core.drive("PE6", true, at)
    for (let i = 0; i < 37; i++) {
      core.drive("PE6", false, at + 10 * US + i * 4 * US)
      core.drive("PE6", true, at + 12 * US + i * 4 * US)
    }
    core.runUntil(at + 200 * US)
    expect(cnt("TIM9")).toBe(37)
  })

  it("restarts TIM12's one-pulse on every PH6 rising edge (F7 combined reset + trigger mode): PH9 high 10…50 µs after the last edge", () => {
    const edges = core.edges("PH9")
    edges.length = 0
    const first = core.time + 20 * US
    core.drive("PH6", true, first)
    core.drive("PH6", false, first + 5 * US)
    const second = first + 100 * US
    core.drive("PH6", true, second)
    core.drive("PH6", false, second + 5 * US)
    const third = second + 30 * US
    core.drive("PH6", true, third)
    core.drive("PH6", false, third + 5 * US)
    core.runUntil(third + 200 * US)
    const want = [
      { time: first + ONE_SHOT.delay, level: true },
      { time: first + ONE_SHOT.end, level: false },
      { time: second + ONE_SHOT.delay, level: true },
      { time: third, level: false },
      { time: third + ONE_SHOT.delay, level: true },
      { time: third + ONE_SHOT.end, level: false },
    ]
    expect(edges.map((e) => e.level)).toEqual(want.map((e) => e.level))
    edges.forEach((e, i) => expect.soft(e.time, `edge ${i}`).toBeNear(want[i].time, TICK))
    expect(core.timer("TIM12").read("CR1") & 1, "stopped by OPM after the pulse").toBe(0)
  })
})
