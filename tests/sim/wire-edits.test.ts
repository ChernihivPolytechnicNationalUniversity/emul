import { describe, expect, it } from "vitest"
import { GRID, objectPins, type Point } from "@/schematic/geometry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { clipOf, connectPins, moved, recoloured, removed, reoriented, travellingWires } from "@/schematic/wire-edits"
import { danglingEnds, junctionsOf, wireNets } from "@/schematic/wires/graph"
import { wirePins } from "@/schematic/migrate-wires"
import { normalFormViolations } from "../lib/wire-reference"
import { pinPartition } from "../lib/pin-partition"
import type { WireSegment } from "@/schematic/wires/segment"

const c = (v: number) => v * GRID
const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
const pinAt = (o: PlacedObject, pin: string) => objectPins(o, GRID).find((p) => p.pin.id === pin)!.point
const seg = (id: string, a: Point, b: Point, color?: WireSegment["color"]): WireSegment => ({ id, a, b, ...(color && { color }) })
const view = (doc: Schematic) => wireNets(doc.wires, wirePins(doc.objects))
const cells = (p: Point) => [p.x / GRID, p.y / GRID]
let fresh = 0
const newId = () => `n${fresh++}`

function spineThroughR1() {
  const r1 = resistor("R1", 8, 0, 90)
  const tap = pinAt(r1, "2")
  const r2 = resistor("R2", 0, 0)
  const r3 = resistor("R3", 0, 0)
  const left: PlacedObject = { ...r2, x: r2.x + tap.x - c(4) - pinAt(r2, "2").x, y: r2.y + tap.y - pinAt(r2, "2").y }
  const right: PlacedObject = { ...r3, x: r3.x + tap.x + c(4) - pinAt(r3, "1").x, y: r3.y + tap.y - pinAt(r3, "1").y }
  const doc: Schematic = { objects: [r1, left, right], wires: [seg("a", pinAt(left, "2"), tap), seg("b", tap, pinAt(right, "1"))], parts: {} }
  return { doc, r1, left, right, tap }
}

describe("deleting (design.md §6.5, junctions.md 4)", () => {
  it("R1 deleted from the middle of a spine: the wires stay, the two collinear ends merge, R2 and R3 stay joined by one straight segment with no dot", () => {
    const { doc, r1, left, right } = spineThroughR1()
    expect.soft(junctionsOf(view(doc)).map(cells), "before: a dot on R1's pin").toEqual([cells(pinAt(r1, "2"))])
    const after = removed(doc, new Set([r1.id]), new Set(), newId)
    expect.soft(after.objects.map((o) => o.id), "R1 gone").toEqual([left.id, right.id])
    expect.soft(after.wires.map((s) => [cells(s.a), cells(s.b)].sort()), "one straight segment").toEqual([[cells(pinAt(left, "2")), cells(pinAt(right, "1"))].sort()])
    expect.soft(junctionsOf(view(after)), "no dot").toEqual([])
    expect.soft(pinPartition(after), "R2 and R3 still joined").toEqual([["R2.2", "R3.1"]])
  })

  it("a part at the end of a wire deleted leaves the wire hanging from where its pin was, and its part state goes with it", () => {
    const r1 = resistor("R1", 0, 0)
    const r2 = resistor("R2", 10, 0)
    const doc: Schematic = { objects: [r1, r2], wires: [seg("w", pinAt(r1, "2"), pinAt(r2, "1"))], parts: { "R2:SW": { on: true }, "R1:SW": { on: false } } }
    const after = removed(doc, new Set([r2.id]), new Set(), newId)
    expect.soft(after.wires, "the wire stays").toEqual(doc.wires)
    expect.soft(danglingEnds(view(after)).map(cells), "its end hangs where R2's pin was").toEqual([cells(pinAt(r2, "1"))])
    expect.soft(Object.keys(after.parts), "R2's state gone").toEqual(["R1:SW"])
  })

  it("deleting segments removes just them, and what they split merges again", () => {
    const { doc } = spineThroughR1()
    const after = removed(doc, new Set(), new Set(["b"]), newId)
    expect.soft(after.wires.map((s) => s.id), "only a left").toEqual(["a"])
  })
})

describe("moving and turning before phase 4's rubber band (design.md §13.15)", () => {
  it("a part moved alone leaves its wires where they were, their ends dangling", () => {
    const r1 = resistor("R1", 0, 0)
    const r2 = resistor("R2", 10, 0)
    const doc: Schematic = { objects: [r1, r2], wires: [seg("w", pinAt(r1, "2"), pinAt(r2, "1"))], parts: {} }
    const after = moved(doc, new Map([[r2.id, { x: r2.x, y: r2.y }]]), 0, c(6), newId)
    expect.soft(after.wires, "the wire where it was").toEqual(doc.wires)
    expect.soft(pinPartition(after), "nothing joined").toEqual([])
    expect.soft(danglingEnds(view(after)).map(cells), "one end dangling").toEqual([cells(pinAt(r2, "1"))])
  })

  it("the wiring between parts carried together travels with them, and a net wholly carried travels whole", () => {
    const r1 = resistor("R1", 0, 0)
    const r2 = resistor("R2", 10, 0)
    const r3 = resistor("R3", 30, 0)
    const doc: Schematic = { objects: [r1, r2, r3], wires: [seg("between", pinAt(r1, "2"), pinAt(r2, "1")), seg("away", pinAt(r2, "2"), pinAt(r3, "1"))], parts: {} }
    expect.soft([...travellingWires(doc, new Set([r1.id, r2.id]))], "only the wire between them").toEqual(["between"])
    const after = moved(doc, new Map([r1, r2].map((o) => [o.id, { x: o.x, y: o.y }])), 0, c(6), newId)
    const between = after.wires.find((s) => s.id === "between")!
    expect.soft([cells(between.a), cells(between.b)], "moved with them").toEqual([cells(pinAt(r1, "2")), cells(pinAt(r2, "1"))].map(([x, y]) => [x, y + 6]))
    expect.soft(after.wires.find((s) => s.id === "away"), "the wire to R3 stays").toEqual(doc.wires[1])
    expect.soft(pinPartition(after), "R1 and R2 still joined, R3 left").toEqual([["R1.2", "R2.1"]])
  })

  it("a part dropped with a pin on a wire joins it there: the wire splits at the pin", () => {
    const r1 = resistor("R1", 0, 0)
    const r2 = resistor("R2", 20, 0)
    const r3 = resistor("R3", 0, 10, 90)
    const doc: Schematic = { objects: [r1, r2, r3], wires: [seg("w", pinAt(r1, "2"), pinAt(r2, "1"))], parts: {} }
    const target = { x: pinAt(r1, "2").x + c(6), y: pinAt(r1, "2").y }
    const p = pinAt(r3, "1")
    const after = moved(doc, new Map([[r3.id, { x: r3.x, y: r3.y }]]), target.x - p.x, target.y - p.y, newId)
    expect.soft(after.wires.length, "split in two").toBe(2)
    expect.soft(pinPartition(after), "R3 on the net").toEqual([["R1.2", "R2.1", "R3.1"]])
    expect.soft(normalFormViolations(after.wires, wirePins(after.objects)), "normal form").toEqual([])
  })

  it("a part turned in place leaves its wires; where a turned pin left a spine, the spine merges", () => {
    const { doc, r1, left, right } = spineThroughR1()
    const turned: Schematic = { ...doc, objects: doc.objects.map((o) => (o.id === r1.id ? { ...o, rotation: 0 as const, x: o.x - c(6), y: o.y - c(6) } : o)) }
    const after = reoriented(doc, turned, new Set([r1.id]), newId)
    expect.soft(after.wires.length, "one segment").toBe(1)
    expect.soft(pinPartition(after), "R2 and R3 joined, R1 off the spine").toEqual([["R2.2", "R3.1"]])
    expect.soft([left.id, right.id].every((id) => after.objects.some((o) => o.id === id)), "the others untouched").toBe(true)
  })
})

describe("colour (junctions.md 19)", () => {
  it("one segment of a run recoloured splits the run at the boundary; recoloured back, it merges again", () => {
    const a = { x: 0, y: 0 }
    const m = { x: c(4), y: 0 }
    const b = { x: c(8), y: 0 }
    const doc: Schematic = { objects: [], wires: [seg("w", a, b)], parts: {} }
    const split: Schematic = { ...doc, wires: [seg("w", a, m), seg("x", m, b)] }
    const red = recoloured(split, [["x", "red"]], newId)
    expect.soft(red.wires.map((s) => s.color ?? "black"), "two colours, two segments").toEqual(["black", "red"])
    const back = recoloured(red, [["x", undefined]], newId)
    expect.soft(back.wires.length, "merged again").toBe(1)
  })
})

describe("connecting two pins (design.md §6.1 until phase 4's drawing)", () => {
  it("the new wire keeps clear of another net lying on the straight way between the pins", () => {
    const r1 = resistor("R1", 0, 0)
    const r2 = resistor("R2", 14, 0)
    const g1 = resistor("G1", 0, 10)
    const g2 = resistor("G2", 14, 10)
    const from = pinAt(r1, "2")
    const to = pinAt(r2, "1")
    const foreign = [seg("f1", pinAt(g1, "2"), { x: from.x + c(3), y: pinAt(g1, "2").y }), seg("f2", { x: from.x + c(3), y: pinAt(g1, "2").y }, { x: from.x + c(3), y: from.y }), seg("f3", { x: from.x + c(3), y: from.y }, { x: to.x - c(3), y: from.y }), seg("f4", { x: to.x - c(3), y: from.y }, { x: to.x - c(3), y: pinAt(g2, "1").y }), seg("f5", { x: to.x - c(3), y: pinAt(g2, "1").y }, pinAt(g2, "1"))]
    const doc: Schematic = { objects: [r1, r2, g1, g2], wires: foreign, parts: {} }
    const after = connectPins(doc, { object: r1.id, pin: "2" }, { object: r2.id, pin: "1" }, [], undefined, newId)
    expect.soft(pinPartition(after), "two nets, kept apart").toEqual([["G1.2", "G2.1"], ["R1.2", "R2.1"]])
    expect.soft(normalFormViolations(after.wires, wirePins(after.objects)), "normal form").toEqual([])
  })
})

describe("copying (design.md §6.6)", () => {
  it("a clip carries the picked parts, the wiring among them and their part state, nothing that leaves the selection", () => {
    const r1 = resistor("R1", 0, 0)
    const r2 = resistor("R2", 10, 0)
    const r3 = resistor("R3", 30, 0)
    const doc: Schematic = { objects: [r1, r2, r3], wires: [seg("between", pinAt(r1, "2"), pinAt(r2, "1")), seg("away", pinAt(r2, "2"), pinAt(r3, "1"))], parts: { "R1:X": { on: true }, "R3:X": { on: true } } }
    const clip = clipOf(doc, new Set([r1.id, r2.id]))!
    expect.soft(clip.objects.map((o) => o.id), "the two parts").toEqual([r1.id, r2.id])
    expect.soft(clip.wires.map((s) => s.id), "the wire between them").toEqual(["between"])
    expect.soft(Object.keys(clip.parts), "their state").toEqual(["R1:X"])
    expect.soft(clipOf(doc, new Set()), "nothing picked").toBeNull()
  })
})
