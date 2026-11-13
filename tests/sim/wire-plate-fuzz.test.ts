import { describe, expect, it } from "vitest"
import { wirePlates, type WirePlate } from "@/components/field/wire-plate"
import { casingTrim, wireCornerRadius } from "@/components/field/wire-style"
import type { Run } from "@/schematic/circuit"
import { examples } from "@/schematic/examples"
import { FieldState } from "@/schematic/field-state"
import { GRID, objectRect, type Point, type Rect, type RoutedWire } from "@/schematic/geometry"
import { pinsOf } from "@/schematic/pin-index"
import { flippedWithWires, PartDrag, SegmentDrag, TurnRun, type Landed } from "@/schematic/rubber-band"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { runPath } from "@/schematic/wire-look"
import { inNormalForm, removed, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { carriedSelection, pressesGoOn } from "@/schematic/wire-select"
import { WireGraph } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { arcLengthOf, flatten, pointAt, worstGapAlong } from "../lib/drawn-path"
import { random } from "../lib/wire-reference"

const RADIUS = wireCornerRadius(GRID)
const TRIM = casingTrim(GRID)
const MARGIN = 200 * GRID
const ON_THE_PATH = 0.01
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 2)
const STEPS = Number(process.env.PLATE_STEPS ?? 10)

const c = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const part = (id: string, def: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def, x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
const usersWire = (): Schematic => ({
  objects: [part("R1", "resistor", 4, 6), part("C1", "capacitor-polarized", 14, 9)],
  wires: [
    { id: "a", a: c(8, 7), b: c(12, 7) },
    { id: "b", a: c(12, 7), b: c(12, 10) },
    { id: "c", a: c(12, 10), b: c(14, 10) },
  ],
  parts: {},
})

const diagonalWire = (): Schematic => ({
  objects: [part("R1", "resistor", 4, 6), part("C1", "capacitor-polarized", 14, 9)],
  wires: [
    { id: "d", a: c(8, 7), b: c(11, 10) },
    { id: "e", a: c(11, 10), b: c(14, 10) },
  ],
  parts: {},
})

type Kept = { readonly graph: WireGraph; readonly field: FieldState; readonly view: Rect; readonly doc: Schematic; readonly wiring: Wiring; readonly routes: readonly RoutedWire[] }

function around(doc: Schematic): Rect {
  const xs = [...doc.objects.flatMap((o) => { const r = objectRect(o, GRID); return [r.x, r.x + r.w] }), ...doc.wires.flatMap((s) => [s.a.x, s.b.x]), 0]
  const ys = [...doc.objects.flatMap((o) => { const r = objectRect(o, GRID); return [r.y, r.y + r.h] }), ...doc.wires.flatMap((s) => [s.a.y, s.b.y]), 0]
  const x = Math.min(...xs) - MARGIN
  const y = Math.min(...ys) - MARGIN
  return { x, y, w: Math.max(...xs) + MARGIN - x, h: Math.max(...ys) + MARGIN - y }
}

function kept(doc: Schematic, from?: Kept, view = from?.view ?? around(doc)): Kept {
  const graph = from?.graph ?? new WireGraph()
  const field = from?.field ?? new FieldState()
  const wiring = wiringOf(graph, doc)
  return { graph, field, view, doc, wiring, routes: field.commit(doc, wiring).visible(view).routes }
}

const fresh = (doc: Schematic, view: Rect) => kept(doc, undefined, view)

const routeLook = (routes: readonly RoutedWire[]) => routes.map((r) => ({ id: r.id, pts: r.pts, leads: r.leads ?? null }))

const selectedRuns = (selection: ReadonlySet<string>, wiring: Wiring): Run[] => {
  const runs = new Map<string, Run>()
  for (const id of selection) {
    const run = wiring.runBySegment.get(id)
    if (run) runs.set(run.id, run)
  }
  return [...runs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function platesOf(state: Kept, selection: ReadonlySet<string>): WirePlate[] {
  const routes = new Map(state.routes.map((r) => [r.id, r]))
  return wirePlates(selectedRuns(selection, state.wiring), (id) => routes.get(id), selection, RADIUS, TRIM)
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id))
const sorted = (ids: Iterable<string>) => [...ids].sort()
const wholeRunsOnly = (selection: ReadonlySet<string>, wiring: Wiring) => selectedRuns(selection, wiring).every((run) => run.segments.every((s) => selection.has(s.id)))

function plateFaults(state: Kept, selection: ReadonlySet<string>, plates: readonly WirePlate[]): string[] {
  const faults: string[] = []
  const routes = new Map(state.routes.map((r) => [r.id, r]))
  for (const run of selectedRuns(selection, state.wiring)) {
    const route = routes.get(run.id)
    if (!route) {
      faults.push(`run ${run.id} selected but not drawn`)
      continue
    }
    const pts = route.pts
    const aligned = run.segments.length === pts.length - 1 && run.segments.every((s, i) => [s.a, s.b].every((p) => [pts[i], pts[i + 1]].some((q) => p.x === q.x && p.y === q.y)))
    if (!aligned) faults.push(`run ${run.id}: the drawn route's points are not its segments' ends`)
    const drawn = runPath(pts, RADIUS, route.leads)
    const path = flatten(drawn)
    const cuts = [0, ...pts.slice(1, -1).map((v) => arcLengthOf(path, v)), path.length]
    const mine = plates.filter((p) => p.run === run.id)
    const picked = run.segments.map((s) => selection.has(s.id))
    const chains: [number, number][] = []
    picked.forEach((on, i) => {
      if (!on) return
      const open = chains.at(-1)
      if (open && open[1] === i - 1) open[1] = i
      else chains.push([i, i])
    })
    const whole = chains.length === 1 && chains[0][0] === 0 && chains[0][1] === run.segments.length - 1
    if (whole && (mine.length !== 1 || !mine[0].whole || mine[0].d !== drawn)) faults.push(`run ${run.id}: selected whole but its plate is not its drawn path (${mine.length} plates)`)
    if (!whole && mine.length !== chains.length) faults.push(`run ${run.id}: ${chains.length} selected stretches drawn as ${mine.length} plates`)
    mine.forEach((plate, k) => {
      const [first, end] = chains[k] ?? [0, run.segments.length - 1]
      const part = flatten(plate.d)
      const from = cuts[first]
      const to = cuts[end + 1]
      const start = pointAt(path, from)
      const gap = worstGapAlong(part, path, from)
      const short = part.length - (to - from)
      const off = Math.hypot(part.points[0].x - start.x, part.points[0].y - start.y)
      if (gap > ON_THE_PATH || Math.abs(short) > ON_THE_PATH || off > ON_THE_PATH) faults.push(`run ${run.id} plate ${k}: leaves the drawn path by ${gap.toFixed(3)}, ${short.toFixed(3)} longer than its stretch, starts ${off.toFixed(3)} off`)
    })
  }
  return faults
}

type Step = { kind: string; landed: Landed; dragged?: string }

function randomDoc(seed: number): Schematic {
  const rng = random(seed)
  const defs = ["resistor", "capacitor", "capacitor-polarized"]
  const objects: PlacedObject[] = []
  const columns = rng.int(2, 4)
  const rows = rng.int(2, 3)
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      if (rng.chance(0.2)) continue
      objects.push(part(`P${row}-${column}`, rng.pick(defs), column * 10 + rng.int(0, 2), row * 8 + rng.int(0, 2), rng.chance(0.25) ? 90 : undefined))
    }
  const pins = pinsOf(objects)
  const wires: WireSegment[] = []
  const used = new Set<string>()
  for (let k = 0; k < objects.length + 2; k++) {
    const p = rng.pick(pins)
    const q = rng.pick(pins)
    if (p.key === q.key || p.key.split(":")[0] === q.key.split(":")[0] || used.has(p.key) || used.has(q.key)) continue
    used.add(p.key)
    used.add(q.key)
    const middle = Math.round((p.at.x + q.at.x) / 2 / GRID) * GRID
    const points = rng.chance(0.5) ? [p.at, { x: q.at.x, y: p.at.y }, q.at] : [p.at, { x: middle, y: p.at.y }, { x: middle, y: q.at.y }, q.at]
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]
      const b = points[i]
      if (a.x !== b.x || a.y !== b.y) wires.push({ id: `w${k}-${i}`, a, b })
    }
  }
  return inNormalForm({ objects, wires, parts: {} })
}

function fuzz(name: string, start: Schematic, seed: number, steps: number, found: string[], tally: Record<string, number>) {
  const rng = random(seed)
  let state = kept(start)
  let freshBefore = fresh(start, state.view)
  const history: Schematic[] = []
  let selection: ReadonlySet<string> = new Set()
  let back: { segment: string; dx: number; dy: number } | null = null
  const click = () => {
    const runs = state.wiring.runs
    if (!runs.length) return new Set<string>()
    const run = rng.pick(runs)
    if (run.segments.length > 1 && rng.chance(0.15)) return new Set(run.segments.filter(() => rng.chance(0.5)).map((s) => s.id))
    return new Set(run.segments.map((s) => s.id))
  }
  selection = click()
  for (let step = 0; step < steps; step++) {
    const doc = state.doc
    const wiring = state.wiring
    const objects = doc.objects.map((o) => o.id)
    const where = `${name} seed ${seed} step ${step}`
    let edit: Step
    try {
      const roll = rng.next()
      if (back && wiring.segmentsById.has(back.segment) && roll < 0.35) {
        edit = { kind: "segment back", landed: new SegmentDrag(doc, wiring, back.segment).landed(-back.dx, -back.dy), dragged: back.segment }
        back = null
      } else if (roll < 0.55 && selection.size) {
        const segment = rng.pick([...selection].filter((id) => wiring.segmentsById.has(id)))
        const along = rng.chance(0.5)
        const by = rng.int(1, 4) * (rng.chance(0.5) ? 1 : -1) * GRID
        const dx = along ? by : rng.int(-3, 3) * GRID
        const dy = along ? rng.int(-3, 3) * GRID : by
        edit = segment ? { kind: "segment", landed: new SegmentDrag(doc, wiring, segment).landed(dx, dy), dragged: segment } : { kind: "none", landed: { doc, unlaid: [], at: { x: 0, y: 0 } } }
        if (segment) back = { segment, dx, dy }
      } else if (roll < 0.7 && objects.length) {
        const ids = new Set([rng.pick(objects), ...(rng.chance(0.3) ? [rng.pick(objects)] : [])])
        edit = { kind: "part", landed: new PartDrag(doc, wiring, { objects: ids }, { detach: rng.chance(0.15) }).landed(rng.int(-4, 4) * GRID, rng.int(-4, 4) * GRID) }
      } else if (roll < 0.8) {
        const ids = new Set(objects.length && rng.chance(0.7) ? [rng.pick(objects)] : [])
        const run = new TurnRun(doc, wiring, ids, undefined, selection)
        let landed: Landed = { doc, unlaid: [], at: { x: 0, y: 0 } }
        for (let k = rng.int(1, 3); k > 0; k--) landed = run.turned(rng.chance(0.5) ? 1 : -1)
        edit = { kind: "turn", landed }
      } else if (roll < 0.87) {
        const ids = new Set(objects.length ? [rng.pick(objects)] : [])
        edit = { kind: "flip", landed: flippedWithWires(doc, wiring, ids, rng.chance(0.5) ? "horizontal" : "vertical", undefined, undefined, selection) }
      } else if (roll < 0.95 && history.length) {
        edit = { kind: "undo", landed: { doc: history.pop()!, unlaid: [], at: { x: 0, y: 0 } } }
      } else {
        selection = click()
        continue
      }
    } catch (e) {
      found.push(`${where}: the edit threw ${(e as Error).message}`)
      continue
    }
    tally[edit.kind] = (tally[edit.kind] ?? 0) + 1
    const next = edit.landed.doc
    if (next === doc) continue
    if (edit.kind !== "undo") history.push(doc)
    const after = kept(next, state)
    const freshAfter = fresh(next, state.view)
    const carried = carriedSelection(selection, wiring, after.wiring)
    const what = `${where} (${edit.kind})`
    if (JSON.stringify(routeLook(after.routes)) !== JSON.stringify(routeLook(freshAfter.routes))) found.push(`${what}: the routes kept on the field are not the fresh document's (ids, points, order)`)
    const ids = new Set(next.wires.map((s) => s.id))
    const stale = [...carried].filter((id) => !ids.has(id))
    if (stale.length) found.push(`${what}: the carried selection names ${stale.length} segment(s) the document no longer has`)
    const lost = [...selection].filter((id) => ids.has(id) && !carried.has(id))
    if (lost.length) found.push(`${what}: ${lost.length} selected segment(s) still there but no longer selected`)
    if (wholeRunsOnly(selection, wiring) && !wholeRunsOnly(carried, after.wiring)) found.push(`${what}: a wire selected whole came out selected in part`)
    if (!sameSet(carriedSelection(selection, freshBefore.wiring, freshAfter.wiring), carried)) found.push(`${what}: the selection carried through the kept wiring is not the one carried through fresh wirings`)
    if (edit.dragged && selection.has(edit.dragged) && wholeRunsOnly(selection, wiring) && ids.has(edit.dragged)) {
      const run = after.wiring.runBySegment.get(edit.dragged)!
      if (!run.segments.every((s) => carried.has(s.id))) found.push(`${what}: the dragged wire is no longer selected whole, as a click on it would select it`)
    }
    const keptPlates = platesOf(after, carried)
    const freshPlates = platesOf(freshAfter, carried)
    if (JSON.stringify(keptPlates) !== JSON.stringify(freshPlates)) found.push(`${what}: the plates kept on the field differ from a fresh document's`)
    for (const fault of plateFaults(after, carried, keptPlates)) found.push(`${what}: ${fault}`)
    tally.plates = (tally.plates ?? 0) + keptPlates.length
    tally.commits = (tally.commits ?? 0) + 1
    state = after
    freshBefore = freshAfter
    selection = carried
    if (!selection.size || rng.chance(0.1)) selection = click()
  }
}

describe("a selected wire keeps one plate along its drawn path through every edit (the user, 2026-11-12: «туда-сюда подёргали провод»)", () => {
  it("the user's wire, selected and dragged back and forth along both axes: after every release it is still selected whole and its plate is its drawn path, pin to pin", () => {
    let state = kept(usersWire())
    let selection: ReadonlySet<string> = new Set(state.wiring.runBySegment.get("b")!.segments.map((s) => s.id))
    const drags: [string, number, number][] = [["b", -2, 0], ["b", 2, 0], ["a", 0, -2], ["a", 0, 2], ["c", 0, 1], ["c", 0, -1], ["b", 1, 0], ["a", 0, -1], ["b", -1, 0], ["a", 0, 1]]
    for (const [segment, dx, dy] of drags) {
      const label = `${segment} by (${dx}, ${dy})`
      const target = state.wiring.segmentsById.has(segment) ? segment : [...selection][0]
      const landed = new SegmentDrag(state.doc, state.wiring, target).landed(dx * GRID, dy * GRID)
      expect.soft(landed.refused, `${label}: the drag lands`).toBeUndefined()
      const after = kept(landed.doc, state)
      selection = carriedSelection(selection, state.wiring, after.wiring)
      state = after
      expect.soft(state.wiring.runs.length, `${label}: still one wire from R1 to C1`).toBe(1)
      expect.soft(sorted(selection), `${label}: the whole wire stays selected, as a click on it selects it`).toEqual(sorted(state.wiring.runs[0].segments.map((s) => s.id)))
      const plates = platesOf(state, selection)
      const route = state.routes[0]
      expect.soft(plates.map((p) => [p.whole, p.d]), `${label}: one plate, the wire's own drawn path`).toEqual([[true, runPath(route.pts, RADIUS, route.leads)]])
      expect.soft(plateFaults(state, selection, plates), `${label}: the plate measured against the drawn path`).toEqual([])
    }
  })

  it("a diagonal wire (phase 7), selected and dragged back and forth: after every release it is still selected whole and its plate is its drawn path; its slanted piece selected alone gets the drawn path's stretch", () => {
    let state = kept(diagonalWire())
    expect.soft(state.wiring.runs.length, "set up: one wire from R1 to C1 with a 45° piece").toBe(1)
    const slanted = (doc: Schematic) => doc.wires.filter((s) => s.a.x !== s.b.x && s.a.y !== s.b.y)
    expect.soft(slanted(state.doc).length, "set up: the 45° piece is kept").toBe(1)
    let selection: ReadonlySet<string> = new Set(state.wiring.runs[0].segments.map((s) => s.id))
    const drags: [string, number, number][] = [["d", 1, 0], ["d", -1, 0], ["d", 0, -1], ["d", 0, 1], ["e", 0, 1], ["e", 0, -1], ["d", 2, 0], ["d", -2, 0]]
    let moved = 0
    for (const [segment, dx, dy] of drags) {
      const label = `${segment} by (${dx}, ${dy})`
      const target = state.wiring.segmentsById.has(segment) ? segment : segment === "d" ? slanted(state.doc)[0]?.id ?? [...selection][0] : [...selection][0]
      const landed = new SegmentDrag(state.doc, state.wiring, target).landed(dx * GRID, dy * GRID)
      if (landed.refused?.length || landed.doc === state.doc) continue
      moved++
      const after = kept(landed.doc, state)
      selection = carriedSelection(selection, state.wiring, after.wiring)
      state = after
      expect.soft(state.wiring.runs.length, `${label}: still one wire from R1 to C1`).toBe(1)
      expect.soft(sorted(selection), `${label}: the whole wire stays selected, as a click on it selects it`).toEqual(sorted(state.wiring.runs[0].segments.map((s) => s.id)))
      const plates = platesOf(state, selection)
      const route = state.routes[0]
      expect.soft(plates.map((p) => [p.whole, p.d]), `${label}: one plate, the wire's own drawn path`).toEqual([[true, runPath(route.pts, RADIUS, route.leads)]])
      expect.soft(plateFaults(state, selection, plates), `${label}: the plate measured against the drawn path`).toEqual([])
    }
    expect.soft(moved, "every drag lands").toBe(drags.length)
    const piece = slanted(state.doc)
    expect.soft(piece.length, "the wire still has its 45° piece").toBeGreaterThan(0)
    const alone = new Set(piece.map((s) => s.id))
    const plates = platesOf(state, alone)
    expect.soft(plates.length, "the 45° piece alone: one plate").toBe(1)
    expect.soft(plates[0]?.whole, "not the whole wire's").toBe(false)
    expect.soft(plateFaults(state, alone, plates), "the 45° piece's plate lies on the drawn path between its bends' middles").toEqual([])
  })

  it("random edits on random documents and on every example — segment drags and drags back, part drags, Alt detach, turns, mirrors, undo: the plate kept on the field is the fresh document's and lies on the drawn path, the routes drawn are the fresh ones, and a wire selected whole stays whole", () => {
    const found: string[] = []
    const tally: Record<string, number> = {}
    for (let seed = 1; seed <= SEEDS * 20; seed++) fuzz("random", randomDoc(seed * 7919), seed, STEPS * 3, found, tally)
    for (let seed = 1; seed <= SEEDS * 4; seed++) fuzz("user's wire", usersWire(), seed, STEPS * 3, found, tally)
    for (let seed = 1; seed <= SEEDS * 4; seed++) fuzz("diagonal wire", diagonalWire(), seed, STEPS * 3, found, tally)
    for (const example of examples) for (let seed = 1; seed <= SEEDS; seed++) fuzz(example.id, inNormalForm(example.build(GRID)), seed * 31 + example.id.length, STEPS, found, tally)
    expect.soft(found, "no edit leaves a plate off its wire, a kept route or plate unlike a fresh one, or a whole selection cut").toEqual([])
    const scale = SEEDS * STEPS
    expect.soft((tally.segment ?? 0) + (tally["segment back"] ?? 0), "hundreds of wire drags").toBeGreaterThan(scale * 25)
    expect.soft(tally["segment back"] ?? 0, "hundreds of them straight back").toBeGreaterThan(scale * 10)
    expect.soft(tally.commits ?? 0, "over a thousand edits landed in all").toBeGreaterThan(scale * 50)
    expect.soft(tally.plates ?? 0, "every landing's plates measured").toBeGreaterThan(scale * 50)
    expect.soft(["part", "turn", "flip", "undo"].map((kind) => (tally[kind] ?? 0) > scale * 3), "parts, turns, mirrors and undo each ran dozens of times").toEqual([true, true, true, true])
  }, 600_000)
})

describe("the selection follows the wire, not the ids it happened to be stored under", () => {
  it("a selected wire cut in two by an undo that brings back a branch on it stays selected on both sides", () => {
    const branched: Schematic = {
      objects: [],
      wires: [
        { id: "q", a: c(0, 0), b: c(5, 0) },
        { id: "w", a: c(5, 0), b: c(10, 0) },
        { id: "arm", a: c(5, 0), b: c(5, 3) },
      ],
      parts: {},
    }
    const graph = new WireGraph()
    const withArm = wiringOf(graph, branched)
    const merged = removed(branched, new Set(), new Set(["arm"]))
    const withoutArm = wiringOf(graph, merged)
    expect.soft(withoutArm.runs.map((run) => run.segments.length), "deleting the arm leaves one straight wire").toEqual([1])
    const clicked = new Set(withoutArm.runs[0].segments.map((s) => s.id))
    const undone = carriedSelection(clicked, withoutArm, wiringOf(graph, branched))
    expect.soft(sorted(undone), "undone, both halves of the wire that was selected are selected, the arm is not").toEqual(["q", "w"])
    expect.soft(sorted(carriedSelection(new Set(["q", "w"]), withArm, withoutArm)), "and redone, the merged wire is selected").toEqual(sorted(clicked))
  })

  it("a part selected in part keeps exactly its selected segments and the pieces they were cut into", () => {
    const doc = usersWire()
    const graph = new WireGraph()
    const before = wiringOf(graph, doc)
    const landed = new SegmentDrag(doc, before, "a").landed(0, -2 * GRID)
    const after = wiringOf(graph, landed.doc)
    const carried = carriedSelection(new Set(["c"]), before, after)
    expect.soft(sorted(carried), "only the run into C1, which the drag left where it was").toEqual(["c"])
  })

  it("a run of R presses on a selected wire is still one run once the turn has given the wire new segments", () => {
    const doc = usersWire()
    const graph = new WireGraph()
    const before = wiringOf(graph, doc)
    const wires = new Set(["a", "b", "c"])
    const run = new TurnRun(doc, before, new Set(), undefined, wires)
    const landed = run.turned(1)
    const after = wiringOf(graph, landed.doc)
    const now = carriedSelection(wires, before, after)
    expect.soft(now.size > wires.size, "the turn laid new segments into the selected wire").toBe(true)
    const last = { objects: "", wires, of: before, doc: landed.doc }
    expect.soft(pressesGoOn(last, "", now, landed.doc, after), "the next press goes on with the same run").toBe(true)
    expect.soft(pressesGoOn(last, "", new Set(["a"]), landed.doc, after), "a selection changed by hand starts a new run").toBe(false)
    expect.soft(pressesGoOn(last, "", now, doc, after), "so does any other document").toBe(false)
    expect.soft(pressesGoOn(last, "R1", now, landed.doc, after), "and other parts").toBe(false)
  })
})

