import * as React from "react"
import { getLibraryVersion, libraryEntries, registry, subscribeLibrary, PALETTE_DRAG_TYPE } from "@/schematic/registry"
import { CATEGORIES } from "@/schematic/categories"
import type { ComponentDef } from "@/schematic/types"

export { PALETTE_DRAG_TYPE }

export type PaletteGroup = { id: string; label: string; items: ComponentDef[] }

/** The registry in the palette's groups, in their fixed order; parts keep registry order inside a group. */
export const paletteGroups: PaletteGroup[] = CATEGORIES.map(({ id, label }) => ({ id, label, items: registry.filter((def) => def.category === id) })).filter((g) => g.items.length > 0)

export function useLibrary() {
  const version = React.useSyncExternalStore(subscribeLibrary, getLibraryVersion)
  return React.useMemo(() => {
    void version
    return libraryEntries()
  }, [version])
}
