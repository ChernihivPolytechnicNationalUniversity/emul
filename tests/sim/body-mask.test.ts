import { describe, expect, it } from "vitest"
import { bodyMaskShapes } from "@/components/field/body-mask"
import { GRID } from "@/schematic/geometry"
import { examples } from "@/schematic/examples"
import type { PlacedObject } from "@/schematic/types"

const c = (v: number) => v * GRID
const boxOf = (points: readonly { x: number; y: number }[]) => {
  const xs = points.map((p) => p.x / GRID)
  const ys = points.map((p) => p.y / GRID)
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

describe("a crossing's gap cuts wires, never a part's body (the user, 2026-11-11: a wire through R10 cut its outline)", () => {
  it("a lying resistor keeps its drawn body out of the gaps: one polygon from (1, 0.6) to (3, 1.4) cells off its corner", () => {
    const r: PlacedObject = { id: "R1", def: "resistor", x: c(10), y: c(10), props: { ref: "R1" } }
    const shapes = bodyMaskShapes([r], GRID)
    expect.soft(shapes.bodies.length, "one body").toBe(1)
    expect.soft(boxOf(shapes.bodies[0]), "its drawn body").toEqual({ x0: 11, y0: 10.6, x1: 13, y1: 11.4 })
    expect.soft(shapes.leads.map(([pin]) => boxOf([pin])), "both leads, from each pin").toEqual([{ x0: 10, y0: 11, x1: 10, y1: 11 }, { x0: 14, y0: 11, x1: 14, y1: 11 }])
    expect.soft(shapes.texts.length, "its designator and value: a wire over them leaves them whole").toBe(2)
  })

  it("a standing resistor's body turns with it", () => {
    const r: PlacedObject = { id: "R1", def: "resistor", x: c(10), y: c(10), rotation: 90, props: { ref: "R1" } }
    const box = boxOf(bodyMaskShapes([r], GRID).bodies[0])
    expect.soft([box.x1 - box.x0, box.y1 - box.y0].map((v) => Math.round(v * 1000) / 1000), "0.8 wide, 2 tall").toEqual([0.8, 2])
  })

  it("a board is not kept out: a wire over a board still cuts what it passes, its sockets included (design.md §4.5)", () => {
    const board = examples.find((e) => e.id === "lab1-running-light")!.build(GRID).objects.find((o) => o.def === "open746i-c")!
    expect(bodyMaskShapes([board], GRID)).toEqual({ bodies: [], leads: [], texts: [] })
  })
})
