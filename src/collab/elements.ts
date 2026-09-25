import type { HdlModule, PartState, PlacedObject, Schematic, Wire } from "@/schematic/types"

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
const byZ = <T>(a: Ordered<T>, b: Ordered<T>) => a.z - b.z
const unz = <T>(o: Ordered<T>): T => {
  const copy: Partial<Ordered<T>> = { ...o }
  delete copy.z
  return copy as T
}

export function join(elements: ReadonlyMap<string, string>): Schematic {
  const objects: Ordered<PlacedObject>[] = []
  const extra = new Map<string, Partial<PlacedObject> & { firmware?: Record<string, string> }>()
  const wires: Ordered<Wire>[] = []
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
    else if (kind === "w") wires.push(value as Ordered<Wire>)
    else if (kind === "s") parts[id] = value as PartState
    else if (kind === "m") library.push(value as Ordered<HdlModule>)
  }
  const doc: Schematic = {
    objects: objects.sort(byZ).map((o) => {
      const { firmware, ...x } = extra.get(o.id) ?? {}
      const object = unz(o)
      return { ...object, ...x, props: { ...object.props, ...firmware } }
    }),
    wires: wires.sort(byZ).map(unz),
    parts,
  }
  if (library.length) doc.library = library.sort(byZ).map(unz)
  return doc
}
