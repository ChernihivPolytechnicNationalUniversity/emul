import { getDef } from "./registry"
import { emptySchematic, type PlacedObject, type Rotation, type Schematic, type Wire } from "./types"

/** Small DSL over the document: place components by cell, wire them by pin. */
export function builder(grid: number) {
  const doc: Schematic = emptySchematic()
  const counts = new Map<string, number>()
  const place = (def: string, x: number, y: number, props: Record<string, string> = {}, rotation?: Rotation) => {
    const d = getDef(def)
    const obj: PlacedObject = { id: crypto.randomUUID(), def, x: x * grid, y: y * grid, props }
    if (rotation) obj.rotation = rotation
    if (d?.prefix && !props.ref) {
      const n = (counts.get(d.prefix) ?? 0) + 1
      counts.set(d.prefix, n)
      obj.props = { ...props, ref: `${d.prefix}${n}` }
    }
    doc.objects.push(obj)
    return obj
  }
  /** `bends` are cell coordinates the wire is forced through. */
  const wire = (a: PlacedObject, pinA: string, b: PlacedObject, pinB: string, bends: [number, number][] = []) => {
    const w: Wire = {
      id: crypto.randomUUID(),
      from: { object: a.id, pin: pinA },
      to: { object: b.id, pin: pinB },
      points: bends.length ? bends.map(([x, y]) => ({ x: x * grid, y: y * grid })) : undefined,
    }
    doc.wires.push(w)
    return w
  }
  return { doc, place, wire }
}
