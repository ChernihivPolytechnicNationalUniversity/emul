import { describe, expect, it, vi } from "vitest"
import * as bodies from "@/schematic/body-crossing"
import { checked } from "@/schematic/checker"
import { GRID, objectPins, snap, type Point } from "@/schematic/geometry"
import { wireCheck } from "@/schematic/placement"
import { getDef } from "@/schematic/registry"
import { flippedAlone, flippedWithWires, PartDrag, turnedAlone, TurnRun, type Landed } from "@/schematic/rubber-band"
import type { PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { pasteLanding, pastedInto } from "@/schematic/use-schematic"
import { drawEndAt, drawnTo, isRefusal, pointerAt, startDrawing } from "@/schematic/wire-draw"
import { inNormalForm, placedObject, wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import { sourceCallback } from "../lib/source-callback"

const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const resistor = (id: string, x: number, y: number, rotation: Rotation = 0): PlacedObject => ({ id, def: "resistor", ...at(x, y), rotation })
let serial = 0
const newId = () => `body-rule-${serial++}`
const wire = (a: Point, b: Point) => ({ id: newId(), a, b })
const docOf = (objects: PlacedObject[], wires: Schematic["wires"] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic) => wiringOf(new WireGraph(), doc)
const crossings = (doc: Schematic) => checked(doc).filter((f) => f.kind === "wire-through-body")

function turningScene(x: number, y: number) {
  const part = resistor("moving", 0, 0, 45)
  const pin = objectPins(part, GRID)[1].point
  return docOf([part, resistor("neighbour", x, y)], [wire(pin, { x: pin.x + 5 * GRID, y: pin.y })])
}

describe("the final body audit", () => {
  it.each([45, 90])("a %i degree turn whose committed wires would cross the neighbour where it stands never commits them: it lands where they are clean, or is refused", (degrees) => {
    const doc = turningScene(degrees === 45 ? -1 : 0, 2)
    expect(crossings(doc)).toEqual([])
    const snapshot = structuredClone(doc)
    const wires = degrees === 90 ? new Set(doc.wires.map((s) => s.id)) : undefined
    const run = new TurnRun(doc, wiringFor(doc), new Set(["moving"]), undefined, wires)
    const result = run.turned(1, newId)
    expect.soft(crossings(result.doc), "no wire through a body after the turn").toEqual([])
    expect.soft(result.refused ? result.doc === doc && run.doc === doc : result.doc !== doc, "refused and nothing committed, or a clean landing").toBe(true)
    expect.soft(doc, "the document turned is untouched").toEqual(snapshot)
  })

  it("refuses X when its committed wires cross the neighbour", () => {
    const doc = turningScene(-1, 2)
    const result = flippedWithWires(doc, wiringFor(doc), new Set(["moving"]), "horizontal", newId)
    expect(result.refused).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "body" })]))
    expect(result.doc).toBe(doc)
  })

  it("refuses Y when the left pin's carried wire crosses the neighbour", () => {
    const part = resistor("moving", 0, 0, 45)
    const doc = docOf([part, resistor("neighbour", -2, 0)], [wire(at(0, 0), at(0, -5))])
    expect(crossings(doc)).toEqual([])
    const result = flippedWithWires(doc, wiringFor(doc), new Set(["moving"]), "vertical", newId)
    expect(result.refused?.some((c) => c.reason === "body")).toBe(true)
    expect(result.doc).toBe(doc)
  })

  it.each(["rotateAlone", "flipAlone"])("%s cannot turn a body over a static wire: it is refused or lands where its body is clear (fix/rotate-placement's nearest clean spot)", (name) => {
    const doc = name === "rotateAlone"
      ? docOf([resistor("moving", 0, 0)], [wire(at(1, 1.5), at(2, 1.5))])
      : docOf([resistor("moving", 0, 0, 45)], [wire(at(0, 2), at(1, 2))])
    expect(crossings(doc)).toEqual([])
    let after = doc
    const run = sourceCallback<(ids: Set<string>, direction: 1 | "horizontal") => unknown>("src/schematic/use-schematic.ts", name, {
      doc, turnedAlone, flippedAlone,
      commitFrom: (_before: Schematic, next: Schematic) => { after = next },
    })
    const landed = run(new Set(["moving"]), name === "rotateAlone" ? 1 : "horizontal") as Landed
    expect.soft(crossings(after), "no wire through a body after the turn").toEqual([])
    expect.soft(landed.refused ? after === doc : after === landed.doc && after !== doc, "refused and nothing committed, or the clean landing committed").toBe(true)
  })

  it.each(["horizontal", "vertical"] as const)("refuses a %s flip that covers a static wire with the part itself", (axis) => {
    const part = { id: "part", def: "npn", ...at(0, 0) }
    for (let x = 0; x <= 4; x++) {
      for (let y = 0; y <= 4; y++) {
        const doc = docOf([part], [wire(at(x, y), at(x + 1, y))])
        if (crossings(doc).length) continue
        const result = flippedWithWires(doc, wiringFor(doc), new Set(["part"]), axis, newId)
        expect(crossings(result.doc), `${axis} at ${x},${y}`).toEqual([])
        if (result.refused) expect(result.doc).toBe(doc)
      }
    }
  })

  it("refuses the relaying fallback when every nearby offset covers a static wire", () => {
    const doc = docOf([resistor("moving", 0, 0), resistor("fixed", 80, 80)], Array.from({ length: 13 }, (_, i) => wire(at(20 + i, -8), at(20 + i, 8))))
    const drag = new PartDrag(doc, wiringFor(doc), { objects: new Set(["moving"]) })
    for (let dx = 18; dx <= 26; dx++) for (let dy = -4; dy <= 4; dy++) expect(drag.blocked(dx * GRID, dy * GRID)).toBe(true)
    const result = drag.landed(22 * GRID, 0, newId)
    expect(result.refused?.some((c) => c.reason === "body")).toBe(true)
    expect(result.at).toEqual(at(0, 0))
    expect(result.doc).toBe(doc)
  })

  it("audits detached drops even when all the parts are carried", () => {
    const doc = docOf([resistor("moving", 0, 0)], [wire(at(12, -4), at(12, 5))])
    const result = new PartDrag(doc, wiringFor(doc), { objects: new Set(["moving"]) }, { detach: true }).landed(10 * GRID, 0, newId)
    expect(result.refused?.some((c) => c.reason === "body")).toBe(true)
    expect(result.doc).toBe(doc)
  })

  it.each([false, true])("audits pasted wires against both existing and pasted bodies (internal=%s)", (internal) => {
    const part = resistor("part", 0, 0)
    const doc = docOf(internal ? [] : [part])
    const clip = { objects: internal ? [part] : [], wires: [wire(at(2, -3), at(2, 4))], parts: {} }
    const refused = vi.fn()
    const result = pastedInto(doc, clip, 0, 0, newId, newId, refused)
    expect(result).toBe(doc)
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ refused: "body" }))
  })

  it("a part-only paste covering an existing wire is refused at its final result", () => {
    const doc = docOf([], [wire(at(2, -3), at(2, 4))])
    const result = pastedInto(doc, { objects: [resistor("part", 0, 0)], wires: [], parts: {} }, 0, 0, newId, newId)
    expect(result).toBe(doc)
  })

  it("a paste with an invalid internal crossing cannot claim a clean landing", () => {
    const clip = { objects: [resistor("part", 0, 0)], wires: [wire(at(2, -3), at(2, 4))], parts: {} }
    expect(pasteLanding({ objects: [], routes: [], grid: GRID }, clip, at(0, 0)).clear).toBe(false)
  })

  it("audits palette placement after normalization when the offset search exhausts its reach", () => {
    let doc = docOf([], [wire(at(2, -3), at(2, 4))])
    const before = doc
    const refused = vi.fn()
    const add = sourceCallback<(def: string, center: Point, options: object) => unknown>("src/schematic/use-schematic.ts", "add", {
      doc, getDef, snap, grid: GRID, crypto: { randomUUID: newId }, placedObject, wireCheck, freeSpot: () => at(0, 0),
      bodyRefusal: bodies.bodyRefusal,
      setDoc: (fn: (d: Schematic) => Schematic) => { doc = fn(doc) },
      nextRef: () => "R1", setSelectedObjects: () => {}, setSelectedWires: () => {},
    })
    add("resistor", at(2, 1), { onRefused: refused })
    expect(doc).toBe(before)
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ refused: "body" }))
  })

  it("audits drawing after the preview even if its spatial query omitted a body", () => {
    const doc = docOf([resistor("part", 0, 0)])
    const wiring = wiringFor(doc)
    const start = startDrawing(wiring, drawEndAt(wiring, at(2, -3)))
    if (isRefusal(start)) throw new Error(start.refused)
    const drawing = pointerAt(start, at(2, 4))
    const result = drawnTo(doc, wiring, drawing, drawEndAt(wiring, at(2, 4)), newId, () => [])
    expect(result).toMatchObject({ refused: "body" })
    expect(doc.wires).toEqual([])
  })

  it("compares crossing geometry rather than segment IDs, directions or normalization splits", () => {
    const part = resistor("old", 0, 0)
    const before = docOf([part], [wire(at(2, -3), at(2, 4))])
    const after = { ...before, objects: [{ ...part, id: "renamed" }], wires: [wire(at(2, 4), at(2, 1)), wire(at(2, 1), at(2, -3))] }
    expect(bodies.bodyRefusal(before, after)).toBeNull()
    expect(bodies.bodyRefusal(before, { ...after, wires: [...after.wires, wire(at(2.5, -3), at(2.5, 4))] })).toMatchObject({ refused: "body" })
  })

  it("an old crossing permits edits elsewhere, but moving its body over fresh wire is refused", () => {
    const doc = docOf([resistor("old", 0, 0), resistor("moving", 30, 30)], [wire(at(2, -3), at(2, 4)), wire(at(12, -3), at(12, 4))])
    const result = new PartDrag(doc, wiringFor(doc), { objects: new Set(["moving"]) }).landed(GRID, 0, newId)
    expect(result.refused).toBeUndefined()
    expect(result.doc).not.toBe(doc)
    expect(crossings(result.doc)).toHaveLength(1)
    const detached = new PartDrag(doc, wiringFor(doc), { objects: new Set(["old"]) }, { detach: true }).landed(10 * GRID, 0, newId)
    expect(detached.refused?.some((c) => c.reason === "body")).toBe(true)
    expect(detached.doc).toBe(doc)
  })

  it("a board stays passable and a successful splice leaves no crossing", () => {
    const board = { id: "board", def: "nucleo-f429zi", ...at(0, 0) }
    const doc = docOf([board])
    const pasted = pastedInto(doc, { objects: [], wires: [wire(at(8, -4), at(8, 40))], parts: {} }, 0, 0, newId, newId)
    expect(pasted).not.toBe(doc)
    expect(crossings(pasted)).toEqual([])
    const spine = docOf([], [wire(at(-3, 1), at(8, 1))])
    const spliced = placedObject(spine, resistor("part", 0, 0), newId)
    expect(spliced).not.toBe(spine)
    expect(crossings(spliced)).toEqual([])
  })
})
