import { objectIndex, objectRect, resolvePinIn, GRID } from "@/schematic/geometry"
import type { Schematic } from "@/schematic/types"

const DB_NAME = "emul"
const VERSION = 2
const META = "projects"
const DOCS = "docs"
const PREFS = "prefs"
const LEGACY = "bench"
const LAST = "last"

export type Thumb = { w: number; h: number; rects: number[]; lines: number[] }

export type ProjectMeta = { id: string; name: string; created: number; at: number; thumb?: Thumb }

export const FILE_FORMAT = "emul-project"
export const FILE_EXT = ".emul"

export function isSchematic(doc: unknown): doc is Schematic {
  const d = doc as Schematic
  return !!d && Array.isArray(d.objects) && Array.isArray(d.wires)
}

export function parseSchematic(text: string): Schematic | null {
  try {
    const doc: unknown = JSON.parse(text)
    return isSchematic(doc) ? doc : null
  } catch {
    return null
  }
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const LEVEL = 19

const zstd = () => import("@hpcc-js/wasm-zstd").then((m) => m.Zstd.load())

export async function readProjectFile(file: Blob): Promise<{ name?: string; doc: Schematic } | null> {
  return readProjectBytes(new Uint8Array(await file.arrayBuffer()))
}

async function readProjectBytes(raw: Uint8Array): Promise<{ name?: string; doc: Schematic } | null> {
  let parsed: unknown
  try {
    let bytes = raw
    if (ZSTD_MAGIC.every((b, i) => bytes[i] === b)) bytes = (await zstd()).decompress(bytes)
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  const f = parsed as { format?: unknown; name?: unknown; schematic?: unknown }
  if (f?.format !== FILE_FORMAT || !isSchematic(f.schematic)) return null
  return { name: typeof f.name === "string" ? f.name : undefined, doc: f.schematic }
}

async function projectBytes(name: string, doc: Schematic): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify({ format: FILE_FORMAT, version: 1, name, schematic: doc }))
  return (await zstd()).compress(json, LEVEL)
}

export async function projectFile(name: string, doc: Schematic): Promise<Blob> {
  return new Blob([new Uint8Array(await projectBytes(name, doc))], { type: "application/zstd" })
}

const SHARE = /^\/s\/([A-Za-z0-9]{8})\/?$/

export async function shareLink(name: string, doc: Schematic): Promise<string> {
  const res = await fetch("/api/shares", {
    method: "POST",
    headers: { "content-type": "application/zstd" },
    body: new Uint8Array(await projectBytes(name, doc)),
  })
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
  if (!res.ok || !body.id) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  return `${location.origin}/s/${body.id}`
}

export function sharedId(path = location.pathname): string | null {
  return SHARE.exec(path)?.[1] ?? null
}

export async function readShare(id: string): Promise<{ name?: string; doc: Schematic } | null> {
  const res = await fetch(`/api/shares/${id}`)
  if (!res.ok) return null
  return readProjectBytes(new Uint8Array(await res.arrayBuffer()))
}

export function fileName(name: string): string {
  return (name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "bench") + FILE_EXT
}

export function nameFromFile(file: string): string {
  return file.replace(/\.emul$/i, "").trim() || "Untitled"
}

const THUMB_OBJECTS = 400
const THUMB_WIRES = 800

export function thumbnail(doc: Schematic): Thumb | undefined {
  if (!doc.objects.length) return undefined
  const boxes = doc.objects.map((o) => objectRect(o, GRID))
  const x0 = Math.min(...boxes.map((r) => r.x))
  const y0 = Math.min(...boxes.map((r) => r.y))
  const w = Math.max(...boxes.map((r) => r.x + r.w)) - x0 || GRID
  const h = Math.max(...boxes.map((r) => r.y + r.h)) - y0 || GRID
  const s = 100 / Math.max(w, h)
  const q = (v: number) => Math.round(v * s * 10) / 10
  const rects = boxes
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, THUMB_OBJECTS)
    .flatMap((r) => [q(r.x - x0), q(r.y - y0), q(r.w), q(r.h)])
  const index = objectIndex(doc.objects)
  const lines: number[] = []
  for (const wire of doc.wires.slice(0, THUMB_WIRES)) {
    const a = resolvePinIn(index, wire.from, GRID)
    const b = resolvePinIn(index, wire.to, GRID)
    if (!a || !b) continue
    lines.push(q(a.point.x - x0), q(a.point.y - y0), q(b.point.x - x0), q(b.point.y - y0))
  }
  return { w: q(w), h: q(h), rects, lines }
}

let db: Promise<IDBDatabase> | null = null

function database(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const d = req.result
      const tx = req.transaction!
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: "id" })
      if (!d.objectStoreNames.contains(DOCS)) d.createObjectStore(DOCS)
      if (!d.objectStoreNames.contains(PREFS)) d.createObjectStore(PREFS)
      if (!d.objectStoreNames.contains(LEGACY)) return
      const old = tx.objectStore(LEGACY).get("current")
      old.onsuccess = () => {
        const b = old.result as { text?: unknown; at?: unknown } | undefined
        const doc = typeof b?.text === "string" ? parseSchematic(b.text) : null
        if (b && doc && doc.objects.length) {
          const at = typeof b.at === "number" ? b.at : Date.now()
          const meta: ProjectMeta = { id: newId(), name: "Untitled", created: at, at, thumb: thumbnail(doc) }
          tx.objectStore(META).put(meta)
          tx.objectStore(DOCS).put(b.text, meta.id)
          tx.objectStore(PREFS).put(meta.id, LAST)
        }
        d.deleteObjectStore(LEGACY)
      }
    }
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close()
      resolve(req.result)
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error("an older tab of emul holds the storage; reload it"))
  }).catch((e: unknown) => {
    db = null
    throw e
  })
  return db
}

export function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error("the storage refused the change"))
  })
}

function result<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = await result<ProjectMeta[]>((await database()).transaction(META).objectStore(META).getAll())
  return all.sort((a, b) => b.at - a.at)
}

export async function readProject(id: string): Promise<{ meta: ProjectMeta; text: string } | null> {
  const tx = (await database()).transaction([META, DOCS])
  const [meta, text] = await Promise.all([
    result<ProjectMeta | undefined>(tx.objectStore(META).get(id)),
    result<string | undefined>(tx.objectStore(DOCS).get(id)),
  ])
  return meta && typeof text === "string" ? { meta, text } : null
}

export async function writeProject(meta: ProjectMeta, text?: string): Promise<void> {
  const tx = (await database()).transaction([META, DOCS], "readwrite")
  tx.objectStore(META).put(meta)
  if (text !== undefined) tx.objectStore(DOCS).put(text, meta.id)
  await done(tx)
}

export async function deleteProject(id: string): Promise<void> {
  const tx = (await database()).transaction([META, DOCS], "readwrite")
  tx.objectStore(META).delete(id)
  tx.objectStore(DOCS).delete(id)
  await done(tx)
}

export async function lastProject(): Promise<string | null> {
  const id = await result<unknown>((await database()).transaction(PREFS).objectStore(PREFS).get(LAST))
  return typeof id === "string" ? id : null
}

export async function setLastProject(id: string): Promise<void> {
  const tx = (await database()).transaction(PREFS, "readwrite")
  tx.objectStore(PREFS).put(id, LAST)
  await done(tx)
}
