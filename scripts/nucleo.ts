/**
 * Marks the Nucleo-144 board model against the "Nucleo blink" example without firmware:
 * supplies, ground, a header pin driven high and low by a logic-state instrument into an LED,
 * the on-board LEDs and the USER button.
 *
 *   pnpm nucleo
 *
 * Exit code 1 when any check is outside its tolerance.
 */
import { GRID } from "@/schematic/geometry"
import { nucleoF429zi } from "@/schematic/components/nucleo-f429zi"
import { builder } from "@/schematic/builder"
import { nucleoBlink } from "@/schematic/examples"
import { partKey, pinKey, type PlacedObject } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { formatSI } from "@/sim/units"

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

const pinV = (snap: Snapshot, o: PlacedObject, pin: string) => snap.pinVoltage[pinKey(o.id, pin)]
const reading = (snap: Snapshot, o: PlacedObject, element = 0) => {
  const x = snap.readings.find((x) => x.object === o.id && x.element === element)
  if (!x) throw new Error(`no reading for ${o.props?.ref ?? o.id}`)
  return x
}
const part = (snap: Snapshot, o: PlacedObject, id: string) => snap.parts[partKey(o.id, id)]

type Check = { block: string; what: string; got: number; want: number; tol: number; unit: string; note?: string }
const checks: Check[] = []
const expect = (c: Check) => checks.push(c)

// A logic-state instrument on the D13 net stands in for the firmware: 1 drives it high, 0 low.
const { place, wire } = builder(GRID)
const ls = place("logic-state", 32, 12)
doc.objects.push(ls)
doc.wires.push(wire(ls, "OUT", u, "CN7-10"))
const setLevel = (obj: PlacedObject, on: boolean) => (doc.parts[partKey(obj.id, "S")] = { on })
setLevel(ls, true)

// 1. Rails, with D13 driven high.
{
  const snap = settle()
  expect({ block: "Rails", what: "+3V3 pin", got: pinV(snap, u, "CN8-7")!, want: 3.3, tol: 0.01, unit: "V" })
  expect({ block: "Rails", what: "+5V pin", got: pinV(snap, u, "CN8-9")!, want: 5, tol: 0.01, unit: "V" })
  expect({ block: "Rails", what: "IOREF follows +3V3", got: pinV(snap, u, "CN8-3")!, want: 3.3, tol: 0.01, unit: "V" })
  expect({ block: "Rails", what: "AVDD follows +3V3", got: pinV(snap, u, "CN10-1")!, want: 3.3, tol: 0.01, unit: "V" })
  expect({ block: "Rails", what: "GND pin", got: pinV(snap, u, "CN7-8")!, want: 0, tol: 0, unit: "V" })
  expect({ block: "Rails", what: "NRST idles high", got: pinV(snap, u, "CN8-5")!, want: 3.3, tol: 0.01, unit: "V" })

  // Logic state (3.3 V through its 25 Ω driver) → 220 Ω → red LED → GND.
  const i = Math.abs(reading(snap, led).current)
  const vLed = reading(snap, led).voltage
  expect({ block: "D13 high", what: "LED current", got: i, want: (3.3 - vLed) / (220 + 25), tol: 0.02, unit: "A" })
  expect({ block: "D13 high", what: "LED forward drop", got: vLed, want: 1.85, tol: 0.05, unit: "V" })
  expect({ block: "D13 high", what: "D13 pin voltage (3.3 V less the driver's drop)", got: pinV(snap, u, "CN7-10")!, want: 3.3 - i * 25, tol: 0.01, unit: "V" })
  expect({ block: "D13 high", what: "resistor current", got: Math.abs(reading(snap, r).current), want: i, tol: 0.01, unit: "A" })
  expect({ block: "D13 high", what: "LED lit", got: part(snap, led, "LED")?.on ? 1 : 0, want: 1, tol: 0, unit: "" })
  // Nothing drives the on-board LEDs without firmware.
  expect({ block: "On-board", what: "LD1 (green, PB0) dark", got: part(snap, u, "LD1")?.on ? 1 : 0, want: 0, tol: 0, unit: "" })
  expect({ block: "On-board", what: "LD2 (blue, PB7) dark", got: part(snap, u, "LD2")?.on ? 1 : 0, want: 0, tol: 0, unit: "" })
  expect({ block: "On-board", what: "LD3 (red, PB14) dark", got: part(snap, u, "LD3")?.on ? 1 : 0, want: 0, tol: 0, unit: "" })
}

// 2. D13 low: the instrument sinks, nothing flows, the LED is dark.
{
  setLevel(ls, false)
  const snap = settle()
  expect({ block: "D13 low", what: "D13 pin voltage", got: pinV(snap, u, "CN7-10")!, want: 0, tol: 1e-3, unit: "V" })
  expect({ block: "D13 low", what: "LED current", got: Math.abs(reading(snap, led).current), want: 0, tol: 1e-9, unit: "A" })
  expect({ block: "D13 low", what: "LED dark", got: part(snap, led, "LED")?.on ? 1 : 0, want: 0, tol: 0, unit: "" })
}

// 3. LD1 shares PB0 with D33 (CN10-31): a level on the header pin lights the green LED.
{
  const ls2 = place("logic-state", 32, 30)
  doc.objects.push(ls2)
  const w = wire(ls2, "OUT", u, "CN10-31")
  doc.wires.push(w)
  setLevel(ls2, true)
  const snap = settle()
  const ld1 = part(snap, u, "LD1")
  expect({ block: "LD1 via D33", what: "LD1 lit", got: ld1?.on ? 1 : 0, want: 1, tol: 0, unit: "" })
  // 3.3 V through 510 Ω into a ~2 V green LED.
  expect({ block: "LD1 via D33", what: "LD1 brightness", got: ld1?.level ?? 0, want: (3.3 - 2.0) / 510 / 8e-3, tol: 0.15, unit: "×" })
  doc.objects.splice(doc.objects.indexOf(ls2), 1)
  doc.wires.splice(doc.wires.indexOf(w), 1)
}

// 4. D11 and D71 are one MCU pin (PA7): a level on one header shows on the other.
{
  const ls3 = place("logic-state", 32, 34)
  doc.objects.push(ls3)
  const w = wire(ls3, "OUT", u, "CN7-14")
  doc.wires.push(w)
  setLevel(ls3, true)
  const snap = settle()
  expect({ block: "Shared PA7", what: "D11 voltage", got: pinV(snap, u, "CN7-14")!, want: 3.3, tol: 0.01, unit: "V" })
  expect({ block: "Shared PA7", what: "D71 voltage", got: pinV(snap, u, "CN9-15")!, want: 3.3, tol: 0.01, unit: "V" })
  doc.objects.splice(doc.objects.indexOf(ls3), 1)
  doc.wires.splice(doc.wires.indexOf(w), 1)
}

// 5. Power tree: unplug USB → rails collapse; a 9 V battery on VIN brings them back through
//    the regulators; a short on +5V folds the USB port back to 500 mA instead of burning.
{
  setLevel(ls, false)
  doc.parts[partKey(u.id, "USB")] = { on: false }
  let snap = settle()
  expect({ block: "Power", what: "+3V3 with USB unplugged", got: pinV(snap, u, "CN8-7")!, want: 0, tol: 1e-3, unit: "V" })
  expect({ block: "Power", what: "+5V with USB unplugged", got: pinV(snap, u, "CN8-9")!, want: 0, tol: 1e-3, unit: "V" })
  const bat = place("battery", 20, 60, { value: "9 V", rint: "0.5 Ω", imax: "1 A" })
  doc.objects.push(bat)
  const w1 = wire(bat, "+", u, "CN8-15")
  const w2 = wire(bat, "-", u, "CN8-11")
  doc.wires.push(w1, w2)
  snap = settle()
  expect({ block: "Power", what: "+5V from VIN regulator", got: pinV(snap, u, "CN8-9")!, want: 5, tol: 0.01, unit: "V" })
  expect({ block: "Power", what: "+3V3 from LDO", got: pinV(snap, u, "CN8-7")!, want: 3.3, tol: 0.01, unit: "V" })
  const vinReg = nucleoF429zi.model!.findIndex((el) => el.kind === "REG" && el.in === "CN8-15")
  expect({ block: "Power", what: "VIN regulator mode", got: reading(snap, u, vinReg).extra?.mode === "regulating" ? 1 : 0, want: 1, tol: 0, unit: "", note: reading(snap, u, vinReg).extra?.mode })
  // Load the 3.3 V rail with 33 Ω (100 mA): the battery must deliver it through both regulators.
  const load = place("resistor", 40, 60, { value: "33 Ω", power: "1" })
  doc.objects.push(load)
  const w3 = wire(load, "1", u, "CN8-7")
  const w4 = wire(load, "2", u, "CN8-13")
  doc.wires.push(w3, w4)
  snap = settle()
  expect({ block: "Power", what: "+3V3 under 100 mA load", got: pinV(snap, u, "CN8-7")!, want: 3.3, tol: 0.01, unit: "V" })
  // The load plus the idle MCU (~12 mA at 16 MHz HSI without firmware).
  expect({ block: "Power", what: "battery current ≈ load + MCU idle", got: Math.abs(reading(snap, bat).current), want: 0.112, tol: 0.05, unit: "A" })
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
  expect({ block: "Power", what: "USB port current into 1 Ω short", got: reading(snap, u, usbReg).current, want: 0.5, tol: 0.01, unit: "A" })
  expect({ block: "Power", what: "USB port mode", got: reading(snap, u, usbReg).extra?.mode === "current limit" ? 1 : 0, want: 1, tol: 0, unit: "", note: reading(snap, u, usbReg).extra?.mode })
  expect({ block: "Power", what: "nothing burnt", got: failures.length, want: 0, tol: 0, unit: "" })
  doc.objects.splice(doc.objects.indexOf(shortR), 1)
  for (const w of [w5, w6]) doc.wires.splice(doc.wires.indexOf(w), 1)
  setLevel(ls, true)
}

// 6. USER button: PC13 reads low, high while pressed. RESET pulls NRST to ground.
{
  // PC13 reaches no header pin, so it is read across its 100 kΩ pull-down.
  const pullDown = nucleoF429zi.model!.findIndex((el) => el.kind === "R" && el.a === "$PC13")
  const pc13 = (snap: Snapshot) => Math.abs(reading(snap, u, pullDown).voltage)
  expect({ block: "Buttons", what: "PC13 released", got: pc13(settle()), want: 0, tol: 0, unit: "V" })
  doc.parts[partKey(u.id, "B1")] = { pressed: true }
  expect({ block: "Buttons", what: "PC13 pressed", got: pc13(settle()), want: 3.3, tol: 0.01, unit: "V" })
  doc.parts[partKey(u.id, "B1")] = { pressed: false }
  doc.parts[partKey(u.id, "RESET")] = { pressed: true }
  expect({ block: "Buttons", what: "NRST while RESET held", got: pinV(settle(), u, "CN8-5")!, want: 0, tol: 1e-3, unit: "V", note: "a few µV across the closed switch" })
  doc.parts[partKey(u.id, "RESET")] = { pressed: false }
}

// --- report --------------------------------------------------------------------
const fmt = (v: number, unit: string) => (unit === "" ? String(v) : unit === "×" ? `${v.toFixed(3)}×` : formatSI(v, unit, 3))
let failed = 0
let block = ""
for (const c of checks) {
  if (c.block !== block) {
    block = c.block
    console.log(`\n${block}`)
  }
  const err = c.want === 0 ? Math.abs(c.got) : Math.abs(c.got - c.want) / Math.abs(c.want)
  const ok = c.tol === 0 ? (c.want === 0 ? Math.abs(c.got) < 1e-6 : c.got === c.want) : err <= c.tol
  if (!ok) failed++
  const dev = c.tol === 0 ? "" : `  (${(err * 100).toFixed(1)}% off, ±${c.tol * 100}%)`
  console.log(`  ${ok ? "✓" : "✗"} ${c.what.padEnd(30)} ${fmt(c.got, c.unit).padStart(11)}  expected ${fmt(c.want, c.unit)}${dev}${c.note ? `  — ${c.note}` : ""}`)
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
if (failures.length) console.log(`failures reported: ${failures.join("; ")}`)
process.exit(failed ? 1 : 0)
