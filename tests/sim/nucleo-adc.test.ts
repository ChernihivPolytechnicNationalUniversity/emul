/**
 * The "Nucleo ADC and DAC" example co-simulated: the ADC samples the wiper's net voltage out of the
 * solver, the PWM duty follows the pot, the DAC's sine drives a real LED load through the field.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoAdc } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

type Core = { mcu: { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } } }

describe("Nucleo ADC and DAC", () => {
  const doc = nucleoAdc.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const pot = doc.objects.find((o) => o.def === "potentiometer")!
  const led = doc.objects.find((o) => o.def === "led")!
  u.props = { ...u.props, firmware: "nucleo-adc.elf", firmwareData: exampleBase64("nucleo-adc.elf") }

  const loop = new SimLoop()
  let clock = 0
  const dacTrace: number[] = []
  function run(seconds: number) {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 2)
      loop.advance(clock)
      dacTrace.push(loop.snapshot()!.pinVoltage[pinKey(u.id, "CN7-17")])
    }
  }
  let core: Core["mcu"]
  const word = (name: string) => core.bus.read32(core.firmware.symbols.find((x) => x.name === name)!.value)
  let snap: Snapshot
  let ld1 = 0

  beforeAll(() => {
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    loop.advance(clock)
    core = (loop as unknown as { mcus: Map<string, { mcu: Core }> }).mcus.get(u.id)!.mcu.mcu
    run(0.1)
    snap = loop.snapshot()!
  })

  it("reads the wiper at 70 % and dims LD1 to match", () => {
    expect(snap.mcus[u.id].running, "core running").toBe(true)
    expect.soft(word("errors"), "no HAL errors").toBe(0)
    expect.soft(snap.pinVoltage[pinKey(u.id, "CN9-1")], "0.99 V on A0").toBeNear(0.99, 0.02)
    expect.soft(word("adcValue"), "ADC counts").toBeNear(1229, 15)
    ld1 = snap.parts[partKey(u.id, "LD1")]?.level ?? 0
    expect.soft(ld1, "LD1 dimmed (30 % duty)").toBeGreaterThan(0.03)
    expect.soft(ld1, "LD1 dimmed (30 % duty)").toBeLessThan(0.15)
  })

  it("follows the pot turned up", () => {
    pot.props = { ...pot.props, pos: "0.1" }
    loop.setDoc(doc)
    run(0.1)
    snap = loop.snapshot()!
    expect.soft(snap.pinVoltage[pinKey(u.id, "CN9-1")], "A0 now near 2.97 V").toBeNear(2.97, 0.03)
    expect.soft(word("adcValue"), "ADC follows").toBeNear(3686, 20)
    expect.soft(snap.parts[partKey(u.id, "LD1")]?.level ?? 0, "LD1 brighter").toBeGreaterThan(ld1)
  })

  it("drives the LED with the DAC's sine", () => {
    const recent = dacTrace.slice(-50)
    // 100 Ω of DAC output resistance into 1 kΩ + LED drops the peak a little.
    expect.soft(Math.max(...recent), "DAC pin swings up to ~3.15 V").toBeNear(3.15, 0.1)
    expect.soft(Math.min(...recent), "and down to ~0 V").toBeNear(0, 0.15)
    const glow = snap.parts[partKey(led.id, "LED")]?.level ?? 0
    expect.soft(glow, "the LED glows dimly (average of the sine)").toBeGreaterThan(0.02)
    expect.soft(glow, "the LED glows dimly (average of the sine)").toBeLessThan(0.6)
    expect.soft(snap.mcus[u.id].unmodelled.length, "nothing unmodelled").toBe(0)
  })
})
