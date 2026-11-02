/**
 * The STM32F4-Discovery board model (MB997) against UM1472 Rev 9 and the MB997 schematics, without
 * firmware: the P1/P2 map, the power tree (D1, LD3985M33R, D3, JP1), the user LEDs and their
 * resistors, B1 and B2, the boot straps. Values from docs/stm32f4-discovery/board-checklist.md.
 */
import { describe, expect, it } from "vitest"
import { STM32F407VG } from "@/mcu/chip"
import { stm32f4Discovery } from "@/schematic/components/stm32f4-discovery"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { EYE_SETTLED } from "../lib/eye"

/** UM1472 Table 7 / SCH-B sheet 1, P1 then P2, pin 1 to 50. */
const P1 = "GND GND VDD VDD GND NRST PC1 PC0 PC3 PC2 PA1 PA0 PA3 PA2 PA5 PA4 PA7 PA6 PC5 PC4 PB1 PB0 GND PB2 PE7 PE8 PE9 PE10 PE11 PE12 PE13 PE14 PE15 PB10 PB11 PB12 PB13 PB14 PB15 PD8 PD9 PD10 PD11 PD12 PD13 PD14 PD15 NC GND GND"
const P2 = "GND GND 5V 5V 3V 3V PH0 PH1 PC14 PC15 PE6 PC13 PE4 PE5 PE2 PE3 PE0 PE1 PB8 PB9 BOOT0 VDD PB6 PB7 PB4 PB5 PD7 PB3 PD5 PD6 PD3 PD4 PD1 PD2 PC12 PD0 PC10 PC11 PA14 PA15 PA10 PA13 PA8 PA9 PC8 PC9 PC6 PC7 GND GND"

describe("STM32F4-Discovery pins (UM1472 Table 7)", () => {
  it("has P1 and P2 pin for pin, odd pins in the left column", () => {
    for (const [name, list] of [["P1", P1], ["P2", P2]] as const)
      list.split(" ").forEach((label, i) => {
        const pin = stm32f4Discovery.pins.find((p) => p.id === `${name}-${i + 1}`)
        expect(pin?.label, `${name}-${i + 1}`).toBe(label)
        const sibling = stm32f4Discovery.pins.find((p) => p.id === `${name}-${i % 2 === 0 ? i + 2 : i}`)!
        expect(pin!.y, `${name}-${i + 1} row`).toBe(sibling.y)
        if (i % 2 === 0) expect(pin!.x, `${name}-${i + 1} left of its pair`).toBeLessThan(sibling.x)
      })
  })

  it("wires every LQFP100 GPIO but PA11/PA12 (USB on CN5) to a header; PH0/PH1 stay off it (SB13/SB14 open)", () => {
    const wired = new Set(stm32f4Discovery.pins.map((p) => p.mcu).filter(Boolean))
    const lqfp100 = ["A", "B", "C", "D", "E"].flatMap((port) => Array.from({ length: 16 }, (_, i) => `P${port}${i}`))
    expect(lqfp100.filter((p) => !wired.has(p))).toEqual(["PA11", "PA12"])
    expect(wired.has("PH0") || wired.has("PH1")).toBe(false)
  })

  it("puts the headers 53.34 mm apart and pins on 2.54 mm", () => {
    const p1 = stm32f4Discovery.pins.find((p) => p.id === "P1-1")!
    const p2 = stm32f4Discovery.pins.find((p) => p.id === "P2-2")!
    expect(p2.x - p1.x).toBe(21)
    expect(stm32f4Discovery.pins.find((p) => p.id === "P1-49")!.y - p1.y).toBe(24)
  })

  it("carries the STM32F407VG with an 8 MHz HSE and no LSE crystal (X3 not fitted)", () => {
    expect(stm32f4Discovery.chip).toBe(STM32F407VG.id)
    expect(stm32f4Discovery.mcuClocks?.hse?.hz).toBe(8e6)
    expect(stm32f4Discovery.mcuClocks?.lse).toBeNull()
  })
})

const { place, wire, doc: built } = builder(GRID)
const doc: Schematic = built
const u = place("stm32f4-discovery", 0, 0)

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
const pinV = (snap: Snapshot, o: PlacedObject, pin: string) => snap.pinVoltage[pinKey(o.id, pin)]!
const part = (snap: Snapshot, id: string) => snap.parts[partKey(u.id, id)]
function drive(pin: string, on: boolean) {
  const ls = place("logic-state", 40, 20)
  const w = wire(ls, "OUT", u, pin)
  doc.parts[partKey(ls.id, "S")] = { on }
  return () => {
    doc.objects.splice(doc.objects.indexOf(ls), 1)
    doc.wires.splice(doc.wires.indexOf(w), 1)
  }
}

describe("STM32F4-Discovery without firmware", () => {
  it("runs 5V behind D1, 3V behind the LD3985M33R and D3, VDD through JP1; LD2 PWR lit", () => {
    const snap = settle()
    // BAT60J: 0.28 V at 10 mA, a little less at the board's few mA.
    expect.soft(pinV(snap, u, "P2-3"), "5V").toBeGreaterThan(4.68)
    expect.soft(pinV(snap, u, "P2-3"), "5V").toBeLessThan(4.8)
    expect.soft(pinV(snap, u, "P2-5"), "3V = 3.3 V less one Schottky").toBeGreaterThan(2.98)
    expect.soft(pinV(snap, u, "P2-5"), "3V").toBeLessThan(3.1)
    expect.soft(pinV(snap, u, "P1-3"), "VDD with JP1 on").toBeNearRel(pinV(snap, u, "P2-5"), 0.001)
    expect.soft(pinV(snap, u, "P1-6"), "NRST idles high").toBeNearRel(pinV(snap, u, "P1-3"), 0.01)
    expect.soft(!!part(snap, "LD2")?.on, "LD2 PWR").toBe(true)
    for (const ld of ["LD3", "LD4", "LD5", "LD6"]) expect.soft(!!part(snap, ld)?.on, `${ld} dark without firmware`).toBe(false)
    expect.soft(failures).toEqual([])
  })

  it("lights LD4 green from PD12 through 510 Ω and LD6 blue from PD15 through 680 Ω", () => {
    const undo4 = drive("P1-44", true)
    let snap = settle()
    expect.soft(!!part(snap, "LD4")?.on, "LD4").toBe(true)
    undo4()
    const undo6 = drive("P1-47", true)
    snap = settle()
    expect.soft(!!part(snap, "LD6")?.on, "LD6").toBe(true)
    expect.soft(!!part(snap, "LD4")?.on, "LD4 off again").toBe(false)
    undo6()
  })

  it("reads B1 on PA0: low through 220 kΩ, high when pressed; B2 pulls NRST down", () => {
    let snap = settle()
    expect.soft(pinV(snap, u, "P1-12"), "PA0 released").toBeNear(0, 0.01)
    doc.parts[partKey(u.id, "B1")] = { pressed: true }
    snap = settle()
    expect.soft(pinV(snap, u, "P1-12"), "PA0 pressed").toBeNearRel(pinV(snap, u, "P1-3"), 0.01)
    doc.parts[partKey(u.id, "B1")] = { pressed: false }
    doc.parts[partKey(u.id, "B2")] = { pressed: true }
    snap = settle()
    expect.soft(pinV(snap, u, "P1-6"), "NRST held").toBeNear(0, 0.01)
    doc.parts[partKey(u.id, "B2")] = { pressed: false }
  })

  it("holds BOOT0 low (510 Ω vs 10 kΩ), BOOT1 high, the codec in reset and the OTG switch off", () => {
    const snap = settle()
    const vdd = pinV(snap, u, "P1-3")
    expect.soft(pinV(snap, u, "P2-21"), "BOOT0 = 510/(10k+510)·VDD").toBeNearRel((vdd * 510) / 10510, 0.02)
    expect.soft(pinV(snap, u, "P1-24"), "BOOT1 (PB2) pulled up").toBeNearRel(vdd, 0.01)
    expect.soft(pinV(snap, u, "P2-32"), "PD4 (CS43L22 RESET̅) pulled down").toBeNear(0, 0.01)
    expect.soft(pinV(snap, u, "P1-8"), "PC0 (STMPS2141 EN̅) pulled up to 3V").toBeNearRel(pinV(snap, u, "P2-5"), 0.01)
    expect.soft(pinV(snap, u, "P2-23"), "PB6 SCL pull-up").toBeNearRel(vdd, 0.01)
    expect.soft(!!part(snap, "LD8")?.on, "LD8 dark while FAULT̅ is pulled up").toBe(false)
  })

  it("drops VDD when JP1 comes off; 3V and LD2 stay", () => {
    doc.parts[partKey(u.id, "JP1")] = { on: false }
    const snap = settle()
    expect.soft(pinV(snap, u, "P1-3"), "VDD").toBeLessThan(0.5)
    expect.soft(pinV(snap, u, "P2-5"), "3V").toBeGreaterThan(2.98)
    expect.soft(!!part(snap, "LD2")?.on, "LD2").toBe(true)
    doc.parts[partKey(u.id, "JP1")] = { on: true }
  })
})
