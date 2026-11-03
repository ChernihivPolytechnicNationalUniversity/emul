import * as React from "react"
import { getDef, getLibraryVersion, libraryEntries, registry, subscribeLibrary, PALETTE_DRAG_TYPE } from "@/schematic/registry"
import { familyHint, familyOf, variantLabel, type Family } from "@/schematic/families"
import type { SearchHit } from "./search"
import { CATEGORIES } from "@/schematic/categories"
import type { ComponentDef } from "@/schematic/types"

export { PALETTE_DRAG_TYPE }

/** One palette row: a part of its own, or a family whose row places `def`, the variant picked. */
export type PaletteEntry = { key: string; name: string; def: ComponentDef; family?: Family; hint?: string }

export type PaletteGroup = { id: string; label: string; aside?: string; items: ComponentDef[]; entries: PaletteEntry[] }

const familyEntry = (family: Family, def = getDef(family.variants[0][0])!): PaletteEntry => ({ key: family.id, name: family.name, def, family })

/** A group's rows: a family where its first variant would stand, its other variants folded into that row. */
function entriesOf(items: ComponentDef[]): PaletteEntry[] {
  const out: PaletteEntry[] = []
  const shown = new Set<string>()
  for (const def of items) {
    const family = familyOf(def.id)
    if (!family) out.push({ key: def.id, name: def.name, def })
    else if (!shown.has(family.id)) {
      shown.add(family.id)
      out.push({ ...familyEntry(family), hint: familyHint(family) })
    }
  }
  return out
}

/** The registry in the palette's groups, in their fixed order; parts keep registry order inside a group. */
export const paletteGroups: PaletteGroup[] = CATEGORIES.map((c) => {
  const items = registry.filter((def) => def.category === c.id)
  return { id: c.id, label: c.label, aside: "aside" in c ? c.aside : undefined, items, entries: entriesOf(items) }
}).filter((g) => g.items.length > 0)

/** Search hits as palette rows: the first hit of a family stands for it and places the variant that matched. */
export function hitEntries(hits: SearchHit[]): (PaletteEntry & { hit: SearchHit })[] {
  const out: (PaletteEntry & { hit: SearchHit })[] = []
  const shown = new Set<string>()
  for (const hit of hits) {
    const family = familyOf(hit.def.id)
    // A board says its MCU, whatever found it: "STM32" against every board tells nothing apart.
    if (!family) out.push({ key: hit.def.id, name: hit.def.name, def: hit.def, hint: hit.def.board?.mcu ?? hit.matched, hit })
    else if (!shown.has(family.id)) {
      shown.add(family.id)
      out.push({ ...familyEntry(family, hit.def), hint: variantLabel(hit.def.id), hit })
    }
  }
  return out
}

export function useLibrary() {
  const version = React.useSyncExternalStore(subscribeLibrary, getLibraryVersion)
  return React.useMemo(() => {
    void version
    return libraryEntries()
  }, [version])
}
