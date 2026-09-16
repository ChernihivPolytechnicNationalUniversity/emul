import * as React from "react"
import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Inspector } from "@/components/inspector/Inspector"
import { PALETTE_DRAG_TYPE, paletteGroups } from "@/components/palette/items"
import { GRID as FIELD_GRID, objectRect, resolvePin, snap, type Point } from "@/schematic/geometry"
import type { PinRef, Schematic } from "@/schematic/types"
import { pinName } from "@/schematic/registry"
import { useSchematic, type Clip } from "@/schematic/use-schematic"
import { toast } from "sonner"
import { DT } from "@/sim/loop"
import { useSimulation } from "@/sim/use-simulation"
import { Scope, SCOPE_COLUMNS, TIMEBASES, type ScopeMode } from "@/components/scope/Scope"
import { TraceStore } from "@/components/scope/trace-store"
import { LogicAnalyser, LOGIC_SPANS, DEFAULT_DECODER, type DecoderConfig } from "@/components/logic/LogicAnalyser"
import { LogicStore } from "@/components/logic/logic-store"
import { ComponentView } from "./ComponentView"
import { MeasureLayer } from "./MeasureLayer"
import { PinLayer } from "./PinLayer"
import { FieldReadout, ProbeReadout, type HoverTarget } from "./Readout"
import { ScaleBar } from "./ScaleBar"
import { SimControls } from "./SimControls"
import { WireLayer, type PendingWire } from "./WireLayer"
import { ZoomControls } from "./ZoomControls"
import { useMeasure, MAX_HELD, PROBE_ID, type ProbePoint } from "./use-measure"
import { useSelection, type Rect } from "./use-selection"
import { useViewport } from "./use-viewport"

/** 1 cell = 2.54 mm (0.1"), the standard header pitch, so pins land on grid nodes. */
const GRID = FIELD_GRID
/** Screen distance below which grid dots are thinned out. */
const MIN_DOT_PX = 16

/** Everything the app menu drives on the field. */
export type DotFieldHandle = {
  /** Place a component of the given definition id at the center of the current view. */
  addAtCenter: (defId: string) => void
  /** Replace the schematic and bring it into view. */
  load: (doc: Schematic) => void
  /** The document as it stands, for saving. */
  doc: () => Schematic
  clear: () => void
  undo: () => void
  redo: () => void
  cut: () => void
  copy: () => void
  paste: () => void
  duplicate: () => void
  selectAll: () => void
  deselectAll: () => void
  deleteSelected: () => void
  rotate: (delta: 45 | -45) => void
  zoomIn: () => void
  zoomOut: () => void
  resetView: () => void
  toggleRun: () => void
  restart: () => void
  setSpeed: (speed: number) => void
  toggleProbe: () => void
  toggleScope: () => void
  toggleLogic: () => void
}

/** What the menu needs to know to label and enable its items. */
export type FieldState = {
  hasSelection: boolean
  /** Objects, not just wires, are selected: what cut/copy/rotate act on. */
  hasObjects: boolean
  isEmpty: boolean
  canUndo: boolean
  canRedo: boolean
  canPaste: boolean
  running: boolean
  /** False before the first solver step: there is nothing to start over from. */
  started: boolean
  speed: number
  probing: boolean
  scope: boolean
  logic: boolean
}

type DotFieldProps = Omit<React.ComponentProps<typeof ContextMenuTrigger>, "ref"> & {
  ref?: React.Ref<DotFieldHandle>
  grid?: number
  /** Called whenever the marquee area changes (null when cleared). */
  onSelectionChange?: (rect: Rect | null) => void
  /** Called whenever the schematic document changes. */
  onChange?: (doc: Schematic) => void
  /** Called whenever something the menu shows changes. */
  onStateChange?: (state: FieldState) => void
}

/** Locate the pin under a client point, using DOM data attributes set by PinLayer. */
function pinAt(clientX: number, clientY: number): PinRef | null {
  const el = document.elementFromPoint(clientX, clientY)
  const pinEl = el?.closest<SVGElement>("[data-pin]")
  const objEl = pinEl?.closest<SVGElement>("[data-object]")
  if (!pinEl || !objEl) return null
  return { object: objEl.dataset.object!, pin: pinEl.dataset.pin! }
}

/** Id of the wire under a client point, when the point is not on a pin. */
function wireAt(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY)
  return el?.closest<SVGElement>("[data-wire]")?.dataset.wire ?? null
}

export function DotField({ ref, className, grid = GRID, onSelectionChange, onChange, onStateChange, children, ...props }: DotFieldProps) {
  const { containerRef, viewport, panning, spaceHeld, zoomIn, zoomOut, reset, fitTo, toWorld, isPanStart, startPan, movePan, endPan } = useViewport()
  const sel = useSelection(toWorld, grid)
  const sch = useSchematic(grid)
  const measure = useMeasure()
  const [simRunning, setSimRunning] = React.useState(false)
  const onFailure = React.useCallback(
    (f: { ref: string; damage: { reason: string } }) => toast.error(`${f.ref} burnt out`, { description: f.damage.reason }),
    [],
  )
  // Simulated seconds per real second; 1 is real time.
  const [speed, setSpeed] = React.useState(1)

  // --- oscilloscope -----------------------------------------------------------
  const [scopeOpen, setScopeOpen] = React.useState(false)
  const [scopeWindow, setScopeWindow] = React.useState<number>(TIMEBASES[4])
  const [scopeMode, setScopeMode] = React.useState<ScopeMode>("sweep")
  const [trace] = React.useState(() => new TraceStore())
  const [traceVersion, setTraceVersion] = React.useState(0)
  const onTrace = React.useCallback<NonNullable<Parameters<typeof useSimulation>[2]>["onTrace"] & object>(
    (chunk, probes) => {
      trace.push(chunk, probes)
      setTraceVersion(trace.version)
    },
    [trace],
  )
  // Samples are only collected while the scope is open; the bucket follows the timebase.
  const traceBucket = scopeOpen ? Math.max(DT, scopeWindow / SCOPE_COLUMNS) : 0

  // --- logic analyser ----------------------------------------------------------
  const [logicOpen, setLogicOpen] = React.useState(false)
  const [logicSpan, setLogicSpan] = React.useState<number>(LOGIC_SPANS[7])
  const [decoder, setDecoder] = React.useState<DecoderConfig>(DEFAULT_DECODER)
  const [logic] = React.useState(() => new LogicStore())
  const [logicVersion, setLogicVersion] = React.useState(0)
  const onLogic = React.useCallback<NonNullable<Parameters<typeof useSimulation>[2]>["onLogic"] & object>(
    (chunk, probes) => {
      logic.push(chunk, probes)
      setLogicVersion(logic.version)
    },
    [logic],
  )

  const { sim, restart, started, sendSerial } = useSimulation(sch.doc, simRunning, {
    speed,
    probes: measure.probes,
    onFailure,
    traceBucket,
    onTrace,
    logic: logicOpen,
    onLogic,
  })
  const hairline = 1 / viewport.scale
  // Dot grid adapts to zoom: when cells get too dense, show every 2nd/4th/… node; the
  // dropped level fades in as it grows so zooming does not pop.
  const cellPx = grid * viewport.scale
  let level = 1
  while (cellPx * level < MIN_DOT_PX) level *= 2
  const step = cellPx * level
  const fine = level > 1 ? step / 2 : 0
  const fineAlpha = fine ? Math.max(0, Math.min(1, (fine - MIN_DOT_PX / 2) / (MIN_DOT_PX / 2))) : 0
  const dotR = Math.max(1, Math.min(2, step / 24))
  const dot = (alpha: number) =>
    `radial-gradient(color-mix(in oklch, var(--muted-foreground) ${Math.round(35 * alpha)}%, transparent) ${dotR}px, transparent ${dotR}px)`

  const hasSelection = sch.selectedObjects.size > 0 || sch.selectedWires.size > 0
  const hasObjects = sch.selectedObjects.size > 0
  const isEmpty = sch.doc.objects.length === 0

  // --- clipboard --------------------------------------------------------------
  // The clip lives here; the system clipboard gets a JSON copy so a schematic fragment can
  // travel between tabs, and a paste that carries one is preferred over the local clip.
  const [clip, setClip] = React.useState<Clip | null>(null)
  /** How many times the current clip was pasted; each paste lands one cell further. */
  const pasted = React.useRef(0)

  const { copySelected, paste: pasteClip } = sch
  const copy = React.useCallback(() => {
    const c = copySelected()
    if (!c) return
    setClip(c)
    pasted.current = 0
    navigator.clipboard?.writeText(JSON.stringify({ emul: c })).catch(() => {})
  }, [copySelected])
  const paste = React.useCallback(
    (c: Clip | null = clip) => {
      if (!c) return
      pasted.current += 1
      pasteClip(c, pasted.current * grid, pasted.current * grid)
    },
    [clip, pasteClip, grid],
  )
  const duplicate = React.useCallback(() => {
    const c = copySelected()
    if (c) pasteClip(c, grid, grid)
  }, [copySelected, pasteClip, grid])
  const cut = React.useCallback(() => {
    copy()
    sch.removeSelected()
  }, [copy, sch])

  React.useEffect(() => onSelectionChange?.(sel.selection), [sel.selection, onSelectionChange])
  React.useEffect(() => onChange?.(sch.doc), [sch.doc, onChange])
  React.useEffect(
    () =>
      onStateChange?.({
        hasSelection,
        hasObjects,
        isEmpty,
        canUndo: sch.canUndo,
        canRedo: sch.canRedo,
        canPaste: clip !== null,
        running: simRunning,
        started,
        speed,
        probing: measure.active,
        scope: scopeOpen,
        logic: logicOpen,
      }),
    [onStateChange, hasSelection, hasObjects, isEmpty, sch.canUndo, sch.canRedo, clip, simRunning, started, speed, measure.active, scopeOpen, logicOpen],
  )

  /** World point under the last right-click, used by the "Add" submenu. */
  const menuPoint = React.useRef<Point>({ x: 0, y: 0 })

  const viewCenter = React.useCallback((): Point => {
    const el = containerRef.current
    const r = el?.getBoundingClientRect()
    return toWorld((r?.left ?? 0) + (el?.clientWidth ?? 0) / 2, (r?.top ?? 0) + (el?.clientHeight ?? 0) / 2)
  }, [containerRef, toWorld])

  const { add, load } = sch
  React.useImperativeHandle(
    ref,
    () => ({
      addAtCenter: (defId) => add(defId, viewCenter()),
      load: (next) => {
        // A new document has no simulation history: drop the frozen picture as well.
        setSimRunning(false)
        restart()
        trace.clear()
        logic.clear()
        load(next)
        const rects = next.objects.map((o) => objectRect(o, grid))
        if (rects.length === 0) return
        // Grown by a cell on each side: wires are routed outside the component boxes.
        const x = Math.min(...rects.map((r) => r.x)) - grid
        const y = Math.min(...rects.map((r) => r.y)) - grid
        fitTo({
          x,
          y,
          w: Math.max(...rects.map((r) => r.x + r.w)) + grid - x,
          h: Math.max(...rects.map((r) => r.y + r.h)) + grid - y,
        })
      },
      doc: () => sch.doc,
      clear: () => {
        setSimRunning(false)
        restart()
        trace.clear()
        logic.clear()
        sch.clear()
      },
      undo: sch.undo,
      redo: sch.redo,
      cut,
      copy,
      paste: () => paste(),
      duplicate,
      selectAll: sch.selectAll,
      deselectAll: sch.deselectAll,
      deleteSelected: sch.removeSelected,
      rotate: (delta) => sch.rotate(sch.selectedObjects, delta),
      zoomIn,
      zoomOut,
      resetView: reset,
      toggleRun: () => setSimRunning((r) => !r),
      restart: () => {
        restart()
        trace.clear()
        logic.clear()
        setSimRunning(true)
      },
      setSpeed,
      toggleProbe: measure.toggle,
      toggleScope: () => setScopeOpen((o) => !o),
      toggleLogic: () => setLogicOpen((o) => !o),
    }),
    [add, load, viewCenter, fitTo, grid, sch, cut, copy, paste, duplicate, zoomIn, zoomOut, reset, restart, trace, logic, measure.toggle],
  )

  // --- moving objects -------------------------------------------------------
  const move = React.useRef<{ origin: Point; from: Map<string, Point> } | null>(null)

  const onBodyPointerDown = (e: React.PointerEvent<SVGSVGElement>, id: string) => {
    if (e.button !== 0 || spaceHeld) return
    e.stopPropagation()
    const toggle = e.shiftKey || e.ctrlKey || e.metaKey
    sch.selectObject(id, toggle)
    sel.clear()
    if (toggle) return
    const ids = sch.selectedObjects.has(id) ? sch.selectedObjects : new Set([id])
    const from = new Map<string, Point>()
    for (const o of sch.doc.objects) if (ids.has(o.id)) from.set(o.id, { x: o.x, y: o.y })
    move.current = { origin: toWorld(e.clientX, e.clientY), from }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onBodyPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!move.current) return
    const p = toWorld(e.clientX, e.clientY)
    sch.moveTo(move.current.from, p.x - move.current.origin.x, p.y - move.current.origin.y)
  }
  const onBodyPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    move.current = null
    sch.endMove()
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // --- measuring: readout under the cursor, probe tips on click ---------------
  const [hover, setHover] = React.useState<{
    target: HoverTarget
    x: number
    y: number
  } | null>(null)

  /** Track what the cursor is over, except while an interaction owns the pointer. */
  const updateHover = (e: React.PointerEvent) => {
    if (panning || spaceHeld || pending || move.current || sel.dragging) {
      setHover((prev) => (prev === null ? prev : null))
      return
    }
    const pin = pinAt(e.clientX, e.clientY)
    const wire = pin ? null : wireAt(e.clientX, e.clientY)
    const target: HoverTarget | null = pin ? { kind: "pin", ref: pin } : wire ? { kind: "wire", id: wire } : null
    setHover((prev) => (target ? { target, x: e.clientX, y: e.clientY } : prev === null ? prev : null))
  }

  /** A probe tip on a pin sits on the pin; one on a wire sits where the wire was clicked. */
  const probeAtPin = (ref: PinRef): ProbePoint | null => {
    const found = resolvePin(sch.doc.objects, ref, grid)
    return found && { ref, at: found.point, label: pinName(sch.doc.objects, ref) }
  }
  const probeOnWire = (wireId: string, clientX: number, clientY: number): ProbePoint | null => {
    const w = sch.doc.wires.find((x) => x.id === wireId)
    if (!w) return null
    return {
      ref: w.from,
      at: toWorld(clientX, clientY),
      label: pinName(sch.doc.objects, w.from),
      onWire: true,
    }
  }

  // A probe on a pin follows it around the field; one put down on a wire stays where it was
  // clicked, since that point is the net rather than any one terminal.
  const { drop: dropTips } = measure
  React.useEffect(() => {
    const ids = new Set(sch.doc.objects.map((o) => o.id))
    dropTips((ref) => !ids.has(ref.object))
  }, [sch.doc.objects, dropTips])
  const liveTip = (tip: ProbePoint | null): ProbePoint | null => {
    if (!tip || tip.onWire) return tip
    const found = resolvePin(sch.doc.objects, tip.ref, grid)
    return found ? { ...tip, at: found.point } : tip
  }
  const tips = { a: liveTip(measure.tips.a), b: liveTip(measure.tips.b) }
  const heldTips = measure.held.map((c) => ({
    ...c,
    tips: { a: liveTip(c.tips.a)!, b: liveTip(c.tips.b) },
  }))

  // --- wiring: drag from pin to pin, or click bend by bend ------------------
  const [pending, setPending] = React.useState<PendingWire | null>(null)
  const snapPoint = (p: Point): Point => ({
    x: snap(p.x, grid),
    y: snap(p.y, grid),
  })

  const finishWire = (target: PinRef) => {
    if (pending) sch.addWire(pending.from, target, pending.points)
    setPending(null)
  }

  /** Land the pending wire on an existing one: a junction goes in at that point. */
  const tapInto = (wireId: string, clientX: number, clientY: number) => {
    if (!pending) return false
    sch.tapWire(wireId, snapPoint(toWorld(clientX, clientY)), pending.from, pending.points)
    setPending(null)
    return true
  }

  /** Finish on whatever is under the cursor: a pin, else a wire. Returns false if neither. */
  const finishAt = (clientX: number, clientY: number) => {
    const target = pinAt(clientX, clientY)
    if (target && !(pending && target.object === pending.from.object && target.pin === pending.from.pin)) {
      finishWire(target)
      return true
    }
    const wire = wireAt(clientX, clientY)
    return wire ? tapInto(wire, clientX, clientY) : false
  }

  const onPinPointerDown = (e: React.PointerEvent<SVGElement>, object: string, pin: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (measure.active) {
      const tip = probeAtPin({ object, pin })
      if (tip) measure.pick(tip)
      return
    }
    if (pending?.mode === "click") {
      finishWire({ object, pin })
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setPending({
      from: { object, pin },
      cursor: toWorld(e.clientX, e.clientY),
      target: null,
      points: [],
      mode: "drag",
    })
  }
  const onPinPointerMove = (e: React.PointerEvent<SVGElement>) => {
    if (pending?.mode !== "drag") return
    setPending({
      ...pending,
      cursor: toWorld(e.clientX, e.clientY),
      target: pinAt(e.clientX, e.clientY),
    })
  }
  const onPinPointerUp = (e: React.PointerEvent<SVGElement>) => {
    if (pending?.mode !== "drag") return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (finishAt(e.clientX, e.clientY)) return
    // Released on empty space: keep the wire, switch to click mode. A drag adds its end as a bend.
    const cursor = toWorld(e.clientX, e.clientY)
    const moved = pinAt(e.clientX, e.clientY) === null
    setPending({
      ...pending,
      cursor,
      target: null,
      mode: "click",
      points: moved ? [snapPoint(cursor)] : [],
    })
  }

  /** Bend handles of a selected wire. */
  const bend = React.useRef<{ wire: string; index: number } | null>(null)
  const onBendPointerDown = (e: React.PointerEvent<SVGCircleElement>, wire: string, index: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    bend.current = { wire, index }
  }
  const onBendPointerMove = (e: React.PointerEvent<SVGCircleElement>) => {
    if (!bend.current) return
    const w = sch.doc.wires.find((x) => x.id === bend.current!.wire)
    if (!w?.points) return
    const points = w.points.slice()
    points[bend.current.index] = snapPoint(toWorld(e.clientX, e.clientY))
    sch.setWirePoints(w.id, points, true)
  }
  const onBendPointerUp = (e: React.PointerEvent<SVGCircleElement>) => {
    bend.current = null
    sch.endDrag()
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const onInsertBend = (wireId: string, index: number, clientX: number, clientY: number) => {
    const w = sch.doc.wires.find((x) => x.id === wireId)
    if (!w) return
    const points = (w.points ?? []).slice()
    points.splice(index, 0, snapPoint(toWorld(clientX, clientY)))
    sch.setWirePoints(wireId, points)
    sch.selectWire(wireId)
  }
  const onRemoveBend = (wireId: string, index: number) => {
    const w = sch.doc.wires.find((x) => x.id === wireId)
    if (!w?.points) return
    sch.setWirePoints(
      wireId,
      w.points.filter((_, i) => i !== index),
    )
  }

  const onWirePointerDown = (e: React.PointerEvent<SVGPathElement>, id: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (measure.active) {
      const tip = probeOnWire(id, e.clientX, e.clientY)
      if (tip) measure.pick(tip)
      return
    }
    if (pending?.mode === "click" && tapInto(id, e.clientX, e.clientY)) return
    sch.selectWire(id, e.shiftKey || e.ctrlKey || e.metaKey)
    sel.clear()
  }

  // --- field pointer handling: pan or marquee --------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isPanStart(e)) startPan(e)
    // A click on bare field while probing is a miss, not a selection.
    else if (measure.active) return
    else if (e.button === 0 && pending?.mode === "click") {
      if (!finishAt(e.clientX, e.clientY))
        setPending({
          ...pending,
          points: [...pending.points, snapPoint(toWorld(e.clientX, e.clientY))],
        })
    } else if (e.button === 0) {
      sch.deselectAll()
      sel.start(e)
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (movePan(e)) return
    if (pending?.mode === "click") {
      setPending({
        ...pending,
        cursor: toWorld(e.clientX, e.clientY),
        target: pinAt(e.clientX, e.clientY),
      })
      return
    }
    updateHover(e)
    sel.move(e)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (endPan(e)) return
    const rect = sel.end(e)
    if (rect) sch.selectInRect(rect)
  }

  // --- drag-and-drop from the palette ----------------------------------------
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(PALETTE_DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }
  const onDrop = (e: React.DragEvent) => {
    const defId = e.dataTransfer.getData(PALETTE_DRAG_TYPE)
    if (!defId) return
    e.preventDefault()
    sch.add(defId, toWorld(e.clientX, e.clientY))
  }

  // --- keyboard --------------------------------------------------------------
  /** Keys typed into a text field are the field's; buttons (a just-clicked palette entry) are fine. */
  const inTextField = (e: Event) => {
    const t = e.target as HTMLElement | null
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
  }
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inTextField(e)) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (e.key === "Delete" || e.key === "Backspace") {
        sch.removeSelected()
      } else if (e.key === "Escape") {
        if (measure.active) measure.stop()
        sch.deselectAll()
        setPending(null)
      } else if (mod && key === "z") {
        e.preventDefault()
        if (e.shiftKey) sch.redo()
        else sch.undo()
      } else if (mod && key === "y") {
        e.preventDefault()
        sch.redo()
      } else if (mod && key === "a") {
        e.preventDefault()
        sch.selectAll()
      } else if (mod && key === "d") {
        e.preventDefault()
        duplicate()
      } else if (!mod && !e.altKey && key === "m") {
        measure.toggle()
      } else if (!mod && !e.altKey && key === "o") {
        setScopeOpen((o) => !o)
      } else if (!mod && !e.altKey && key === "l") {
        setLogicOpen((o) => !o)
      } else if (!mod && !e.altKey && key === "r") {
        if (sch.selectedObjects.size) sch.rotate(sch.selectedObjects, e.shiftKey ? -45 : 45)
      }
    }
    // Cut/copy/paste ride the native events so the system clipboard sees them too.
    const onCopy = (e: ClipboardEvent) => {
      if (inTextField(e) || !sch.selectedObjects.size) return
      e.preventDefault()
      copy()
    }
    const onCut = (e: ClipboardEvent) => {
      if (inTextField(e) || !sch.selectedObjects.size) return
      e.preventDefault()
      cut()
    }
    const onPaste = (e: ClipboardEvent) => {
      if (inTextField(e)) return
      e.preventDefault()
      const text = e.clipboardData?.getData("text/plain")
      let external: Clip | null = null
      try {
        const parsed = text ? (JSON.parse(text) as { emul?: Clip }) : null
        if (parsed?.emul && Array.isArray(parsed.emul.objects)) external = parsed.emul
      } catch {
        // Not ours; fall back to the local clip.
      }
      paste(external ?? undefined)
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("copy", onCopy)
    window.addEventListener("cut", onCut)
    window.addEventListener("paste", onPaste)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("copy", onCopy)
      window.removeEventListener("cut", onCut)
      window.removeEventListener("paste", onPaste)
    }
  }, [sch, measure, copy, cut, paste, duplicate])

  const cursor = panning ? "cursor-grabbing" : spaceHeld ? "cursor-grab" : "cursor-crosshair"
  const probeReading = sim.probe(PROBE_ID)
  const selectedObjectList = sch.doc.objects.filter((o) => sch.selectedObjects.has(o.id))
  const across = (a: ProbePoint, b: ProbePoint | null) => `${a.label} → ${b ? b.label : "ground"}`
  const scopeChannels = [
    ...measure.held.map((c) => ({
      id: c.id,
      label: across(c.tips.a, c.tips.b),
      color: c.color,
      value: sim.probe(c.id)?.live ? sim.probe(c.id)?.v : undefined,
    })),
    ...(measure.tips.a
      ? [
          {
            id: PROBE_ID,
            label: across(measure.tips.a, measure.tips.b),
            color: "#ef4444",
            value: probeReading?.live ? probeReading.v : undefined,
            live: true,
          },
        ]
      : []),
  ]

  return (
    <ContextMenu>
      <ContextMenuTrigger data-slot="dot-field" className={cn("flex h-full w-full flex-col overflow-hidden bg-background", className)} {...props}>
        <div data-slot="dot-field-stage" className="relative min-h-0 flex-1 overflow-hidden">
          <div
            ref={containerRef}
            data-slot="dot-field-viewport"
            className={cn("absolute inset-0 touch-none select-none", cursor)}
            style={{
              backgroundImage: fine && fineAlpha > 0 ? `${dot(1)}, ${dot(fineAlpha)}` : dot(1),
              backgroundSize: fine && fineAlpha > 0 ? `${step}px ${step}px, ${fine}px ${fine}px` : `${step}px ${step}px`,
              backgroundPosition: `${viewport.x}px ${viewport.y}px`,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => setHover(null)}
            onContextMenu={(e) => {
              menuPoint.current = toWorld(e.clientX, e.clientY)
              if (pending) {
                e.preventDefault()
                setPending(null)
              }
            }}
            onDragOver={onDragOver}
            onDrop={onDrop}
          >
            <div
              data-slot="dot-field-content"
              className="absolute top-0 left-0 origin-top-left"
              style={{
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
              }}
            >
              {children}
              {sch.doc.objects.map((o) => (
                <div key={o.id} data-object={o.id} className="contents">
                  <ComponentView
                    object={o}
                    grid={grid}
                    selected={sch.selectedObjects.has(o.id)}
                    hairline={hairline}
                    parts={sch.doc.parts}
                    sim={sim}
                    onBodyPointerDown={(e) => onBodyPointerDown(e, o.id)}
                    onBodyPointerMove={onBodyPointerMove}
                    onBodyPointerUp={onBodyPointerUp}
                    onBodyContextMenu={() => sch.selectObject(o.id)}
                    onPartChange={sch.setPart}
                  />
                </div>
              ))}
              <WireLayer
                objects={sch.doc.objects}
                wires={sch.doc.wires}
                grid={grid}
                hairline={hairline}
                selected={sch.selectedWires}
                pending={pending}
                currents={sim.wireCurrent}
                currentsAbs={sim.wireCurrentAbs}
                phases={sim.wirePhase}
                paused={sim.paused}
                onWirePointerDown={onWirePointerDown}
                onInsertBend={onInsertBend}
                onRemoveBend={onRemoveBend}
                onBendPointerDown={onBendPointerDown}
                onBendPointerMove={onBendPointerMove}
                onBendPointerUp={onBendPointerUp}
              />
              {/* Above the wires: a pin on a wire has to stay visible and clickable. */}
              <PinLayer
                objects={sch.doc.objects}
                grid={grid}
                hairline={hairline}
                connectedPins={sch.connectedPins}
                contactPins={sch.contactPins}
                onPinPointerDown={onPinPointerDown}
                onPinPointerMove={onPinPointerMove}
                onPinPointerUp={onPinPointerUp}
              />
              <MeasureLayer tips={tips} held={heldTips} grid={grid} hairline={hairline} />
              {sel.selection && (
                <div
                  data-slot="dot-field-selection"
                  className="pointer-events-none absolute border border-primary bg-primary/10"
                  style={{
                    left: sel.selection.x,
                    top: sel.selection.y,
                    width: sel.selection.w,
                    height: sel.selection.h,
                    borderWidth: hairline,
                  }}
                />
              )}
            </div>
          </div>

          <ProbeReadout
            className="absolute bottom-16 left-4"
            tips={tips}
            reading={probeReading}
            sim={sim}
            onClear={measure.clear}
            onPointerDown={(e) => e.stopPropagation()}
          />
          <SimControls
            className="absolute bottom-4 left-4"
            sim={sim}
            speed={speed}
            started={started}
            probing={measure.active}
            onProbeToggle={measure.toggle}
            onToggle={() => setSimRunning((r) => !r)}
            onRestart={() => {
              restart()
              setSimRunning(true)
            }}
            onSpeedChange={setSpeed}
            onPointerDown={(e) => e.stopPropagation()}
          />
          <Inspector
            className="absolute top-3 right-3"
            selected={selectedObjectList}
            damage={sim.damage}
            sim={sim}
            onChange={sch.setProps}
            onSerial={sendSerial}
            onRotate={(d) => sch.rotate(sch.selectedObjects, d)}
            onDelete={sch.removeSelected}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <ScaleBar className="absolute right-4 bottom-14" scale={viewport.scale} grid={grid} />
          <ZoomControls className="absolute right-4 bottom-4" scale={viewport.scale} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={reset} />
          {hover && <FieldReadout target={hover.target} x={hover.x} y={hover.y} objects={sch.doc.objects} wires={sch.doc.wires} sim={sim} />}
        </div>
        {scopeOpen && (
          <Scope
            className="h-56 shrink-0 border-t"
            store={trace}
            version={traceVersion}
            channels={scopeChannels}
            window={scopeWindow}
            onWindowChange={setScopeWindow}
            mode={scopeMode}
            onModeChange={setScopeMode}
            canHold={measure.held.length < MAX_HELD}
            onHold={measure.hold}
            onRelease={measure.release}
            onClose={() => setScopeOpen(false)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        )}
        {logicOpen && (
          <LogicAnalyser
            className="h-56 shrink-0 border-t"
            store={logic}
            version={logicVersion}
            channels={scopeChannels}
            span={logicSpan}
            onSpanChange={setLogicSpan}
            decoder={decoder}
            onDecoderChange={setDecoder}
            canHold={measure.held.length < MAX_HELD}
            onHold={measure.hold}
            onRelease={measure.release}
            onClose={() => setLogicOpen(false)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        )}
      </ContextMenuTrigger>

      <ContextMenuContent className="w-64">
        <ContextMenuSub>
          <ContextMenuSubTrigger>Add component</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            {paletteGroups.map((g, gi) => (
              <React.Fragment key={g.id}>
                {gi > 0 && <ContextMenuSeparator />}
                {g.items.map((def) => (
                  <ContextMenuItem key={def.id} onClick={() => sch.add(def.id, menuPoint.current)}>
                    <def.icon />
                    {def.name}
                  </ContextMenuItem>
                ))}
              </React.Fragment>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!sch.canUndo} onClick={sch.undo}>
          Undo
          <ContextMenuShortcut>⌘Z</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!sch.canRedo} onClick={sch.redo}>
          Redo
          <ContextMenuShortcut>⇧⌘Z</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!hasObjects} onClick={cut}>
          Cut
          <ContextMenuShortcut>⌘X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasObjects} onClick={copy}>
          Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!clip} onClick={() => paste()}>
          Paste
          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasObjects} onClick={duplicate}>
          Duplicate
          <ContextMenuShortcut>⌘D</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!hasObjects} onClick={() => sch.rotate(sch.selectedObjects, 45)}>
          Rotate 45° clockwise
          <ContextMenuShortcut>R</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasObjects} onClick={() => sch.rotate(sch.selectedObjects, -45)}>
          Rotate 45° counter-clockwise
          <ContextMenuShortcut>⇧R</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onClick={sch.removeSelected}>
          Delete
          <ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={zoomIn}>
          Zoom in
          <ContextMenuShortcut>⌘+</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={zoomOut}>
          Zoom out
          <ContextMenuShortcut>⌘−</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={reset}>
          Reset view
          <ContextMenuShortcut>⌘0</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={isEmpty} onClick={sch.selectAll}>
          Select all
          <ContextMenuShortcut>⌘A</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection}
          onClick={() => {
            sch.deselectAll()
            sel.clear()
          }}
        >
          Deselect
          <ContextMenuShortcut>Esc</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" disabled={isEmpty} onClick={sch.clear}>
          Clear field
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
