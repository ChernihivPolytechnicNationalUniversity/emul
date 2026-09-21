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
}

const NO_PARTS: Record<string, LivePart> = {}
const NO_READINGS: readonly Reading[] = []
const IDLE: ObjectSim = { live: false, parts: NO_PARTS, damage: undefined, display: undefined }

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

const sameView = (a: ObjectSim, b: ObjectSim) =>
  a.live === b.live && a.damage === b.damage && a.display === b.display && sameParts(a.parts, b.parts)

const sameReading = (a: Reading, b: Reading) =>
  a.element === b.element &&
  a.voltage === b.voltage &&
  a.current === b.current &&
  a.power === b.power &&
  a.rms?.voltage === b.rms?.voltage &&
  a.rms?.current === b.rms?.current &&
  a.rms?.power === b.rms?.power

function sameReadings(a: readonly Reading[], b: readonly Reading[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!sameReading(a[i], b[i])) return false
  return true
}

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

type Listeners = Map<string, Set<() => void>>

function listen(listeners: Listeners, objectId: string, listener: () => void) {
  const set = listeners.get(objectId)
  if (set) set.add(listener)
  else listeners.set(objectId, new Set([listener]))
  return () => {
    const current = listeners.get(objectId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(objectId)
  }
}

export class SimStore {
  private readout: SimReadout | null = null
  private partsByObject = new Map<string, Record<string, LivePart>>()
  private views = new Map<string, ObjectSim>()
  private readings = new Map<string, readonly Reading[]>()
  private viewListeners: Listeners = new Map()
  private readingListeners: Listeners = new Map()

  push(next: SimReadout) {
    this.readout = next
    this.partsByObject = next.live ? indexPartsByObject(next.parts) : new Map()
    for (const id of this.viewListeners.keys()) this.refresh(id)
    for (const id of this.readingListeners.keys()) if (!this.viewListeners.has(id)) this.refresh(id)
  }

  subscribe(objectId: string, listener: () => void) {
    const stop = listen(this.viewListeners, objectId, listener)
    this.refresh(objectId)
    return () => {
      stop()
      if (!this.viewListeners.has(objectId)) this.views.delete(objectId)
    }
  }

  subscribeReadings(objectId: string, listener: () => void) {
    const stop = listen(this.readingListeners, objectId, listener)
    this.refresh(objectId)
    return () => {
      stop()
      if (!this.readingListeners.has(objectId)) this.readings.delete(objectId)
    }
  }

  viewOf(objectId: string): ObjectSim {
    return this.views.get(objectId) ?? IDLE
  }

  readingsOf(objectId: string): readonly Reading[] {
    return this.readings.get(objectId) ?? NO_READINGS
  }

  private refresh(objectId: string) {
    let changed = false
    if (this.viewListeners.has(objectId)) {
      const next = this.buildView(objectId)
      if (!sameView(this.viewOf(objectId), next)) {
        this.views.set(objectId, next)
        changed = true
      }
    }
    if (this.readingListeners.has(objectId)) {
      const next = this.readout?.live ? this.readout.readings(objectId) : NO_READINGS
      if (!sameReadings(this.readingsOf(objectId), next)) {
        this.readings.set(objectId, next.length ? next : NO_READINGS)
        changed = true
      }
    }
    if (changed) this.notify(objectId)
  }

  private notify(objectId: string) {
    for (const set of [this.viewListeners.get(objectId), this.readingListeners.get(objectId)]) {
      if (set) for (const listener of set) listener()
    }
  }

  private buildView(objectId: string): ObjectSim {
    const readout = this.readout
    if (!readout?.live) return IDLE
    return {
      live: true,
      parts: this.partsByObject.get(objectId) ?? NO_PARTS,
      damage: readout.damage[objectId],
      display: readout.display(objectId),
    }
  }
}

export function useObjectSim(store: SimStore, objectId: string): ObjectSim {
  const subscribe = React.useCallback((listener: () => void) => store.subscribe(objectId, listener), [store, objectId])
  const read = React.useCallback(() => store.viewOf(objectId), [store, objectId])
  return React.useSyncExternalStore(subscribe, read)
}

export function useObjectReadings(store: SimStore, objectId: string): readonly Reading[] {
  const subscribe = React.useCallback((listener: () => void) => store.subscribeReadings(objectId, listener), [store, objectId])
  const read = React.useCallback(() => store.readingsOf(objectId), [store, objectId])
  return React.useSyncExternalStore(subscribe, read)
}
