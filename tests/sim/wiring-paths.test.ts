import { tiled } from "../../scripts/lib/stress"
import type { HdlNetlist } from "emul-shared/hdl"
import counter from "./hdl/counter.json"
import { getDef, setLibrary } from "@/schematic/registry"
import { commitEdit, normalise } from "@/schematic/wires/normal-form"
import { SpatialIndex } from "@/schematic/spatial"
import { checked, KeptChecker } from "@/schematic/checker"
import { FieldState } from "@/schematic/field-state"
import { placedFields, withFieldAt, withFieldMoved } from "@/schematic/fields"
import { documentPins, editedObjects, pinsOf } from "@/schematic/pin-index"
import { describe, expect, it, vi } from "vitest"
import { retainedAfterCommits } from "../lib/wiring-retention"
import * as segmentKeys from "@/schematic/wires/segment"
import { OverlayMap } from "@/schematic/wires/overlay-map"
import { runsOf, flowVertices } from "@/schematic/circuit"
import { turnsAtPins } from "@/schematic/wire-look"
import { circuitOf } from "@/schematic/circuit"
import { examples } from "@/schematic/examples"
import { GRID, objectPins, routeBox, touches, type Point } from "@/schematic/geometry"
import type { HdlModule, PlacedObject, Schematic } from "@/schematic/types"
import { clipOf, moved, placedObject, recoloured, removed, travellingWires, withModule, withSegments, wireOrder, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import { isRerouteRefusal, rerouted, routeBetween } from "@/schematic/wires/router"
import { flippedWithWires, PartDrag, SegmentDrag, TurnRun } from "@/schematic/rubber-band"
import { pastedInto } from "@/schematic/use-schematic"
import { lineCodeOf, WireSheet, type SheetMark } from "@/schematic/wires/sheet"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"
import type { FieldKey } from "@/schematic/fields"
import { sourceCallback } from "../lib/source-callback"
import { crossingNear, junctionAt } from "@/schematic/junction-tool"

function random(seed: number) {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] }
}

const points = (list: readonly Point[]) => list.map((p) => `${p.x},${p.y}`).sort()

function shape(w: Wiring) {
  const groupsOf = (entries: Iterable<readonly [string, string]>) => {
    const groups = new Map<string, string[]>()
    for (const [key, root] of entries) groups.set(root, [...(groups.get(root) ?? []), key])
    return [...groups.values()].map((g) => g.sort().join(" ")).sort()
  }
  return {
    runs: w.runs.map((r) => `${r.id}: ${r.points.map((p) => `${p.x},${p.y}`).join(" ")} [${r.segments.map((s) => s.id).join(" ")}]`),
    routes: w.routes.map((r) => JSON.stringify({ id: r.id, pts: r.pts, leads: r.leads ?? null })),
    bySegment: [...w.runBySegment].map(([id, run]) => `${id}>${run.id}`).sort(),
    nets: w.nets.nets.map((net) => [...w.nets.wiresOf(net)].sort().join(" ")).sort(),
    runNets: groupsOf(w.runs.map((r) => [r.id, w.nets.wiresOf(w.nets.netOfWire(r.id)!).join(" ")] as const)),
    contacts: groupsOf(w.nets.contacts),
    circuit: w.circuit,
    dots: points(w.dots),
    dangling: points(w.dangling),
    corners: w.corners.map((c) => JSON.stringify(c)).sort(),
  }
}

describe("the wiring kept up to date across edits is the wiring built afresh (design.md §11: the commit touches only what changed)", () => {
  it.each([true, false])("reordering wires preserves canonical flow with an early collection read of %s", (early) => {
    const before: Schematic = { objects: [], wires: [{ id: "b", a: { x: 0, y: 0 }, b: { x: 2 * GRID, y: 0 } }, { id: "a", a: { x: 0, y: 2 * GRID }, b: { x: 2 * GRID, y: 2 * GRID } }], parts: {} }
    const graph = new WireGraph()
    const first = wiringOf(graph, before)
    if (early) void first.circuit.flow
    const after = { ...before, wires: [...before.wires].reverse() }
    const second = wiringOf(graph, after)
    const third = wiringOf(graph, before)
    const original = first.circuit.flow
    for (const [doc, kept] of [[before, first], [after, second], [before, third]] as const) {
      const fresh = circuitOf(structuredClone(doc))
      expect.soft(kept.circuit.flow.runs.map((run) => run.id), "run identity determines flow order").toEqual(["a", "b"])
      expect.soft(kept.circuit, "kept equals independently fresh after a reorder").toEqual(fresh)
      expect.soft(kept.circuit.flow, "a harmless reorder reuses the flow collection").toBe(original)
    }
  })

  it.each(["metronome", "nucleo-74hc595", "system-exam", "power-supply"])("%s: forty random moves, translations, deletions and recolourings", (id) => {
    const rng = random(id.length * 7919)
    let doc: Schematic = { ...examples.find((e) => e.id === id)!.build(GRID) }
    const graph = new WireGraph()
    let known = wiringOf(graph, doc)
    let n = 0
    const newId = () => `e${n++}`
    for (let step = 0; step < 40; step++) {
      const action = rng.int(0, 5)
      const at = (ids: readonly string[]) => new Map(doc.objects.filter((o) => ids.includes(o.id)).map((o) => [o.id, { x: o.x, y: o.y }] as const))
      const d = () => rng.pick([-2, -1, 1, 2, 3]) * GRID
      if (action === 0) doc = moved(doc, at([rng.pick(doc.objects).id]), d(), d(), newId, known)
      else if (action === 1) doc = moved(doc, at(doc.objects.map((o) => o.id)), d(), d(), newId, known)
      else if (action === 2) doc = moved(doc, at(Array.from({ length: rng.int(2, 5) }, () => rng.pick(doc.objects).id)), d(), 0, newId, known)
      else if (action === 3 && doc.wires.length) doc = removed(doc, new Set(), new Set([rng.pick(doc.wires).id]), newId)
      else if (action === 4 && doc.objects.length > 5) doc = removed(doc, new Set([rng.pick(doc.objects).id]), new Set(), newId)
      else if (doc.wires.length) doc = recoloured(doc, [[rng.pick(doc.wires).id, rng.pick(["red", "blue", undefined] as const)]], newId)
      known = wiringOf(graph, doc)
      const fresh = wiringOf(new WireGraph(), doc)
      expect.soft(shape(known), `${id} step ${step} (action ${action})`).toEqual(shape(fresh))
      for (const size of [1, 2, 4]) {
        const carried = new Set(Array.from({ length: size }, () => rng.pick(doc.objects).id))
        expect.soft([...travellingWires(doc, carried, known)].sort(), `${id} step ${step}: the wires a move of ${size} parts carries, from the kept wiring`).toEqual([...travellingWires(doc, carried)].sort())
      }
      expect.soft(fresh.circuit, `${id} step ${step}: the store's circuit is the one the solver builds from the document`).toEqual(circuitOf(doc))
    }
  })
})

describe("the kept-up turns at pins are derived from the pins, not carried along (findings 3.L16)", () => {
  const buttedAtARightAngle = (): Schematic => {
    const a: PlacedObject = { id: "A", def: "resistor", x: 0, y: 0, props: { ref: "A" } }
    const probe: PlacedObject = { id: "C", def: "resistor", x: 0, y: 0, rotation: 90, props: { ref: "C" } }
    const meet = objectPins(a, GRID).find((p) => p.pin.id === "2")!.point
    const top = objectPins(probe, GRID).map((p) => p.point).sort((p, q) => p.y - q.y)[0]
    return { objects: [a, { ...probe, x: meet.x - top.x, y: meet.y - top.y }], wires: [], parts: {} }
  }
  const documents: [string, () => Schematic][] = [
    ...["system-exam", "nucleo-serial", "open746-touch"].map((id): [string, () => Schematic] => [id, () => ({ ...examples.find((e) => e.id === id)!.build(GRID) })]),
    ["two resistors butted at a right angle", buttedAtARightAngle],
  ]
  it.each(documents)("%s: a hundred and twenty moves of the whole sheet leave every lead and corner where a fresh derivation puts it", (id, build) => {
    const rng = random(id.length * 31 + 5)
    let doc: Schematic = build()
    const graph = new WireGraph()
    let known = wiringOf(graph, doc)
    const turns = (w: Wiring) => ({ leads: w.routes.flatMap((r) => (r.leads ? [`${r.id}: ${JSON.stringify(r.leads)}`] : [])), corners: w.corners.map((c) => JSON.stringify(c)).sort() })
    expect.soft(turns(known).leads.length + turns(known).corners.length, `${id}: turns to keep up`).toBeGreaterThan(0)
    for (let step = 0; step < 120; step++) {
      doc = moved(doc, new Map(doc.objects.map((o) => [o.id, { x: o.x, y: o.y }])), rng.int(-5, 5) * GRID || GRID, rng.int(-5, 5) * GRID, () => `t${step}`, known)
      known = wiringOf(graph, doc)
      expect.soft(turns(known), `${id} step ${step}`).toEqual(turns(wiringOf(new WireGraph(), doc)))
    }
  })
})

describe("routes read through the kept field are the routes a fresh field gives (design.md §7, §11; plan.md phase 6: the router reads the field's maintained indexes)", () => {
  it.each(["metronome", "nucleo-74hc595", "power-supply", "nucleo-serial"])("%s: after each of twenty kept moves, deletions and recolourings, routes between random pins and the re-route of a random run equal those of a fresh wiring", (id) => {
    const rng = random(id.length * 4057 + 11)
    let doc: Schematic = { ...examples.find((e) => e.id === id)!.build(GRID) }
    const graph = new WireGraph()
    let known = wiringOf(graph, doc)
    let n = 0
    const newId = () => `k${n++}`
    let routed = 0
    for (let step = 0; step < 20; step++) {
      const action = rng.int(0, 3)
      const at = (ids: readonly string[]) => new Map(doc.objects.filter((o) => ids.includes(o.id)).map((o) => [o.id, { x: o.x, y: o.y }] as const))
      const d = () => rng.pick([-2, -1, 1, 2]) * GRID
      if (action === 0) doc = moved(doc, at([rng.pick(doc.objects).id]), d(), d(), newId, known)
      else if (action === 1) doc = moved(doc, at(doc.objects.map((o) => o.id)), d(), d(), newId, known)
      else if (action === 2 && doc.wires.length > 4) doc = removed(doc, new Set(), new Set([rng.pick(doc.wires).id]), newId)
      else if (doc.wires.length) doc = recoloured(doc, [[rng.pick(doc.wires).id, rng.pick(["red", "blue", undefined] as const)]], newId)
      known = wiringOf(graph, doc)
      for (let k = 0; k < 3; k++) {
        const ends = [0, 1].map(() => {
          const pins = objectPins(rng.pick(doc.objects), GRID)
          const p = rng.pick(pins)
          return { pin: { object: p.key.slice(0, p.key.indexOf(":")), pin: p.pin.id } }
        })
        const kept = routeBetween(doc, ends[0], ends[1], known)
        if (kept) routed++
        expect.soft(kept, `${id} step ${step}: ${ends.map((e) => `${e.pin.object}:${e.pin.pin}`).join(" → ")}, kept against fresh`).toEqual(routeBetween(doc, ends[0], ends[1]))
      }
      if (!doc.wires.length) continue
      const segment = rng.pick(doc.wires).id
      let a = 0
      let b = 0
      const kept = rerouted(doc, segment, () => `r${a++}`, known)
      const fresh = rerouted(doc, segment, () => `r${b++}`)
      expect.soft(isRerouteRefusal(kept) ? kept : kept.wires, `${id} step ${step}: re-route of ${segment}, kept against fresh`).toEqual(isRerouteRefusal(fresh) ? fresh : fresh.wires)
    }
    expect.soft(routed, `${id}: some of the random pairs have a route`).toBeGreaterThan(0)
  })
})

function sheetShape(sheet: WireSheet, wires: readonly WireSegment[], pins: readonly WirePin[]) {
  const ids = (list: readonly WireSegment[]) => list.map((s) => s.id).sort().join(" ")
  const marks = (list: readonly SheetMark[]) => list.map((m) => `${m.at.x},${m.at.y}:${m.segment?.id ?? m.pin!.key}`).sort().join(" ")
  const out: string[] = []
  for (const s of wires) {
    const line = lineCodeOf(s)
    out.push(`${s.id} a[${ids(sheet.endsAt(s.a))}] b[${ids(sheet.endsAt(s.b))}] along[${ids(sheet.along(line, -1e9, 1e9))}] marks[${marks(sheet.marks(line, -1e9, 1e9))}] seg=${JSON.stringify(sheet.segment(s.id))}`)
  }
  for (const p of pins) out.push(`${p.key} at[${sheet.pinsAt(p.at).map((q) => q.key).sort().join(" ")}] through[${ids(sheet.through(p.at))}] pin=${JSON.stringify(sheet.pin(p.key))}`)
  return out.sort()
}

describe("the sheet index the rubber band reads is kept up by each commit's delta (design.md §11; kickoff: the sheet lives in the store beside the graph)", () => {
  it.each(["metronome", "nucleo-74hc595", "system-exam", "power-supply"])("%s: thirty random drags with wires, segment drags, deletions and recolourings leave a sheet equal to one built afresh, and the wiring equal to a fresh one", (id) => {
    const rng = random(id.length * 104729)
    let doc: Schematic = { ...examples.find((e) => e.id === id)!.build(GRID) }
    const graph = new WireGraph()
    let known = wiringOf(graph, doc)
    let n = 0
    const newId = () => `k${n++}`
    for (let step = 0; step < 30; step++) {
      const action = rng.int(0, 4)
      const d = () => rng.pick([-2, -1, 1, 2]) * GRID
      if (action === 0) doc = new PartDrag(doc, known, { objects: new Set([rng.pick(doc.objects).id]) }).landed(d(), d(), newId).doc
      else if (action === 1 && doc.wires.length) doc = new SegmentDrag(doc, known, rng.pick(doc.wires).id).landed(d(), d(), newId).doc
      else if (action === 2) doc = new PartDrag(doc, known, { objects: new Set([rng.pick(doc.objects).id]) }, { detach: true }).landed(d(), 0, newId).doc
      else if (action === 3 && doc.wires.length) doc = removed(doc, new Set(), new Set([rng.pick(doc.wires).id]), newId)
      else if (doc.wires.length) doc = recoloured(doc, [[rng.pick(doc.wires).id, rng.pick(["red", "blue", undefined] as const)]], newId)
      known = wiringOf(graph, doc)
      const fresh = wiringOf(new WireGraph(), doc)
      expect.soft(shape(known), `${id} step ${step} (action ${action}): the wiring`).toEqual(shape(fresh))
      expect.soft(sheetShape(known.sheet, doc.wires, known.pins), `${id} step ${step} (action ${action}): the sheet`).toEqual(sheetShape(WireSheet.of(doc.wires, known.pins), doc.wires, known.pins))
    }
  })

  it("a one-part commit on a large sheet takes the sheet's delta rather than building it again", () => {
    const doc: Schematic = { ...examples.find((e) => e.id === "system-exam")!.build(GRID) }
    const graph = new WireGraph()
    const before = wiringOf(graph, doc)
    const sheet = before.sheet
    const one = doc.objects.find((o) => o.def === "resistor")!
    const after = wiringOf(graph, moved(doc, new Map([[one.id, { x: one.x, y: one.y }]]), GRID, 0, () => "m", before))
    expect.soft(after.sheet, "the index built at the first drag, updated in place by the next commit").toBe(sheet)
  })
})

describe("phase 5's edits keep the store's wiring and sheet equal to fresh ones (design.md §11; plan.md phase 5: the commit's indexes checked kept-up against fresh)", () => {
  const line = (): Schematic => ({
    objects: [
      { id: "R1", def: "resistor", x: 0, y: 0, props: { ref: "R1" } },
      { id: "R2", def: "resistor", x: 16 * GRID, y: 0, props: { ref: "R2" } },
      { id: "R3", def: "resistor", x: 6 * GRID, y: 4 * GRID, props: { ref: "R3", value: "1 kΩ" } },
    ],
    wires: [{ id: "w", a: { x: 4 * GRID, y: GRID }, b: { x: 16 * GRID, y: GRID } }],
    parts: {},
  })

  it("a splice, then undo and redo through the same kept graph", () => {
    const before = line()
    const graph = new WireGraph()
    const known = wiringOf(graph, before)
    void known.sheet
    let n = 0
    const after = new PartDrag(before, known, { objects: new Set(["R3"]) }).landed(0, -4 * GRID, () => `s${n++}`).doc
    expect.soft(after.wires.length, "set up: the wire cut in two").toBe(2)
    for (const [name, doc] of [["after the splice", after], ["undone", before], ["redone", after]] as const) {
      const kept = wiringOf(graph, doc)
      const fresh = wiringOf(new WireGraph(), doc)
      expect.soft(shape(kept), `${name}: the wiring`).toEqual(shape(fresh))
      expect.soft(sheetShape(kept.sheet, doc.wires, kept.pins), `${name}: the sheet`).toEqual(sheetShape(WireSheet.of(doc.wires, kept.pins), doc.wires, kept.pins))
    }
  })

  it.each([true, false])("palette insertion with splice suppression %s stays fresh through undo and redo", (suppressSplice) => {
    const base = line()
    const before = { ...base, objects: base.objects.slice(0, 2) }
    const graph = new WireGraph()
    wiringOf(graph, before)
    const after = placedObject(before, { ...base.objects[2], y: 0 }, undefined, { suppressSplice })
    for (const doc of [after, before, after]) {
      const kept = wiringOf(graph, doc)
      const fresh = wiringOf(new WireGraph(), structuredClone(doc))
      expect.soft(shape(kept), "the inserted part's wiring").toEqual(shape(fresh))
      expect.soft(checked(doc, kept), "the inserted part's findings").toEqual(checked(structuredClone(doc)))
      expect.soft(sheetShape(kept.sheet, doc.wires, kept.pins), "the inserted part's sheet").toEqual(sheetShape(fresh.sheet, doc.wires, fresh.pins))
    }
  })

  it("a field moved through the store leaves the wiring as it was, kept and fresh through undo and redo", () => {
    const before = line()
    const graph = new WireGraph()
    const known = wiringOf(graph, before)
    let after = before
    const moveField = sourceCallback<(id: string, key: FieldKey, dx: number, dy: number) => void>("src/schematic/use-schematic.ts", "moveField", {
      documentPins, editedObjects, withFieldMoved, grid: GRID,
      setDoc: (fn: (d: Schematic) => Schematic) => { after = fn(after) },
    })
    moveField("R3", "ref", 3 * GRID, -GRID)
    const kept = wiringOf(graph, after)
    expect.soft(after.objects.find((o) => o.id === "R3")!.fieldAt, "set up: the field moved").toBeDefined()
    expect.soft(shape(kept), "the wiring, kept").toEqual(shape(wiringOf(new WireGraph(), after)))
    const electrical = (w: Wiring) => ({ ...shape(w), circuit: { nets: w.circuit.nets, wired: w.circuit.wired, flow: w.circuit.flow } })
    expect.soft(electrical(kept), "and the wiring, the nets and the flow unchanged by the move (the circuit carries the parts themselves, the moved field with them)").toEqual(electrical(known))
    const checker = new KeptChecker()
    for (const doc of [after, before, after]) {
      const current = wiringOf(graph, doc)
      const fresh = wiringOf(new WireGraph(), structuredClone(doc))
      expect.soft(shape(current), "the store's field edit through history").toEqual(shape(fresh))
      expect.soft(checker.update(doc, current), "the moved field's findings through history").toEqual(checked(structuredClone(doc)))
      expect.soft(sheetShape(current.sheet, doc.wires, current.pins), "the field edit's sheet through history").toEqual(sheetShape(fresh.sheet, doc.wires, fresh.pins))
    }
  })
})

describe("the maintained field commit has the same findings and queries as a fresh field", () => {
  it.each([0, 65])("a field crossing two wire buckets stays exactly fresh after translation and local edits, with %s distant marks", (count) => {
    const at = (x: number, y: number) => ({ x: x * GRID, y: y * GRID })
    const label = withFieldAt({ id: "R1", def: "resistor", ...at(100, 100), props: { ref: "R1234567890", value: "" } }, "ref", at(-0.5, 0), GRID, getDef("resistor")!)
    const before: Schematic = { objects: [label, ...Array.from({ length: count }, (_, i) => ({ id: `mark${i}`, def: "junction", ...at(200 + i * 4, 0) }))], wires: [{ id: "right", a: at(0, -1), b: at(0, 1) }, { id: "left", a: at(-1, -1), b: at(-1, 1) }], parts: {} }
    const graph = new WireGraph()
    const checker = new KeptChecker()
    const known = wiringOf(graph, before)
    checker.update(before, known)
    const after = moved(before, new Map(before.objects.map((o) => [o.id, { x: o.x, y: o.y }])), 2 * GRID, 0, undefined, known)
    const edited = { ...after, objects: editedObjects(after.objects, after.objects.map((o) => o.id === label.id ? withFieldMoved(o, "ref", 0, GRID / 2, GRID) : o), [label.id]) }
    for (const doc of [after, edited, after, before, after]) {
      expect.soft(checker.update(doc, wiringOf(graph, doc)), "canonical findings survive bucket changes, undo and redo").toEqual(checked(structuredClone(doc)))
    }
  })

  it("board field findings stay fresh when a label enters the housing and the edit is undone", () => {
    const label: PlacedObject = { id: "R1", def: "resistor", x: 100 * GRID, y: 100 * GRID, props: { ref: "I", value: "" } }
    const before: Schematic = { objects: [{ id: "B", def: "open746i-c", x: 0, y: 0 }, label, ...Array.from({ length: 65 }, (_, i) => ({ id: `mark${i}`, def: "junction", x: (200 + i * 4) * GRID, y: 0 }))], wires: [], parts: {} }
    const after = { ...before, objects: editedObjects(before.objects, before.objects.map((o) => o === label ? withFieldAt(o, "ref", { x: 36.5 * GRID, y: 26.5 * GRID }, GRID, getDef(o.def)!) : o), [label.id]) }
    const graph = new WireGraph()
    const checker = new KeptChecker()
    for (const doc of [before, after, before, after]) {
      expect.soft(checker.update(doc, wiringOf(graph, doc)), "field collisions include the board").toEqual(checked(structuredClone(doc)))
    }
  })

  it("circular body collisions stay fresh across a field edit, undo and redo", () => {
    const label: PlacedObject = { id: "R1", def: "resistor", x: 100 * GRID, y: 100 * GRID, props: { ref: "I", value: "" } }
    const before: Schematic = { objects: [{ id: "V1", def: "voltmeter", x: 0, y: 0 }, label, ...Array.from({ length: 65 }, (_, i) => ({ id: `mark${i}`, def: "junction", x: (200 + i * 4) * GRID, y: 0 }))], wires: [{ id: "cross", a: { x: 1.5 * GRID, y: 1.5 * GRID }, b: { x: 1.5 * GRID, y: 3 * GRID } }], parts: {} }
    const after = { ...before, objects: editedObjects(before.objects, before.objects.map((o) => o === label ? withFieldAt(o, "ref", { x: 1.5 * GRID, y: 1.5 * GRID }, GRID, getDef(o.def)!) : o), [label.id]) }
    const graph = new WireGraph()
    const checker = new KeptChecker()
    for (const doc of [before, after, before, after]) {
      const kept = wiringOf(graph, doc)
      expect.soft(checker.update(doc, kept), "wire and field collisions with the circle").toEqual(checked(structuredClone(doc)))
    }
  })

  it("editing an interior pin's wire keeps directional body findings fresh through undo and redo", () => {
    const at = (x: number, y: number) => ({ x: x * GRID, y: y * GRID })
    const before: Schematic = { objects: [{ id: "U1", def: "opamp-generic", x: 0, y: 0 }, ...Array.from({ length: 65 }, (_, i) => ({ id: `mark${i}`, def: "junction", x: (100 + i * 4) * GRID, y: 0 }))], wires: [{ id: "out", a: at(5, 3), b: at(8, 3) }], parts: {} }
    const graph = new WireGraph()
    const checker = new KeptChecker()
    checker.update(before, wiringOf(graph, before))
    const after = withSegments(before, [{ ...before.wires[0], b: at(0, 3) }], before.wires)
    for (const doc of [after, before, after]) {
      const kept = wiringOf(graph, doc)
      expect.soft(checker.update(doc, kept), "the directional exit after each edit").toEqual(checked(structuredClone(doc)))
    }
  })

  it.each(["metronome", "nucleo-74hc595", "system-exam", "power-supply", "power-supply-tiled"])("%s: moves, splices, field moves, removal, undo and redo", (id) => {
    const rng = random(id.length * 73)
    const graph = new WireGraph()
    const checker = new KeptChecker()
    const field = new FieldState()
    let doc = id === "power-supply-tiled" ? tiled(examples.find((e) => e.id === "power-supply")!.build(GRID), 9) : examples.find((e) => e.id === id)!.build(GRID)
    let known = wiringOf(graph, doc)
    let serial = 0
    const newId = () => `check${serial++}`
    for (let step = 0; step < 32; step++) {
      const before = doc
      const object = rng.pick(doc.objects)
      const action = step % 5
      if (action === 0) doc = new PartDrag(doc, known, { objects: new Set([object.id]) }).landed(GRID, GRID, newId).doc
      else if (action === 1) doc = { ...doc, objects: doc.objects.map((o) => o === object ? withFieldMoved(o, "ref", -3 * GRID, GRID, GRID) : o) }
      else if (action === 2 && doc.wires.length) doc = removed(doc, new Set(), new Set([rng.pick(doc.wires).id]), newId)
      else if (action === 3) doc = moved(doc, new Map([[object.id, { x: object.x, y: object.y }]]), GRID, -GRID, newId, known)
      else doc = moved(doc, new Map(doc.objects.map((o) => [o.id, { x: o.x, y: o.y }])), GRID, GRID, newId, known)
      const after = doc
      for (const current of [after, before, after]) {
        known = wiringOf(graph, current)
        const actual = checker.update(current, known)
        expect.soft(actual, `${id} ${step}: the checker`).toEqual(checked(current))
        const committed = field.commit(current, known)
        expect.soft(committed.findings, `${id} ${step}: the field uses the maintained checker`).toEqual(actual)
        const view = { x: 0, y: 0, w: 30 * GRID, h: 30 * GRID }
        expect.soft(committed.visible(view).routes.map((r) => r.id), `${id} ${step}: the route index`).toEqual(known.routes.filter((r) => touches(routeBox(r), view)).map((r) => r.id))
        const fresh = documentPins([...current.objects])
        for (const o of current.objects.slice(0, 3)) {
          const box = { x: o.x - GRID, y: o.y - GRID, w: 12 * GRID, h: 12 * GRID }
          expect.soft(known.index.within(box).map((p) => p.key).sort(), `${id} ${step}: local pin query`).toEqual(fresh.within(box).map((p) => p.key).sort())
          for (const p of objectPins(o, GRID).slice(0, 4)) for (const line of [{ x: p.point.x - 40 * GRID, y: p.point.y, w: 80 * GRID, h: 0 }, { x: p.point.x, y: p.point.y - 40 * GRID, w: 0, h: 80 * GRID }, { ...p.point, w: 0, h: 0 }])
            expect.soft(known.index.within(line).map((q) => q.key), `${id} ${step}: pins on a line through ${p.key}`).toEqual(fresh.within(line).map((q) => q.key))
        }
      }
    }
  })
})

function slantShape(sheet: WireSheet, wires: readonly WireSegment[], pins: readonly WirePin[]) {
  const ids = (list: readonly WireSegment[]) => list.map((s) => s.id).sort().join(" ")
  const marks = (list: readonly SheetMark[]) => list.map((m) => `${m.at.x},${m.at.y}:${m.segment?.id ?? m.pin!.key}`).sort().join(" ")
  const out: string[] = []
  for (const s of wires) {
    const steps = segmentKeys.latticePointsInside(s)
    out.push(`${s.id} along[${ids(sheet.alongSegment(s))}] marks[${marks(sheet.marksOn(s))}] through[${steps.map((p) => ids(sheet.through(p))).join("|")}] a[${ids(sheet.through(s.a))}] b[${ids(sheet.through(s.b))}]`)
  }
  for (const p of pins) out.push(`${p.key} through[${ids(sheet.through(p.at))}] near[${ids(sheet.within(p.at, GRID))}]`)
  return out.sort()
}

describe("diagonals on the kept wiring and sheet (design.md §6.11 rules 3–9, §11: kept equals fresh at any angle, and the local commit equals the global one)", () => {
  it.each(["metronome", "logic", "power-supply"])("%s: thirty edits laying, dragging, joining, recolouring and deleting diagonals leave the wiring and the sheet equal to fresh ones", (id) => {
    const rng = random(id.length * 7121)
    let doc: Schematic = { ...examples.find((e) => e.id === id)!.build(GRID) }
    const graph = new WireGraph()
    let known = wiringOf(graph, doc)
    let n = 0
    const newId = () => `q${n++}`
    const slopes = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: -1 }, { x: 3, y: -2 }, { x: 1, y: 2 }]
    const slanted = () => doc.wires.filter((s) => s.a.x !== s.b.x && s.a.y !== s.b.y)
    let laid = 0
    for (let step = 0; step < 30; step++) {
      const action = step < 6 || step % 2 === 0 ? 0 : rng.int(0, 6)
      const d = () => rng.pick([-2, -1, 1, 2]) * GRID
      if (action === 0) {
        const existing = slanted()
        const on = existing.length && rng.next() < 0.7 ? rng.pick(existing) : null
        const inside = on ? segmentKeys.latticePointsInside(on) : []
        const from = on ? rng.pick([on.a, on.b, ...inside]) : rng.pick(doc.wires.flatMap((s) => [s.a, s.b]))
        const own = on ? segmentKeys.slopeOf(on) : null
        const slope = own && rng.next() < 0.4 ? { x: own.run, y: own.rise } : rng.pick([...slopes, { x: 1, y: 0 }, { x: 0, y: 1 }])
        const k = rng.int(1, 4) * (rng.next() < 0.5 ? 1 : -1) * segmentKeys.HALF_CELL
        const add = [{ id: `diag${step}`, a: from, b: { x: from.x + slope.x * k, y: from.y + slope.y * k } }]
        let a = 0
        let b = 0
        const expected = commitEdit(doc.wires, pinsOf(doc.objects), { add, points: [add[0].a, add[0].b] }, () => `g${step}_${a++}`)
        doc = withSegments(doc, add, [], [add[0].a, add[0].b], () => `g${step}_${b++}`)
        expect.soft(doc.wires, `${id} step ${step}: the local commit lays the diagonal as the global normaliser does`).toEqual(expected.wires)
        laid++
      } else if (action === 1) doc = new PartDrag(doc, known, { objects: new Set([rng.pick(doc.objects).id]) }).landed(d(), d(), newId).doc
      else if (action === 2 && slanted().length) doc = new SegmentDrag(doc, known, rng.pick(slanted()).id).landed(d(), d(), newId).doc
      else if (action === 3 && slanted().length) doc = removed(doc, new Set(), new Set([rng.pick(slanted()).id]), newId)
      else if (action === 4 && slanted().length) doc = recoloured(doc, [[rng.pick(slanted()).id, rng.pick(["red", "blue", undefined] as const)]], newId)
      else if (action === 5 && slanted().length) {
        const s = rng.pick(slanted())
        const crossing = crossingNear(known, { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }, Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) / 2)
        const joined = crossing ? junctionAt(doc, known, crossing.at, newId) : null
        if (joined && !("refused" in joined)) doc = joined
      } else doc = moved(doc, new Map(doc.objects.map((o) => [o.id, { x: o.x, y: o.y }])), GRID, -GRID, newId, known)
      known = wiringOf(graph, doc)
      const fresh = wiringOf(new WireGraph(), doc)
      expect.soft(shape(known), `${id} step ${step} (action ${action}): the wiring`).toEqual(shape(fresh))
      expect.soft(slantShape(known.sheet, doc.wires, known.pins), `${id} step ${step} (action ${action}): the sheet at any angle`).toEqual(slantShape(WireSheet.of(doc.wires, known.pins), doc.wires, known.pins))
      expect.soft(fresh.circuit, `${id} step ${step}: the store's circuit is the one the solver builds`).toEqual(circuitOf(doc))
    }
    expect.soft(laid, "diagonals were laid").toBeGreaterThan(5)
    expect.soft(slanted().length, "and some are still there at the end").toBeGreaterThan(0)
  })

  it.each(["metronome", "logic", "power-supply", "bridge"])("%s: turns, mirrors, pastes, deletes, undos and redos around diagonals leave the wiring and the sheet equal to fresh ones", (id) => {
    const rng = random(id.length * 911)
    let doc: Schematic = { ...examples.find((e) => e.id === id)!.build(GRID) }
    const graph = new WireGraph()
    let known = wiringOf(graph, doc)
    let n = 0
    const newId = () => `r${n++}`
    const history: Schematic[] = [doc]
    let cursor = 0
    const done = new Set<string>()
    const slopes = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: -1 }, { x: 3, y: -2 }, { x: 1, y: 2 }]
    const slanted = () => doc.wires.filter((s) => s.a.x !== s.b.x && s.a.y !== s.b.y)
    for (let step = 0; step < 40; step++) {
      const kind = step < 6 || step % 3 === 0 ? "lay" : rng.pick(["turn", "mirror", "paste", "delete", "undo", "redo"] as const)
      let next: Schematic | null = null
      if (kind === "lay") {
        const on = slanted().length && rng.next() < 0.6 ? rng.pick(slanted()) : null
        const from = on ? rng.pick([on.a, on.b, ...segmentKeys.latticePointsInside(on)]) : rng.pick(doc.wires.flatMap((s) => [s.a, s.b]))
        const slope = rng.pick(slopes)
        const k = rng.int(1, 4) * (rng.next() < 0.5 ? 1 : -1) * segmentKeys.HALF_CELL
        const add = [{ id: `diag${step}`, a: from, b: { x: from.x + slope.x * k, y: from.y + slope.y * k } }]
        next = withSegments(doc, add, [], [add[0].a, add[0].b], newId)
      } else if (kind === "turn") {
        const parts = new Set(rng.next() < 0.5 ? [rng.pick(doc.objects).id] : doc.objects.slice(0, 3).map((o) => o.id))
        next = new TurnRun(doc, known, parts, undefined, new Set(rng.next() < 0.5 ? slanted().slice(0, 2).map((s) => s.id) : [])).turned(rng.next() < 0.5 ? 1 : -1, newId).doc
      } else if (kind === "mirror") {
        next = flippedWithWires(doc, known, new Set([rng.pick(doc.objects).id]), rng.next() < 0.5 ? "horizontal" : "vertical", newId, undefined, new Set(rng.next() < 0.5 ? slanted().slice(0, 1).map((s) => s.id) : [])).doc
      } else if (kind === "paste") {
        const clip = clipOf(doc, new Set(doc.objects.slice(0, 2).map((o) => o.id)))
        if (clip) next = pastedInto(doc, clip, 0, 40 * GRID, (old) => `p${step}-${old}`, newId)
      } else if (kind === "delete" && slanted().length) next = removed(doc, new Set(), new Set([rng.pick(slanted()).id]), newId)
      else if (kind === "undo" && cursor > 0) doc = history[(cursor = Math.max(0, cursor - rng.int(1, 3)))]
      else if (kind === "redo" && cursor < history.length - 1) doc = history[++cursor]
      if (next) {
        doc = next
        history.length = cursor + 1
        history.push(doc)
        cursor++
      }
      if (doc.wires !== known.source.wires) done.add(kind)
      known = wiringOf(graph, doc)
      const fresh = wiringOf(new WireGraph(), doc)
      expect.soft(shape(known), `${id} step ${step} (${kind}): the wiring`).toEqual(shape(fresh))
      expect.soft(slantShape(known.sheet, doc.wires, known.pins), `${id} step ${step} (${kind}): the sheet at any angle`).toEqual(slantShape(WireSheet.of(doc.wires, known.pins), doc.wires, known.pins))
    }
    expect.soft([...done].sort(), "set up: the wires changed by laying, turning, mirroring, pasting or deleting, and by an undo").toEqual(expect.arrayContaining(["lay", "undo"]))
    expect.soft(done.size, "and by at least four kinds of edit").toBeGreaterThanOrEqual(4)
    expect.soft(slanted().length, "diagonals present at the end").toBeGreaterThan(0)
  })
})

describe("local commit indexes preserve the document and the gesture's starting state", () => {
  it.each(["system-exam", "power-supply", "nucleo-74hc595"])("%s: the indexed normaliser produces the same segments as the full normaliser", (id) => {
    const rng = random(id.length * 407)
    let doc = examples.find((e) => e.id === id)!.build(GRID)
    const graph = new WireGraph()
    for (let step = 0; step < 30; step++) {
      wiringOf(graph, doc)
      const remove = doc.wires.length && step % 3 === 0 ? [rng.pick(doc.wires)] : []
      const at = rng.pick(doc.objects)
      const add = step % 3 === 1 ? [{ id: `added${step}`, a: { x: at.x, y: at.y }, b: { x: at.x + 5 * GRID, y: at.y } }] : []
      const points = objectPins(at, GRID).map((p) => p.point)
      let a = 0
      let b = 0
      const expected = commitEdit(doc.wires, pinsOf(doc.objects), { add, remove, points }, () => `normal${step}_${a++}`)
      const next = withSegments(doc, add, remove, points, () => `normal${step}_${b++}`)
      expect.soft(next.wires, `${id} ${step}`).toEqual(expected.wires)
      const order = wireOrder(next.wires)
      expect.soft([...next.wires].sort((a, b) => order.get(a)! - order.get(b)!), `${id} ${step}: the maintained wire order`).toEqual(next.wires)
      doc = next
    }
  })

  it("empty board sockets stay available without becoming graph vertices, then a touching pin and wire join them", () => {
    const board: PlacedObject = { id: "B", def: "open746i-c", x: 0, y: 0 }
    const anchor: PlacedObject = { id: "anchor", def: "resistor", x: -100 * GRID, y: -100 * GRID }
    const before: Schematic = { objects: [board, anchor], wires: [], parts: {} }
    const graph = new WireGraph()
    const loaded = wiringOf(graph, before)
    expect.soft(loaded.activePins, "isolated pins have no graph vertices").toHaveLength(0)
    expect.soft(loaded.pins).toEqual(pinsOf(before.objects))
    const socket = loaded.pins.find((p) => p.key.startsWith("B:"))!
    expect.soft(loaded.view.pin(socket.key)).toEqual(socket)
    expect.soft(loaded.sheet.pin(socket.key)).toEqual(socket)
    const after = withSegments(before, [{ id: "plug", a: socket.at, b: { x: socket.at.x - 3 * GRID, y: socket.at.y } }])
    const live = wiringOf(graph, after)
    expect.soft(live.activePins.some((p) => p.key === socket.key)).toBe(true)
    expect.soft(shape(live)).toEqual(shape(wiringOf(new WireGraph(), after)))
    expect.soft(live.circuit).toEqual(circuitOf(after))
  })

  it("a spatial edit leaves the old index readable and the new index equal to a fresh one, including a very long query", () => {
    const objects: PlacedObject[] = Array.from({ length: 20 }, (_, i) => ({ id: `R${i}`, def: "resistor", x: i * 50 * GRID, y: i * 4 * GRID }))
    const before = documentPins(objects)
    const next = editedObjects(objects, objects.map((o, i) => i === 3 ? { ...o, x: -100 * GRID } : o))
    const after = documentPins(next)
    const fresh = new SpatialIndex(next, GRID)
    for (const box of [{ x: -110 * GRID, y: 0, w: 40 * GRID, h: 20 * GRID }, { x: -1e9, y: 0, w: 2e9, h: GRID }]) {
      const ids = (list: readonly PlacedObject[]) => list.map((o) => o.id).sort()
      expect.soft(ids(after.spatial.query(box))).toEqual(ids(fresh.query(box)))
      expect.soft(ids(before.spatial.query(box))).toEqual(ids(new SpatialIndex(objects, GRID).query(box)))
    }
  })

  it("a run of turns keeps its starting graph and sheet after the store takes each press", () => {
    const before = examples.find((e) => e.id === "system-exam")!.build(GRID)
    const graph = new WireGraph()
    const loaded = wiringOf(graph, before)
    const part = before.objects.find((o) => o.def === "resistor")!
    const ids = new Set([part.id])
    const run = new TurnRun(before, loaded, ids, loaded.index.spatial)
    let serial = 0
    const newId = () => `turn${serial++}`
    let previous = before
    for (let press = 1; press <= 6; press++) {
      const next = run.turned(1, newId).doc
      expect.soft(next, `press ${press} changes the document`).not.toBe(previous)
      const live = wiringOf(graph, next)
      expect.soft(shape(live), `press ${press}`).toEqual(shape(wiringOf(new WireGraph(), next)))
      expect.soft(live.circuit).toEqual(circuitOf(next))
      previous = next
    }
  })
})

it("a snapshot of the sheet keeps answering for its own wiring at any angle after the live sheet takes a delta on the same slanted lines (the turn run's starting sheet, design.md §6.6, §6.11 rule 9)", () => {
  const c = (x: number, y: number) => ({ x: x * GRID, y: y * GRID })
  const pins: WirePin[] = [{ key: "R1:2", at: c(4, 1) }, { key: "R2:1", at: c(10, 5) }]
  const before: WireSegment[] = [{ id: "d", a: c(4, 1), b: c(10, 5) }, { id: "far", a: c(16, 9), b: c(22, 13) }, { id: "x", a: c(4, 5), b: c(10, 1) }]
  const live = WireSheet.of(before, pins)
  const kept = live.snapshot()
  const stretched: WireSegment = { id: "d2", a: c(4, 1), b: c(13, 7) }
  live.apply({ removed: [before[0], before[2]], added: [stretched, { id: "x2", a: c(4, 5), b: c(13, 3) }] })
  const after = [stretched, before[1], { id: "x2", a: c(4, 5), b: c(13, 3) }]
  expect.soft(slantShape(kept, before, pins), "the snapshot answers as a fresh sheet of the wires it was taken from").toEqual(slantShape(WireSheet.of(before, pins), before, pins))
  expect.soft(slantShape(live, after, pins), "the live sheet answers as a fresh sheet of the wires after the delta").toEqual(slantShape(WireSheet.of(after, pins), after, pins))
})

it("the sheet shifted with the whole drawing then edited locally still answers as a fresh sheet", () => {
  let doc = examples.find((e) => e.id === "system-exam")!.build(GRID)
  const graph = new WireGraph()
  let known = wiringOf(graph, doc)
  const sheet = known.sheet
  let serial = 0
  const newId = () => `shift${serial++}`
  for (let i = 0; i < 12; i++) {
    doc = moved(doc, new Map(doc.objects.map((o) => [o.id, { x: o.x, y: o.y }])), GRID, -GRID, newId, known)
    known = wiringOf(graph, doc)
    expect.soft(known.sheet).toBe(sheet)
    expect.soft(sheetShape(known.sheet, doc.wires, known.pins)).toEqual(sheetShape(WireSheet.of(doc.wires, known.pins), doc.wires, known.pins))
    const part = doc.objects.find((o) => o.def === "resistor")!
    doc = new PartDrag(doc, known, { objects: new Set([part.id]) }).landed(GRID, GRID, newId).doc
    known = wiringOf(graph, doc)
    expect.soft(sheetShape(known.sheet, doc.wires, known.pins)).toEqual(sheetShape(WireSheet.of(doc.wires, known.pins), doc.wires, known.pins))
  }
})

it("a normalisation point on an empty line keeps the document it was given", () => {
  const doc = examples.find((e) => e.id === "system-exam")!.build(GRID)
  wiringOf(new WireGraph(), doc)
  expect(withSegments(doc, [], [], [{ x: -1000 * GRID, y: -1000 * GRID }])).toBe(doc)
})

it.each(examples)("$id: loading keeps the document and the solver's complete circuit", (example) => {
  const doc = example.build(GRID)
  const before = structuredClone(doc)
  const wiring = wiringOf(new WireGraph(), doc)
  expect.soft(wiring.circuit).toEqual(circuitOf(doc))
  expect.soft(doc).toEqual(before)
})

it("a whole translation followed by a wire edit before the store takes it keeps the socket and the findings", () => {
  const doc: Schematic = {
    objects: [{ id: "B", def: "open746i-c", x: 0, y: 0 }, { id: "anchor", def: "resistor", x: -100 * GRID, y: -100 * GRID }],
    wires: [],
    parts: {},
  }
  const graph = new WireGraph()
  const state = new FieldState()
  const before = wiringOf(graph, doc)
  state.commit(doc, before)
  const translated = moved(doc, new Map(doc.objects.map((o) => [o.id, { x: o.x, y: o.y }])), GRID, GRID, undefined, before)
  const socket = objectPins(translated.objects[0], GRID)[0].point
  const next = withSegments(translated, [{ id: "plug", a: socket, b: { x: socket.x - 3 * GRID, y: socket.y } }])
  const live = wiringOf(graph, next)
  expect.soft(live.circuit).toEqual(circuitOf(next))
  expect.soft(shape(live)).toEqual(shape(wiringOf(new WireGraph(), next)))
  expect.soft(state.commit(next, live).findings).toEqual(checked(next))
})

it("a local split keeps the untouched wire's order and the old snapshot", () => {
  const doc: Schematic = { objects: [], wires: Array.from({ length: 256 }, (_, i) => ({ id: `rail${i}`, a: { x: 0, y: i * 3 * GRID }, b: { x: 4 * GRID, y: i * 3 * GRID } })), parts: {} }
  wiringOf(new WireGraph(), doc)
  const order = wireOrder(doc.wires)
  const branch: WireSegment = { id: "branch", a: { x: GRID, y: 0 }, b: { x: GRID, y: -GRID } }
  const after = withSegments(doc, [branch])
  const next = wireOrder(after.wires)
  expect.soft(after.wires.length).toBe(doc.wires.length + 2)
  expect.soft(next.get(doc.wires.at(-1)!)).toBe(order.get(doc.wires.at(-1)!))
  expect.soft([...after.wires].sort((a, b) => next.get(a)! - next.get(b)!)).toEqual(after.wires)
  expect.soft(order.has(branch)).toBe(false)
})

it("an actual splice, a field on its wire, undo and redo keep positive and negative checker findings", () => {
  const r1: PlacedObject = { id: "R1", def: "resistor", x: 0, y: 0, props: { ref: "R1" } }
  const r2: PlacedObject = { id: "R2", def: "resistor", x: 16 * GRID, y: 0, props: { ref: "R2" } }
  const r3: PlacedObject = { id: "R3", def: "resistor", x: 10 * GRID, y: -8 * GRID, props: { ref: "R3" } }
  const fillers: PlacedObject[] = Array.from({ length: 70 }, (_, i) => ({ id: `far${i}`, def: "resistor", x: (100 + i * 10) * GRID, y: 100 * GRID }))
  const before: Schematic = { objects: [r1, r2, r3, ...fillers], wires: [{ id: "bridge", a: { x: 4 * GRID, y: GRID }, b: { x: 16 * GRID, y: GRID } }], parts: {} }
  const graph = new WireGraph()
  const field = new FieldState()
  let known = wiringOf(graph, before)
  expect.soft(field.commit(before, known).findings.some((f) => f.kind === "unconnected-pin")).toBe(true)
  const spliced = new PartDrag(before, known, { objects: new Set([r3.id]) }, { index: known.index.spatial }).landed(0, 8 * GRID).doc
  expect.soft(spliced.wires).toHaveLength(2)
  const ref = placedFields(r1, GRID).find((f) => f.key === "ref")!
  const movedField = withFieldMoved(r1, "ref", 7 * GRID - ref.at.x, GRID - ref.at.y, GRID)
  const annotated = { ...spliced, objects: spliced.objects.map((o) => o.id === r1.id ? movedField : o) }
  expect.soft(checked(annotated).some((f) => f.kind === "field-on-wire")).toBe(true)
  expect.soft(checked(spliced).some((f) => f.kind === "field-on-wire")).toBe(false)
  for (const doc of [spliced, annotated, before, annotated, spliced]) {
    known = wiringOf(graph, doc)
    expect.soft(field.commit(doc, known).findings).toEqual(checked(doc))
    expect.soft(known.circuit).toEqual(circuitOf(doc))
  }
})

it("circuits first read after later commits still describe their own documents", () => {
  let doc = tiled(examples.find((e) => e.id === "power-supply")!.build(GRID), 9)
  const graph = new WireGraph()
  let known = wiringOf(graph, doc)
  const saved: { doc: Schematic; circuit: Wiring["circuit"] }[] = [{ doc, circuit: known.circuit }]
  for (let i = 0; i < 40; i++) {
    const moving = i % 3 ? doc.objects.slice(0, 1) : doc.objects
    doc = moved(doc, new Map(moving.map((o) => [o.id, { x: o.x, y: o.y }])), i % 2 ? GRID : -GRID, GRID, undefined, known)
    known = wiringOf(graph, doc)
    if (i % 5 === 0) saved.push({ doc, circuit: known.circuit })
  }
  for (const { doc, circuit } of saved) expect.soft(circuit).toEqual(circuitOf(doc))
})

it("a changed HDL definition refreshes pin and checker indexes before the next local edit", () => {
  const narrow: HdlModule = { id: "hdl:cache-counter", name: "counter", files: [], netlist: counter as unknown as HdlNetlist, built: "narrow" }
  const wide = { ...narrow, name: "wide_counter_".repeat(18), built: "wide" }
  try {
    setLibrary([wide])
    const width = getDef(wide.id)!.width * GRID
    const moving: PlacedObject = { id: "R", def: "resistor", x: width - 8 * GRID, y: 20 * GRID, props: { ref: "R" } }
    const fillers: PlacedObject[] = Array.from({ length: 70 }, (_, i) => ({ id: `far${i}`, def: "resistor", x: (100 + i * 10) * GRID, y: 100 * GRID }))
    const doc: Schematic = { objects: [{ id: "U", def: narrow.id, x: 0, y: 0, props: { ref: "U" } }, moving, ...fillers], wires: [{ id: "plug", a: { x: width / 2, y: -4 * GRID }, b: { x: width / 2, y: 0 } }], parts: {}, library: [narrow] }
    setLibrary([narrow])
    const graph = new WireGraph()
    const field = new FieldState()
    field.commit(doc, wiringOf(graph, doc))
    const updated = withModule(doc, wide)
    setLibrary([wide])
    let known = wiringOf(graph, updated)
    expect.soft(known.circuit.wired).toContain("U:VCC")
    expect.soft(known.circuit).toEqual(circuitOf(updated))
    expect.soft(field.commit(updated, known).findings).toEqual(checked(updated))
    const after = moved(updated, new Map([[moving.id, { x: moving.x, y: moving.y }]]), 0, -18 * GRID, undefined, known)
    known = wiringOf(graph, after)
    expect.soft(checked(after).some((f) => f.kind === "field-on-body" && f.objects.includes("U"))).toBe(true)
    expect.soft(field.commit(after, known).findings).toEqual(checked(after))
  } finally {
    setLibrary([])
  }
})

it("undoing a whole translation restores endpoint counts before a field-only edit", () => {
  const r1: PlacedObject = { id: "R1", def: "resistor", x: 0, y: 0, props: { ref: "R1" } }
  const r2: PlacedObject = { id: "R2", def: "resistor", x: 12 * GRID, y: 0, props: { ref: "R2" } }
  const before: Schematic = { objects: [r1, r2, { id: "anchor", def: "resistor", x: 100 * GRID, y: 100 * GRID }], wires: [{ id: "wire", a: { x: 4 * GRID, y: GRID }, b: { x: 12 * GRID, y: GRID } }], parts: {} }
  const graph = new WireGraph()
  const known = wiringOf(graph, before)
  const after = moved(before, new Map(before.objects.map((o) => [o.id, { x: o.x, y: o.y }])), 50 * GRID, 50 * GRID, undefined, known)
  wiringOf(graph, after)
  const undo = wiringOf(graph, before)
  expect.soft(undo.circuit).toEqual(circuitOf(before))
  const objects = editedObjects(before.objects, before.objects.map((o) => o === r1 ? withFieldMoved(r1, "ref", GRID, GRID, GRID) : o), [r1.id])
  const annotated = { ...before, objects }
  const current = wiringOf(graph, annotated)
  expect.soft(current.circuit).toEqual(circuitOf(annotated))
  expect.soft(current.circuit.wired).toEqual(["R1:2", "R2:1"])
})

it("a pin with three wires on it gives the kept checker what a fresh one gives when it looks again around an edit on one of the wires", () => {
  const corner = 300 * GRID
  const part: PlacedObject = { id: "hub-resistor", def: "resistor", x: corner, y: corner, props: { ref: "R90" } }
  const hub = { x: corner + 4 * GRID, y: corner + GRID }
  const spoke = (id: string, x: number, y: number): WireSegment => ({ id, a: hub, b: { x: hub.x + x * GRID, y: hub.y + y * GRID } })
  const base = tiled(examples.find((e) => e.id === "power-supply")!.build(GRID), 9)
  const doc: Schematic = { ...base, objects: [...base.objects, part], wires: [...base.wires, spoke("east", 4, 0), spoke("north", 0, -4), spoke("south", 0, 4)] }
  expect.soft(doc.objects.length, "a sheet large enough for the kept checker's local path").toBeGreaterThan(64)
  const graph = new WireGraph()
  const checker = new KeptChecker()
  checker.update(doc, wiringOf(graph, doc))
  const east = doc.wires.find((s) => s.id === "east")!
  const edited = withSegments(doc, [{ ...east, color: "red" }], [east])
  const kept = checker.update(edited, wiringOf(graph, edited))
  expect.soft(kept.filter((f) => f.at.x === hub.x && f.at.y === hub.y), "nothing at the pin and its three wires").toEqual([])
  expect.soft(kept, "the kept checker, a fresh one").toEqual(checked(edited))
})

it("visible routes kept from the last frame are ranked again when the commit renumbered the wires before them", () => {
  const wire = (id: string, y: number, length = 4): WireSegment => ({ id, a: { x: 0, y: y * GRID }, b: { x: length * GRID, y: y * GRID } })
  const [x1, x2, q, r] = [wire("x1", 0), wire("x2", 3), wire("q", 6), wire("r", 9)]
  const before: Schematic = { objects: [], wires: [x1, x2, q, r], parts: {} }
  const view = { x: -GRID, y: -GRID, w: 20 * GRID, h: 20 * GRID }
  const graph = new WireGraph()
  const field = new FieldState()
  field.commit(before, wiringOf(graph, before)).visible(view)
  const after = withSegments(before, [wire("r", 9, 6)], [x1, x2, r])
  const known = wiringOf(graph, after)
  expect.soft(field.commit(after, known).visible(view).routes.map((route) => route.id), "the field's visible routes, in the document's order").toEqual(known.routes.filter((route) => touches(routeBox(route), view)).map((route) => route.id))
})

it("a part's fields, laid out once for its definition, orientation and text, equal a fresh layout after moves, turns and field moves", () => {
  const parts = ["system-exam", "power-supply", "nucleo-74hc595"].flatMap((id) => examples.find((e) => e.id === id)!.build(GRID).objects.filter((o) => placedFields(o, GRID).length).slice(0, 6))
  expect.soft(parts.length, "parts with fields to lay out").toBeGreaterThan(4)
  const fresh = (o: PlacedObject) => placedFields(structuredClone(o), GRID)
  for (const part of parts) {
    let o = part
    for (let step = 0; step < 10; step++) {
      if (step % 4 === 1) o = { ...o, rotation: (((o.rotation ?? 0) + 90) % 360) as PlacedObject["rotation"] }
      else if (step % 4 === 2) o = withFieldMoved(o, "ref", GRID, -GRID, GRID)
      else if (step % 4 === 3) o = { ...o, mirror: !o.mirror }
      o = { ...o, x: o.x + (step - 4) * GRID, y: o.y - step * GRID }
      expect.soft(placedFields(o, GRID), `${part.id} step ${step}`).toEqual(fresh(o))
    }
  }
})


describe("commit allocation stays bounded by the changed region", () => {
  it("old wire lists and transient wire ranks can be collected while the latest wiring is kept", async () => {
    const result = await retainedAfterCommits()
    expect.soft(result.latest).toBe(250)
    expect.soft(result.lists, "only the latest commit's predecessor is needed by the field").toBeLessThanOrEqual(2)
    expect.soft(result.segments, "rank ancestry must not retain every replaced segment").toBeLessThanOrEqual(8)
  })

  it("recording a wire edit creates no weak reference to a whole wire list", () => {
    const before: Schematic = { objects: [], wires: [{ id: "s", a: { x: 0, y: 0 }, b: { x: GRID, y: 0 } }], parts: {} }
    const NativeWeakRef = globalThis.WeakRef
    let lists = 0
    class TrackedWeakRef extends NativeWeakRef<object> {
      constructor(value: object) {
        super(value)
        if (Array.isArray(value)) lists++
      }
    }
    vi.stubGlobal("WeakRef", TrackedWeakRef)
    let after: Schematic
    try {
      after = withSegments(before, [{ ...before.wires[0], b: { x: 2 * GRID, y: 0 } }], before.wires)
      expect.soft(lists, "a weak target stays alive until the current JavaScript task ends").toBe(0)
    } finally { vi.stubGlobal("WeakRef", NativeWeakRef) }
    expect.soft(after!.wires[0].b.x).toBe(2 * GRID)
  })

  it("a direct commit and undo read at most eight weak predecessors after a long edit history", () => {
    let doc: Schematic = { objects: [], wires: [{ id: "s", a: { x: 0, y: 0 }, b: { x: GRID, y: 0 } }], parts: {} }
    const graph = new WireGraph()
    for (let i = 0; i < 80; i++) {
      wiringOf(graph, doc)
      doc = withSegments(doc, [{ ...doc.wires[0], b: { x: (i + 2) * GRID, y: 0 } }], doc.wires)
    }
    wiringOf(graph, doc)
    const after = withSegments(doc, [{ ...doc.wires[0], b: { x: 100 * GRID, y: 0 } }], doc.wires)
    for (const current of [after, doc, after]) {
      const reads = vi.spyOn(WeakRef.prototype, "deref")
      let known: Wiring
      try {
        known = wiringOf(graph, current)
        expect.soft(reads.mock.calls.length, "the adjacent edit needs no ancestor table").toBeLessThanOrEqual(8)
      } finally { reads.mockRestore() }
      expect.soft(shape(known!)).toEqual(shape(wiringOf(new WireGraph(), current)))
    }
  })

  it("a thousand insertions and deletions retain no tombstones for keys absent from the base or earlier layers", () => {
    const base = new Map([["base", 1]])
    let kept: ReadonlyMap<string, number> = base
    const snapshots: ReadonlyMap<string, number>[] = []
    for (let i = 0; i < 1024; i++) {
      kept = new OverlayMap(kept, new Map([[`temporary${i}`, i]]), new Set(i ? [`temporary${i - 1}`] : []))
      if (i % 128 === 0) snapshots.push(kept)
    }
    expect.soft([...kept]).toEqual([["base", 1], ["temporary1023", 1023]])
    const layers = Reflect.get(kept, "layers") as { removed: ReadonlySet<string> }[]
    expect.soft(layers.reduce((n, layer) => n + layer.removed.size, 0), "deleting a transient key cancels its insertion").toBe(0)
    for (let i = 0; i < snapshots.length; i++) expect.soft([...snapshots[i]]).toEqual([["base", 1], [`temporary${i * 128}`, i * 128]])
    const deleted = new OverlayMap(kept, new Map(), new Set(["base"]))
    const restored = new OverlayMap(deleted, new Map([["base", 2]]), new Set())
    expect.soft([...restored]).toEqual([["temporary1023", 1023], ["base", 2]])
  })

  it("one moved part copies fewer than 256 rectangle slots and shares visitation storage across readable snapshots", () => {
    const objects: PlacedObject[] = Array.from({ length: 5010 }, (_, i) => ({ id: `R${i}`, def: "resistor", x: i * 32 * GRID, y: 0 }))
    const before = new SpatialIndex(objects, GRID)
    const next = objects.slice()
    next[65] = { ...next[65], x: -64 * GRID }
    const after = new SpatialIndex(next, GRID, before, [65])
    const oldPages = Reflect.get(before, "rects") as readonly (readonly unknown[])[]
    const pages = Reflect.get(after, "rects") as readonly (readonly unknown[])[]
    const allocated = pages.length + pages.reduce((n, page, i) => n + (page === oldPages[i] ? 0 : Array.isArray(page) ? page.length : 1), 0)
    expect.soft(allocated).toBeLessThan(256)
    expect.soft(Reflect.get(after, "returned")).toBeDefined()
    expect.soft(Reflect.get(after, "returned")).toBe(Reflect.get(before, "returned"))
    const fresh = new SpatialIndex(next, GRID)
    for (const box of [{ x: -65 * GRID, y: -GRID, w: 8 * GRID, h: 8 * GRID }, { x: 0, y: -GRID, w: 200000 * GRID, h: 8 * GRID }]) {
      const ids = (items: readonly PlacedObject[]) => items.map((o) => o.id).sort()
      for (let i = 0; i < 3; i++) {
        expect.soft(ids(after.meeting(box))).toEqual(ids(fresh.meeting(box)))
        expect.soft(ids(before.meeting(box))).toEqual(ids(new SpatialIndex(objects, GRID).meeting(box)))
        expect.soft(after.overlaps(box)).toBe(fresh.overlaps(box))
      }
    }
    Reflect.get(after, "returned").visits = 0x7fffffff
    expect.soft(after.meeting({ x: -65 * GRID, y: -GRID, w: 8 * GRID, h: 8 * GRID })).toContain(next[65])
  })

  it("a whole translation shares rectangle pages, then local edits and old snapshots answer as fresh indexes", () => {
    const objects: PlacedObject[] = Array.from({ length: 130 }, (_, i) => ({ id: `R${i}`, def: "resistor", x: i * GRID * 8, y: (i % 3) * GRID }))
    let reads = 0
    const bounds = (object: PlacedObject) => { reads++; return { x: object.x, y: object.y, w: 3 * GRID, h: 2 * GRID } }
    const initial = new SpatialIndex(objects, GRID, undefined, undefined, bounds)
    const translated = objects.map((o) => ({ ...o, x: o.x - 65 * GRID, y: o.y + 33 * GRID }))
    reads = 0
    const shifted = new SpatialIndex(translated, GRID, initial, [], bounds, { x: -65 * GRID, y: 33 * GRID })
    expect.soft(reads, "translation allocates no per-object bounds").toBe(0)
    expect.soft(Reflect.get(shifted, "rects")).toBe(Reflect.get(initial, "rects"))
    const next = translated.slice()
    next[65] = { ...next[65], x: -150 * GRID, y: -50 * GRID }
    const edited = new SpatialIndex(next, GRID, shifted, [65], bounds)
    const states = [[objects, initial], [translated, shifted], [next, edited]] as const
    for (const [source, index] of states) {
      const fresh = new SpatialIndex(source, GRID, undefined, undefined, bounds)
      for (const box of [{ x: -200 * GRID, y: -100 * GRID, w: 400 * GRID, h: 200 * GRID }, { x: -1e9, y: -1e9, w: 2e9, h: 2e9 }, { x: 0, y: 33 * GRID, w: 10 * GRID, h: 10 * GRID }]) {
        const ids = (list: readonly PlacedObject[]) => list.map((o) => o.id).sort()
        expect.soft(ids(index.query(box))).toEqual(ids(fresh.query(box)))
        expect.soft(ids(index.meeting(box))).toEqual(ids(fresh.meeting(box)))
        expect.soft(index.overlaps(box)).toBe(fresh.overlaps(box))
      }
    }
    const doc: Schematic = { objects, wires: [], parts: {} }
    const graph = new WireGraph()
    const before = wiringOf(graph, doc)
    const movedDoc = moved(doc, new Map(objects.map((o) => [o.id, { x: o.x, y: o.y }])), -65 * GRID, 33 * GRID, undefined, before)
    const kept = wiringOf(graph, movedDoc)
    expect.soft(Reflect.get(kept.index.spatial, "rects"), "the document index uses the shared translation").toBe(Reflect.get(before.index.spatial, "rects"))
    expect.soft(Reflect.get(kept.index.objects, "source")).toBe(movedDoc.objects)
    expect.soft(Reflect.get(kept.index.objects, "positions")).toBe(Reflect.get(before.index, "positions"))
    expect.soft([...kept.index.objects]).toEqual(movedDoc.objects.map((o) => [o.id, o]))
    expect.soft([...kept.index.objects.keys()]).toEqual(objects.map((o) => o.id))
    expect.soft([...kept.index.objects.values()]).toEqual(movedDoc.objects)
    expect.soft(kept.index.objects.size).toBe(objects.length)
    const visited: PlacedObject[] = []
    kept.index.objects.forEach((o, id, map) => { expect.soft(map.get(id)).toBe(o); visited.push(o) })
    expect.soft(visited).toEqual(movedDoc.objects)
    expect.soft(kept.index.objects.has("R65")).toBe(true)
    expect.soft(kept.index.objects.get("absent")).toBeUndefined()
    expect.soft(kept.index.within({ x: -1000 * GRID, y: -1000 * GRID, w: 3000 * GRID, h: 3000 * GRID })).toEqual(documentPins([...movedDoc.objects]).within({ x: -1000 * GRID, y: -1000 * GRID, w: 3000 * GRID, h: 3000 * GRID }))
  })

  it("net derivation builds no point-key strings for integer coordinates", () => {
    const wires: WireSegment[] = [{ id: "a", a: { x: 0, y: 0 }, b: { x: 16, y: 0 } }, { id: "b", a: { x: 16, y: 0 }, b: { x: 16, y: 16 } }]
    const pins: WirePin[] = [{ key: "R:1", at: wires[0].a, out: { x: 0, y: 1 } }]
    const strings = vi.spyOn(segmentKeys, "pointKey")
    try {
      const runs = runsOf(wires, pins)
      expect.soft(runs).toHaveLength(1)
      expect.soft(flowVertices(runs, pins).pins).toEqual([["R:1", "p:R:1"]])
      expect.soft(turnsAtPins(runs, pins).leads.size).toBe(1)
      const derived = wiringOf(new WireGraph(), { objects: [], wires })
      expect.soft(derived.circuit.flow.runs).toHaveLength(1)
      expect.soft(strings, "integer net derivation allocates no coordinate strings").not.toHaveBeenCalled()
    } finally { strings.mockRestore() }
  })

  it("numeric line keys preserve the off-lattice pin diagnostic", () => {
    const wire: WireSegment = { id: "s", a: { x: 0, y: 0 }, b: { x: GRID, y: 0 } }
    expect(() => normalise([wire], [{ key: "off:1", at: { x: GRID / 4, y: 0 } }])).toThrow(`a pin at ${GRID / 4} on h0 lies on a wire but off the half-cell lattice`)
  })

  it.each([-(2 ** 24), -16, 0, 16, 2 ** 24, 0.5, -0.5, Number.MAX_SAFE_INTEGER])("line keys round-trip %s without colliding with the other axis", (at) => {
    const row = segmentKeys.horizontalLine(at)
    const column = segmentKeys.verticalLine(at)
    expect.soft(row).not.toBe(column)
    expect.soft(segmentKeys.pointOnLine(row, 24)).toEqual({ x: 24, y: at })
    expect.soft(segmentKeys.pointOnLine(column, 24)).toEqual({ x: at, y: 24 })
    expect.soft(segmentKeys.crossLineThrough(row, { x: at, y: at })).toBe(column)
    expect.soft(segmentKeys.crossLineThrough(column, { x: at, y: at })).toBe(row)
    if (Number.isInteger(at) && Math.abs(at) <= 2 ** 24) {
      expect.soft(typeof row, "lattice line keys allocate no strings").toBe("number")
      expect.soft(typeof column).toBe("number")
    }
  })

  it.each([0.25, -(2 ** 25), 2 ** 25, 2 ** 30])("runs and flow retain distinct endpoints outside the numeric point-code range at %s", (offset) => {
    const wires: WireSegment[] = [{ id: "a", a: { x: offset, y: 0 }, b: { x: offset + 24, y: 0 } }, { id: "b", a: { x: offset + 24, y: 0 }, b: { x: offset + 24, y: 24 } }, { id: "c", a: { x: offset, y: 0.5 }, b: { x: offset + 24, y: 0.5 } }]
    const pins: WirePin[] = [{ key: "A:1", at: wires[0].a }, { key: "B:1", at: wires[2].a }]
    const runs = runsOf(wires, pins)
    expect.soft(runs.map((run) => run.segments.map((segment) => segment.id))).toEqual([["a", "b"], ["c"]])
    expect.soft(flowVertices(runs, pins).runs).toEqual([{ id: "a", a: "p:A:1", b: "r:a:b" }, { id: "c", a: "p:B:1", b: "r:c:b" }])
  })

  it("160 commits, every undo and every redo restore fresh wiring, sheets, spatial queries and checker findings", () => {
    const graph = new WireGraph()
    const field = new FieldState()
    let doc = examples.find((e) => e.id === "power-supply")!.build(GRID)
    let known = wiringOf(graph, doc)
    const states = [doc]
    let serial = 0
    for (let i = 0; i < 160; i++) {
      const source = doc.wires[i % doc.wires.length]
      doc = withSegments(doc, [{ ...source, color: i % 2 ? "red" : "blue" }], [source], [], () => `history${serial++}`)
      states.push(doc)
      known = wiringOf(graph, doc)
      field.commit(doc, known)
    }
    const view = { x: -10 * GRID, y: -10 * GRID, w: 100 * GRID, h: 100 * GRID }
    for (const [step, state] of [...states].reverse().concat(states).entries()) {
      known = wiringOf(graph, state)
      const fresh = wiringOf(new WireGraph(), state)
      expect.soft(shape(known), `history state ${step}`).toEqual(shape(fresh))
      expect.soft(sheetShape(known.sheet, state.wires, known.pins), `history sheet ${step}`).toEqual(sheetShape(fresh.sheet, state.wires, fresh.pins))
      const committed = field.commit(state, known)
      expect.soft(committed.findings, `history checker ${step}`).toEqual(checked(state))
      expect.soft(committed.visible(view).routes, `history visible ${step}`).toEqual(fresh.routes.filter((route) => touches(routeBox(route), view)))
      expect.soft(known.index.spatial.meeting(view), `history spatial ${step}`).toEqual(fresh.index.spatial.meeting(view))
    }
  })
})
