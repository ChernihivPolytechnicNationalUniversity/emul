import { WireGraph } from "@/schematic/wires/graph"
import { commitEdit, normalise } from "@/schematic/wires/normal-form"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"

const CELL = 24
const HALF = CELL / 2
const SIZES = [1_000, 5_000, 20_000]

const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[samples.length >> 1] ?? 0

function time(run: () => void, repeat = 7) {
  run()
  const samples: number[] = []
  for (let i = 0; i < repeat; i++) {
    const started = performance.now()
    run()
    samples.push(performance.now() - started)
  }
  return median(samples)
}

let serial = 0
const seg = (ax: number, ay: number, bx: number, by: number): WireSegment => ({ id: `w${++serial}`, a: { x: ax, y: ay }, b: { x: bx, y: by } })

function overlapping(n: number): WireSegment[] {
  return Array.from({ length: n }, (_, i) => seg(HALF * i, 0, HALF * (i + n), 0))
}

function fingers(k: number): { wires: WireSegment[]; spine: WireSegment[] } {
  const wires = Array.from({ length: k }, (_, i) => seg(CELL * i, 0, CELL * i, HALF))
  const spine = Array.from({ length: k - 1 }, (_, i) => seg(CELL * i, HALF, CELL * (i + 1), HALF))
  return { wires, spine }
}

function ladder(rungs: number): WireSegment[] {
  const out: WireSegment[] = []
  for (let i = 0; i < rungs; i++) {
    const y = CELL * i
    out.push(seg(0, y, CELL, y), seg(CELL, y, 2 * CELL, y), seg(CELL, y, CELL, y + CELL))
  }
  return out
}

function rows(n: number, aligned: boolean): { wires: WireSegment[]; pins: WirePin[] } {
  const wires: WireSegment[] = []
  const pins: WirePin[] = []
  for (let i = 0; i < n; i++) {
    const x = aligned ? 0 : 5 * CELL * i
    const y = 5 * CELL * i
    wires.push(seg(x, y, x + 2 * CELL, y))
    pins.push({ key: `R${i}:1`, at: { x, y } }, { key: `R${i}:2`, at: { x: x + 2 * CELL, y } })
  }
  return { wires, pins }
}

function oneEdit(n: number, aligned: boolean) {
  const { wires, pins } = rows(n, aligned)
  const graph = new WireGraph()
  graph.of(wires, pins)
  const middle = wires[n >> 1]
  const branch = seg(middle.a.x + CELL, middle.a.y, middle.a.x + CELL, middle.a.y + HALF)
  let current: readonly WireSegment[] = wires
  let normalising = 0
  let applying = 0
  const samples = 15
  const normal: number[] = []
  const graphed: number[] = []
  for (let i = 0; i < samples; i++) {
    const adding = !current.includes(branch)
    let started = performance.now()
    const edit = adding ? commitEdit(current, pins, { add: [branch] }) : commitEdit(current, pins, { remove: [branch] })
    normal.push(performance.now() - started)
    started = performance.now()
    graph.apply(edit, edit.wires, pins)
    graphed.push(performance.now() - started)
    current = edit.wires
  }
  normalising = median(normal.slice(2))
  applying = median(graphed.slice(2))
  return { normalising, applying }
}

const ms = (v: number) => `${v.toFixed(2)} ms`.padStart(11)
let failed = 0
const check = (what: string, got: number, limit: number) => {
  const ok = got <= limit
  if (!ok) failed++
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(52)} ${ms(got)}   at most ${ms(limit)}`)
}

console.log("\nWires as segments: the model core on large sheets (median of warm runs)\n")
console.log("  segments   overlapping, normalised whole   merge k nets (one spine)   one edit, aligned rows: normalise / graph   one edit, sparse rows: normalise / graph")
const results = SIZES.map((n) => {
  const overlap = time(() => normalise(overlapping(n), []), 3)
  const rails = time(() => normalise(ladder(Math.round(n / 3)), []), 3)
  const { wires, spine } = fingers(n)
  const merges: number[] = []
  for (let i = 0; i < 3; i++) {
    const graph = new WireGraph()
    graph.of(wires, [])
    const started = performance.now()
    graph.apply({ added: spine }, [...wires, ...spine], [])
    merges.push(performance.now() - started)
  }
  const merge = median(merges)
  const aligned = oneEdit(n, true)
  const sparse = oneEdit(n, false)
  console.log(`  ${String(n).padStart(8)}   ${ms(overlap).padStart(29)}   ${ms(merge).padStart(24)}   ${ms(aligned.normalising)} / ${ms(aligned.applying)}${" ".repeat(10)}   ${ms(sparse.normalising)} / ${ms(sparse.applying)}`)
  console.log(`  ${" ".repeat(8)}   four-way ladder of ${Math.round(n / 3)} rungs, normalised whole: ${ms(rails)}`)
  return { n, overlap, rails, merge, aligned, sparse }
})

console.log("")
const large = results[results.length - 1]
check(`${large.n} overlapping segments normalised whole`, large.overlap, 300)
check(`a ${Math.round(large.n / 3)}-rung four-way ladder normalised whole`, large.rails, 300)
check(`merging ${large.n} nets`, large.merge, 400)
check(`one edit on ${large.n} aligned rows: normalise`, large.aligned.normalising, 5)
check(`one edit on ${large.n} aligned rows: graph`, large.aligned.applying, 1)
check(`one edit on ${large.n} sparse rows: normalise`, large.sparse.normalising, 5)
check(`one edit on ${large.n} sparse rows: graph`, large.sparse.applying, 1)
console.log(`\n${7 - failed}/7 checks passed`)
if (failed) process.exitCode = 1
