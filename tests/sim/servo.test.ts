/**
 * TowerPro SG90 on the bench, against its sheet: 1.5 ms the middle, 2 ms +90°, 1 ms −90°, 60° in
 * 0.1 s, a 10 µs dead band; the supply carries 90 mA while it moves, 4 mA at rest and 750 mA
 * stalled on its end stop; without pulses the horn stops where it is.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import type { Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { Servo, SG90, type ServoSnapshot } from "@/sim/servo"

function bench(width: string | null, supply = "5 V") {
  const { doc, place, wire } = builder(GRID)
  const vcc = place("dc-source", 0, 0, { value: supply, rint: "0.1 Ω", imax: "3 A" })
  const servo = place("servo-sg90", 14, 0)
  const gnd = place("ground", 4, 14)
  wire(vcc, "+", servo, "VCC")
  wire(vcc, "-", gnd, "GND")
  wire(servo, "GND", gnd, "GND")
  if (width) {
    const pwm = place("pulse-source", 8, 6, { high: "3.3 V", low: "0 V", freq: "50 Hz", width, rint: "25 Ω" })
    wire(pwm, "+", servo, "SIG")
    wire(pwm, "-", gnd, "GND")
  }
  return { doc, servo }
}

function start(doc: Schematic) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const to = (ms: number) => {
    while (clock < ms) loop.advance((clock = Math.min(ms, clock + 5)))
  }
  return { loop, to }
}

const snap = (loop: SimLoop, id: string) => loop.snapshot()!.digital[id] as ServoSnapshot
const supplyAmps = (loop: SimLoop, id: string) => Math.abs(loop.snapshot()!.readings.find((r) => r.object === id && r.element === 0)!.current)

describe("Servo SG90", () => {
  it.each([
    ["1.5 ms", 0],
    ["2 ms", 90],
    ["1 ms", -90],
    ["1.75 ms", 45],
  ])("%s pulses every 20 ms put the horn at %i°", (width, angle) => {
    const { doc, servo } = bench(width)
    const { loop, to } = start(doc)
    to(400)
    const s = snap(loop, servo.id)
    expect(s.pulse! * 1e3).toBeNear(parseFloat(width), 1e-6)
    expect(s.period! * 1e3).toBeNear(20, 0.05)
    expect(s.angle).toBeNear(angle, 0.5)
    expect(s.state).toBe("holding")
    loop.dispose()
  })

  it("swings 90° in 0.15 s (0.1 s/60°), drawing 90 mA on the way and 4 mA once there", () => {
    const { doc, servo } = bench("2 ms")
    const { loop, to } = start(doc)
    to(100)
    const moving = snap(loop, servo.id)
    expect(moving.state).toBe("moving")
    // The first rising edge is at 0; the first pulse ends at 2 ms, and the horn moves from then on.
    expect(moving.angle).toBeNear(SG90.speed * (0.1 - 0.002), 3)
    expect(supplyAmps(loop, servo.id)).toBeNear(SG90.running, 0.005)
    to(300)
    expect(snap(loop, servo.id).state).toBe("holding")
    expect(supplyAmps(loop, servo.id)).toBeNear(SG90.idle, 0.001)
    loop.dispose()
  })

  it("a 2.5 ms pulse asks past the +90° stop: the horn stalls there drawing 750 mA", () => {
    const { doc, servo } = bench("2.5 ms")
    const { loop, to } = start(doc)
    to(400)
    const s = snap(loop, servo.id)
    expect(s.angle).toBeNear(90, 1e-6)
    expect(s.state).toBe("stalled")
    expect(supplyAmps(loop, servo.id)).toBeNear(SG90.stall, 0.01)
    loop.dispose()
  })

  it("a change inside the 10 µs dead band does not move it; one past it does", () => {
    const servo = new Servo("M1")
    servo.sense((pin) => (pin === "VCC" ? 5 : 0), 0)
    const pulse = (at: number, width: number) => {
      servo.input("SIG", true, at)
      servo.input("SIG", false, at + width)
      servo.tick(at + 0.02)
    }
    for (let k = 0; k < 10; k++) pulse(k * 0.02, 1.5e-3)
    expect(servo.snapshot().angle).toBe(0)
    for (let k = 10; k < 20; k++) pulse(k * 0.02, 1.509e-3)
    expect(servo.snapshot().angle, "9 µs: inside the dead band").toBe(0)
    for (let k = 20; k < 30; k++) pulse(k * 0.02, 1.511e-3)
    expect(servo.snapshot().angle, "11 µs: past it").toBeNear((0.011 / 0.5) * 90, 1e-6)
  })

  it("no pulses: no motion, 4 mA of electronics", () => {
    const { doc, servo } = bench(null)
    const { loop, to } = start(doc)
    to(200)
    const s = snap(loop, servo.id)
    expect(s.state).toBe("idle")
    expect(s.angle).toBe(0)
    expect(supplyAmps(loop, servo.id)).toBeNear(SG90.idle, 0.001)
    loop.dispose()
  })
})
