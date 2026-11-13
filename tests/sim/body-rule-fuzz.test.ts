import { afterEach, describe, expect, it, vi } from "vitest"
import { checked } from "@/schematic/checker"
import { bodiesOf } from "@/schematic/body-crossing"
import { examples } from "@/schematic/examples"
import { GRID, type Point } from "@/schematic/geometry"
import { flippedWithWires, PartDrag, SegmentDrag, TurnRun } from "@/schematic/rubber-band"
import type { PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { pasteLanding, pastedInto } from "@/schematic/use-schematic"
import { drawEndAt, drawnTo, isRefusal, pointerAt, startDrawing } from "@/schematic/wire-draw"
import { inNormalForm, placedObject, wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import { random } from "../lib/wire-reference"

const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const key = (object: PlacedObject) => JSON.stringify(bodiesOf([object])[0]?.contour.map((p) => p.map((q) => [Math.round(q.x * 1e6), Math.round(q.y * 1e6)]).sort()).sort())
const through = (doc: Schematic) => checked(doc).filter((f) => f.kind === "wire-through-body").map((f) => ({ body: key(doc.objects.find((o) => o.id === f.objects[0])!), wire: doc.wires.find((s) => s.id === f.segments[0])! }))
const contains = (a: Point, b: Point, p: Point) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < 1e-5 && p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6 && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6

afterEach(() => vi.restoreAllMocks())

function newCrossings(before: ReturnType<typeof through>, after: Schematic) {
  return through(after).filter((next) => !before.some((old) => old.body === next.body && contains(old.wire.a, old.wire.b, next.wire.a) && contains(old.wire.a, old.wire.b, next.wire.b)))
}

function randomScene(seed: number): Schematic {
  const rng = random(seed)
  const objects: PlacedObject[] = Array.from({ length: 7 }, (_, i) => ({ id: `part-${i}`, def: rng.chance(0.3) ? "npn" : "resistor", ...at(rng.int(-12, 12), rng.int(-12, 12)), rotation: (rng.int(0, 7) * 45) as Rotation }))
  const doc: Schematic = { objects, wires: [], parts: {} }
  for (let i = 0; i < 9; i++) {
    const a = at(rng.int(-16, 16), rng.int(-16, 16))
    const b = rng.chance(0.5) ? { x: a.x + rng.int(1, 8) * GRID, y: a.y } : { x: a.x, y: a.y + rng.int(1, 8) * GRID }
    const next = { ...doc, wires: [...doc.wires, { id: `wire-${i}`, a, b }] }
    if (!through(next).length) doc.wires = next.wires
  }
  return inNormalForm(doc)
}

describe("seeded edits never introduce wire/body crossings", () => {
  it("checks every example and random scenes with drags, turns, X/Y, pastes, placements and drawing", () => {
    let uuid = 0
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${(++uuid).toString(16).padStart(12, "0")}`)
    const scenes = [...examples.map((e) => ({ name: e.id, doc: inNormalForm(e.build(GRID)) })), ...Array.from({ length: 24 }, (_, i) => ({ name: `random-${i}`, doc: randomScene(104729 + i * 31) }))]
    const failures: string[] = []
    const tally = { drag: 0, segment: 0, turn: 0, flip: 0, paste: 0, placement: 0, drawing: 0 }
    let serial = 0
    const newId = () => `body-fuzz-${serial++}`
    for (const { name, doc } of scenes) {
      const rng = random(524287 + name.length * 31 + name.charCodeAt(0))
      const before = through(doc)
      const wiring = wiringOf(new WireGraph(), doc)
      const snapshot = structuredClone(doc)
      const offset = at(rng.int(-8, 8), rng.int(-8, 8))
      const part = doc.objects[rng.int(0, Math.max(0, doc.objects.length - 1))]
      const ids = new Set(part ? [part.id] : [])
      const inspect = (kind: keyof typeof tally, after: Schematic, refused = false) => {
        tally[kind]++
        const bad = newCrossings(before, after)
        if (bad.length) failures.push(`${name} ${kind}: ${JSON.stringify(bad.slice(0, 2))}`)
        if (refused && after !== doc) failures.push(`${name} ${kind}: refusal changed the document`)
      }
      for (const detach of [false, true]) {
        const result = new PartDrag(doc, wiring, { objects: ids }, { detach }).landed(offset.x, offset.y, newId)
        inspect("drag", result.doc, !!result.refused)
      }
      if (doc.wires.length) {
        const segment = doc.wires[rng.int(0, doc.wires.length - 1)]
        const result = new SegmentDrag(doc, wiring, segment.id).landed(offset.x, offset.y, newId)
        inspect("segment", result.doc, !!result.refused)
      }
      for (const withWire of [false, true]) {
        const run = new TurnRun(doc, wiring, ids, undefined, withWire && doc.wires.length ? new Set([doc.wires[0].id]) : undefined)
        const result = run.turned(rng.chance(0.5) ? 1 : -1, newId)
        inspect("turn", result.doc, !!result.refused)
      }
      for (const axis of ["horizontal", "vertical"] as const) {
        const result = flippedWithWires(doc, wiring, ids, axis, newId)
        inspect("flip", result.doc, !!result.refused)
      }
      const point = part ? { x: part.x + 2 * GRID, y: part.y + GRID } : offset
      const clip = { objects: [{ id: "pasted", def: "resistor", ...point }], wires: [{ id: "pasted-wire", a: { x: point.x + 2 * GRID, y: point.y - 3 * GRID }, b: { x: point.x + 2 * GRID, y: point.y + 4 * GRID } }], parts: {} }
      inspect("paste", pastedInto(doc, clip, offset.x, offset.y, newId, newId))
      const pin = { x: point.x, y: point.y + GRID }
      const tail = { ...clip, wires: [{ id: "tail", a: { x: pin.x - 3 * GRID, y: pin.y }, b: pin }] }
      inspect("paste", pastedInto(doc, tail, offset.x, offset.y, newId, newId))
      const landing = pasteLanding({ objects: doc.objects, routes: wiring.routes, grid: GRID }, { ...clip, wires: [] }, offset)
      if (landing.clear) inspect("paste", pastedInto(doc, landing.clip, landing.at.x, landing.at.y, newId, newId))
      inspect("placement", placedObject(doc, { id: newId(), def: "resistor", ...point }, newId))
      const start = startDrawing(wiring, drawEndAt(wiring, { x: point.x + 2 * GRID, y: point.y - 3 * GRID }))
      if (!isRefusal(start)) {
        const end = drawEndAt(wiring, { x: point.x + 2 * GRID, y: point.y + 4 * GRID })
        const result = drawnTo(doc, wiring, pointerAt(start, end.at), end, newId)
        inspect("drawing", isRefusal(result) ? doc : result, isRefusal(result))
      }
      expect(doc, `${name}: source unchanged`).toEqual(snapshot)
    }
    expect(failures.slice(0, 20)).toEqual([])
    for (const [kind, count] of Object.entries(tally)) expect(count, kind).toBeGreaterThan(0)
  }, 20_000)
})
