import { buildNets } from "@/schematic/nets"
import { GRID, nudgeRoutes, objectPins, routeBox, Router, touches } from "@/schematic/geometry"
import { SpatialIndex } from "@/schematic/spatial"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { autoNetColor, type WireColorKey } from "@/schematic/wire-colors"
import { boardDocuments, stressDocuments } from "./lib/stress"

const ITERATIONS = 21
const WARMUP = 3

const BUDGET_MS: Record<number, { move: number; moveAll: number }> = {
  30: { move: 2, moveAll: 1.5 },
  120: { move: 2.5, moveAll: 6 },
  480: { move: 5, moveAll: 15 },
  1200: { move: 9, moveAll: 35 },
  2010: { move: 15, moveAll: 65 },
  5010: { move: 40, moveAll: 175 },
}

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

function moveTo(doc: Schematic, moving: ReadonlySet<string>, dx: number, dy: number): Schematic {
  return {
    ...doc,
    objects: doc.objects.map((o) => (moving.has(o.id) ? { ...o, x: o.x + dx, y: o.y + dy } : o)),
    wires: doc.wires.map((w) =>
      w.points && moving.has(w.from.object) && moving.has(w.to.object)
        ? { ...w, points: w.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
        : w,
    ),
  }
}

type Breakdown = { nets: number; index: number; route: number; nudge: number; derived: number; total: number }

function commitParts(router: Router, doc: Schematic, view: { x: number; y: number; w: number; h: number }) {
  const nets = () => buildNets(doc.objects, doc.wires, GRID)
  const index = () => new SpatialIndex(doc.objects, GRID)
  const route = () => router.routeAll(doc.objects, doc.wires, GRID)
  return {
    nets,
    index,
    route,
    nudge: (routes: ReturnType<typeof route>, netOfWire: (id: string) => string | undefined) => nudgeRoutes(routes, netOfWire, GRID),
    derived: (n: ReturnType<typeof nets>, i: SpatialIndex, routes: ReturnType<typeof route>) => {
      const wireById = new Map(doc.wires.map((w) => [w.id, w]))
      const visibleObjects = i.query(view)
      const visibleRoutes = routes.filter((r) => touches(routeBox(r), view))
      const visiblePins = visibleObjects.reduce((sum, o) => sum + objectPins(o, GRID).length, 0)
      const autoColor = new Map<string, WireColorKey>()
      for (const net of n.nets) autoColor.set(net, autoNetColor(n.kindsOf(net)))
      return { wireById, visibleObjects, visibleRoutes, visiblePins, autoColor }
    },
  }
}

function commit(router: Router, doc: Schematic, view: { x: number; y: number; w: number; h: number }): Breakdown {
  const parts = commitParts(router, doc, view)
  const t0 = performance.now()
  const nets = parts.nets()
  const t1 = performance.now()
  const index = parts.index()
  const t2 = performance.now()
  const routed = parts.route()
  const t3 = performance.now()
  const routes = parts.nudge(routed, nets.netOfWire)
  const t4 = performance.now()
  parts.derived(nets, index, routes)
  const t5 = performance.now()
  return { nets: t1 - t0, index: t2 - t1, route: t3 - t2, nudge: t4 - t3, derived: t5 - t4, total: t5 - t0 }
}

const mean = (runs: Breakdown[], of: keyof Breakdown) => runs.reduce((sum, r) => sum + r[of], 0) / runs.length

const VIEW = { x: -40 * GRID, y: -40 * GRID, w: 200 * GRID, h: 160 * GRID }

const withWires = (doc: Schematic): PlacedObject => {
  const wired = new Set(doc.wires.flatMap((w) => [w.from.object, w.to.object]))
  return doc.objects.find((o) => wired.has(o.id)) ?? doc.objects[0]
}

let failed = 0
let total = 0
const check = (what: string, ok: boolean, detail: string) => {
  total++
  if (!ok) failed++
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(44)} ${detail}`)
}
const ms = (value: number) => `${value.toFixed(2)} ms`
const atMost = (what: string, got: number, limit: number) => check(what, got <= limit, `${ms(got).padStart(10)}   at most ${ms(limit)}`)

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
const documents = (boards ? boardDocuments() : stressDocuments()).filter(
  (doc) => requested.length === 0 || requested.includes(doc.objects.length),
)

type Row = {
  doc: Schematic
  pins: number
  contacts: number
  load: Breakdown
  move: Breakdown
  moveAll: Breakdown
  clone: number
  serialise: number
}

const rows: Row[] = []
for (const doc of documents) {
  const view = VIEW
  const contactCount = buildNets(doc.objects, doc.wires, GRID).contacts.size
  const pinTotal = doc.objects.reduce((sum, o) => sum + objectPins(o, GRID).length, 0)

  const loads: Breakdown[] = []
  for (let i = 0; i < 5; i++) {
    const fresh = JSON.parse(JSON.stringify(doc)) as Schematic
    loads.push(commit(new Router(), fresh, view))
  }

  const one = new Set([withWires(doc).id])
  const all = new Set(doc.objects.map((o) => o.id))
  const runOn = (moving: ReadonlySet<string>) => {
    const router = new Router()
    let current = doc
    const runs: Breakdown[] = []
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      current = moveTo(current, moving, i % 2 ? -GRID : GRID, 0)
      const taken = commit(router, current, view)
      if (i >= WARMUP) runs.push(taken)
    }
    return runs
  }
  const move = runOn(one)
  const moveAll = runOn(all)

  const topology = { objects: doc.objects, wires: doc.wires, parts: {} }
  const clone = time(() => void structuredClone(topology), 11)
  const serialise = time(() => void JSON.stringify(doc), 11)

  const pick = (runs: Breakdown[]): Breakdown => ({
    nets: mean(runs, "nets"),
    index: mean(runs, "index"),
    route: mean(runs, "route"),
    nudge: mean(runs, "nudge"),
    derived: mean(runs, "derived"),
    total: mean(runs, "total"),
  })
  rows.push({
    doc,
    pins: pinTotal,
    contacts: contactCount,
    load: pick(loads),
    move: pick(move),
    moveAll: pick(moveAll),
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
    ["objects/wires/pins", "buildNets", "index", "routeAll", "nudge", "derived", "total"],
    rows.map((r) => [size(r), ms(r[of].nets), ms(r[of].index), ms(r[of].route), ms(r[of].nudge), ms(r[of].derived), ms(r[of].total)]),
  )
}

console.log("\nThe document leaving the main thread")
table(
  ["objects/wires/pins", "contacts", "structuredClone", "JSON.stringify"],
  rows.map((r) => [size(r), String(r.contacts), ms(r.clone), ms(r.serialise)]),
)

console.log(`\nthis machine runs the reference in ${(speed * REFERENCE_MS).toFixed(0)} ms, ${speed.toFixed(2)}× the one the budgets were set on`)
for (const r of rows) {
  const budget = boards ? undefined : BUDGET_MS[r.doc.objects.length]
  if (!budget) continue
  atMost(`${r.doc.objects.length} objects: one object moved`, r.move.total, budget.move * speed)
  atMost(`${r.doc.objects.length} objects: whole schematic moved`, r.moveAll.total, budget.moveAll * speed)
}

console.log(`\n${total - failed}/${total} checks passed`)
process.exit(failed ? 1 : 0)
