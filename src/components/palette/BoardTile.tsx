import { PALETTE_DRAG_TYPE } from "@/schematic/registry"
import type { ComponentDef } from "@/schematic/types"
import { cn } from "@/lib/utils"
import type { PaletteEntry } from "./items"

const THUMB = { w: 66, h: 44 }

/** A board in the palette: its photo, the name students use, the MCU and clock. */
export function BoardTile({ entry, onPick }: { entry: PaletteEntry; onPick?: (item: ComponentDef) => void }) {
  const def = entry.def
  const card = def.board
  if (!card) return null
  const tags = [`${card.volts} V`, ...(entry.family ? [`${entry.family.variants.length} variants`] : []), ...card.tags].slice(0, 3)
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PALETTE_DRAG_TYPE, def.id)
        e.dataTransfer.effectAllowed = "copy"
      }}
      onClick={() => onPick?.(def)}
      title={`${entry.name} · ${card.vendor}\n${card.mcu}, ${card.mhz} MHz, ${card.volts} V logic`}
      className={cn(
        "flex min-w-0 cursor-grab items-center gap-2 rounded-md p-1 text-left outline-hidden transition-colors active:cursor-grabbing",
        "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
      )}
    >
      <img src={`${import.meta.env.BASE_URL}boards/${card.photo}`} alt="" loading="lazy" decoding="async" draggable={false} className="shrink-0 object-contain" style={{ width: THUMB.w, height: THUMB.h }} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm leading-5">{entry.name}</span>
        <span className="truncate text-[11px] leading-4 text-muted-foreground tabular-nums">
          {card.mcu} · {card.mhz} MHz
        </span>
        <span className="flex min-w-0 gap-1 pt-0.5">
          {tags.map((t) => (
            <span key={t} className="shrink-0 truncate rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground last:shrink">
              {t}
            </span>
          ))}
        </span>
      </span>
    </button>
  )
}
