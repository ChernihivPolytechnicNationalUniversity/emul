/**
 * The "Nucleo timers and PWM" example co-simulated: LD1 dimmed by TIM3 reads as a steady
 * brightness that follows the duty, the external LED on D6 sees TIM1's 20 kHz PWM, and TIM4
 * measures LD1's PWM through the wire from D33 to D26.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoPwm } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

describe("Nucleo timers and PWM", () => {
  const doc = nucleoPwm.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const led = doc.objects.find((o) => o.def === "led")!
  u.props = { ...u.props, firmware: "nucleo-pwm.elf", firmwareData: exampleBase64("nucleo-pwm.elf") }

  const loop = new SimLoop()
  let clock = 0
  function run(seconds: number, sample?: (s: Snapshot) => void) {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
      if (sample) sample(loop.snapshot()!)
    }
  }
  const ld1 = () => loop.snapshot()!.parts[partKey(u.id, "LD1")]!.level
  const ext = () => loop.snapshot()!.parts[partKey(led.id, "LED")]!.level
  // LD1: 3.3 V through 510 Ω into a green LED ≈ 2.4 mA at 100 % → level 0.3; at 10 % duty a tenth of it.
  const full = (3.3 - 2.1) / 510 / 8e-3

  beforeAll(() => {
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    loop.advance(clock)
    run(0.06)
  })

  it("runs the core with nothing unmodelled", () => {
    const st = loop.snapshot()!.mcus[u.id]
    expect(st.halted).toBeFalsy()
    expect(st.running).toBe(true)
    expect(st.unmodelled.map((b) => b.block)).toEqual([])
  })

  it("dims LD1 to 10 % and the external LED to 30 %", () => {
    expect.soft(ld1(), "LD1").toBeNear(full * 0.1, 0.02)
    expect.soft(ext(), "external LED (TIM1, 330 Ω)").toBeNear(((3.3 - 2.1) / 330 / 8e-3) * 0.3, 0.03)
  })

  it("drives D6 rail to rail (a 20 kHz PWM)", () => {
    const d6 = loop.snapshot()!.pinVoltage[pinKey(u.id, "CN10-4")]
    expect(d6 < 0.3 || d6 > 3.0, `D6 at ${d6} V`).toBe(true)
  })

  it.each([20, 30, 40, 50])("follows the duty ramp on LD1 at %i %", (duty) => {
    run(0.1)
    expect(ld1()).toBeNear((full * duty) / 100, 0.03)
  })

  // LD2 (blue, 330 Ω) is toggled at 200 Hz by the TIM2 interrupt: a 100 Hz square the eye sees as half brightness.
  it("lights LD2 steadily from the TIM2 interrupt", () => {
    const ld2: number[] = []
    run(0.1, (s) => ld2.push(s.parts[partKey(u.id, "LD2")]!.level))
    const mean = ld2.reduce((a, b) => a + b, 0) / ld2.length
    expect(mean, "lit").toBeGreaterThan(0.03)
    expect((Math.max(...ld2) - Math.min(...ld2)) / mean, "steady, not strobing").toBeNear(0, 0.3)
  })
})
