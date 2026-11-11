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
