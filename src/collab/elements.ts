import type * as Y from "yjs"
import { ROOM_ELEMENTS } from "emul-shared/room"
import { SCHEMATIC_VERSION, upgradedFrom, type SavedSchematic, type Upgrade } from "@/schematic/migrate"
import type { HdlModule, PartState, PlacedObject, Schematic } from "@/schematic/types"
import type { WireSegment } from "@/schematic/wires/segment"
import { defIds, withLibrary } from "@/schematic/registry"
import { inNormalForm } from "@/schematic/wire-edits"

export const ROOM_VERSION = "version"

export const ROOM_FORMAT = "format"

const FIRST_SHELVED = 4

export const shelfName = (format: number) => (format < FIRST_SHELVED ? ROOM_ELEMENTS : `${ROOM_ELEMENTS}@${format}`)

export function onThisVersion(stored: SavedSchematic | Schematic, stamp: string | undefined): Upgrade & { upgraded: boolean } {
  const version = Number(stamp) || undefined
  if (version !== undefined && version >= SCHEMATIC_VERSION) return { doc: stored as Schematic, notes: [], upgraded: false }
  return { ...upgradedFrom(stored, version), upgraded: true }
}

const FIRMWARE = ["firmware", "firmwareData", "firmwareBuild"] as const

const objectParts = new WeakMap<PlacedObject, { z: number; parts: [string, string][] }>()

function splitObject(o: PlacedObject, z: number): [string, string][] {
  const cached = objectParts.get(o)
  if (cached?.z === z) return cached.parts
  const { project, debug, props, ...rest } = o
  const light: Record<string, string> = {}
  const firmware: Record<string, string> = {}
  for (const [k, v] of Object.entries(props ?? {})) ((FIRMWARE as readonly string[]).includes(k) ? firmware : light)[k] = v
  const parts: [string, string][] = [[`o:${o.id}`, JSON.stringify({ ...rest, props: light, z })]]
  if (project) parts.push([`p:${o.id}`, JSON.stringify(project)])
  if (debug) parts.push([`d:${o.id}`, JSON.stringify(debug)])
  if (Object.keys(firmware).length) parts.push([`f:${o.id}`, JSON.stringify(firmware)])
  objectParts.set(o, { z, parts })
  return parts
}

export function split(doc: Schematic): Map<string, string> {
  const out = new Map<string, string>()
  doc.objects.forEach((o, i) => {
    for (const [k, v] of splitObject(o, i)) out.set(k, v)
  })
  doc.wires.forEach((w, i) => out.set(`w:${w.id}`, JSON.stringify({ ...w, z: i })))
  for (const [k, v] of Object.entries(doc.parts)) out.set(`s:${k}`, JSON.stringify(v))
  doc.library?.forEach((m, i) => out.set(`m:${m.id}`, JSON.stringify({ ...m, z: i })))
  return out
}

type Ordered<T> = T & { z: number }
const byZThenId = <T extends { id: string }>(a: Ordered<T>, b: Ordered<T>) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const unz = <T>(o: Ordered<T>): T => {
  const copy: Partial<Ordered<T>> = { ...o }
  delete copy.z
  return copy as T
}

export function join(elements: ReadonlyMap<string, string>): Schematic {
  const objects: Ordered<PlacedObject>[] = []
  const extra = new Map<string, Partial<PlacedObject> & { firmware?: Record<string, string> }>()
  const wires: Ordered<WireSegment>[] = []
  const library: Ordered<HdlModule>[] = []
  const parts: Record<string, PartState> = {}
  const more = (id: string) => extra.get(id) ?? extra.set(id, {}).get(id)!
  for (const [key, raw] of elements) {
    const at = key.indexOf(":")
    const kind = key.slice(0, at)
    const id = key.slice(at + 1)
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      continue
    }
    if (kind === "o") objects.push(value as Ordered<PlacedObject>)
    else if (kind === "p") more(id).project = value as PlacedObject["project"]
    else if (kind === "d") more(id).debug = value as PlacedObject["debug"]
    else if (kind === "f") more(id).firmware = value as Record<string, string>
    else if (kind === "w") wires.push(value as Ordered<WireSegment>)
    else if (kind === "s") parts[id] = value as PartState
    else if (kind === "m") library.push(value as Ordered<HdlModule>)
  }
  const doc: Schematic = {
    objects: objects.sort(byZThenId).map((o) => {
      const { firmware, ...x } = extra.get(o.id) ?? {}
      const object = unz(o)
      return { ...object, ...x, props: { ...object.props, ...firmware } }
    }),
    wires: wires.sort(byZThenId).map(unz),
    parts,
  }
  if (library.length) doc.library = library.sort(byZThenId).map(unz)
  return doc
}

export type Room = { ydoc: Y.Doc; elements: Y.Map<string>; meta: Y.Map<string> }

export const formatOf = (room: Room) => Number(room.meta.get(ROOM_FORMAT)) || 0

export const newerThanThis = (room: Room) => formatOf(room) > SCHEMATIC_VERSION

export function pushTo(room: Room, doc: Schematic) {
  const next = split(doc)
  room.ydoc.transact(() => {
    for (const [k, v] of next) if (room.elements.get(k) !== v) room.elements.set(k, v)
    for (const k of [...room.elements.keys()]) if (!next.has(k)) room.elements.delete(k)
    if (formatOf(room) < SCHEMATIC_VERSION) room.meta.set(ROOM_FORMAT, String(SCHEMATIC_VERSION))
  })
}

function olderShelf(room: Room): { elements: Y.Map<string>; stamp: string | undefined } | null {
  for (let format = SCHEMATIC_VERSION - 1; format >= FIRST_SHELVED; format--) {
    const elements = room.ydoc.getMap<string>(shelfName(format))
    if (elements.size) return { elements, stamp: String(format) }
  }
  const legacy = room.ydoc.getMap<string>(shelfName(FIRST_SHELVED - 1))
  return legacy.size ? { elements: legacy, stamp: room.meta.get(ROOM_VERSION) } : null
}

const shelvedHere = (room: Room) => room.elements.size > 0 || formatOf(room) >= SCHEMATIC_VERSION

export function roomDefIds(room: Room): string[] {
  const shelf = shelvedHere(room) ? room.elements : olderShelf(room)?.elements
  return shelf ? defIds(join(new Map(shelf.entries()))) : []
}

export function readRoom(room: Room): Upgrade {
  if (shelvedHere(room)) {
    const doc = join(new Map(room.elements.entries()))
    return { doc: withLibrary(doc.library, () => inNormalForm(doc)), notes: [] }
  }
  const older = olderShelf(room)
  if (!older) return { doc: join(new Map()), notes: [] }
  const { upgraded: _upgraded, ...read } = onThisVersion(join(new Map(older.elements.entries())) as unknown as SavedSchematic, older.stamp)
  pushTo(room, read.doc)
  return read
}

const holdsAnything = (room: Room) => room.elements.size > 0 || (!shelvedHere(room) && olderShelf(room) !== null)

export function hostRoom(room: Room, doc: Schematic): Upgrade | null {
  if (holdsAnything(room)) return readRoom(room)
  pushTo(room, doc)
  return null
}

export const guestRoom = (room: Room): Upgrade | null => (holdsAnything(room) ? readRoom(room) : null)

export const roomOf = (ydoc: Y.Doc, meta: Y.Map<string>): Room => ({ ydoc, elements: ydoc.getMap<string>(shelfName(SCHEMATIC_VERSION)), meta })

export type Peer = { format?: unknown }

export const olderPeers = <P extends Peer>(peers: readonly P[]) => peers.filter((p) => !(Number(p.format) >= SCHEMATIC_VERSION))

export const newerPeers = <P extends Peer>(peers: readonly P[]) => peers.filter((p) => Number(p.format) > SCHEMATIC_VERSION)

export type Storage = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }

export function reloadForNewer(storage: Storage | null, room: string, format: number): boolean {
  const key = `emul-reloaded:${room}:${format}`
  try {
    if (!storage || storage.getItem(key)) return false
    storage.setItem(key, "1")
    return true
  } catch {
    return false
  }
}

export type NewerSeen = { format: number }

export function onNewerFormat(storage: Storage | null, room: string, format: number, seen: NewerSeen): "reload" | "warn" | null {
  if (format <= seen.format) return null
  seen.format = format
  return reloadForNewer(storage, room, format) ? "reload" : "warn"
}
