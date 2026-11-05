import "./lib/all-parts"
import { GRID, objectPins, routeBox, touches } from "@/schematic/geometry"
import { SpatialIndex } from "@/schematic/spatial"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { autoNetColor, type WireColorKey } from "@/schematic/wire-colors"
import { moved, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { PartDrag } from "@/schematic/rubber-band"
import { checked } from "@/schematic/checker"
import { WireGraph } from "@/schematic/wires/graph"
import { pointKey } from "@/schematic/wires/segment"
import { boardDocuments, stressDocuments } from "./lib/stress"

const ITERATIONS = 21
const WARMUP = 30

const BUDGET_MS: Record<number, { move: number; moveAll: number }> = {
  30: { move: 2, moveAll: 1.5 },
  120: { move: 2.5, moveAll: 6 },
  480: { move: 5, moveAll: 15 },
  1200: { move: 9, moveAll: 35 },
  2010: { move: 15, moveAll: 65 },
  5010: { move: 40, moveAll: 175 },
}

const BOARD_BUDGET_MS: Record<number, { load: number; moveAll: number }> = {
  1700: { load: 60, moveAll: 60 },
}

const FIXED_EDIT_GROWTH = 2

const REFERENCE_MS = 18

function reference() {
  const map = new Map<number, number>()
  let sum = 0
  for (let i = 0; i < 600_000; i++) map.set(i & 0x3fff, i * 3)
  for (let i = 0; i < 600_000; i++) sum += (map.get(i & 0x3fff) ?? 0) % 7
  return sum
}

function median(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[sorted.length >> 1] ?? 0
}

function time(run: (iteration: number) => void, iterations = ITERATIONS) {
  for (let i = 0; i < WARMUP; i++) run(i)
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const started = performance.now()
    run(i)
    samples.push(performance.now() - started)
  }
  return median(samples)
}

let fresh = 0
const newId = () => `bench${fresh++}`

function moveTo(doc: Schematic, moving: ReadonlySet<string>, dx: number, dy: number, known: Wiring): Schematic {
  const from = new Map(doc.objects.filter((o) => moving.has(o.id)).map((o) => [o.id, { x: o.x, y: o.y }] as const))
  return moved(doc, from, dx, dy, newId, known)
}

type Breakdown = { edit: number; wiring: number; index: number; derived: number; total: number }

function derived(wiring: Wiring, index: SpatialIndex, view: { x: number; y: number; w: number; h: number }) {
  const visibleObjects = index.query(view)
  const visibleRoutes = wiring.routes.filter((r) => touches(routeBox(r), view))
  const visiblePins = visibleObjects.reduce((sum, o) => sum + objectPins(o, GRID).length, 0)
  const autoColor = new Map<string, WireColorKey>()
  for (const net of wiring.nets.nets) autoColor.set(net, autoNetColor(wiring.nets.kindsOf(net)))
  return { visibleObjects, visibleRoutes, visiblePins, autoColor }
}

function commit(graph: WireGraph, doc: Schematic, view: { x: number; y: number; w: number; h: number }, edit = 0): { taken: Breakdown; wiring: Wiring } {
  const t0 = performance.now()
  const wiring = wiringOf(graph, doc)
  const t1 = performance.now()
  const index = new SpatialIndex(doc.objects, GRID)
  const t2 = performance.now()
  derived(wiring, index, view)
  const t3 = performance.now()
  return { taken: { edit, wiring: t1 - t0, index: t2 - t1, derived: t3 - t2, total: edit + t3 - t0 }, wiring }
}

const mean = (runs: Breakdown[], of: keyof Breakdown) => runs.reduce((sum, r) => sum + r[of], 0) / runs.length

const VIEW = { x: -40 * GRID, y: -40 * GRID, w: 200 * GRID, h: 160 * GRID }

const withWires = (doc: Schematic): PlacedObject => {
  const ends = new Set(doc.wires.flatMap((s) => [pointKey(s.a), pointKey(s.b)]))
  return doc.objects.find((o) => objectPins(o, GRID).some((p) => ends.has(pointKey(p.point)))) ?? doc.objects[0]
}

let failed = 0
let total = 0
const check = (what: string, ok: boolean, detail: string) => {
  total++
  if (!ok) failed++
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(44)} ${detail}`)
}
const ms = (value: number) => `${value.toFixed(2)} ms`
const atMost = (what: string, got: number, limit: number) => check(what, Number.isFinite(got) && got <= limit, `${ms(got).padStart(10)}   at most ${ms(limit)}`)

function table(header: string[], rows: string[][]) {
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column].length)))
  const line = (cells: string[]) => "  " + cells.map((cell, column) => cell.padStart(widths[column])).join("   ")
  console.log(line(header))
  console.log(line(widths.map((width) => "─".repeat(width))))
  for (const row of rows) console.log(line(row))
}

const speed = (() => {
  reference()
  const runs: number[] = []
  for (let i = 0; i < 5; i++) {
    const started = performance.now()
    reference()
    runs.push(performance.now() - started)
  }
  return median(runs) / REFERENCE_MS
})()

const boards = process.argv.includes("boards")
const requested = process.argv.slice(2).map(Number).filter(Number.isFinite)
const ANCHOR: PlacedObject = { id: "anchor", def: "resistor", x: -400 * GRID, y: -400 * GRID, props: { ref: "R0" } }
const anchored = (doc: Schematic): Schematic => ({ ...doc, objects: [...doc.objects, ANCHOR] })
const documents = (boards ? boardDocuments() : stressDocuments())
  .filter((doc) => requested.length === 0 || requested.includes(doc.objects.length))
  .map((doc) => (boards ? anchored(doc) : doc))
const counted = (doc: Schematic) => doc.objects.filter((o) => o !== ANCHOR).length

type Row = {
  doc: Schematic
  pins: number
  dots: number
  load: Breakdown
  move: Breakdown
  moveAll: Breakdown
  drop: Breakdown & { checker: number }
  clone: number
  serialise: number
}

const rows: Row[] = []
for (const doc of documents) {
  const view = VIEW
  const pinTotal = doc.objects.reduce((sum, o) => sum + objectPins(o, GRID).length, 0)
  const dotCount = wiringOf(new WireGraph(), doc).dots.length

  const loads: Breakdown[] = []
  for (let i = 0; i < 5; i++) {
    const loaded = JSON.parse(JSON.stringify(doc)) as Schematic
    loads.push(commit(new WireGraph(), loaded, view).taken)
  }

  const one = new Set([withWires(doc).id])
  const all = new Set(doc.objects.map((o) => o.id))
  const runOn = (moving: ReadonlySet<string>) => {
    const graph = new WireGraph()
    let current = doc
    let known = wiringOf(graph, current)
    const runs: Breakdown[] = []
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      const started = performance.now()
      current = moveTo(current, moving, i % 2 ? -GRID : GRID, 0, known)
      const { taken, wiring } = commit(graph, current, view, performance.now() - started)
      known = wiring
      if (i >= WARMUP) runs.push(taken)
    }
    return runs
  }
  const move = runOn(one)
  const moveAll = runOn(all)
  const drops = (() => {
    const graph = new WireGraph()
    let current = doc
    let known = wiringOf(graph, current)
    const runs: (Breakdown & { checker: number })[] = []
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      const drag = new PartDrag(current, known, { objects: one })
      const dx = i % 2 ? -GRID : GRID
      drag.frame(dx, 0)
      const started = performance.now()
      const landed = drag.landed(dx, 0, newId)
      const { taken, wiring } = commit(graph, landed.doc, view, performance.now() - started)
      const checking = performance.now()
      let checker = Infinity
      try {
        checked(landed.doc, wiring)
        checker = performance.now() - checking
      } catch {
        checker = Infinity
      }
      current = landed.doc
      known = wiring
      if (i >= WARMUP) runs.push({ ...taken, checker, total: taken.total + checker })
    }
    return runs
  })()

  const topology = { objects: doc.objects, wires: doc.wires, parts: {} }
  const clone = time(() => void structuredClone(topology), 11)
  const serialise = time(() => void JSON.stringify(doc), 11)

  const pick = (runs: Breakdown[]): Breakdown => ({
    edit: mean(runs, "edit"),
    wiring: mean(runs, "wiring"),
    index: mean(runs, "index"),
    derived: mean(runs, "derived"),
    total: mean(runs, "total"),
  })
  rows.push({
    doc,
    pins: pinTotal,
    dots: dotCount,
    load: pick(loads),
    move: pick(move),
    moveAll: pick(moveAll),
    drop: { ...pick(drops), checker: drops.reduce((sum, r) => sum + r.checker, 0) / drops.length, total: drops.reduce((sum, r) => sum + r.total, 0) / drops.length },
    clone,
    serialise,
  })
}

const size = (r: Row) => `${r.doc.objects.length}/${r.doc.wires.length}/${r.pins}`

console.log("\nOne commit: what the main thread does when the document changes")
for (const [name, of] of [
  ["a document loaded", "load"],
  ["one object moved", "move"],
  ["the whole schematic moved", "moveAll"],
] as const) {
  console.log(`\n${name}`)
  table(
    ["objects/segments/pins", "edit", "wiring", "index", "derived", "total"],
    rows.map((r) => [size(r), ms(r[of].edit), ms(r[of].wiring), ms(r[of].index), ms(r[of].derived), ms(r[of].total)]),
  )
}

console.log("\none part dropped by the rubber band, the commit and the checker after it (the field's real drop)")
table(
  ["objects/segments/pins", "drop", "wiring", "index", "derived", "checker", "total"],
  rows.map((r) => [size(r), ms(r.drop.edit), ms(r.drop.wiring), ms(r.drop.index), ms(r.drop.derived), ms(r.drop.checker), ms(r.drop.total)]),
)

console.log("\nThe document leaving the main thread")
table(
  ["objects/segments/pins", "dots", "structuredClone", "JSON.stringify"],
  rows.map((r) => [size(r), String(r.dots), ms(r.clone), ms(r.serialise)]),
)

console.log(`\nthis machine runs the reference in ${(speed * REFERENCE_MS).toFixed(0)} ms, ${speed.toFixed(2)}× the one the budgets were set on`)
for (const r of rows) {
  const budget = boards ? undefined : BUDGET_MS[r.doc.objects.length]
  if (!budget) continue
  atMost(`${r.doc.objects.length} objects: one object moved`, r.move.total, budget.move * speed)
  atMost(`${r.doc.objects.length} objects: whole schematic moved`, r.moveAll.total, budget.moveAll * speed)
}

const smallest = rows[0]
const largest = rows[rows.length - 1]
if (smallest && largest && smallest !== largest) {
  const what = boards ? "board" : "object"
  atMost(`a fixed-size edit costs no more on ${counted(largest.doc)} ${what}s than on ${counted(smallest.doc)}: one ${what} moved, within ${FIXED_EDIT_GROWTH}× (plan.md phase 5)`, largest.move.total, FIXED_EDIT_GROWTH * smallest.move.total)
  atMost(`the same for one ${what} dropped by the rubber band, the checker included`, largest.drop.total, FIXED_EDIT_GROWTH * smallest.drop.total)
}
for (const r of rows) {
  const budget = boards ? BOARD_BUDGET_MS[counted(r.doc)] : undefined
  if (!budget) continue
  atMost(`${counted(r.doc)} boards: the sheet loaded`, r.load.total, budget.load * speed)
  atMost(`${counted(r.doc)} boards: the whole sheet moved`, r.moveAll.total, budget.moveAll * speed)
}

console.log(`\n${total - failed}/${total} checks passed`)
process.exit(failed ? 1 : 0)
