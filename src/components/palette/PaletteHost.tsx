import * as React from "react"
import { PlusIcon, SearchIcon, StarIcon } from "lucide-react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { PaletteMode, WidthClass } from "@/hooks/use-size-class"
import { HdlIcon } from "@/schematic/icons"
import { ComponentsSidebar, QUICK_GROUP, SEARCH_GROUP } from "./ComponentsSidebar"
import { clampWidth, FOLD_BELOW, PALETTE_SEARCH_EVENT, RAIL_PX, saveWidth } from "./dock-width"
import { paletteGroups, useLibrary } from "./items"
import { useQuickLists } from "./recents"

type SidebarProps = Omit<React.ComponentProps<typeof ComponentsSidebar>, "only" | "onSearchFocus" | "autoFocusSearch" | "collapsible">


type PaletteHostProps = {
  mode: PaletteMode
  widthClass: WidthClass
  /** Docked: unfolded. A sheet or the rail's flyout: shown. */
  open: boolean
  onOpenChange: (open: boolean) => void
  width: number
  onWidthChange: (px: number) => void
  sidebar: SidebarProps
}

/**
 * The palette, placed for the screen it is on: docked beside the field and dragged wider or folded
 * to a column of group icons; that column on a tablet, a group sliding out over the field; a sheet
 * from the side when the screen is short; a sheet from the bottom on a phone held upright.
 */
export function PaletteHost({ mode, widthClass, open, onOpenChange, width, onWidthChange, sidebar }: PaletteHostProps) {
  if (mode === "bottom-sheet") return <BottomSheet open={open} onOpenChange={onOpenChange} sidebar={sidebar} />
  if (mode === "side-sheet")
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" initialFocus={false} className="w-[min(18rem,45vw)] gap-0 bg-sidebar p-0 [&>button]:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Parts</SheetTitle>
            <SheetDescription>Pick a part, then tap the field to place it.</SheetDescription>
          </SheetHeader>
          <ComponentsSidebar collapsible="none" className="h-full w-full" {...sidebar} />
        </SheetContent>
      </Sheet>
    )
  if (mode === "rail" || !open) return <RailWithFlyout sidebar={sidebar} />
  return <Dock width={width} widthClass={widthClass} onWidthChange={onWidthChange} onFold={() => onOpenChange(false)} sidebar={sidebar} />
}

function Dock({ width, widthClass, onWidthChange, onFold, sidebar }: { width: number; widthClass: WidthClass; onWidthChange: (px: number) => void; onFold: () => void; sidebar: SidebarProps }) {
  const drag = React.useRef<{ x: number; width: number } | null>(null)
  const [live, setLive] = React.useState<number | null>(null)
  const shown = live ?? clampWidth(width, widthClass)
  const settle = (px: number) => {
    if (px < FOLD_BELOW) onFold()
    else {
      const next = clampWidth(px, widthClass)
      onWidthChange(next)
      saveWidth(next)
    }
  }
  return (
    <div data-slot="palette-dock" className="relative h-full shrink-0 border-r" style={{ width: shown }}>
      <ComponentsSidebar collapsible="none" className="h-full w-full" {...sidebar} />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Palette width: drag, or use the arrow keys; drag far left to fold it"
        aria-valuenow={shown}
        tabIndex={0}
        title="Drag to resize · double-click for the default width"
        className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none outline-hidden after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-ring focus-visible:after:bg-ring"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, width: shown }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const px = drag.current.width + e.clientX - drag.current.x
          // Past the fold point the panel shows where it will go: down to its icon column.
          setLive(px < FOLD_BELOW ? RAIL_PX : clampWidth(px, widthClass))
        }}
        onPointerUp={(e) => {
          if (!drag.current) return
          const px = drag.current.width + e.clientX - drag.current.x
          drag.current = null
          setLive(null)
          settle(px)
        }}
        onPointerCancel={() => {
          drag.current = null
          setLive(null)
        }}
        onDoubleClick={() => settle(288)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
          e.preventDefault()
          settle(shown + (e.key === "ArrowRight" ? 16 : -16))
        }}
      />
    </div>
  )
}

type RailItem = { id: string; label: string; hint?: string; icon: React.ReactNode }

/** One icon of the rail; its name (and its group's count) shows at once beside it, not as a slow native title. */
function RailButton({ item, shown, onClick }: { item: RailItem; shown: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={item.label}
            aria-expanded={shown}
            onClick={onClick}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/80 outline-hidden hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring [&>svg]:size-4",
              shown && "bg-sidebar-accent text-sidebar-foreground",
            )}
          />
        }
      >
        {item.icon}
      </TooltipTrigger>
      {!shown && (
        <TooltipContent side="right" sideOffset={8}>
          {item.label}
          {item.hint && <span className="text-background/60 tabular-nums">{item.hint}</span>}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

/** The palette folded to a column of icons: search, favourites, a group each. A click slides the group out over the field. */
function RailWithFlyout({ sidebar }: { sidebar: SidebarProps }) {
  const [shown, setShown] = React.useState<string | null>(null)
  const library = useLibrary()
  const quick = useQuickLists()
  const host = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!shown) return
    const away = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node)) setShown(null)
    }
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setShown(null)
    window.addEventListener("pointerdown", away, true)
    window.addEventListener("keydown", esc)
    return () => {
      window.removeEventListener("pointerdown", away, true)
      window.removeEventListener("keydown", esc)
    }
  }, [shown])

  // Search and the quick lists first, set off by a line from the groups; a group's tip names it and counts its parts.
  const tools: RailItem[] = [
    { id: SEARCH_GROUP, label: "Search parts", hint: "/", icon: <SearchIcon /> },
    ...(quick.favourites.length || quick.recent.length ? [{ id: QUICK_GROUP, label: "Recent and favourites", icon: <StarIcon /> }] : []),
    ...(library.length ? [{ id: "hdl", label: "Project modules", hint: String(library.length), icon: <HdlIcon /> }] : []),
  ]
  const groups: RailItem[] = paletteGroups.map((g) => {
    const Icon = g.entries[0].def.icon
    return { id: g.id, label: g.label, hint: String(g.entries.length), icon: <Icon /> }
  })
  React.useEffect(() => {
    const search = () => setShown(SEARCH_GROUP)
    window.addEventListener(PALETTE_SEARCH_EVENT, search)
    return () => window.removeEventListener(PALETTE_SEARCH_EVENT, search)
  }, [])
  const close = () => setShown(null)
  // A part taken in hand closes the flyout: the field is where the next click goes.
  const flyoutSidebar: SidebarProps = { ...sidebar, onArm: (item) => (close(), sidebar.onArm?.(item)), onPick: (item) => (close(), sidebar.onPick?.(item)) }

  return (
    <div ref={host} data-slot="palette-rail" className="relative z-30 flex h-full shrink-0 border-r bg-sidebar" style={{ width: RAIL_PX }}>
      <nav aria-label="Part groups" className="flex w-full flex-col items-center gap-0.5 overflow-y-auto py-1.5">
        {tools.map((item) => (
          <RailButton key={item.id} item={item} shown={shown === item.id} onClick={() => setShown((s) => (s === item.id ? null : item.id))} />
        ))}
        <div role="separator" className="my-1 h-px w-5 shrink-0 bg-sidebar-border" />
        {groups.map((item) => (
          <RailButton key={item.id} item={item} shown={shown === item.id} onClick={() => setShown((s) => (s === item.id ? null : item.id))} />
        ))}
      </nav>
      {shown && (
        <div data-slot="palette-flyout" className="absolute inset-y-0 w-80 border-r bg-sidebar shadow-lg" style={{ left: RAIL_PX }}>
          <ComponentsSidebar
            key={shown}
            collapsible="none"
            className="h-full w-full"
            only={shown}
            autoFocusSearch={shown === SEARCH_GROUP}
            {...flyoutSidebar}
          />
        </div>
      )}
    </div>
  )
}

const DETENTS = ["peek", "half", "full"] as const
type Detent = (typeof DETENTS)[number]
const HEIGHT: Record<Detent, string> = { peek: "11rem", half: "52dvh", full: "calc(100dvh - 3rem)" }

/** A phone's palette: a sheet from the bottom at three heights, the "+" button when it is down. */
function BottomSheet({ open, onOpenChange, sidebar }: { open: boolean; onOpenChange: (open: boolean) => void; sidebar: SidebarProps }) {
  const [detent, setDetent] = React.useState<Detent>("half")
  const sheet = React.useRef<HTMLDivElement>(null)
  const drag = React.useRef<{ y: number; height: number } | null>(null)
  const [live, setLive] = React.useState<number | null>(null)

  if (!open)
    return (
      <button
        type="button"
        aria-label="Add a part"
        onClick={() => {
          setDetent("half")
          onOpenChange(true)
        }}
        className="fixed right-3 bottom-20 z-40 flex size-14 items-center justify-center rounded-2xl bg-foreground text-background shadow-lg active:scale-95 [&>svg]:size-6"
      >
        <PlusIcon />
      </button>
    )

  const settle = (px: number) => {
    const vh = window.innerHeight
    // The nearest height; below the lowest by a third of it, the sheet goes down.
    const heights: [Detent, number][] = [
      ["peek", 176],
      ["half", vh * 0.52],
      ["full", vh - 48],
    ]
    if (px < heights[0][1] * 0.66) return onOpenChange(false)
    setDetent(heights.reduce((a, b) => (Math.abs(b[1] - px) < Math.abs(a[1] - px) ? b : a))[0])
  }
  // A part taken in hand: the sheet goes down so the field can be tapped.
  const sheetSidebar: SidebarProps = { ...sidebar, onArm: (item) => (onOpenChange(false), sidebar.onArm?.(item)), onPick: (item) => (onOpenChange(false), sidebar.onPick?.(item)) }

  return (
    <div
      ref={sheet}
      data-slot="palette-sheet"
      role="dialog"
      aria-label="Parts"
      className={cn("fixed inset-x-0 bottom-0 z-40 flex flex-col overflow-hidden rounded-t-2xl border-t bg-sidebar shadow-[0_-8px_24px_rgb(0_0_0/0.12)] pb-[env(safe-area-inset-bottom)]", !live && "transition-[height] duration-200 ease-out motion-reduce:transition-none")}
      style={{ height: live ?? HEIGHT[detent] }}
    >
      <div
        className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center"
        aria-label="Drag to resize; tap to switch the height"
        role="button"
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { y: e.clientY, height: sheet.current?.offsetHeight ?? 0 }
        }}
        onPointerMove={(e) => drag.current && setLive(Math.max(0, drag.current.height - (e.clientY - drag.current.y)))}
        onPointerUp={(e) => {
          if (!drag.current) return
          const moved = Math.abs(e.clientY - drag.current.y)
          const px = drag.current.height - (e.clientY - drag.current.y)
          drag.current = null
          setLive(null)
          if (moved < 6) setDetent((d) => DETENTS[(DETENTS.indexOf(d) + 1) % DETENTS.length])
          else settle(px)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setDetent((d) => DETENTS[(DETENTS.indexOf(d) + 1) % DETENTS.length])
          if (e.key === "Escape") onOpenChange(false)
        }}
      >
        <span className="h-1 w-9 rounded-full bg-muted-foreground/40" />
      </div>
      <ComponentsSidebar collapsible="none" className="min-h-0 w-full flex-1" onSearchFocus={() => setDetent("full")} {...sheetSidebar} />
    </div>
  )
}
