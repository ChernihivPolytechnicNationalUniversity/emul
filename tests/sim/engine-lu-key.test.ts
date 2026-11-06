import { describe, expect, it } from "vitest"
import { Engine } from "@/sim/engine"
import type { Netlist } from "@/sim/netlist"

const PAD_OHMS = 25
const VDD = 3.3

const padIntoLiveLoad: Netlist = {
  nodes: 1,
  sources: 0,
  elements: [
    { id: "u:load", object: "u", element: 0, ref: "U1", kind: "R", a: 0, b: -1, value: 1, live: "$idd", keys: ["u:P", "u:GND"] },
    { id: "u:pad", object: "u", element: 1, ref: "U1", kind: "GPIO", node: 0, nodeKey: "P", vdd: VDD, vddNet: undefined, gndNet: undefined, ohms: PAD_OHMS, ohmsAt: 0, pull: 40000, keys: ["u:P"] },
  ],
  pinNet: new Map([["u:P", 0], ["u:GND", -1]]),
  nodeNet: new Map(),
  groundTies: new Map([["u:GND", "reference"]]),
  contacts: new Map(),
  conductorOf: new Map(),
  partShorts: [],
}

function bench() {
  const engine = new Engine(padIntoLiveLoad)
  const drive = { ohms: 1, state: "low" as "high" | "low" }
  const step = (ohms: number, state: "high" | "low") => {
    drive.ohms = ohms
    drive.state = state
    const before = engine.factorizationCount
    engine.step(20e-6, () => ({}), (_: number, __: string, node: string) => (node === "$idd" ? drive.ohms : drive.state))
    return { volts: engine.v[0], factorized: engine.factorizationCount > before }
  }
  return step
}

const divider = (load: number) => (VDD * load) / (load + PAD_OHMS)

describe("the cached factorization is keyed on every pad and live resistance", () => {
  it("a pad going high while a live load goes from 1 to 32 Ω is factorized anew", () => {
    const step = bench()
    step(1, "low")
    const next = step(32, "high")
    expect.soft(next.factorized, "31·2 + 1 = 31·1 + 32: a base-31 key took these two states for one").toBe(true)
    expect.soft(next.volts, "the pad's 25 Ω into 32 Ω").toBeNear(divider(32), 1e-6)
  })

  it("a live load moving by a fraction of an ohm is not truncated out of the key", () => {
    const step = bench()
    step(66.2, "high")
    const next = step(66.7, "high")
    expect.soft(next.factorized, "66.2 Ω and 66.7 Ω are different circuits").toBe(true)
    expect.soft(next.volts, "the pad's 25 Ω into 66.7 Ω").toBeNear(divider(66.7), 1e-6)
  })

  it("an unchanged circuit keeps its factorization", () => {
    const step = bench()
    step(32, "high")
    const again = step(32, "high")
    expect.soft(again.factorized, "nothing moved").toBe(false)
    expect.soft(again.volts).toBeNear(divider(32), 1e-6)
  })
})
