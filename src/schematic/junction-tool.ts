import type { PinGroup } from "./net-names"
import type { Point, Schematic } from "./types"
import type { NewId, Wiring } from "./wire-edits"

export type JunctionRefusal = { readonly refused: "no-crossing"; readonly at: Point }

const unbuilt = (what: string): never => {
  throw new Error(`${what} is not built yet`)
}

export function junctionJoins(_wiring: Wiring, _at: Point): readonly PinGroup[] {
  return unbuilt("junctionJoins")
}

export function junctionAt(_doc: Schematic, _wiring: Wiring, _at: Point, _newId?: NewId): Schematic | JunctionRefusal {
  return unbuilt("junctionAt")
}
