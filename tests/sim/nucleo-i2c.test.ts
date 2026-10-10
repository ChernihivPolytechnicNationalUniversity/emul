/**
 * The "Nucleo I²C EEPROM" example co-simulated: the open-drain bus resolved on the field (pull-ups
 * from the rail, the MCU and the EEPROM both pulling low), the EEPROM model answering at the edges'
 * own times, and its contents visible in the snapshot.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoI2c } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import type { EepromSnapshot } from "@/sim/digital"
import { buildNetlist } from "@/sim/netlist"
import { exampleBase64 } from "../lib/firmware"

type Core = { mcu: { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } } }

describe("Nucleo I²C EEPROM", () => {
  const doc = nucleoI2c.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const mem = doc.objects.find((o) => o.def === "eeprom-24c")!
  u.props = { ...u.props, firmware: "nucleo-i2c.elf", firmwareData: exampleBase64("nucleo-i2c.elf") }

  const loop = new SimLoop()
  let clock = 0
  function run(seconds: number) {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
    }
  }
  let core: Core["mcu"]
  const word = (name: string) => core.bus.read32(core.firmware.symbols.find((x) => x.name === name)!.value)
  const eeprom = () => loop.snapshot()!.digital[mem.id] as EepromSnapshot
  let snap: Snapshot

  beforeAll(() => {
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    loop.advance(clock)
    core = (loop as unknown as { mcus: Map<string, { mcu: Core }> }).mcus.get(u.id)!.mcu.mcu
    run(0.06)
    snap = loop.snapshot()!
  })

  it("writes and verifies the greeting", () => {
    expect(snap.mcus[u.id].running, "core running").toBe(true)
    expect.soft(word("verified"), "greeting verified by the firmware").toBe(1)
    expect.soft(word("errors"), "no HAL errors").toBe(0)
    expect.soft(String.fromCharCode(...eeprom().bytes.slice(0, 14)), "EEPROM contents in the snapshot").toBe("Hello, EEPROM!")
  })

  it("idles the bus high on the pull-ups", () => {
    expect.soft(snap.pinVoltage[pinKey(mem.id, "SCL")], "SCL").toBeGreaterThan(3)
    expect.soft(snap.pinVoltage[pinKey(mem.id, "SDA")], "SDA").toBeGreaterThan(3)
  })

  it("lights LD1 for the match and leaves LD3 dark", () => {
    expect.soft(snap.parts[partKey(u.id, "LD1")]?.on ?? false, "LD1").toBe(true)
    expect.soft(snap.parts[partKey(u.id, "LD3")]?.on ?? false, "LD3").toBe(false)
  })

  it("keeps the counter through a restart of the board", () => {
    run(0.3)
    const before = eeprom().bytes[0x40]
    expect(before, "counter written to 0x40").toBeGreaterThanOrEqual(2)
    // Power-cycle the board: the EEPROM keeps its bytes, the firmware picks the count up.
    loop.setRunning(false)
    loop.setRunning(true)
    loop.restart()
    loop.setDoc(doc)
    clock = 0
    loop.advance(0)
    run(0.15)
    snap = loop.snapshot()!
    expect.soft(String.fromCharCode(...eeprom().bytes.slice(0, 5)), "EEPROM kept the greeting through the restart").toBe("Hello")
    expect.soft(eeprom().bytes[0x40], "counter continued from the stored value").toBeGreaterThan(before)
    expect.soft(word("errors"), "no HAL errors after restart").toBe(0)
    expect.soft(snap.mcus[u.id].unmodelled.length, "nothing unmodelled").toBe(0)
  })

  it("RESET tapped through transfers never has the open-drain SDA drive high against the EEPROM's acknowledge", () => {
    const bench = nucleoI2c.build(GRID)
    const board = bench.objects.find((o) => o.def === "nucleo-f429zi")!
    board.props = { ...board.props, firmware: "nucleo-i2c.elf", firmwareData: exampleBase64("nucleo-i2c.elf") }
    const sda = buildNetlist(bench).elements.find((e) => e.object === board.id && e.kind === "GPIO" && e.nodeKey === "CN7-4")!.element
    const tapped = new SimLoop()
    tapped.setDoc(bench)
    tapped.setParts(bench.parts)
    tapped.setRunning(true)
    let at = 0
    let worst = 0
    tapped.advance(at)
    const fine = (ms: number) => {
      const end = at + ms
      while (at < end) {
        tapped.advance((at += 0.2))
        const pad = tapped.snapshot()!.readings.find((r) => r.object === board.id && r.element === sda)
        worst = Math.max(worst, Math.abs(pad?.current ?? 0))
      }
    }
    fine(300)
    const reset = partKey(board.id, "RESET")
    for (let k = 0; k < 20; k++) {
      tapped.setParts({ [reset]: { pressed: true } })
      fine(2 + ((k * 7) % 30))
      tapped.setParts({ [reset]: { pressed: false } })
      fine(2 + ((k * 13) % 40))
    }
    const after = tapped.snapshot()!
    expect.soft(worst * 1e3, "SDA's pad only ever sinks what the 4.7 kΩ pull-up gives (mA)").toBeLessThan(1)
    expect.soft(Object.values(after.damage).map((d) => d.reason), "nothing burnt").toEqual([])
    expect.soft(after.mcus[board.id].running, "the core runs on").toBe(true)
  })
})
