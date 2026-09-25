import * as React from "react"
import { getLibraryVersion, libraryEntries, registry, subscribeLibrary, PALETTE_DRAG_TYPE } from "@/schematic/registry"
import type { ComponentDef } from "@/schematic/types"

export { PALETTE_DRAG_TYPE }

export type PaletteGroup = { id: string; label: string; items: ComponentDef[] }

/** Registry grouped by category, in registry order. */
export const paletteGroups: PaletteGroup[] = registry.reduce<PaletteGroup[]>((groups, def) => {
  let g = groups.find((x) => x.label === def.category)
  if (!g) {
    g = { id: def.category.toLowerCase().replace(/\s+/g, "-"), label: def.category, items: [] }
    groups.push(g)
  }
  g.items.push(def)
  return groups
}, [])

export function useLibrary() {
  const version = React.useSyncExternalStore(subscribeLibrary, getLibraryVersion)
  return React.useMemo(() => {
    void version
    return libraryEntries()
  }, [version])
}
