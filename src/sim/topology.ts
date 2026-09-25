import type { Schematic } from "@/schematic/types"

export type Topology = Pick<Schematic, "objects" | "wires" | "library">

export function sameTopology(a: Topology, b: Topology) {
  if (a.objects.length !== b.objects.length || a.wires.length !== b.wires.length) return false
  const la = a.library ?? []
  const lb = b.library ?? []
  if (la.length !== lb.length) return false
  for (let i = 0; i < la.length; i++) if (la[i]!.id !== lb[i]!.id || la[i]!.built !== lb[i]!.built || la[i]!.name !== lb[i]!.name) return false
  for (let i = 0; i < a.objects.length; i++) {
    const x = a.objects[i]
    const y = b.objects[i]
    if (x === y) continue
    if (x.id !== y.id || x.def !== y.def || x.props !== y.props) return false
  }
  for (let i = 0; i < a.wires.length; i++) {
    const x = a.wires[i]
    const y = b.wires[i]
    if (x === y) continue
    if (x.id !== y.id) return false
    if (x.from.object !== y.from.object || x.from.pin !== y.from.pin) return false
    if (x.to.object !== y.to.object || x.to.pin !== y.to.pin) return false
  }
  return true
}

export class TopologyGate {
  private sent: Topology | null = null
  private contacts: ReadonlyMap<string, string> | null = null

  latest(next: Topology, contacts: ReadonlyMap<string, string>): Topology {
    if (this.sent && this.contacts === contacts && sameTopology(this.sent, next)) return this.sent
    this.sent = next
    this.contacts = contacts
    return next
  }
}
