import { CrosshairIcon, GaugeIcon, PauseIcon, PlayIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { SimReadout } from "@/sim/use-simulation"
import { SPEEDS, formatSpeed as format } from "@/sim/speeds"

/** Slider range; wider than the presets and logarithmic, so every decade gets the same travel. */
const MIN_SPEED = 0.01
const MAX_SPEED = 4
/** Slider steps per decade: ~1.5% per step near 1×. */
const STEPS_PER_DECADE = 160
/** Below this share of the requested speed the gauge shows what the solver actually manages. */
const LAGGING = 0.9

const toSlider = (speed: number) => Math.round(Math.log10(speed / MIN_SPEED) * STEPS_PER_DECADE)
const fromSlider = (pos: number) => MIN_SPEED * 10 ** (pos / STEPS_PER_DECADE)
const SLIDER_MAX = toSlider(MAX_SPEED)

/** Snap to a preset when the slider lands within half a step of it, so 1× stays reachable. */
function snap(speed: number) {
  const preset = SPEEDS.find((s) => Math.abs(Math.log10(s.value / speed)) < 0.5 / STEPS_PER_DECADE)
  return preset ? preset.value : Number(speed.toPrecision(2))
}

type SimControlsProps = React.ComponentProps<"div"> & {
  sim: SimReadout
  speed: number
  /** False before the first step: there is nothing to start over from. */
  started: boolean
  /** Whether clicks on the field are placing probe tips. */
  probing: boolean
  onProbeToggle: () => void
  onToggle: () => void
  onRestart: () => void
  onSpeedChange: (speed: number) => void
}

export function SimControls({ sim, speed, started, probing, onProbeToggle, onToggle, onRestart, onSpeedChange, className, ...props }: SimControlsProps) {
  // A heavy circuit (an MCU rendering a display) can't keep up with the setting: the gauge then
  // reads the achieved speed, not the wish, and says so.
  const lagging = sim.running && sim.rate !== null && sim.rate < speed * LAGGING
  return (
    <div data-slot="sim-controls" className={cn("flex items-center gap-2", className)} {...props}>
      <ButtonGroup>
        <Tooltip>
          <TooltipTrigger render={<Button variant={sim.running ? "secondary" : "default"} size="sm" onClick={onToggle} />}>
            {sim.running ? <PauseIcon /> : <PlayIcon />}
            {sim.running ? "Pause" : "Run"}
          </TooltipTrigger>
          <TooltipContent>{sim.running ? "Pause simulation" : "Run electrical simulation"}</TooltipContent>
        </Tooltip>
        <ButtonGroupSeparator />
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" disabled={!started} onClick={onRestart} />}>
            <RotateCcwIcon />
          </TooltipTrigger>
          <TooltipContent>{started ? "Start over from 0 s" : "Nothing to start over yet"}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" className={cn("tabular-nums", lagging && "text-amber-600 dark:text-amber-400")} />}>
                  <GaugeIcon />
                  {format(lagging ? sim.rate! : speed)}
                </DropdownMenuTrigger>
              }
            />
            <TooltipContent>
              {lagging ? `Running at ${format(sim.rate!)}: the circuit is too heavy for the ${format(speed)} setting` : "Simulation speed"}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="top" align="start" className="w-48">
            <div className="flex items-center gap-2 px-1.5 py-1.5">
              <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{format(speed)}</span>
              <Slider
                aria-label="Simulation speed"
                min={0}
                max={SLIDER_MAX}
                step={1}
                value={toSlider(speed)}
                onValueChange={(v) => onSpeedChange(snap(fromSlider(Array.isArray(v) ? v[0] : v)))}
              />
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={String(speed)} onValueChange={(v) => onSpeedChange(Number(v))}>
              {SPEEDS.map((s) => (
                <DropdownMenuRadioItem key={s.value} value={String(s.value)}>
                  <span className="w-12 shrink-0 tabular-nums text-muted-foreground">{format(s.value)}</span>
                  {s.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <ButtonGroupSeparator />
        <Tooltip>
          <TooltipTrigger render={<Button variant={probing ? "default" : "outline"} size="icon-sm" onClick={onProbeToggle} aria-pressed={probing} />}>
            <CrosshairIcon />
          </TooltipTrigger>
          <TooltipContent>{probing ? "Stop probing (M)" : "Probe the voltage between two points (M)"}</TooltipContent>
        </Tooltip>
      </ButtonGroup>
      {sim.live && (
        <Badge variant="secondary" className="tabular-nums">
          {sim.time.toFixed(3)} s
        </Badge>
      )}
      {sim.live && !sim.converged && (
        <Tooltip>
          <TooltipTrigger render={<Badge variant="destructive" />}>
            <TriangleAlertIcon />
            no convergence
          </TooltipTrigger>
          <TooltipContent>The solver did not settle this step; readings may be off.</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
