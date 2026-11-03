import * as React from "react"
import { getDef } from "@/schematic/registry"

// The parts a student placed lately and the ones they starred, kept in this browser only.
// Two strips, not one adaptive list: the palette's own order never moves under the pointer.

const RECENT_KEY = "emul.palette.recent"
const FAVOURITE_KEY = "emul.palette.favourites"
export const RECENT_KEEP = 12

/** Saved ids that are still parts; anything else in storage is ignored. */
export function readIds(raw: string | null): string[] {
  try {
    const saved: unknown = JSON.parse(raw ?? "[]")
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string" && getDef(id) !== undefined) : []
  } catch {
    return []
  }
}

export const pushRecent = (ids: readonly string[], id: string): string[] => [id, ...ids.filter((x) => x !== id)].slice(0, RECENT_KEEP)

export const toggleFavourite = (ids: readonly string[], id: string): string[] => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])

type Lists = { recent: readonly string[]; favourites: readonly string[] }

const load = (key: string) => {
  try {
    return readIds(localStorage.getItem(key))
  } catch {
    return []
  }
}

let lists: Lists | null = null
const listeners = new Set<() => void>()

const current = (): Lists => (lists ??= { recent: load(RECENT_KEY), favourites: load(FAVOURITE_KEY) })

function save(next: Lists) {
  lists = next
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next.recent))
    localStorage.setItem(FAVOURITE_KEY, JSON.stringify(next.favourites))
  } catch {
    // Storage full or off: the lists still work until the page reloads.
  }
  listeners.forEach((notify) => notify())
}

/** A part placed from the palette, by any route: a click, a drop, Enter. */
export const notePlaced = (id: string) => save({ ...current(), recent: pushRecent(current().recent, id) })

export const flipFavourite = (id: string) => save({ ...current(), favourites: toggleFavourite(current().favourites, id) })

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const EMPTY: Lists = { recent: [], favourites: [] }

export function useQuickLists(): Lists {
  return React.useSyncExternalStore(subscribe, current, () => EMPTY)
}
