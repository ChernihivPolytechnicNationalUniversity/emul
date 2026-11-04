import type { Run } from "./circuit"
import type { Rect } from "./geometry"
import type { Point, Schematic } from "./types"
import type { Wiring } from "./wire-edits"

const unbuilt = (what: string): never => {
  throw new Error(`${what} is not built yet`)
}

export function segmentNearest(_run: Run, _at: Point): string {
  return unbuilt("segmentNearest")
}

export function chainOf(_wiring: Wiring, _segment: string): readonly string[] {
  return unbuilt("chainOf")
}

export function inRect(_doc: Schematic, _rect: Rect): { readonly objects: readonly string[]; readonly wires: readonly string[] } {
  return unbuilt("inRect")
}
