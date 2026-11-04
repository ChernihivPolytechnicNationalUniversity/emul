import { runsOf } from "@/schematic/circuit"
import type { RoutedWire } from "@/schematic/geometry"
import { wiresAsSegments } from "@/schematic/migrate-wires"
import type { LegacyWire, PlacedObject } from "@/schematic/types"
import { pinsOf } from "@/schematic/wire-edits"
import type { WireSegment } from "@/schematic/wires/segment"

const isLegacy = (w: LegacyWire | WireSegment): w is LegacyWire => "from" in w

export function segmentsOf(objects: readonly PlacedObject[], wires: readonly (LegacyWire | WireSegment)[]): WireSegment[] {
  const legacy = wires.filter(isLegacy)
  const stored = wires.filter((w): w is WireSegment => !isLegacy(w))
  if (!legacy.length) return stored
  return [...stored, ...wiresAsSegments({ objects: [...objects], wires: legacy, parts: {} }).doc.wires]
}

export const routesOf = (objects: readonly PlacedObject[], wires: readonly (LegacyWire | WireSegment)[]): RoutedWire[] =>
  runsOf(segmentsOf(objects, wires), pinsOf(objects)).map((r) => ({ id: r.id, pts: [...r.points], owner: [] }))
