import { describe, expect, it } from "vitest"
import { netCuts } from "@/components/field/wire-cuts"
import { GRID, type Point, type RoutedWire } from "@/schematic/geometry"

const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const route = (id: string, ...pts: Point[]): RoutedWire => ({ id, pts }) as RoutedWire

describe("a crossing gap masks a net only by the nets that really come near it (Codex review 2026-11-16)", () => {
  it("1000 nested L-shaped nets whose boxes all overlap but whose wires never cross reference only their neighbours", () => {
    const n = 1000
    const groups = Array.from({ length: n }, (_, i) => ({ wires: [route(`w${i}`, at(i, 0), at(i, n - i), at(n + 1, n - i))] }))
    const started = performance.now()
    const cuts = netCuts(groups, GRID)
    const elapsed = performance.now() - started
    const references = cuts.cutBy.reduce((sum, later) => sum + later.length, 0)
    expect.soft(references, "references stay linear in the nets, not n²/2 = 499 500").toBeLessThanOrEqual(2 * n)
    expect.soft(elapsed, "computed in well under a second").toBeLessThan(500)
  })

  it("two crossing nets: the earlier is cut by the later, never the other way round", () => {
    const cuts = netCuts([{ wires: [route("h", at(0, 5), at(10, 5))] }, { wires: [route("v", at(5, 0), at(5, 10))] }], GRID)
    expect.soft(cuts.cutBy, "net 0 cut by net 1 only").toEqual([[1], []])
  })

  it("two far-apart nets inside each other's box are not cut", () => {
    const cuts = netCuts([{ wires: [route("l", at(0, 0), at(0, 20), at(20, 20))] }, { wires: [route("s", at(10, 5), at(12, 5))] }], GRID)
    expect.soft(cuts.cutBy, "no mask at all").toEqual([[], []])
  })

  it("a diagonal crossing a horizontal is cut even though no end lies near the other wire", () => {
    const cuts = netCuts([{ wires: [route("d", at(0, 0), at(20, 20))] }, { wires: [route("h", at(0, 10), at(20, 10))] }], GRID)
    expect.soft(cuts.cutBy, "net 0 cut by net 1").toEqual([[1], []])
  })
})
