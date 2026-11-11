import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import type { Point } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import { danglingEnds, junctionsOf, pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import { commitEdit, normalise } from "@/schematic/wires/normal-form"
import { contains, HALF_CELL, latticePointsInside, type WirePin, type WireSegment } from "@/schematic/wires/segment"
import { canonical } from "../lib/pin-partition"
import { bruteDangling, bruteJunctions, counter, geometryOf, random, sortedPoints } from "../lib/wire-reference"
import { collinear, crossingOf, diagonalNormalFormViolations, diagonalPaint, diagonalPartition, exactlyOn, latticeInside, latticeSteps } from "../lib/diagonal-reference"

const c = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
let serial = 0
const w = (a: Point, b: Point, color?: WireColorKey): WireSegment => (color ? { id: `w${++serial}`, a, b, color } : { id: `w${++serial}`, a, b })
const pin = (key: string, at: Point, socket = false): WirePin => ({ key, at, socket })
const ids = () => counter("n")
const nets = (wires: readonly WireSegment[], pins: readonly WirePin[]) => pinPartition(wireNets(wires, pins))
const dots = (wires: readonly WireSegment[], pins: readonly WirePin[]) => sortedPoints(junctionsOf(wireNets(wires, pins)))

function commit(before: readonly WireSegment[], pins: readonly WirePin[], added: readonly WireSegment[]) {
  const raw = [...before, ...added]
  return normalise(raw, pins, { segments: added }, ids())
}

describe("N1 relaxed: a wire may run in any direction between two lattice points, in exact integer arithmetic (design.md §6.11 rules 2–3; ГОСТ 2.701-2008 п. 5.5.2 Примечание and IEC 61082-1:2014 7.1.3.4: oblique lines allowed where they help)", () => {
  it("a diagonal between two lattice points is a wire: normalising leaves it as it is and it joins the pins at its ends, at 45° and at any other slope", () => {
    for (const end of [c(4, 4), c(4, 2), c(3, 1), c(1.5, 3.5), c(-2, 5)]) {
      const pins = [pin("P:1", c(0, 0)), pin("Q:1", end)]
      const wires = [w(c(0, 0), end)]
      const label = `(0, 0) → (${end.x / GRID}, ${end.y / GRID})`
      expect.soft(() => normalise(wires, pins, undefined, ids()), `${label}: accepted`).not.toThrow()
      expect.soft(normalise(wires, pins, undefined, ids()), `${label}: a fixed point`).toBe(wires)
      expect.soft(nets(wires, pins), `${label}: one net`).toEqual([["P:1", "Q:1"]])
    }
  })

  it("a point lies on a diagonal iff the cross product is zero and it lies between the ends: true at each lattice point on it, false 1e-9 off, beside it or past an end (design.md §6.11 rule 3; CLRS §33.1 ON-SEGMENT; KiCad IsPointOnSegment, trigo.cpp:87, no tolerance)", () => {
    const s = w(c(0, 0), c(4, 2))
    for (const p of [c(0, 0), c(1, 0.5), c(2, 1), c(3, 1.5), c(4, 2)]) expect.soft(contains(s, p), `(${p.x / GRID}, ${p.y / GRID}) is on it`).toBe(true)
    expect.soft(contains(s, { x: c(2, 1).x + 1e-9, y: c(2, 1).y }), "1e-9 px off (2, 1)").toBe(false)
    expect.soft(contains(s, { x: c(2, 1).x, y: c(2, 1).y - 1e-9 }), "1e-9 px above (2, 1)").toBe(false)
    expect.soft(contains(s, c(2, 1.5)), "a lattice point beside the line").toBe(false)
    expect.soft(contains(s, c(1, 1)), "another lattice point inside the box").toBe(false)
    expect.soft(contains(s, c(6, 3)), "on the line past b").toBe(false)
    expect.soft(contains(s, c(-2, -1)), "on the line before a").toBe(false)
    const back = w(c(4, 2), c(0, 0))
    expect.soft(contains(back, c(3, 1.5)), "the same drawn the other way").toBe(true)
  })

  it("stays exact at the far end of the coordinate range: a lattice point 4·10⁻⁶ px off a 2.5·10⁷ px diagonal is off it, the point on it is on it (research/diagonal-wires.md §5: products exact while |c| ≲ 3.3·10⁷ lattice units)", () => {
    const N = 2 ** 20
    const s = w({ x: 0, y: 0 }, { x: 2 * N * HALF_CELL, y: (2 * N - 2) * HALF_CELL })
    expect.soft(contains(s, { x: N * HALF_CELL, y: (N - 1) * HALF_CELL }), "the lattice point halfway").toBe(true)
    expect.soft(contains(s, { x: HALF_CELL, y: HALF_CELL }), "(1, 1) half-cells: cross product 2, distance ≈ 4·10⁻⁶ px").toBe(false)
    const pins = [pin("A:1", s.a), pin("B:1", s.b), pin("C:1", { x: HALF_CELL, y: HALF_CELL }), pin("D:1", { x: N * HALF_CELL, y: (N - 1) * HALF_CELL })]
    const out = normalise([s], pins, undefined, ids())
    expect.soft(nets(out, pins), "D on the wire and split into it; C not").toEqual([["A:1", "B:1", "D:1"]])
  })

  it("the lattice points inside a diagonal from a to b are a + k·(b − a)/g, g = gcd(|dx|, |dy|) in half cells, k = 1 … g − 1, in order from a (design.md §6.11 rule 3)", () => {
    expect.soft(latticePointsInside(w(c(0, 0), c(4, 2))), "(8, 4) half cells: g = 4").toEqual([c(1, 0.5), c(2, 1), c(3, 1.5)])
    expect.soft(latticePointsInside(w(c(4, 2), c(0, 0))), "the same, drawn back").toEqual([c(3, 1.5), c(2, 1), c(1, 0.5)])
    expect.soft(latticePointsInside(w(c(0, 0), c(3, 1))), "(6, 2): g = 2, the midpoint on half cells").toEqual([c(1.5, 0.5)])
    expect.soft(latticePointsInside(w(c(0, 0), c(7, 3))), "(14, 6): g = 2").toEqual([c(3.5, 1.5)])
    expect.soft(latticePointsInside(w(c(0, 0), c(0.5, 1.5))), "(1, 3): g = 1, none").toEqual([])
    expect.soft(latticePointsInside(w(c(0, 0), c(2, -2))), "45°, (4, −4): g = 4").toEqual([c(0.5, -0.5), c(1, -1), c(1.5, -1.5)])
    expect.soft(latticePointsInside(w(c(0, 0), c(2, 0))), "an orthogonal wire by the same rule").toEqual([c(0.5, 0), c(1, 0), c(1.5, 0)])
  })

  it("an end off the half-cell lattice is still refused at any angle, and so is a pin off the lattice lying exactly on a diagonal (design.md §2 N1, §1.2 «exact means exact»)", () => {
    const pins = [pin("A:1", c(0, 0))]
    expect.soft(() => normalise([w({ x: 5, y: 0 }, c(3, 1))], pins), "a diagonal from 5 px").toThrow(/off the half-cell lattice/)
    expect.soft(() => normalise([w(c(0, 0), { x: 29, y: 13 })], pins), "a diagonal to (29, 13) px").toThrow(/off the half-cell lattice/)
    expect.soft(() => normalise([w(c(0, 0), c(3, 1))], [pin("X:1", { x: 24, y: 8 })]), "a pin at (24, 8) px, on the line y = x/3 between lattice points").toThrow(/off the half-cell lattice/)
    expect.soft(normalise([w(c(0, 0), c(3, 1))], [pin("X:1", { x: 24, y: 9 })], undefined, ids()).length, "off the lattice and off the wire: no harm").toBe(1)
  })
})

describe("N2–N4 in every direction (design.md §6.11 rule 4; KiCad SCH_LINE::MergeOverlap, sch_line.cpp:550, collinear by exact cross-multiplication; BreakSegments, sch_line_wire_bus_tool.cpp ≈ 1489)", () => {
  const ends = (...points: Point[]) => points.map((p, i) => pin(`P${i}:1`, p))

  it("collinear overlapping diagonals merge into one wire (N2)", () => {
    const pins = ends(c(0, 0), c(6, 3))
    const out = commit([w(c(0, 0), c(4, 2))], pins, [w(c(2, 1), c(6, 3))])
    expect.soft(geometryOf(out), "one wire").toEqual(geometryOf([w(c(0, 0), c(6, 3))]))
    expect.soft(diagonalNormalFormViolations(out, pins), "normal form").toEqual([])
    expect.soft(nets(out, pins), "one net").toEqual([["P0:1", "P1:1"]])
  })

  it("where collinear diagonals of two colours overlap, every stretch keeps the colour of the wire that was there first (N2; findings 1.18)", () => {
    const raw = [w(c(0, 0), c(4, 2), "red"), w(c(2, 1), c(6, 3), "blue")]
    const out = commit(raw.slice(0, 1), [], raw.slice(1))
    expect.soft(geometryOf(out), "red to (4, 2), blue on from there").toEqual(geometryOf([w(c(0, 0), c(4, 2), "red"), w(c(4, 2), c(6, 3), "blue")]))
    expect.soft(diagonalPaint(out), "paint").toEqual(diagonalPaint(raw))
  })

  it("two collinear diagonal ends meeting with nothing else become one wire (N4); not across a pin, which takes a dot, nor across a colour boundary", () => {
    const pins = ends(c(0, 0), c(4, 2))
    expect.soft(geometryOf(commit([w(c(0, 0), c(2, 1))], pins, [w(c(2, 1), c(4, 2))])), "merged").toEqual(geometryOf([w(c(0, 0), c(4, 2))]))
    const pinned = [...pins, pin("R1:1", c(2, 1))]
    const across = commit([w(c(0, 0), c(2, 1))], pinned, [w(c(2, 1), c(4, 2))])
    expect.soft(geometryOf(across), "a pin between them: two wires").toEqual(geometryOf([w(c(0, 0), c(2, 1)), w(c(2, 1), c(4, 2))]))
    expect.soft(dots(across, pinned), "two ends and a pin: a dot").toEqual([c(2, 1)])
    const coloured = commit([w(c(0, 0), c(2, 1), "red")], pins, [w(c(2, 1), c(4, 2), "blue")])
    expect.soft(geometryOf(coloured), "a colour boundary is a vertex").toEqual(geometryOf([w(c(0, 0), c(2, 1), "red"), w(c(2, 1), c(4, 2), "blue")]))
    expect.soft(dots(coloured, pins), "and no dot").toEqual([])
  })

  it("a diagonal meeting an orthogonal wire, or a diagonal of another slope, end to end is a corner: never merged, no dot (design.md §6.11 rule 4)", () => {
    const pins = ends(c(0, 0), c(4, 2))
    const bend = commit([w(c(0, 0), c(2, 0))], pins, [w(c(2, 0), c(4, 2))])
    expect.soft(geometryOf(bend), "orthogonal then 45°").toEqual(geometryOf([w(c(0, 0), c(2, 0)), w(c(2, 0), c(4, 2))]))
    const slopes = commit([w(c(0, 0), c(2, 1))], ends(c(0, 0), c(4, 4)), [w(c(2, 1), c(4, 4))])
    expect.soft(geometryOf(slopes), "two slopes").toEqual(geometryOf([w(c(0, 0), c(2, 1)), w(c(2, 1), c(4, 4))]))
    expect.soft(dots(slopes, ends(c(0, 0), c(4, 4))), "a bend, no dot").toEqual([])
  })

  it("parallel diagonals on different lines never merge, and collinear ones with a gap between stay apart", () => {
    const pins = ends(c(0, 0), c(4, 2), c(0, 1), c(4, 3))
    const parallel = commit([w(c(0, 0), c(4, 2))], pins, [w(c(0, 1), c(4, 3))])
    expect.soft(parallel.length, "two wires").toBe(2)
    expect.soft(nets(parallel, pins), "two nets").toEqual([["P0:1", "P1:1"], ["P2:1", "P3:1"]])
    const gapped = commit([w(c(0, 0), c(2, 1))], ends(c(0, 0), c(2, 1), c(3, 1.5), c(5, 2.5)), [w(c(3, 1.5), c(5, 2.5))])
    expect.soft(nets(gapped, ends(c(0, 0), c(2, 1), c(3, 1.5), c(5, 2.5))), "two nets across the gap").toEqual([["P0:1", "P1:1"], ["P2:1", "P3:1"]])
  })

  it("a wire ended on a lattice point inside a diagonal splits it there and connects, with a dot (N3; junctions.md 2 at an angle)", () => {
    const pins = ends(c(0, 0), c(4, 2), c(2, 5))
    const out = commit([w(c(0, 0), c(4, 2))], pins, [w(c(2, 1), c(2, 5))])
    expect.soft(geometryOf(out), "the diagonal in two at the branch").toEqual(geometryOf([w(c(0, 0), c(2, 1)), w(c(2, 1), c(4, 2)), w(c(2, 1), c(2, 5))]))
    expect.soft(diagonalNormalFormViolations(out, pins), "normal form").toEqual([])
    expect.soft(dots(out, pins), "the dot").toEqual([c(2, 1)])
    expect.soft(nets(out, pins), "one net").toEqual([["P0:1", "P1:1", "P2:1"]])
  })

  it("a diagonal ended on an orthogonal wire's interior splits that wire (N3)", () => {
    const pins = ends(c(0, 2), c(6, 2), c(4, 5))
    const out = commit([w(c(0, 2), c(6, 2))], pins, [w(c(4, 5), c(2, 2))])
    expect.soft(geometryOf(out), "the rail split where the diagonal lands").toEqual(geometryOf([w(c(0, 2), c(2, 2)), w(c(2, 2), c(6, 2)), w(c(4, 5), c(2, 2))]))
    expect.soft(dots(out, pins), "the dot").toEqual([c(2, 2)])
  })

  it("a symbol's pin on a lattice point inside a diagonal splits it and joins; a board's socket there is passed and joins nothing (N3; design.md §4.5 at any angle)", () => {
    const pins = ends(c(0, 0), c(4, 2))
    const symbol = [...pins, pin("R1:1", c(2, 1))]
    const split = normalise([w(c(0, 0), c(4, 2))], symbol, undefined, ids())
    expect.soft(geometryOf(split), "split at the pin").toEqual(geometryOf([w(c(0, 0), c(2, 1)), w(c(2, 1), c(4, 2))]))
    expect.soft(nets(split, symbol), "the pin on the net").toEqual([["P0:1", "P1:1", "R1:1"]])
    const socket = [...pins, pin("U1:P1", c(2, 1), true)]
    const passed = normalise([w(c(0, 0), c(4, 2))], socket, undefined, ids())
    expect.soft(geometryOf(passed), "one wire past the socket").toEqual(geometryOf([w(c(0, 0), c(4, 2))]))
    expect.soft(nets(passed, socket), "the socket not on the net").toEqual([["P0:1", "P1:1"]])
  })

  it("N3 before N4 on diagonals: two collinear diagonal ends meeting on a crossing wire's interior make a four-way join that no merge undoes (design.md §2, §13.7)", () => {
    const pins = ends(c(0, 0), c(4, 4), c(2, 0), c(2, 4))
    const out = normalise([w(c(0, 0), c(2, 2)), w(c(2, 2), c(4, 4)), w(c(2, 0), c(2, 4))], pins, undefined, ids())
    expect.soft(out.length, "the upright split too: four wires").toBe(4)
    expect.soft(nets(out, pins), "one net").toEqual([["P0:1", "P1:1", "P2:1", "P3:1"]])
    expect.soft(dots(out, pins), "a dot").toEqual([c(2, 2)])
  })

  it("a split diagonal keeps its direction on every piece and its id on one of them; the document it came from is untouched", () => {
    const back = w(c(4, 2), c(0, 0))
    const pins = [pin("R1:1", c(2, 1))]
    const before = JSON.stringify([back])
    const out = normalise([back], pins, undefined, ids())
    const runs = (wires: readonly { a: Point; b: Point }[]) => wires.map((s) => `(${s.a.x / GRID}, ${s.a.y / GRID})→(${s.b.x / GRID}, ${s.b.y / GRID})`).sort()
    expect.soft(runs(out), "both pieces run from (4, 2) towards (0, 0)").toEqual(runs([{ a: c(4, 2), b: c(2, 1) }, { a: c(2, 1), b: c(0, 0) }]))
    expect.soft(out.filter((s) => s.id === back.id).length, "one keeps the id").toBe(1)
    expect.soft(JSON.stringify([back]), "the input untouched").toBe(before)
    expect.soft(normalise(out, pins, undefined, ids()), "and the result is a fixed point").toBe(out)
  })
})

describe("crossings never connect, at a lattice point or between (design.md §6.11 rule 5; ГОСТ 2.721-74 item 5; IEEE 315-1975 3.1.5: «the crossing is not necessarily at a 90-degree angle»; KiCad AnalyzePoint: a pure X of two interiors is no junction)", () => {
  const scenes: { name: string; s: [Point, Point]; t: [Point, Point]; at: Point; onLattice: boolean }[] = [
    { name: "a diagonal across an orthogonal wire at a lattice point of both", s: [c(0, 0), c(4, 4)], t: [c(0, 2), c(4, 2)], at: c(2, 2), onLattice: true },
    { name: "a diagonal across an orthogonal wire between lattice points", s: [c(0, 0), c(1, 3)], t: [c(-2, 0.5), c(2, 0.5)], at: { x: GRID / 6, y: GRID / 2 }, onLattice: false },
    { name: "two diagonals crossing as an X at a lattice point of both", s: [c(0, 0), c(4, 4)], t: [c(0, 4), c(4, 0)], at: c(2, 2), onLattice: true },
    { name: "two diagonals crossing between lattice points", s: [c(0, 0), c(2, 1)], t: [c(0, 1), c(1, 0)], at: { x: (2 / 3) * GRID, y: (1 / 3) * GRID }, onLattice: false },
  ]
  for (const scene of scenes) {
    it(`${scene.name}: two wires, two nets, no dot`, () => {
      const pins = [pin("A:1", scene.s[0]), pin("B:1", scene.s[1]), pin("C:1", scene.t[0]), pin("D:1", scene.t[1])]
      const wires = [w(...scene.s), w(...scene.t)]
      const met = crossingOf(wires[0], wires[1])!
      expect.soft(met.x, "set up: where they cross, x").toBeNear(scene.at.x, 1e-9)
      expect.soft(met.y, "set up: where they cross, y").toBeNear(scene.at.y, 1e-9)
      expect.soft(exactlyOn(wires[0], met) && exactlyOn(wires[1], met), "set up: a lattice point of both or not").toBe(scene.onLattice)
      const out = normalise(wires, pins, undefined, ids())
      expect.soft(out, "nothing split, nothing merged").toBe(wires)
      expect.soft(nets(out, pins), "two nets").toEqual([["A:1", "B:1"], ["C:1", "D:1"]])
      expect.soft(dots(out, pins), "no dot").toEqual([])
      const drawn = commit([wires[0]], pins, [wires[1]])
      expect.soft(geometryOf(drawn), "drawn one after the other: the same two wires").toEqual(geometryOf(wires))
    })
  }
})

type Edit = { added: WireSegment[]; removed: WireSegment[]; moved: Point[] }

const COLORS: (WireColorKey | undefined)[] = [undefined, undefined, undefined, "red", "blue"]
const SIDE = 12
const DIRECTIONS: readonly Point[] = [
  { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: -1 }, { x: 2, y: 1 }, { x: 1, y: 2 },
  { x: 2, y: -1 }, { x: 1, y: -2 }, { x: 3, y: 1 }, { x: 1, y: 3 }, { x: 3, y: -2 }, { x: 2, y: 3 },
]

type MovingPin = { key: string; at: Point; socket: boolean }

function randomDiagonalEdit(rng: ReturnType<typeof random>, wires: readonly WireSegment[], pins: MovingPin[], fresh: () => string): Edit {
  const half = (p: Point) => ({ x: p.x / HALF_CELL, y: p.y / HALF_CELL })
  const at = (x: number, y: number): Point => ({ x: x * HALF_CELL, y: y * HALF_CELL })
  const inBox = (p: Point) => p.x >= 0 && p.y >= 0 && p.x <= SIDE * HALF_CELL && p.y <= SIDE * HALF_CELL
  const lattice = () => at(rng.int(0, SIDE), rng.int(0, SIDE))
  const color = () => rng.pick(COLORS)
  const seg = (a: Point, b: Point, colour = color()): WireSegment => (colour ? { id: fresh(), a, b, color: colour } : { id: fresh(), a, b })
  const ray = (from: Point, direction = rng.pick(DIRECTIONS)): Point => {
    const f = half(from)
    const sign = rng.chance(0.5) ? 1 : -1
    for (let k = rng.int(1, 4); k >= 1; k--) {
      for (const s of [sign, -sign]) {
        const to = at(f.x + direction.x * k * s, f.y + direction.y * k * s)
        if (inBox(to)) return to
      }
    }
    return at(f.x === 0 ? 1 : f.x - 1, f.y)
  }
  const none: Edit = { added: [], removed: [], moved: [] }
  const kind = rng.int(0, 10)
  if (kind === 0 && wires.length) return { ...none, removed: [rng.pick(wires)] }
  if (kind === 1) {
    const moving = rng.pick(pins)
    const was = moving.at
    const onWire = wires.length && rng.chance(0.5) ? latticeSteps(rng.pick(wires)) : []
    moving.at = onWire.length ? rng.pick(onWire) : lattice()
    return { ...none, moved: [was, moving.at] }
  }
  if (kind === 2 && wires.length) {
    const old = rng.pick(wires)
    return { ...none, removed: [old], added: [seg(old.a, old.b)] }
  }
  if (kind === 3 && wires.length) {
    const from = rng.pick(wires.flatMap((s) => [s.a, s.b]))
    return { ...none, added: [seg(from, ray(from))] }
  }
  if (kind === 4 && wires.length) {
    const inside = latticeInside(rng.pick(wires))
    if (inside.length) {
      const from = rng.pick(inside)
      return { ...none, added: [seg(from, ray(from))] }
    }
  }
  if (kind === 5 && wires.length) {
    const steps = latticeSteps(rng.pick(wires))
    const i = rng.int(0, steps.length - 2)
    const j = rng.int(i + 1, steps.length - 1)
    return { ...none, added: [rng.chance(0.5) ? seg(steps[i], steps[j]) : seg(steps[j], steps[i])] }
  }
  if (kind === 6) {
    const from = rng.chance(0.5) ? rng.pick(pins).at : lattice()
    const corner = ray(from)
    const colour = color()
    return { ...none, added: [seg(from, corner, colour), seg(corner, ray(corner), colour)] }
  }
  if (kind === 7 && wires.length > 1) {
    const doomed = new Set<WireSegment>()
    for (let i = rng.int(1, 3); i > 0; i--) doomed.add(rng.pick(wires))
    return { ...none, removed: [...doomed] }
  }
  if (kind === 8 && wires.length) {
    const steps = latticeSteps(rng.pick(wires))
    const i = rng.int(0, steps.length - 2)
    const [p, q] = [steps[i], steps[i + 1]]
    if (p.x !== q.x && p.y !== q.y) return { ...none, added: [seg({ x: p.x, y: q.y }, { x: q.x, y: p.y })] }
    const through = rng.pick(steps)
    const direction = rng.pick(DIRECTIONS)
    const h = half(through)
    const a = at(h.x - direction.x, h.y - direction.y)
    const b = at(h.x + direction.x, h.y + direction.y)
    if (inBox(a) && inBox(b)) return { ...none, added: [seg(a, b)] }
  }
  if (kind === 9) return { ...none, added: [seg(lattice(), lattice())] }
  const from = rng.chance(0.4) ? rng.pick(pins).at : lattice()
  return { ...none, added: [seg(from, ray(from, rng.pick(DIRECTIONS.slice(0, 2))))] }
}

function untouchedBy(edit: Edit, before: readonly WireSegment[]): WireSegment[] {
  const points = [...edit.moved, ...edit.added.flatMap((s) => [s.a, s.b]), ...edit.removed.flatMap((s) => [s.a, s.b])]
  const reaches = (s: WireSegment, t: WireSegment) => {
    if (t.a.x === t.b.x && t.a.y === t.b.y) return false
    return collinear(s, t) && (exactlyOn(s, t.a) || exactlyOn(s, t.b) || exactlyOn(t, s.a) || exactlyOn(t, s.b))
  }
  const removed = new Set(edit.removed)
  return before.filter((s) => !removed.has(s) && !points.some((p) => exactlyOn(s, p)) && !edit.added.some((t) => reaches(s, t)))
}

describe("random edits with diagonals against an exact brute-force reference (plan.md phase 7: «the normal form on diagonals (random edits, every invariant after each)»; junctions.md principle 5; design.md §6.11 rules 3–5)", () => {
  it("after every edit: N1–N4 hold at any angle, local equals global, a fixed point, every stretch keeps its first colour, the circuit is the raw drawing's, the graph kept or rebuilt agrees, and nothing outside the edit moved", () => {
    const SEQUENCES = 120
    const STEPS = 40
    let checked = 0
    let diagonals = 0
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const rng = random(seed + 7000)
      const fresh = counter(`d${seed}-`)
      const pins: MovingPin[] = Array.from({ length: 6 }, (_, i) => ({ key: `P${i}:1`, at: { x: rng.int(0, SIDE) * HALF_CELL, y: rng.int(0, SIDE) * HALF_CELL }, socket: i >= 4 }))
      const graph = new WireGraph()
      const deltaGraph = new WireGraph()
      let wires: readonly WireSegment[] = []
      let lastPins: WirePin[] = []
      for (let step = 0; step < STEPS; step++) {
        const edit = randomDiagonalEdit(rng, wires, pins, fresh)
        const livePins = pins.map((p) => ({ ...p, at: { ...p.at } }))
        const gone = new Set(edit.removed.map((s) => s.id))
        const raw = [...wires.filter((s) => !gone.has(s.id)), ...edit.added]
        const where = `seed ${seed} step ${step}`
        const local = normalise(raw, livePins, { segments: [...edit.added, ...edit.removed], points: edit.moved }, fresh)
        const global = normalise(raw, livePins, undefined, counter("g"))
        const problems = diagonalNormalFormViolations(local, livePins)
        expect.soft(problems, `${where}: normal form`).toEqual([])
        expect.soft(geometryOf(local), `${where}: local and global agree`).toEqual(geometryOf(global))
        expect.soft(normalise(local, livePins, undefined, counter("i")), `${where}: idempotent`).toBe(local)
        expect.soft(diagonalPaint(local), `${where}: every stretch keeps the colour of the wire that was there first`).toEqual(diagonalPaint(raw))
        const want = diagonalPartition(raw, livePins)
        const nets = graph.of(local, livePins)
        expect.soft(canonical(pinPartition(nets)), `${where}: the graph kept up to date gives the raw drawing's circuit`).toEqual(want)
        expect.soft(canonical(pinPartition(wireNets(local, livePins))), `${where}: a graph built afresh gives it too`).toEqual(want)
        expect.soft(sortedPoints(junctionsOf(nets)), `${where}: dots`).toEqual(bruteJunctions(local, livePins))
        expect.soft(sortedPoints(danglingEnds(nets)), `${where}: dangling ends`).toEqual(bruteDangling(local, livePins))
        const committed = commitEdit(wires, livePins, { add: edit.added, remove: edit.removed, points: edit.moved }, counter(`c${seed}-${step}-`))
        expect.soft(geometryOf(committed.wires), `${where}: committing gives the same document`).toEqual(geometryOf(local))
        const moved = (p: WirePin, q: WirePin | undefined) => !q || q.at.x !== p.at.x || q.at.y !== p.at.y
        const viaDelta = deltaGraph.apply({ added: committed.added, removed: committed.removed, pinsAdded: livePins.filter((p) => moved(p, lastPins.find((q) => q.key === p.key))), pinsRemoved: lastPins.filter((p) => moved(p, livePins.find((q) => q.key === p.key))) })
        expect.soft(canonical(pinPartition(viaDelta)), `${where}: the graph fed the edit's delta`).toEqual(want)
        lastPins = livePins
        const kept = untouchedBy(edit, wires)
        expect.soft(kept.filter((s) => !local.includes(s)).map((s) => s.id), `${where}: wires the edit does not reach are the same objects`).toEqual([])
        if (problems.length) return
        wires = committed.wires
        diagonals += wires.filter((s) => s.a.x !== s.b.x && s.a.y !== s.b.y).length
        checked++
      }
    }
    expect.soft(checked, "every edit of every sequence checked").toBe(SEQUENCES * STEPS)
    expect.soft(diagonals, "the sequences carry diagonals: at least one per step on average").toBeGreaterThan(SEQUENCES * STEPS)
  })
})

describe("the exact reference itself (tests/lib/diagonal-reference.ts)", () => {
  it("agrees with the hand-worked cases above (guard)", () => {
    expect.soft(latticeInside(w(c(0, 0), c(4, 2))), "lattice points inside").toEqual([c(1, 0.5), c(2, 1), c(3, 1.5)])
    expect.soft(exactlyOn(w(c(0, 0), c(4, 2)), { x: c(2, 1).x + 1e-9, y: c(2, 1).y }), "1e-9 off").toBe(false)
    expect.soft(diagonalNormalFormViolations([w(c(0, 0), c(4, 2)), w(c(2, 1), c(6, 3))], []).length, "an overlap is N2").toBeGreaterThan(0)
    expect.soft(diagonalNormalFormViolations([w(c(0, 0), c(4, 2)), w(c(2, 1), c(2, 4))], []).length, "an end inside is N3").toBeGreaterThan(0)
    expect.soft(diagonalNormalFormViolations([w(c(0, 0), c(2, 1)), w(c(2, 1), c(4, 2))], []).length, "a straight join is N4").toBeGreaterThan(0)
    expect.soft(diagonalNormalFormViolations([w(c(0, 0), c(4, 4)), w(c(0, 4), c(4, 0))], []), "an X is in normal form").toEqual([])
    expect.soft(diagonalPartition([w(c(0, 0), c(4, 4)), w(c(0, 4), c(4, 0))], [pin("A:1", c(0, 0)), pin("B:1", c(4, 4)), pin("C:1", c(0, 4)), pin("D:1", c(4, 0))]), "an X is two nets").toEqual([["A:1", "B:1"], ["C:1", "D:1"]])
    expect.soft(diagonalPartition([w(c(0, 0), c(4, 2)), w(c(2, 1), c(2, 4))], [pin("A:1", c(0, 0)), pin("C:1", c(2, 4))]), "a T on a lattice point inside joins").toEqual([["A:1", "C:1"]])
  })
})
