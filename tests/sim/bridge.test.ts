/**
 * Voltage drops across the resistor bridge example, checked against a nodal solve done here
 * by hand. The check is independent of the simulator: three node equations written out from
 * the topology and solved by Cramer's rule, with no MNA and no matrix code in common.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { examples } from "@/schematic/examples"
import { SimLoop } from "@/sim/loop"

const example = examples.find((e) => e.id === "bridge")!
const doc = example.build(GRID)
const byRef = new Map(doc.objects.map((o) => [o.props?.ref ?? "", o]))

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

const across: Record<string, [keyof typeof node, keyof typeof node]> = {
  R1: [1, 2],
  R4: [1, 2],
  R2: [1, 3],
  R3: [2, 3],
  R6: [2, 4],
  R7: [3, 4],
  R5: [4, "B"],
}
const drop = (ref: string) => {
  const [p, q] = across[ref]
  return node[p] - node[q]
}

describe("resistor bridge", () => {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  for (let i = 0; i < 40; i++) loop.advance((clock += 25))
  const snap = loop.snapshot()!

  it.each(Object.keys(across))("drops the hand-solved voltage across %s", (ref) => {
    const obj = byRef.get(ref)!
    const r = snap.readings.find((x) => x.object === obj.id)!
    expect(Math.abs(r.voltage)).toBeNearRel(Math.abs(drop(ref)), 1e-3)
  })

  // Delta-wye on the R3/R6/R7 triangle turns the bridge into series and parallel arms, so the
  // whole network reduces by hand with no linear algebra at all. If this agrees, the answer is
  // not an artefact of either set of equations.
  it("agrees with a delta-wye reduction", () => {
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
    expect.soft(total, "total resistance").toBeNearRel(V / (node[4] / R.R5), 1e-9)
    expect.soft(iTotal, "supply current").toBeNearRel(node[4] / R.R5, 1e-9)
    expect.soft(V - iLeft * ((R.R1 * R.R4) / (R.R1 + R.R4)), "left corner").toBeNearRel(node[2], 1e-9)
    expect.soft(V - (iTotal - iLeft) * R.R2, "right corner").toBeNearRel(node[3], 1e-9)
    expect.soft(iTotal * R.R5, "bottom corner").toBeNearRel(node[4], 1e-9)
  })

  it("satisfies KVL along two loops", () => {
    expect(drop("R1") - drop("R2") + drop("R3")).toBeNear(0, 1e-9)
    expect(drop("R3") + drop("R7") - drop("R6")).toBeNear(0, 1e-9)
  })
})
