import { beforeAll, describe, expect, it } from "vitest"
import { WiredCore } from "../lib/wired-core"

const TICKS_PER_MS = 16000

describe("STM32F746 timers as masters", () => {
  const core = new WiredCore("timers-master.elf")
  const cnt = (tim: string) => core.timer(tim).read("CNT")
  const events = new Map<string, number>()
  const tim8 = core.timer("TIM8").tim
  const forward = tim8.onEvent
  tim8.onEvent = (event) => {
    events.set(event, (events.get(event) ?? 0) + 1)
    forward(event)
  }

  const overOneMillisecond = (read: () => number) => {
    const before = read()
    core.run(1e-3)
    return read() - before
  }

  beforeAll(() => {
    core.until(() => core.word("master_bench") === 1, 0.01)
  })

  it("puts each EGR.UG on TRGO (MMS = reset): TIM3 counts TIM2's five software updates through ITR1", () => {
    expect(cnt("TIM3")).toBe(5)
  })

  it("puts each update on TRGO (MMS = update): TIM12 counts TIM4's 100-tick periods through ITR0", () => {
    expect(overOneMillisecond(() => cnt("TIM12"))).toBe(TICKS_PER_MS / 100)
  })

  it("puts a pulse on TRGO at each CC1 compare (MMS = compare pulse): TIM1 counts TIM5's 400-tick periods through ITR0", () => {
    expect(overOneMillisecond(() => cnt("TIM1"))).toBe(TICKS_PER_MS / 400)
  })

  it("gates TIM9 with TIM10's OC1REF (ITR2 = TIM10_OC): it counts the 25 % of the time the PWM is high", () => {
    expect(overOneMillisecond(() => cnt("TIM9"))).toBe(TICKS_PER_MS / 4)
  })

  it("gives the ADC and DAC triggers one TRGO rising edge per period from OC2REF and two TRGO2 pulses from OC4REF's edges (MMS2 = 1010)", () => {
    events.clear()
    core.run(1e-3)
    expect(events.get("TRGO")).toBe(TICKS_PER_MS / 1000)
    expect(events.get("TRGO2")).toBe((2 * TICKS_PER_MS) / 1000)
  })

  it("reports what it does not model in the inspector: DMA burst, OCxM ≥ 8, the TIM2 ITR1 remap", () => {
    expect([...core.mcu.unmodelled.features.keys()]).toEqual(
      expect.arrayContaining(["TIM13 DMA burst (DCR/DMAR)", "TIM13 retriggerable one-pulse, combined or asymmetric PWM (OCxM ≥ 8)", "TIM2 input remap (OR)"]),
    )
  })
})
