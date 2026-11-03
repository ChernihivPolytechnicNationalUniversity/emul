import { StarIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ComponentDef } from "@/schematic/types"
import { usePaletteActions } from "./palette-actions"
import { flipFavourite } from "./recents"

export function FavouriteButton({ def, className }: { def: ComponentDef; className?: string }) {
  const { favourites } = usePaletteActions()
  const on = favourites.has(def.id)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        flipFavourite(def.id)
      }}
      aria-pressed={on}
      aria-label={on ? `Unpin ${def.name}` : `Pin ${def.name}`}
      title={on ? "Unpin" : "Pin to the top of the palette"}
      className={cn("flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none [&>svg]:size-3.5", className)}
    >
      <StarIcon className={on ? "fill-amber-400 text-amber-500" : undefined} />
    </button>
  )
}

