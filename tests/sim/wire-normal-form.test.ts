import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { wirePins } from "@/schematic/migrate-wires"
import type { Point } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import { danglingEnds, junctionsOf, pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import { commitEdit, normalise, type Touched } from "@/schematic/wires/normal-form"
import { HALF_CELL, type WirePin, type WireSegment } from "@/schematic/wires/segment"
import { canonical, geometricGroups, joiningContactsOfNcPads, renamed } from "../lib/pin-partition"
import { partitionDocuments, readFixture } from "../lib/partition-documents"
import { bruteDangling, bruteJunctions, counter, geometryOf, normalFormViolations, paintOf, random, referencePartition, sortedPoints } from "../lib/wire-reference"

const c = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
let serial = 0
const w = (a: Point, b: Point, color?: WireColorKey): WireSegment => (color ? { id: `w${++serial}`, a, b, color } : { id: `w${++serial}`, a, b })
const path = (color: WireColorKey | undefined, ...pts: Point[]) => pts.slice(1).map((p, i) => w(pts[i], p, color))
const pin = (key: string, at: Point, socket = false): WirePin => ({ key, at, socket })
const ids = () => counter("n")
const touching = (...segments: WireSegment[]): Touched => ({ segments })

function commit(before: readonly WireSegment[], pins: readonly WirePin[], added: readonly WireSegment[], removed: readonly WireSegment[] = []) {
  const gone = new Set(removed.map((s) => s.id))
  const raw = [...before.filter((s) => !gone.has(s.id)), ...added]
  return { raw, wires: normalise(raw, pins, { segments: [...added, ...removed] }, ids()) }
}

describe("the normal form: N1–N4 after every edit, one source of truth for the junctions", () => {
  it("a wire ended on another wire's interior splits it there, and the split point is a junction (junctions.md 2)", () => {
    const pins = [pin("R1:2", c(0, 0)), pin("R2:1", c(8, 0)), pin("R3:1", c(4, 4))]
    const spine = w(c(0, 0), c(8, 0))
    const { wires } = commit([spine], pins, [w(c(4, 4), c(4, 0))])
    expect.soft(geometryOf(wires), "the spine in two at the branch").toEqual(geometryOf([w(c(0, 0), c(4, 0)), w(c(4, 0), c(8, 0)), w(c(4, 0), c(4, 4))]))
    expect.soft(normalFormViolations(wires, pins), "normal form").toEqual([])
    expect.soft(junctionsOf(wireNets(wires, pins)), "the dot").toEqual([c(4, 0)])
    expect.soft(pinPartition(wireNets(wires, pins)), "one net").toEqual([["R1:2", "R2:1", "R3:1"]])
  })

  it("a same-net wire drawn along the spine through R1's pin merges into it: one line, no doubling, the dot on the pin (junctions.md 3)", () => {
    const pins = [pin("R2:2", c(2, 4)), pin("R1:1", c(6, 4)), pin("R3:1", c(10, 4))]
    const { wires } = commit([w(c(2, 4), c(6, 4))], pins, [w(c(2, 4), c(10, 4))])
    expect.soft(geometryOf(wires), "R2 to R1's pin, R1's pin to R3").toEqual(geometryOf([w(c(2, 4), c(6, 4)), w(c(6, 4), c(10, 4))]))
    expect.soft(normalFormViolations(wires, pins), "normal form").toEqual([])
    expect.soft(junctionsOf(wireNets(wires, pins)), "a dot on R1's pin").toEqual([c(6, 4)])
  })

  it("a part's pin dropped on a wire's bend makes three ends at the corner, and a dot there (junctions.md 15)", () => {
    const bend = path(undefined, c(0, 0), c(4, 0), c(4, 4))
    const pins = [pin("A:1", c(0, 0)), pin("B:1", c(4, 4)), pin("R1:1", c(4, 0))]
    const wires = normalise(bend, pins, { points: [c(4, 0)] }, ids())
    expect.soft(wires, "nothing to split: the corner is already a vertex").toBe(bend)
    expect.soft(junctionsOf(wireNets(wires, pins)), "the dot").toEqual([c(4, 0)])
  })

  it("two collinear wires of different colours meeting with nothing else stay two; of one colour they become one (junctions.md 19)", () => {
    const pins = [pin("A:1", c(0, 0)), pin("B:1", c(8, 0))]
    const red = w(c(0, 0), c(4, 0), "red")
    const blue = w(c(4, 0), c(8, 0), "blue")
    const { wires: coloured } = commit([red], pins, [blue])
    expect.soft(geometryOf(coloured), "the colour boundary is a vertex").toEqual(geometryOf([red, blue]))
    expect.soft(normalFormViolations(coloured, pins), "normal form").toEqual([])
    expect.soft(junctionsOf(wireNets(coloured, pins)), "and no dot").toEqual([])
    const { wires: plain } = commit([w(c(0, 0), c(4, 0), "red")], pins, [w(c(4, 0), c(8, 0), "red")])
    expect.soft(geometryOf(plain), "one red wire").toEqual(geometryOf([w(c(0, 0), c(8, 0), "red")]))
  })

  it("normalising is pure and a normal document is a fixed point, so undo and redo restore byte-identical documents (junctions.md 21)", () => {
    const pins = [pin("A:1", c(0, 0)), pin("B:1", c(8, 0)), pin("C:1", c(4, 4))]
    const before = normalise([w(c(0, 0), c(8, 0))], pins, undefined, ids())
    const saved = JSON.stringify(before)
    const { wires: after } = commit(before, pins, [w(c(4, 4), c(4, 0))])
    expect.soft(JSON.stringify(before), "the edit did not touch the document it started from").toBe(saved)
    expect.soft(normalise(after, pins, undefined, ids()), "redo lands on a fixed point").toBe(after)
    expect.soft(normalise(before, pins, undefined, ids()), "undo lands on a fixed point").toBe(before)
  })

  it("a wire started on a wire and drawn along it to R1's pin and on to R3 is one wire, its start point gone, the dot on R1's pin (junctions.md 22)", () => {
    const pins = [pin("R2:2", c(2, 4)), pin("R1:1", c(6, 4)), pin("R3:1", c(10, 0))]
    const spine = w(c(2, 4), c(6, 4))
    const { raw, wires } = commit([spine], pins, path(undefined, c(3, 4), c(6, 4), c(10, 4), c(10, 0)))
    expect.soft(geometryOf(wires), "no vertex left where the new wire started").toEqual(geometryOf([spine, ...path(undefined, c(6, 4), c(10, 4), c(10, 0))]))
    expect.soft(wires.find((s) => s.id === spine.id), "the old wire keeps its identity").toBe(spine)
    expect.soft(junctionsOf(wireNets(wires, pins)), "the dot where the new wire leaves").toEqual([c(6, 4)])
    expect.soft(pinPartition(wireNets(wires, pins)), "the same circuit as the raw drawing").toEqual(referencePartition(raw, pins))
  })

  it("the same wire turned off halfway between R2 and R1 splits the spine where it leaves (junctions.md 23)", () => {
    const pins = [pin("R2:2", c(2, 4)), pin("R1:1", c(6, 4)), pin("R3:1", c(4, 0))]
    const { wires } = commit([w(c(2, 4), c(6, 4))], pins, path(undefined, c(3, 4), c(4, 4), c(4, 0)))
    expect.soft(geometryOf(wires), "the spine split where the wire leaves").toEqual(geometryOf([w(c(2, 4), c(4, 4)), w(c(4, 4), c(6, 4)), w(c(4, 4), c(4, 0))]))
    expect.soft(junctionsOf(wireNets(wires, pins)), "the dot at the leaving point").toEqual([c(4, 4)])
  })

  it("a wire end dropped on a dangling end of its own net makes a bend, or one straight wire when collinear; never a dot (junctions.md 29)", () => {
    const pins = [pin("A:1", c(0, 0)), pin("B:1", c(4, 4)), pin("C:1", c(8, 0))]
    const stub = w(c(0, 0), c(4, 0))
    const { wires: bent } = commit([stub], pins, [w(c(4, 4), c(4, 0))])
    expect.soft(geometryOf(bent), "a corner").toEqual(geometryOf([stub, w(c(4, 4), c(4, 0))]))
    expect.soft(junctionsOf(wireNets(bent, pins)), "no dot at the corner").toEqual([])
    expect.soft(danglingEnds(wireNets(bent, pins)), "no dangling end").toEqual([])
    const { wires: straight } = commit([stub], pins, [w(c(8, 0), c(4, 0))])
    expect.soft(geometryOf(straight), "collinear: one wire").toEqual(geometryOf([w(c(0, 0), c(8, 0))]))
  })

  it("a board's socket passed by a wire splits nothing and joins nothing; a socket a wire ends on is a vertex like any pin", () => {
    const pins = [pin("A:1", c(0, 0)), pin("B:1", c(8, 0)), pin("U1:P1", c(4, 0), true)]
    const passing = normalise(path(undefined, c(0, 0), c(2, 0), c(8, 0)), pins, undefined, ids())
    expect.soft(geometryOf(passing), "one wire past the socket").toEqual(geometryOf([w(c(0, 0), c(8, 0))]))
    expect.soft(pinPartition(wireNets(passing, pins)), "the socket is not on the net").toEqual([["A:1", "B:1"]])
    const ending = normalise(path(undefined, c(0, 0), c(4, 0), c(8, 0)), pins, undefined, ids())
    expect.soft(geometryOf(ending), "two wires meeting on the socket").toEqual(geometryOf(path(undefined, c(0, 0), c(4, 0), c(8, 0))))
    expect.soft(pinPartition(wireNets(ending, pins)), "the socket is on the net").toEqual([["A:1", "B:1", "U1:P1"]])
    expect.soft(junctionsOf(wireNets(ending, pins)), "two wires on a socket: the dot inside its ring").toEqual([c(4, 0)])
    const symbol = [pin("A:1", c(0, 0)), pin("B:1", c(8, 0)), pin("R1:1", c(4, 0))]
    const across = normalise([w(c(0, 0), c(8, 0))], symbol, undefined, ids())
    expect.soft(geometryOf(across), "a symbol's pin on a wire splits it (N3)").toEqual(geometryOf(path(undefined, c(0, 0), c(4, 0), c(8, 0))))
  })

  it("a crossing stays a crossing; four ends at a point are a four-way join that no merge undoes", () => {
    const pins = [pin("A:1", c(0, 2)), pin("B:1", c(4, 2)), pin("C:1", c(2, 0)), pin("D:1", c(2, 4))]
    const crossing = normalise([w(c(0, 2), c(4, 2)), w(c(2, 0), c(2, 4))], pins, undefined, ids())
    expect.soft(crossing.length, "two wires").toBe(2)
    expect.soft(pinPartition(wireNets(crossing, pins)), "two nets").toEqual([["A:1", "B:1"], ["C:1", "D:1"]])
    const fourWay = normalise([...path(undefined, c(0, 2), c(2, 2), c(4, 2)), w(c(2, 0), c(2, 4))], pins, undefined, ids())
    expect.soft(fourWay.length, "two collinear ends on a crossing split the crossing wire too").toBe(4)
    expect.soft(pinPartition(wireNets(fourWay, pins)), "one net").toEqual([["A:1", "B:1", "C:1", "D:1"]])
    expect.soft(junctionsOf(wireNets(fourWay, pins)), "a dot").toEqual([c(2, 2)])
  })

  it("zero-length pieces vanish, and an end off the half-cell lattice is refused", () => {
    const pins = [pin("A:1", c(0, 0)), pin("B:1", c(4, 0))]
    expect.soft(geometryOf(normalise([w(c(0, 0), c(4, 0)), w(c(2, 0), c(2, 0))], pins, undefined, ids())), "a point is no wire").toEqual(geometryOf([w(c(0, 0), c(4, 0))]))
    expect.soft(() => normalise([w({ x: 5, y: 0 }, c(1, 0))], pins), "off the lattice").toThrow(/off the half-cell lattice/)
    expect.soft(geometryOf(normalise([w({ x: HALF_CELL, y: 0 }, c(2, 0))], pins, undefined, ids())), "a half cell is on it").toEqual([`(1, 0)→(4, 0)`])
  })

  it("a split wire keeps its id on its first piece along the line and its direction on every piece, in its own place in the document", () => {
    const x = w(c(0, 4), c(4, 4))
    const backwards = w(c(8, 0), c(0, 0))
    const y = w(c(0, 8), c(4, 8))
    const pins = [pin("R1:1", c(4, 0))]
    const out = normalise([x, backwards, y], pins, undefined, ids())
    expect.soft(out.map((s) => s.id), "order and ids").toEqual([x.id, backwards.id, "n1", y.id])
    expect.soft(out[1], "the first piece along the line keeps the id, running right to left like the wire").toEqual({ id: backwards.id, a: c(4, 0), b: c(0, 0) })
    expect.soft(out[2], "the second piece, the same way").toEqual({ id: "n1", a: c(8, 0), b: c(4, 0) })
    expect.soft(out[0], "an untouched neighbour is the same object").toBe(x)
  })

  it("a pin off the half-cell lattice lying on a wire is refused rather than cutting it off the lattice", () => {
    expect.soft(() => normalise([w(c(0, 0), c(4, 0))], [pin("X:1", { x: 30, y: 0 })]), "a pin at 30 px").toThrow(/off the half-cell lattice/)
    expect.soft(normalise([w(c(0, 0), c(4, 0))], [pin("X:1", { x: 30, y: 5 })], undefined, ids()).length, "off the lattice and off the wire: no harm").toBe(1)
    const gap = [w(c(0, 0), c(1, 0)), w(c(2, 0), c(3, 0))]
    expect.soft(normalise(gap, [pin("X:1", { x: 30, y: 0 })], undefined, ids()), "in the gap between two wires on its line: no harm").toBe(gap)
    expect.soft(normalise(gap, [pin("X:1", { x: 30, y: 0 })], { segments: gap }, ids()), "the same, local").toBe(gap)
    const column = [w(c(0, 0), c(0, 1)), w(c(0, 2), c(0, 3))]
    expect.soft(normalise(column, [pin("X:1", { x: 0, y: 30 })], undefined, ids()), "in a vertical gap").toBe(column)
  })

  it("an edit touches only the wires through the points it changed: every other wire is the same object", () => {
    const pins: WirePin[] = []
    const sheet: WireSegment[] = []
    for (let row = 0; row < 200; row++) for (let col = 0; col < 10; col++) sheet.push(w(c(col * 6, row * 2), c(col * 6 + 4, row * 2)))
    const added = w(c(2, 100), c(2, 101))
    const wires = normalise([...sheet, added], pins, touching(added), ids())
    const same = sheet.filter((s) => wires.includes(s)).length
    expect.soft(same, "2 000 wires, one split by the new branch").toBe(sheet.length - 1)
    expect.soft(wires.length, "the split wire is two now, plus the branch").toBe(sheet.length + 2)
    expect.soft(normalise(sheet, pins, touching(), ids()), "nothing touched: the same array").toBe(sheet)
  })
})

describe("the derived graph", () => {
  it("two wires with one id are refused by normalising a whole document and by the graph, which stays as it was", () => {
    const pins = [pin("A:1", c(0, 0)), pin("B:1", c(1, 0)), pin("C:1", c(2, 0)), pin("D:1", c(3, 0))]
    const twins: WireSegment[] = [{ id: "same", a: c(0, 0), b: c(1, 0) }, { id: "same", a: c(2, 0), b: c(3, 0) }]
    expect.soft(() => normalise(twins, pins), "normalised whole").toThrow(/share the id same/)
    const graph = new WireGraph()
    const one = graph.of([twins[0]], pins)
    expect.soft(() => graph.of(twins, pins), "fed to the graph").toThrow(/share the id same/)
    expect.soft(pinPartition(one), "the graph unchanged by the refused input").toEqual([["A:1", "B:1"]])
    expect.soft(() => graph.apply({ added: [twins[1]] }), "applied as a delta").toThrow(/share the id same/)
    expect.soft(pinPartition(graph.of([twins[0]], pins)), "and still unchanged").toEqual([["A:1", "B:1"]])
  })

  it("a view answers until the graph takes its next edit, then refuses rather than mix two documents; the graph stays sound", () => {
    const pins: WirePin[] = [{ key: "A:1", at: c(0, 0), kind: "power" }, { key: "B:1", at: c(4, 0), kind: "analog" }, { key: "C:1", at: c(0, 4) }, { key: "D:1", at: c(4, 4) }]
    const graph = new WireGraph()
    const a = w(c(0, 0), c(4, 0))
    const b = w(c(0, 4), c(4, 4))
    const kept = graph.of([a], pins)
    const net = kept.netOfSegment(a.id)!
    expect.soft({ pins: [...kept.pinsOf(net)].sort(), kinds: [...kept.kindsOf(net)] }, "before").toEqual({ pins: ["A:1", "B:1"], kinds: ["power", "analog"] })
    const now = graph.of([a, b], pins)
    for (const [what, read] of [["nets", () => kept.nets], ["pinsOf", () => kept.pinsOf(net)], ["netOfSegment", () => kept.netOfSegment(a.id)], ["junctions", () => kept.junctions()]] as const)
      expect.soft(read, `the old view's ${what}`).toThrow(/out of date/)
    expect.soft(now.netOfSegment(a.id), "the new view keeps the old net's id").toBe(net)
    const after = graph.apply({ removed: [b] })
    expect.soft(pinPartition(after), "an edit after the refused reads lands on the true state").toEqual([["A:1", "B:1"]])
  })

  it("the graph refuses a delta that does not match it, and stays as it was", () => {
    const pins = [pin("A:1", c(0, 0)), pin("B:1", c(4, 0))]
    const a = w(c(0, 0), c(4, 0))
    const graph = new WireGraph()
    graph.of([a], pins)
    expect.soft(() => graph.apply({ removed: [w(c(0, 0), c(4, 0))] }), "removing a wire it does not hold").toThrow(/not in the graph/)
    expect.soft(() => graph.apply({ removed: [a, a] }), "removing one twice").toThrow(/removed twice/)
    expect.soft(() => graph.apply({ pinsRemoved: [pin("A:1", c(9, 9))] }), "removing a pin from where it is not").toThrow(/not in the graph as given/)
    expect.soft(pinPartition(graph.of([a], pins)), "unchanged").toEqual([["A:1", "B:1"]])
  })

  it("a committed edit's delta is the exact difference: a wire removed and put back, or removed twice, is no change", () => {
    const a = w(c(0, 0), c(4, 0))
    const again = commitEdit([a], [], { remove: [a], add: [a] }, ids())
    expect.soft({ added: again.added, removed: again.removed }, "removed and put back").toEqual({ added: [], removed: [] })
    const twice = commitEdit([a], [], { remove: [a, a] }, ids())
    expect.soft(twice.removed, "removed twice, listed once").toEqual([a])
  })

  it("pins handed over again as fresh objects with the same values change nothing: the same view comes back", () => {
    const pins = () => [pin("A:1", c(0, 0)), pin("B:1", c(4, 0))]
    const wires = [w(c(0, 0), c(4, 0))]
    const graph = new WireGraph()
    const first = graph.of(wires, pins())
    expect.soft(graph.of(wires, pins()), "value-equal pins").toBe(first)
    expect.soft(graph.of([...wires], pins()), "a new array of the same wires").toBe(first)
  })

  it("an edit committed as a delta and applied to the graph gives what diffing the whole document gives", () => {
    const pins = [pin("A:1", c(0, 0)), pin("B:1", c(8, 0)), pin("C:1", c(4, 4))]
    const spine = w(c(0, 0), c(8, 0))
    const byDelta = new WireGraph()
    const byDiff = new WireGraph()
    byDelta.of([spine], pins)
    byDiff.of([spine], pins)
    const branch = w(c(4, 4), c(4, 0))
    const edit = commitEdit([spine], pins, { add: [branch] }, ids())
    expect.soft(edit.removed, "the spine replaced").toEqual([spine])
    expect.soft(edit.added.map((s) => s.id).sort(), "by its two halves, and the branch").toEqual([branch.id, spine.id, "n1"].sort())
    const delta = byDelta.apply(edit)
    const diff = byDiff.of(edit.wires, pins)
    expect.soft(pinPartition(delta), "partition").toEqual(pinPartition(diff))
    expect.soft(sortedPoints(junctionsOf(delta)), "dots").toEqual(sortedPoints(junctionsOf(diff)))
  })
})

type Edit = { added: WireSegment[]; removed: WireSegment[]; moved: Point[] }

const COLORS: (WireColorKey | undefined)[] = [undefined, undefined, undefined, "red", "blue"]
const SIDE = 10

type MovingPin = { key: string; at: Point; socket: boolean }

function randomEdit(rng: ReturnType<typeof random>, wires: readonly WireSegment[], pins: MovingPin[], fresh: () => string): Edit {
  const at = (x: number, y: number): Point => ({ x: Math.max(0, Math.min(SIDE, x)) * HALF_CELL, y: Math.max(0, Math.min(SIDE, y)) * HALF_CELL })
  const lattice = () => at(rng.int(0, SIDE), rng.int(0, SIDE))
  const color = () => rng.pick(COLORS)
  const seg = (a: Point, b: Point, colour = color()): WireSegment => (colour ? { id: fresh(), a, b, color: colour } : { id: fresh(), a, b })
  const run = (from: Point) => {
    const length = rng.int(1, 6) * (rng.chance(0.5) ? 1 : -1)
    return rng.chance(0.5) ? at(from.x / HALF_CELL + length, from.y / HALF_CELL) : at(from.x / HALF_CELL, from.y / HALF_CELL + length)
  }
  const inside = (s: WireSegment): Point => {
    const t = rng.next()
    return at(Math.round((s.a.x + (s.b.x - s.a.x) * t) / HALF_CELL), Math.round((s.a.y + (s.b.y - s.a.y) * t) / HALF_CELL))
  }
  const none: Edit = { added: [], removed: [], moved: [] }
  const kind = rng.int(0, 9)
  if (kind === 0 && wires.length) return { ...none, removed: [rng.pick(wires)] }
  if (kind === 1) {
    const moving = rng.pick(pins)
    const was = moving.at
    moving.at = lattice()
    return { ...none, moved: [was, moving.at] }
  }
  if (kind === 2 && wires.length) {
    const old = rng.pick(wires)
    return { ...none, removed: [old], added: [seg(old.a, old.b)] }
  }
  if (kind === 3 && wires.length) {
    const from = rng.pick(wires.flatMap((s) => [s.a, s.b]))
    return { ...none, added: [seg(from, run(from))] }
  }
  if (kind === 4 && wires.length) {
    const from = inside(rng.pick(wires))
    return { ...none, added: [seg(from, run(from))] }
  }
  if (kind === 5 && wires.length) {
    const along = rng.pick(wires)
    return { ...none, added: [seg(inside(along), inside(along))] }
  }
  if (kind === 6) {
    const from = rng.chance(0.5) ? rng.pick(pins).at : lattice()
    const corner = run(from)
    const to = corner.y === from.y ? at(corner.x / HALF_CELL, corner.y / HALF_CELL + rng.int(-5, 5)) : at(corner.x / HALF_CELL + rng.int(-5, 5), corner.y / HALF_CELL)
    const colour = color()
    return { ...none, added: [seg(from, corner, colour), seg(corner, to, colour)] }
  }
  if (kind === 7 && wires.length > 1) {
    const doomed = new Set<WireSegment>()
    for (let i = rng.int(1, 3); i > 0; i--) doomed.add(rng.pick(wires))
    return { ...none, removed: [...doomed] }
  }
  const from = rng.chance(0.4) ? rng.pick(pins).at : lattice()
  return { ...none, added: [seg(from, run(from))] }
}

function untouchedBy(edit: Edit, before: readonly WireSegment[]): WireSegment[] {
  const points = [...edit.moved, ...edit.added.flatMap((s) => [s.a, s.b]), ...edit.removed.flatMap((s) => [s.a, s.b])]
  const on = (s: WireSegment, p: Point) =>
    s.a.y === s.b.y ? p.y === s.a.y && p.x >= Math.min(s.a.x, s.b.x) && p.x <= Math.max(s.a.x, s.b.x) : p.x === s.a.x && p.y >= Math.min(s.a.y, s.b.y) && p.y <= Math.max(s.a.y, s.b.y)
  const overlaps = (s: WireSegment, t: WireSegment) => {
    if (t.a.x === t.b.x && t.a.y === t.b.y) return false
    const flatS = s.a.y === s.b.y
    const flatT = t.a.y === t.b.y
    if (flatS !== flatT) return false
    if (flatS ? s.a.y !== t.a.y : s.a.x !== t.a.x) return false
    const k = (p: Point) => (flatS ? p.x : p.y)
    return Math.max(k(s.a), k(s.b)) >= Math.min(k(t.a), k(t.b)) && Math.min(k(s.a), k(s.b)) <= Math.max(k(t.a), k(t.b))
  }
  const removed = new Set(edit.removed)
  return before.filter((s) => !removed.has(s) && !points.some((p) => on(s, p)) && !edit.added.some((t) => overlaps(s, t)))
}

describe("what the graph may keep across a document handed to it again (findings 3.L15)", () => {
  const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
  const shifted = (p: Point): Point => ({ x: p.x + 3 * GRID, y: p.y + GRID })
  const wires: WireSegment[] = [{ id: "a", a: at(0, 0), b: at(4, 0) }, { id: "b", a: at(4, 0), b: at(4, 3) }]
  const pins: WirePin[] = [{ key: "R1:2", at: at(0, 0), out: { x: 1, y: 0 } }, { key: "R2:1", at: at(4, 3), out: { x: 0, y: -1 } }]
  const tokenOf = (view: ReturnType<WireGraph["of"]>, key: string) => view.token(view.netOfPin(key)!)

  it("the whole drawing moved keeps its nets; moved with a wire recoloured or a pin facing another way, the net is derived again", () => {
    const moved = { wires: wires.map((s) => ({ ...s, a: shifted(s.a), b: shifted(s.b) })), pins: pins.map((p) => ({ ...p, at: shifted(p.at) })) }
    const graph = new WireGraph()
    const first = tokenOf(graph.of(wires, pins), "R1:2")
    expect.soft(tokenOf(graph.of(moved.wires, moved.pins), "R1:2"), "moved: the same net").toBe(first)
    const plain = new WireGraph()
    const kept = tokenOf(plain.of(wires, pins), "R1:2")
    expect.soft(tokenOf(plain.of(moved.wires.map((s) => (s.id === "b" ? { ...s, color: "red" as const } : s)), moved.pins), "R1:2"), "moved and recoloured: a net derived again").not.toBe(kept)
    const turned = new WireGraph()
    const before = tokenOf(turned.of(wires, pins), "R1:2")
    expect.soft(tokenOf(turned.of(moved.wires, moved.pins.map((p) => (p.key === "R1:2" ? { ...p, out: { x: -1, y: 0 } } : p))), "R1:2"), "moved with a pin facing back: a net derived again").not.toBe(before)
  })

  it("a pin handed again in its place but facing another way is the new pin", () => {
    const graph = new WireGraph()
    graph.of(wires, pins)
    const view = graph.of(wires, pins.map((p) => (p.key === "R1:2" ? { ...p, out: { x: 0, y: 1 } } : p)))
    expect.soft(view.pin("R1:2")!.out, "facing down now").toEqual({ x: 0, y: 1 })
  })
})

describe("random edit sequences against the brute-force reference (junctions.md principle 5)", () => {
  it("after every edit: N1–N4 hold, local equals global, a fixed point, the circuit of the raw drawing, the graph rebuilt or updated agrees, and nothing outside the edit moved", () => {
    const SEQUENCES = 120
    const STEPS = 40
    let checked = 0
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const rng = random(seed)
      const fresh = counter(`s${seed}-`)
      const pins: MovingPin[] = Array.from({ length: 6 }, (_, i) => ({ key: `P${i}:1`, at: { x: rng.int(0, SIDE) * HALF_CELL, y: rng.int(0, SIDE) * HALF_CELL }, socket: i >= 4 }))
      const graph = new WireGraph()
      const deltaGraph = new WireGraph()
      let wires: readonly WireSegment[] = []
      let lastPins: WirePin[] = []
      for (let step = 0; step < STEPS; step++) {
        const edit = randomEdit(rng, wires, pins, fresh)
        const livePins = pins.map((p) => ({ ...p, at: { ...p.at } }))
        const gone = new Set(edit.removed.map((s) => s.id))
        const raw = [...wires.filter((s) => !gone.has(s.id)), ...edit.added]
        const local = normalise(raw, livePins, { segments: [...edit.added, ...edit.removed], points: edit.moved }, fresh)
        const global = normalise(raw, livePins, undefined, counter("g"))
        const where = `seed ${seed} step ${step}`
        const problems = normalFormViolations(local, livePins)
        expect.soft(problems, `${where}: normal form`).toEqual([])
        expect.soft(geometryOf(local), `${where}: local and global agree`).toEqual(geometryOf(global))
        expect.soft(normalise(local, livePins, undefined, counter("i")), `${where}: idempotent`).toBe(local)
        expect.soft(paintOf(local), `${where}: every stretch keeps the colour of the wire that was there first`).toEqual(paintOf(raw))
        const nets = graph.of(local, livePins)
        const fresher = wireNets(local, livePins)
        const want = referencePartition(raw, livePins)
        expect.soft(canonical(pinPartition(nets)), `${where}: the graph kept up to date gives the raw drawing's circuit`).toEqual(want)
        expect.soft(canonical(pinPartition(fresher)), `${where}: a graph built afresh gives it too`).toEqual(want)
        expect.soft(sortedPoints(junctionsOf(nets)), `${where}: dots`).toEqual(bruteJunctions(local, livePins))
        expect.soft(sortedPoints(danglingEnds(nets)), `${where}: dangling ends`).toEqual(bruteDangling(local, livePins))
        for (const s of local) expect.soft(nets.netOfSegment(s.id), `${where}: ${s.id} on a net`).toBeDefined()
        const committed = commitEdit(wires, livePins, { add: edit.added, remove: edit.removed, points: edit.moved }, counter(`c${seed}-${step}-`))
        expect.soft(geometryOf(committed.wires), `${where}: committing gives the same document`).toEqual(geometryOf(local))
        const moved = (p: WirePin, q: WirePin | undefined) => !q || q.at.x !== p.at.x || q.at.y !== p.at.y
        const viaDelta = deltaGraph.apply({ added: committed.added, removed: committed.removed, pinsAdded: livePins.filter((p) => moved(p, lastPins.find((q) => q.key === p.key))), pinsRemoved: lastPins.filter((p) => moved(p, livePins.find((q) => q.key === p.key))) })
        expect.soft(canonical(pinPartition(viaDelta)), `${where}: the graph fed the edit's delta`).toEqual(want)
        expect.soft(sortedPoints(junctionsOf(viaDelta)), `${where}: its dots`).toEqual(bruteJunctions(committed.wires, livePins))
        lastPins = livePins
        const kept = untouchedBy(edit, wires)
        expect.soft(kept.filter((s) => !local.includes(s)).map((s) => s.id), `${where}: wires the edit does not reach are the same objects`).toEqual([])
        if (problems.length) return
        wires = committed.wires
        checked++
      }
    }
    expect.soft(checked, "every edit of every sequence checked").toBe(SEQUENCES * STEPS)
  })
})

describe("today's examples and files, every wire frozen into segments", () => {
  it("are in normal form and give exactly the circuit phase 0 froze, with no register of exceptions", async () => {
    for (const { name, doc } of await partitionDocuments()) {
      const fixture = readFixture(name)
      if (!fixture) continue
      const pins = wirePins(doc.objects)
      expect.soft(normalFormViolations(doc.wires, pins), `${name}: normal form`).toEqual([])
      const got = renamed(doc.objects, pinPartition(wireNets(doc.wires, pins)))
      const raw = renamed(doc.objects, geometricGroups(pins.map((p) => ({ key: p.key, at: p.at, socket: p.socket })), doc.wires))
      expect.soft(got, `${name}: the graph agrees with the brute-force reference`).toEqual(raw)
      expect.soft(got, `${name}: the circuit phase 0 froze, NC pads' contacts joined`).toEqual(joiningContactsOfNcPads(fixture.nets, doc.objects))
    }
  })
})
