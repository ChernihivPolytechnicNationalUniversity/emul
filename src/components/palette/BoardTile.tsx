import { cn } from "@/lib/utils"
import type { PaletteEntry } from "./items"
import { useDragOut, usePaletteActions } from "./palette-actions"
import { FavouriteButton } from "./FavouriteButton"

/** A board in the palette: its photo on top, the name students use, the MCU and clock, what sets it apart. */
export function BoardTile({ entry }: { entry: PaletteEntry }) {
  const { activate, armed, favourites } = usePaletteActions()
  const def = entry.def
  const drag = useDragOut(def)
  const card = def.board
  if (!card) return null
  // Clock and logic level first: what a student compares boards by; then what sets this one apart.
  const tags = [`${card.mhz} MHz`, `${card.volts} V`, ...(entry.family ? [`${entry.family.variants.length} variants`] : []), ...card.tags].slice(0, 3)
  const inHand = armed === def.id
  return (
    <div className="group/tile relative flex min-w-0">
      <button
        type="button"
        {...drag}
        onClick={(e) => activate(def, e)}
        aria-pressed={inHand}
        title={`${entry.name} · ${card.vendor}\n${card.mcu}, ${card.mhz} MHz, ${card.volts} V logic`}
        className={cn(
          "flex h-full w-full min-w-0 cursor-grab flex-col gap-0.5 rounded-lg border bg-background p-1.5 text-left outline-hidden transition-colors active:cursor-grabbing",
          "hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          inHand && "border-foreground ring-1 ring-foreground",
        )}
      >
        <img src={`${import.meta.env.BASE_URL}boards/${card.photo}`} alt="" loading="lazy" decoding="async" draggable={false} className="aspect-[3/2] w-full object-contain" />
        <span className="mt-0.5 line-clamp-2 min-h-8 text-xs leading-4 font-semibold">{entry.name}</span>
        <span className="truncate text-[11px] leading-4 text-muted-foreground">{card.mcu}</span>
        <span className="flex min-w-0 flex-wrap gap-1 pt-1">
          {tags.map((t) => (
            <span key={t} className="rounded-full bg-muted px-1.5 text-[10px] leading-4 whitespace-nowrap text-muted-foreground tabular-nums">
              {t}
            </span>
          ))}
        </span>
      </button>
      <FavouriteButton def={def} className={cn("absolute top-1 right-1 bg-background/80", !favourites.has(def.id) && "opacity-0 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100")} />
    </div>
  )
}
