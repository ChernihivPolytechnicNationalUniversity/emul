import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { SidebarMenu } from "@/components/ui/sidebar"

/** A list this long renders whole: nothing to save, and the browser's find-in-page sees every row. */
export const WINDOW_FROM = 60
/** A row's height before it is measured: 32 px, 44 under a finger (pointer-coarse:h-11). */
const ROW_PX = 32

/** Where a row of the list goes: handed to the row, which puts it on its <li>. */
export type RowSlot = { ref?: (el: HTMLElement | null) => void; style?: React.CSSProperties; "data-index"?: number }

/**
 * Rows of the palette, drawn only where the panel shows them once a list grows long: a search that
 * matches two thousand parts lays out the thirty on screen. The list scrolls with the panel (no
 * scroller of its own), so the virtualizer reads the panel's scroll with the list's own offset in it.
 * `selected` is the keyboard's row: it is brought into view.
 */
export function VirtualRows<T>({ items, row, selected, className }: { items: readonly T[]; row: (item: T, index: number, slot: RowSlot) => React.ReactNode; selected?: number; className?: string }) {
  if (items.length < WINDOW_FROM) return <SidebarMenu className={className}>{items.map((item, i) => row(item, i, {}))}</SidebarMenu>
  return <Windowed items={items} row={row} selected={selected} className={className} />
}

function Windowed<T>({ items, row, selected, className }: { items: readonly T[]; row: (item: T, index: number, slot: RowSlot) => React.ReactNode; selected?: number; className?: string }) {
  const list = React.useRef<HTMLUListElement>(null)
  const [scroller, setScroller] = React.useState<HTMLElement | null>(null)
  const [margin, setMargin] = React.useState(0)

  React.useLayoutEffect(() => {
    const el = list.current
    const panel = el?.closest<HTMLElement>('[data-slot="sidebar-content"]')
    if (!el || !panel) return
    setScroller(panel)
    // The list's top within the panel's content: moves when a section above opens or closes, not on scroll.
    const measure = () => setMargin(el.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop)
    measure()
    const observer = new ResizeObserver(measure)
    for (const child of panel.children) observer.observe(child)
    return () => observer.disconnect()
  }, [])

  // The virtualizer hands out fresh positions each render: this component is left unmemoised on purpose.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_PX,
    overscan: 10,
    scrollMargin: margin,
  })

  React.useEffect(() => {
    if (selected !== undefined && selected >= 0) virtualizer.scrollToIndex(selected, { align: "auto" })
  }, [selected, virtualizer])

  return (
    <SidebarMenu ref={list} className={className} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((v) =>
        row(items[v.index], v.index, {
          ref: virtualizer.measureElement,
          "data-index": v.index,
          style: { position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start - margin}px)` },
        }),
      )}
    </SidebarMenu>
  )
}
