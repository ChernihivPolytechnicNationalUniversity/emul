/**
 * The Netduino Plus 2 (Rev A) board model against the CW0034 schematic (docs/netduino-plus-2/
 * board-checklist.md), without firmware: the Uno-style headers, the power tree, the three power
 * switches off at reset, the LEDs as their transistors leave them, BTN on BOOT0/PB11/PC14, the
 * one-way /RESET buffer. PB2 switching the header rails on is in f405-boards-firmware.test.ts.
 */
import { describe, expect, it } from "vitest"
import { STM32F405RG } from "@/mcu/chip"
import { netduinoPlus2 } from "@/schematic/components/netduino-plus-2"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { EYE_SETTLED } from "../lib/eye"

const pin = (id: string) => netduinoPlus2.pins.find((p) => p.id === id)!

describe("Netduino Plus 2 pins (CW0034 §Arduino headers)", () => {
  it("maps D0–D13, SDA/SCL and A0–A5 to the schematic's MCU pins", () => {
    const want = { D0: "PC7", D1: "PC6", D2: "PA3", D3: "PA2", D4: "PB12", D5: "PB8", D6: "PB9", D7: "PA1", D8: "PA0", D9: "PA6", D10: "PB10", D11: "PB15", D12: "PB14", D13: "PB13", SDA: "PB7", SCL: "PB6", A0: "PC0", A1: "PC1", A2: "PC2", A3: "PC3", A4: "PC4", A5: "PC5" }
    for (const [id, mcu] of Object.entries(want)) expect(pin(id).mcu, id).toBe(mcu)
    expect(pin("AREF").kind).toBe("nc")
  })

  it("puts D0–D7 on one row, 0.1\" apart, D8–SCL beside them, power and analog on the other edge", () => {
    expect(pin("D0").x - pin("D7").x).toBe(7)
    expect(pin("D8").x).toBeLessThan(pin("D7").x)
    expect(pin("SCL").x - pin("D8").x).toBe(-9)
    expect(pin("A5").x - pin("A0").x).toBe(5)
    expect(pin("D0").y).toBe(pin("SCL").y)
    expect(pin("VIN").y - pin("D0").y).toBe(19)
  })

  it("carries the F405RG with a 25 MHz crystal and no LSE", () => {
    expect(netduinoPlus2.chip).toBe(STM32F405RG.id)
    expect(netduinoPlus2.mcuClocks).toMatchObject({ hse: { hz: 25e6, kind: "crystal" }, lse: null })
    expect(netduinoPlus2.mcuBoot0).toBe("$SWITCH1")
  })
})

const { place, wire, doc } = builder(GRID)
const u = place("netduino-plus-2", 0, 0)
const loop = new SimLoop()
const failures: string[] = []
loop.onFailure = (f) => failures.push(`${f.ref}: ${f.damage.reason}`)
let clock = 0
function settle(): Snapshot {
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  const end = clock + EYE_SETTLED * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 30)
    loop.advance(clock)
  }
  return loop.snapshot()!
}
const v = (snap: Snapshot, id: string) => snap.pinVoltage[pinKey(u.id, id)]!
const lit = (snap: Snapshot, id: string) => !!snap.parts[partKey(u.id, id)]?.on

describe("Netduino Plus 2 without firmware", () => {
  it("keeps the header 3V3/5V off while PB2 floats; PWR and the blue LED lit (pulled up)", () => {
    const snap = settle()
    expect.soft(v(snap, "3V3"), "header 3V3 off").toBeLessThan(0.3)
    expect.soft(v(snap, "5V"), "header 5V off").toBeLessThan(0.3)
    expect.soft(lit(snap, "PWR"), "PWR: PC13 floats, Q1 off").toBe(true)
    expect.soft(lit(snap, "LED"), "LED: PA10's 10 kΩ pull-up turns Q3A on").toBe(true)
    expect.soft(failures).toEqual([])
  })

  it("resets the MCU when /RESET is pulled low, through the buffer", () => {
    const ls = place("logic-state", 14, 26)
    const w = wire(ls, "OUT", u, "RESET")
    doc.parts[partKey(ls.id, "S")] = { on: false }
    let snap = settle()
    const nrst = netduinoPlus2.model!.findIndex((e) => e.kind === "C" && e.a === "$NRST")
    const reading = (s: Snapshot) => Math.abs(s.readings.find((r) => r.object === u.id && r.element === nrst)?.voltage ?? NaN)
    expect.soft(reading(snap), "NRST low while /RESET is held").toBeLessThan(0.4)
    doc.parts[partKey(ls.id, "S")] = { on: true }
    snap = settle()
    expect.soft(reading(snap), "NRST back up").toBeGreaterThan(3)
    doc.objects.splice(doc.objects.indexOf(ls), 1)
    doc.wires.splice(doc.wires.indexOf(w), 1)
  })

  it("holds BOOT0 low through 10 kΩ, high while BTN is pressed", () => {
    const r = netduinoPlus2.model!.findIndex((e) => e.kind === "R" && e.a === "$SWITCH1")
    const sw = (s: Snapshot) => Math.abs(s.readings.find((x) => x.object === u.id && x.element === r)?.voltage ?? NaN)
    expect.soft(sw(settle()), "released").toBeLessThan(0.05)
    doc.parts[partKey(u.id, "BTN")] = { pressed: true }
    expect.soft(sw(settle()), "pressed").toBeGreaterThan(3.2)
    doc.parts[partKey(u.id, "BTN")] = { pressed: false }
  })
})
