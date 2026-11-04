import { describe, expect, it } from "vitest"
import { GRID, type Point } from "@/schematic/geometry"
import { clearPath, Foreign, type Box } from "@/schematic/wires/clear-path"
import { Conductors } from "@/schematic/wires/conductors"

const c = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const cells = (pts: readonly Point[] | null) => (pts ?? []).map((p) => [p.x / GRID, p.y / GRID])
const area: Box = { x: c(-6, -6).x, y: c(-6, -6).y, w: c(24, 0).x, h: c(0, 24).y }
const bends = (pts: readonly Point[] | null) => Math.max(0, (pts?.length ?? 0) - 2)
const visits = (pts: readonly Point[] | null, at: Point) => {
  const list = pts ?? []
  for (let i = 1; i < list.length; i++) {
    const [a, b] = [list[i - 1], list[i]]
    if (a.x === b.x && a.x === at.x && Math.min(a.y, b.y) <= at.y && at.y <= Math.max(a.y, b.y)) return true
    if (a.y === b.y && a.y === at.y && Math.min(a.x, b.x) <= at.x && at.x <= Math.max(a.x, b.x)) return true
  }
  return false
}

function laid(fill: (f: Foreign) => void, from: Point, to: Point): Point[] | null {
  const foreign = new Foreign(area)
  fill(foreign)
  return clearPath(from, to, foreign, GRID)
}

describe("the lattice search that lays a wire clear of other nets (design.md §10 item 4)", () => {
  it("goes straight where nothing is in the way, and turns as few times as it can", () => {
    expect.soft(cells(laid(() => {}, c(0, 0), c(6, 0))), "one straight run").toEqual([[0, 0], [6, 0]])
    expect.soft(bends(laid(() => {}, c(0, 0), c(6, 4))), "an L, not a staircase").toBe(1)
    expect.soft(cells(laid(() => {}, c(0, 0.5), c(1, 0.5))), "a short hop along a half-cell lane stays straight rather than turning twice onto a grid line").toEqual([[0, 0.5], [1, 0.5]])
  })

  it("runs on the grid's own lines rather than the half-cell lanes between them", () => {
    const path = cells(laid(() => {}, c(0, 0.5), c(6, 0.5)))
    expect.soft(path.length, `off the lane, along a grid line, back: ${JSON.stringify(path)}`).toBe(4)
    expect.soft(Number.isInteger(path[1]?.[1]) && path[1]?.[1] === path[2]?.[1], `the long run on a whole cell: ${JSON.stringify(path)}`).toBe(true)
  })

  it("crosses another net's wire only straight, and never ends or turns on it", () => {
    const wire = (f: Foreign) => {
      for (let y = -3; y <= 3; y += 0.5) f.run(c(3, y), false)
      f.end(c(3, -3))
      f.end(c(3, 3))
    }
    expect.soft(cells(laid(wire, c(0, 0), c(6, 0))), "straight across").toEqual([[0, 0], [6, 0]])
    expect.soft(laid(wire, c(0, 0), c(3, 2)), "an end on the other wire is refused").toBeNull()
    const turn = laid(wire, c(0, 0), c(6, 2))
    expect.soft(cells(turn).some(([x]) => x === 3) && bends(turn) > 0 && cells(turn).slice(1, -1).some(([x]) => x === 3), `no corner on the other wire: ${JSON.stringify(cells(turn))}`).toBe(false)
  })

  it("never passes through another net's wire end or pin, and keeps half a cell from its pins where it can", () => {
    expect.soft(visits(laid((f) => f.end(c(3, 0)), c(0, 0), c(6, 0)), c(3, 0)), "round the end").toBe(false)
    expect.soft(visits(laid((f) => f.pin(c(3, 0), false), c(0, 0), c(6, 0)), c(3, 0)), "round the pin").toBe(false)
    expect.soft(cells(laid((f) => f.pin(c(3, 1), false), c(0, 0), c(6, 0))), "a pin a cell away leaves the run alone").toEqual([[0, 0], [6, 0]])
    expect.soft(visits(laid((f) => f.pin(c(3, -0.5), false), c(0, 0), c(6, 0.5)), c(3, 0)), "half a cell from a pin is avoided where a lane a cell further costs little more").toBe(false)
    const walled = (f: Foreign) => {
      f.pin(c(3, 0), true)
      f.body({ x: c(1, -6).x, y: c(1, -6).y, w: c(4, 0).x, h: c(0, 5.5).y })
      f.body({ x: c(1, 0.5).x, y: c(1, 0.5).y, w: c(4, 0).x, h: c(0, 5.5).y })
    }
    expect.soft(cells(laid(walled, c(0, 0), c(6, 0))), "walled in, another net's board socket is passed straight over, as a jumper wire would (design.md §13.5; findings 3.L15)").toEqual([[0, 0], [6, 0]])
  })

  it("goes round a body when it can, and through it only when nothing else is left", () => {
    const body = { x: c(2, -2).x, y: c(2, -2).y, w: c(2, 0).x, h: c(0, 4).y }
    expect.soft(visits(laid((f) => f.body(body), c(0, 0), c(6, 0)), c(3, 0)), "round the body").toBe(false)
    expect.soft(laid((f) => f.body({ x: area.x, y: c(0, -2).y, w: area.w, h: c(0, 4).y }), c(0, -3), c(0, 3)), "a body across the whole area is crossed").not.toBeNull()
  })

  it("the raster built from what is laid stops at another net's wire end, keeps out of bodies, and leaves its own net free", () => {
    const conductors = new Conductors()
    conductors.lay(0, "other", [c(3, -3), c(3, 0)])
    conductors.lay(1, "mine", [c(0, 2), c(6, 2)])
    const body = { x: c(2, 3).x, y: c(2, 3).y, w: c(2, 0).x, h: c(0, 4).y }
    const foreign = conductors.foreign(new Set(["mine"]), area, [body])
    expect.soft(visits(clearPath(c(0, 0), c(6, 0), foreign, GRID), c(3, 0)), "not through the other wire's end").toBe(false)
    expect.soft(cells(clearPath(c(0, 2), c(6, 2), foreign, GRID)), "along my own net's wire").toEqual([[0, 2], [6, 2]])
    expect.soft(visits(clearPath(c(0, 5), c(6, 5), foreign, GRID), c(3, 5)), "round the body").toBe(false)
  })
})
