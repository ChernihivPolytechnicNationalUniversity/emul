import * as React from "react"
import { CrosshairIcon, HandIcon, MousePointer2Icon, SquarePlusIcon } from "lucide-react"
import { KEYMAP, labelFor } from "@/lib/keymap"
import type { Keys } from "@/lib/keys"
import { TOOL_GROUPS, WIRE_MODE_CHOICES, type ToolId, type ToolSpec } from "@/lib/tools"
import { cn } from "@/lib/utils"
import type { LineMode } from "@/schematic/wire-draw"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

function WireIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 18h7V6h9" />
      <circle cx="4" cy="18" r="1.6" fill="currentColor" />
      <circle cx="20" cy="6" r="1.6" fill="currentColor" />
    </svg>
  )
}

const ICONS: Record<ToolId, React.ComponentType<React.ComponentProps<"svg">>> = {
  select: MousePointer2Icon,
  hand: HandIcon,
  wire: WireIcon,
  part: SquarePlusIcon,
  probe: CrosshairIcon,
}

const KEYCAP = "inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] border border-b-2 px-1 font-mono text-[10px] leading-none pointer-coarse:hidden"

const keyOf = (keys: Keys) => labelFor(keys)

export type StripContext =
  | { kind: "wire"; mode: LineMode; onMode: (mode: LineMode) => void }
  | { kind: "hint"; text: string }

type FieldToolbarProps = {
  active: ToolId
  onTool: (tool: ToolId) => void
  strip: StripContext | null
  className?: string
}

const stopField = { onPointerDown: (e: React.PointerEvent) => e.stopPropagation(), onTouchStart: (e: React.TouchEvent) => e.stopPropagation() }

export function FieldToolbar({ active, onTool, strip, className }: FieldToolbarProps) {
  return (
    <div className={cn("pointer-events-none absolute top-3 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-col items-center gap-2", className)}>
      <div data-slot="field-toolbar" role="toolbar" aria-label="Tools" aria-orientation="horizontal" className="pointer-events-auto flex items-center gap-1 rounded-lg border bg-background/95 p-1 shadow-sm backdrop-blur-sm" {...stopField}>
        {TOOL_GROUPS.map((group, index) => (
          <React.Fragment key={group[0].id}>
            {index > 0 && <div role="separator" aria-orientation="vertical" className="mx-0.5 h-6 w-px bg-border" />}
            {group.map((tool) => (
              <ToolButton key={tool.id} tool={tool} pressed={active === tool.id} onPress={() => onTool(tool.id)} />
            ))}
          </React.Fragment>
        ))}
      </div>
      {strip && <ToolStrip context={strip} />}
    </div>
  )
}

function ToolButton({ tool, pressed, onPress }: { tool: ToolSpec; pressed: boolean; onPress: () => void }) {
  const Icon = ICONS[tool.id]
  const key = keyOf(tool.keys)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-tool={tool.id}
            aria-pressed={pressed}
            aria-keyshortcuts={key}
            aria-label={tool.name}
            onClick={onPress}
            className={cn(
              "inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium outline-none transition-colors pointer-coarse:h-11 pointer-coarse:min-w-11",
              "focus-visible:ring-2 focus-visible:ring-ring",
              pressed ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted",
            )}
          />
        }
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span data-slot="tool-name" className="max-lg:hidden">
          {tool.name}
        </span>
        <kbd className={cn(KEYCAP, pressed ? "border-primary-foreground/40 text-primary-foreground" : "bg-background text-foreground/70")}>{key}</kbd>
      </TooltipTrigger>
      <TooltipContent side="bottom" className={tool.note ? "flex-col items-start gap-0.5" : undefined}>
        <span>
          {tool.name} — {key}
        </span>
        {tool.note && <span className="text-background/70">{tool.note}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

function ToolStrip({ context }: { context: StripContext }) {
  return (
    <div data-slot="tool-strip" className="pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto rounded-lg border bg-background/95 p-1 text-xs whitespace-nowrap shadow-sm backdrop-blur-sm" {...stopField}>
      {context.kind === "wire" && <WireModes mode={context.mode} onMode={context.onMode} />}
      {context.kind === "hint" && <span className="px-2 py-1 text-muted-foreground">{context.text}</span>}
    </div>
  )
}

function WireModes({ mode, onMode }: { mode: LineMode; onMode: (mode: LineMode) => void }) {
  const lineKey = labelFor(KEYMAP.lineMode)
  return (
    <>
      <div role="radiogroup" aria-label="Wire angle" aria-keyshortcuts={lineKey} className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
        {WIRE_MODE_CHOICES.map((choice) => (
          <Tooltip key={choice.mode}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="radio"
                  data-mode={choice.mode}
                  aria-checked={choice.mode === mode}
                  aria-label={choice.name}
                  onClick={() => onMode(choice.mode)}
                  className={cn(
                    "inline-flex h-7 min-w-10 items-center justify-center rounded-[5px] px-2 font-medium tabular-nums outline-none pointer-coarse:h-11 focus-visible:ring-2 focus-visible:ring-ring",
                    choice.mode === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                />
              }
            >
              {choice.short}
            </TooltipTrigger>
            <TooltipContent side="bottom">{choice.name}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <kbd className={cn(KEYCAP, "h-5 bg-background text-foreground/70")}>{lineKey}</kbd>
      <span className="pr-2 text-muted-foreground pointer-coarse:hidden">/ which leg first · Backspace takes a corner back · Enter finishes · 0–9, C, M colour · Esc stops</span>
    </>
  )
}
