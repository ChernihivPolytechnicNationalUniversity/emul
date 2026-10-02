import type { ComponentDef, Element, PinDef } from "./types"

function endsOf(element: Element): readonly [string, string] | null {
  switch (element.kind) {
    case "R":
    case "C":
    case "L":
    case "SW":
      return [element.a, element.b]
    case "D":
      return [element.anode, element.cathode]
    default:
      return null
  }
}

export function elementTerminals(def: ComponentDef, element: number): readonly [PinDef, PinDef] | null {
  const model = def.model?.[element]
  const ends = model && endsOf(model)
  if (!ends) return null
  const from = def.pins.find((pin) => pin.id === ends[0])
  const to = def.pins.find((pin) => pin.id === ends[1])
  return from && to ? [from, to] : null
}

export const terminalName = (pin: PinDef) => pin.label || pin.id
