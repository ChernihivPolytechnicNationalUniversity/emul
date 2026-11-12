import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readProjectFile } from "@/project/project-store"
import { bodiesOf, crossedBody } from "@/schematic/body-crossing"
import { wirePins } from "@/schematic/migrate-wires"
import { withLibrary } from "@/schematic/registry"
import type { Point, Schematic } from "@/schematic/types"
import { junctionsOf, wireNets } from "@/schematic/wires/graph"
import { joiningContactsOfNcPads, pinPartition } from "../lib/pin-partition"
import { geometryOf, normalFormViolations } from "../lib/wire-reference"

const CORPUS = join(homedir(), "tmp", "emul-p3-corpus")
const REALISTIC = (name: string) => !name.startsWith("c--")

const interior = (s: { a: Point; b: Point }, p: Point) =>
  s.a.y === s.b.y ? p.y === s.a.y && p.x > Math.min(s.a.x, s.b.x) && p.x < Math.max(s.a.x, s.b.x) : p.x === s.a.x && p.y > Math.min(s.a.y, s.b.y) && p.y < Math.max(s.a.y, s.b.y)

function cycles(wires: Schematic["wires"]): number {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    while (parent.get(k) !== k) k = parent.get(k)!
    return k
  }
  let n = 0
  for (const s of wires) {
    const ends = [`${s.a.x},${s.a.y}`, `${s.b.x},${s.b.y}`]
    for (const k of ends) if (!parent.has(k)) parent.set(k, k)
    const [ra, rb] = ends.map(find)
    if (ra === rb) n++
    else parent.set(ra, rb)
  }
  return n
}

describe.skipIf(!existsSync(CORPUS) || !process.env.RUN_CORPUS)("review A: the 1 053 base-written documents (~/tmp/emul-p3-corpus) at the head", () => {
  it(
    "each opens with the circuit the base froze, in normal form, the same on a second read; the realistic ones with nothing through a body, no socket passed across its row and no dot on a two-pin net",
    async () => {
      const index = JSON.parse(readFileSync(join(CORPUS, "index.json"), "utf8")) as { name: string; document: string; partition: string }[]
      const wrong: string[] = []
      let read = 0
      for (const entry of index) {
        const bytes = readFileSync(join(CORPUS, entry.document))
        const opened = await readProjectFile(new Blob([bytes]))
        if (!opened) {
          wrong.push(`${entry.name}: does not read`)
          continue
        }
        read++
        const doc = opened.doc
        const fixture = JSON.parse(readFileSync(join(CORPUS, entry.partition), "utf8")) as { nets: string[][] }
        withLibrary(doc.library, () => {
          if (JSON.stringify(pinPartition(doc)) !== JSON.stringify(joiningContactsOfNcPads(fixture.nets, doc.objects))) wrong.push(`${entry.name}: the circuit changed`)
          const pins = wirePins(doc.objects)
          const nf = normalFormViolations(doc.wires, pins)
          if (nf.length) wrong.push(`${entry.name}: ${nf[0]}`)
          if (!REALISTIC(entry.name)) return
          const bodies = bodiesOf(doc.objects)
          for (const s of doc.wires) if (crossedBody(s, bodies)) wrong.push(`${entry.name}: a wire through a body`)
          for (const s of doc.wires) for (const p of pins) if (p.socket && interior(s, p.at) && !(p.out && (s.a.y === s.b.y ? p.out.y === 0 : p.out.x === 0))) wrong.push(`${entry.name}: ${p.key} passed across its row`)
          const view = wireNets(doc.wires, pins)
          for (const dot of junctionsOf(view)) {
            const s = doc.wires.find((w) => (w.a.x === dot.x && w.a.y === dot.y) || (w.b.x === dot.x && w.b.y === dot.y))
            const net = s && view.netOfSegment(s.id)
            if (net && view.pinsOf(net).length === 2) wrong.push(`${entry.name}: a dot on a two-pin net at (${dot.x / 24}, ${dot.y / 24})`)
          }
          if (cycles(doc.wires) && entry.name !== "b--corridor-one-net") wrong.push(`${entry.name}: a loop`)
        })
        const again = await readProjectFile(new Blob([bytes]))
        if (again && JSON.stringify(geometryOf(again.doc.wires)) !== JSON.stringify(geometryOf(doc.wires))) wrong.push(`${entry.name}: a second read lays it differently`)
      }
      expect.soft(read, "every document reads").toBe(index.length)
      expect.soft(wrong, "every document keeps its circuit and opens clean").toEqual([])
    },
    3_600_000,
  )
})
