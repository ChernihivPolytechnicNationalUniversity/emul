/**
 * The WeAct Black Pill (MiniF4x1Cx V3.1) board model against the V3.1 schematic and board-shape
 * drawing (docs/blackpill-f411/SUMMARY.md), without firmware.
 */
import { describe, expect, it } from "vitest"
import { STM32F401CC, STM32F401CE, STM32F411CE } from "@/mcu/chip"
import { weactBlackpillF401cc, weactBlackpillF401ce, weactBlackpillF411 } from "@/schematic/components/weact-blackpill"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PlacedObject } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { EYE_SETTLED } from "../lib/eye"

/** S31 P1 and P2, pin 1 to 20, as the BS31 silkscreen labels them. */
const P1 = "5V G 3V3 B10 B2 B1 B0 A7 A6 A5 A4 A3 A2 A1 A0 R C15 C14 C13 VB"
const P2 = "B12 B13 B14 B15 A8 A9 A10 A11 A12 A15 B3 B4 B5 B6 B7 B8 B9 5V G 3V3"
const pin = (id: string) => weactBlackpillF411.pins.find((p) => p.id === id)!

describe("WeAct Black Pill pins (S31, BS31)", () => {
  it("has P1 and P2 pin for pin", () => {
    for (const [name, list] of [["P1", P1], ["P2", P2]] as const) list.split(" ").forEach((label, i) => expect(pin(`${name}-${i + 1}`).label, `${name}-${i + 1}`).toBe(label))
  })

  it("wires every lettered pin to its MCU pad and R to NRST", () => {
    for (const p of weactBlackpillF411.pins) {
      const m = /^([ABC])(\d+)$/.exec(p.label)
      if (m) expect(p.mcu, p.id).toBe(`P${m[1]}${m[2]}`)
    }
    expect(pin("P1-16").mcu).toBe("NRST")
  })

  it("lays the rows out as BS31 does: 0.1\" pitch, 15.2 mm (6 cells) apart, pin 1 of both rows at the USB end", () => {
    expect(pin("P1-2").x - pin("P1-1").x).toBe(1)
    expect(pin("P1-20").x - pin("P1-1").x).toBe(19)
    expect(pin("P2-1").x).toBe(pin("P1-1").x)
    expect(pin("P2-1").y - pin("P1-1").y).toBe(6)
  })

  it("leaves PA13/PA14 (SWD) and PH0/PH1 (HSE) off the rows; the UFQFPN48 has no PB11", () => {
    const rows = new Set(weactBlackpillF411.pins.filter((p) => p.connector !== "P3").map((p) => p.mcu))
    for (const p of ["PA13", "PA14", "PH0", "PH1", "PB11"]) expect(rows.has(p), p).toBe(false)
  })

  it("brings SWDIO (PA13) and SWCLK (PA14) out on P3 between 3V3 and GND (S31)", () => {
    expect([1, 2, 3, 4].map((n) => pin(`P3-${n}`).mcu ?? pin(`P3-${n}`).label)).toEqual(["3V3", "PA13", "PA14", "GND"])
  })

  it("carries the F411CE with a 25 MHz and a 32.768 kHz crystal", () => {
    expect(weactBlackpillF411.chip).toBe(STM32F411CE.id)
    expect(weactBlackpillF411.mcuClocks).toMatchObject({ hse: { hz: 25e6, kind: "crystal" }, lse: { hz: 32768, kind: "crystal" } })
  })
})

describe.each([
  { def: weactBlackpillF401cc, chip: STM32F401CC, marking: ["STM32F401", "CCU6"] },
  { def: weactBlackpillF401ce, chip: STM32F401CE, marking: ["STM32F401", "CEU6"] },
])("$def.name: the same V3.1 PCB with an F401 (STM32F4X1CXU6 on every schematic)", ({ def, chip, marking }) => {
  it("carries its chip, marked on U1", () => {
    expect(def.chip).toBe(chip.id)
    const texts = def.body.filter((b) => b.type === "text").map((b) => (b as { text: string }).text)
    expect(texts).toEqual(expect.arrayContaining(marking))
  })
  it("has the F411 board's pins, rails and parts", () => {
    expect(def.pins.map((p) => [p.id, p.label, p.mcu ?? null])).toEqual(weactBlackpillF411.pins.map((p) => [p.id, p.label, p.mcu ?? null]))
    expect(def.parts.map((p) => p.id)).toEqual(weactBlackpillF411.parts.map((p) => p.id))
  })
  it("does not call PA0/PB5 TC: every F401 pad is FT (DS9716/DS10086 Table 8)", () => {
    for (const id of ["P1-15", "P2-13"]) expect(def.pins.find((p) => p.id === id)!.note ?? "", id).not.toMatch(/TC/)
    for (const id of ["P1-15", "P2-13"]) expect(weactBlackpillF411.pins.find((p) => p.id === id)!.note, id).toMatch(/TC/)
  })
})

const { place, wire, doc } = builder(GRID)
const u = place("weact-blackpill-f411", 0, 0)
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

describe("WeAct Black Pill without firmware", () => {
  it("powers 3V3 from USB-C through D4 and the ME6231A33; PWR lit, C13 dark", () => {
    const snap = settle()
    expect.soft(v(snap, u, "P1-1"), "5V = VBUS less one Schottky").toBeGreaterThan(4.7)
    expect.soft(v(snap, u, "P1-1"), "5V").toBeLessThan(5)
    expect.soft(v(snap, u, "P1-3"), "3V3").toBeNearRel(3.3, 0.005)
    expect.soft(v(snap, u, "P2-20"), "3V3 on P2").toBeNearRel(v(snap, u, "P1-3"), 0.001)
    expect.soft(v(snap, u, "P2-18"), "5V on P2").toBeNearRel(v(snap, u, "P1-1"), 0.001)
    expect.soft(lit(snap, "PWR"), "PWR").toBe(true)
    expect.soft(lit(snap, "C13"), "C13 dark: PC13 floats").toBe(false)
    expect.soft(failures).toEqual([])
  })

  it("lights C13 when PC13 is pulled low", () => {
    const ls = place("logic-state", 10, 20)
    const w = wire(ls, "OUT", u, "P1-19")
    doc.parts[partKey(ls.id, "S")] = { on: false }
    expect(lit(settle(), "C13")).toBe(true)
    doc.objects.splice(doc.objects.indexOf(ls), 1)
    doc.wires.splice(doc.wires.indexOf(w), 1)
  })

  it("pulls PA0 to GND through 330 Ω while KEY is held; NRST pulls R down", () => {
    doc.parts[partKey(u.id, "KEY")] = { pressed: true }
    expect.soft(v(settle(), u, "P1-15"), "PA0 pressed").toBeNear(0, 0.01)
    doc.parts[partKey(u.id, "KEY")] = { pressed: false }
    doc.parts[partKey(u.id, "NRST")] = { pressed: true }
    expect.soft(v(settle(), u, "P1-16"), "NRST held").toBeNear(0, 0.01)
    doc.parts[partKey(u.id, "NRST")] = { pressed: false }
    expect.soft(v(settle(), u, "P1-16"), "NRST released: the MCU's own pull-up, R4 not fitted").toBeNearRel(3.3, 0.01)
  })

  it("puts 3V3 and GND on P3", () => {
    const snap = settle()
    expect.soft(v(snap, u, "P3-1"), "P3 3V3").toBeNearRel(v(snap, u, "P1-3"), 0.001)
    expect.soft(v(snap, u, "P3-4"), "P3 GND").toBeNear(0, 1e-6)
  })

  it("holds PB2 (BOOT1) low through R3 10 kΩ", () => {
    expect(v(settle(), u, "P1-5")).toBeNear(0, 0.01)
  })

  it("drops 3V3 with USB unplugged", () => {
    doc.parts[partKey(u.id, "USB")] = { on: false }
    expect(v(settle(), u, "P1-3")).toBeLessThan(0.1)
    doc.parts[partKey(u.id, "USB")] = { on: true }
  })
})
