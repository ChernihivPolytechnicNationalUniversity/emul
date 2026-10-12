import { RELEASE_HIGH, RELEASE_HOLDS, RELEASE_LOW, READS_ONLY_THE_CIRCUIT, readbackCode, type ReleaseLevel } from "@/mcu/periph/gpio"
import { R_PULL, switchClosed } from "./engine"
import { GROUND, type GpioState, type Netlist, type Resolved } from "./netlist"
import { partKey, type PartState } from "@/schematic/types"

export const RELEASE_SETTLES_WITHIN = 1e-6

export type ReleaseKind = "pullup" | "pulldown" | "floating"

export type PadSurroundings = {
  bare: boolean
  capacitance: number
  conductance: number
  ownPull: number
}

export function releaseKind(drive: GpioState | undefined): ReleaseKind | null {
  if (drive === "pullup") return "pullup"
  if (drive === "pulldown") return "pulldown"
  if (drive === null) return "floating"
  return null
}

export class PadRelease {
  private readonly around: PadSurroundings
  private readonly seen: Record<ReleaseKind, ReleaseLevel | undefined> = { pullup: undefined, pulldown: undefined, floating: undefined }
  lastKind: ReleaseKind = "floating"
  code: number

  constructor(around: PadSurroundings) {
    this.around = around
    this.code = this.encode()
  }

  observe(kind: ReleaseKind, volts: number, high: number, low: number): boolean {
    this.lastKind = kind
    const level = volts > high ? RELEASE_HIGH : volts < low ? RELEASE_LOW : RELEASE_HOLDS
    if (this.seen[kind] === level) return false
    this.seen[kind] = level
    const code = this.encode()
    if (code === this.code) return false
    this.code = code
    return true
  }

  level(kind: ReleaseKind): ReleaseLevel {
    const { bare, capacitance, conductance, ownPull } = this.around
    const pulled = kind !== "floating" && ownPull > 0
    const g = conductance + (pulled ? 1 / ownPull : 0)
    if (!(g > 0) || capacitance / g > RELEASE_SETTLES_WITHIN) return RELEASE_HOLDS
    if (bare) return kind === "pullup" ? RELEASE_HIGH : kind === "pulldown" ? RELEASE_LOW : RELEASE_HOLDS
    const seen = this.seen[kind]
    if (seen !== undefined) return seen
    if (kind === "pullup" && this.seen.floating === RELEASE_HIGH) return RELEASE_HIGH
    if (kind === "pulldown" && this.seen.floating === RELEASE_LOW) return RELEASE_LOW
    return RELEASE_HOLDS
  }

  releasedLevel(): boolean | null {
    const level = this.level(this.lastKind)
    return level === RELEASE_HOLDS ? null : level === RELEASE_HIGH
  }

  private encode() {
    return readbackCode({ pullup: this.level("pullup"), pulldown: this.level("pulldown"), floating: this.level("floating") })
  }
}

export const NO_READBACK = READS_ONLY_THE_CIRCUIT

const terminals = (el: Resolved, net: Netlist): number[] => {
  if (el.kind === "R" || el.kind === "C" || el.kind === "L" || el.kind === "SW") return [el.a, el.b]
  const nodes: number[] = []
  for (const key of el.keys) {
    const node = net.pinNet.get(key) ?? net.nodeNet.get(key)
    if (node !== undefined) nodes.push(node)
  }
  return nodes
}

export class Surroundings {
  private readonly links = new Map<number, number[]>()
  private readonly touching = new Map<number, Resolved[]>()

  constructor(net: Netlist, linkOhms: number, readPart: (key: string) => PartState) {
    for (const el of net.elements) {
      const nodes = terminals(el, net)
      const linked = (el.kind === "SW" && switchClosed(el.closed, readPart(partKey(el.object, el.part)))) || (el.kind === "R" && !el.live && el.value <= linkOhms)
      if (linked && el.kind !== "C") {
        const [a, b] = nodes
        if (a !== GROUND && b !== GROUND && a !== b) {
          this.links.set(a, [...(this.links.get(a) ?? []), b])
          this.links.set(b, [...(this.links.get(b) ?? []), a])
        }
      }
      for (const node of new Set(nodes)) {
        if (node === GROUND) continue
        let list = this.touching.get(node)
        if (!list) this.touching.set(node, (list = []))
        list.push(el)
      }
    }
  }

  of(pad: Extract<Resolved, { kind: "GPIO" }>): PadSurroundings {
    const nodes = new Set([pad.node])
    const queue = [pad.node]
    while (queue.length)
      for (const next of this.links.get(queue.pop()!) ?? []) {
        if (nodes.has(next)) continue
        nodes.add(next)
        queue.push(next)
      }
    const own = (el: Resolved) => el.id === pad.id || el.id.startsWith(`${pad.id}$`)
    const seen = new Set<Resolved>()
    let bare = true
    let capacitance = 0
    let conductance = 0
    for (const node of nodes)
      for (const el of this.touching.get(node) ?? []) {
        if (seen.has(el) || own(el)) continue
        seen.add(el)
        if (el.kind === "SW") continue
        if (el.kind === "C" || el.kind === "R") {
          const inside = nodes.has(el.a) && nodes.has(el.b)
          if (inside) continue
          if (el.kind === "C") capacitance += el.value
          else {
            conductance += 1 / el.value
            bare = false
          }
          continue
        }
        bare = false
      }
    for (const node of nodes)
      for (const el of this.touching.get(node) ?? []) if (own(el) && el.kind === "C") capacitance += el.value
    return { bare, capacitance, conductance, ownPull: pad.pull || R_PULL }
  }
}
