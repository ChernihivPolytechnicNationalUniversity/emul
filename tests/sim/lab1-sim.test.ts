/**
 * Lab 1 through the circuit: the "STM32F746 stand: LED staircase" schematic — a bare
 * STM32F746IGT6 with LEDs and a joystick drawn around it — running the lab's firmware through
 * the same SimLoop the worker uses. The LED staircase through the real resistors and diodes,
 * the joystick pull-ups, and the reset button on NRST.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { lab1Stand } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

const LEDS = ["VD1", "VD2", "VD3", "VD4"]

describe("lab 1 stand through the circuit", () => {
  const doc = lab1Stand.build(GRID)
  const dd = doc.objects.find((o) => o.def === "stm32f746ig")!
  const byRef = (ref: string) => doc.objects.find((o) => o.props?.ref === ref)!
  dd.props = { ...dd.props, firmware: "lab1-f746.elf", firmwareData: exampleBase64("lab1-f746.elf") }

  const loop = new SimLoop()
  let clock = 0
  const run = (seconds: number, sample?: (snap: Snapshot) => void) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
      if (sample) sample(loop.snapshot()!)
    }
    return loop.snapshot()!
  }
  const ledOn = (s: Snapshot, ref: string) => s.parts[partKey(byRef(ref).id, "LED")]?.on ?? false
  const ledStr = (s: Snapshot) => LEDS.map((l) => (ledOn(s, l) ? "●" : "○")).join("")
  const volts = (s: Snapshot, pin: string) => s.pinVoltage[pinKey(dd.id, pin)]
  const press = (ref: string, pressed: boolean) => loop.setParts({ [partKey(byRef(ref).id, "SW")]: { pressed } })

  describe("boot", () => {
    let snap: Snapshot
    beforeAll(() => {
      loop.setDoc(doc)
      loop.setParts(doc.parts)
      loop.setRunning(true)
      loop.advance(clock)
      snap = run(0.05)
    })

    it("loads and runs the firmware at 50 MHz", () => {
      const st = snap.mcus[dd.id]
      expect(st?.firmware ?? "none", "MCU loaded").toBe("lab1-f746.elf")
      expect(st?.halted, "halted").toBeFalsy()
      expect(st?.running, "core running").toBe(true)
      expect(st?.sysclk ?? 0, "SYSCLK").toBe(50e6)
    })

    it("powers VDD and idles NRST high on the pull-up", () => {
      expect.soft(volts(snap, "VDD"), "VDD").toBeNear(3.3, 0.01)
      expect.soft(volts(snap, "NRST"), "NRST").toBeNear(3.3, 0.01)
    })

    it("pulls the joystick up", () => {
      for (const p of ["PG2", "PG3", "PD4", "PD5", "PI11"]) expect.soft(volts(snap, p), p).toBeNear(3.3, 0.05)
    })

    it("lights L1 through its 1 kΩ", () => {
      expect(ledStr(snap)).toBe("●○○○")
      expect(Math.abs(snap.pinCurrent[pinKey(byRef("R2").id, "1")]) * 1e3, "mA").toBeNear(((3.3 - 1.9) / 1e3) * 1e3, 0.3)
    })
  })

  describe("staircase: L2 at 1 s, L3 at 3 s, L4 at 6 s, then off from 10 s", () => {
    const onAt: Record<string, number> = {}
    let snap: Snapshot
    beforeAll(() => {
      snap = run(11.5, (s) => {
        for (const l of LEDS) if (onAt[l] === undefined && ledOn(s, l)) onAt[l] = s.time
      })
    })

    it.each([
      ["VD1", 0.03],
      ["VD2", 1.0],
      ["VD3", 3.0],
      ["VD4", 6.0],
    ])("lights %s at %s s", (led, t) => {
      expect(onAt[led] ?? NaN).toBeNear(t, 0.05)
    })

    it("has L1 and L2 off again at 11.5 s", () => expect(ledStr(snap)).toBe("○○●●"))
  })

  it("pulls PD4 to ground while SA4 is pressed", () => {
    press("SA4", true)
    let snap = run(0.05)
    expect.soft(volts(snap, "PD4"), "PD4 while pressed").toBeNear(0, 0.05)
    expect.soft(volts(snap, "PD5"), "PD5 untouched").toBeNear(3.3, 0.05)
    press("SA4", false)
    snap = run(0.05)
    expect.soft(volts(snap, "PD4"), "PD4 released").toBeNear(3.3, 0.05)
  })

  describe("reset button SA1", () => {
    it("holds the core in reset while NRST is low", () => {
      press("SA1", true)
      const snap = run(0.1)
      expect.soft(volts(snap, "NRST"), "NRST").toBeNear(0, 0.05)
      expect.soft(snap.mcus[dd.id].powered, "core powered").toBe(false)
      expect.soft(ledStr(snap), "LEDs").toBe("○○○○")
    })

    it("restarts the staircase from the top on release", () => {
      press("SA1", false)
      const snap = run(0.1)
      expect.soft(snap.mcus[dd.id].powered && snap.mcus[dd.id].running, "core restarted").toBe(true)
      expect.soft(snap.mcus[dd.id].time, "core time").toBeLessThan(0.15)
      expect.soft(ledStr(snap), "LEDs").toBe("●○○○")
    })
  })

  describe("100 V on the +3V3 rail", () => {
    const doc2 = lab1Stand.build(GRID)
    const dd2 = doc2.objects.find((o) => o.def === "stm32f746ig")!
    dd2.props = { ...dd2.props, firmware: "lab1-f746.elf", firmwareData: exampleBase64("lab1-f746.elf") }
    const rail = doc2.objects.find((o) => o.def === "supply")!
    rail.props = { ...rail.props, value: "+100V", voltage: "100 V" }
    let s2: Snapshot
    beforeAll(() => {
      const loop2 = new SimLoop()
      loop2.setDoc(doc2)
      loop2.setParts(doc2.parts)
      loop2.setRunning(true)
      let t = 0
      loop2.advance(t)
      for (let i = 0; i < 10; i++) loop2.advance((t += 30))
      s2 = loop2.snapshot()!
    })

    it("burns out DD1 and halts the core", () => {
      const dmg = s2.damage[dd2.id]
      expect(dmg ? `${dmg.fail}: ${dmg.reason}` : "intact").toBe("short: voltage 100.00 V exceeds the 4.00 V rating")
      expect(s2.mcus[dd2.id].halted ?? "running").toBe(
        "fault at 0x" + (s2.mcus[dd2.id].pc >>> 0).toString(16).padStart(8, "0") + ": burnt out: voltage 100.00 V exceeds the 4.00 V rating",
      )
    })

    // The dead die shorts its supply, and a bench supply into a short trips.
    it("trips the +100 V supply into the shorted die", () => {
      const railDmg = s2.damage[rail.id]
      expect(railDmg ? railDmg.reason.replace(/[\d.]+ kA/, "…") : "intact").toBe("current … exceeds the 1.00 A rating")
    })

    it("damages nothing else", () => expect(Object.keys(s2.damage).length).toBe(2))
  })
})
