import { describe, expect, it } from "vitest"
import { refusedStretches } from "@/schematic/conflict-marks"
import { GRID, type Point } from "@/schematic/geometry"
import { wirePins } from "@/schematic/migrate-wires"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { drawEndAt, drawnTo, isRefusal, laysClear, pointerAt, previewOf, startDrawing, withCorner, withLineMode, type Drawing, type LineMode } from "@/schematic/wire-draw"
import { inNormalForm, wiringOf } from "@/schematic/wire-edits"
import { danglingEnds, junctionsOf, pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import { samePoint, type WireSegment } from "@/schematic/wires/segment"
import { diagonalNormalFormViolations } from "../lib/diagonal-reference"
import { counter, geometryOf, sortedPoints } from "../lib/wire-reference"

const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
const newId = counter("across")
const seg = (a: Point, b: Point): WireSegment => ({ id: newId(), a, b })
const docOf = (objects: PlacedObject[] = [], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic) => wiringOf(new WireGraph(), doc)
const viewOf = (doc: Schematic) => wireNets(doc.wires, wirePins(doc.objects))

function drawing(doc: Schematic, from: Point, mode: LineMode = "90") {
  const wiring = wiringFor(doc)
  const started = startDrawing(wiring, drawEndAt(wiring, from))
  if (isRefusal(started)) throw new Error(started.refused)
  return { wiring, d: withLineMode(started, mode) }
}

function lay(doc: Schematic, from: Point, to: Point, mode: LineMode = "90", corners: Point[] = []) {
  const { wiring, d } = drawing(doc, from, mode)
  const held = corners.reduce((d: Drawing, p) => {
    const corner = withCorner(doc, wiring, pointerAt(d, p), p)
    if (isRefusal(corner)) throw new Error(corner.refused)
    return corner
  }, d)
  const target = drawEndAt(wiring, to)
  const aimed = pointerAt(held, to)
  const preview = previewOf(doc, wiring, aimed, target)
  expect.soft(preview.refused, "the preview allows every contact on the route").toBeNull()
  expect.soft(refusedStretches(preview.points, preview.refused), "no conflict stretch in the preview").toEqual([])
  const after = drawnTo(doc, wiring, aimed, target, newId)
  expect.soft(isRefusal(after), "the click lays the preview").toBe(false)
  if (isRefusal(after)) throw new Error(after.refused)
  const expected = docOf(doc.objects, [...doc.wires, ...preview.points.slice(1).map((p, i) => seg(preview.points[i], p))])
  expect.soft(geometryOf(after.wires), "the laid geometry equals the preview in normal form").toEqual(geometryOf(expected.wires))
  expect.soft(diagonalNormalFormViolations(after.wires, wirePins(after.objects)), "every contact is split in normal form").toEqual([])
  return { after, preview }
}

describe("drawing through connection points connects them", () => {
  it.each([3, 4])("connects %i vertically stacked resistors through every middle pin", (count) => {
    const doc = docOf(Array.from({ length: count }, (_, i) => resistor(`R${i + 1}`, 0, i * 3)))
    const points = Array.from({ length: count }, (_, i) => at(0, i * 3 + 1))
    const { after, preview } = lay(doc, points[0], points.at(-1)!)
    expect.soft(preview.points, "a single straight vertical stroke").toEqual([points[0], points.at(-1)!])
    expect.soft(preview.routed, "passing pins does not invoke completion").toBe(false)
    expect.soft(geometryOf(after.wires), "split at each middle pin").toEqual(geometryOf(points.slice(1).map((p, i) => seg(points[i], p))))
    expect.soft(pinPartition(viewOf(after)), "all left pins are one net").toEqual([Array.from({ length: count }, (_, i) => `R${i + 1}:1`)])
    expect.soft(sortedPoints(junctionsOf(viewOf(after))), "a dot at each through pin").toEqual(points.slice(1, -1))
    expect.soft(danglingEnds(viewOf(after)), "both ends finish on pins").toEqual([])
  })

  it("connects a horizontal row through two other free pins", () => {
    const doc = docOf([0, 3, 6, 9].map((x, i) => resistor(`R${i + 1}`, x, 0, 90)))
    const points = [1, 4, 7, 10].map((x) => at(x, 0))
    const { after } = lay(doc, points[0], points[3])
    expect.soft(geometryOf(after.wires), "split at both intermediate pins").toEqual(geometryOf(points.slice(1).map((p, i) => seg(points[i], p))))
    expect.soft(pinPartition(viewOf(after)), "all four pins joined").toEqual([["R1:1", "R2:1", "R3:1", "R4:1"]])
  })

  it("connects a horizontal stroke across a vertical open end as a dotted T", () => {
    const { after } = lay(docOf([], [seg(at(0, 0), at(0, 4))]), at(-4, 0), at(4, 0))
    expect.soft(geometryOf(after.wires), "the horizontal stroke split at the open end").toEqual(geometryOf([seg(at(-4, 0), at(0, 0)), seg(at(0, 0), at(4, 0)), seg(at(0, 0), at(0, 4))]))
    expect.soft(junctionsOf(viewOf(after)), "three ends give one dot").toEqual([at(0, 0)])
    expect.soft(viewOf(after).nets.length, "the stub and stroke are one net").toBe(1)
    expect.soft(sortedPoints(danglingEnds(viewOf(after))), "the former top end is no longer dangling").toEqual([at(-4, 0), at(0, 4), at(4, 0)])
  })

  it("joins a collinear open end without treating end-to-end contact as overlap", () => {
    const { after, preview } = lay(docOf([], [seg(at(0, 0), at(4, 0))]), at(-4, 0), at(0, 0))
    expect.soft(preview.points, "the drawn leg stops at the existing end").toEqual([at(-4, 0), at(0, 0)])
    expect.soft(geometryOf(after.wires), "the two collinear pieces merge").toEqual(geometryOf([seg(at(-4, 0), at(4, 0))]))
    expect.soft(junctionsOf(viewOf(after)), "two ends do not make a dot").toEqual([])
  })

  it.each(["bend", "T", "junction"] as const)("connects through an existing %s point", (kind) => {
    const wires = [seg(at(0, 0), at(-2, 2)), seg(at(0, 0), at(2, 2))]
    if (kind !== "bend") wires.push(seg(at(0, 0), at(0, -4)))
    if (kind === "junction") wires.push(seg(at(0, 0), at(0, 4)))
    const { after } = lay(docOf([], wires), at(-4, 0), at(4, 0))
    expect.soft(after.wires.filter((s) => samePoint(s.a, at(0, 0)) || samePoint(s.b, at(0, 0))).length, "every arm ends on the joined point").toBe(wires.length + 2)
    expect.soft(junctionsOf(viewOf(after)), "the joined point has a dot").toEqual([at(0, 0)])
    expect.soft(viewOf(after).nets.length, "all arms share a net").toBe(1)
  })

  it.each(["45", "any"] as const)("connects through a pin and an open end exactly on the %s diagonal", (mode) => {
    const end = mode === "45" ? at(8, 8) : at(12, 6)
    const pin = mode === "45" ? at(4, 4) : at(4, 2)
    const contact = mode === "45" ? at(6, 6) : at(6, 3)
    const doc = docOf([resistor("R1", pin.x / GRID, pin.y / GRID - 1)], [seg(contact, at(contact.x / GRID, contact.y / GRID + 4))])
    const { after, preview } = lay(doc, at(0, 0), end, mode)
    expect.soft(preview.points, "the diagonal is kept as drawn").toEqual([at(0, 0), end])
    expect.soft(preview.routed, "diagonal drawing does not use completion").toBe(false)
    expect.soft(sortedPoints(junctionsOf(viewOf(after))), "dots on the pin and the stub's end").toEqual([pin, contact])
    expect.soft(viewOf(after).nets.length, "the pin, stroke and stub are one net").toBe(1)
  })

  it("silently merges already wired nets when passing their connected pin", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 7, 1, 90), resistor("R3", 12, 0), resistor("R4", 7, -6, 90)], [seg(at(8, -2), at(8, 1))])
    const { after } = lay(doc, at(4, 1), at(12, 1))
    expect.soft(pinPartition(viewOf(after)), "both pins of the old net join the drawn net").toEqual([["R1:2", "R2:1", "R3:1", "R4:2"]])
    expect.soft(junctionsOf(viewOf(after)), "the connected pin has three wire ends and a dot").toEqual([at(8, 1)])
  })

  it("starts on empty field as W or double-click does and connects every pin it passes", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 0, 3), resistor("R3", 0, 6)])
    const { after } = lay(doc, at(0, -2), at(0, 10))
    expect.soft(pinPartition(viewOf(after)), "all passed pins join the stroke").toEqual([["R1:1", "R2:1", "R3:1"]])
    expect.soft(sortedPoints(danglingEnds(viewOf(after))), "both field ends remain open").toEqual([at(0, -2), at(0, 10)])
  })

  it("can fix a corner beyond a passed pin and continue the same drawing", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 0, 3)])
    const { after } = lay(doc, at(0, 1), at(-4, 7), "90", [at(0, 7)])
    expect.soft(pinPartition(viewOf(after)), "the intermediate pin joins before the click-placed corner").toEqual([["R1:1", "R2:1"]])
    expect.soft(junctionsOf(viewOf(after)), "the pin keeps its dot after continuation").toEqual([at(0, 4)])
  })

  it.each(["pin", "end", "half-cell end", "diagonal end", "half-cell diagonal end", "bend", "T"] as const)("completion connects through %s on its route and lays exactly that preview", (kind) => {
    const objects = [resistor("R1", 0, 0), resistor("R2", 10, 4), resistor("R9", 6, -2, 90)]
    const base = docOf(objects)
    const start = at(4, 1)
    const target = at(10, 5)
    const { wiring, d } = drawing(base, start)
    const baseline = previewOf(base, wiring, pointerAt(d, target), drawEndAt(wiring, target))
    expect.soft(baseline.routed, "the obstructed L needs completion").toBe(true)
    const leg = baseline.points.slice(1).map((b, i) => ({ a: baseline.points[i], b })).find((s) => Math.abs(s.a.x - s.b.x) + Math.abs(s.a.y - s.b.y) >= 3 * GRID)!
    const distance = kind.startsWith("half-cell") ? GRID / 2 : GRID
    const contact = { x: leg.a.x + Math.sign(leg.b.x - leg.a.x) * distance, y: leg.a.y + Math.sign(leg.b.y - leg.a.y) * distance }
    const vertical = leg.a.x === leg.b.x
    const side = (across: number, along = 0) => ({ x: contact.x + (vertical ? across : along) * GRID, y: contact.y + (vertical ? along : across) * GRID })
    const wires = [seg(contact, side(-1, kind.includes("diagonal") || kind === "bend" || kind === "T" ? 0.5 : 0))]
    if (kind === "bend" || kind === "T") wires.push(seg(contact, side(-1, -0.5)))
    if (kind === "T") wires.push(seg(contact, side(1)))
    const doc = kind === "pin"
      ? docOf([...objects, resistor("R3", contact.x / GRID - (vertical ? 0 : 1), contact.y / GRID - (vertical ? 1 : 0), vertical ? undefined : 90)])
      : docOf(objects, wires)
    const { after, preview } = lay(doc, start, target)
    expect.soft(preview.routed, "completion still handles the obstructed plain L").toBe(true)
    expect.soft(preview.points, "a connection point on the route does not force a detour").toEqual(baseline.points)
    expect.soft(junctionsOf(viewOf(after)), "the completion joins the passed contact").toEqual([contact])
    if (kind === "pin") expect.soft(pinPartition(viewOf(after)), "the routed wire also connects R3").toEqual([["R1:2", "R2:1", "R3:1"]])
    else expect.soft(viewOf(after).nets.length, "the routed wire and stub merge").toBe(1)
  })

  it("keeps wire interiors crossing without a connection or a dot", () => {
    const { after } = lay(docOf([], [seg(at(0, -4), at(0, 4))]), at(-4, 0), at(4, 0))
    expect.soft(after.wires.length, "neither interior splits").toBe(2)
    expect.soft(viewOf(after).nets.length, "the crossing still has two nets").toBe(2)
    expect.soft(junctionsOf(viewOf(after)), "no dot at an interior crossing").toEqual([])
  })

  it("still refuses overlap with a net contacted earlier in the same drawing", () => {
    const doc = docOf([], [seg(at(-4, 2), at(0, 4)), seg(at(0, 4), at(3, 4))])
    const { wiring, d } = drawing(doc, at(-4, 0))
    const corner = withCorner(doc, wiring, pointerAt(d, at(-4, 4)), at(-4, 4))
    expect.soft(isRefusal(corner), "passing the first end is allowed").toBe(false)
    if (isRefusal(corner)) throw new Error(corner.refused)
    const aimed = pointerAt(corner, at(4, 4))
    const target = drawEndAt(wiring, at(4, 4))
    expect.soft(previewOf(doc, wiring, aimed, target).refused?.refused, "contact does not exempt later overlap").toBe("along")
    const after = drawnTo(doc, wiring, aimed, target, newId)
    expect.soft(isRefusal(after) && after.refused, "the click is refused too").toBe("along")
  })

  it("keeps paste clearance strict over a pin or wire end", () => {
    const doc = docOf([resistor("R1", 0, 0)], [seg(at(0, 4), at(3, 4))])
    const wiring = wiringFor(doc)
    expect.soft(laysClear(wiring, [seg(at(0, -2), at(0, 2))], doc), "paste still refuses a standing pin").toBe(false)
    expect.soft(laysClear(wiring, [seg(at(0, 2), at(0, 6))], doc), "paste still refuses a standing wire end").toBe(false)
  })
})
