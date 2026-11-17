import { chained, trimmedAtBends, type Stretch } from "@/schematic/conflict-marks"
import { toPath, trimRouteEnds, type Point } from "@/schematic/geometry"
import { runPath, towards, type Leads } from "@/schematic/wire-look"
import { casingTrim, WIRE_PX, wireCornerRadius } from "./wire-style"

export const WIRE_LIFT_CUT_ID = "field-wire-lift-cut"
export const PENDING_WIRE_CUT_ID = "pending-wire-cut"

export type WireRoute = { readonly pts: readonly Point[]; readonly leads?: Leads }

export const wireStrokePath = (route: WireRoute, grid: number) => runPath(route.pts, wireCornerRadius(grid), route.leads)

export const wireCasingPath = (route: WireRoute, grid: number) => toPath(trimRouteEnds(route.pts, casingTrim(grid)), wireCornerRadius(grid))

export type LeadCutAt = { readonly pin: Point; readonly from: Point; readonly to: Point }

const pastThePin = (lead: Point, pin: Point): Point => towards(pin, lead, -WIRE_PX)

export function turnedLeads(routes: readonly WireRoute[], corners: readonly { readonly at: Point; readonly a: Point; readonly b: Point }[] = []): LeadCutAt[] {
  const cuts: LeadCutAt[] = []
  for (const { pts, leads } of routes) {
    if (leads?.start) cuts.push({ pin: pts[0], from: leads.start, to: pastThePin(leads.start, pts[0]) })
    if (leads?.end) cuts.push({ pin: pts[pts.length - 1], from: leads.end, to: pastThePin(leads.end, pts[pts.length - 1]) })
  }
  for (const c of corners) for (const lead of [c.a, c.b]) cuts.push({ pin: c.at, from: lead, to: pastThePin(lead, c.at) })
  return cuts
}

export const leadPatchPaths = (route: WireRoute): string[] => turnedLeads([route]).map(({ from, to }) => toPath([from, to]))

export const conflictCutPaths = (stretches: readonly Stretch[], grid: number): string[] => chained(stretches).map((line) => toPath(line, wireCornerRadius(grid)))

export function conflictGlowPaths(stretches: readonly Stretch[], bendAt: (p: Point) => boolean, grid: number): string[] {
  const radius = wireCornerRadius(grid)
  return chained(stretches).map((line) => toPath(trimmedAtBends(line, bendAt, radius), radius))
}
