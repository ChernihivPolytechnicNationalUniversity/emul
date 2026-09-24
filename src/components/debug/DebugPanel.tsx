import * as React from "react"
import { CircleIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BreakpointSpec } from "@/debug/protocol"
import type { BoardView, DebugController } from "@/debug/session"
import type { DebugInfo } from "@/debug/info"
import { variableValue } from "@/debug/values"
import { breakpointLabel, breakpointPlace } from "@/debug/breakpoints"
import { excName } from "@/mcu/faults"
import { cn } from "@/lib/utils"
import { ValueTree, type TreeRoot } from "./ValueTree"
import { MemoryView } from "./MemoryView"
import { PeripheralsView } from "./PeripheralsView"

export type PanelTab = "output" | "variables" | "watch" | "stack" | "breakpoints" | "registers" | "peripherals" | "memory"

const TABS: { id: PanelTab; label: string }[] = [
  { id: "output", label: "Output" },
  { id: "variables", label: "Variables" },
  { id: "watch", label: "Watch" },
  { id: "stack", label: "Stack" },
  { id: "breakpoints", label: "Breakpoints" },
  { id: "registers", label: "Registers" },
  { id: "peripherals", label: "Peripherals" },
  { id: "memory", label: "Memory" },
]

type Props = {
  debug: DebugController
  boardId: string
  chip: string
  view: BoardView
  info: DebugInfo | null
  tab: PanelTab
  onTab: (tab: PanelTab) => void
  /** The build's log, when there is one. */
  output: React.ReactNode | null
  watches: string[]
  onWatches: (list: string[]) => void
  breakpoints: BreakpointSpec[]
  onBreakpoints: (list: BreakpointSpec[]) => void
  catchFaults: boolean
  onCatchFaults: (on: boolean) => void
  /** Show a breakpoint's place in the editor. */
  onReveal: (b: BreakpointSpec) => void
  memoryAt: { addr: number; seq: number } | null
  onMemory: (addr: number) => void
  height: number
  onHeight: (h: number) => void
  onClose: () => void
}

/**
 * The debugger's views under the editor, one tab each as in an IDE's bottom panel: the build
 * output, variables, watches, the call stack, breakpoints, registers, the peripherals'
 * registers and memory. Everything reads the stop the core is at; while it runs they show
 * what they had.
 */
export function DebugPanel(p: Props) {
  const { debug, boardId, view, info, tab, onTab } = p
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = p.height
    const move = (ev: PointerEvent) => p.onHeight(Math.min(window.innerHeight * 0.7, Math.max(96, startH + (startY - ev.clientY))))
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }
  return (
    <div data-slot="debug-panel" className="relative flex shrink-0 flex-col border-t" style={{ height: p.height }}>
      <div className="absolute inset-x-0 top-0 z-10 h-1 cursor-row-resize hover:bg-primary/40" onPointerDown={onResizeStart} aria-label="Resize panel" />
      <div className="flex h-7 shrink-0 items-center bg-sidebar pr-1 text-xs">
        <div className="flex min-w-0 flex-1 items-stretch self-stretch overflow-x-auto [scrollbar-width:none]" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={cn("shrink-0 border-b-2 px-1.5 text-[0.6875rem] font-medium text-muted-foreground uppercase hover:text-foreground", tab === t.id ? "border-primary text-foreground" : "border-transparent")}
              onClick={() => onTab(t.id)}
            >
              {t.label}
              {t.id === "breakpoints" && p.breakpoints.length > 0 && <span className="ml-1 rounded-sm bg-muted px-1 font-mono text-[10px] normal-case">{p.breakpoints.length}</span>}
            </button>
          ))}
        </div>
        {(tab === "variables" || tab === "watch") && (
          <Button variant="ghost" size="xs" className="font-mono" onClick={() => debug.setRadix(debug.radix === "hex" ? "dec" : "hex")} title="Show integers in hex or decimal">
            {debug.radix === "hex" ? "0x" : "10"}
          </Button>
        )}
        <Button variant="ghost" size="icon-xs" onClick={p.onClose} aria-label="Close panel">
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "output" && (p.output ?? <Empty>No build yet: Compile puts its log here.</Empty>)}
        {tab === "variables" && <VariablesView debug={debug} boardId={boardId} view={view} info={info} onWatch={(e) => p.onWatches([...p.watches, e])} />}
        {tab === "watch" && <WatchView debug={debug} boardId={boardId} view={view} watches={p.watches} onWatches={p.onWatches} />}
        {tab === "stack" && <CallStackView debug={debug} boardId={boardId} view={view} />}
        {tab === "breakpoints" && <BreakpointsView info={info} breakpoints={p.breakpoints} onBreakpoints={p.onBreakpoints} catchFaults={p.catchFaults} onCatchFaults={p.onCatchFaults} onReveal={p.onReveal} hit={view.stop?.reason === "breakpoint" ? view.stop.breakpoint : undefined} />}
        {tab === "registers" && <RegistersView view={view} />}
        {tab === "peripherals" && <PeripheralsView debug={debug} boardId={boardId} chip={p.chip} view={view} />}
        {tab === "memory" && <MemoryView debug={debug} boardId={boardId} view={view} at={p.memoryAt} />}
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-2 text-xs text-muted-foreground">{children}</div>
}

/** Whether the views have a stop to show; the text when they do not. */
function notStopped(view: BoardView): string | null {
  if (view.status === "no-image") return "No program on this board."
  if (view.status === "running" || view.status === "stepping") return "Running: pause the bench, or stop at a breakpoint, to see this."
  if (!view.regs) return view.error ?? "Reading the core…"
  return null
}

function useExpanded() {
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  const toggle = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return [expanded, toggle] as const
}

// --- variables -------------------------------------------------------------------------------------

function VariablesView({ debug, boardId, view, info, onWatch }: { debug: DebugController; boardId: string; view: BoardView; info: DebugInfo | null; onWatch: (expr: string) => void }) {
  const [expanded, toggle] = useExpanded()
  const [open, setOpen] = React.useState<Record<string, boolean>>({ locals: true, unit: true, all: false })
  const why = notStopped(view)
  if (why) return <Empty>{why}</Empty>
  if (!info?.hasDwarf) return <Empty>The image has no debug information: see Registers, Memory and the disassembly.</Empty>
  const env = debug.env(boardId)
  const before = env && view.prevMem ? { ...env, mem: view.prevMem } : null
  const frame = view.frames[view.frame]
  const locals = debug.locals(boardId)
  const unit = frame?.fn?.die.unit
  const roots = (list: typeof locals, prefix: string): TreeRoot[] =>
    list.map((v) => ({ key: `${prefix}:${v.name}:${v.die.offset}`, name: v.name, value: env ? variableValue(env, v) : null }))
  const sections: { id: string; label: string; roots: TreeRoot[] }[] = [
    { id: "locals", label: frame ? `Locals · ${frame.name}` : "Locals", roots: roots(locals, "L") },
    { id: "unit", label: `Globals · ${unit?.name.split("/").pop() ?? "this file"}`, roots: roots(info.globals.filter((g) => g.die.unit === unit), "G") },
    { id: "all", label: "All globals", roots: roots([...info.globals].sort((a, b) => a.name.localeCompare(b.name)), "A") },
  ]
  return (
    <div className="py-0.5">
      {sections.map((s) => (
        <div key={s.id}>
          <button type="button" className="flex h-5 w-full items-center gap-1 px-1 text-left text-[11px] font-medium text-muted-foreground hover:bg-accent/60" onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}>
            <span className={cn("inline-block w-3 text-center transition-transform", open[s.id] && "rotate-90")}>›</span>
            {s.label}
            <span className="ml-1 font-mono text-[10px]">{s.roots.length}</span>
          </button>
          {open[s.id] &&
            (s.roots.length ? (
              <ValueTree env={env} before={before} roots={s.roots} radix={debug.radix} expanded={expanded} onToggle={toggle} onPick={(_, path) => onWatch(path)} className="pl-3" />
            ) : (
              <div className="pl-7 text-[11px] text-muted-foreground">none</div>
            ))}
        </div>
      ))}
    </div>
  )
}

// --- watch -------------------------------------------------------------------------------------------

function WatchView({ debug, boardId, view, watches, onWatches }: { debug: DebugController; boardId: string; view: BoardView; watches: string[]; onWatches: (list: string[]) => void }) {
  const [expanded, toggle] = useExpanded()
  const [text, setText] = React.useState("")
  const stopped = !notStopped(view)
  const env = stopped ? debug.env(boardId) : null
  const before = env && view.prevMem ? { ...env, mem: view.prevMem } : null
  const roots: TreeRoot[] = watches.map((expr, i) => {
    const r = stopped ? debug.evaluate(boardId, expr) : null
    return {
      key: `W${i}:${expr}`,
      name: expr,
      value: r?.value ?? null,
      shown: r && !r.value ? r.shown : r ? undefined : { text: "—", expandable: false },
      actions: (
        <Button variant="ghost" size="icon-xs" aria-label="Remove watch" onClick={() => onWatches(watches.filter((_, k) => k !== i))}>
          <XIcon />
        </Button>
      ),
    }
  })
  const add = () => {
    const e = text.trim()
    if (e && !watches.includes(e)) onWatches([...watches, e])
    setText("")
  }
  return (
    <div className="flex flex-col py-0.5">
      <ValueTree env={env} before={before} roots={roots} radix={debug.radix} expanded={expanded} onToggle={toggle} />
      <form
        className="flex items-center gap-1 px-1 pt-0.5"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <PlusIcon className="size-3 shrink-0 text-muted-foreground" />
        <input
          className="h-5 min-w-0 flex-1 rounded-sm bg-transparent px-1 font-mono text-[11px] outline-none placeholder:text-muted-foreground focus:bg-muted"
          placeholder="Add an expression: counter, buf[3], GPIOA->ODR, *p, (uint8_t)x…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </form>
      {!stopped && watches.length > 0 && <div className="px-6 text-[11px] text-muted-foreground">{notStopped(view)}</div>}
    </div>
  )
}

// --- call stack --------------------------------------------------------------------------------------

function CallStackView({ debug, boardId, view }: { debug: DebugController; boardId: string; view: BoardView }) {
  const why = notStopped(view)
  if (why) return <Empty>{why}</Empty>
  if (!view.frames.length) return <Empty>No call frame information: the stack cannot be walked. The PC is 0x{view.regs!.r[15].toString(16)}.</Empty>
  return (
    <div className="py-0.5 font-mono text-[11px]">
      {view.frames.map((f, i) => (
        <React.Fragment key={i}>
          {f.interruptedBy && (
            <div className="flex h-5 items-center gap-2 px-2 text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {f.interruptedBy} exception
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          <button
            type="button"
            className={cn("flex h-5 w-full min-w-0 items-center gap-2 px-2 text-left hover:bg-accent/60", view.frame === i && "bg-accent")}
            onClick={() => debug.selectFrame(boardId, i)}
          >
            <span className={cn("w-3 shrink-0 text-center", i === 0 ? "text-amber-600" : "text-muted-foreground")}>{i === 0 ? "▶" : view.frame === i ? "›" : ""}</span>
            <span className="min-w-0 truncate">{f.name}</span>
            {f.inlined && <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">inlined</span>}
            <span className="ml-auto shrink-0 text-muted-foreground">{f.file ? `${f.file.split("/").pop()}:${f.line}` : `0x${f.pc.toString(16).padStart(8, "0")}`}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

// --- breakpoints --------------------------------------------------------------------------------------

function BreakpointsView({ info, breakpoints, onBreakpoints, catchFaults, onCatchFaults, onReveal, hit }: { info: DebugInfo | null; breakpoints: BreakpointSpec[]; onBreakpoints: (l: BreakpointSpec[]) => void; catchFaults: boolean; onCatchFaults: (on: boolean) => void; onReveal: (b: BreakpointSpec) => void; hit?: string }) {
  const [name, setName] = React.useState("")
  const addFunction = () => {
    const n = name.trim()
    if (!n) return
    const address = /^0x[0-9a-f]+$/i.test(n) ? parseInt(n, 16) : null
    const b: BreakpointSpec = address !== null ? { id: crypto.randomUUID(), kind: "address", address, enabled: true } : { id: crypto.randomUUID(), kind: "function", name: n.replace(/\(\)$/, ""), enabled: true }
    onBreakpoints([...breakpoints, b])
    setName("")
  }
  return (
    <div className="flex flex-col py-0.5 text-[11px]">
      <label className="flex h-5 items-center gap-2 px-2 hover:bg-accent/60">
        <input type="checkbox" checked={catchFaults} onChange={(e) => onCatchFaults(e.target.checked)} />
        <span>Stop on faults (HardFault, MemManage, BusFault, UsageFault)</span>
      </label>
      {breakpoints.map((b) => {
        const place = breakpointPlace(info, b)
        return (
          <div key={b.id} className={cn("group flex h-5 min-w-0 items-center gap-2 px-2 hover:bg-accent/60", hit === b.id && "bg-amber-200/50 dark:bg-amber-500/20")}>
            <input type="checkbox" checked={b.enabled} onChange={(e) => onBreakpoints(breakpoints.map((x) => (x.id === b.id ? { ...x, enabled: e.target.checked } : x)))} aria-label="Enabled" />
            <CircleIcon className={cn("size-2.5 shrink-0", !b.enabled ? "fill-muted-foreground text-muted-foreground" : place.ok ? "fill-red-600 text-red-600" : "text-muted-foreground")} />
            <button type="button" className="min-w-0 truncate text-left font-mono hover:underline" onClick={() => onReveal(b)} title={b.kind === "line" ? b.path : undefined}>
              {breakpointLabel(b)}
            </button>
            {b.kind === "line" && place.line !== undefined && place.line !== b.line && <span className="shrink-0 text-muted-foreground">→ line {place.line}</span>}
            {!place.ok && info && <span className="shrink-0 text-muted-foreground">not in the program</span>}
            <Button variant="ghost" size="icon-xs" className="ml-auto opacity-0 group-hover:opacity-100" aria-label="Remove breakpoint" onClick={() => onBreakpoints(breakpoints.filter((x) => x.id !== b.id))}>
              <XIcon />
            </Button>
          </div>
        )
      })}
      <form
        className="flex items-center gap-1 px-1 pt-0.5"
        onSubmit={(e) => {
          e.preventDefault()
          addFunction()
        }}
      >
        <PlusIcon className="size-3 shrink-0 text-muted-foreground" />
        <input
          className="h-5 min-w-0 flex-1 rounded-sm bg-transparent px-1 font-mono text-[11px] outline-none placeholder:text-muted-foreground focus:bg-muted"
          placeholder="Break on a function (HAL_GPIO_EXTI_Callback) or an address (0x08000400)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {breakpoints.length > 0 && (
          <Button variant="ghost" size="xs" onClick={() => onBreakpoints([])} title="Remove every breakpoint">
            <Trash2Icon />
            Remove all
          </Button>
        )}
      </form>
    </div>
  )
}

// --- registers ------------------------------------------------------------------------------------------

const hex8 = (v: number) => `0x${(v >>> 0).toString(16).padStart(8, "0")}`
const CORE = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "sp", "lr", "pc"]

function xpsrText(v: number) {
  const f = (bit: number, c: string) => (v & (1 << bit) ? c : c.toLowerCase())
  const ipsr = v & 0x1ff
  return `${f(31, "N")}${f(30, "Z")}${f(29, "C")}${f(28, "V")}${f(27, "Q")} GE=${((v >>> 16) & 0xf).toString(2).padStart(4, "0")} ${ipsr ? excName(ipsr) : "Thread"}`
}

function RegistersView({ view }: { view: BoardView }) {
  const why = notStopped(view)
  if (why) return <Empty>{why}</Empty>
  const regs = view.regs!
  const prev = view.prevRegs
  const frame = view.frames[view.frame]
  // A caller's frame knows the registers the calls kept (r4–r11, SP, PC); the rest are the callee's business.
  const r = view.frame > 0 && frame ? frame.regs.r : regs.r
  const cell = (name: string, value: number | null, before: number | null | undefined, extra?: string) => (
    <div key={name} className="flex h-5 items-center gap-2 px-2" title={extra}>
      <span className="w-14 shrink-0 text-violet-700 dark:text-violet-300">{name}</span>
      <span className={cn("tabular-nums", value !== null && before !== undefined && before !== null && before !== value && "rounded-sm bg-amber-200/60 px-0.5 dark:bg-amber-500/30", value === null && "text-muted-foreground")}>{value === null ? "—" : hex8(value)}</span>
      {extra && <span className="min-w-0 truncate text-muted-foreground">{extra}</span>}
    </div>
  )
  const u = (x: number) => new DataView(new Uint32Array([x]).buffer).getFloat32(0, true)
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] py-0.5 font-mono text-[11px]">
      {CORE.map((n, i) => cell(n, r[i] ?? null, view.frame === 0 ? prev?.r[i] : undefined, i >= 13 ? undefined : r[i] !== null && r[i] !== undefined ? String(r[i]! | 0) : undefined))}
      {cell("xPSR", regs.xpsr, prev?.xpsr, xpsrText(regs.xpsr))}
      {cell("MSP", regs.msp, prev?.msp)}
      {cell("PSP", regs.psp, prev?.psp)}
      {cell("PRIMASK", regs.primask, prev?.primask)}
      {cell("BASEPRI", regs.basepri, prev?.basepri)}
      {cell("FAULTMASK", regs.faultmask, prev?.faultmask)}
      {cell("CONTROL", regs.control, prev?.control, `${regs.control & 1 ? "unprivileged" : "privileged"}, ${regs.control & 2 ? "PSP" : "MSP"}${regs.control & 4 ? ", FP active" : ""}`)}
      {cell("cycles", regs.cycles, undefined, `${regs.instructions.toLocaleString()} instructions${regs.sleeping ? ", asleep" : ""}`)}
      {regs.s && (
        <>
          {cell("FPSCR", regs.fpscr, prev?.fpscr)}
          {regs.s.map((bits, i) => cell(`s${i}`, bits, prev?.s?.[i], String(u(bits))))}
        </>
      )}
    </div>
  )
}

