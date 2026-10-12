import { beforeAll, describe, expect, it } from "vitest"
import { STM32F429ZI, STM32F746IG } from "@/mcu/chip"
import { parsePad, Stm32 } from "@/mcu/stm32f429"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { buffer, example } from "../lib/firmware"

const DONE = 0xc0ffee00
const PB6 = parsePad("PB6")!
const PA0 = parsePad("PA0")!
const PVDO = 1 << 2
const BRE_BRR = 0x208
const MAGIC = 0xb5a7c0de
const EXTI_PENDING = 0x40013c14
const PVD_LINE = 1 << 16

function results(mcu: Stm32) {
  const base = mcu.firmware!.symbols.find((s) => s.name === "results")!.value
  const header = mcu.bus.peek(base, 4)! >>> 0
  const list: number[] = []
  for (let i = 1; i <= (header & 0xff); i++) list.push(mcu.bus.peek(base + 4 * i, 4)! >>> 0)
  return { done: (header & ~0xff) >>> 0 === DONE, list }
}

describe("PVD at PLS = 101 against the core's VDD (DS10916 Table 23: falls below 2.84 V, rises above 2.93 V)", () => {
  const mcu = new Stm32(STM32F746IG)
  mcu.load(buffer(example("exam-pvd.elf")), "exam-pvd.elf")
  const at = (vdd: number) => {
    mcu.setSupply(vdd)
    mcu.run(0.001)
    const { done, list } = results(mcu)
    return { done, edges: list.slice(2), pvdo: mcu.pwr.get("CSR1") & PVDO ? 1 : 0, led: mcu.padDrive(PB6), pending: (mcu.bus.peek(EXTI_PENDING, 4)! & PVD_LINE) !== 0 }
  }

  it("reads PVDO clear at 3.3 V, before and after PVDE", () => {
    const s = at(3.3)
    expect(s.done, "firmware set up").toBe(true)
    expect(results(mcu).list.slice(0, 2)).toEqual([0, 0])
    expect(s.pvdo).toBe(0)
  })

  it("keeps it clear just above the falling threshold", () => {
    expect(at(2.85)).toMatchObject({ pvdo: 0, edges: [] })
  })

  it("sets it below the threshold and takes the EXTI16 interrupt on the rising edge", () => {
    expect(at(2.83)).toMatchObject({ pvdo: 1, edges: [1], led: "high", pending: false })
  })

  it("holds it through the 100 mV hysteresis", () => {
    expect(at(2.92)).toMatchObject({ pvdo: 1, edges: [1] })
  })

  it("clears it above the rising threshold with the interrupt on the falling edge", () => {
    expect(at(2.94)).toMatchObject({ pvdo: 0, edges: [1, 0], led: "low", pending: false })
  })

  it("follows a deep sag and the recovery", () => {
    at(2.0)
    expect(at(3.3)).toMatchObject({ pvdo: 0, edges: [1, 0, 1, 0] })
  })

  it("reports a part it has no PVD thresholds for instead of leaving PVDO silently clear", () => {
    const f429 = new Stm32(STM32F429ZI)
    f429.load(buffer(example("exam-pvd.elf")), "exam-pvd.elf")
    f429.run(0.001)
    expect(f429.unmodelled.summary().map((u) => u.block)).toContain("PVD: no thresholds for this part, PVDO stays 0")
  })
})

describe("PVD on a bare F746 whose VDD a source swings between 3.3 V and 2.7 V at 50 Hz", () => {
  const { doc, place, wire } = builder(GRID)
  const dd = place("stm32f746ig", 0, 0, { firmware: "exam-pvd.elf", firmwareData: example("exam-pvd.elf").toString("base64") })
  const source = place("pulse-source", -12, 0, { high: "3.3 V", low: "2.7 V", freq: "50 Hz", duty: "50", rint: "0.1 Ω" })
  const gnd = place("ground", -12, 8)
  const load = place("resistor", -12, 12, { value: "10 kΩ" })
  wire(dd, "PB6", load, "1")
  wire(load, "2", gnd, "GND")
  wire(source, "+", dd, "VDD")
  wire(source, "+", dd, "VDDA")
  wire(source, "-", gnd, "GND")
  wire(dd, "VSS", gnd, "GND")
  wire(dd, "VSSA", gnd, "GND")
  const loop = new SimLoop()
  let clock = 0
  const runTo = (ms: number) => {
    while (clock < ms) loop.advance((clock = Math.min(ms, clock + 1)))
    return loop.snapshot()!
  }
  const samples: { ms: number; vdd: number; led: number }[] = []

  beforeAll(async () => {
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    loop.advance(clock)
    while (loop.booting) await new Promise((resolve) => setTimeout(resolve, 10))
    for (const ms of [5, 15, 25, 35, 45, 55]) {
      const snap: Snapshot = runTo(ms)
      samples.push({ ms, vdd: snap.pinVoltage[pinKey(dd.id, "VDD")], led: snap.pinVoltage[pinKey(dd.id, "PB6")] })
    }
  })

  it("keeps the core running through the sags", () => {
    expect(loop.snapshot()!.mcus[dd.id]?.running).toBe(true)
  })

  it("drives PB6 from the PVD interrupt: low on the 3.3 V half, high on the 2.7 V half", () => {
    for (const s of samples) {
      const sagging = s.vdd < 3
      expect.soft(s.led, `PB6 at ${s.ms} ms, VDD ${s.vdd.toFixed(2)} V`).toBeNear(sagging ? s.vdd : 0, 0.1)
    }
    expect(samples.filter((s) => s.vdd < 3)).toHaveLength(3)
  })
})

describe("backup SRAM on the F746: kept by its regulator, behind BKPSRAMEN and DBP", () => {
  const mcu = new Stm32(STM32F746IG)
  mcu.load(buffer(example("exam-bkpsram.elf")), "exam-bkpsram.elf")
  const boot = (wakeup: boolean, reset?: () => void) => {
    reset?.()
    mcu.setPad(PA0, wakeup)
    mcu.run(0.01)
    const [clockless, magic, boots, last, breAtBoot, withoutDbp, breAfter, narrow] = results(mcu).list
    return { clockless, magic, boots, last, breAtBoot, withoutDbp, breAfter, narrow, led: mcu.padDrive(PB6) }
  }
  const vbatBackedCut = () => mcu.reset("por", { backup: true })

  it("reads zero with its interface clock off, ignores writes without DBP, takes bytes and halfwords", () => {
    const b = boot(true)
    expect.soft(b.clockless, "BKPSRAMEN clear").toBe(0)
    expect.soft(b.magic, "fresh").toBe(0)
    expect.soft(b.withoutDbp, "written before DBP").toBe(0)
    expect.soft(b.breAfter, "BRE then BRR").toBe(BRE_BRR)
    expect.soft(b.narrow, "byte at 0x10, halfword at 0x12").toBe(0xcdef00ab)
  })

  it("keeps its contents and BRE through a power cut on VBAT with the backup regulator on", () => {
    const b = boot(false, vbatBackedCut)
    expect.soft(b.magic).toBe(MAGIC)
    expect.soft(b.boots).toBe(1)
    expect.soft(b.last, "the last word, 4 KB up").toBe(~MAGIC >>> 0)
    expect.soft(b.breAtBoot, "BRE kept with the backup domain").toBe(BRE_BRR)
    expect.soft(b.led).toBe("high")
  })

  it("loses them through the same cut with the regulator off", () => {
    const b = boot(false, vbatBackedCut)
    expect.soft(b.breAtBoot, "the last boot turned BRE off").toBe(0)
    expect.soft(b.magic).toBe(0)
    expect.soft(b.last).toBe(0)
    expect.soft(b.led).toBe("low")
  })

  it("keeps them through a system reset and a probe reset whatever BRE says: VDD never went", () => {
    expect.soft(boot(false, () => mcu.reset("system")).magic, "system reset").toBe(MAGIC)
    expect.soft(boot(true, () => mcu.reset("por", { backup: true, supplyKept: true })).magic, "probe reset").toBe(MAGIC)
  })

  it("keeps them through Standby only with the regulator on", () => {
    expect.soft(boot(false, () => mcu.reset("standby")).magic, "BRE was on").toBe(MAGIC)
    expect.soft(boot(false, () => mcu.reset("standby")).magic, "BRE was off").toBe(0)
  })

  it("keeps BRE with its ready flag BRR through a system reset, and clears both with a backup-domain reset that keeps VDD", () => {
    boot(true, () => mcu.reset("system"))
    expect.soft(boot(false, () => mcu.reset("system")).breAtBoot, "system reset").toBe(BRE_BRR)
    boot(true, () => mcu.reset("system"))
    expect.soft(boot(false, () => mcu.reset("por", { supplyKept: true })).breAtBoot, "backup domain reset, VDD kept").toBe(0)
  })

  it("loses them and BRE when VBAT goes too", () => {
    boot(true, () => mcu.reset("system"))
    const b = boot(false, () => mcu.reset("por"))
    expect.soft(b.magic).toBe(0)
    expect.soft(b.breAtBoot).toBe(0)
  })
})

describe("backup SRAM on the Open746I-C with a CR2032 on VBAT, through two power cuts", () => {
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "exam-bkpsram.elf", firmwareData: example("exam-bkpsram.elf").toString("base64") }
  const cell = { id: "cell", def: "battery", x: 30 * GRID, y: 60 * GRID, props: { chem: "li-mno2", cells: "1", capacity: "220 mAh" } }
  const gnd = { id: "g", def: "ground", x: 34 * GRID, y: 66 * GRID, props: {} }
  doc.objects.push(cell, gnd)
  doc.wires.push(
    { id: "w1", from: { object: cell.id, pin: "+" }, to: { object: u.id, pin: "VBAT" } },
    { id: "w2", from: { object: gnd.id, pin: "GND" }, to: { object: u.id, pin: "P24-1" } },
    { id: "w3", from: { object: cell.id, pin: "-" }, to: { object: gnd.id, pin: "GND" } },
  )
  const loop = new SimLoop()
  let t = 0
  const ticks = (n: number) => {
    for (let i = 0; i < n; i++) loop.advance((t += 30))
    return loop.snapshot()!
  }
  const battery = { [partKey(u.id, "VBATJ")]: { on: false }, [partKey(u.id, "BOOT")]: { on: false } }
  const unplugged = { [partKey(u.id, "MUSB")]: { on: false } }
  const wakeup = { [partKey(u.id, "WAKEUP")]: { pressed: true } }
  const led1 = (s: Snapshot) => s.parts[partKey(u.id, "LED1")]?.on ?? false

  it("boots with WAKEUP held, which turns the backup regulator on, and finds nothing kept", () => {
    loop.setDoc(doc)
    loop.setParts({ ...battery, ...wakeup })
    loop.setRunning(true)
    loop.advance(t)
    const s = ticks(5)
    expect.soft(s.mcus[u.id].running, "core running").toBe(true)
    expect.soft(led1(s), "LED1").toBe(false)
  })

  it("finds its pattern after a cut with the cell holding VBAT", () => {
    loop.setParts({ ...battery, ...unplugged })
    expect(ticks(5).mcus[u.id].powered, "core off").toBe(false)
    loop.setParts(battery)
    const s = ticks(8)
    expect.soft(s.mcus[u.id].backupKept, "backup domain kept").toBe(true)
    expect.soft(led1(s), "LED1").toBe(true)
  })

  it("loses it over the next cut, which that boot made with the regulator off", () => {
    loop.setParts({ ...battery, ...unplugged })
    ticks(5)
    loop.setParts(battery)
    const s = ticks(8)
    expect.soft(s.mcus[u.id].backupKept, "backup domain kept").toBe(true)
    expect.soft(led1(s), "LED1").toBe(false)
  })

  it("keeps it through a RESET press with the regulator off: VDD stays, so does the backup SRAM", () => {
    loop.setParts({ ...battery, [partKey(u.id, "RESET")]: { pressed: true } })
    expect(ticks(3).mcus[u.id].powered, "held in reset").toBe(false)
    loop.setParts(battery)
    const s = ticks(5)
    expect.soft(s.mcus[u.id].running, "core running").toBe(true)
    expect.soft(led1(s), "LED1").toBe(true)
  })
})
