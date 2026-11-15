import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { wirePins } from "@/schematic/migrate-wires"
import { pinKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { pinPartition, wireNets } from "@/schematic/wires/graph"
import { Engine } from "@/sim/engine"
import { buildNetlist, GROUND } from "@/sim/netlist"
import { DT } from "@/sim/speeds"
import { canonical } from "../lib/pin-partition"

type Collector = "VT1" | "VT2"

type Reference = {
  threshold: number
  steady: { from: number; vt1Off: number; vt2Off: number }
}

const reference: Reference = JSON.parse(readFileSync(new URL("../data/multivibrator/reference.json", import.meta.url), "utf8"))

const SIMULATED = 0.13
const PERIODS = 10
const STEPS_OF_TOLERANCE = 3
const WOBBLE_FLOOR = 1e-3

function multivibratorWithAnOrthogonalX() {
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
  b.wire(r2, "2", vt2, "B", [[6, 7], [15, 7]])
  b.wire(r3, "2", vt1, "B", [[14, 6], [5, 6]])
  return b.doc
}

const CIRCUIT = [
  ["C1:1", "R1:2", "VT1:C"],
  ["C1:2", "R2:2", "VT2:B"],
  ["C2:1", "R3:2", "VT1:B"],
  ["C2:2", "R4:2", "VT2:C"],
  ["G1:GND", "VT1:E", "VT2:E"],
  ["R1:1", "R2:1", "R3:1", "R4:1", "V1:V"],
]

const byRef = (doc: Schematic, ref: string): PlacedObject => doc.objects.find((o) => o.props?.ref === ref)!

function partitionOf(doc: Schematic) {
  const refs = new Map(doc.objects.map((o) => [o.id, o.props?.ref ?? o.id]))
  const groups = pinPartition(wireNets(doc.wires, wirePins(doc.objects)))
  return canonical(groups.map((g) => g.map((key) => `${refs.get(key.slice(0, key.indexOf(":")))}${key.slice(key.indexOf(":"))}`)))
}

function run(doc: Schematic, dt: number) {
  const e = new Engine(buildNetlist(doc))
  const node = (ref: string, pin: string) => e.net.pinNet.get(pinKey(byRef(doc, ref).id, pin))!
  const volts = (net: number) => (net === GROUND ? 0 : e.v[net])
  const nets = { c1: node("VT1", "C"), c2: node("VT2", "C"), b1: node("VT1", "B"), b2: node("VT2", "B") }
  const trace = { c1: [volts(nets.c1)], c2: [volts(nets.c2)], b1: [volts(nets.b1)], b2: [volts(nets.b2)] }
  const unsolved: number[] = []
  const parts = (key: string) => doc.parts[key] ?? {}
  const steps = Math.round(SIMULATED / dt)
  for (let k = 1; k <= steps; k++) {
    e.step(dt, parts)
    if (!e.converged) unsolved.push(k * dt)
    for (const key of ["c1", "c2", "b1", "b2"] as const) trace[key].push(volts(nets[key]))
  }
  return { trace, unsolved }
}

const runs = new Map<number, ReturnType<typeof run>>()
function runAt(dt: number) {
  if (!runs.has(dt)) runs.set(dt, run(multivibratorWithAnOrthogonalX(), dt))
  return runs.get(dt)!
}

type Fall = { collector: Collector; step: number; at: number }

function fallsOf(trace: ReturnType<typeof run>["trace"], dt: number): Fall[] {
  const falls: Fall[] = []
  const th = reference.threshold
  for (let k = 1; k < trace.c1.length; k++) {
    for (const [collector, v] of [["VT1", trace.c1], ["VT2", trace.c2]] as const) {
      if (v[k - 1] >= th && v[k] < th) falls.push({ collector, step: k, at: (k - 1 + (v[k - 1] - th) / (v[k - 1] - v[k])) * dt })
    }
  }
  return falls
}

const ms = (s: number) => `${(s * 1e3).toFixed(3)} ms`

describe("the transistor astable multivibrator through its regenerative switches, against ngspice 45.2 on the same netlist (tests/data/multivibrator; the X drawn as two orthogonal wires, the pin partition of the reference)", () => {
  it("the orthogonal X is the circuit of the reference netlist, node for node", () => {
    expect.soft(partitionOf(multivibratorWithAnOrthogonalX()), "the partition of multivibrator.cir").toEqual(canonical(CIRCUIT))
  })

  for (const dt of [DT, DT / 4]) {
    const tolerance = STEPS_OF_TOLERANCE * dt
    it(`at ${(dt * 1e6).toFixed(0)} µs a step: every step's Newton iteration converges, the switches included, the collectors fall in turn for ${PERIODS} periods and every steady half-period is within three steps (${(tolerance * 1e6).toFixed(0)} µs) of ngspice's VT1 off ${(reference.steady.vt1Off * 1e3).toFixed(4)} ms, VT2 off ${(reference.steady.vt2Off * 1e3).toFixed(4)} ms`, () => {
      const { trace, unsolved } = runAt(dt)
      expect.soft(unsolved.map(ms), "steps whose Newton iteration ran out without converging (each one used to commit a non-solution to the capacitors)").toEqual([])
      const falls = fallsOf(trace, dt)
      const repeats = falls.filter((f, i) => i > 0 && f.collector === falls[i - 1].collector).map((f) => `${f.collector} at ${ms(f.at)}`)
      expect.soft(repeats, "each fall is the other collector's: no aborted transition, no collector falling twice running").toEqual([])
      const steady = falls.filter((f) => f.at >= reference.steady.from)
      const halves = steady.slice(1).map((f, i) => ({ off: f.collector, from: steady[i].at, length: f.at - steady[i].at }))
      expect.soft(halves.length, `at least ${2 * PERIODS} steady half-periods in ${SIMULATED * 1e3} ms`).toBeGreaterThanOrEqual(2 * PERIODS)
      for (const half of halves) {
        const want = half.off === "VT1" ? reference.steady.vt1Off : reference.steady.vt2Off
        expect.soft(half.length, `${half.off} off from ${ms(half.from)}, ngspice ${(want * 1e3).toFixed(4)} ms`).toBeNear(want, tolerance)
      }
    })

    it(`at ${(dt * 1e6).toFixed(0)} µs a step: an off transistor's base charges through its 47 kΩ like the RC exponential it is — rising at every step until the switch, with no step-to-step alternation (consecutive second differences of opposite sign, both over ${WOBBLE_FLOOR * 1e3} mV; the exponential's own are under 0.2 mV)`, () => {
      const { trace } = runAt(dt)
      const falls = fallsOf(trace, dt)
      let stretches = 0
      for (let i = 1; i < falls.length; i++) {
        const [before, end] = [falls[i - 1], falls[i]]
        if (before.collector === end.collector) continue
        const base = end.collector === "VT1" ? trace.b1 : trace.b2
        const charging = base.slice(before.step, end.step)
        const rise = charging.slice(1).map((v, k) => v - charging[k])
        const bend = rise.slice(1).map((d, k) => d - rise[k])
        const label = `${end.collector}'s base from ${ms(before.at)} to ${ms(end.at)}`
        stretches++
        const falling = rise.flatMap((d, k) => (d <= 0 ? [`${ms((before.step + k + 1) * dt)}: ${(d * 1e3).toFixed(1)} mV`] : []))
        expect.soft(falling, `${label} never falls while it charges`).toEqual([])
        const wobbles = bend.flatMap((d, k) => (k > 0 && Math.sign(d) !== Math.sign(bend[k - 1]) && Math.min(Math.abs(d), Math.abs(bend[k - 1])) > WOBBLE_FLOOR ? [`${ms((before.step + k + 2) * dt)}: ${(bend[k - 1] * 1e3).toFixed(1)} then ${(d * 1e3).toFixed(1)} mV`] : []))
        expect.soft(wobbles, `${label} does not alternate step to step`).toEqual([])
      }
      expect.soft(stretches, `the charging stretches of ${PERIODS} periods`).toBeGreaterThanOrEqual(2 * PERIODS)
    })
  }
})
