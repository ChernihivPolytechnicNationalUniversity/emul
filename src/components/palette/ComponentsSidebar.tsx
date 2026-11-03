import * as React from "react"
import { ChevronRightIcon, CornerDownLeftIcon, FileUpIcon, PencilIcon, PlusIcon, SearchIcon, StarIcon, XIcon } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { hitEntries, paletteGroups, useLibrary, type PaletteEntry } from "./items"
import { useGroupsOpen } from "./collapsed-groups"
import type { ComponentDef } from "@/schematic/types"
import type { HdlLanguage } from "emul-shared/hdl"
import { HdlIcon } from "@/schematic/icons"
import { isModified } from "@/schematic/hdl"
import { getDef, registry } from "@/schematic/registry"
import { BoardTile } from "./BoardTile"
import { useQuickLists } from "./recents"
import { Actions, startDrag, usePaletteActions, type PaletteActions } from "./palette-actions"
import { FavouriteButton } from "./FavouriteButton"
import { hdlCreateMatch, highlight, requestPartUrl, searchParts, similarParts, toolHints } from "./search"

type ComponentsSidebarProps = React.ComponentProps<typeof Sidebar> & {
  /** Place the part at once, at the centre of the view: the keyboard's way in. */
  onPick?: (item: ComponentDef) => void
  /** The part taken in hand, for a click on the field to place. */
  armed?: string | null
  /** Take the part in hand (or put it back, if it is the one in hand). */
  onArm?: (item: ComponentDef) => void
  onHdlNew?: (language: HdlLanguage) => void
  onHdlImport?: () => void
  onHdlOpen?: (id: string) => void
}

/** Queries that show what the search understands: a kind, two words, a family, a part number, a need. */
const EXAMPLES = ["led", "lcd i2c", "stm32", "ws2812", "regulator 3.3"]

/** A heading over a run of rows, in the palette's one style: small capitals, a count, an action on the right. */
function Heading({ children, count, aside, action, className }: { children: React.ReactNode; count?: number; aside?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-7 items-center gap-1.5 px-2 text-[11px] font-semibold tracking-[.02em] text-muted-foreground uppercase", className)}>
      <span className="truncate">
        {children}
        {aside && <span className="font-medium"> · {aside}</span>}
      </span>
      {count !== undefined && <span className="font-medium text-muted-foreground/60 tabular-nums">{count}</span>}
      {action && <span className="ml-auto flex items-center">{action}</span>}
    </div>
  )
}

function PaletteSection({ label, aside, count, open, onOpenChange, action, children }: { label: string; aside?: string; count: number; open: boolean; onOpenChange: (open: boolean) => void; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="group/collapsible">
      <SidebarGroup className="relative py-0.5">
        <CollapsibleTrigger className={cn("flex w-full items-center rounded-md text-left outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring", action && "pr-7")}>
          <Heading count={count} aside={aside} className="min-w-0 flex-1">
            {label}
          </Heading>
          <ChevronRightIcon className="mr-2 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-open/collapsible:rotate-90 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        {action && <div className="absolute top-1.5 right-7">{action}</div>}
        <CollapsibleContent className="-m-0.5 h-(--collapsible-panel-height) overflow-hidden p-0.5 transition-[height,padding] duration-200 ease-out data-ending-style:h-0 data-ending-style:py-0 data-starting-style:h-0 data-starting-style:py-0 motion-reduce:transition-none">
          <SidebarGroupContent>{children}</SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

const HDL_GROUP = "hdl"

const MARK = "rounded-[3px] bg-yellow-200 px-px text-inherit dark:bg-yellow-500/35"

/** The name with the letters the query matched picked out. */
function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  let at = 0
  for (const [a, b] of ranges) {
    if (a > at) parts.push(text.slice(at, a))
    parts.push(
      <mark key={a} className={MARK}>
        {text.slice(a, b)}
      </mark>,
    )
    at = b
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-b-2 bg-background px-1 font-mono text-[10px] leading-none text-muted-foreground">{children}</kbd>
}

/** One part, one row: icon, name, and on the right what tells it apart (variants, the word that found it). */
function PartRow({ entry, ranges = [], matched, variant, selected }: { entry: PaletteEntry; ranges?: [number, number][]; matched?: string; variant?: string; selected?: boolean }) {
  const { activate, armed, favourites } = usePaletteActions()
  const item = entry.def
  const title = entry.family ? `${entry.family.variants.length} variants; this places ${item.name}, the inspector switches it` : item.description
  const inHand = armed === item.id
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        draggable
        onDragStart={(e) => startDrag(e, item)}
        onClick={(e) => activate(item, e)}
        title={title}
        isActive={inHand || selected}
        aria-pressed={inHand}
        className="cursor-grab text-[13px] active:cursor-grabbing [&>svg]:size-[18px]"
      >
        <item.icon />
        <span className="min-w-[40%] truncate">
          <Highlighted text={entry.name} ranges={ranges} />
        </span>
        <span className="ml-auto flex max-w-[50%] shrink-0 items-center gap-1 truncate text-[11px] text-muted-foreground group-hover/menu-item:invisible">
          {variant ? (
            <mark className={cn(MARK, "truncate")}>{variant}</mark>
          ) : matched ? (
            <>
              matched: <mark className={cn(MARK, "truncate")}>{matched}</mark>
            </>
          ) : (
            entry.hint && <span className="truncate">{entry.hint}</span>
          )}
          {selected && !variant && !matched && !entry.hint && (
            <Kbd>
              <CornerDownLeftIcon className="size-2.5" />
            </Kbd>
          )}
        </span>
      </SidebarMenuButton>
      <SidebarMenuAction showOnHover={!favourites.has(item.id)} render={<FavouriteButton def={item} />} />
    </SidebarMenuItem>
  )
}

/** Favourite or recent parts: round chips with the part's icon and name, wrapping. */
function QuickStrip({ label, ids, action }: { label: string; ids: readonly string[]; action?: React.ReactNode }) {
  const { activate, armed } = usePaletteActions()
  const defs = ids.flatMap((id) => getDef(id) ?? [])
  if (defs.length === 0) return null
  return (
    <SidebarGroup className="py-0.5">
      <Heading action={action}>{label}</Heading>
      <div className="flex flex-wrap gap-1.5 px-2 pb-1.5">
        {defs.map((def) => (
          <button
            key={def.id}
            type="button"
            draggable
            onDragStart={(e) => startDrag(e, def)}
            onClick={(e) => activate(def, e)}
            title={def.description ?? def.name}
            aria-pressed={armed === def.id}
            className={cn(
              "flex h-[26px] max-w-[11rem] min-w-0 cursor-grab items-center gap-1.5 rounded-full border bg-background pr-2.5 pl-1.5 text-xs outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring active:cursor-grabbing [&>svg]:size-4 [&>svg]:shrink-0",
              armed === def.id && "border-foreground bg-foreground text-background hover:bg-foreground",
            )}
          >
            <def.icon />
            <span className="truncate">{def.name}</span>
          </button>
        ))}
      </div>
    </SidebarGroup>
  )
}

function HdlCreateItems({ onHdlNew, onHdlImport }: Pick<ComponentsSidebarProps, "onHdlNew" | "onHdlImport">) {
  return (
    <>
      <DropdownMenuItem onClick={() => onHdlNew?.("vhdl")}>
        <PlusIcon />
        New VHDL component
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onHdlNew?.("verilog")}>
        <PlusIcon />
        New Verilog component
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onHdlImport?.()}>
        <FileUpIcon />
        Import .vhd / .v…
      </DropdownMenuItem>
    </>
  )
}

/** The search's rows, also what the arrow keys walk through and Enter places. */
function useSearchRows(query: string) {
  return React.useMemo(() => {
    const hits = searchParts(registry, query)
    const rows = hitEntries(hits)
    const similar = hits.length === 0 ? hitEntries(similarParts(registry, query)) : []
    return { hits, rows, similar, pickable: rows.length ? rows : similar }
  }, [query])
}

function SearchResults({ query, search, selected, onHdlNew, onHdlImport }: { query: string; search: ReturnType<typeof useSearchRows>; selected: number } & Pick<ComponentsSidebarProps, "onHdlNew" | "onHdlImport">) {
  const { hits, rows, similar } = search
  const tools = toolHints(query)
  const asked = query.trim()
  const hdl = hdlCreateMatch(query)
  return (
    <SidebarGroup className="pt-1" aria-live="polite">
      {tools.map((t) => (
        <div key={t.name} className="px-2 pb-2 text-xs">
          <p className="text-muted-foreground">That’s a tool, not a part:</p>
          <p className="mt-0.5 flex items-center gap-1.5 font-semibold">
            {t.where}
            {t.shortcut && <Kbd>{t.shortcut}</Kbd>}
          </p>
        </div>
      ))}
      {hdl && (
        // An HDL module is written, not picked: a search for one offers to start it.
        <>
          <Heading>New HDL module</Heading>
          <SidebarMenu className="mb-1">
            {(["vhdl", "verilog"] as const).map((lang) => (
              <SidebarMenuItem key={lang}>
                <SidebarMenuButton onClick={() => onHdlNew?.(lang)} className="text-[13px]">
                  <PlusIcon />
                  <span>New {lang === "vhdl" ? "VHDL" : "Verilog"} component</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => onHdlImport?.()} className="text-[13px]">
                <FileUpIcon />
                <span>Import .vhd / .v…</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </>
      )}
      {rows.length > 0 ? (
        <>
          {hits[0].correction ? (
            <p className="px-2 pb-1 text-xs text-muted-foreground">
              Showing results for <span className="font-semibold text-foreground">{hits[0].correction}</span>
            </p>
          ) : (
            <Heading count={rows.length}>From library</Heading>
          )}
          <SidebarMenu>
            {rows.map((row, i) => (
              <PartRow
                key={row.key}
                entry={row}
                ranges={row.hit.corrected ? [] : row.family ? highlight(row.name, query) : row.hit.ranges}
                // A family found by one of its other variants says which: that variant is what Enter places.
                variant={row.family && row.def.id !== row.family.variants[0][0] ? row.hint : undefined}
                matched={row.family ? undefined : row.hit.matched}
                selected={i === selected}
              />
            ))}
          </SidebarMenu>
        </>
      ) : (
        !hdl &&
        tools.length === 0 && (
          <div className="px-2 pt-1">
            <p className="text-sm font-semibold">No “{asked}” in the library yet</p>
            {similar.length > 0 && (
              <>
                <p className="mt-1 mb-1 text-xs text-muted-foreground">Similar parts:</p>
                <SidebarMenu className="-mx-2 w-auto">
                  {similar.map((row, i) => (
                    <PartRow key={row.key} entry={row} selected={i === selected} />
                  ))}
                </SidebarMenu>
              </>
            )}
            <a
              href={requestPartUrl(query)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 block rounded-lg border border-dashed px-3 py-2.5 outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                <PlusIcon className="size-3.5" />
                Request this part
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">Opens a GitHub issue titled “{asked}”</span>
            </a>
          </div>
        )
      )}
    </SidebarGroup>
  )
}

/** Before anything is typed: what the search understands, and its keys. */
function SearchIntro({ onExample }: { onExample: (q: string) => void }) {
  return (
    <div className="px-4 pb-2">
      <p className="text-xs text-muted-foreground">Search by name, type or part number:</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {EXAMPLES.map((q) => (
          <button
            key={q}
            type="button"
            // Keep the focus in the search box: the chip fills it, the student goes on typing.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onExample(q)}
            className="h-[26px] rounded-full border bg-background px-2.5 text-xs hover:bg-sidebar-accent"
          >
            {q}
          </button>
        ))}
      </div>
      <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> select · <Kbd>↵</Kbd> place · <Kbd>Esc</Kbd> close
      </p>
    </div>
  )
}

export function ComponentsSidebar({ onPick, armed = null, onArm, onHdlNew, onHdlImport, onHdlOpen, ...props }: ComponentsSidebarProps) {
  const library = useLibrary()
  const quick = useQuickLists()
  const [query, setQuery] = React.useState("")
  const [focused, setFocused] = React.useState(false)
  const [selected, setSelected] = React.useState(0)
  const input = React.useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const groupsOpen = useGroupsOpen(q)

  const hdl = library.filter((e) => !q || e.module.name.toLowerCase().includes(q))
  const search = useSearchRows(query)
  const favourites = React.useMemo(() => new Set(quick.favourites), [quick.favourites])
  const recent = quick.recent.filter((id) => !favourites.has(id)).slice(0, 6)

  const ask = (next: string) => {
    setQuery(next)
    setSelected(0)
  }

  const actions = React.useMemo<PaletteActions>(
    () => ({
      // A click has a pointer behind it (detail ≥ 1); Enter or Space on a focused row has none.
      activate: (def, e) => (e.detail === 0 ? onPick?.(def) : onArm?.(def)),
      armed,
      favourites,
    }),
    [onPick, onArm, armed, favourites],
  )

  const hdlMenu = (trigger: React.ReactElement) => (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent className="w-56">
        <HdlCreateItems onHdlNew={onHdlNew} onHdlImport={onHdlImport} />
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <Actions.Provider value={actions}>
      <Sidebar {...props}>
        <SidebarHeader className="pb-1">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <SidebarInput
              ref={input}
              data-slot="palette-search"
              value={query}
              onChange={(e) => ask(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                const rows = search.pickable
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  if (!rows.length) return
                  e.preventDefault()
                  setSelected((s) => (s + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length)
                } else if (e.key === "Enter" && rows[selected]) {
                  e.preventDefault()
                  onPick?.(rows[selected].def)
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  if (query) ask("")
                  else e.currentTarget.blur()
                }
              }}
              placeholder="Search parts…"
              aria-label="Search parts"
              className="h-8 rounded-lg bg-background pr-8 pl-8 text-[13px]"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  ask("")
                  input.current?.focus()
                }}
                aria-label="Clear the search"
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : (
              <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2" aria-hidden>
                <Kbd>/</Kbd>
              </span>
            )}
          </div>
        </SidebarHeader>
        <SidebarContent className="gap-0">
          {q ? (
            <SearchResults query={query} search={search} selected={selected} onHdlNew={onHdlNew} onHdlImport={onHdlImport} />
          ) : (
            <>
              {focused && <SearchIntro onExample={ask} />}
              <QuickStrip label="Recent" ids={recent} />
              <QuickStrip label="Favourites" ids={quick.favourites} action={<StarIcon className="size-3.5 fill-amber-400 text-amber-500" />} />
            </>
          )}
          {hdl.length > 0 && (
            // The project's own modules: only this project has them, and they are what it is about.
            <PaletteSection
              label="Project modules"
              aside="HDL"
              count={hdl.length}
              open={groupsOpen.isOpen(HDL_GROUP)}
              onOpenChange={(open) => groupsOpen.setOpen(HDL_GROUP, open)}
              action={
                !q &&
                hdlMenu(
                  <button type="button" aria-label="New HDL component" title="New HDL component" className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
                    <PlusIcon className="size-4" />
                  </button>,
                )
              }
            >
              <SidebarMenu>
                {hdl.map(({ module, def }) => {
                  const state = !def ? "not built" : isModified(module) ? "rebuild" : "built"
                  return (
                    <SidebarMenuItem key={module.id}>
                      <SidebarMenuButton
                        draggable={!!def}
                        onDragStart={(e) => def && startDrag(e, def)}
                        onClick={(e) => (def ? actions.activate(def, e) : onHdlOpen?.(module.id))}
                        title={def ? def.description : "Not built yet: open to build"}
                        isActive={!!def && armed === def.id}
                        className="cursor-grab text-[13px] active:cursor-grabbing [&>svg]:size-[18px]"
                      >
                        <HdlIcon />
                        <span className={cn("truncate", !def && "text-muted-foreground italic")}>{module.name}</span>
                        <span
                          className={cn(
                            "ml-auto shrink-0 rounded px-1.5 text-[11px] leading-[18px] group-hover/menu-item:invisible",
                            state === "rebuild" ? "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300" : "bg-muted text-muted-foreground",
                          )}
                        >
                          {state}
                        </span>
                      </SidebarMenuButton>
                      <SidebarMenuAction showOnHover onClick={() => onHdlOpen?.(module.id)} title="Edit source" aria-label={`Edit ${module.name}`}>
                        <PencilIcon />
                      </SidebarMenuAction>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </PaletteSection>
          )}
          {!q && (
            <>
              {(hdl.length > 0 || recent.length > 0 || quick.favourites.length > 0) && <SidebarSeparator className="my-1.5" />}
              {paletteGroups.map((group) => (
                <PaletteSection key={group.id} label={group.label} aside={group.aside} count={group.entries.length} open={groupsOpen.isOpen(group.id)} onOpenChange={(open) => groupsOpen.setOpen(group.id, open)}>
                  {group.id === "boards" ? (
                    <div className="grid grid-cols-2 gap-1.5 px-1 pt-0.5 pb-2">
                      {group.entries.map((entry) => (
                        <BoardTile key={entry.key} entry={entry} />
                      ))}
                    </div>
                  ) : (
                    <>
                      {group.id === "mcus" && (
                        <p className="mx-2 mb-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">Needs power, a clock, reset and decoupling wired by you. A board has them.</p>
                      )}
                      <SidebarMenu>
                        {group.entries.map((entry) => (
                          <PartRow key={entry.key} entry={entry} />
                        ))}
                      </SidebarMenu>
                    </>
                  )}
                </PaletteSection>
              ))}
              {library.length === 0 && (
                // No modules yet: one way in, at the end, not a section of buttons above the parts.
                <SidebarGroup className="py-0.5">
                  <SidebarMenu>
                    <SidebarMenuItem>
                      {hdlMenu(
                        <SidebarMenuButton className="text-[13px] text-muted-foreground [&>svg]:size-[18px]">
                          <HdlIcon />
                          <span title="VHDL or Verilog, written here or imported">New HDL component…</span>
                        </SidebarMenuButton>,
                      )}
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroup>
              )}
            </>
          )}
        </SidebarContent>
      </Sidebar>
    </Actions.Provider>
  )
}
