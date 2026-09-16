/**
 * Voltage drops across the resistor bridge example, checked against a nodal solve done here
 * by hand. The check is independent of the simulator: three node equations written out from
 * the topology and solved by Cramer's rule, with no MNA and no matrix code in common.
 *
 *   pnpm bridge
 */
import { GRID } from "@/schematic/geometry"
import { examples } from "@/schematic/examples"
import { SimLoop } from "@/sim/loop"
import { formatSI } from "@/sim/units"

const example = examples.find((e) => e.id === "bridge")!
const doc = example.build(GRID)
const byRef = new Map(doc.objects.map((o) => [o.props?.ref ?? "", o]))

const loop = new SimLoop()
loop.setDoc(doc)
loop.setRunning(true)
let clock = 0
loop.advance(clock)
for (let i = 0; i < 40; i++) loop.advance((clock += 25))
const snap = loop.snapshot()!

// --- the hand solve ----------------------------------------------------------
// Nodes: 1 = A (the +12 V rail, tied to the top corner by wire), 2 = left corner,
// 3 = right corner, 4 = bottom corner. B is ground.
//   R4 and R1 both run 1-2, R2 runs 1-3, R3 runs 2-3, R6 runs 2-4, R7 runs 3-4, R5 runs 4-B.
const V = 12
const R = { R1: 1e3, R2: 2.2e3, R3: 4.7e3, R4: 1.5e3, R5: 470, R6: 3.3e3, R7: 680 }
const g = (r: number) => 1 / r
const g12 = g(R.R4) + g(R.R1)
// Node 2: (V2−V1)·g12 + (V2−V3)·g3 + (V2−V4)·g6 = 0, and so on for 3 and 4.
const A = [
  [g12 + g(R.R3) + g(R.R6), -g(R.R3), -g(R.R6)],
  [-g(R.R3), g(R.R2) + g(R.R3) + g(R.R7), -g(R.R7)],
  [-g(R.R6), -g(R.R7), g(R.R6) + g(R.R7) + g(R.R5)],
]
const b = [V * g12, V * g(R.R2), 0]
const det3 = (m: number[][]) =>
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
  m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
  m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
const D = det3(A)
const sub = (col: number) => det3(A.map((row, i) => row.map((v, j) => (j === col ? b[i] : v))))
const [V2, V3, V4] = [sub(0) / D, sub(1) / D, sub(2) / D]
const node = { 1: V, 2: V2, 3: V3, 4: V4, B: 0 }

/** Expected drop across each resistor, from the hand-solved node voltages. */
const across: Record<string, [keyof typeof node, keyof typeof node]> = {
  R1: [1, 2],
  R4: [1, 2],
  R2: [1, 3],
  R3: [2, 3],
  R6: [2, 4],
  R7: [3, 4],
  R5: [4, "B"],
}

console.log(`Node voltages (hand solve): A ${V.toFixed(3)} V, left ${V2.toFixed(3)} V, right ${V3.toFixed(3)} V, bottom ${V4.toFixed(3)} V\n`)
console.log("part    value      drop        expected     current     power     check")

let worst = 0
for (const [ref, [p, q]] of Object.entries(across)) {
  const obj = byRef.get(ref)!
  const r = snap.readings.find((x) => x.object === obj.id)!
  const want = node[p] - node[q]
  const got = Math.abs(r.voltage)
  const err = Math.abs(got - Math.abs(want)) / Math.abs(want)
  worst = Math.max(worst, err)
  console.log(
    `${ref.padEnd(6)} ${formatSI(R[ref as keyof typeof R], "Ω", 1).padStart(8)}  ${formatSI(got, "V", 4).padStart(10)}  ${formatSI(Math.abs(want), "V", 4).padStart(10)}  ${formatSI(Math.abs(r.current), "A", 3).padStart(10)}  ${formatSI(r.power, "W", 3).padStart(9)}  ${err < 1e-3 ? "ok" : `${(err * 100).toFixed(2)}% off`}`,
  )
}

// --- a second check by a different method -------------------------------------
// Delta-wye on the R3/R6/R7 triangle turns the bridge into series and parallel arms, so the
// whole network reduces by hand with no linear algebra at all. If this agrees, the answer is
// not an artefact of either set of equations.
{
  const sum = R.R3 + R.R6 + R.R7
  const yL = (R.R3 * R.R6) / sum
  const yR = (R.R3 * R.R7) / sum
  const yB = (R.R6 * R.R7) / sum
  const left = (R.R1 * R.R4) / (R.R1 + R.R4) + yL
  const right = R.R2 + yR
  const total = (left * right) / (left + right) + yB + R.R5
  const iTotal = V / total
  const vCentre = iTotal * (yB + R.R5)
  const iLeft = (V - vCentre) / left
  const wye = {
    "total resistance": total,
    "supply current": iTotal,
    "left corner": V - iLeft * ((R.R1 * R.R4) / (R.R1 + R.R4)),
    "right corner": V - (iTotal - iLeft) * R.R2,
    "bottom corner": iTotal * R.R5,
  }
  const nodal = { "total resistance": V / (node[4] / R.R5), "supply current": node[4] / R.R5, "left corner": node[2], "right corner": node[3], "bottom corner": node[4] }
  console.log("\nDelta-wye reduction vs the node equations:")
  for (const [what, value] of Object.entries(wye)) {
    const other = nodal[what as keyof typeof nodal]
    const unit = what === "total resistance" ? "Ω" : what === "supply current" ? "A" : "V"
    console.log(`  ${what.padEnd(18)} ${formatSI(value, unit, 4).padStart(11)}  vs ${formatSI(other, unit, 4).padStart(11)}  ${Math.abs(value - other) / Math.abs(other) < 1e-9 ? "same" : "DIFFER"}`)
  }
}

// Kirchhoff's voltage law along two independent loops, as a third, cheaper check.
const drop = (ref: string) => {
  const [p, q] = across[ref]
  return node[p] - node[q]
}
const loopA = drop("R1") - drop("R2") + drop("R3")
const loopB = drop("R3") + drop("R7") - drop("R6")
console.log(`\nKVL A→left→right→A: ${loopA.toExponential(1)} V; left→right→bottom→left: ${loopB.toExponential(1)} V`)
console.log(`Worst deviation from the hand solve: ${(worst * 100).toFixed(3)} %`)
process.exit(worst > 1e-3 ? 1 : 0)
