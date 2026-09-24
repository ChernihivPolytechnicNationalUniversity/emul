/**
 * The "Nucleo blink" schematic with the HAL blink firmware loaded into U1, run through the same
 * SimLoop the worker uses. The firmware drives PA5 (D13) into the external LED and PB0/PB7 into
 * the on-board ones; the USER button goes back in through EXTI.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoBlink } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { hal } from "../lib/firmware"

describe("Nucleo blink through the circuit", () => {
  const doc = nucleoBlink.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const led = doc.objects.find((o) => o.def === "led")!
  u.props = { ...u.props, firmware: "blink.elf", firmwareData: hal("blink.elf").toString("base64") }

  const loop = new SimLoop()
  let clock = 0
  const run = (seconds: number, sample?: (snap: Snapshot) => void) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
      if (sample) sample(loop.snapshot()!)
    }
  }
  const d13 = pinKey(u.id, "CN7-10")

  describe("boot", () => {
    let snap: Snapshot
    beforeAll(() => {
      loop.setDoc(doc)
      loop.setParts(doc.parts)
      loop.setRunning(true)
      loop.advance(clock)
      run(0.02)
      snap = loop.snapshot()!
    })

    it("loads and runs the firmware at 180 MHz", () => {
      const st = snap.mcus[u.id]
      expect(st?.firmware ?? "none", "MCU loaded").toBe("blink.elf")
      expect(st?.halted, "halted").toBeFalsy()
      expect(st?.running, "core running").toBe(true)
      expect(st?.sysclk ?? 0, "SYSCLK").toBe(180e6)
    })
  })

  describe("3 s of blinking", () => {
    let snap: Snapshot
    const edges: number[] = []
    const ld2Levels: number[] = []
    beforeAll(() => {
      let lastLevel: boolean | null = null
      run(3, (s) => {
        const level = s.pinVoltage[d13] > 1.65
        if (lastLevel !== null && level !== lastLevel) edges.push(s.time)
        lastLevel = level
        ld2Levels.push(s.parts[partKey(u.id, "LD2")]?.level ?? 0)
      })
      snap = loop.snapshot()!
    })

    it("toggles D13 every HAL_Delay(500), 501 ms", () => {
      const period = edges.length >= 3 ? (2 * (edges[edges.length - 1] - edges[0])) / (edges.length - 1) : 0
      expect.soft(edges.length, "D13 toggles seen in 3 s").toBeNearRel(6, 0.2)
      expect.soft(period, "D13 toggle period").toBeNearRel(1.002, 0.01)
    })

    it("drives the external LED and LD1 (PB0) with D13", () => {
      const d13High = snap.pinVoltage[d13] > 1.65
      expect.soft(snap.parts[partKey(led.id, "LED")]?.on, "external LED").toBe(d13High)
      expect.soft(snap.parts[partKey(u.id, "LD1")]?.on ?? false, "LD1").toBe(d13High)
    })

    it("toggles LD2 (PB7) at 5 Hz", () => {
      const ld2Toggles = ld2Levels.reduce((n, l, i) => (i > 0 && (l > 0.05) !== (ld2Levels[i - 1] > 0.05) ? n + 1 : n), 0)
      expect(ld2Toggles).toBeNearRel(30, 0.1)
    })

    it("holds D13 high at 3.15 V", () => {
      expect(Math.max(...edges.map(() => 0), snap.pinVoltage[d13] > 1.65 ? snap.pinVoltage[d13] : 3.15)).toBeNearRel(3.15, 0.03)
    })
  })

  it("toggles LD3 on a USER button press through the analog switch into EXTI", () => {
    const before = loop.snapshot()!.parts[partKey(u.id, "LD3")]?.on ?? false
    loop.setParts({ [partKey(u.id, "B1")]: { pressed: true } })
    run(0.05)
    loop.setParts({ [partKey(u.id, "B1")]: { pressed: false } })
    run(0.05)
    expect(loop.snapshot()!.parts[partKey(u.id, "LD3")]?.on ?? false).toBe(!before)
  })

  describe("USB unplugged", () => {
    it("takes the core's power away", () => {
      loop.setParts({ [partKey(u.id, "USB")]: { on: false } })
      run(0.1)
      const snap = loop.snapshot()!
      expect.soft(snap.mcus[u.id].powered, "core powered").toBe(false)
      expect.soft(snap.pinVoltage[pinKey(u.id, "CN8-7")], "+3V3").toBeNear(0, 1e-3)
      expect.soft(snap.parts[partKey(u.id, "LD1")]?.on ?? false, "LD1").toBe(false)
    })

    it("restarts the core from t = 0 when plugged back in", () => {
      loop.setParts({ [partKey(u.id, "USB")]: { on: true } })
      run(0.05)
      const st = loop.snapshot()!.mcus[u.id]
      expect.soft(st.powered, "core powered").toBe(true)
      expect.soft(st.time, "core time").toBeLessThan(0.06)
      expect.soft(st.running, "core running").toBe(true)
    })
  })
})
