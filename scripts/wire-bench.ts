import { builder, connect, connections, legacyOf } from "@/schematic/builder"
import { examples, lab1Board } from "@/schematic/examples"
import { circuitOf } from "@/schematic/circuit"
import { buildNetlist } from "@/sim/netlist"
import { FlowSolver } from "@/sim/flow"
import { GRID } from "@/schematic/geometry"
import { wiresAsSegments } from "@/schematic/migrate-wires"
import { getDef } from "@/schematic/registry"
import { upgraded } from "@/schematic/migrate"
import { placementCheck } from "@/schematic/placement"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { WireGraph } from "@/schematic/wires/graph"
import { boardDocuments, stressDocuments } from "./lib/stress"
import { PartDrag, TurnRun } from "@/schematic/rubber-band"
import { SpatialIndex } from "@/schematic/spatial"
import { drawEndAt, isRefusal, pointerAt, previewOf, startDrawing } from "@/schematic/wire-draw"
import { wiringOf } from "@/schematic/wire-edits"
import { commitEdit, normalise } from "@/schematic/wires/normal-form"
import { planDrag } from "@/schematic/wires/drag"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"
import { WireSheet } from "@/schematic/wires/sheet"

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

function comb(n: number): WireSegment[] {
  const teeth = n >> 1
  const out: WireSegment[] = []
  for (let i = 0; i < teeth; i++) out.push(seg(CELL * i, 0, CELL * (i + 1), 0), seg(CELL * i, 0, CELL * i, CELL))
  return out
}

function bigNetEdit(n: number) {
  const wires = comb(n)
  const graph = new WireGraph()
  graph.of(wires, [])
  const tooth = wires[wires.length - 1]
  const samples: number[] = []
  let present = true
  for (let i = 0; i < 9; i++) {
    const started = performance.now()
    graph.apply(present ? { removed: [tooth] } : { added: [tooth] })
    samples.push(performance.now() - started)
    present = !present
  }
  return median(samples.slice(1))
}

function copiedPins(n: number) {
  const { wires, pins } = rows(n, false)
  const graph = new WireGraph()
  graph.of(wires, pins)
  const samples: number[] = []
  for (let i = 0; i < 9; i++) {
    const copies = pins.map((p) => ({ ...p, at: { ...p.at } }))
    const started = performance.now()
    graph.of(wires, copies)
    samples.push(performance.now() - started)
  }
  return median(samples.slice(1))
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
    graph.apply(edit)
    graphed.push(performance.now() - started)
    current = edit.wires
  }
  normalising = median(normal.slice(2))
  applying = median(graphed.slice(2))
  return { normalising, applying }
}

const ms = (v: number) => `${v.toFixed(2)} ms`.padStart(11)
let failed = 0
let checked = 0
const check = (what: string, got: number, limit: number) => {
  const ok = got <= limit
  checked++
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
    graph.apply({ added: spine })
    merges.push(performance.now() - started)
  }
  const merge = median(merges)
  const aligned = oneEdit(n, true)
  const sparse = oneEdit(n, false)
  console.log(`  ${String(n).padStart(8)}   ${ms(overlap).padStart(29)}   ${ms(merge).padStart(24)}   ${ms(aligned.normalising)} / ${ms(aligned.applying)}${" ".repeat(10)}   ${ms(sparse.normalising)} / ${ms(sparse.applying)}`)
  const big = bigNetEdit(n)
  const copies = copiedPins(n)
  console.log(`  ${" ".repeat(8)}   four-way ladder of ${Math.round(n / 3)} rungs, normalised whole: ${ms(rails)}; a tooth off a ${n}-segment net: ${ms(big)}; the same ${2 * n} pins as fresh objects: ${ms(copies)}`)
  return { n, overlap, rails, merge, aligned, sparse, big, copies }
})

const CHAIN = 512
const chain = (): Schematic => ({ objects: Array.from({ length: CHAIN }, (_, i): PlacedObject => ({ id: `r${i}`, def: "resistor", x: 3 * i * GRID, y: 3 * i * GRID, rotation: 45, props: { ref: `R${i + 1}` } })), wires: [], parts: {}, version: 2 } as Schematic)
const lattice = time(() => upgraded(chain()), 3)
const BOARDS = 400
const sheet = boardDocuments([BOARDS])[0]
const carried: PlacedObject = { id: "carried", def: "crystal", x: 38 * GRID, y: 28 * GRID, props: { ref: "Y1" } }
const dragStart = time(() => placementCheck({ objects: [...sheet.objects, carried], routes: [], grid: GRID }, [carried]), 5)
const FENCE = 60
const FENCED = 40
const fenced = (): Schematic => ({
  objects: [
    ...Array.from({ length: FENCE * FENCE }, (_, i): PlacedObject => ({ id: `g${i}`, def: "ground", x: ((i % FENCE) - 1) * GRID, y: Math.floor(i / FENCE) * GRID, props: { ref: `G${i}` } })),
    ...Array.from({ length: FENCED }, (_, k): PlacedObject => ({ id: `f${k}`, def: "resistor", x: (FENCE / 2 + (k % 5)) * GRID, y: (FENCE / 2 + Math.floor(k / 5)) * GRID, rotation: 45, props: { ref: `R${k + 1}` } })),
  ],
  wires: [],
  parts: {},
  version: 2,
} as Schematic)
const fencedIn = time(() => upgraded(fenced()), 3)
const STRIP_WIRES = 23
const crowded = (() => {
  const doc = lab1Board.build(GRID)
  const board = doc.objects.find((o) => o.def === "open746i-c")!
  const strips = getDef("open746i-c")!.pins.filter((p) => /^P(18|19)-\d+$/.test(p.id) && /^P[A-I]\d+$/.test(p.label ?? ""))
  const load = builder(GRID)
  strips.slice(0, STRIP_WIRES).forEach((p, i) => {
    const sw = load.place("switch", 90 + (i % 14) * 6, 4 + Math.floor(i / 14) * 6)
    load.wire(board, p.id, sw, "1")
    load.wire(sw, "2", board, "P18-36")
  })
  doc.objects.push(...load.doc.objects)
  connect(doc, ...connections(load.doc))
  return legacyOf(doc)
})()
const frozen = time(() => wiresAsSegments(crowded), 3)
const SUPPLIES = 100
const supplies = (() => {
  const one = examples.find((e) => e.id === "power-supply")!.build(GRID)
  const doc: Schematic = { objects: [], wires: [], parts: {} }
  for (let tile = 0; tile < SUPPLIES; tile++) {
    const dx = (tile % 10) * 60 * GRID
    const dy = Math.floor(tile / 10) * 40 * GRID
    for (const o of one.objects) doc.objects.push({ ...o, id: `${o.id}-${tile}`, x: o.x + dx, y: o.y + dy })
    for (const w of one.wires) doc.wires.push({ ...w, id: `${w.id}-${tile}`, a: { x: w.a.x + dx, y: w.a.y + dy }, b: { x: w.b.x + dx, y: w.b.y + dy } })
  }
  return doc
})()
const suppliesCircuit = circuitOf(supplies)
const suppliesNet = buildNetlist(suppliesCircuit)
const terminals = Object.keys(suppliesCircuit.flow.pins).filter((key) => suppliesNet.pinNet.has(key))
const flowBuilt = time(() => {
  const solver = new FlowSolver(suppliesCircuit.flow, suppliesNet.pinNet, suppliesNet.groundKeys)
  for (const key of terminals) solver.unit(key)
}, 3)
console.log(`  an old file's ${CHAIN} resistors chained on their diagonals, moved onto the lattice: ${ms(lattice)}; a drag's placement check set up on ${BOARDS} boards: ${ms(dragStart)}`)
console.log(`  ${FENCED} diagonal resistors fenced in by ${FENCE * FENCE} grounds, each taken out to a clear spot: ${ms(fencedIn)}`)
console.log(`  an old file's ${2 * STRIP_WIRES} wires crowding into the Open746I-C's strips, frozen and laid clear of each other's nets: ${ms(frozen)}`)
console.log(`  the wire currents per terminal for ${SUPPLIES} power supplies (${supplies.objects.length} parts, ${suppliesCircuit.flow.runs.length} runs, ${terminals.length} terminals): ${ms(flowBuilt)}`)

console.log("")
const large = results[results.length - 1]
check(`${large.n} overlapping segments normalised whole`, large.overlap, 300)
check(`a ${Math.round(large.n / 3)}-rung four-way ladder normalised whole`, large.rails, 120)
check(`merging ${large.n} nets`, large.merge, 400)
check(`one edit on ${large.n} aligned rows: normalise`, large.aligned.normalising, 5)
check(`one edit on ${large.n} aligned rows: graph`, large.aligned.applying, 1)
check(`one edit on ${large.n} sparse rows: normalise`, large.sparse.normalising, 5)
check(`one edit on ${large.n} sparse rows: graph`, large.sparse.applying, 1)
check(`a tooth taken off a ${large.n}-segment net: graph`, large.big, 60)
check(`the graph handed ${2 * large.n} value-equal pins`, large.copies, 2)
check(`an old file's ${CHAIN}-part diagonal chain moved onto the lattice`, lattice, 400)
check(`a drag's placement check set up on ${BOARDS} boards`, dragStart, 30)
check(`${FENCED} parts fenced in by ${FENCE * FENCE} grounds taken out to clear spots`, fencedIn, 300)
check(`an old file's ${2 * STRIP_WIRES} crowded wires frozen`, frozen, 600)
check(`the wire currents per terminal for ${SUPPLIES} power supplies`, flowBuilt, 150)

const ROWS = 100
const COLUMNS = 100
function resistorGrid() {
  const wires: WireSegment[] = []
  const pins: WirePin[] = []
  const heading = new Map<string, { x: number; y: number }>()
  for (let r = 0; r < ROWS; r++)
    for (let k = 0; k < COLUMNS; k++) {
      const x = 8 * CELL * k
      const y = 4 * CELL * r
      pins.push({ key: `R${r}_${k}:1`, at: { x, y } }, { key: `R${r}_${k}:2`, at: { x: x + 4 * CELL, y } })
      heading.set(`R${r}_${k}:1`, { x: -1, y: 0 })
      heading.set(`R${r}_${k}:2`, { x: 1, y: 0 })
      if (k + 1 < COLUMNS) wires.push(seg(x + 4 * CELL, y, x + 8 * CELL, y))
      if (r + 1 < ROWS) wires.push(seg(x + 4 * CELL, y, x + 4 * CELL, y + 4 * CELL))
    }
  return { wires, pins, heading }
}
const grid = resistorGrid()
const gridWires = normalise(grid.wires, grid.pins)
const sheetBuild = time(() => WireSheet.of(gridWires, grid.pins), 3)
const spine = overlapping(SIZES[SIZES.length - 1]).reverse()
const onOneLine = time(() => WireSheet.of(spine, []), 3)
const gridSheet = WireSheet.of(gridWires, grid.pins)
const gridNets = new WireGraph().of(gridWires, grid.pins)
const carriedParts = ["R50_50", "R50_51", "R51_50", "R52_52", "R49_53"]
const request = { pins: carriedParts.flatMap((p) => [`${p}:1`, `${p}:2`]), heading: (key: string) => grid.heading.get(key) }
const planning = time(() => planDrag(gridSheet, gridNets, request), 25)
const dragPlan = planDrag(gridSheet, gridNets, request)
const offsets: { x: number; y: number }[] = []
for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) offsets.push({ x: dx * CELL, y: dy * CELL })
const WARM = 20
const MEASURED = 5
const frameSamples: number[] = []
let drawn = 0
for (let round = 0; round < WARM + MEASURED; round++)
  for (const offset of offsets) {
    const started = performance.now()
    const pieces = dragPlan.frame(offset).pieces.length
    if (round < WARM) continue
    frameSamples.push(performance.now() - started)
    drawn += pieces
  }
const frame = median(frameSamples)
const releaseOffset = { x: 2 * CELL, y: CELL }
const releaseEdit = time(() => dragPlan.commit(releaseOffset), 25)
const released = dragPlan.commit(releaseOffset)!
const movedPins = new Map(released.pins.map((p) => [p.key, p]))
const pinsAfter = grid.pins.map((p) => movedPins.get(p.key) ?? p)
const releaseNormalised = time(() => commitEdit(gridWires, pinsAfter, released.edit), 7)
const committed = commitEdit(gridWires, pinsAfter, released.edit)
const pinsMoved = released.pins
const pinsLeft = pinsMoved.map((p) => grid.pins.find((q) => q.key === p.key)!)
const sheetSamples: number[] = []
for (let i = 0; i < 9; i++) {
  const forward = i % 2 === 0
  const started = performance.now()
  gridSheet.apply(forward ? { added: committed.added, removed: committed.removed, pinsAdded: pinsMoved, pinsRemoved: pinsLeft } : { added: committed.removed, removed: committed.added, pinsAdded: pinsLeft, pinsRemoved: pinsMoved })
  for (const s of committed.added) gridSheet.through(s.a)
  for (const s of committed.removed) gridSheet.through(s.a)
  sheetSamples.push(performance.now() - started)
}
if (sheetSamples.length % 2) gridSheet.apply({ added: committed.removed, removed: committed.added, pinsAdded: pinsLeft, pinsRemoved: pinsMoved })
const sheetDelta = median(sheetSamples.slice(1))
console.log(`\nThe rubber band on a ${gridWires.length}-segment sheet of ${ROWS * COLUMNS} resistors, ${carriedParts.length} carried (median of warm runs)\n`)
console.log(`  the sheet index built once per document: ${ms(sheetBuild)} (${ms(onOneLine)} for ${spine.length} segments on one line); the plan at pointer-down: ${ms(planning)}; a frame (${offsets.length} offsets, ${Math.round(drawn / (MEASURED * offsets.length))} pieces each on average): ${ms(frame)}`)
console.log(`  the release: the edit built ${ms(releaseEdit)}, then committed and normalised by commitEdit ${ms(releaseNormalised)}; the sheet index taking its delta (${committed.added.length} added, ${committed.removed.length} removed, ${pinsMoved.length} pins moved) and answering on the touched lines: ${ms(sheetDelta)}`)
console.log("")
check(`a drag's plan at pointer-down on ${gridWires.length} segments`, planning, 0.2)
check(`a drag frame on ${gridWires.length} segments, ${carriedParts.length} parts carried`, frame, 0.15)
check(`a drag's release turned into an edit on ${gridWires.length} segments`, releaseEdit, 0.5)
check(`the sheet index taking a release's delta on ${gridWires.length} segments`, sheetDelta, 1)
check(`the sheet index built for ${large.n} overlapping segments on one line`, onOneLine, 200)
const [stand] = stressDocuments([67])
const standWiring = wiringOf(new WireGraph(), stand)
void standWiring.sheet
const standIndex = new SpatialIndex(stand.objects, CELL)
const standPart = stand.objects.find((o) => o.def === "resistor")!
const carriedPart = { objects: new Set([standPart.id]) }
const dragBuilt = time(() => new PartDrag(stand, standWiring, carriedPart, { index: standIndex }), 15)
const dragBuiltAlone = time(() => new PartDrag(stand, standWiring, carriedPart), 15)
const standDrag = new PartDrag(stand, standWiring, carriedPart, { index: standIndex })
const standFrames: number[] = []
for (let round = 0; round < 25; round++)
  for (let dx = -4; dx <= 4; dx++) {
    const started = performance.now()
    standDrag.frame(dx * CELL, (round % 5) * CELL + CELL)
    if (round >= 5) standFrames.push(performance.now() - started)
  }
const standFrame = median(standFrames)
const standLanded = time(() => standDrag.landed(CELL, 2 * CELL), 9)
const pressed = time(() => new TurnRun(stand, standWiring, carriedPart.objects, standIndex).turned(1), 9)
const storeGraph = new WireGraph()
const secondPresses: number[] = []
for (let i = 0; i < 7; i++) {
  const live = wiringOf(storeGraph, stand)
  void live.sheet
  const run = new TurnRun(stand, live, carriedPart.objects, standIndex)
  const first = run.turned(1)
  void wiringOf(storeGraph, first.doc).sheet
  const started = performance.now()
  run.turned(1)
  secondPresses.push(performance.now() - started)
}
const pressedAgain = median(secondPresses.slice(1))
const standPin = standWiring.pins.find((p) => p.key.startsWith(`${standPart.id}:`))!
const started = startDrawing(standWiring, drawEndAt(standWiring, standPin.at))
const drawing = isRefusal(started) ? null : started
const previewed = drawing ? time(() => previewOf(stand, standWiring, pointerAt(drawing, { x: standPin.at.x + 5 * CELL, y: standPin.at.y + 3 * CELL })), 25) : Infinity
const hovered: Schematic = {
  ...stand,
  objects: [
    ...stand.objects,
    { id: "hoverA", def: "resistor", x: -40 * CELL, y: 0, props: { ref: "RA" } },
    { id: "hoverBlock", def: "resistor", x: -33 * CELL, y: -1 * CELL, rotation: 90, props: { ref: "RX" } },
    { id: "hoverB", def: "resistor", x: -30 * CELL, y: 0, props: { ref: "RB" } },
  ],
}
const hoverWiring = wiringOf(new WireGraph(), hovered)
const hoverIndex = new SpatialIndex(hovered.objects, CELL)
const hoverStart = startDrawing(hoverWiring, drawEndAt(hoverWiring, { x: -36 * CELL, y: CELL }))
const hoverTarget = drawEndAt(hoverWiring, { x: -30 * CELL, y: CELL })
const hoverDrawing = isRefusal(hoverStart) ? null : pointerAt(hoverStart, { x: -30 * CELL, y: CELL })
let firstHover = Infinity
if (hoverDrawing) {
  const started = performance.now()
  previewOf(hovered, hoverWiring, hoverDrawing, hoverTarget, (area) => hoverIndex.query(area))
  firstHover = performance.now() - started
}
const hoverRouted = hoverDrawing ? previewOf(hovered, hoverWiring, hoverDrawing, hoverTarget, (area) => hoverIndex.query(area)).routed : false
const hovering = hoverDrawing ? time(() => previewOf(hovered, hoverWiring, hoverDrawing, hoverTarget, (area) => hoverIndex.query(area)), 25) : Infinity
console.log(`\nEditing on a sheet of ${stand.objects.length} objects and ${stand.wires.length} segments (median of warm runs)\n`)
console.log(`  a part's drag set up: ${ms(dragBuilt)} with the field's index (${ms(dragBuiltAlone)} building its own); a frame: ${ms(standFrame)}; the drop: ${ms(standLanded)}; a press of R: ${ms(pressed)}, the next press of the same run once the store took the first: ${ms(pressedAgain)}; a drawing's preview: ${ms(previewed)}; over a target pin whose plain L crosses a body${hoverRouted ? "" : " (NOT ROUTED)"}: ${ms(hovering)} each move after the first (${ms(firstHover)})`)
console.log("")
check(`a part's drag set up on ${stand.objects.length} objects, the field's index given`, dragBuilt, 2)
check(`a drag frame on ${stand.objects.length} objects, one part carried`, standFrame, 0.3)
check(`a part's drop on ${stand.objects.length} objects`, standLanded, 8)
check(`a press of R on ${stand.objects.length} objects`, pressed, 7)
check(`the next press of a run on ${stand.objects.length} objects`, pressedAgain, 180)
check(`a drawing's preview on ${stand.objects.length} objects`, previewed, 2)
check(`a preview over a target pin on ${stand.objects.length} objects, each move after the first`, hoverRouted ? hovering : Infinity, 2)
console.log(`\n${checked - failed}/${checked} checks passed`)
if (failed) process.exitCode = 1
