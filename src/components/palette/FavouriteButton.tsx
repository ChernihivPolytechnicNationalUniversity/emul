import type * as React from "react"
import { StarIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PartMeta } from "@/schematic/registry"
import { usePaletteActions } from "./palette-actions"
import { flipFavourite } from "./recents"

/** The star that pins a part. Rendered as a row's menu action, it passes on what the row puts on it (data-sidebar, position): the row keeps room for it. */
export function FavouriteButton({ def, className, ...props }: { def: PartMeta } & Omit<React.ComponentProps<"button">, "onClick">) {
  const { favourites } = usePaletteActions()
  const on = favourites.has(def.id)
  return (
    <button
      {...props}
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

