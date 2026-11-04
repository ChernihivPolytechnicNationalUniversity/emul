import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cn } from "cn"

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-3", className)} {...props} />
}

/** A segmented control: the tabs share one grey track, the open one raised in white. */
function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("flex gap-0.5 rounded-lg bg-muted p-0.5", className)} {...props} />
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-medium text-muted-foreground outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-disabled:text-muted-foreground/45 data-active:bg-background data-active:text-foreground data-active:shadow-xs",
        className,
      )}
      {...props}
    />
  )
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel data-slot="tabs-panel" className={cn("outline-hidden", className)} {...props} />
}

export { Tabs, TabsList, TabsTab, TabsPanel }
