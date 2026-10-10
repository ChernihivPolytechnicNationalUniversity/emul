import * as React from "react"
import { ChevronDownIcon, FileUpIcon, PencilIcon, PlusIcon, SearchIcon } from "lucide-react"
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
import { PALETTE_DRAG_TYPE, paletteGroups, useLibrary } from "./items"
import { useGroupsOpen } from "./collapsed-groups"
import type { ComponentDef } from "@/schematic/types"
import type { HdlLanguage } from "emul-shared/hdl"
import { HdlIcon } from "@/schematic/icons"

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

export function ComponentsSidebar({ onPick, onHdlNew, onHdlImport, onHdlOpen, ...props }: ComponentsSidebarProps) {
  const library = useLibrary()
  const [query, setQuery] = React.useState("")
  const q = query.trim().toLowerCase()
  const groupsOpen = useGroupsOpen(q)

  const hdl = library.filter((e) => !q || e.module.name.toLowerCase().includes(q))
  const groups = paletteGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => !q || i.name.toLowerCase().includes(q) || i.keywords?.some((k) => k.toLowerCase().includes(q))) }))
    .filter((g) => g.items.length > 0)

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <div className="px-2 pt-1 text-sm font-semibold">Components</div>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <SidebarInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="pl-8"
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {groups.length === 0 && hdl.length === 0 && q && (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            Nothing found
          </div>
        )}
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
        {groups.map((group) => (
          <PaletteSection key={group.id} label={group.label} open={groupsOpen.isOpen(group.id)} onOpenChange={(open) => groupsOpen.setOpen(group.id, open)}>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(PALETTE_DRAG_TYPE, item.id)
                      e.dataTransfer.effectAllowed = "copy"
                    }}
                    onClick={() => onPick?.(item)}
                    title={item.description}
                    className="cursor-grab active:cursor-grabbing [&>svg]:size-5"
                  >
                    <item.icon />
                    <span>{item.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </PaletteSection>
        ))}
      </SidebarContent>
    </Sidebar>
  )
}
