import "./lib/all-parts"
import { GRID, objectPins } from "@/schematic/geometry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import { routeBetween, type RouteEnd } from "@/schematic/wires/router"
import { stressDocuments, TILE_PITCH, TILINGS } from "./lib/stress"

const ITERATIONS = 21
const WARMUP = 10
const REFERENCE_MS = 18
const LOCAL_GROWTH = 2

const BUDGET_MS = { near: 2, across: 5 }

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

type Pair = { name: keyof typeof BUDGET_MS; from: readonly [string, number, number, number]; to: readonly [string, number, number, number] }

const PAIRS: readonly Pair[] = [
  { name: "near", from: ["pushbutton", 18, 39, 1], to: ["capacitor", 36, 51, 0] },
  { name: "across", from: ["pushbutton", -15, 13, 0], to: ["capacitor", 36, 51, 1] },
]

function middleTile(doc: Schematic) {
  const tiles = doc.objects.length / 30
  const tile = Math.floor(tiles / 2)
  const columns = Math.ceil(Math.sqrt(tiles))
  return { x: (tile % columns) * TILE_PITCH.x, y: Math.floor(tile / columns) * TILE_PITCH.y }
}

function endOf(doc: Schematic, [def, x, y, index]: readonly [string, number, number, number]): RouteEnd {
  const shift = middleTile(doc)
  const object = doc.objects.find((o: PlacedObject) => o.def === def && o.x === x * GRID + shift.x && o.y === y * GRID + shift.y)
  if (!object) throw new Error(`no ${def} at (${x}, ${y}) in the middle tile`)
  return { pin: { object: object.id, pin: objectPins(object, GRID)[index].pin.id } }
}

function timed(doc: Schematic, pair: Pair): number {
  const known = wiringOf(new WireGraph(), doc)
  const from = endOf(doc, pair.from)
  const to = endOf(doc, pair.to)
  const a = known.sheet.pin(`${"pin" in from ? from.pin.object : ""}:${"pin" in from ? from.pin.pin : ""}`)!.at
  const b = known.sheet.pin(`${"pin" in to ? to.pin.object : ""}:${"pin" in to ? to.pin.pin : ""}`)!.at
  const samples: number[] = []
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    const started = performance.now()
    const route = routeBetween({ ...doc }, from, to, known)
    const elapsed = performance.now() - started
    if (!route?.length || route[0].x !== a.x || route[0].y !== a.y || route.at(-1)!.x !== b.x || route.at(-1)!.y !== b.y) throw new Error("the route must connect the requested pins")
    if (route.some((p, j) => j > 0 && p.x !== route[j - 1].x && p.y !== route[j - 1].y)) throw new Error("the route must be orthogonal")
    if (i >= WARMUP) samples.push(elapsed)
  }
  return median(samples)
}

let failed = 0
let total = 0
const check = (what: string, ok: boolean, detail: string) => {
  total++
  if (!ok) failed++
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(64)} ${detail}`)
}
const ms = (value: number) => `${value.toFixed(2)} ms`

const documents = stressDocuments(TILINGS)
const measured = new Map<string, number>()
console.log("One route between two pins of the middle tile (design.md §7; plan.md phase 6)")
for (const doc of documents)
  for (const pair of PAIRS) {
    let taken = Infinity
    let why = ""
    try {
      taken = timed(doc, pair)
    } catch (error) {
      why = error instanceof Error ? error.message : String(error)
    }
    measured.set(`${pair.name}@${doc.objects.length}`, taken)
    console.log(`  ${String(doc.objects.length).padStart(5)} objects, ${pair.name.padEnd(6)} ${Number.isFinite(taken) ? ms(taken) : why}`)
  }

console.log(`\nthis machine runs the reference in ${(speed * REFERENCE_MS).toFixed(0)} ms, ${speed.toFixed(2)}× the one the budgets were set on`)
const at = (pair: string, objects: number) => measured.get(`${pair}@${objects}`) ?? Infinity
for (const pair of PAIRS) {
  const limit = BUDGET_MS[pair.name] * speed
  const got = at(pair.name, 1200)
  check(`1 200 objects: one route, ${pair.name}`, Number.isFinite(got) && got <= limit, `${ms(got).padStart(10)}   at most ${ms(limit)}`)
  const small = at(pair.name, 30)
  const large = at(pair.name, 5010)
  check(`a route costs no more on 5 010 objects than on 30, ${pair.name}, within ${LOCAL_GROWTH}×`, Number.isFinite(large) && large <= LOCAL_GROWTH * small, `${ms(large).padStart(10)}   at most ${ms(LOCAL_GROWTH * small)}`)
}

console.log(`\n${total - failed}/${total} checks passed`)
process.exit(failed ? 1 : 0)
