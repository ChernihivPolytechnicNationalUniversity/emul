import * as React from "react"
import { ChevronDownIcon, ExternalLinkIcon, FileUpIcon, PencilIcon, PlusIcon, SearchIcon, WrenchIcon } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { PALETTE_DRAG_TYPE, hitEntries, paletteGroups, useLibrary, type PaletteEntry } from "./items"
import { useGroupsOpen } from "./collapsed-groups"
import type { ComponentDef } from "@/schematic/types"
import type { HdlLanguage } from "emul-shared/hdl"
import { HdlIcon } from "@/schematic/icons"
import { registry } from "@/schematic/registry"
import { BoardTile } from "./BoardTile"
import { highlight, requestPartUrl, searchParts, toolHints, type SearchHit } from "./search"

type ComponentsSidebarProps = React.ComponentProps<typeof Sidebar> & {
  /** Called when an item is clicked (drag-and-drop onto the field comes later). */
  onPick?: (item: ComponentDef) => void
  onHdlNew?: (language: HdlLanguage) => void
  onHdlImport?: () => void
  onHdlOpen?: (id: string) => void
}

function PaletteSection({ label, open, onOpenChange, children }: { label: string; open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="group/collapsible">
      <SidebarGroup>
        <SidebarGroupLabel render={<CollapsibleTrigger />} className="w-full hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
          {label}
          <ChevronDownIcon className="ml-auto transition-transform duration-200 ease-out group-data-open/collapsible:rotate-180 motion-reduce:transition-none" />
        </SidebarGroupLabel>
        <CollapsibleContent className="-m-0.5 h-(--collapsible-panel-height) overflow-hidden p-0.5 transition-[height,padding] duration-200 ease-out data-ending-style:h-0 data-ending-style:py-0 data-starting-style:h-0 data-starting-style:py-0 motion-reduce:transition-none">
          <SidebarGroupContent>{children}</SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

const HDL_GROUP = "hdl"

/** The name with the letters the query matched picked out. */
function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  let at = 0
  for (const [a, b] of ranges) {
    if (a > at) parts.push(text.slice(at, a))
    parts.push(
      <mark key={a} className="rounded-[2px] bg-primary/15 font-semibold text-inherit">
        {text.slice(a, b)}
      </mark>,
    )
    at = b
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

function PartRow({ entry, onPick, ranges = [], active }: { entry: PaletteEntry; onPick?: (item: ComponentDef) => void; ranges?: [number, number][]; active?: boolean }) {
  const item = entry.def
  const title = entry.family ? `Places ${item.name}; ${entry.family.variants.length - 1} more variants in the inspector` : item.description
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PALETTE_DRAG_TYPE, item.id)
          e.dataTransfer.effectAllowed = "copy"
        }}
        onClick={() => onPick?.(item)}
        title={title}
        isActive={active}
        className="cursor-grab active:cursor-grabbing [&>svg]:size-5"
      >
        <item.icon />
        <span className="min-w-0 truncate">
          <Highlighted text={entry.name} ranges={ranges} />
        </span>
        {entry.hint && <span className="ml-auto max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{entry.hint}</span>}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function SearchResults({ query, hits, onPick }: { query: string; hits: SearchHit[]; onPick?: (item: ComponentDef) => void }) {
  const tools = toolHints(query)
  const rows = hitEntries(hits)
  return (
    <SidebarGroup>
      {tools.map((t) => (
        <div key={t.name} className="mx-2 mb-1 flex items-start gap-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          <WrenchIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t.name} is a tool, not a part: <span className="font-medium text-foreground">{t.where}</span>
            {t.shortcut && (
              <>
                {" "}
                or press <kbd className="rounded border bg-background px-1 font-mono">{t.shortcut}</kbd>
              </>
            )}
          </span>
        </div>
      ))}
      {hits.length > 0 ? (
        <>
          <div className="px-2 pb-1 text-xs text-muted-foreground" aria-live="polite">
            {hits[0].corrected ? `Nothing matches “${query.trim()}”; close spellings:` : `${rows.length} ${rows.length === 1 ? "part" : "parts"}`}
          </div>
          <SidebarGroupContent>
            <SidebarMenu>
              {rows.map((row, i) => (
                <PartRow key={row.key} entry={row} ranges={row.hit.corrected ? [] : row.family ? highlight(row.name, query) : row.hit.ranges} active={i === 0} onPick={onPick} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </>
      ) : (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground" aria-live="polite">
          <p>No parts match “{query.trim()}”.</p>
          <a href={requestPartUrl(query)} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline">
            Request this part
            <ExternalLinkIcon className="size-3.5" />
          </a>
          <p className="mt-1 text-xs">Opens a GitHub issue with the name filled in.</p>
        </div>
      )}
    </SidebarGroup>
  )
}

export function ComponentsSidebar({ onPick, onHdlNew, onHdlImport, onHdlOpen, ...props }: ComponentsSidebarProps) {
  const library = useLibrary()
  const [query, setQuery] = React.useState("")
  const q = query.trim().toLowerCase()
  const groupsOpen = useGroupsOpen(q)

  const hdl = library.filter((e) => !q || e.module.name.toLowerCase().includes(q))
  const hits = React.useMemo(() => searchParts(registry, query), [query])

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <div className="px-2 pt-1 text-sm font-semibold">Components</div>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <SidebarInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits[0]) {
                e.preventDefault()
                onPick?.(hits[0].def)
              } else if (e.key === "Escape") {
                e.preventDefault()
                if (query) setQuery("")
                else e.currentTarget.blur()
              }
            }}
            placeholder="Search parts…"
            aria-label="Search parts"
            className="pl-8"
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {(!q || hdl.length > 0) && (
          <PaletteSection label="HDL · VHDL / Verilog" open={groupsOpen.isOpen(HDL_GROUP)} onOpenChange={(open) => groupsOpen.setOpen(HDL_GROUP, open)}>
            <SidebarMenu>
              {hdl.map(({ module, def }) => (
                <SidebarMenuItem key={module.id}>
                  <SidebarMenuButton
                    draggable={!!def}
                    onDragStart={(e) => {
                      if (!def) return
                      e.dataTransfer.setData(PALETTE_DRAG_TYPE, def.id)
                      e.dataTransfer.effectAllowed = "copy"
                    }}
                    onClick={() => (def ? onPick?.(def) : onHdlOpen?.(module.id))}
                    title={def ? def.description : "Not built yet: open to build"}
                    className="cursor-grab active:cursor-grabbing [&>svg]:size-5"
                  >
                    <HdlIcon />
                    <span className={def ? undefined : "text-muted-foreground italic"}>{module.name}</span>
                  </SidebarMenuButton>
                  <SidebarMenuAction showOnHover onClick={() => onHdlOpen?.(module.id)} title="Edit source" aria-label={`Edit ${module.name}`}>
                    <PencilIcon />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              ))}
              {!q && (
                <>
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={() => onHdlNew?.("vhdl")} className="text-muted-foreground">
                      <PlusIcon />
                      <span>New VHDL component</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={() => onHdlNew?.("verilog")} className="text-muted-foreground">
                      <PlusIcon />
                      <span>New Verilog component</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={() => onHdlImport?.()} className="text-muted-foreground">
                      <FileUpIcon />
                      <span>Import .vhd / .v…</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </>
              )}
            </SidebarMenu>
          </PaletteSection>
        )}
        {q ? (
          <SearchResults query={query} hits={hits} onPick={onPick} />
        ) : (
          paletteGroups.map((group) => (
            <PaletteSection key={group.id} label={group.label} open={groupsOpen.isOpen(group.id)} onOpenChange={(open) => groupsOpen.setOpen(group.id, open)}>
              {group.id === "boards" ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-0.5 px-2 pb-1">
                  {group.entries.map((entry) => (
                    <BoardTile key={entry.key} entry={entry} onPick={onPick} />
                  ))}
                </div>
              ) : (
                <>
                  {group.id === "mcus" && <p className="mx-2 mb-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">Bare chips: power, clock, reset and decoupling are yours to wire. A board has them.</p>}
                  <SidebarMenu>
                    {group.entries.map((entry) => (
                      <PartRow key={entry.key} entry={entry} onPick={onPick} />
                    ))}
                  </SidebarMenu>
                </>
              )}
            </PaletteSection>
          ))
        )}
      </SidebarContent>
    </Sidebar>
  )
}
