/**
 * The Open746I-C board on its own, running the lab 1 firmware: the USER LEDs step through
 * their staircase behind 1 kΩ, the joystick pulls its pins to ground, WAKEUP lifts PA0, RESET
 * holds the core, the board runs from the module's USB (SW1 at USB) or from the USART1 USB or
 * the jack through S2 (SW1 at 5Vin), and is dead with its source unplugged.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { lab1Board } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { example } from "../lib/firmware"

const LEDS = ["LED1", "LED2", "LED3", "LED4"]
const elf = example("lab1-f746.elf")

describe("Open746I-C running lab 1", () => {
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "lab1-f746.elf", firmwareData: elf.toString("base64") }

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
  const ledOn = (s: Snapshot, id: string) => s.parts[partKey(u.id, id)]?.on ?? false
  const ledStr = (s: Snapshot) => LEDS.map((l) => (ledOn(s, l) ? "●" : "○")).join("")
  const v = (s: Snapshot, pin: string) => s.pinVoltage[pinKey(u.id, pin)]
  const press = (part: string, pressed: boolean) => loop.setParts({ [partKey(u.id, part)]: { pressed } })
  const BOOT = partKey(u.id, "BOOT")
  const RESET = partKey(u.id, "RESET")

  describe("boot on the module's USB (SW1 at USB), the USART1 USB plugged for the serial port", () => {
    let snap: Snapshot
    beforeAll(() => {
      loop.setDoc(doc)
      loop.setParts(doc.parts)
      loop.setRunning(true)
      loop.advance(clock)
      snap = run(0.05)
    })

    it("runs the firmware at 50 MHz from the 8 MHz crystal", () => {
      const st = snap.mcus[u.id]
      expect(st?.firmware ?? "none", "MCU loaded").toBe("lab1-f746.elf")
      expect(st?.halted, "halted").toBeFalsy()
      expect(st?.running, "core running").toBe(true)
      expect(st?.sysclk ?? 0, "SYSCLK").toBe(50e6)
      expect(st?.clock.hse ? `${st.clock.hse.kind} ${st.clock.hse.hz / 1e6} MHz` : "none", "HSE").toBe("crystal 8 MHz")
    })

    it("brings up the rails", () => {
      expect.soft(v(snap, "P23-1"), "3V3 rail (P23)").toBeNear(3.3, 0.02)
      expect.soft(v(snap, "P22-1"), "5V rail (P22)").toBeNear(5, 0.05)
      expect.soft(v(snap, "CN2-2"), "Arduino IOREF on 3.3 V").toBeNear(3.3, 0.02)
      expect.soft(v(snap, "P13-17"), "NRST idles high").toBeNear(3.3, 0.02)
      expect.soft(snap.parts[partKey(u.id, "PWR")]?.on, "PWR LED").toBe(true)
    })

    it("pulls joystick C up and holds WAKEUP down", () => {
      expect.soft(v(snap, "P12-8"), "PD4 on P12-8").toBeNear(3.3, 0.05)
      expect.soft(v(snap, "CN3-1"), "PA0 (A0)").toBeNear(0, 0.02)
    })

    it("lights LED1 dimly", () => {
      expect(ledStr(snap)).toBe("●○○○")
      // 1.4 mA through 1 kΩ: a dim LED, as on the real board (8 mA counts as full).
      expect(snap.parts[partKey(u.id, "LED1")]?.level ?? 0).toBeNear(0.18, 0.05)
    })
  })

  describe("staircase: LED2 at 1 s, LED3 at 3 s, LED4 at 6 s, then off from 10 s", () => {
    const onAt: Record<string, number> = {}
    let snap: Snapshot
    beforeAll(() => {
      snap = run(11.5, (s) => {
        for (const l of LEDS) if (onAt[l] === undefined && ledOn(s, l)) onAt[l] = s.time
      })
    })

    it.each([
      ["LED1", 0.03],
      ["LED2", 1.0],
      ["LED3", 3.0],
      ["LED4", 6.0],
    ])("lights %s at %s s", (led, t) => {
      expect(onAt[led] ?? NaN).toBeNear(t, 0.05)
    })

    it("has LED1 and LED2 off again at 11.5 s", () => expect(ledStr(snap)).toBe("○○●●"))
  })

  it("pulls PD4 to ground with joystick C and lifts PA0 with WAKEUP", () => {
    press("JOY_C", true)
    let snap = run(0.05)
    expect.soft(v(snap, "P12-8"), "PD4 while C is pressed").toBeNear(0, 0.05)
    expect.soft(v(snap, "P12-10"), "PD5 untouched").toBeNear(3.3, 0.05)
    press("JOY_C", false)
    press("WAKEUP", true)
    snap = run(0.05)
    expect.soft(v(snap, "P12-8"), "PD4 released").toBeNear(3.3, 0.05)
    expect.soft(v(snap, "CN3-1"), "PA0 while K1 is pressed (÷2 divider)").toBeNear(1.65, 0.05)
    press("WAKEUP", false)
    expect.soft(v(run(0.05), "CN3-1"), "PA0 back down").toBeNear(0, 0.02)
  })

  it("frees PH4 from LED3 (JMP3_3), the joystick from PD4 (JMP4_3) and K1 from PA0 (JMP6) with the jumpers open", () => {
    loop.setParts({
      [partKey(u.id, "JMP3_3")]: { on: false },
      [partKey(u.id, "JMP4_3")]: { on: false },
      [partKey(u.id, "JMP6")]: { on: false },
      [partKey(u.id, "JOY_C")]: { pressed: true },
      [partKey(u.id, "WAKEUP")]: { pressed: true },
    })
    const snap = run(0.1)
    expect.soft(`${ledOn(snap, "LED3") ? "●" : "○"} ${v(snap, "CN4-3").toFixed(1)} V on Arduino D2`, "LED3 dark with PH4 driven high").toBe("○ 3.3 V on Arduino D2")
    expect.soft(v(snap, "P12-8"), "PD4 with C pressed").toBeNear(3.3, 0.05)
    expect.soft(v(snap, "CN3-1"), "PA0 with K1 pressed (pad pull-down only)").toBeNear(0, 0.05)
    loop.setParts({})
    expect.soft(ledOn(run(0.1), "LED3"), "LED3 back").toBe(true)
  })

  describe("RESET", () => {
    it("holds the core", () => {
      press("RESET", true)
      const snap = run(0.1)
      expect.soft(v(snap, "P13-17"), "NRST").toBeNear(0, 0.05)
      expect.soft(snap.mcus[u.id].powered, "core powered").toBe(false)
      expect.soft(ledStr(snap), "LEDs").toBe("○○○○")
    })

    it("restarts it on release", () => {
      press("RESET", false)
      const snap = run(0.1)
      expect.soft(snap.mcus[u.id].running, "core running").toBe(true)
      expect.soft(ledStr(snap), "staircase from the top").toBe("●○○○")
    })
  })

  describe("BOOT to SYSTEM and a reset", () => {
    it("starts the core in system memory and the firmware does not run", () => {
      // setParts replaces the whole map, so the switch is held through the reset explicitly.
      loop.setParts({ [BOOT]: { on: true }, [RESET]: { pressed: true } })
      run(0.05)
      loop.setParts({ [BOOT]: { on: true } })
      const snap = run(0.2)
      expect.soft(v(snap, "BOOT0"), "BOOT0 high (10 kΩ up, the pad's 40 kΩ down)").toBeNear(2.64, 0.05)
      expect.soft(ledStr(snap), "LEDs").toBe("○○○○")
      expect.soft(snap.mcus[u.id].unmodelled.some((x) => /bootloader/.test(x.block)), "system bootloader flagged as unmodelled").toBe(true)
    })

    it("runs the firmware again after a reset at FLASH", () => {
      loop.setParts({ [RESET]: { pressed: true } })
      run(0.05)
      loop.setParts({})
      const snap = run(0.1)
      expect.soft(v(snap, "BOOT0"), "BOOT0").toBeNear(0, 0.05)
      expect.soft(ledStr(snap), "LEDs").toBe("●○○○")
    })
  })

  describe("flashed with BOOT at SYSTEM", () => {
    it("starts the image through the loader's Go", () => {
      loop.setParts({ [BOOT]: { on: true } })
      run(0.05)
      u.props = { ...u.props, firmwareData: Buffer.concat([elf, Buffer.from([0])]).toString("base64") }
      loop.setDoc({ ...doc, objects: doc.objects.map((o) => (o.id === u.id ? { ...o, props: { ...u.props } } : o)) })
      expect(ledStr(run(0.1))).toBe("●○○○")
    })

    it("lands back in the loader on a RESET with BOOT still at SYSTEM", () => {
      loop.setParts({ [BOOT]: { on: true }, [RESET]: { pressed: true } })
      run(0.05)
      loop.setParts({ [BOOT]: { on: true } })
      expect(ledStr(run(0.2))).toBe("○○○○")
    })

    it("runs the image again on a RESET at FLASH", () => {
      loop.setParts({ [RESET]: { pressed: true } })
      run(0.05)
      loop.setParts({})
      expect(ledStr(run(0.1))).toBe("●○○○")
    })
  })

  it("keeps running from the module's own USB with the USART1 USB unplugged", () => {
    loop.setParts({ [partKey(u.id, "USB")]: { on: false } })
    const snap = run(0.1)
    expect.soft(v(snap, "P23-1"), "3V3 rail").toBeNear(3.3, 0.02)
    expect.soft(snap.mcus[u.id].running, "core running").toBe(true)
  })

  it("loses 5 V, 3.3 V and the core with the module's USB unplugged too", () => {
    loop.setParts({ [partKey(u.id, "MUSB")]: { on: false } })
    const snap = run(0.1)
    expect.soft(v(snap, "P22-1"), "5V rail").toBeNear(0, 0.05)
    expect.soft(v(snap, "P23-1"), "3V3 rail").toBeNear(0, 0.05)
    expect.soft(snap.mcus[u.id].powered, "core powered").toBe(false)
    expect.soft(ledStr(snap), "LEDs").toBe("○○○○")
  })

  it("runs from the board's USB with SW1 at 5Vin and the USART1 USB back in (S2 at USB)", () => {
    loop.setParts({ [partKey(u.id, "USB")]: { on: true }, [partKey(u.id, "SW1")]: { on: false } })
    const snap = run(0.3)
    expect.soft(v(snap, "P23-1"), "3V3 rail").toBeNear(3.3, 0.02)
    expect.soft(snap.mcus[u.id].running, "core running").toBe(true)
    expect.soft(snap.mcus[u.id].backupKept, "backup domain kept (VBAT on the jumper died with the rail)").toBe(false)
  })
})

describe("VBAT: a CR2032 on the VBAT pin (jumper open) through a power cut", () => {
  const doc3 = lab1Board.build(GRID)
  const u3 = doc3.objects.find((o) => o.def === "open746i-c")!
  u3.props = { ...u3.props, firmware: "lab1-f746.elf", firmwareData: elf.toString("base64") }
  const cell = { id: "cell", def: "battery", x: 30 * GRID, y: 60 * GRID, props: { chem: "li-mno2", cells: "1", capacity: "220 mAh" } }
  const gnd = { id: "g3", def: "ground", x: 34 * GRID, y: 66 * GRID, props: {} }
  doc3.objects.push(cell, gnd)
  doc3.wires.push(
    { id: "w3", from: { object: cell.id, pin: "+" }, to: { object: u3.id, pin: "VBAT" } },
    { id: "w4", from: { object: gnd.id, pin: "GND" }, to: { object: u3.id, pin: "P24-1" } },
    { id: "w5", from: { object: cell.id, pin: "-" }, to: { object: gnd.id, pin: "GND" } },
  )
  const loop3 = new SimLoop()
  const off = { [partKey(u3.id, "VBATJ")]: { on: false } }
  let t = 0
  const ticks = (n: number) => {
    for (let i = 0; i < n; i++) loop3.advance((t += 30))
    return loop3.snapshot()!
  }

  it("feeds VBAT from the cell", () => {
    loop3.setDoc(doc3)
    loop3.setParts(off)
    loop3.setRunning(true)
    loop3.advance(t)
    expect(ticks(5).pinVoltage[pinKey(u3.id, "VBAT")]).toBeNear(3.2, 0.2)
  })

  it("keeps VBAT up with the core off", () => {
    loop3.setParts({ ...off, [partKey(u3.id, "MUSB")]: { on: false } })
    const s3 = ticks(5)
    expect.soft(s3.mcus[u3.id].powered, "core powered").toBe(false)
    expect.soft(s3.pinVoltage[pinKey(u3.id, "VBAT")], "VBAT").toBeNear(3.2, 0.2)
  })

  it("brings the core back with the backup domain kept", () => {
    loop3.setParts(off)
    const s3 = ticks(8)
    expect.soft(s3.mcus[u3.id].running, "core running").toBe(true)
    expect.soft(s3.mcus[u3.id].backupKept, "backup domain kept").toBe(true)
  })
})

it("comes back on SW1 at 5Vin, S2 to the jack, 5 V on 5VDC, both USBs out", () => {
  const doc2 = lab1Board.build(GRID)
  const u2 = doc2.objects.find((o) => o.def === "open746i-c")!
  u2.props = { ...u2.props, firmware: "lab1-f746.elf", firmwareData: elf.toString("base64") }
  const sup = { id: "sup", def: "supply", x: 5 * GRID, y: -6 * GRID, props: { value: "+5V", voltage: "5 V" } }
  const gnd = { id: "g", def: "ground", x: -6 * GRID, y: 3 * GRID, props: {} }
  doc2.objects.push(sup, gnd)
  doc2.wires.push({ id: "w1", from: { object: sup.id, pin: "V" }, to: { object: u2.id, pin: "5VDC" } }, { id: "w2", from: { object: gnd.id, pin: "GND" }, to: { object: u2.id, pin: "P24-1" } })
  doc2.parts[partKey(u2.id, "USB")] = { on: false }
  doc2.parts[partKey(u2.id, "MUSB")] = { on: false }
  doc2.parts[partKey(u2.id, "SW1")] = { on: false }
  doc2.parts[partKey(u2.id, "S2")] = { on: true }
  const loop2 = new SimLoop()
  loop2.setDoc(doc2)
  loop2.setParts(doc2.parts)
  loop2.setRunning(true)
  let t = 0
  loop2.advance(t)
  for (let i = 0; i < 5; i++) loop2.advance((t += 30))
  const s2 = loop2.snapshot()!
  expect.soft(s2.pinVoltage[pinKey(u2.id, "P23-1")], "3V3 rail from the jack").toBeNear(3.3, 0.02)
  expect.soft(s2.mcus[u2.id].halted, "halted").toBeFalsy()
  expect.soft(s2.mcus[u2.id].running, "core running").toBe(true)
  expect.soft(s2.parts[partKey(u2.id, "LED1")]?.on, "LED1").toBe(true)
})
