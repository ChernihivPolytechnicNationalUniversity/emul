import { describe, expect, it } from "vitest"
import type { HdlNetlist } from "emul-shared/hdl"
import { circuitOf, flowGraph, runsOf } from "@/schematic/circuit"
import { GRID, objectPins } from "@/schematic/geometry"
import { getDef, setLibrary } from "@/schematic/registry"
import type { HdlModule, PlacedObject, Schematic } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"
import { wireCurrents } from "@/sim/flow"
import counter from "./hdl/counter.json"

const c = (x: number, y: number) => ({ x: x * GRID, y: y * GRID })
const seg = (id: string, a: [number, number], b: [number, number], color?: WireColorKey): WireSegment => ({ id, a: c(...a), b: c(...b), ...(color && { color }) })
const pin = (key: string, x: number, y: number): WirePin => ({ key, at: c(x, y) })
const cells = (pts: readonly { x: number; y: number }[]) => pts.map((p) => [p.x / GRID, p.y / GRID])

describe("runs: the chains of segments a wire is drawn and animated as (design.md §1.3)", () => {
  it("a chain through bends is one run, named by its smallest segment id, its points in order from one end to the other", () => {
    const runs = runsOf([seg("c", [4, 2], [4, 0]), seg("a", [0, 0], [4, 0]), seg("d", [4, 2], [8, 2])], [])
    expect.soft(runs.map((r) => r.id), "one run").toEqual(["a"])
    const points = cells(runs[0].points)
    expect.soft(points.length === 4 && [JSON.stringify(points), JSON.stringify([...points].reverse())].includes(JSON.stringify([[0, 0], [4, 0], [4, 2], [8, 2]])), `in order: ${JSON.stringify(points)}`).toBe(true)
  })

  it("a pin, a branch and a change of colour each end a run", () => {
    const throughPin = runsOf([seg("a", [0, 0], [4, 0]), seg("b", [4, 0], [8, 0])], [pin("R1:1", 4, 0)])
    expect.soft(throughPin.map((r) => r.id).sort(), "a pin between them").toEqual(["a", "b"])
    const branch = runsOf([seg("a", [0, 0], [4, 0]), seg("b", [4, 0], [8, 0]), seg("c", [4, 0], [4, 4])], [])
    expect.soft(branch.map((r) => r.id).sort(), "a T").toEqual(["a", "b", "c"])
    const colours = runsOf([seg("a", [0, 0], [4, 0], "red"), seg("b", [4, 0], [8, 0], "blue")], [])
    expect.soft(colours.map((r) => r.id).sort(), "red into blue").toEqual(["a", "b"])
    const same = runsOf([seg("a", [0, 0], [4, 0], "red"), seg("b", [4, 0], [8, 0], "red")], [])
    expect.soft(same.map((r) => r.id), "red into red").toEqual(["a"])
  })

  it("a closed ring of segments is one run that starts and ends on the same point", () => {
    const ring = runsOf([seg("a", [0, 0], [4, 0]), seg("b", [4, 0], [4, 4]), seg("c", [4, 4], [0, 4]), seg("d", [0, 4], [0, 0])], [])
    expect.soft(ring.length, "one run").toBe(1)
    const flow = flowGraph(ring, [])
    expect.soft(flow.runs[0].a, "its ends meet").toBe(flow.runs[0].b)
  })
})

describe("the circuit handed to the solver (design.md §2)", () => {
  const resistor = (id: string, x: number, y: number): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id } })
  const pinAt = (o: PlacedObject, id: string) => objectPins(o, GRID).find((p) => p.pin.id === id)!.point

  it("its nets are the pin partition, and only pins a wire ends on count as wired", () => {
    const r1 = resistor("R1", 0, 0)
    const r2 = resistor("R2", 10, 0)
    const base = resistor("R3", 0, 0)
    const r3: PlacedObject = { ...base, x: pinAt(r2, "2").x - pinAt(base, "1").x, y: pinAt(r2, "2").y - pinAt(base, "1").y }
    const a = pinAt(r1, "2")
    const b = pinAt(r2, "1")
    const doc: Schematic = { objects: [r1, r2, r3], wires: [{ id: "w", a, b }], parts: {} }
    const circuit = circuitOf(doc)
    expect.soft(circuit.nets, "R1 2 to R2 1 by the wire, R2 2 to R3 1 by contact").toEqual([["R1:2", "R2:1"], ["R2:2", "R3:1"]])
    expect.soft([...circuit.wired].sort(), "the two pins the wire ends on").toEqual(["R1:2", "R2:1"])
    expect.soft(circuit.flow.pins["R1:2"], "each pin sits on its point").toBe(`${a.x},${a.y}`)
  })

  it("an HDL part's pins come from the document's own library, whatever library was set last", () => {
    const m: HdlModule = { id: "hdl:cnt", name: "cnt", files: [], netlist: counter as unknown as HdlNetlist, built: "w4" }
    setLibrary([m])
    const part: PlacedObject = { id: "U1", def: m.id, x: 0, y: 0, props: { ref: "U1" } }
    const clk = objectPins(part, GRID).find((p) => p.pin.id === "clk")!.point
    setLibrary([])
    expect.soft(getDef(m.id), "nothing set globally").toBeUndefined()
    const r = resistor("R1", 0, 0)
    const placed: PlacedObject = { ...r, x: clk.x - pinAt(r, "2").x, y: clk.y - pinAt(r, "2").y }
    const doc: Schematic = { objects: [part, placed], wires: [], parts: {}, library: [m] }
    expect.soft(circuitOf(doc).nets, "the clock pin meets R1 2 by contact").toEqual([["R1:2", "U1:clk"]])
  })
})

describe("current along the wires (design.md §9)", () => {
  const flow = (runs: [string, string, string][], pins: Record<string, string>) => ({ runs: runs.map(([id, a, b]) => ({ id, a, b })), pins })
  const inNetlist = (...keys: string[]) => new Map(keys.map((k) => [k, 1]))

  it("a chain carries the same current in every run, signed from each run's first point to its last", () => {
    const f = flow([["r1", "A", "B"], ["r2", "B", "C"]], { "P1:1": "A", "P2:1": "C" })
    const amps = wireCurrents(f, inNetlist("P1:1", "P2:1"), new Set(), (k) => (k === "P1:1" ? 1 : k === "P2:1" ? -1 : 0))
    expect.soft(amps.get("r1")!, "from C towards A, against r1's direction").toBeNear(-1, 1e-12)
    expect.soft(amps.get("r2")!, "and against r2's").toBeNear(-1, 1e-12)
  })

  it("a loop splits the current evenly between its two ways round, and a run closed on itself carries none", () => {
    const f = flow([["top", "A", "B"], ["bottom", "A", "B"], ["ring", "C", "C"]], { "P1:1": "A", "P2:1": "B", "P3:1": "C" })
    const amps = wireCurrents(f, inNetlist("P1:1", "P2:1", "P3:1"), new Set(), (k) => (k === "P1:1" ? -2 : k === "P2:1" ? 2 : 0))
    expect.soft(amps.get("top")!, "half each way").toBeNear(1, 1e-12)
    expect.soft(amps.get("bottom")!, "half each way").toBeNear(1, 1e-12)
    expect.soft(amps.get("ring"), "nothing round a closed run").toBe(0)
  })

  it("a net no element of the netlist touches carries nothing", () => {
    const f = flow([["r1", "A", "B"]], { "P1:1": "A", "P2:1": "B" })
    const amps = wireCurrents(f, new Map(), new Set(), () => 1)
    expect.soft(amps.get("r1"), "left at zero").toBe(0)
  })
})
