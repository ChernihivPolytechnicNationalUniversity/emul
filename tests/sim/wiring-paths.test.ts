import { describe, expect, it } from "vitest"
import { circuitOf } from "@/schematic/circuit"
import { examples } from "@/schematic/examples"
import { GRID, objectPins, type Point } from "@/schematic/geometry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { moved, recoloured, removed, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import { PartDrag, SegmentDrag } from "@/schematic/rubber-band"
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
