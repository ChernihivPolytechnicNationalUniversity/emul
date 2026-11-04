import type { PlacedObject } from "./types"

export type PinGroup = readonly string[]

export type NetJoin = { readonly from: readonly PinGroup[]; readonly into: PinGroup }

export type NetSplit = { readonly from: PinGroup; readonly into: readonly PinGroup[] }

export type NetChange = { readonly joined: readonly NetJoin[]; readonly split: readonly NetSplit[] }

export const NO_CHANGE: NetChange = { joined: [], split: [] }

const unbuilt = (what: string): never => {
  throw new Error(`${what} is not built yet`)
}

export function netChanges(_before: readonly PinGroup[], _after: readonly PinGroup[]): NetChange {
  return unbuilt("netChanges")
}

export function netName(_objects: readonly PlacedObject[], _group: PinGroup): string {
  return unbuilt("netName")
}

export function changeMessage(_objects: readonly PlacedObject[], _change: NetChange): string | null {
  return unbuilt("changeMessage")
}
