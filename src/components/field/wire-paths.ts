import { chained, trimmedAtBends, type Stretch } from "@/schematic/conflict-marks"
import { toPath, trimRouteEnds, type Point } from "@/schematic/geometry"
import { runPath, towards, type Leads } from "@/schematic/wire-look"
import { casingTrim, WIRE_PX, wireCornerRadius } from "./wire-style"

export type WireRoute = { readonly pts: readonly Point[]; readonly leads?: Leads }

export const wireStrokePath = (route: WireRoute, grid: number) => runPath(route.pts, wireCornerRadius(grid), route.leads)

export const wireCasingPath = (route: WireRoute, grid: number) => toPath(trimRouteEnds(route.pts, casingTrim(grid)), wireCornerRadius(grid))

export function leadPatchPaths({ pts, leads }: WireRoute, px: number): string[] {
  const patches: string[] = []
  const pastThePin = WIRE_PX * px
  if (leads?.start) patches.push(toPath([leads.start, towards(pts[0], leads.start, -pastThePin)]))
  if (leads?.end) patches.push(toPath([leads.end, towards(pts[pts.length - 1], leads.end, -pastThePin)]))
  return patches
}

export const conflictCutPaths = (stretches: readonly Stretch[], grid: number): string[] => chained(stretches).map((line) => toPath(line, wireCornerRadius(grid)))

export function conflictGlowPaths(stretches: readonly Stretch[], bendAt: (p: Point) => boolean, grid: number): string[] {
  const radius = wireCornerRadius(grid)
  return chained(stretches).map((line) => toPath(trimmedAtBends(line, bendAt, radius), radius))
}
