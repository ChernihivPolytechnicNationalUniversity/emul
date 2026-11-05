import { getDef, getPin, pinName } from "./registry"
import type { PlacedObject } from "./types"

export type PinGroup = readonly string[]

export type NetJoin = { readonly from: readonly PinGroup[]; readonly into: PinGroup }

export type NetSplit = { readonly from: PinGroup; readonly into: readonly PinGroup[] }

export type NetChange = { readonly joined: readonly NetJoin[]; readonly split: readonly NetSplit[] }

export const NO_CHANGE: NetChange = { joined: [], split: [] }

function groupsBy(groups: readonly PinGroup[]): Map<string, PinGroup> {
  const of = new Map<string, PinGroup>()
  for (const group of groups) for (const key of group) of.set(key, group)
  return of
}

function reached(group: PinGroup, of: ReadonlyMap<string, PinGroup>): PinGroup[] {
  const found = new Set<PinGroup>()
  for (const key of group) {
    const other = of.get(key)
    if (other) found.add(other)
  }
  return [...found]
}

export function netChanges(before: readonly PinGroup[], after: readonly PinGroup[]): NetChange {
  const stayed = new Set(after)
  const existed = new Set(before)
  const gone = before.filter((g) => !stayed.has(g))
  const born = after.filter((g) => !existed.has(g))
  if (!gone.length && !born.length) return NO_CHANGE
  const goneOf = groupsBy(gone)
  const bornOf = groupsBy(born)
  const joined: NetJoin[] = []
  for (const into of born) {
    const from = reached(into, goneOf)
    if (from.length >= 2) joined.push({ from, into })
  }
  const split: NetSplit[] = []
  for (const from of gone) {
    const into = reached(from, bornOf)
    if (into.length >= 2) split.push({ from, into })
  }
  return joined.length || split.length ? { joined, split } : NO_CHANGE
}

const refOf = (key: string) => {
  const at = key.indexOf(":")
  return { object: key.slice(0, at), pin: key.slice(at + 1) }
}

type Named = { name: string; rank: number }

function named(objects: readonly PlacedObject[], group: PinGroup): Named {
  const byId = new Map(objects.map((o) => [o.id, o]))
  let rail: string | undefined
  for (const key of group) {
    const ref = refOf(key)
    const object = byId.get(ref.object)
    const def = object && getDef(object.def)
    if (!def) continue
    if (getPin(def, ref.pin)?.kind === "gnd") return { name: "GND", rank: 0 }
    if (def.id === "supply") rail ??= object.props?.value || def.defaults?.value
  }
  if (rail) return { name: rail, rank: 1 }
  const names = group.map((key) => pinName(objects as PlacedObject[], refOf(key))).sort(byName)
  return { name: names[0] ?? "?", rank: 2 }
}

const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true })

export const netName = (objects: readonly PlacedObject[], group: PinGroup): string => named(objects, group).name

function listed(names: readonly Named[]): string {
  const ordered = [...names].sort((a, b) => a.rank - b.rank || byName(a.name, b.name)).map((n) => n.name)
  return ordered.length < 2 ? (ordered[0] ?? "") : `${ordered.slice(0, -1).join(", ")} and ${ordered.at(-1)}`
}

function putInSeries(objects: readonly PlacedObject[], split: NetSplit): string | null {
  if (split.into.length !== 2) return null
  const before = new Set(split.from)
  const ownersIn = (group: PinGroup) => new Set(group.filter((key) => !before.has(key)).map((key) => refOf(key).object))
  const [left, right] = split.into.map(ownersIn)
  const bridging = [...left].filter((id) => right.has(id))
  if (bridging.length !== 1) return null
  const [part] = bridging
  const object = objects.find((o) => o.id === part)
  const sides = split.into.map((g) => g.filter((key) => refOf(key).object !== part))
  if (!object || sides.some((side) => !side.length)) return null
  return `${object.props?.ref || part} put in series between ${listed(sides.map((side) => named(objects, side)))}`
}

export function changeMessage(objects: readonly PlacedObject[], change: NetChange): string | null {
  const lines = [
    ...change.joined.map((j) => `${listed(j.from.map((g) => named(objects, g)))} joined`),
    ...change.split.map((s) => putInSeries(objects, s) ?? `${listed(s.into.map((g) => named(objects, g)))} split apart`),
  ]
  return lines.length ? lines.join("; ") : null
}
