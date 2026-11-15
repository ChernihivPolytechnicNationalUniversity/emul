import { describe, expect, it } from "vitest"
import type { HdlNetlist } from "emul-shared/hdl"
import { circuitOf, flowGraph, runsOf, type Circuit, type FlowGraph } from "@/schematic/circuit"
import { moved, wiringOf, withSegments } from "@/schematic/wire-edits"
import { examples } from "@/schematic/examples"
import { WireGraph } from "@/schematic/wires/graph"
import { buildNetlist } from "@/sim/netlist"
import { FlowGate, TopologyGate } from "@/sim/topology"
import { GRID, objectPins } from "@/schematic/geometry"
import { getDef, setLibrary } from "@/schematic/registry"
import type { HdlModule, PlacedObject, Schematic } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"
import { FlowSolver } from "@/sim/flow"
import { flowNetOf, referenceWireCurrents, schematicTies } from "../lib/flow-reference"
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
    expect.soft([circuit.flow.pins["R1:2"], circuit.flow.pins["R2:1"]].sort(), "each pin sits on its end of the run").toEqual([circuit.flow.runs[0].a, circuit.flow.runs[0].b].sort())
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
  const wireCurrents = (f: FlowGraph, pinNet: ReadonlyMap<string, number>, terminal: (key: string) => number) => new FlowSolver(f, flowNetOf(pinNet)).currents(terminal).wires

  it("a chain carries the same current in every run, signed from each run's first point to its last", () => {
    const f = flow([["r1", "A", "B"], ["r2", "B", "C"]], { "P1:1": "A", "P2:1": "C" })
    const amps = wireCurrents(f, inNetlist("P1:1", "P2:1"), (k) => (k === "P1:1" ? 1 : k === "P2:1" ? -1 : 0))
    expect.soft(amps.get("r1")!, "from C towards A, against r1's direction").toBeNear(-1, 1e-12)
    expect.soft(amps.get("r2")!, "and against r2's").toBeNear(-1, 1e-12)
  })

  it("a loop splits the current evenly between its two ways round, and a run closed on itself carries none", () => {
    const f = flow([["top", "A", "B"], ["bottom", "A", "B"], ["ring", "C", "C"]], { "P1:1": "A", "P2:1": "B", "P3:1": "C" })
    const amps = wireCurrents(f, inNetlist("P1:1", "P2:1", "P3:1"), (k) => (k === "P1:1" ? -2 : k === "P2:1" ? 2 : 0))
    expect.soft(amps.get("top")!, "half each way").toBeNear(1, 1e-12)
    expect.soft(amps.get("bottom")!, "half each way").toBeNear(1, 1e-12)
    expect.soft(amps.get("ring"), "nothing round a closed run").toBe(0)
  })

  it("a net no element of the netlist touches carries nothing", () => {
    const f = flow([["r1", "A", "B"]], { "P1:1": "A", "P2:1": "B" })
    const amps = wireCurrents(f, new Map(), () => 1)
    expect.soft(amps.get("r1"), "left at zero").toBe(0)
  })
})

describe("found by phase 3's reviews", () => {
  const resistor = (id: string, x: number, y: number): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id } })
  const pinAt = (o: PlacedObject, id: string) => objectPins(o, GRID).find((p) => p.pin.id === id)!.point

  it("the field's wiring takes an HDL part's pins from the document's own library too, whatever library was set last (findings 3.R1)", () => {
    const m: HdlModule = { id: "hdl:cnt", name: "cnt", files: [], netlist: counter as unknown as HdlNetlist, built: "w4" }
    setLibrary([m])
    const part: PlacedObject = { id: "U1", def: m.id, x: 0, y: 0, props: { ref: "U1" } }
    const clk = objectPins(part, GRID).find((p) => p.pin.id === "clk")!.point
    setLibrary([])
    const r = resistor("R1", 0, 0)
    const placed: PlacedObject = { ...r, x: clk.x - pinAt(r, "2").x, y: clk.y - pinAt(r, "2").y }
    const doc: Schematic = { objects: [part, placed], wires: [], parts: {}, library: [m] }
    expect.soft(wiringOf(new WireGraph(), doc).circuit.nets, "the clock pin meets R1 2 by contact").toEqual([["R1:2", "U1:clk"]])
  })

  it("a pad wired to nothing but a wire is still a pad the solver drives (findings 3.R12)", () => {
    const chip: PlacedObject = { id: "U1", def: "pic16f628a", x: 0, y: 0, props: { ref: "U1" } }
    const pad = pinAt(chip, "RB0")
    const bare: Schematic = { objects: [chip], wires: [], parts: {} }
    const wired: Schematic = { ...bare, wires: [{ id: "w", a: pad, b: { x: pad.x + 3 * GRID, y: pad.y } }] }
    const pads = (doc: Schematic) => buildNetlist(doc).elements.filter((e) => e.kind === "GPIO" && e.keys.includes("U1:RB0")).length
    expect.soft(pads(bare), "an unwired pad is left out").toBe(0)
    expect.soft(pads(wired), "a wired one is in").toBe(1)
  })

  it("the flow sent to the solver changes when the run graph does though the circuit does not (findings 3.R12)", () => {
    const gate = new FlowGate()
    const first: FlowGraph = { runs: [{ id: "r", a: "p:R1:2", b: "p:R2:1" }], pins: { "R1:2": "p:R1:2", "R2:1": "p:R2:1" } }
    expect.soft(gate.latest(first), "the first is sent").toBe(first)
    expect.soft(gate.latest({ runs: [{ id: "r", a: "p:R1:2", b: "p:R2:1" }], pins: { "R1:2": "p:R1:2", "R2:1": "p:R2:1" } }), "the same again is not").toBe(first)
    const looped: FlowGraph = { runs: [...first.runs, { id: "s", a: "p:R1:2", b: "p:R2:1" }], pins: first.pins }
    expect.soft(gate.latest(looped), "a second run between the same pins is").toBe(looped)
  })

  it("the gates send again when only a pin's place in the flow changes, or only which pins a wire ends on (findings 3.L15)", () => {
    const flows = new FlowGate()
    const first: FlowGraph = { runs: [{ id: "r", a: "p:R1:2", b: "p:R2:1" }], pins: { "R1:2": "p:R1:2", "R2:1": "p:R2:1" } }
    flows.latest(first)
    const moved: FlowGraph = { runs: first.runs, pins: { "R1:2": "p:R1:2", "R2:1": "p:R1:2" } }
    expect.soft(flows.latest(moved), "a pin on another vertex").toBe(moved)
    const r = (id: string): PlacedObject => ({ id, def: "resistor", x: 0, y: 0, props: { ref: id } })
    const objects = [r("R1"), r("R2")]
    const topology = new TopologyGate()
    const wiredOne: Circuit = { objects, nets: [["R1:2", "R2:1"]], wired: ["R1:2"], flow: first }
    topology.latest(wiredOne)
    const wiredBoth: Circuit = { ...wiredOne, wired: ["R1:2", "R2:1"] }
    expect.soft(topology.latest(wiredBoth), "a pin a wire now ends on").toBe(wiredBoth)
  })

  it("wiring moved without changing what it connects leaves the flow the solver has as it was; a new branch does not (findings 3.L6)", () => {
    const doc = examples.find((e) => e.id === "power-supply")!.build(GRID)
    const shifted: Schematic = { ...doc, objects: doc.objects.map((o) => ({ ...o, x: o.x + 3 * GRID, y: o.y + GRID })), wires: doc.wires.map((s) => ({ ...s, a: { x: s.a.x + 3 * GRID, y: s.a.y + GRID }, b: { x: s.b.x + 3 * GRID, y: s.b.y + GRID } })) }
    const gate = new FlowGate()
    const first = gate.latest(circuitOf(doc).flow)
    expect.soft(gate.latest(circuitOf(shifted).flow), "the whole sheet moved: nothing to send").toBe(first)
    const graph = new WireGraph()
    expect.soft(gate.latest(wiringOf(graph, doc).circuit.flow), "the store's wiring: the same flow").toBe(first)
    const whole = moved(doc, new Map(doc.objects.map((o) => [o.id, { x: o.x, y: o.y }])), 3 * GRID, GRID)
    expect.soft(gate.latest(wiringOf(graph, whole).circuit.flow), "moved whole in the store, its looks shifted: nothing to send").toBe(first)
    const branched = withSegments(doc, [{ id: "branch", a: doc.wires[0].a, b: { x: doc.wires[0].a.x, y: doc.wires[0].a.y - 5 * GRID } }])
    expect.soft(gate.latest(wiringOf(graph, branched).circuit.flow), "a branch is sent").not.toBe(first)
  })

  it("on random graphs the solver built once gives what the solver it replaced gave, for every terminal and for any injection (findings 3.L6; verification)", () => {
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let round = 0; round < 200; round++) {
      const vertices = Array.from({ length: 2 + Math.floor(next() * 10) }, (_, i) => `v${i}`)
      const runs = Array.from({ length: 1 + Math.floor(next() * 14) }, (_, i) => ({ id: `r${i}`, a: vertices[Math.floor(next() * vertices.length)], b: vertices[Math.floor(next() * vertices.length)] }))
      const pins: Record<string, string> = {}
      const pinNet = new Map<string, number>()
      const ground = new Set<string>()
      for (let k = 0; k < 1 + Math.floor(next() * 6); k++) {
        const key = `P${k}:1`
        pins[key] = vertices[Math.floor(next() * vertices.length)]
        if (next() < 0.85) pinNet.set(key, k)
        if (next() < 0.25) ground.add(key)
      }
      const flow: FlowGraph = { runs, pins }
      const solver = new FlowSolver(flow, flowNetOf(pinNet, ground))
      const injection = new Map(Object.keys(pins).map((key) => [key, Math.round((next() * 4 - 2) * 100) / 100]))
      const terminal = (key: string) => injection.get(key) ?? 0
      const reference = referenceWireCurrents(flow, pinNet, schematicTies(ground), terminal)
      const now = solver.currents(terminal).wires
      for (const [id, amps] of reference) expect.soft(now.get(id), `round ${round}, ${id}, every terminal at once`).toBeNear(amps, 1e-9)
      for (const key of Object.keys(pins)) {
        const unit = solver.unit(key).wires
        for (const [id, amps] of referenceWireCurrents(flow, pinNet, schematicTies(ground), (k) => (k === key ? 1 : 0))) expect.soft(unit.get(id) ?? 0, `round ${round}, ${key} → ${id}`).toBeNear(amps, 1e-9)
      }
    }
  })

  it("the currents the solver builds once per terminal equal the ones solved for every terminal afresh (findings 3.L6)", () => {
    const doc = examples.find((e) => e.id === "power-supply")!.build(GRID)
    const circuit = circuitOf(doc)
    const net = buildNetlist(circuit)
    const solver = new FlowSolver(circuit.flow, net)
    const keys = Object.keys(circuit.flow.pins).filter((key) => net.pinNet.has(key))
    expect.soft(keys.length, "terminals to try").toBeGreaterThan(5)
    for (const key of keys) {
      const afresh = [...referenceWireCurrents(circuit.flow, net.pinNet, net.groundTies, (k) => (k === key ? 1 : 0))].filter(([, amps]) => Math.abs(amps) > 1e-12)
      const once = [...solver.unit(key).wires].filter(([, amps]) => Math.abs(amps) > 1e-12)
      expect.soft(once.map(([id]) => id).sort(), `${key}: the runs it drives`).toEqual(afresh.map(([id]) => id).sort())
      for (const [id, amps] of afresh) expect.soft(solver.unit(key).wires.get(id), `${key} → ${id}`).toBeNear(amps, 1e-9)
    }
  })
})
