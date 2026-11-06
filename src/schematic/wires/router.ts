import type { PinRef, Point, Schematic } from "../types"
import type { NewId, Wiring } from "../wire-edits"

export type RouteEnd = { readonly pin: PinRef } | { readonly at: Point }

export type RerouteRefusal = { readonly refused: "no-clean-path"; readonly at: Point }

export const REROUTE_REFUSED: Record<RerouteRefusal["refused"], { title: string; why: string }> = {
  "no-clean-path": { title: "Not re-routed", why: "Every way between the wire's ends would run along another net's wire, pass over its pin or bend on it, so the wire stays as it was." },
}

export const isRerouteRefusal = (value: unknown): value is RerouteRefusal => typeof value === "object" && value !== null && "refused" in value

export function routeBetween(_doc: Schematic, _from: RouteEnd, _to: RouteEnd, _known?: Wiring): readonly Point[] | null {
  throw new Error("phase 6: the router of design.md §7 is not built yet")
}

export function rerouted(_doc: Schematic, _segment: string, _newId: NewId, _known?: Wiring): Schematic | RerouteRefusal {
  throw new Error("phase 6: re-route of design.md §7 is not built yet")
}
