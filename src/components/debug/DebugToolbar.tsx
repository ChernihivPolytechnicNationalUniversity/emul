import { ArrowDownToLineIcon, ArrowUpFromLineIcon, BinaryIcon, CornerDownRightIcon, PauseIcon, PlayIcon, RedoDotIcon, RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { BoardView } from "@/debug/session"
import { excName } from "@/mcu/faults"
import { cn } from "@/lib/utils"

type Props = {
  view: BoardView
  running: boolean
  /** Where the stop is, for the status line: "main.c:27", or an address. */
  where: string | null
  /** The disassembly tab is the one shown: steps are instruction steps. */
  instructions: boolean
  disassembly: boolean
  onContinue: () => void
  onPause: () => void
  onStepOver: () => void
  onStepInto: () => void
  onStepOut: () => void
  onStepInstruction: () => void
  onRestart: () => void
  onDisassembly: () => void
}

function Tool({ label, keys, onClick, disabled, children, active }: { label: string; keys?: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant={active ? "secondary" : "ghost"} size="icon-xs" onClick={onClick} disabled={disabled} aria-label={label} />}>{children}</TooltipTrigger>
      <TooltipContent>
        {label}
        {keys && <span className="ml-2 text-muted-foreground">{keys}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

/** What the core is doing, in a few words. */
function statusText(view: BoardView, running: boolean, where: string | null): { text: string; tone: "run" | "stop" | "fault" | "idle" } {
  if (view.status === "no-image") return { text: "No program", tone: "idle" }
  if (view.status === "stepping") return { text: "Stepping…", tone: "run" }
  if (running) return { text: "Running", tone: "run" }
  const at = where ? ` at ${where}` : ""
  const s = view.stop
  if (!s) return { text: `Paused${at}`, tone: "idle" }
  switch (s.reason) {
    case "breakpoint":
      return { text: `Breakpoint${at}`, tone: "stop" }
    case "step":
      return { text: `Stepped${at}`, tone: "stop" }
    case "bkpt":
      return { text: `BKPT instruction${at}`, tone: "stop" }
    case "exception":
      return { text: `${s.exception ? excName(s.exception) : "Fault"}${s.detail ? `: ${s.detail}` : ""}${at}`, tone: "fault" }
    case "reset":
      return { text: `Reset during the step${at}`, tone: "stop" }
    default:
      return { text: `Paused${at}`, tone: "idle" }
  }
}

/**
 * The debugger's buttons, as an IDE lays them out: continue/pause, step over, into, out, one
 * instruction, restart the core; the status of the stop beside them. Stepping runs the whole
 * bench for as long as the step takes.
 */
export function DebugToolbar({ view, running, where, instructions, disassembly, onContinue, onPause, onStepOver, onStepInto, onStepOut, onStepInstruction, onRestart, onDisassembly }: Props) {
  const idle = view.status === "no-image"
  const busy = running || view.status === "stepping"
  const status = statusText(view, running, where)
  const unit = instructions ? "instruction" : "line"
  return (
    <div data-slot="debug-toolbar" className="flex h-7 shrink-0 items-center gap-0.5 border-b bg-sidebar px-1 text-xs">
      {running ? (
        <Tool label="Pause the bench" keys="F5" onClick={onPause} disabled={idle}>
          <PauseIcon />
        </Tool>
      ) : (
        <Tool label="Continue: run the bench" keys="F5" onClick={onContinue} disabled={idle}>
          <PlayIcon className="text-emerald-600" />
        </Tool>
      )}
      <Tool label={`Step over (one ${unit}, calls run through)`} keys="F10" onClick={onStepOver} disabled={idle || busy}>
        <RedoDotIcon />
      </Tool>
      <Tool label={`Step into (one ${unit}, into calls)`} keys="F11" onClick={onStepInto} disabled={idle || busy}>
        <ArrowDownToLineIcon />
      </Tool>
      <Tool label="Step out (run to the caller)" keys="⇧F11" onClick={onStepOut} disabled={idle || busy}>
        <ArrowUpFromLineIcon />
      </Tool>
      <Tool label="Step one instruction" keys="⌥F11" onClick={onStepInstruction} disabled={idle || busy}>
        <CornerDownRightIcon />
      </Tool>
      <Tool label="Restart the core (the bench keeps its time)" keys="⇧⌘F5" onClick={onRestart} disabled={idle}>
        <RotateCcwIcon />
      </Tool>
      <div className="mx-1 h-4 w-px bg-border" />
      <Tool label={disassembly ? "Back to the source" : "Disassembly"} keys="⌘⇧D" onClick={onDisassembly} disabled={idle} active={disassembly}>
        <BinaryIcon />
      </Tool>
      <span
        className={cn(
          "ml-2 min-w-0 truncate font-mono text-[11px]",
          status.tone === "run" && "text-emerald-700 dark:text-emerald-400",
          status.tone === "stop" && "text-amber-700 dark:text-amber-400",
          status.tone === "fault" && "text-destructive",
          status.tone === "idle" && "text-muted-foreground",
        )}
        title={status.text}
      >
        {status.text}
      </span>
    </div>
  )
}
