import { objectPins, pinContacts } from "./geometry"
import { pinKey, type PinKind, type PlacedObject, type Wire } from "./types"

export type NetMap = {
  netOfPin: (key: string) => string | undefined
  netOfWire: (wireId: string) => string | undefined
  wiresOf: (net: string) => readonly string[]
  pinsOf: (net: string) => readonly string[]
  kindsOf: (net: string) => ReadonlySet<PinKind>
  nets: readonly string[]
}

const EMPTY_KINDS: ReadonlySet<PinKind> = new Set()
const EMPTY_LIST: readonly string[] = []

export const emptyNets = (): NetMap => ({
  netOfPin: () => undefined,
  netOfWire: () => undefined,
  wiresOf: () => EMPTY_LIST,
  pinsOf: () => EMPTY_LIST,
  kindsOf: () => EMPTY_KINDS,
  nets: EMPTY_LIST,
})

export function buildNets(objects: readonly PlacedObject[], wires: readonly Wire[], grid: number): NetMap {
  const kindOfPin = new Map<string, PinKind>()
  for (const obj of objects) {
    for (const { key, pin } of objectPins(obj, grid)) kindOfPin.set(key, pin.kind)
  }

  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let p = parent.get(k)
    if (p === undefined) {
      parent.set(k, k)
      return k
    }
    if (p !== k) {
      p = find(p)
      parent.set(k, p)
    }
    return p
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const [key, root] of pinContacts(objects, grid)) union(key, root)
  for (const w of wires) union(pinKey(w.from.object, w.from.pin), pinKey(w.to.object, w.to.pin))

  const wiresOf = new Map<string, string[]>()
  const pinsOf = new Map<string, string[]>()
  const kindsOf = new Map<string, Set<PinKind>>()
  const netOfWire = new Map<string, string>()
  const nets: string[] = []

  const push = <T>(map: Map<string, T[]>, net: string, value: T) => {
    const list = map.get(net)
    if (list) list.push(value)
    else map.set(net, [value])
  }

  for (const key of parent.keys()) {
    const net = find(key)
    push(pinsOf, net, key)
    const kind = kindOfPin.get(key)
    if (kind && kind !== "nc") {
      const set = kindsOf.get(net)
      if (set) set.add(kind)
      else kindsOf.set(net, new Set([kind]))
    }
  }
  for (const w of wires) {
    const net = find(pinKey(w.from.object, w.from.pin))
    netOfWire.set(w.id, net)
    if (!wiresOf.has(net)) nets.push(net)
    push(wiresOf, net, w.id)
  }

  return {
    netOfPin: (key) => (parent.has(key) ? find(key) : undefined),
    netOfWire: (id) => netOfWire.get(id),
    wiresOf: (net) => wiresOf.get(net) ?? EMPTY_LIST,
    pinsOf: (net) => pinsOf.get(net) ?? EMPTY_LIST,
    kindsOf: (net) => kindsOf.get(net) ?? EMPTY_KINDS,
    nets,
  }
}
