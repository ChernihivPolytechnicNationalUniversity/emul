import * as React from "react"
import { CrosshairIcon, HandIcon, MousePointer2Icon, SquarePlusIcon } from "lucide-react"
import { KEYMAP, labelFor } from "@/lib/keymap"
import { TOOL_GROUPS, WIRE_MODE_CHOICES, type ToolId, type ToolSpec } from "@/lib/tools"
import { cn } from "@/lib/utils"
import type { LineMode } from "@/schematic/wire-draw"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type IconProps = React.ComponentProps<"svg">

const WIRE_SHAPES: Record<LineMode, { d: string; ends: readonly [readonly [number, number], readonly [number, number]] }> = {
  "90": { d: "M4 18h8V6h8", ends: [[4, 18], [20, 6]] },
  "45": { d: "M4 18h6l8-8V5", ends: [[4, 18], [18, 5]] },
  any: { d: "M4 19L20 5", ends: [[4, 19], [20, 5]] },
}

function WireIcon({ mode, ...props }: IconProps & { mode: LineMode }) {
  const shape = WIRE_SHAPES[mode]
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d={shape.d} />
      {shape.ends.map(([cx, cy]) => (
        <circle key={`${cx},${cy}`} cx={cx} cy={cy} r="1.6" fill="currentColor" />
      ))}
    </svg>
  )
}

const ICONS: Record<Exclude<ToolId, "wire">, React.ComponentType<IconProps>> = {
  select: MousePointer2Icon,
  hand: HandIcon,
  part: SquarePlusIcon,
  probe: CrosshairIcon,
}

const KEYCAP = "inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] border border-background/30 px-1 font-mono text-[10px] leading-none"
const BUTTON = "relative inline-flex size-7 group-data-docked/tools:size-8 items-center justify-center rounded-md outline-none transition-colors pointer-coarse:size-11 focus-visible:ring-2 focus-visible:ring-ring"
const pressedLook = (pressed: boolean) => (pressed ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted")

type FieldToolbarProps = {
  active: ToolId
  onTool: (tool: ToolId) => void
  wireMode: LineMode
  onWireMode: (mode: LineMode) => void
  showAngles: boolean
  docked?: boolean
  className?: string
}

const stopField = { onPointerDown: (e: React.PointerEvent) => e.stopPropagation(), onTouchStart: (e: React.TouchEvent) => e.stopPropagation() }

export function FieldToolbar({ active, onTool, wireMode, onWireMode, showAngles, docked = false, className }: FieldToolbarProps) {
  return (
    <div
      data-slot="field-toolbar"
      role="toolbar"
      aria-label="Tools"
      aria-orientation="vertical"
      data-docked={docked || undefined}
      className={cn(
        docked
          ? "group/tools flex flex-col items-center gap-0.5"
          : "group/tools absolute top-13 left-[9px] z-20 flex flex-col items-center gap-0.5 rounded-lg border bg-background/95 p-0.5 shadow-sm backdrop-blur-sm [@media(max-height:460px)]:grid [@media(max-height:460px)]:grid-cols-2",
        className,
      )}
      {...stopField}
    >
      {TOOL_GROUPS.map((group, index) => (
        <React.Fragment key={group[0].id}>
          {index > 0 && <div role="separator" aria-orientation="horizontal" className="my-0.5 h-px w-5 bg-border group-data-docked/tools:bg-sidebar-border [@media(max-height:460px)]:hidden" />}
          {group.map((tool) =>
            tool.id === "wire" ? (
              <WireButton key={tool.id} tool={tool} pressed={active === tool.id} mode={wireMode} showAngles={showAngles} onPress={() => onTool(tool.id)} onMode={onWireMode} />
            ) : (
              <ToolButton key={tool.id} tool={tool} pressed={active === tool.id} onPress={() => onTool(tool.id)} Icon={ICONS[tool.id]} />
            ),
          )}
        </React.Fragment>
      ))}
    </div>
  )
}

function ToolTip({ tool, extra }: { tool: ToolSpec; extra?: string }) {
  return (
    <TooltipContent side="right" className="flex-col items-start gap-0.5">
      <span className="flex items-center gap-2">
        {tool.name}
        <kbd className={KEYCAP}>{labelFor(tool.keys)}</kbd>
      </span>
      {extra && <span className="text-background/70">{extra}</span>}
      {tool.note && <span className="text-background/70">{tool.note}</span>}
    </TooltipContent>
  )
}

function ToolButton({ tool, pressed, onPress, Icon }: { tool: ToolSpec; pressed: boolean; onPress: () => void; Icon: React.ComponentType<IconProps> }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" data-tool={tool.id} aria-pressed={pressed} aria-keyshortcuts={labelFor(tool.keys)} aria-label={tool.name} onClick={onPress} className={cn(BUTTON, pressedLook(pressed))} />}>
        <Icon className="size-4" aria-hidden />
      </TooltipTrigger>
      <ToolTip tool={tool} />
    </Tooltip>
  )
}

function WireButton({ tool, pressed, mode, showAngles, onPress, onMode }: { tool: ToolSpec; pressed: boolean; mode: LineMode; showAngles: boolean; onPress: () => void; onMode: (mode: LineMode) => void }) {
  const lineKey = labelFor(KEYMAP.lineMode)
  const current = WIRE_MODE_CHOICES.find((c) => c.mode === mode)!
  return (
    <div className="relative" data-wire-mode={mode}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-tool={tool.id}
              aria-pressed={pressed}
              aria-keyshortcuts={labelFor(tool.keys)}
              aria-label={`${tool.name}, ${current.name.toLowerCase()}`}
              onClick={onPress}
              className={cn(BUTTON, pressedLook(pressed))}
            />
          }
        >
          <WireIcon mode={mode} className="size-4" aria-hidden />
        </TooltipTrigger>
        <ToolTip tool={tool} extra="Double-click the field or drag from a pin to start" />
      </Tooltip>
      {showAngles && (
        <div
          role="radiogroup"
          aria-label="Wire angle"
          aria-keyshortcuts={lineKey}
          data-slot="wire-angles"
          className="absolute top-1/2 left-full z-20 ml-3 flex -translate-y-1/2 items-center gap-0.5 rounded-lg border bg-background p-0.5 shadow-sm"
        >
          <span aria-hidden data-slot="wire-angles-tail" className="absolute top-1/2 -left-[5px] size-2.5 -translate-y-1/2 rotate-45 rounded-bl-[2px] border-b border-l bg-background" />
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
                    className={cn(BUTTON, pressedLook(choice.mode === mode))}
                  />
                }
              >
                <WireIcon mode={choice.mode} className="size-4" aria-hidden />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="flex items-center gap-2">
                {choice.name}
                <kbd className={KEYCAP}>{lineKey}</kbd>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  )
}

export function ToolHint({ text, className }: { text: string; className?: string }) {
  return (
    <div
      data-slot="tool-hint"
      className={cn(
        "pointer-events-none absolute top-3 left-1/2 z-20 max-w-[calc(100%-1.5rem)] -translate-x-1/2 truncate rounded-md border bg-background/95 px-3 py-1 text-xs whitespace-nowrap text-muted-foreground shadow-sm backdrop-blur-sm pointer-coarse:hidden",
        className,
      )}
    >
      {text}
    </div>
  )
}
