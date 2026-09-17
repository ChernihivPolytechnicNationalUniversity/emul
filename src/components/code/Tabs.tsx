import * as React from "react"
import { toast } from "sonner"
import { XIcon } from "lucide-react"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"

type TabsProps = Omit<React.ComponentProps<"div">, "onChange"> & {
  open: string[]
  active: string | null
  onActivate: (path: string) => void
  /** Any change to the set or order of tabs, with the tab to show after it. */
  onChange: (open: string[], active: string | null) => void
}

const DRAG_TYPE = "application/x-emul-tab"

/**
 * The open files, one tab each, the way an editor shows them: name, folder in grey, a close
 * cross; middle-click closes, drag reorders, the wheel scrolls the strip, right-click has the
 * close-others family.
 */
export function Tabs({ open, active, onActivate, onChange, className, ...props }: TabsProps) {
  const strip = React.useRef<HTMLDivElement>(null)
  const target = React.useRef<string | null>(null)
  const [menuPath, setMenuPath] = React.useState<string | null>(null)
  const [dropAt, setDropAt] = React.useState<number | null>(null)

  // The tab just activated comes into view, as when a file is opened from the explorer.
  React.useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [active])

  /** Close some tabs; the active one moves to the nearest survivor when it goes. */
  const close = (gone: string[]) => {
    const rest = open.filter((p) => !gone.includes(p))
    let next = active
    if (active && gone.includes(active)) {
      const i = open.indexOf(active)
      next = rest[Math.min(i, rest.length - 1)] ?? null
    }
    onChange(rest, next)
  }
  const reorder = (path: string, to: number) => {
    const from = open.indexOf(path)
    if (from < 0) return
    const next = open.filter((p) => p !== path)
    next.splice(to > from ? to - 1 : to, 0, path)
    onChange(next, active)
  }

  return (
    <ContextMenu
      onOpenChange={(isOpen) => {
        setMenuPath(isOpen ? target.current : null)
        if (!isOpen) target.current = null
      }}
    >
      <ContextMenuTrigger
        ref={strip}
        role="tablist"
        data-slot="tabs"
        className={cn("flex h-8 min-w-0 items-stretch overflow-x-auto bg-sidebar [scrollbar-width:none]", className)}
        onWheel={(e) => {
          // A mouse wheel has no horizontal axis; its vertical turn walks the strip.
          if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY
        }}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) target.current = null
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
          e.preventDefault()
          if (e.target === e.currentTarget) setDropAt(open.length)
        }}
        onDrop={(e) => {
          e.preventDefault()
          const path = e.dataTransfer.getData(DRAG_TYPE)
          if (path) reorder(path, dropAt ?? open.length)
          setDropAt(null)
        }}
        onDragEnd={() => setDropAt(null)}
        {...props}
      >
        {open.map((path, i) => {
          const slash = path.lastIndexOf("/")
          const name = slash < 0 ? path : path.slice(slash + 1)
          const dir = slash < 0 ? "" : path.slice(0, slash)
          const current = path === active
          return (
            <div
              key={path}
              role="tab"
              aria-selected={current}
              title={path}
              draggable
              className={cn(
                "group relative flex max-w-48 shrink-0 cursor-default items-center gap-1.5 border-r pr-1 pl-3 text-xs select-none",
                current ? "bg-background text-foreground" : "text-muted-foreground hover:bg-accent/60",
                menuPath === path && "ring-1 ring-inset ring-ring",
                dropAt === i && "before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-primary",
                dropAt === i + 1 && i === open.length - 1 && "after:absolute after:inset-y-1 after:right-0 after:w-0.5 after:bg-primary",
              )}
              onClick={() => onActivate(path)}
              onAuxClick={(e) => e.button === 1 && close([path])}
              onContextMenu={() => (target.current = path)}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, path)
                e.dataTransfer.effectAllowed = "move"
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
                e.preventDefault()
                e.stopPropagation()
                const r = e.currentTarget.getBoundingClientRect()
                setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1)
              }}
            >
              <span className="truncate">{name}</span>
              {dir && <span className="truncate text-[0.6875rem] text-muted-foreground/70">{dir}</span>}
              <button
                type="button"
                aria-label={`Close ${name}`}
                className={cn(
                  "ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-accent",
                  current ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70",
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  close([path])
                }}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          )
        })}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {menuPath && (
          <>
            <ContextMenuItem onClick={() => close([menuPath])}>Close</ContextMenuItem>
            <ContextMenuItem disabled={open.length < 2} onClick={() => close(open.filter((p) => p !== menuPath))}>
              Close others
            </ContextMenuItem>
            <ContextMenuItem disabled={open.indexOf(menuPath) === open.length - 1} onClick={() => close(open.slice(open.indexOf(menuPath) + 1))}>
              Close to the right
            </ContextMenuItem>
          </>
        )}
        <ContextMenuItem disabled={open.length === 0} onClick={() => close(open)}>
          Close all
        </ContextMenuItem>
        {menuPath && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() =>
                navigator.clipboard.writeText(menuPath).then(
                  () => toast(`Copied ${menuPath}`),
                  () => toast.error("Could not copy"),
                )
              }
            >
              Copy path
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
