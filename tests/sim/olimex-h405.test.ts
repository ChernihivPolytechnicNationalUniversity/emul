/**
 * The Olimex STM32-H405 (Rev. C) board model against its user manual, Rev. C schematic and
 * dimension drawing (docs/olimex-h405/board-checklist.md), without firmware.
 */
import { describe, expect, it } from "vitest"
import { STM32F405RG } from "@/mcu/chip"
import { olimexStm32H405 } from "@/schematic/components/olimex-stm32-h405"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PlacedObject } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { EYE_SETTLED } from "../lib/eye"

/** UM §6.3.1 / §6.3.2, pin 1 to 26. */
const EXT1 = "PA11 PA8 PA12 PA9 3.3V GND PA10 PC10 PC11 PC12 PD2 PB5 PB6 PA6 PB7 PB8 PB9 PA5 PC0 PC1 PB0 PA7 VBAT PC13 RST PB1"
const EXT2 = "VDDA PC2 AGND PA0 3.3V GND PA2 PA1 PC3 PA3 PA4 PC4 PC5 PB10 PB11 PB13 PB12 PB14 PB15 PC6 PC7 PC8 +5V_USB PC9 GND VIN"
const pin = (id: string) => olimexStm32H405.pins.find((p) => p.id === id)!

describe("Olimex STM32-H405 pins (UM §6.3)", () => {
  it("has EXT1 and EXT2 pin for pin", () => {
    for (const [name, list] of [["EXT1", EXT1], ["EXT2", EXT2]] as const) list.split(" ").forEach((label, i) => expect(pin(`${name}-${i + 1}`).label, `${name}-${i + 1}`).toBe(label))
  })

  it("lays the headers out as the dimension drawing does: 0.1\" pitch, 1000 mil between centre-lines, EXT2 pin 1 above EXT1 pin 25", () => {
    expect(pin("EXT2-3").x - pin("EXT2-1").x).toBe(-1)
    expect(pin("EXT1-3").x - pin("EXT1-1").x).toBe(1)
    expect(pin("EXT2-1").y - pin("EXT2-2").y).toBe(1)
    expect(pin("EXT1-2").y - pin("EXT1-1").y).toBe(1)
    expect((pin("EXT1-1").y + pin("EXT1-2").y) / 2 - (pin("EXT2-1").y + pin("EXT2-2").y) / 2).toBe(10)
    expect(pin("EXT2-1").x).toBe(pin("EXT1-25").x)
  })

  it("leaves PA13/PA14/PA15/PB3/PB4 (JTAG), PB2, PC14/PC15 and PH0/PH1 off the headers", () => {
    const wired = new Set(olimexStm32H405.pins.map((p) => p.mcu))
    for (const p of ["PA13", "PA14", "PA15", "PB3", "PB4", "PB2", "PC14", "PC15", "PH0", "PH1"]) expect(wired.has(p), p).toBe(false)
  })

  it("carries the F405RG with an 8 MHz and a 32.768 kHz crystal", () => {
    expect(olimexStm32H405.chip).toBe(STM32F405RG.id)
    expect(olimexStm32H405.mcuClocks).toMatchObject({ hse: { hz: 8e6, kind: "crystal" }, lse: { hz: 32768, kind: "crystal" } })
  })
})

const { place, wire, doc } = builder(GRID)
const u = place("olimex-stm32-h405", 0, 0)
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
const v = (snap: Snapshot, o: PlacedObject, id: string) => snap.pinVoltage[pinKey(o.id, id)]!
const lit = (snap: Snapshot, id: string) => !!snap.parts[partKey(u.id, id)]?.on

describe("Olimex STM32-H405 without firmware", () => {
  it("powers 3.3V from USB through D1 and the LM1117 (240 Ω / 390 Ω, 60 µA adjust current); PWR lit, STAT dark", () => {
    const snap = settle()
    expect.soft(v(snap, u, "EXT2-23"), "+5V_USB").toBeNearRel(5, 0.01)
    expect.soft(v(snap, u, "EXT1-5"), "3.3V = 1.25 V × (1 + 390/240) + 60 µA × 390 Ω").toBeNearRel(3.305, 0.005)
    expect.soft(v(snap, u, "EXT2-26"), "VIN = 5 V less one 1N5819").toBeGreaterThan(4.75)
    expect.soft(v(snap, u, "EXT2-1"), "VDDA").toBeNearRel(v(snap, u, "EXT1-5"), 0.001)
    expect.soft(v(snap, u, "EXT1-23"), "VBAT jumpered to 3.3V").toBeNearRel(v(snap, u, "EXT1-5"), 0.001)
    expect.soft(lit(snap, "PWR"), "PWR").toBe(true)
    expect.soft(lit(snap, "STAT"), "STAT dark: PC12 floats").toBe(false)
    expect.soft(failures).toEqual([])
  })

  it("lights STAT when PC12 is pulled low", () => {
    const ls = place("logic-state", 10, 20)
    const w = wire(ls, "OUT", u, "EXT1-10")
    doc.parts[partKey(ls.id, "S")] = { on: false }
    expect(lit(settle(), "STAT")).toBe(true)
    doc.objects.splice(doc.objects.indexOf(ls), 1)
    doc.wires.splice(doc.wires.indexOf(w), 1)
  })

  it("reads BUT on PA0 high through 10 kΩ, low when pressed; RESET pulls RST down", () => {
    let snap = settle()
    expect.soft(v(snap, u, "EXT2-4"), "PA0 released").toBeNearRel(v(snap, u, "EXT1-5"), 0.01)
    doc.parts[partKey(u.id, "BUT")] = { pressed: true }
    snap = settle()
    expect.soft(v(snap, u, "EXT2-4"), "PA0 pressed").toBeNear(0, 0.01)
    doc.parts[partKey(u.id, "BUT")] = { pressed: false }
    doc.parts[partKey(u.id, "RESET")] = { pressed: true }
    expect.soft(v(settle(), u, "EXT1-25"), "RST held").toBeNear(0, 0.01)
    doc.parts[partKey(u.id, "RESET")] = { pressed: false }
  })

  it("senses VBUS on PC4 through 15 kΩ / 22 kΩ, not on PA9", () => {
    const snap = settle()
    expect.soft(v(snap, u, "EXT2-12"), "PC4 = 5 V × 22/37").toBeNearRel((5 * 22) / 37, 0.02)
    doc.parts[partKey(u.id, "USB")] = { on: false }
    const off = settle()
    expect.soft(v(off, u, "EXT2-12"), "PC4 without USB").toBeNear(0, 0.01)
    expect.soft(v(off, u, "EXT1-5"), "3.3V without USB").toBeLessThan(0.1)
    doc.parts[partKey(u.id, "USB")] = { on: true }
  })
})
