import * as React from "react"
import { CornerDownLeftIcon, SearchIcon } from "lucide-react"
import { SidebarContent, SidebarGroup, SidebarMenu } from "@/components/ui/sidebar"
import { ensureDefs, type PartMeta } from "@/schematic/registry"
import type { HdlLanguage } from "emul-shared/hdl"
import { Heading, Kbd, PartRow, SearchResults } from "./ComponentsSidebar"
import { searchRows } from "./items"
import { Actions, clickEndsDrag, type PaletteActions } from "./palette-actions"
import { hideCard } from "./part-card"
import { opensQuickInsert, panelPosition, pickableRows, quickKey, quickSections, QUICK_START, typed, type QuickState, type Rect } from "./quick-insert"
import { useQuickLists } from "./recents"

type QuickInsertProps = {
  /** The screen point the part goes to. */
  at: { x: number; y: number }
  /** The bench's box on screen: the panel stays inside it. */
  bounds: Rect
  /** Place the part where the panel was opened; `more` keeps the panel open for the next one. */
  onPlace: (def: PartMeta, more: boolean) => void
  /** Take a part in hand, dragged out of the panel onto the field (null: let go off the field). */
  onTake: (def: PartMeta | null) => void
  /** The part Enter would place, for the field to show its ghost at the point. */
  onPreview: (defId: string | null) => void
  onClose: () => void
  onHdlNew?: (language: HdlLanguage) => void
  onHdlImport?: () => void
}

const WIDTH = 320
const RETURN = <CornerDownLeftIcon className="size-2.5" />
const MAX_HEIGHT = 416

/**
 * The palette's search where the part is going: a box, the same results as the palette's, and for a
 * blank query the favourite and recent parts. The keyboard does everything; a click places, a drag
 * takes the part out onto the field.
 */
export function QuickInsert({ at, bounds, onPlace, onTake, onPreview, onClose, onHdlNew, onHdlImport }: QuickInsertProps) {
  const [state, setState] = React.useState<QuickState>(QUICK_START)
  // Keys come faster than renders (a held arrow, a burst of PageDown): each one moves on from the last, not from the last render.
  const live = React.useRef<QuickState>(QUICK_START)
  const update = (next: QuickState) => {
    live.current = next
    setState(next)
  }
  const quick = useQuickLists()
  // Typing never waits for the search; the rows, the selection and Enter all follow the same deferred query.
  const query = React.useDeferredValue(state.query)
  const searching = query.trim() !== ""
  const search = React.useMemo(() => searchRows(query), [query])
  const sections = React.useMemo(() => quickSections(quick.recent, quick.favourites), [quick.recent, quick.favourites])
  const rows = React.useMemo(() => (searching ? search.pickable : sections.flatMap((s) => s.entries)), [searching, search, sections])
  const selected = rows.length ? Math.min(state.selected, rows.length - 1) : -1
  const current = selected >= 0 ? rows[selected]!.def.id : null

  const panel = React.useRef<HTMLDivElement>(null)
  const input = React.useRef<HTMLInputElement>(null)
  const [height, setHeight] = React.useState(MAX_HEIGHT)
  const room = Math.max(160, bounds.bottom - bounds.top - 16)
  const maxHeight = Math.min(MAX_HEIGHT, room)
  const width = Math.min(WIDTH, bounds.right - bounds.left - 16)
  const pos = panelPosition(at, { width, height: Math.min(height, maxHeight) }, bounds)

  React.useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /** What had the focus before the panel took it: the keyboard goes back there when the panel is shut by a key. */
  const opener = React.useRef<Element | null>(null)
  // The box has the keyboard before the next key: a word typed straight after "A" goes into it whole.
  React.useLayoutEffect(() => {
    // Run twice (React's development check), the second run finds the focus in the box already: keep the first.
    if (!panel.current?.contains(document.activeElement)) opener.current = document.activeElement
    input.current?.focus()
    // The menu that opened the panel hands the focus back to the field as it closes: take it again after.
    const frame = requestAnimationFrame(() => input.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])
  /** Shut by a key (Escape, Ctrl+K): the focus returns where it was, the palette's search say, if that is still on the page. */
  const dismiss = () => {
    const back = opener.current
    onClose()
    if (back instanceof HTMLElement && back.isConnected && back !== document.body) back.focus()
  }

  // The part Enter would place: its ghost at the point, its file on its way.
  React.useEffect(() => {
    onPreview(current)
    if (current) void ensureDefs([current])?.catch(() => {})
  }, [current, onPreview])
  React.useEffect(() => () => onPreview(null), [onPreview])

  // A press anywhere else closes the panel: the field, the palette, the menu bar.
  React.useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (panel.current?.contains(t) || t?.closest?.('[data-slot="part-card"]')) return
      onClose()
    }
    window.addEventListener("pointerdown", away, true)
    return () => window.removeEventListener("pointerdown", away, true)
  }, [onClose])

  const actions = React.useMemo<PaletteActions>(
    () => ({
      activate: (def, e) => {
        if (clickEndsDrag()) return
        onPlace(def, e.shiftKey)
        // Shift+click places more: the keyboard stays in the box for the next query.
        if (e.shiftKey) input.current?.focus()
      },
      take: (def) => {
        if (def) hideCard()
        onTake(def)
      },
      armed: null,
      favourites: new Set(quick.favourites),
    }),
    [onPlace, onTake, quick.favourites],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // The key that opened the panel shuts it again.
    if (opensQuickInsert(e.nativeEvent, "text")) {
      e.preventDefault()
      e.stopPropagation()
      return dismiss()
    }
    // A key straight after typing can come before the deferred rows have caught up: it acts on the rows of what is typed.
    const typedNow = live.current.query
    const keyRows = typedNow === query ? rows : pickableRows(typedNow, quick.recent, quick.favourites)
    const out = quickKey(live.current, e, keyRows)
    if (out.kind === "pass") return
    e.preventDefault()
    e.stopPropagation()
    if (out.kind === "close") return dismiss()
    update(out.state)
    if (out.kind === "place") onPlace(out.entry.def, out.keepOpen)
  }
  // An HDL module is started from the panel, then written in its own: the panel's part is done.
  const hdlNew = onHdlNew && ((language: HdlLanguage) => (onClose(), onHdlNew(language)))
  const hdlImport = onHdlImport && (() => (onClose(), onHdlImport()))

  let index = 0
  return (
    <Actions.Provider value={actions}>
      <div
        ref={panel}
        role="dialog"
        aria-label="Quick insert"
        data-slot="quick-insert"
        className="fixed z-50 flex flex-col overflow-hidden rounded-xl border bg-sidebar text-sidebar-foreground shadow-xl ring-1 ring-black/5 dark:ring-white/10"
        style={{ left: pos.left, top: pos.top, width, maxHeight }}
      >
        <div className="relative shrink-0 border-b p-2">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-4.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={input}
            data-slot="quick-insert-search"
            value={state.query}
            onChange={(e) => update(typed(e.target.value))}
            onKeyDown={onKeyDown}
            placeholder="Add a part here…"
            aria-label="Search parts to add here"
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-full rounded-lg border bg-background pr-2 pl-8 text-[13px] outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          />
        </div>
        <SidebarContent className="min-h-0 py-1">
          {searching ? (
            <SearchResults query={query} search={search} selected={selected} onHdlNew={hdlNew} onHdlImport={hdlImport} />
          ) : sections.length ? (
            sections.map((section) => (
              <SidebarGroup key={section.label} className="py-0.5">
                <Heading count={section.entries.length}>{section.label}</Heading>
                <SidebarMenu>
                  {section.entries.map((entry) => {
                    const i = index++
                    return <PartRow key={entry.key} entry={entry} selected={i === selected} />
                  })}
                </SidebarMenu>
              </SidebarGroup>
            ))
          ) : (
            <p className="px-4 py-3 text-xs text-muted-foreground">Type a part’s name, kind or number: “led”, “lcd i2c”, “ws2812”.</p>
          )}
        </SidebarContent>
        <p className="flex shrink-0 items-center gap-1 border-t px-3 py-1.5 text-[11px] whitespace-nowrap text-muted-foreground pointer-coarse:hidden">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> select · <Kbd>{RETURN}</Kbd> place · <Kbd>⇧</Kbd>
          <Kbd>{RETURN}</Kbd> more · <Kbd>Esc</Kbd> close
        </p>
      </div>
    </Actions.Provider>
  )
}
