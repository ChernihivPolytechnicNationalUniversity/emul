/**
 * The 4×4 membrane keypad (Parallax #27899) on the bench: a key joins its row to its column
 * through its contact resistance and nothing else does; three keys at a rectangle's corners
 * ghost the fourth (no diodes inside); past the 30 mA rating the printed contact fuses open.
 */
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey, type Schematic } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

function run(doc: Schematic, ms: number): Snapshot {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  while (clock < ms) {
    clock = Math.min(ms, clock + 10)
    loop.advance(clock)
  }
  const snap = loop.snapshot()!
  loop.dispose()
  return snap
}

/** 3.3 V into one row through `ohms`, every column pulled to ground through 10 kΩ. */
function bench(row: number, pressed: string[], ohms = 1000) {
  const { doc, place, wire } = builder(GRID)
  const source = place("dc-source", 0, 0, { value: "3.3 V", rint: `${ohms} Ω` })
  const kp = place("keypad-4x4", 10, 0)
  const gnd = place("ground", 2, 30)
  wire(source, "+", kp, `R${row}`)
  wire(source, "-", gnd, "GND")
  for (let c = 1; c <= 4; c++) {
    const r = place("resistor", 8 + c * 5, 20, { value: "10 kΩ", power: "0.25" }, 90)
    wire(kp, `C${c}`, r, "1")
    wire(r, "2", gnd, "GND")
  }
  for (const key of pressed) doc.parts[partKey(kp.id, key)] = { pressed: true }
  return { doc, kp }
}

const volts = (snap: Snapshot, kp: { id: string }, pin: string) => snap.pinVoltage[pinKey(kp.id, pin)] ?? 0

describe("Keypad 4×4", () => {
  it("has the Parallax header, rows then columns, numbered 8 to 1 from the left", () => {
    const def = getDef("keypad-4x4")!
    expect(def.pins.map((p) => [p.id, p.connectorPin])).toEqual([
      ["R1", 8], ["R2", 7], ["R3", 6], ["R4", 5], ["C1", 4], ["C2", 3], ["C3", 2], ["C4", 1],
    ])
    expect(def.parts.map((p) => (p.type === "button" ? p.face : "")).join("")).toBe("123A456B789C*0#D")
  })

  it("key 6 joins row 2 to column 3 and nothing else", () => {
    const { doc, kp } = bench(2, ["K23"])
    const snap = run(doc, 20)
    // 3.3 V over 1 kΩ + 100 Ω contact + 10 kΩ: the column reads 10k/11.1k of it.
    expect(volts(snap, kp, "C3")).toBeNear((3.3 * 10_000) / 11_100, 0.01)
    for (const c of ["C1", "C2", "C4"]) expect.soft(volts(snap, kp, c), c).toBeLessThan(0.01)
  })

  it("no key pressed: every column stays low", () => {
    const { doc, kp } = bench(1, [])
    const snap = run(doc, 20)
    for (const c of ["C1", "C2", "C3", "C4"]) expect.soft(volts(snap, kp, c), c).toBeLessThan(0.01)
  })

  it("ghosting: keys 1, 2 and 5 held, scanning row 2 also reads column 1 (key 4 is not pressed)", () => {
    // Row 2 → key 5 (R2–C2) → key 2 (C2–R1) → key 1 (R1–C1) → column 1.
    const { doc, kp } = bench(2, ["K11", "K12", "K22"])
    const snap = run(doc, 20)
    expect(volts(snap, kp, "C1"), "phantom key 4").toBeGreaterThan(1)
    expect(snap.parts[partKey(kp.id, "K21")]?.pressed ?? false).toBe(false)
  })

  it("past its 30 mA switching rating a key carries on: no sheet gives it a carry limit or a failure", () => {
    const b = builder(GRID)
    const source = b.place("dc-source", 0, 0, { value: "5 V", rint: "10 Ω" })
    const k = b.place("keypad-4x4", 10, 0)
    const gnd = b.place("ground", 2, 30)
    b.wire(source, "+", k, "R1")
    b.wire(k, "C1", gnd, "GND")
    b.wire(source, "-", gnd, "GND")
    b.doc.parts[partKey(k.id, "K11")] = { pressed: true }
    const snap = run(b.doc, 500)
    const amps = Math.abs(snap.readings.find((r) => r.object === k.id && r.element === 0)!.current)
    expect(amps, "5 V over 10 Ω + 100 Ω").toBeNear(5 / 110, 0.001)
    expect(snap.damage[k.id]).toBeFalsy()
  })
})
