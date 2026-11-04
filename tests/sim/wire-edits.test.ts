import { describe, expect, it } from "vitest"
import { GRID, objectPins, type Point } from "@/schematic/geometry"
import type { HdlModule, PlacedObject, Schematic } from "@/schematic/types"
import type { HdlNetlist } from "emul-shared/hdl"
import { withLibrary } from "@/schematic/registry"
import { normalise } from "@/schematic/wires/normal-form"
import counter from "./hdl/counter.json"
import counter2 from "./hdl/counter2.json"
import { clipOf, connectPins, moved, nearestOn, placedObject, recoloured, removed, reoriented, tapWireAt, travellingWires, wiringOf, withModule } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
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

describe("found by phase 3's reviews", () => {
  it("a part placed with a pin on a wire joins it there: the wire splits at the pin (findings 3.R2)", () => {
    const g = (id: string, x: number): PlacedObject => ({ id, def: "ground", x: c(x), y: 0 })
    const a = g("A", 0)
    const b = g("B", 10)
    const rail = seg("rail", pinAt(a, "GND"), pinAt(b, "GND"))
    const doc: Schematic = { objects: [a, b], wires: [rail], parts: {} }
    const placed = placedObject(doc, g("C", 5), newId)
    expect.soft(placed.wires.length, "split in two at the new pin").toBe(2)
    expect.soft(normalFormViolations(placed.wires, wirePins(placed.objects)), "normal form").toEqual([])
    expect.soft(view(placed).netOfPin("C:GND"), "on the rail's net").toBe(view(placed).netOfPin("A:GND"))
  })

  it("a module rebuilt without a pin a spine ran through lets the spine merge back into one wire (findings 3.R1)", () => {
    const wide: HdlModule = { id: "hdl:cnt", name: "cnt", files: [], netlist: counter as unknown as HdlNetlist, built: "w4" }
    const narrow: HdlModule = { ...wide, netlist: counter2 as unknown as HdlNetlist, built: "w2" }
    const part: PlacedObject = { id: "U1", def: wide.id, x: 0, y: 0, props: { ref: "U1" } }
    const q3 = withLibrary([wide], () => pinAt(part, "carry"))
    const through = [seg("spine", { x: q3.x, y: q3.y - c(0.5) }, { x: q3.x, y: q3.y + c(0.5) })]
    const cut = withLibrary([wide], () => normalise(through, wirePins([part]), undefined, newId))
    expect.soft(cut.length, "the pin cuts a wire through it in two").toBe(2)
    const rebuilt = withModule({ objects: [part], wires: [...cut], parts: {}, library: [wide] }, narrow, newId)
    expect.soft(rebuilt.wires.length, "one wire where the pin was").toBe(1)
    expect.soft(withLibrary(rebuilt.library, () => normalFormViolations(rebuilt.wires, wirePins(rebuilt.objects))), "normal form").toEqual([])
  })

  it("the same document read under a rebuilt module sees the module's new pin, not the view kept from before (findings 3.R1)", () => {
    const narrow: HdlModule = { id: "hdl:cnt", name: "cnt", files: [], netlist: counter2 as unknown as HdlNetlist, built: "w2" }
    const wide: HdlModule = { ...narrow, netlist: counter as unknown as HdlNetlist, built: "w4" }
    const part: PlacedObject = { id: "U1", def: wide.id, x: 0, y: 0, props: { ref: "U1" } }
    const carry = withLibrary([wide], () => pinAt(part, "carry"))
    const doc: Schematic = { objects: [part], wires: [seg("w", carry, { x: carry.x + c(3), y: carry.y })], parts: {} }
    const carried = new Set([part.id])
    expect.soft(withLibrary([narrow], () => [...travellingWires(doc, carried)]), "no pin at the wire's end before the rebuild").toEqual([])
    expect.soft(withLibrary([wide], () => [...travellingWires(doc, carried)]), "the new pin carries its wire").toEqual(["w"])
  })

  it("recolouring a wire keeps its place in the drawing, so a crossing keeps which wire breaks the other (findings 3.R8)", () => {
    const h = seg("h", { x: 0, y: c(1) }, { x: c(2), y: c(1) })
    const v = seg("v", { x: c(1), y: 0 }, { x: c(1), y: c(2) })
    const doc: Schematic = { objects: [], wires: [h, v], parts: {} }
    const red = recoloured(doc, [["h", "red"]], newId)
    expect.soft(red.wires.map((s) => `${s.id}:${s.color ?? ""}`), "h first still").toEqual(["h:red", "v:"])
    expect.soft(recoloured(red, [["h", undefined]], newId).wires.map((s) => s.id), "and back").toEqual(["h", "v"])
  })

  it("until phase 6's slip, a wire to an outer header pin another net's wire already passes is refused and the document left as it was (design.md §13.9; findings 3.L3)", () => {
    const board: PlacedObject = { id: "U1", def: "nucleo-f429zi", x: 0, y: 0, props: { ref: "U1" } }
    const inner = pinAt(board, "CN8-6")
    const outer = pinAt(board, "CN8-5")
    const r4: PlacedObject = { id: "R4", def: "resistor", x: inner.x - c(18), y: inner.y - c(1), props: { ref: "R4" } }
    const r1: PlacedObject = { id: "R1", def: "resistor", x: outer.x - c(12), y: outer.y + c(4), props: { ref: "R1" } }
    const passing = connectPins({ objects: [board, r4, r1], wires: [], parts: {} }, { object: "U1", pin: "CN8-6" }, { object: "R4", pin: "2" }, [], undefined, newId)
    expect.soft(passing.wires.some((s) => s.a.y === outer.y && s.b.y === outer.y && Math.min(s.a.x, s.b.x) < outer.x && Math.max(s.a.x, s.b.x) > outer.x), "the inner pin's wire passes the outer pin").toBe(true)
    expect.soft(connectPins(passing, { object: "U1", pin: "CN8-5" }, { object: "R1", pin: "2" }, [], undefined, newId), "refused: the same document").toBe(passing)
  })

  it("connecting and tapping with the store's wiring lay what they lay without it, and a wiring of another document is not taken for it (findings 3.L9)", () => {
    const { doc } = spineThroughR1()
    const r4 = resistor("R4", 0, 6)
    const withR4: Schematic = { ...doc, objects: [...doc.objects, r4] }
    const ids = () => {
      let n = 0
      return () => `k${n++}`
    }
    const known = wiringOf(new WireGraph(), withR4)
    const stale = wiringOf(new WireGraph(), { ...withR4, wires: [] })
    const plain = connectPins(withR4, { object: "R4", pin: "2" }, { object: "R2", pin: "2" }, [], undefined, ids())
    expect.soft(plain.wires.length, "a wire laid").toBeGreaterThan(withR4.wires.length)
    expect.soft(connectPins(withR4, { object: "R4", pin: "2" }, { object: "R2", pin: "2" }, [], undefined, ids(), known).wires, "the same with the store's wiring").toEqual(plain.wires)
    expect.soft(connectPins(withR4, { object: "R4", pin: "2" }, { object: "R2", pin: "2" }, [], undefined, ids(), stale).wires, "the same with a wiring of another document").toEqual(plain.wires)
    const tapped = tapWireAt(withR4, "a", withR4.wires[0].a, { object: "R4", pin: "2" }, [], undefined, ids())
    expect.soft(tapWireAt(withR4, "a", withR4.wires[0].a, { object: "R4", pin: "2" }, [], undefined, ids(), known).wires, "a tap the same with the store's wiring").toEqual(tapped.wires)
  })

  it("wiring carried by a move keeps its place in the drawing, so a crossing keeps which wire breaks the other (findings 3.L13)", () => {
    const r1 = resistor("R1", 0, 4)
    const r2 = resistor("R2", 10, 4)
    const a = pinAt(r1, "2")
    const b = pinAt(r2, "1")
    const h = seg("h", a, b)
    const v = seg("v", { x: a.x + c(3), y: a.y - c(2) }, { x: a.x + c(3), y: a.y + c(2) })
    const doc: Schematic = { objects: [r1, r2, resistor("R3", 0, 20)], wires: [h, v], parts: {} }
    const carried = moved(doc, new Map([r1, r2].map((o) => [o.id, { x: o.x, y: o.y }])), c(1), 0, newId)
    expect.soft(carried.wires.map((s) => s.id), "h, moved along, still first").toEqual(["h", "v"])
    expect.soft(carried.wires[0].a.x, "and moved").toBe(a.x + c(1))
  })

  it("a run between two carried pins travels though its net goes on to a part left behind (findings 3.L15)", () => {
    const r1 = resistor("R1", 0, 0)
    const r2 = resistor("R2", 8, 0)
    const r3 = resistor("R3", 16, 0)
    const join = pinAt(r2, "1")
    const below = { x: join.x, y: join.y + c(3) }
    const under = { x: pinAt(r3, "1").x, y: below.y }
    const doc: Schematic = { objects: [r1, r2, r3], wires: [seg("between", pinAt(r1, "2"), join), seg("down", join, below), seg("across", below, under), seg("up", under, pinAt(r3, "1"))], parts: {} }
    expect.soft([...travellingWires(doc, new Set(["R1", "R2"]))].sort(), "the wire between them goes, the run on to R3 stays").toEqual(["between"])
  })

  it("a tap lands on the wire tapped, at its end when the pointer is past it (findings 3.L15)", () => {
    const s = seg("s", { x: 0, y: 0 }, { x: c(4), y: 0 })
    expect.soft(nearestOn(s, { x: c(10), y: c(1) }), "past the far end").toEqual({ x: c(4), y: 0 })
    expect.soft(nearestOn(s, { x: -c(3), y: 0 }), "before the near end").toEqual({ x: 0, y: 0 })
    expect.soft(nearestOn(s, { x: c(2.2), y: c(5) }), "along it, on the grid").toEqual({ x: c(2), y: 0 })
  })

  it("a part moved off a spine its pin cut lets the spine merge back into one wire (findings 3.L15)", () => {
    const { doc, r1 } = spineThroughR1()
    const after = moved(doc, new Map([[r1.id, { x: r1.x, y: r1.y }]]), c(4), 0, newId)
    expect.soft(after.wires.length, "one wire").toBe(1)
    expect.soft(normalFormViolations(after.wires, wirePins(after.objects)), "normal form").toEqual([])
  })

  it("a net carried whole travels whole, a branch that ends in the open included (findings 3.R12)", () => {
    const r1 = resistor("R1", 0, 0)
    const r2 = resistor("R2", 10, 0)
    const a = pinAt(r1, "2")
    const b = pinAt(r2, "1")
    const mid = { x: a.x + c(3), y: a.y }
    const doc: Schematic = { objects: [r1, r2], wires: [seg("l", a, mid), seg("r", mid, b), seg("branch", mid, { x: mid.x, y: mid.y + c(3) })], parts: {} }
    expect.soft([...travellingWires(doc, new Set([r1.id, r2.id]))].sort(), "the branch goes along").toEqual(["branch", "l", "r"])
  })
})
