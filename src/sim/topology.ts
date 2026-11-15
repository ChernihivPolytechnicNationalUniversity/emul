import type { Circuit, FlowGraph } from "@/schematic/circuit"

function sameNets(a: Circuit["nets"], b: Circuit["nets"]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.length !== y.length) return false
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false
  }
  return true
}

const sameList = (a: readonly string[], b: readonly string[]) => a === b || (a.length === b.length && a.every((v, i) => v === b[i]))

export function sameTopology(a: Circuit, b: Circuit) {
  if (a.objects.length !== b.objects.length) return false
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
  return sameNets(a.nets, b.nets) && sameList(a.wired, b.wired)
}

export function sameFlow(a: FlowGraph, b: FlowGraph) {
  if (a === b) return true
  if (a.runs.length !== b.runs.length) return false
  for (let i = 0; i < a.runs.length; i++) {
    const x = a.runs[i]
    const y = b.runs[i]
    if (x.id !== y.id || x.a !== y.a || x.b !== y.b) return false
  }
  const ka = Object.keys(a.pins)
  if (ka.length !== Object.keys(b.pins).length) return false
  return ka.every((k) => a.pins[k] === b.pins[k])
}

export class TopologyGate {
  private sent: Circuit | null = null

  latest(next: Circuit): Circuit {
    if (this.sent && sameTopology(this.sent, next)) return this.sent
    this.sent = next
    return next
  }
}

export class FlowGate {
  private sent: FlowGraph | null = null

  latest(next: FlowGraph): FlowGraph {
    if (this.sent && sameFlow(this.sent, next)) return this.sent
    this.sent = next
    return next
  }
}
