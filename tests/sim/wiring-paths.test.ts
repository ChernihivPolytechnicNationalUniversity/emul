import { tiled } from "../../scripts/lib/stress"
import type { HdlNetlist } from "emul-shared/hdl"
import counter from "./hdl/counter.json"
import { getDef, setLibrary } from "@/schematic/registry"
import { commitEdit } from "@/schematic/wires/normal-form"
import { SpatialIndex } from "@/schematic/spatial"
import { checked, KeptChecker } from "@/schematic/checker"
import { FieldState } from "@/schematic/field-state"
import { placedFields, withFieldMoved } from "@/schematic/fields"
import { documentPins, editedObjects, pinsOf } from "@/schematic/pin-index"
import { describe, expect, it } from "vitest"
import { circuitOf } from "@/schematic/circuit"
import { examples } from "@/schematic/examples"
import { GRID, objectPins, routeBox, touches, type Point } from "@/schematic/geometry"
import type { HdlModule, PlacedObject, Schematic } from "@/schematic/types"
import { moved, recoloured, removed, withModule, withSegments, wireOrder, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import { PartDrag, SegmentDrag, TurnRun } from "@/schematic/rubber-band"
import { lineCodeOf, WireSheet, type SheetMark } from "@/schematic/wires/sheet"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"

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

  it("a field moved by hand leaves the wiring as it was, kept and fresh", async () => {
    const { withFieldMoved } = await import("@/schematic/fields")
    const before = line()
    const graph = new WireGraph()
    const known = wiringOf(graph, before)
    const after: Schematic = { ...before, objects: before.objects.map((o) => (o.id === "R3" ? withFieldMoved(o, "ref", 3 * GRID, -GRID, GRID) : o)) }
    const kept = wiringOf(graph, after)
    expect.soft(after.objects.find((o) => o.id === "R3")!.fieldAt, "set up: the field moved").toBeDefined()
    expect.soft(shape(kept), "the wiring, kept").toEqual(shape(wiringOf(new WireGraph(), after)))
    const electrical = (w: Wiring) => ({ ...shape(w), circuit: { nets: w.circuit.nets, wired: w.circuit.wired, flow: w.circuit.flow } })
    expect.soft(electrical(kept), "and the wiring, the nets and the flow unchanged by the move (the circuit carries the parts themselves, the moved field with them)").toEqual(electrical(known))
  })
})

describe("the maintained field commit has the same findings and queries as a fresh field", () => {
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
