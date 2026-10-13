import { describe, expect, it } from "vitest"
import { WiredCore } from "../lib/wired-core"

const risingAfterStart = (edges: { time: number; level: boolean }[]) => edges.filter((e) => e.level).map((e) => e.time).slice(1)
const meanPeriod = (times: number[]) => (times[times.length - 1] - times[0]) / (times.length - 1)

describe("STM32F746 timer kernel clocks", () => {
  it("doubles PCLK for the timers when an APB prescaler is not 1: our lab 2 at 216 MHz, APB1 /4 and APB2 /2, puts TIM4 at 108 MHz and TIM1/TIM8 at 216 MHz", () => {
    const core = new WiredCore("lab2-variants.elf", { watch: ["PD12"] })
    core.until(() => core.word("lab2", 1) === 1, 0.05)
    expect(core.mcu.clocks).toMatchObject({ sysclk: 216e6, hclk: 216e6, pclk1: 54e6, timclk1: 108e6, pclk2: 108e6, timclk2: 216e6, source: "PLL" })
    core.run(0.05)
    expect(meanPeriod(risingAfterStart(core.edges("PD12"))), "TIM4: (17 + 1) × (59 999 + 1) / 108 MHz").toBeNearRel(0.01, 1e-9)
  })

  it("leaves them at PCLK with every prescaler at 1: the lecturer's PLLM 8, PLLN 100, PLLP 2 gives 50 MHz everywhere and TIM4 at 49.95 Hz", () => {
    const core = new WiredCore("lab2-f746.elf", { watch: ["PD12"] })
    core.run(0.15)
    expect(core.mcu.clocks).toMatchObject({ sysclk: 50e6, hclk: 50e6, pclk1: 50e6, timclk1: 50e6, pclk2: 50e6, timclk2: 50e6, source: "PLL" })
    expect(meanPeriod(risingAfterStart(core.edges("PD12"))), "(999 + 1) × (1000 + 1) / 50 MHz").toBeNearRel((1000 * 1001) / 50e6, 1e-9)
  })
})
