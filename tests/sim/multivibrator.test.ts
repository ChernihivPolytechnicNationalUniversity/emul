import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID, type Point } from "@/schematic/geometry"
import { stamped, upgraded } from "@/schematic/migrate"
import { wirePins } from "@/schematic/migrate-wires"
import { pinKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { junctionsOf, pinPartition, wireNets } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { Engine } from "@/sim/engine"
import { buildNetlist, GROUND } from "@/sim/netlist"
import { DT } from "@/sim/speeds"
import { crossingOf, diagonalNormalFormViolations } from "../lib/diagonal-reference"
import { canonical } from "../lib/pin-partition"
import { geometryOf } from "../lib/wire-reference"

type Fall = { collector: "VT1" | "VT2"; at: number }

type Reference = {
  threshold: number
  collectorFalls: Fall[]
  steady: { from: number; vt1Off: number; vt2Off: number }
  collectorSwing: Record<"VT1" | "VT2", [number, number]>
}

const reference: Reference = JSON.parse(readFileSync(new URL("../data/multivibrator/reference.json", import.meta.url), "utf8"))

const SIMULATED = 0.08
const TOLERANCE = 3 * DT

const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })

function multivibrator() {
  const b = builder(GRID)
  const v1 = b.place("supply", -1, -2, { ref: "V1", value: "+5V", voltage: "5 V" })
  const r1 = b.place("resistor", 1, 0, { ref: "R1", value: "1 kΩ" }, 90)
  const r2 = b.place("resistor", 5, 0, { ref: "R2", value: "47 kΩ" }, 90)
  const r3 = b.place("resistor", 13, 0, { ref: "R3", value: "47 kΩ" }, 90)
  const r4 = b.place("resistor", 17, 0, { ref: "R4", value: "1 kΩ" }, 90)
  b.place("capacitor", 2, 3, { ref: "C1", value: "220 nF" })
  b.place("capacitor", 14, 3, { ref: "C2", value: "100 nF" })
  const vt1 = b.place("npn", 1, 8, { ref: "VT1" })
  vt1.mirror = true
  const vt2 = b.place("npn", 15, 8, { ref: "VT2" })
  const g1 = b.place("ground", 9, 14, { ref: "G1" })
  b.wire(v1, "V", r1, "1")
  b.wire(r1, "1", r2, "1")
  b.wire(r2, "1", r3, "1")
  b.wire(r3, "1", r4, "1")
  b.wire(r1, "2", vt1, "C")
  b.wire(r4, "2", vt2, "C")
  b.wire(vt1, "E", g1, "GND", [[2, 14]])
  b.wire(vt2, "E", g1, "GND", [[18, 14]])
  b.straight(r2, "2", vt2, "B")
  b.straight(r3, "2", vt1, "B")
  return b.doc
}

const refOf = (doc: Schematic) => new Map(doc.objects.map((o) => [o.id, o.props?.ref ?? o.id]))
const byRef = (doc: Schematic, ref: string): PlacedObject => doc.objects.find((o) => o.props?.ref === ref)!
const named = (doc: Schematic, groups: readonly (readonly string[])[]) => {
  const refs = refOf(doc)
  return canonical(groups.map((g) => g.map((key) => `${refs.get(key.slice(0, key.indexOf(":")))}${key.slice(key.indexOf(":"))}`)))
}
const partitionOf = (doc: Schematic) => named(doc, pinPartition(wireNets(doc.wires, wirePins(doc.objects))))
const diagonalsOf = (doc: Schematic) => doc.wires.filter((s) => s.a.x !== s.b.x && s.a.y !== s.b.y)

const CIRCUIT = [
  ["C1:1", "R1:2", "VT1:C"],
  ["C1:2", "R2:2", "VT2:B"],
  ["C2:1", "R3:2", "VT1:B"],
  ["C2:2", "R4:2", "VT2:C"],
  ["G1:GND", "VT1:E", "VT2:E"],
  ["R1:1", "R2:1", "R3:1", "R4:1", "V1:V"],
]

function collectorFalls(doc: Schematic) {
  const e = new Engine(buildNetlist(doc))
  const node = (ref: string, pin: string) => e.net.pinNet.get(pinKey(byRef(doc, ref).id, pin))
  const volts = (net: number | undefined) => (net === undefined || net === GROUND ? 0 : e.v[net])
  const nets = { VT1: node("VT1", "C"), VT2: node("VT2", "C") }
  const swing = { VT1: [Infinity, -Infinity], VT2: [Infinity, -Infinity] }
  const falls: Fall[] = []
  let last = { VT1: volts(nets.VT1), VT2: volts(nets.VT2) }
  const parts = (key: string) => doc.parts[key] ?? {}
  const steps = Math.round(SIMULATED / DT)
  for (let k = 0; k < steps; k++) {
    e.step(DT, parts)
    for (const collector of ["VT1", "VT2"] as const) {
      const now = volts(nets[collector])
      const before = last[collector]
      if (before >= reference.threshold && now < reference.threshold) falls.push({ collector, at: (k + (before - reference.threshold) / (before - now)) * DT })
      if ((k + 1) * DT >= reference.steady.from) swing[collector] = [Math.min(swing[collector][0], now), Math.max(swing[collector][1], now)]
      last = { ...last, [collector]: now }
    }
  }
  return { falls, swing }
}

function halfPeriods(falls: readonly Fall[]) {
  const steady = falls.filter((f) => f.at >= reference.steady.from)
  const out: { off: "VT1" | "VT2"; length: number; from: number }[] = []
  for (let i = 1; i < steady.length; i++) out.push({ off: steady[i].collector, length: steady[i].at - steady[i - 1].at, from: steady[i - 1].at })
  return out
}

describe("acceptance 6: the transistor astable multivibrator with its cross-coupling wires drawn as an X of diagonals (plan.md acceptance 6; design.md §6.11 «Acceptance»; mockups/multivibrator-reference.png)", () => {
  it("built through the builder, the X is two straight diagonal segments: R2's foot to VT2's base and R3's foot to VT1's base, in normal form", () => {
    const doc = multivibrator()
    expect.soft(geometryOf(diagonalsOf(doc)), "two diagonals, one segment each").toEqual(geometryOf([{ id: "x1", a: at(6, 4), b: at(15, 10) }, { id: "x2", a: at(14, 4), b: at(5, 10) }] as WireSegment[]))
    expect.soft(diagonalNormalFormViolations(doc.wires, wirePins(doc.objects)), "normal form").toEqual([])
  })

  it("at the crossing no dot and no connection: the legs cross between lattice points, each stays whole and on its own net (ГОСТ 2.721-74 item 5; IEEE 315-1975 3.1.5)", () => {
    const doc = multivibrator()
    const [one, two] = diagonalsOf(doc)
    const crossing = crossingOf(one, two)
    expect.soft(crossing && { x: crossing.x / GRID, y: crossing.y / GRID }, "they cross at (10, 6⅔)").toEqual({ x: 10, y: 20 / 3 })
    const view = wireNets(doc.wires, wirePins(doc.objects))
    expect.soft(junctionsOf(view).some((p) => crossing && Math.hypot(p.x - crossing.x, p.y - crossing.y) < GRID), "no dot within a cell of the crossing").toBe(false)
    expect.soft(view.netOfSegment(one.id) === view.netOfSegment(two.id), "two nets").toBe(false)
    expect.soft(partitionOf(doc), "the circuit of the reference netlist, node for node").toEqual(canonical(CIRCUIT))
  })

  it(`oscillates: the collectors fall in turn and every steady half-period is within ${(TOLERANCE * 1e6).toFixed(0)} µs (three 20 µs steps) of ngspice's on the same netlist, VT1 off ${(reference.steady.vt1Off * 1e3).toFixed(4)} ms (R3·C2), VT2 off ${(reference.steady.vt2Off * 1e3).toFixed(4)} ms (R2·C1) (tests/data/multivibrator)`, () => {
    const doc = multivibrator()
    const { falls, swing } = collectorFalls(doc)
    expect.soft(falls.length, `at least ${reference.collectorFalls.length - 1} collector falls in ${SIMULATED * 1e3} ms, as ngspice's ${reference.collectorFalls.length}`).toBeGreaterThanOrEqual(reference.collectorFalls.length - 1)
    const repeats = falls.filter((f, i) => i > 0 && f.collector === falls[i - 1].collector).map((f) => `${f.collector} at ${(f.at * 1e3).toFixed(3)} ms`)
    expect.soft(repeats, "each fall is the other collector's: no collector falls twice running").toEqual([])
    for (const half of halfPeriods(falls)) {
      const want = half.off === "VT1" ? reference.steady.vt1Off : reference.steady.vt2Off
      expect.soft(half.length, `${half.off} off from ${(half.from * 1e3).toFixed(3)} ms, ngspice ${(want * 1e3).toFixed(4)} ms`).toBeNear(want, TOLERANCE)
    }
    for (const collector of ["VT1", "VT2"] as const) {
      expect.soft(swing[collector][0], `${collector}'s collector saturates, ngspice ${reference.collectorSwing[collector][0]} V`).toBeLessThan(0.2)
      expect.soft(swing[collector][1], `${collector}'s collector rises to the rail, ngspice ${reference.collectorSwing[collector][1]} V`).toBeGreaterThan(4.8)
    }
  })
})

describe("nothing changes in simulation or format (design.md §6.11 rule 13, §9, §10)", () => {
  it("saved and opened again, the two diagonals and the circuit come back as they were, with nothing to migrate", () => {
    const doc = multivibrator()
    const opened = upgraded(JSON.parse(JSON.stringify(stamped(doc))))
    expect.soft(opened.notes, "no upgrade notes").toEqual([])
    expect.soft(opened.doc.wires, "every segment, ids and ends").toEqual(doc.wires)
    expect.soft(partitionOf(opened.doc), "the circuit").toEqual(canonical(CIRCUIT))
  })

  it("the solver reads the pin partition only: each X leg joins its foot to the far base, and the two bases are two nodes", () => {
    const doc = multivibrator()
    const net = buildNetlist(doc)
    const node = (ref: string, pin: string) => net.pinNet.get(pinKey(byRef(doc, ref).id, pin))
    expect.soft(node("R2", "2"), "R2's foot is VT2's base").toBe(node("VT2", "B"))
    expect.soft(node("R3", "2"), "R3's foot is VT1's base").toBe(node("VT1", "B"))
    expect.soft(node("VT1", "B") === node("VT2", "B"), "the bases apart").toBe(false)
  })
})
