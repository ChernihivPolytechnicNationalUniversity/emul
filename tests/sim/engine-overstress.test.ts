import { describe, expect, it } from "vitest"
import { olimexStm32H405 } from "@/schematic/components/olimex-stm32-h405"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey } from "@/schematic/types"
import { Engine } from "@/sim/engine"
import { buildNetlist, type ResolvedLimits } from "@/sim/netlist"

const STEP = 10e-3
const timed = (seconds: number, extra: Partial<ResolvedLimits> = {}): ResolvedLimits => ({ voltage: 1, tau: 3, fail: "short", fatal: false, overstress: { seconds }, ...extra })
const overstressed = (engine: Engine) => (engine as unknown as { overstressed: Float64Array }).overstressed

describe("Limits.overstress: a rating that may be exceeded for a while", () => {
  it("counts each element's time over its rating once a step, settled or not: the long timer has run exactly as long as the short one when the short one fails", () => {
    const { place, wire, doc } = builder(GRID)
    const src = place("dc-source", 0, 0, { value: "2 V", rint: "1 Ω" })
    const gnd = place("ground", 0, 10)
    const a = place("capacitor", 10, 0, { value: "1 µF", vmax: "100 V" })
    const b = place("capacitor", 20, 0, { value: "1 µF", vmax: "100 V" })
    wire(src, "+", a, "1")
    wire(src, "+", b, "1")
    wire(a, "2", gnd, "GND")
    wire(b, "2", gnd, "GND")
    wire(src, "-", gnd, "GND")
    const net = buildNetlist(doc)
    const capOf = (id: string) => net.elements.findIndex((el) => el.kind === "C" && el.object === id)
    net.elements[capOf(a.id)].limits = timed(30)
    net.elements[capOf(b.id)].limits = timed(0.5)
    const engine = new Engine(net)
    let t = 0
    while (!engine.failures.length && t < 1) {
      engine.step(STEP, () => ({}))
      t += STEP
    }
    expect.soft(engine.failures[0]?.object, "the 0.5 s one fails first").toBe(b.id)
    expect.soft(t, "at 0.5 s").toBeNear(0.5 + STEP, STEP)
    expect.soft(overstressed(engine)[capOf(a.id)], "the 30 s one has counted the same time, not a step more").toBeNear(t, 1e-9)
  })

  it("rates the same voltage on settled and full steps: a regulator's input, as its own rating does", () => {
    const failsAfter = (forceFull: boolean) => {
      const { place, wire, doc } = builder(GRID)
      const board = place("olimex-stm32-h405", 0, 0)
      doc.parts[partKey(board.id, "USB")] = { on: false }
      const src = place("dc-source", 80, 0, { value: "18 V", rint: "1 mΩ" })
      const gnd = place("ground", 80, 10)
      wire(src, "+", board, "EXT2-26")
      wire(src, "-", gnd, "GND")
      wire(gnd, "GND", board, "EXT2-25")
      const vr = olimexStm32H405.model!.findIndex((el) => "label" in el && el.label === "VR LM1117-ADJ")
      const net = buildNetlist(doc)
      const i = net.elements.findIndex((el) => el.kind === "REG" && el.object === board.id && el.element === vr)
      net.elements[i].limits = timed(0.5, { voltage: 16, fail: "open" })
      const engine = new Engine(net)
      let t = 0
      const parts = (k: string) => doc.parts[k] ?? {}
      while (!engine.failures.some((f) => f.damage.element === vr) && t < 2) {
        if (forceFull) (engine as unknown as { settledRun: number }).settledRun = 0
        engine.step(STEP, parts)
        t += STEP
      }
      return t
    }
    const settled = failsAfter(false)
    expect.soft(settled, "on the settled path").toBeNear(0.5 + STEP, STEP)
    expect.soft(failsAfter(true), "with every step a full one").toBeNear(settled, STEP)
  })
})
