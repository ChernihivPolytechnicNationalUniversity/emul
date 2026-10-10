import type { PlacedObject } from "./types"

const savedAsHctSelect = (o: PlacedObject) => o.def === "hc595" && o.props?.value === "74HCT595"

export function migrated(o: PlacedObject): PlacedObject {
  if (!savedAsHctSelect(o)) return o
  const { value: _part, ...props } = o.props ?? {}
  return { ...o, def: "hct595", props }
}
