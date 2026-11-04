import type { Point, RoutedWire } from "@/schematic/geometry"
import type { WireColorKey } from "@/schematic/wire-colors"
import type { PinCorner } from "@/schematic/wire-look"

export type WireMarks = {
  dots: readonly { at: Point; color: WireColorKey | null }[]
  open: readonly { at: Point; color: WireColorKey }[]
  corners: readonly PinCorner[]
}

export const NO_MARKS: WireMarks = { dots: [], open: [], corners: [] }

const key = (p: Point) => `${p.x},${p.y}`

export function wireMarks(routes: readonly RoutedWire[], dots: readonly Point[], dangling: readonly Point[], corners: readonly PinCorner[], colorOf: (wireId: string) => WireColorKey, withoutWires: boolean): WireMarks {
  const endOf = new Map<string, string>()
  for (const r of routes) for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) if (p) endOf.set(key(p), r.id)
  return {
    dots: dots.flatMap((at): WireMarks["dots"] => {
      const id = endOf.get(key(at))
      if (id) return [{ at, color: colorOf(id) }]
      return withoutWires ? [{ at, color: null }] : []
    }),
    open: dangling.flatMap((at) => {
      const id = endOf.get(key(at))
      return id ? [{ at, color: colorOf(id) }] : []
    }),
    corners: withoutWires ? corners : [],
  }
}
