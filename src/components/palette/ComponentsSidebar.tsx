import * as React from "react"
import { SearchIcon } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { PALETTE_DRAG_TYPE, paletteGroups } from "./items"
import type { ComponentDef } from "@/schematic/types"

type ComponentsSidebarProps = React.ComponentProps<typeof Sidebar> & {
  /** Called when an item is clicked (drag-and-drop onto the field comes later). */
  onPick?: (item: ComponentDef) => void
}

export function ComponentsSidebar({ onPick, ...props }: ComponentsSidebarProps) {
  const [query, setQuery] = React.useState("")
  const q = query.trim().toLowerCase()

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
        {groups.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            Nothing found
          </div>
        )}
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
