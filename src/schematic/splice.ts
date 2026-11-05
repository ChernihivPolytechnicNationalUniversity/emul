import type { Schematic } from "./types"
import type { NewId } from "./wire-edits"

export function splicedAt(doc: Schematic, _objectIds: Iterable<string>, _newId?: NewId): Schematic {
  return doc
}
