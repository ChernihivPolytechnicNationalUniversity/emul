/**
 * Lab 1 as completed for variant 1 on the Open746I-C: a running light stepped by the joystick.
 * One LED is lit at a time; C runs it LED1→LED4, B the other way, A and D lengthen and shorten
 * the dwell between 1 and 5 s, the centre stops it. Every joystick edge restarts TIM7 through EXTI
 * and the lines are read once they have held still for 20 ms; the core runs at 50 MHz from the
 * 8 MHz crystal.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { lab1RunningLight } from "@/schematic/examples"
import { partKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

const LEDS = ["LED1", "LED2", "LED3", "LED4"]

describe("lab 1 running light on the Open746I-C", () => {
  const doc = lab1RunningLight.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "lab1-running-light.elf", firmwareData: exampleBase64("lab1-running-light.elf") }

  const loop = new SimLoop()
  let clock = 0
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
    }
  }
  const ledStr = (s: Snapshot) => LEDS.map((l) => (s.parts[partKey(u.id, l)]?.on ? "●" : "○")).join("")
  const leds = () => ledStr(loop.snapshot()!)

  /** Press a joystick position and let go of it: the firmware acts 20 ms into the press. */
  const tap = (part: string) => {
    loop.setParts({ [partKey(u.id, part)]: { pressed: true } })
    run(0.05)
    loop.setParts({})
    run(0.05)
  }

  /** Simulated seconds until the LEDs read `want`, stopping there, or NaN when they never do within `within` s. */
  const until = (want: string, within: number) => {
    const started = loop.snapshot()!.time
    const end = clock + within * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
      const s = loop.snapshot()!
      if (ledStr(s) === want) return s.time - started
    }
    return NaN
  }

  describe("boot", () => {
    beforeAll(() => {
      loop.setDoc(doc)
      loop.setParts(doc.parts)
      loop.setRunning(true)
      loop.advance(clock)
      run(0.1)
    })

    it("runs at 50 MHz from the crystal through the PLL", () => {
      const st = loop.snapshot()!.mcus[u.id]
      expect(st?.firmware ?? "none", "MCU loaded").toBe("lab1-running-light.elf")
      expect(st?.halted, "halted").toBeFalsy()
      expect(st?.running, "core running").toBe(true)
      expect(st?.sysclk ?? 0, "SYSCLK = HSE 8 MHz / 4 × 50 / 2").toBe(50e6)
    })

    it("lights LED1 and stays there until told", () => {
      expect(leds(), "after boot").toBe("●○○○")
      run(2.5)
      expect(leds(), "after 2.5 s").toBe("●○○○")
    })
  })

  it("runs LED1 → LED4 on C, a second per step, wrapping", () => {
    tap("JOY_C")
    expect.soft(until("○●○○", 1.5), "LED2 after").toBeNear(1.0, 0.1)
    expect.soft(until("○○●○", 1.5), "LED3 after another").toBeNear(1.0, 0.1)
    expect.soft(until("○○○●", 1.5), "LED4 after another").toBeNear(1.0, 0.1)
    expect.soft(until("●○○○", 1.5), "back to LED1 after another").toBeNear(1.0, 0.1)
  })

  it("stops where it is on the centre", () => {
    tap("JOY_CTR")
    run(2.5)
    expect(leds()).toBe("●○○○")
  })

  it("lengthens the dwell to 2 s on A and runs the other way on B", () => {
    tap("JOY_A")
    tap("JOY_B")
    expect.soft(until("○○○●", 3), "LED4 after 2 s, not 1").toBeNear(2.0, 0.15)
    expect.soft(until("○○●○", 3), "LED3 after another 2 s").toBeNear(2.0, 0.15)
  })

  it("floors the dwell at 1 s on D three times, the step in flight keeping its timer", () => {
    tap("JOY_D")
    tap("JOY_D")
    tap("JOY_D")
    expect.soft(Number.isNaN(until("○●○○", 2)), "LED2 never arrives").toBe(false)
    expect.soft(until("●○○○", 2), "LED1 after another 1 s").toBeNear(1.0, 0.15)
  })

  it("caps the dwell at 5 s on A five times", () => {
    tap("JOY_CTR")
    for (let i = 0; i < 6; i++) tap("JOY_A")
    tap("JOY_C")
    expect(until("○●○○", 6.5)).toBeNear(5.0, 0.15)
  })
})
