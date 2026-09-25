import * as React from "react"
import { FileUpIcon, PencilIcon, PlusIcon, SearchIcon } from "lucide-react"
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

export function ComponentsSidebar({ onPick, onHdlNew, onHdlImport, onHdlOpen, ...props }: ComponentsSidebarProps) {
  const library = useLibrary()
  const [query, setQuery] = React.useState("")
  const q = query.trim().toLowerCase()

  const hdl = library.filter((e) => !q || e.module.name.toLowerCase().includes(q))
  const groups = paletteGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => !q || i.name.toLowerCase().includes(q)) }))
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
        <SidebarGroup>
          <SidebarGroupLabel>HDL · VHDL / Verilog</SidebarGroupLabel>
          <SidebarGroupContent>
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
          </SidebarGroupContent>
        </SidebarGroup>
        {groups.map((group) => (
          <SidebarGroup key={group.id}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
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
                      className="cursor-grab active:cursor-grabbing [&>svg]:size-5"
                    >
                      <item.icon />
                      <span>{item.name}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  )
}
