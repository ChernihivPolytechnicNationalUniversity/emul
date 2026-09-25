/**
 * The low-power firmware on the "Nucleo blink" schematic: the board's supply load follows the
 * core's power mode (the current through the MCU's VDD element is the scope on the supply), the
 * USER button wakes it from Stop, and the Standby exit is a reset the inspector reports.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoBlink } from "@/schematic/examples"
import { getDef } from "@/schematic/registry"
import { partKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { hal } from "../lib/firmware"

type Core = { mcu: { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] }; rcc: { get: (name: string) => number } } }

describe("low power on the Nucleo", () => {
  const doc = nucleoBlink.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  u.props = { ...u.props, firmware: "lowpower.elf", firmwareData: hal("lowpower.elf").toString("base64") }
  const iddElement = getDef(u.def)!.model!.findIndex((el) => el.kind === "R" && el.live === "$idd")

  const loop = new SimLoop()
  let clock = 0
  let core: Core["mcu"]
  const word = (name: string) => core.bus.read32(core.firmware.symbols.find((x) => x.name === name)!.value)

  /**
   * The scope on the supply: one sample per 2 ms tick of the mode and the VDD current. The
   * ~50 µs the firmware runs between two Stops never lands on a sample, so the Stops are told
   * apart by their regulator ("stop low-power" → "stop main" is a wake-up and a new Stop).
   */
  const trace: { t: number; mode: string; amps: number }[] = []
  function run(seconds: number) {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 2)
      loop.advance(clock)
      const s = loop.snapshot()!
      const p = s.mcus[u.id].power
      trace.push({ t: s.time, mode: p.mode === "stop" ? `stop ${p.regulator}` : p.mode, amps: s.readings.find((r) => r.object === u.id && r.element === iddElement)?.current ?? NaN })
    }
  }
  const modeAt = (mode: string, after: number) => trace.find((x) => x.t > after && x.mode === mode)?.t ?? NaN
  const average = (from: number, to: number) => {
    const s = trace.filter((x) => x.t > from + 3e-3 && x.t <= to)
    return s.reduce((a, x) => a + Math.abs(x.amps), 0) / s.length
  }
  const press = (pressed: boolean) => loop.setParts({ [partKey(u.id, "B1")]: { pressed } })

  let snap: Snapshot
  let lseReady = 0
  let t0 = 0
  let stop1 = 0
  let stop2 = 0
  let beforeEvent = 0

  beforeAll(() => {
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    loop.advance(clock)
    core = (loop as unknown as { mcus: Map<string, { mcu: Core }> }).mcus.get(u.id)!.mcu.mcu
  })

  it("waits the 2 s the board's 32.768 kHz crystal takes to start", () => {
    while (clock < 2500 && !(core.rcc.get("BDCR") & 2)) run(0.002)
    snap = loop.snapshot()!
    lseReady = snap.time
    expect.soft(lseReady, "LSE ready (s)").toBeNear(2.0, 0.02)
    expect(snap.mcus[u.id].halted).toBeFalsy()
    expect(snap.mcus[u.id].running).toBe(true)
    expect(iddElement, "supply element found").toBeGreaterThanOrEqual(0)
  })

  it("sleeps between SysTicks", () => {
    run(0.03)
    t0 = loop.snapshot()!.time
    run(0.15)
    snap = loop.snapshot()!
    expect.soft(snap.mcus[u.id].power.mode, "inspector").toBe("sleep")
    expect.soft(snap.mcus[u.id].power.asleep, "asleep nearly all the time").toBeNear(1, 0.03)
    expect.soft(average(t0, snap.time) * 1e3, "VDD current ≈ Sleep at 180 MHz (mA)").toBeNear(39, 3)
  })

  it("stops on the low-power regulator until the RTC wake-up", () => {
    run(0.05)
    stop1 = modeAt("stop low-power", t0)
    expect.soft((stop1 - lseReady) * 1e3, "entered Stop ~200 ms after the RTC came up").toBeNear(205, 8)
    run(0.1)
    snap = loop.snapshot()!
    expect.soft(average(stop1, snap.time) * 1e3, "VDD current in Stop (mA)").toBeNear(0.55, 0.02)
    expect.soft(`${snap.mcus[u.id].power.mode} ${snap.mcus[u.id].power.regulator}`, "inspector").toBe("stop low-power")
    run(0.2)
    stop2 = modeAt("stop main", stop1)
    expect.soft((stop2 - stop1) * 1e3, "woke after 300 ms, straight into the next Stop (ms)").toBeNear(300, 4)
    expect.soft(word("stopTicks"), "HAL tick stood still").toBeNear(0, 1)
    expect.soft(word("reclocked"), "clock re-configured onto the PLL in between").toBe(8)
  })

  it("stops until the USER button (EXTI13 interrupt)", () => {
    run(0.1)
    snap = loop.snapshot()!
    expect.soft(average(stop2, snap.time) * 1e3, "VDD current in Stop, main regulator (mA)").toBeNear(1.2, 0.02)
    expect.soft(word("wakes"), "no wake-up yet").toBe(0)
    press(true)
    run(0.01)
    expect.soft(word("wakes"), "the press woke the core (EXTI callback)").toBe(1)
    press(false)
    run(0.05)
  })

  it("stops until the USER button (EXTI13 event, WFE)", () => {
    snap = loop.snapshot()!
    expect.soft(snap.mcus[u.id].power.mode, "in Stop again").toBe("stop")
    beforeEvent = snap.time
    press(true)
    run(0.01)
    snap = loop.snapshot()!
    press(false)
    const afterButton = snap.time
    run(0.05)
    expect.soft(modeAt("stop under-drive", beforeEvent), "the event woke the core: next Stop is under-drive").toBeLessThan(afterButton + 0.01)
    expect.soft(word("wakes"), "without an interrupt").toBe(1)
  })

  it("goes from an under-drive Stop into Standby and out through a reset", () => {
    run(0.2)
    const stop4 = modeAt("stop under-drive", beforeEvent)
    snap = loop.snapshot()!
    expect.soft(average(stop4, Math.min(snap.time, stop4 + 0.19)) * 1e3, "VDD current in under-drive Stop (mA)").toBeNear(0.13, 0.02)
    run(0.05)
    const standby = modeAt("standby", stop4 + 0.19)
    expect.soft((standby - stop4) * 1e3, "Standby 200 ms after the under-drive Stop (ms)").toBeNear(200, 4)
    run(0.2)
    snap = loop.snapshot()!
    expect.soft(snap.mcus[u.id].power.mode, "inspector").toBe("standby")
    expect.soft(average(standby, snap.time) * 1e6, "VDD current in Standby (µA)").toBeNear(3, 0.2)
    run(0.35)
    snap = loop.snapshot()!
    expect.soft(`${snap.mcus[u.id].resets} by ${snap.mcus[u.id].lastReset}`, "Standby exit counted as a reset").toBe("1 by standby")
    expect.soft(snap.mcus[u.id].power.mode, "core back in Standby waiting for WKUP").toBe("standby")
    expect.soft(snap.mcus[u.id].unmodelled.length, "nothing unmodelled").toBe(0)
  })
})
