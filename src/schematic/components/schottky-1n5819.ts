import { junctionDropAt10mA } from "@/sim/junction"
import type { Element, NodeRef } from "../types"

export const SCHOTTKY_1N5819 = {
  forward: { is: 3.282e-6, n: 1.0191, rs: 0.0826 },
  leakage: { is: 16.5e-6, n: 5, shuntOhms: 194.5e3 },
  ratings: { current: 1, surge: 25, voltage: 40, tau: 3, fail: "short", fatal: false },
} as const

export function schottky1n5819(anode: NodeRef, cathode: NodeRef): Element[] {
  const { forward, leakage, ratings } = SCHOTTKY_1N5819
  return [
    { kind: "D", anode, cathode, vf: junctionDropAt10mA(forward.is, forward.n), emission: forward.n, rs: forward.rs, limits: ratings },
    { kind: "D", anode, cathode, vf: junctionDropAt10mA(leakage.is, leakage.n), emission: leakage.n, hidden: true },
    { kind: "R", a: anode, b: cathode, value: leakage.shuntOhms, hidden: true },
  ]
}
