import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import type { Point } from "@/schematic/types"
import { danglingEnds, junctionsOf, pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import { normalise } from "@/schematic/wires/normal-form"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"
import { counter, geometryOf } from "../lib/wire-reference"

const c = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
let serial = 0
const w = (a: Point, b: Point): WireSegment => ({ id: `w${++serial}`, a, b })
const path = (...pts: Point[]) => pts.slice(1).map((p, i) => w(pts[i], p))
const pin = (key: string, at: Point, socket = false): WirePin => ({ key, at, socket })
const settled = (wires: readonly WireSegment[], pins: readonly WirePin[]) => normalise(wires, pins, undefined, counter("n"))
const dots = (wires: readonly WireSegment[], pins: readonly WirePin[]) => junctionsOf(wireNets(settled(wires, pins), pins))

describe("a dot at every point where three or more conductor ends meet, a pin counting as one, and nowhere else (design.md §3.2)", () => {
  it("a bend of one wire: two ends, no dot", () => {
    expect(dots(path(c(0, 0), c(4, 0), c(4, 4)), [pin("A:1", c(0, 0)), pin("B:1", c(4, 4))])).toEqual([])
  })

  it("a wire ending on a pin: two ends, no dot", () => {
    expect(dots([w(c(0, 0), c(4, 0))], [pin("A:1", c(0, 0)), pin("B:1", c(4, 0))])).toEqual([])
  })

  it("two pins butted, R1 onto LED1: two ends, no dot, but one net", () => {
    const pins = [pin("R1:2", c(4, 1)), pin("LED1:1", c(4, 1))]
    expect.soft(dots([], pins), "no dot on a two-pin contact").toEqual([])
    expect.soft(pinPartition(wireNets([], pins)), "the two pins are connected").toEqual([["LED1:1", "R1:2"]])
  })

  it("a T, a wire ending on another: three ends, a dot", () => {
    expect(dots([w(c(0, 0), c(8, 0)), w(c(4, 4), c(4, 0))], [pin("A:1", c(0, 0)), pin("B:1", c(8, 0)), pin("C:1", c(4, 4))])).toEqual([c(4, 0)])
  })

  it("a wire ending on a pin that another wire also ends on: three ends, a dot on the pin", () => {
    expect(dots([w(c(0, 0), c(4, 0)), w(c(4, 0), c(4, 4))], [pin("A:1", c(0, 0)), pin("R1:1", c(4, 0)), pin("B:1", c(4, 4))])).toEqual([c(4, 0)])
  })

  it("three pins on one point: three ends, a dot", () => {
    expect(dots([], [pin("A:1", c(2, 2)), pin("B:1", c(2, 2)), pin("C:1", c(2, 2))])).toEqual([c(2, 2)])
  })

  it("four ends: a dot", () => {
    expect(dots([...path(c(0, 2), c(2, 2), c(4, 2)), ...path(c(2, 0), c(2, 2), c(2, 4))], [])).toEqual([c(2, 2)])
  })

  it("two wires crossing: no end there, never a dot, and two nets", () => {
    const pins = [pin("A:1", c(0, 2)), pin("B:1", c(4, 2)), pin("C:1", c(2, 0)), pin("D:1", c(2, 4))]
    const wires = [w(c(0, 2), c(4, 2)), w(c(2, 0), c(2, 4))]
    expect.soft(dots(wires, pins), "no dot").toEqual([])
    expect.soft(pinPartition(wireNets(settled(wires, pins), pins)).length, "two nets").toBe(2)
  })
})

describe("the junction register's dot cases (junctions.md)", () => {
  it("R3 wired to R1's pin, which already has a wire to R2: a straight spine through the pin, the dot on the pin (1)", () => {
    const pins = [pin("R2:2", c(2, 4)), pin("R1:1", c(6, 4)), pin("R3:1", c(10, 4))]
    const wires = settled([w(c(2, 4), c(6, 4)), w(c(6, 4), c(10, 4))], pins)
    expect.soft(geometryOf(wires), "the spine stays two wires, split at the pin").toEqual(geometryOf([w(c(2, 4), c(6, 4)), w(c(6, 4), c(10, 4))]))
    expect.soft(junctionsOf(wireNets(wires, pins)), "the dot").toEqual([c(6, 4)])
  })

  it("the branch to R1 deleted, R1 staying: the dot goes, the spine merges, R1's pin is open again (5)", () => {
    const pins = [pin("R2:2", c(0, 4)), pin("R3:1", c(8, 4)), pin("R1:1", c(4, 8))]
    const branch = w(c(4, 8), c(4, 4))
    const graph = new WireGraph()
    const before = settled([w(c(0, 4), c(8, 4)), branch], pins)
    const withBranch = graph.of(before, pins)
    expect.soft(junctionsOf(withBranch), "the dot while the branch is there").toEqual([c(4, 4)])
    expect.soft(withBranch.connected("R1:1"), "R1 on the net").toBe(true)
    const after = normalise(before.filter((s) => s.id !== branch.id), pins, { segments: [branch] }, counter("m"))
    const without = graph.of(after, pins)
    expect.soft(geometryOf(after), "one straight spine").toEqual(geometryOf([w(c(0, 4), c(8, 4))]))
    expect.soft(junctionsOf(without), "no dot").toEqual([])
    expect.soft(without.connected("R1:1"), "R1's pin open").toBe(false)
  })

  it("branches arriving from both sides of one point: four ends, a dot (13)", () => {
    const pins = [pin("A:1", c(0, 4)), pin("B:1", c(8, 4)), pin("C:1", c(4, 0)), pin("D:1", c(4, 8))]
    expect(dots([w(c(0, 4), c(8, 4)), w(c(4, 0), c(4, 4)), w(c(4, 8), c(4, 4))], pins)).toEqual([c(4, 4)])
  })

  it("a third wire ended on a pin that already has two: four ends and a pin, still one dot (14)", () => {
    const pins = [pin("R1:1", c(4, 4)), pin("A:1", c(0, 4)), pin("B:1", c(4, 0)), pin("C:1", c(8, 4))]
    const wires = settled([w(c(0, 4), c(4, 4)), w(c(4, 0), c(4, 4)), w(c(8, 4), c(4, 4))], pins)
    expect.soft(junctionsOf(wireNets(wires, pins)), "one dot").toEqual([c(4, 4)])
    expect.soft(pinPartition(wireNets(wires, pins)), "one net").toEqual([["A:1", "B:1", "C:1", "R1:1"]])
  })

  it("both wires of a crossing split at it, as the junction tool does: four ends kept, a dot, the two nets one (32)", () => {
    const pins = [pin("A:1", c(0, 2)), pin("B:1", c(4, 2)), pin("C:1", c(2, 0)), pin("D:1", c(2, 4))]
    const wires = settled([...path(c(0, 2), c(2, 2), c(4, 2)), ...path(c(2, 0), c(2, 2), c(2, 4))], pins)
    expect.soft(wires.length, "four wires, none merged back through the dot").toBe(4)
    expect.soft(junctionsOf(wireNets(wires, pins)), "the dot").toEqual([c(2, 2)])
    expect.soft(pinPartition(wireNets(wires, pins)), "one net").toEqual([["A:1", "B:1", "C:1", "D:1"]])
  })
})

describe("dangling ends and open pins (design.md §3.3)", () => {
  it("a wire drawn into space ends dangling; ended on a pin it does not", () => {
    const pins = [pin("A:1", c(0, 0))]
    expect.soft(danglingEnds(wireNets([w(c(0, 0), c(4, 0))], pins)), "into space").toEqual([c(4, 0)])
    expect.soft(danglingEnds(wireNets([w(c(0, 0), c(4, 0))], [...pins, pin("B:1", c(4, 0))])), "onto a pin").toEqual([])
  })

  it("a part taken away leaves its wires' ends dangling at its pins, and put back reconnects by itself", () => {
    const wires = [w(c(0, 0), c(4, 0)), w(c(8, 0), c(12, 0))]
    const board = [pin("A:1", c(0, 0)), pin("B:1", c(12, 0))]
    const part = [pin("R1:1", c(4, 0)), pin("R1:2", c(8, 0))]
    const graph = new WireGraph()
    expect.soft(danglingEnds(graph.of(wires, [...board, ...part])), "with the part").toEqual([])
    const gone = graph.of(wires, board)
    expect.soft([...danglingEnds(gone)].sort((p, q) => p.x - q.x), "without it").toEqual([c(4, 0), c(8, 0)])
    expect.soft(pinPartition(gone), "no circuit left through it").toEqual([])
    const back = graph.of(wires, [...board, ...part])
    expect.soft(danglingEnds(back), "back in place").toEqual([])
    expect.soft(pinPartition(back), "reconnected").toEqual([["A:1", "R1:1"], ["B:1", "R1:2"]])
  })

  it("an NC pad is a pin like any other: a pin butted onto it joins it, as a wire ended on it does (design.md §1.2, §13.6)", () => {
    const pad: WirePin = { key: "U1:CN8-1", at: c(5, 17), socket: true, kind: "nc" }
    expect.soft(pinPartition(wireNets([], [pad, pin("R1:1", c(5, 17))])), "butted").toEqual([["R1:1", "U1:CN8-1"]])
    expect.soft(pinPartition(wireNets([w(c(0, 17), c(5, 17))], [pad, pin("R2:1", c(0, 17))])), "wired").toEqual([["R2:1", "U1:CN8-1"]])
  })

  it("a pin with nothing on it is not connected; a pin with a wire or a butted pin is", () => {
    const nets = wireNets([w(c(0, 0), c(4, 0))], [pin("A:1", c(0, 0)), pin("B:1", c(9, 9)), pin("C:1", c(12, 12)), pin("D:1", c(12, 12))])
    expect.soft(nets.connected("A:1"), "wired").toBe(true)
    expect.soft(nets.connected("B:1"), "alone").toBe(false)
    expect.soft(nets.connected("C:1"), "butted").toBe(true)
  })
})
