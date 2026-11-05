import type { Orientation, Point, Rect, TextAnchor } from "./geometry"
import type { BodyShape, ComponentDef, PlacedObject } from "./types"

export type FieldKey = "ref" | "value"

export type FieldSide = "right" | "top" | "left" | "bottom"

export type FieldTemplate = { key: FieldKey; text: string; size: number; muted: boolean }

export type PlacedField = { object: string; key: FieldKey; text: string; at: Point; box: Rect; angle: 0 | -90; anchor: TextAnchor; side: FieldSide; moved: boolean }

const NOT_BUILT = "phase 5: fields are not built yet"

export function fieldTemplates(_def: ComponentDef): readonly FieldTemplate[] {
  throw new Error(NOT_BUILT)
}

export function bodyWithoutFields(_def: ComponentDef): readonly BodyShape[] {
  throw new Error(NOT_BUILT)
}

export function autoplaceSide(_def: ComponentDef, _orientation: Orientation): FieldSide {
  throw new Error(NOT_BUILT)
}

export function placedFields(_object: PlacedObject, _grid: number): readonly PlacedField[] {
  throw new Error(NOT_BUILT)
}

export function withFieldMoved(_object: PlacedObject, _key: FieldKey, _dx: number, _dy: number, _grid: number): PlacedObject {
  throw new Error(NOT_BUILT)
}
