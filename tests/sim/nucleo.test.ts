/**
 * The Nucleo-144 board model against the "Nucleo blink" example without firmware: supplies,
 * ground, a header pin driven high and low by a logic-state instrument into an LED, the on-board
 * LEDs and the USER button.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoF429zi } from "@/schematic/components/nucleo-f429zi"
import { builder } from "@/schematic/builder"
import { nucleoBlink } from "@/schematic/examples"
import { partKey, pinKey, type PlacedObject } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

const doc = nucleoBlink.build(GRID)
const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
const led = doc.objects.find((o) => o.def === "led")!
const r = doc.objects.find((o) => o.def === "resistor")!

const loop = new SimLoop()
const failures: string[] = []
loop.onFailure = (f) => failures.push(`${f.ref}: ${f.damage.reason}`)

let clock = 0
function run(seconds: number) {
  const end = clock + seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 30)
    loop.advance(clock)
  }
}
function settle(): Snapshot {
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  loop.advance(clock)
  run(0.05)
  const snap = loop.snapshot()
  if (!snap) throw new Error("no snapshot")
  return snap
}

const pinV = (snap: Snapshot, o: PlacedObject, pin: string) => snap.pinVoltage[pinKey(o.id, pin)]!
const reading = (snap: Snapshot, o: PlacedObject, element = 0) => {
  const x = snap.readings.find((x) => x.object === o.id && x.element === element)
  if (!x) throw new Error(`no reading for ${o.props?.ref ?? o.id}`)
  return x
}
const lit = (snap: Snapshot, o: PlacedObject, id: string) => !!snap.parts[partKey(o.id, id)]?.on

// A logic-state instrument on the D13 net stands in for the firmware: 1 drives it high, 0 low.
const { place, wire } = builder(GRID)
const ls = place("logic-state", 32, 12)
doc.objects.push(ls)
doc.wires.push(wire(ls, "OUT", u, "CN7-10"))
const setLevel = (obj: PlacedObject, on: boolean) => (doc.parts[partKey(obj.id, "S")] = { on })

describe("Nucleo-144 without firmware", () => {
  it("has its rails up with D13 driven high", () => {
    setLevel(ls, true)
    const snap = settle()
    expect.soft(pinV(snap, u, "CN8-7"), "+3V3 pin").toBeNearRel(3.3, 0.01)
    expect.soft(pinV(snap, u, "CN8-9"), "+5V pin").toBeNearRel(5, 0.01)
    expect.soft(pinV(snap, u, "CN8-3"), "IOREF follows +3V3").toBeNearRel(3.3, 0.01)
    expect.soft(pinV(snap, u, "CN10-1"), "AVDD follows +3V3").toBeNearRel(3.3, 0.01)
    expect.soft(pinV(snap, u, "CN7-8"), "GND pin").toBeNear(0, 1e-6)
    expect.soft(pinV(snap, u, "CN8-5"), "NRST idles high").toBeNearRel(3.3, 0.01)

    // Logic state (3.3 V through its 25 Ω driver) → 220 Ω → red LED → GND.
    const i = Math.abs(reading(snap, led).current)
    const vLed = reading(snap, led).voltage
    expect.soft(i, "LED current").toBeNearRel((3.3 - vLed) / (220 + 25), 0.02)
    expect.soft(vLed, "LED forward drop").toBeNearRel(1.85, 0.05)
    expect.soft(pinV(snap, u, "CN7-10"), "D13 pin voltage (3.3 V less the driver's drop)").toBeNearRel(3.3 - i * 25, 0.01)
    expect.soft(Math.abs(reading(snap, r).current), "resistor current").toBeNearRel(i, 0.01)
    expect.soft(lit(snap, led, "LED"), "LED lit").toBe(true)
    // Nothing drives the on-board LEDs without firmware.
    expect.soft(lit(snap, u, "LD1"), "LD1 (green, PB0) dark").toBe(false)
    expect.soft(lit(snap, u, "LD2"), "LD2 (blue, PB7) dark").toBe(false)
    expect.soft(lit(snap, u, "LD3"), "LD3 (red, PB14) dark").toBe(false)
  })

  it("sinks D13 low: nothing flows, the LED is dark", () => {
    setLevel(ls, false)
    const snap = settle()
    expect.soft(pinV(snap, u, "CN7-10"), "D13 pin voltage").toBeNear(0, 1e-3)
    expect.soft(Math.abs(reading(snap, led).current), "LED current").toBeNear(0, 1e-9)
    expect.soft(lit(snap, led, "LED"), "LED dark").toBe(false)
  })

  // LD1 shares PB0 with D33 (CN10-31): a level on the header pin lights the green LED.
  it("lights LD1 from D33", () => {
    const ls2 = place("logic-state", 32, 30)
    doc.objects.push(ls2)
    const w = wire(ls2, "OUT", u, "CN10-31")
    doc.wires.push(w)
    setLevel(ls2, true)
    const snap = settle()
    const ld1 = snap.parts[partKey(u.id, "LD1")]
    expect.soft(!!ld1?.on, "LD1 lit").toBe(true)
    // 3.3 V through 510 Ω into a ~2 V green LED.
    expect.soft(ld1?.level ?? 0, "LD1 brightness").toBeNearRel((3.3 - 2.0) / 510 / 8e-3, 0.15)
    doc.objects.splice(doc.objects.indexOf(ls2), 1)
    doc.wires.splice(doc.wires.indexOf(w), 1)
  })

  // D11 and D71 are one MCU pin (PA7): a level on one header shows on the other.
  it("shares PA7 between D11 and D71", () => {
    const ls3 = place("logic-state", 32, 34)
    doc.objects.push(ls3)
    const w = wire(ls3, "OUT", u, "CN7-14")
    doc.wires.push(w)
    setLevel(ls3, true)
    const snap = settle()
    expect.soft(pinV(snap, u, "CN7-14"), "D11 voltage").toBeNearRel(3.3, 0.01)
    expect.soft(pinV(snap, u, "CN9-15"), "D71 voltage").toBeNearRel(3.3, 0.01)
    doc.objects.splice(doc.objects.indexOf(ls3), 1)
    doc.wires.splice(doc.wires.indexOf(w), 1)
  })

  // Unplug USB → rails collapse; a 9 V alkaline on VIN brings them back through the regulators;
  // a short on +5V folds the USB port back to 500 mA instead of burning.
  it("follows its power tree", () => {
    setLevel(ls, false)
    doc.parts[partKey(u.id, "USB")] = { on: false }
    let snap = settle()
    expect.soft(pinV(snap, u, "CN8-7"), "+3V3 with USB unplugged").toBeNear(0, 1e-3)
    expect.soft(pinV(snap, u, "CN8-9"), "+5V with USB unplugged").toBeNear(0, 1e-3)
    const bat = place("battery", 20, 60, { chem: "alkaline", cells: "6", capacity: "500 mAh", soc: "100" })
    doc.objects.push(bat)
    const w1 = wire(bat, "+", u, "CN8-15")
    const w2 = wire(bat, "-", u, "CN8-11")
    doc.wires.push(w1, w2)
    snap = settle()
    expect.soft(pinV(snap, u, "CN8-9"), "+5V from VIN regulator").toBeNearRel(5, 0.01)
    expect.soft(pinV(snap, u, "CN8-7"), "+3V3 from LDO").toBeNearRel(3.3, 0.01)
    const vinReg = nucleoF429zi.model!.findIndex((el) => el.kind === "REG" && el.in === "CN8-15")
    expect.soft(reading(snap, u, vinReg).extra?.mode, "VIN regulator mode").toBe("regulating")
    // Load the 3.3 V rail with 33 Ω (100 mA): the battery must deliver it through both regulators.
    const load = place("resistor", 40, 60, { value: "33 Ω", power: "1" })
    doc.objects.push(load)
    const w3 = wire(load, "1", u, "CN8-7")
    const w4 = wire(load, "2", u, "CN8-13")
    doc.wires.push(w3, w4)
    snap = settle()
    expect.soft(pinV(snap, u, "CN8-7"), "+3V3 under 100 mA load").toBeNearRel(3.3, 0.01)
    // The load plus the idle MCU (~12 mA at 16 MHz HSI without firmware).
    expect.soft(Math.abs(reading(snap, bat).current), "battery current ≈ load + MCU idle").toBeNearRel(0.112, 0.05)
    // Short +5V to ground with USB plugged back in: the port limits at 500 mA, nothing burns.
    doc.objects.splice(doc.objects.indexOf(bat), 1)
    doc.objects.splice(doc.objects.indexOf(load), 1)
    for (const w of [w1, w2, w3, w4]) doc.wires.splice(doc.wires.indexOf(w), 1)
    doc.parts[partKey(u.id, "USB")] = { on: true }
    const shortR = place("resistor", 40, 64, { value: "1 Ω", power: "5" })
    doc.objects.push(shortR)
    const w5 = wire(shortR, "1", u, "CN8-9")
    const w6 = wire(shortR, "2", u, "CN8-13")
    doc.wires.push(w5, w6)
    snap = settle()
    const usbReg = nucleoF429zi.model!.findIndex((el) => el.kind === "REG" && el.in === "$usbsw")
    expect.soft(reading(snap, u, usbReg).current, "USB port current into 1 Ω short").toBeNearRel(0.5, 0.01)
    expect.soft(reading(snap, u, usbReg).extra?.mode, "USB port mode").toBe("current limit")
    expect.soft(failures, "nothing burnt").toEqual([])
    doc.objects.splice(doc.objects.indexOf(shortR), 1)
    for (const w of [w5, w6]) doc.wires.splice(doc.wires.indexOf(w), 1)
    setLevel(ls, true)
  })

  // PC13 reads low, high while pressed. RESET pulls NRST to ground.
  it("reads the USER and RESET buttons", () => {
    // PC13 reaches no header pin, so it is read across its 100 kΩ pull-down.
    const pullDown = nucleoF429zi.model!.findIndex((el) => el.kind === "R" && el.a === "$PC13")
    const pc13 = (snap: Snapshot) => Math.abs(reading(snap, u, pullDown).voltage)
    expect.soft(pc13(settle()), "PC13 released").toBeNear(0, 1e-6)
    doc.parts[partKey(u.id, "B1")] = { pressed: true }
    expect.soft(pc13(settle()), "PC13 pressed").toBeNearRel(3.3, 0.01)
    doc.parts[partKey(u.id, "B1")] = { pressed: false }
    doc.parts[partKey(u.id, "RESET")] = { pressed: true }
    // A few µV across the closed switch.
    expect.soft(pinV(settle(), u, "CN8-5"), "NRST while RESET held").toBeNear(0, 1e-3)
    doc.parts[partKey(u.id, "RESET")] = { pressed: false }
  })
})
