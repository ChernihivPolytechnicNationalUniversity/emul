import type { PinGroup } from "./net-names"
import type { Point, Schematic } from "./types"
import type { WireColorKey } from "./wire-colors"
import type { NewId, Wiring } from "./wire-edits"

export type DrawEnd =
  | { readonly kind: "pin"; readonly key: string; readonly at: Point }
  | { readonly kind: "end"; readonly at: Point }
  | { readonly kind: "wire"; readonly at: Point; readonly segment: string }
  | { readonly kind: "crossing"; readonly at: Point }
  | { readonly kind: "field"; readonly at: Point }

export type Axis = "x" | "y"

export type Drawing = {
  readonly from: DrawEnd
  readonly heading?: Point
  readonly corners: readonly Point[]
  readonly clicks: readonly { readonly added: number; readonly axis: Axis | null }[]
  readonly cursor: Point
  readonly axis: Axis | null
  readonly color?: WireColorKey
}

export type DrawRefusal = { readonly refused: "along" | "over" | "corner" | "crossing" | "nothing"; readonly at: Point; readonly nets: readonly string[] }

export type DrawPreview = { readonly points: readonly Point[]; readonly refused: DrawRefusal | null; readonly joins: readonly PinGroup[]; readonly routed: boolean }

export const isRefusal = (value: unknown): value is DrawRefusal => typeof value === "object" && value !== null && "refused" in value

const unbuilt = (what: string): never => {
  throw new Error(`${what} is not built yet`)
}

export function drawEndAt(_wiring: Wiring, _at: Point): DrawEnd {
  return unbuilt("drawEndAt")
}

export function startDrawing(_wiring: Wiring, _from: DrawEnd, _color?: WireColorKey): Drawing | DrawRefusal {
  return unbuilt("startDrawing")
}

export function pointerAt(_drawing: Drawing, _at: Point): Drawing {
  return unbuilt("pointerAt")
}

export function flipPosture(_drawing: Drawing): Drawing {
  return unbuilt("flipPosture")
}

export function withCorner(_doc: Schematic, _wiring: Wiring, _drawing: Drawing, _at: Point): Drawing | DrawRefusal {
  return unbuilt("withCorner")
}

export function withoutCorner(_drawing: Drawing): Drawing {
  return unbuilt("withoutCorner")
}

export function previewOf(_doc: Schematic, _wiring: Wiring, _drawing: Drawing, _target?: DrawEnd): DrawPreview {
  return unbuilt("previewOf")
}

export function drawnTo(_doc: Schematic, _wiring: Wiring, _drawing: Drawing, _target: DrawEnd, _newId?: NewId): Schematic | DrawRefusal {
  return unbuilt("drawnTo")
}
