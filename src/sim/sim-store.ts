import * as React from "react"
import type { Damage, PartState } from "@/schematic/types"
import type { Reading } from "./engine"
import type { DisplayFrame, SimReadout } from "./use-simulation"

type LivePart = PartState & { level: number }

export type ObjectSim = {
  live: boolean
  parts: Record<string, LivePart>
  damage: Damage | undefined
  display: DisplayFrame | undefined
  readings: readonly Reading[]
}

const NO_PARTS: Record<string, LivePart> = {}
const NO_READINGS: readonly Reading[] = []

const blank = (live: boolean): ObjectSim => ({ live, parts: NO_PARTS, damage: undefined, display: undefined, readings: NO_READINGS })
const BLANK_IDLE = blank(false)
const BLANK_LIVE = blank(true)

const isBlank = (view: ObjectSim) =>
  view.parts === NO_PARTS && view.damage === undefined && view.display === undefined && view.readings === NO_READINGS

function samePart(a: LivePart, b: LivePart) {
  return a.level === b.level && a.on === b.on && a.pressed === b.pressed && a.x === b.x && a.y === b.y
}

function sameParts(a: Record<string, LivePart>, b: Record<string, LivePart>) {
  if (a === b) return true
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    const other = b[key]
    if (!other || !samePart(a[key], other)) return false
  }
  return true
}

const same = (a: ObjectSim, b: ObjectSim) =>
  a.live === b.live && a.damage === b.damage && a.display === b.display && a.readings === b.readings && sameParts(a.parts, b.parts)

function indexPartsByObject(parts: Record<string, LivePart>) {
  const byObject = new Map<string, Record<string, LivePart>>()
  for (const [key, value] of Object.entries(parts)) {
    const objectId = key.slice(0, key.indexOf(":"))
    const own = byObject.get(objectId)
    if (own) own[key] = value
    else byObject.set(objectId, { [key]: value })
  }
  return byObject
}

export class SimStore {
  private readout: SimReadout | null = null
  private live = false
  private partsByObject = new Map<string, Record<string, LivePart>>()
  private views = new Map<string, ObjectSim>()
  private listeners = new Map<string, Set<() => void>>()

  push(next: SimReadout) {
    const wasLive = this.live
    this.readout = next
    this.live = next.live
    this.partsByObject = next.live ? indexPartsByObject(next.parts) : new Map()

    const touched = new Set<string>(this.views.keys())
    for (const id of this.partsByObject.keys()) touched.add(id)
    for (const id of Object.keys(next.damage)) touched.add(id)
    for (const id of touched) this.refresh(id)
    if (wasLive !== this.live) for (const id of this.listeners.keys()) if (!touched.has(id)) this.notify(id)
  }

  subscribe(objectId: string, listener: () => void) {
    const set = this.listeners.get(objectId)
    if (set) set.add(listener)
    else this.listeners.set(objectId, new Set([listener]))
    this.refresh(objectId)
    return () => {
      const current = this.listeners.get(objectId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) {
        this.listeners.delete(objectId)
        this.views.delete(objectId)
      }
    }
  }

  viewOf(objectId: string): ObjectSim {
    return this.views.get(objectId) ?? (this.live ? BLANK_LIVE : BLANK_IDLE)
  }

  private refresh(objectId: string) {
    const next = this.build(objectId)
    if (same(this.viewOf(objectId), next)) return
    if (isBlank(next)) this.views.delete(objectId)
    else this.views.set(objectId, next)
    this.notify(objectId)
  }

  private notify(objectId: string) {
    const set = this.listeners.get(objectId)
    if (!set) return
    for (const listener of set) listener()
  }

  private build(objectId: string): ObjectSim {
    const readout = this.readout
    if (!readout?.live) return this.live ? BLANK_LIVE : BLANK_IDLE
    const readings = readout.readings(objectId)
    return {
      live: true,
      parts: this.partsByObject.get(objectId) ?? NO_PARTS,
      damage: readout.damage[objectId],
      display: readout.display(objectId),
      readings: readings.length ? readings : NO_READINGS,
    }
  }
}

export function useObjectSim(store: SimStore, objectId: string): ObjectSim {
  const subscribe = React.useCallback((listener: () => void) => store.subscribe(objectId, listener), [store, objectId])
  const read = React.useCallback(() => store.viewOf(objectId), [store, objectId])
  return React.useSyncExternalStore(subscribe, read)
}
