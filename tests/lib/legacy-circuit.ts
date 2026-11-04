import type { Circuit } from "@/schematic/circuit"
import { GRID } from "@/schematic/geometry"
import { legacyNets } from "@/schematic/nets"
import type { LegacySchematic } from "@/schematic/types"

export function legacyCircuit(doc: LegacySchematic): Circuit {
  const nets = legacyNets(doc.objects, doc.wires, GRID)
  const groups = new Map<string, string[]>()
  for (const net of nets.nets.length ? [...new Set([...nets.nets, ...[...nets.contacts.values()].map((k) => nets.netOfPin(k)!)])] : [...new Set([...nets.contacts.values()].map((k) => nets.netOfPin(k)!))]) groups.set(net, [...nets.pinsOf(net)])
  return {
    objects: doc.objects,
    library: doc.library,
    nets: [...groups.values()].filter((g) => g.length > 1).map((g) => [...g].sort()),
    wired: [...new Set(doc.wires.flatMap((w) => [`${w.from.object}:${w.from.pin}`, `${w.to.object}:${w.to.pin}`]))],
    flow: { runs: [], pins: {} },
  }
}
