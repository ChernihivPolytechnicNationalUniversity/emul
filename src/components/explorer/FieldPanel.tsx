import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronDownIcon, ChevronUpIcon, CircleXIcon, InfoIcon, PanelRightCloseIcon, PanelRightIcon, SearchIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { KEYMAP, labelFor } from "@/lib/keymap"
import { useSampled } from "@/hooks/use-sampled"
import { getDef, getMeta } from "@/schematic/registry"
import { partKey, type PlacedObject } from "@/schematic/types"
import type { SimReadout } from "@/sim/use-simulation"
import { Button } from "@/components/ui/button"
import { fieldEntries, GROUP_LABEL, type FieldEntry, type FieldGroup, type FieldHit } from "./field-index"
import { countBySeverity, type Problem, type Severity } from "./problems"
import { clampFieldWidth, clampShare, FIELD_FOLD_BELOW, FIELD_WIDTH, INSPECTOR_SHARE, saveFieldWidth, savedFieldWidth, savedShare, saveShare } from "./panel-size"

/** Someone else in the live session and what they have selected. */
export type PeerSelection = { clientId: number; name: string; color: string; ids: readonly string[] }

/** Where a row points: an object, or one of its pins. */
export type FieldTarget = { object: string; pin?: string }

type FieldPanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  objects: readonly PlacedObject[]
  problems: readonly Problem[]
  /** The problem F8 last went to: its row is marked and opened. */
  activeProblem: string | null
  onProblem: (key: string) => void
  selected: ReadonlySet<string>
  sim: SimReadout
  peers: readonly PeerSelection[]
  query: string
  onQueryChange: (query: string) => void
  hits: readonly FieldHit[]
  /** The hit the keys are on, -1 for none. */
  hitIndex: number
  onStep: (delta: 1 | -1) => void
  onHit: (index: number) => void
  /** A row clicked: select what it points at and bring it into sight. */
  onPick: (target: FieldTarget, add: boolean) => void
  /** The pointer on a row: the field marks the object, the camera stays. */
  onHover: (object: string | null) => void
  /** Escape in the search box with nothing typed: the keyboard goes back to the field. */
  onLeave: () => void
  searchRef: React.RefObject<HTMLInputElement | null>
  /** The inspector, docked under the list while the panel is open. */
  inspector?: React.ReactNode
  /** In a phone's bottom sheet: full width, no fold (the sheet folds), no inspector (it floats over the field). */
  sheet?: boolean
  className?: string
}


const SEVERITY_ICON: Record<Severity, React.ComponentType<{ className?: string }>> = { error: CircleXIcon, warning: TriangleAlertIcon, info: InfoIcon }
const SEVERITY_TEXT: Record<Severity, string> = { error: "text-red-600 dark:text-red-400", warning: "text-amber-600 dark:text-amber-400", info: "text-sky-600 dark:text-sky-400" }
const SEVERITY_WORD: Record<Severity, string> = { error: "Error", warning: "Warning", info: "Note" }

type Badge = { text: string; tone: "ok" | "bad" | "warn" | "mute" }

const TONE: Record<Badge["tone"], string> = {
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300",
  bad: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
  mute: "bg-muted text-muted-foreground",
}

/** What a row says about its object right now: burnt, an MCU's state, an LED lit. */
function badgeOf(o: PlacedObject, sim: SimReadout): Badge | null {
  const damage = sim.damage[o.id]
  if (damage) return { text: damage.fatal ? "burnt" : "damaged", tone: "bad" }
  const def = getDef(o.def)
  if (!def) return null
  if (def.chip) {
    if (!o.props?.firmware) return { text: "no code", tone: "mute" }
    const status = sim.live ? sim.mcu(o.id) : undefined
    if (!status) return null
    if (!status.powered) return { text: "no power", tone: "warn" }
    if (status.halted) return { text: "halted", tone: "bad" }
    return { text: status.running ? "running" : "stopped", tone: status.running ? "ok" : "mute" }
  }
  if (!sim.live) return null
  const leds = def.parts.filter((p) => p.type === "led")
  if (leds.length) return leds.some((p) => (sim.parts[partKey(o.id, p.id)]?.level ?? 0) > 0.05) ? { text: "lit", tone: "ok" } : { text: "off", tone: "mute" }
  return null
}

function Pill({ badge }: { badge: Badge }) {
  return <span className={cn("shrink-0 rounded px-1 text-[10px] leading-4 font-medium", TONE[badge.tone])}>{badge.text}</span>
}

function Avatars({ peers }: { peers: readonly PeerSelection[] }) {
  if (!peers.length) return null
  return (
    <span className="flex shrink-0 -space-x-1">
      {peers.slice(0, 3).map((p) => (
        <span key={p.clientId} title={`${p.name} has it selected`} className="flex size-3.5 items-center justify-center rounded-full text-[8px] font-bold text-white ring-1 ring-background" style={{ background: p.color }}>
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </span>
  )
}

const KBD = "inline-flex h-4 min-w-4 items-center justify-center rounded border border-b-2 bg-background px-1 font-mono text-[10px] leading-none text-muted-foreground"

type Item =
  | { kind: "head"; key: string; label: string; count: number }
  | { kind: "problem"; key: string; problem: Problem }
  | { kind: "object"; key: string; entry: FieldEntry }
  | { kind: "hit"; key: string; hit: FieldHit; index: number }

/** The list the panel shows: problems, then objects by group; or, while searching, the hits. */
function itemsOf(entries: readonly FieldEntry[], problems: readonly Problem[], hits: readonly FieldHit[], searching: boolean): Item[] {
  if (searching) return hits.map((hit, index) => ({ kind: "hit", key: hit.kind === "pin" ? `${hit.object}:${hit.pin}` : hit.object, hit, index }))
  const items: Item[] = []
  if (problems.length) {
    items.push({ kind: "head", key: "h:problems", label: "Problems", count: problems.length })
    for (const p of problems) items.push({ kind: "problem", key: `p:${p.key}`, problem: p })
  }
  let group: FieldGroup | null = null
  for (const e of entries) {
    if (e.group !== group) {
      group = e.group
      items.push({ kind: "head", key: `h:${group}`, label: GROUP_LABEL[group], count: entries.filter((x) => x.group === group).length })
    }
    items.push({ kind: "object", key: e.id, entry: e })
  }
  return items
}

/**
 * The field explorer: a panel on the right, folded to a column with the problem count until it is
 * opened. Problems first, worst first; then every object, boards and chips before parts, with what
 * each is doing now. Its search finds parts and pins; the inspector docks under the list.
 */
export function FieldPanel(props: FieldPanelProps) {
  const { open } = props
  if (props.sheet) return <OpenPanel {...props} />
  // Folded, the panel is gone: the field shows one floating button for it (FieldToggle).
  if (!open) return null
  return <OpenPanel {...props} />
}

function OpenPanel({ onOpenChange, objects, problems, activeProblem, onProblem, selected, sim: liveSim, peers, query, onQueryChange, hits, hitIndex, onStep, onHit, onPick, onHover, onLeave, searchRef, inspector, sheet, className }: FieldPanelProps) {
  const sim = useSampled(liveSim, 250)
  const entries = React.useMemo(() => fieldEntries(objects), [objects])
  const byId = React.useMemo(() => new Map(objects.map((o) => [o.id, o])), [objects])
  const searching = query.trim() !== ""
  const items = React.useMemo(() => itemsOf(entries, problems, hits, searching), [entries, problems, hits, searching])
  const peersOf = React.useMemo(() => {
    const m = new Map<string, PeerSelection[]>()
    for (const p of peers) for (const id of p.ids) m.set(id, [...(m.get(id) ?? []), p])
    return m
  }, [peers])
  const counts = countBySeverity(problems)

  const scroller = React.useRef<HTMLDivElement>(null)
  const panel = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(savedFieldWidth)
  /** While the edge is dragged: the width shown, the fold point marked by the panel narrowing to nothing. */
  const [liveWidth, setLiveWidth] = React.useState<number | null>(null)
  const [share, setShare] = React.useState(savedShare)
  const [liveShare, setLiveShare] = React.useState<number | null>(null)
  const settleWidth = (px: number) => {
    if (px < FIELD_FOLD_BELOW) return onOpenChange(false)
    const next = clampFieldWidth(px)
    setWidth(next)
    saveFieldWidth(next)
  }
  const settleShare = (next: number) => {
    const s = clampShare(next)
    setShare(s)
    saveShare(s)
  }
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({ count: items.length, getScrollElement: () => scroller.current, estimateSize: (i) => (items[i]?.kind === "head" ? 26 : 28), overscan: 12, getItemKey: (i) => items[i]!.key })

  // The keyboard's hit, the problem F8 went to, an object selected on the field: its row comes into sight.
  const focusKey = searching ? items.find((it) => it.kind === "hit" && it.index === hitIndex)?.key : activeProblem ? `p:${activeProblem}` : selected.size === 1 ? [...selected][0] : undefined
  React.useEffect(() => {
    if (!focusKey) return
    const i = items.findIndex((it) => it.key === focusKey)
    if (i >= 0) virtualizer.scrollToIndex(i, { align: "auto" })
  }, [focusKey, items, virtualizer])

  const activeId = searching && hitIndex >= 0 ? `field-row-${items.findIndex((it) => it.kind === "hit" && it.index === hitIndex)}` : undefined

  return (
    <div ref={panel} data-slot="field-panel" className={cn("relative flex h-full shrink-0 flex-col bg-sidebar text-sidebar-foreground", !sheet && "border-l", className)} style={{ width: sheet ? "100%" : (liveWidth ?? width) }}>
      {!sheet && (
        <Splitter
          orientation="vertical"
          label="Field explorer width: drag, or use the arrow keys; drag far right to fold it"
          value={liveWidth ?? width}
          className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2"
          onDrag={(dx, start) => {
            const px = start - dx
            setLiveWidth(px < FIELD_FOLD_BELOW ? FIELD_WIDTH.min / 2 : clampFieldWidth(px))
          }}
          onDrop={(dx, start) => (setLiveWidth(null), settleWidth(start - dx))}
          onCancel={() => setLiveWidth(null)}
          onStep={(d) => settleWidth(width + d * 16)}
          onReset={() => settleWidth(FIELD_WIDTH.initial)}
          start={() => width}
        />
      )}
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <span className="text-[11px] font-semibold tracking-[.02em] text-muted-foreground uppercase">Field</span>
        <span className="flex items-center gap-1.5 text-[11px] font-medium tabular-nums">
          {(["error", "warning", "info"] as const).map((s) => {
            const Icon = SEVERITY_ICON[s]
            return counts[s] ? (
              <span key={s} className={cn("flex items-center gap-0.5", SEVERITY_TEXT[s])} title={`${counts[s]} ${SEVERITY_WORD[s].toLowerCase()}${counts[s] > 1 ? "s" : ""}`}>
                <Icon className="size-3.5" />
                {counts[s]}
              </span>
            ) : null
          })}
        </span>
        {!sheet && (
          <button type="button" onClick={() => onOpenChange(false)} aria-label="Fold the field explorer" title="Fold" className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground [&>svg]:size-4">
            <PanelRightCloseIcon />
          </button>
        )}
      </div>
      <div className="shrink-0 px-2 pb-1.5">
        <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={searchRef}
          data-slot="field-search"
          role="combobox"
          aria-expanded={searching}
          aria-controls="field-list"
          aria-activedescendant={activeId}
          aria-label="Find a part or a pin on the field"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              onStep(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1)
            } else if (e.key === "Escape") {
              e.preventDefault()
              if (query) onQueryChange("")
              else onLeave()
            }
          }}
          placeholder="Find a part, value or pin…"
          autoComplete="off"
          spellCheck={false}
          className="h-8 w-full rounded-lg border bg-background pr-[4.5rem] pl-8 text-[13px] outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        />
        <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5">
          {searching ? (
            <>
              <span role="status" className="mr-1 text-[11px] text-muted-foreground tabular-nums">
                {hits.length ? `${hitIndex < 0 ? "–" : hitIndex + 1} / ${hits.length}` : "0"}
              </span>
              <button type="button" aria-label="Previous match" disabled={!hits.length} onClick={() => onStep(-1)} className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent disabled:opacity-40">
                <ChevronUpIcon className="size-3.5" />
              </button>
              <button type="button" aria-label="Next match" disabled={!hits.length} onClick={() => onStep(1)} className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent disabled:opacity-40">
                <ChevronDownIcon className="size-3.5" />
              </button>
              <button type="button" aria-label="Clear the search" onClick={() => onQueryChange("")} className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent">
                <XIcon className="size-3.5" />
              </button>
            </>
          ) : (
            <kbd className={cn(KBD, "pointer-coarse:hidden")}>{labelFor(KEYMAP.find)}</kbd>
          )}
        </span>
        </div>
        {searching && <p className="mt-1 px-1 text-[10.5px] text-muted-foreground pointer-coarse:hidden">↵ next · ⇧↵ back · {labelFor(KEYMAP.find)} again: the browser’s own find</p>}
      </div>
      <div ref={scroller} id="field-list" role="listbox" aria-label={searching ? "Matches on the field" : "On the field"} className="min-h-0 flex-1 overflow-y-auto pb-2" onPointerLeave={() => onHover(null)}>
        {items.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">{searching ? `Nothing on the field matches “${query.trim()}”.` : "The field is empty. Add parts from the palette, or press A."}</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const item = items[v.index]!
              return (
                <div key={v.key} id={`field-row-${v.index}`} data-index={v.index} ref={virtualizer.measureElement} className="absolute inset-x-0 top-0 px-1.5" style={{ transform: `translateY(${v.start}px)` }}>
                  {item.kind === "head" ? (
                    <div className="flex h-[26px] items-end gap-1.5 px-2 pb-1 text-[11px] font-semibold tracking-[.02em] text-muted-foreground uppercase">
                      {item.label}
                      <span className="font-medium text-muted-foreground/60 tabular-nums">{item.count}</span>
                    </div>
                  ) : item.kind === "problem" ? (
                    <ProblemRow problem={item.problem} active={item.problem.key === activeProblem} byId={byId} onClick={() => onProblem(item.problem.key)} onHover={onHover} />
                  ) : item.kind === "object" ? (
                    <ObjectRow entry={item.entry} object={byId.get(item.entry.id)} sim={sim} selected={selected.has(item.entry.id)} peers={peersOf.get(item.entry.id) ?? []} onPick={onPick} onHover={onHover} />
                  ) : (
                    <HitRow hit={item.hit} object={byId.get(item.hit.object)} entry={entries.find((e) => e.id === item.hit.object)} query={query} current={item.index === hitIndex} onClick={() => onHit(item.index)} onHover={onHover} />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {inspector && (
        <>
          <Splitter
            orientation="horizontal"
            label="Inspector height: drag, or use the arrow keys"
            value={Math.round((liveShare ?? share) * 100)}
            className="relative z-10 -my-1 h-2 shrink-0 cursor-row-resize after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2"
            onDrag={(dy, start) => setLiveShare(clampShare(start - dy / (panel.current?.clientHeight || 1)))}
            onDrop={(dy, start) => (setLiveShare(null), settleShare(start - dy / (panel.current?.clientHeight || 1)))}
            onCancel={() => setLiveShare(null)}
            onStep={(d) => settleShare(share + d * 0.05)}
            onReset={() => settleShare(INSPECTOR_SHARE.initial)}
            start={() => share}
          />
          <div className="min-h-0 shrink-0 overflow-y-auto border-t bg-background" style={{ height: `${(liveShare ?? share) * 100}%` }}>
            {inspector}
          </div>
        </>
      )}
    </div>
  )
}

const ROW = "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"

function ObjectRow({ entry, object, sim, selected, peers, onPick, onHover }: { entry: FieldEntry; object: PlacedObject | undefined; sim: SimReadout; selected: boolean; peers: readonly PeerSelection[]; onPick: FieldPanelProps["onPick"]; onHover: FieldPanelProps["onHover"] }) {
  const Icon = getMeta(entry.defId)?.icon
  const badge = object ? badgeOf(object, sim) : null
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={(e) => onPick({ object: entry.id }, e.shiftKey || e.metaKey || e.ctrlKey)}
      onPointerEnter={() => onHover(entry.id)}
      className={cn(ROW, selected && "bg-sidebar-accent font-medium")}
    >
      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
      <span className="shrink-0 tabular-nums">{entry.ref || entry.name}</span>
      <span className="min-w-0 truncate text-muted-foreground">{entry.ref ? (entry.value ?? entry.name) : entry.value}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {badge && <Pill badge={badge} />}
        <Avatars peers={peers} />
      </span>
    </button>
  )
}

function ProblemRow({ problem, active, byId, onClick, onHover }: { problem: Problem; active: boolean; byId: Map<string, PlacedObject>; onClick: () => void; onHover: FieldPanelProps["onHover"] }) {
  const Icon = SEVERITY_ICON[problem.severity]
  const exists = !problem.object || byId.has(problem.object)
  if (!exists) return null
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      onPointerEnter={() => onHover(problem.object ?? null)}
      title={[problem.detail, problem.fix].filter(Boolean).join("\n")}
      className={cn("flex w-full flex-col rounded-md px-2 py-1 text-left text-[13px] outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring", active && "bg-sidebar-accent")}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <Icon className={cn("size-4 shrink-0", SEVERITY_TEXT[problem.severity])} aria-label={SEVERITY_WORD[problem.severity]} />
        <span className="min-w-0 truncate">{problem.title}</span>
      </span>
      {active && (
        <span className="mt-0.5 block pl-6 text-xs leading-snug">
          <span className="block text-muted-foreground">{problem.detail}</span>
          {problem.fix && <span className="mt-0.5 block font-medium text-emerald-700 dark:text-emerald-400">→ {problem.fix}</span>}
          <span className="mt-1 flex items-center gap-1 text-[10.5px] text-muted-foreground">
            <kbd className={KBD}>{labelFor(KEYMAP.nextProblem)}</kbd> next <kbd className={KBD}>{labelFor(KEYMAP.previousProblem)}</kbd> back
          </span>
        </span>
      )}
    </button>
  )
}

/** The query's words picked out in a label. */
function Marked({ text, query }: { text: string; query: string }) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const lower = text.toLowerCase()
  const word = words.find((w) => lower.includes(w))
  if (!word) return <>{text}</>
  const at = lower.indexOf(word)
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-yellow-200 px-px text-inherit dark:bg-yellow-500/35">{text.slice(at, at + word.length)}</mark>
      {text.slice(at + word.length)}
    </>
  )
}

function HitRow({ hit, object, entry, query, current, onClick, onHover }: { hit: FieldHit; object: PlacedObject | undefined; entry: FieldEntry | undefined; query: string; current: boolean; onClick: () => void; onHover: FieldPanelProps["onHover"] }) {
  if (!object || !entry) return null
  const Icon = getMeta(entry.defId)?.icon
  const pin = hit.kind === "pin" ? getDef(object.def)?.pins.find((p) => p.id === hit.pin) : undefined
  const pinName = pin ? [pin.label, pin.mcu && pin.mcu !== pin.label ? pin.mcu : null, pin.signal].filter(Boolean).join(" · ") : ""
  return (
    <button type="button" role="option" aria-selected={current} onClick={onClick} onPointerEnter={() => onHover(hit.object)} className={cn(ROW, current && "bg-sidebar-accent font-medium")}>
      {hit.kind === "pin" ? <span className="flex size-4 shrink-0 items-center justify-center"><span className="size-2 rounded-full border-2 border-current text-muted-foreground" /></span> : Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
      <span className="shrink-0 tabular-nums">
        <Marked text={entry.ref || entry.name} query={query} />
      </span>
      <span className="min-w-0 truncate text-muted-foreground">
        {hit.kind === "pin" ? <Marked text={pinName || hit.label} query={query} /> : <Marked text={entry.value ?? entry.name} query={query} />}
      </span>
      {hit.kind === "pin" && <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">pin</span>}
    </button>
  )
}

/**
 * The folded explorer: one button floating at the field's top-right corner, as the palette's sits
 * at its top-left; a dot with the count when the field has errors or warnings.
 */
export function FieldToggle({ problems, onOpen, className }: { problems: readonly Problem[]; onOpen: () => void; className?: string }) {
  const counts = countBySeverity(problems)
  const worst: Severity | null = counts.error ? "error" : counts.warning ? "warning" : null
  const n = counts.error + counts.warning
  return (
    <Button variant="ghost" size="icon-sm" className={cn("relative", className)} onClick={onOpen} aria-label={n ? `Show the field: ${n} problems` : "Show the field"} title={`Field: parts and problems · ${labelFor(KEYMAP.find)} finds`}>
      <PanelRightIcon />
      {worst && (
        <span className={cn("absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white tabular-nums ring-2 ring-background", worst === "error" ? "bg-red-600" : "bg-amber-500")}>{n}</span>
      )}
    </Button>
  )
}

/**
 * An edge to drag: the panel's left edge (its width) or the line over the inspector (its height).
 * The arrow keys step it, a double click puts it back, Escape mid-drag lets go without a change.
 */
function Splitter({ orientation, label, value, className, start, onDrag, onDrop, onCancel, onStep, onReset }: {
  orientation: "vertical" | "horizontal"
  label: string
  value: number
  className?: string
  /** The size when the drag starts. */
  start: () => number
  /** Pixels moved since the press (right or down positive), and the size at the press. */
  onDrag: (moved: number, start: number) => void
  onDrop: (moved: number, start: number) => void
  onCancel: () => void
  /** A key: +1 widens the panel / grows the inspector, -1 the other way. */
  onStep: (direction: 1 | -1) => void
  onReset: () => void
}) {
  const drag = React.useRef<{ at: number; size: number } | null>(null)
  const across = (e: React.PointerEvent) => (orientation === "vertical" ? e.clientX : e.clientY)
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className={cn("touch-none outline-hidden after:absolute after:bg-transparent after:transition-colors hover:after:bg-ring focus-visible:after:bg-ring", className)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { at: across(e), size: start() }
      }}
      onPointerMove={(e) => drag.current && onDrag(across(e) - drag.current.at, drag.current.size)}
      onPointerUp={(e) => {
        if (!drag.current) return
        const { at, size } = drag.current
        drag.current = null
        onDrop(across(e) - at, size)
      }}
      onPointerCancel={() => {
        drag.current = null
        onCancel()
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "Escape" && drag.current) {
          drag.current = null
          return onCancel()
        }
        const grow = orientation === "vertical" ? { ArrowLeft: 1, ArrowRight: -1 } : { ArrowUp: 1, ArrowDown: -1 }
        const d = grow[e.key as keyof typeof grow]
        if (!d) return
        e.preventDefault()
        onStep(d as 1 | -1)
      }}
    />
  )
}
