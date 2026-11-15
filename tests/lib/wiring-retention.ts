import "../../scripts/lib/all-parts"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { setImmediate } from "node:timers/promises"
import { withSegments, wiringOf } from "../../src/schematic/wire-edits"
import { GRID } from "../../src/schematic/grid"
import { WireGraph } from "../../src/schematic/wires/graph"
import type { Schematic } from "../../src/schematic/types"
import type { WireSegment } from "../../src/schematic/wires/segment"

function committedRun() {
  let doc: Schematic = { objects: [], wires: Array.from({ length: 250 }, (_, i) => ({ id: `w${i}`, a: { x: 0, y: i * 2 * GRID }, b: { x: GRID, y: i * 2 * GRID } })), parts: {} }
  const graph = new WireGraph()
  const lists: WeakRef<readonly WireSegment[]>[] = []
  const segments: WeakRef<WireSegment>[] = []
  wiringOf(graph, doc)
  for (let i = 0; i < 160; i++) {
    lists.push(new WeakRef(doc.wires))
    if (i) segments.push(new WeakRef(doc.wires[0]))
    const source = doc.wires[0]
    const segment = { ...source, b: { x: (i + 2) * GRID, y: source.b.y } }
    doc = withSegments(doc, [segment], [source])
    wiringOf(graph, doc)
  }
  return { doc, graph, lists, segments }
}

export async function retainedAfterCommits() {
  setFlagsFromString("--expose_gc")
  const collect = runInNewContext("gc") as () => void
  setFlagsFromString("--no-expose-gc")
  const held = committedRun()
  for (let i = 0; i < 4; i++) {
    await setImmediate()
    collect()
  }
  return { lists: held.lists.filter((ref) => ref.deref()).length, segments: held.segments.filter((ref) => ref.deref()).length, latest: wiringOf(held.graph, held.doc).runs.length }
}
