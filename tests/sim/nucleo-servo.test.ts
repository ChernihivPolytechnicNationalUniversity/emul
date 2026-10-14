/**
 * The "Nucleo servo SG90" example co-simulated: unmodified HAL firmware drives TIM1 CH1 on D6
 * at 50 Hz, the SG90 model measures each pulse at its edges' own times and turns the horn at
 * its 0.1 s/60°; the servo draws its running and idle current from the board's +5V, and holding
 * B1 parks it at 0°.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoServo } from "@/schematic/examples/servo"
import { partKey, pinKey, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { SG90, type ServoSnapshot } from "@/sim/servo"
import { exampleBase64 } from "../lib/firmware"

type Core = { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } }

const angleOf = (pulseUs: number) => ((pulseUs * 1e-6 - SG90.centre) / SG90.perQuarterTurn) * SG90.travel

function bench() {
  const doc: Schematic = nucleoServo.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const servo = doc.objects.find((o) => o.def === "servo-sg90")!
  u.props = { ...u.props, firmware: "nucleo-servo.elf", firmwareData: exampleBase64("nucleo-servo.elf") }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const samples: { t: number; s: ServoSnapshot; pulseUs: number; step: number }[] = []
  const core = () => (loop as unknown as { mcus: Map<string, { mcu: { mcu: Core } }> }).mcus.get(u.id)!.mcu.mcu
  const word = (name: string) => core().bus.read32(core().firmware.symbols.find((x) => x.name === name)!.value)
  const snap = () => loop.snapshot()!.digital[servo.id] as ServoSnapshot
  const run = (seconds: number, slice = 5) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + slice)
      loop.advance(clock)
      samples.push({ t: clock / 1000, s: snap(), pulseUs: word("targetPulseUs"), step: word("step") })
    }
  }
  const press = (pressed: boolean) => loop.setParts({ ...doc.parts, [partKey(u.id, "B1")]: { pressed } })
  return { loop, run, word, snap, samples, press, servo }
}

describe("Nucleo servo SG90", () => {
  it("measures the pulse widths the firmware sets, at 50 Hz", () => {
    const b = bench()
    b.run(4.2)
    expect(b.word("errors"), "no HAL errors").toBe(0)
    expect(b.word("step"), "sweep steps taken").toBeGreaterThanOrEqual(7)
    const s = b.snap()
    expect(s.period, "pulse period").toBeCloseTo(SG90.period, 5)
    // The servo's last measured pulse is the compare value now, or the one before when a step
    // landed inside the last 20 ms; compare only samples well past a step.
    const settled = b.samples.filter((x, i) => i > 8 && b.samples[i - 8].step === x.step && x.s.pulse !== null)
    expect(settled.length).toBeGreaterThan(100)
    for (const x of settled) expect(Math.abs(x.s.pulse! * 1e6 - x.pulseUs), `pulse at ${x.t}s`).toBeLessThan(1.01)
    // 1500 + angle × 500 / 90 in C (integer division truncating toward zero), −90° … +90°.
    const firmware = Array.from({ length: 13 }, (_, k) => 1500 + Math.trunc(((k * 15 - 90) * 500) / 90))
    const widths = [...new Set(settled.map((x) => x.pulseUs))].sort((a, z) => a - z)
    expect(widths, "every step from 1 ms to 2 ms").toEqual(firmware)
  })

  it("follows the target within the 0.1 s/60° speed limit and draws its currents from +5V", () => {
    const b = bench()
    b.run(8)
    // 1000 µs and 2000 µs are the sheet's ±90°, inside the stops: the servo never stalls.
    const stalled = b.samples.filter((x) => x.s.state === "stalled").map((x) => `${x.t}s ${(x.s.pulse! * 1e6).toFixed(9)} µs → ${x.s.target}°, vcc ${x.s.vcc.toFixed(2)} V`)
    expect.soft(stalled, "no stall at the ±90° ends").toEqual([])
    let movingSeen = false
    let restSeen = false
    for (let i = 1; i < b.samples.length; i++) {
      const [p, x] = [b.samples[i - 1], b.samples[i]]
      const dt = x.t - p.t
      expect(Math.abs(x.s.angle - p.s.angle), `speed at ${x.t}s`).toBeLessThanOrEqual(SG90.speed * dt + 1e-6)
      expect(Math.abs(x.s.angle), "never past the end stop").toBeLessThanOrEqual(SG90.travel + 1e-9)
      if (x.s.state === "moving") {
        movingSeen = true
        expect(x.s.current).toBeCloseTo(SG90.running, 6)
      } else if (x.s.state === "holding" && p.s.state === "holding") {
        restSeen = true
        expect(x.s.current).toBeCloseTo(SG90.idle, 6)
        // At rest the horn is where the pulse asks.
        expect(Math.abs(x.s.angle - angleOf(x.s.pulse! * 1e6)), `angle at ${x.t}s`).toBeLessThan(0.1)
      }
    }
    expect(movingSeen && restSeen, "both moving and resting").toBe(true)
    // 15° takes 25 ms at 600°/s, the steps come every 300 ms: 150 ms into a step it has arrived.
    const settled = b.samples.filter((x, i) => x.t > 0.4 && i >= 30 && b.samples[i - 30].step === x.step)
    for (const x of settled) expect(Math.abs(x.s.angle - angleOf(x.pulseUs)), `angle at ${x.t}s`).toBeLessThan(0.2)
    const angles = settled.map((x) => x.s.angle)
    expect(Math.min(...angles), "reaches −90°").toBeLessThan(-89.9)
    expect(Math.max(...angles), "reaches +90°").toBeGreaterThan(89.4)
    const v5 = b.loop.snapshot()!.pinVoltage[pinKey(b.servo.id, "VCC")]
    expect(v5, "5V rail under the servo").toBeGreaterThan(4.7)
    expect(b.snap().vcc).toBeGreaterThan(SG90.minVolts)
  })

  it("parks at 0° while B1 is held and carries on after release", () => {
    const b = bench()
    b.run(1)
    expect(Math.abs(b.snap().angle), "away from the middle before").toBeGreaterThan(20)
    b.press(true)
    b.run(0.3)
    expect(b.word("parked"), "firmware saw B1").toBe(1)
    expect(b.word("targetPulseUs")).toBe(1500)
    const s = b.snap()
    expect(s.pulse! * 1e6).toBeCloseTo(1500, 0)
    expect(Math.abs(s.angle), "parked at 0°").toBeLessThan(0.1)
    expect(s.state).toBe("holding")
    expect(s.current).toBeCloseTo(SG90.idle, 6)
    const stepHeld = b.word("step")
    b.run(1)
    expect(b.word("step"), "sweep waits while held").toBe(stepHeld)
    expect(Math.abs(b.snap().angle)).toBeLessThan(0.1)
    b.press(false)
    b.run(0.7)
    expect(b.word("parked")).toBe(0)
    expect(b.word("step"), "sweep resumes").toBeGreaterThan(stepHeld)
    expect(Math.abs(b.snap().angle), "away from 0° again").toBeGreaterThan(5)
  })
})
