import { wirePins } from "@/schematic/migrate-wires"
import type { Point, Schematic } from "@/schematic/types"
import { wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { netChanges } from "@/schematic/net-names"

const contains = (s: WireSegment, p: Point) =>
  s.a.y === s.b.y ? p.y === s.a.y && p.x >= Math.min(s.a.x, s.b.x) && p.x <= Math.max(s.a.x, s.b.x) : p.x === s.a.x && p.y >= Math.min(s.a.y, s.b.y) && p.y <= Math.max(s.a.y, s.b.y)

export function unexplainedJoins(before: Schematic, after: Schematic, carried: ReadonlySet<string>): string[][] {
  const was = wiringOf(new WireGraph(), before)
  const now = wiringOf(new WireGraph(), after)
  const groupOf = new Map<string, number>()
  was.circuit.nets.forEach((g, i) => g.forEach((k) => groupOf.set(k, i)))
  const parent = was.circuit.nets.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const owner = (key: string) => key.slice(0, key.indexOf(":"))
  const oldPins = wirePins(before.objects)
  for (const pin of wirePins(after.objects)) {
    if (!carried.has(owner(pin.key))) continue
    const own = groupOf.get(pin.key)
    const there: (number | undefined)[] = oldPins.filter((q) => !carried.has(owner(q.key)) && q.at.x === pin.at.x && q.at.y === pin.at.y).map((q) => groupOf.get(q.key))
    for (const s of before.wires) {
      if (!contains(s, pin.at)) continue
      const net = was.view.netOfSegment(s.id)
      const keys = net === undefined ? [] : was.view.pinsOf(net)
      there.push(keys.length ? groupOf.get(keys[0]) : undefined)
    }
    for (const g of there) if (own !== undefined && g !== undefined) parent[find(own)] = find(g)
  }
  return netChanges(was.circuit.nets, now.circuit.nets)
    .joined.filter((j) => new Set(j.from.map((g) => find(groupOf.get(g[0])!))).size > 1)
    .map((j) => j.from.map((g) => g.join("+")))
}
