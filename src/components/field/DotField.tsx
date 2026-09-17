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
import { WirePalette } from "@/components/inspector/WirePalette"
import { PALETTE_DRAG_TYPE, paletteGroups } from "@/components/palette/items"
import { GRID as FIELD_GRID, nudgeRoutes, objectRect, resolvePin, Router, snap, type Point } from "@/schematic/geometry"
import { SpatialIndex } from "@/schematic/spatial"
import { fieldDetail } from "./detail"
import { buildNets } from "@/schematic/nets"
import { autoNetColor, semanticNetColor, wireColorVar, AUTO_COLOR_ORDER, DEFAULT_SIGNAL_COLOR, WIRE_COLOR_BY_CODE, type WireColorKey } from "@/schematic/wire-colors"
import { pinKey, type PinRef, type Schematic } from "@/schematic/types"
import { getDef, pinName } from "@/schematic/registry"
import { bytesToBase64 } from "@/lib/bytes"
import { useEvent } from "@/hooks/use-event"
import { useSchematic, type Clip } from "@/schematic/use-schematic"
import { toast } from "sonner"
import { DT } from "@/sim/loop"
import { useSimulation } from "@/sim/use-simulation"
import { Scope, SCOPE_COLUMNS, TIMEBASES, type ScopeMode } from "@/components/scope/Scope"
import { TraceStore } from "@/components/scope/trace-store"
import { LogicAnalyser, LOGIC_SPANS, DEFAULT_DECODER, type DecoderConfig } from "@/components/logic/LogicAnalyser"
import { LogicStore } from "@/components/logic/logic-store"
import type { EditorHandle } from "@/components/code/Editor"

/** Monaco is a few megabytes; it loads the first time the code panel opens, not with the page. */
const CodePanel = React.lazy(() => import("@/components/code/CodePanel").then((m) => ({ default: m.CodePanel })))
import { ComponentView } from "./ComponentView"
import { MeasureLayer } from "./MeasureLayer"
import { PinLayer } from "./PinLayer"
import { FieldReadout, ProbeReadout, type HoverTarget } from "./Readout"
import { ScaleBar } from "./ScaleBar"
import { SimControls } from "./SimControls"
import { PendingWireLayer, WireLayer, type PendingWire } from "./WireLayer"
import { wireCornerRadius } from "./wire-style"
import { BendDrag, MoveDrag, planBend, planMove } from "./move-drag"
import { WireFlow } from "./wire-flow"
import { ZoomControls } from "./ZoomControls"
import { useMeasure, MAX_HELD, PROBE_ID, type ProbePoint } from "./use-measure"
import { useSelection, type Rect } from "./use-selection"
import { useViewport } from "./use-viewport"

/** 1 cell = 2.54 mm (0.1"), the standard header pitch, so pins land on grid nodes. */
const GRID = FIELD_GRID
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
  toggleCode: () => void
  /** Show the code of the board with this designator. */
  openCode: (ref: string) => void
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
  code: boolean
}

type DotFieldProps = Omit<React.ComponentProps<typeof ContextMenuTrigger>, "ref"> & {
  ref?: React.Ref<DotFieldHandle>
  grid?: number
  /** Called with the marquee area when a marquee drag finishes (null when it selected nothing). */
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
  const { containerRef, contentRef, scale, view, worldPerPixel, panning, spaceHeld, zoomIn, zoomOut, reset, fitTo, toWorld, isPanStart, startPan, movePan, endPan } = useViewport(grid)
  const marquee = useSelection(toWorld, worldPerPixel, grid)
  const { boxRef: marqueeRef } = marquee
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

  // --- code panel -------------------------------------------------------------
  const [codeOpen, setCodeOpen] = React.useState(false)
  const codeEditor = React.useRef<EditorHandle | null>(null)
  // The menu's Undo/Redo follow the focus: the text's own history while the cursor is in the code.
  const undo = React.useCallback(() => (codeEditor.current?.focused() ? codeEditor.current.undo() : sch.undo()), [sch])
  const redo = React.useCallback(() => (codeEditor.current?.focused() ? codeEditor.current.redo() : sch.redo()), [sch])
  /** The board whose code the panel shows: the last one selected, kept while other things are picked. */
  const [codeBoardId, setCodeBoardId] = React.useState<string | null>(null)
  const boards = React.useMemo(() => sch.doc.objects.filter((o) => getDef(o.def)?.chip), [sch.doc.objects])
  const selectedBoard = boards.findLast((o) => sch.selectedObjects.has(o.id))
  if (selectedBoard && selectedBoard.id !== codeBoardId) setCodeBoardId(selectedBoard.id)
  // The one board on the schematic needs no picking.
  const codeBoard = boards.find((o) => o.id === codeBoardId) ?? (boards.length === 1 ? boards[0]! : null)
  const onFirmware = React.useCallback(
    (id: string, name: string, bytes: Uint8Array) => sch.setProps(id, { firmware: name, firmwareData: bytesToBase64(bytes) }),
    [sch],
  )

  const { sim, simStore, restart, started, sendSerial } = useSimulation(sch.doc, simRunning, {
    speed,
    probes: measure.probes,
    onFailure,
    traceBucket,
    onTrace,
    logic: logicOpen,
    onLogic,
  })
  const { objects: docObjects, wires: docWires } = sch.doc
  const [router] = React.useState(() => new Router())
  const nets = React.useMemo(() => buildNets(docObjects, docWires, grid), [docObjects, docWires, grid])
  const index = React.useMemo(() => new SpatialIndex(docObjects, grid), [docObjects, grid])
  const routes = React.useMemo(
    () => nudgeRoutes(router.routeAll(docObjects, docWires, grid), nets.netOfWire, grid),
    [router, docObjects, docWires, grid, nets],
  )
  const wireById = React.useMemo(() => new Map(docWires.map((w) => [w.id, w])), [docWires])

  // --- what is worth drawing: only what the view can show, at the detail it can resolve ------
  const detail = React.useMemo(() => fieldDetail(grid, scale), [grid, scale])
  const visibleObjects = React.useMemo(() => (view.w > 0 ? index.query(view) : docObjects), [index, view, docObjects])
  const visibleRoutes = React.useMemo(() => {
    if (view.w <= 0) return routes
    const right = view.x + view.w
    const bottom = view.y + view.h
    return routes.filter((r) => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const p of r.pts) {
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
      }
      return minX <= right && maxX >= view.x && minY <= bottom && maxY >= view.y
    })
  }, [routes, view])
  /** Pins sitting on another pin: drawn as a solid junction dot instead of a terminal. */
  const contactPins = React.useMemo(() => new Set(nets.contacts.keys()), [nets])
  /** Pins a wire lands on, plus pins that touch another pin — both are live connections. */
  const connectedPins = React.useMemo(() => {
    const s = new Set<string>(contactPins)
    for (const w of docWires) {
      s.add(pinKey(w.from.object, w.from.pin))
      s.add(pinKey(w.to.object, w.to.pin))
    }
    return s
  }, [docWires, contactPins])
  const autoColor = React.useMemo(() => {
    const m = new Map<string, WireColorKey>()
    for (const net of nets.nets) m.set(net, autoNetColor(nets.kindsOf(net)))
    return m
  }, [nets])
  const colorOf = React.useCallback(
    (wireId: string): WireColorKey => {
      const chosen = wireById.get(wireId)?.color
      if (chosen) return chosen
      const net = nets.netOfWire(wireId)
      return (net === undefined ? undefined : autoColor.get(net)) ?? DEFAULT_SIGNAL_COLOR
    },
    [wireById, nets, autoColor],
  )
  const bendsOf = React.useCallback((wireId: string) => wireById.get(wireId)?.points, [wireById])
  const pinNetColor = React.useCallback(
    (key: string) => {
      const net = nets.netOfPin(key)
      const wire = net && nets.wiresOf(net)[0]
      return wire ? wireColorVar(colorOf(wire)) : undefined
    },
    [nets, colorOf],
  )
  const [hoveredWire, setHoveredWire] = React.useState<string | null>(null)
  const hoveredNet = hoveredWire === null ? null : (nets.netOfWire(hoveredWire) ?? null)
  const [flow] = React.useState(() => new WireFlow())
  React.useEffect(() => () => flow.dispose(), [flow])
  React.useEffect(() => {
    flow.push(sim.wireCurrentAbs, sim.wirePhase, sim.live, sim.paused)
  }, [flow, sim])

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
        code: codeOpen,
      }),
    [onStateChange, hasSelection, hasObjects, isEmpty, sch.canUndo, sch.canRedo, clip, simRunning, started, speed, measure.active, scopeOpen, logicOpen, codeOpen],
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
      undo,
      redo,
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
      toggleCode: () => setCodeOpen((o) => !o),
      openCode: (ref) => {
        const board = sch.doc.objects.find((o) => o.props?.ref === ref)
        if (board) setCodeBoardId(board.id)
        setCodeOpen(true)
      },
    }),
    [add, load, viewCenter, fitTo, grid, sch, undo, redo, cut, copy, paste, duplicate, zoomIn, zoomOut, reset, restart, trace, logic, measure.toggle],
  )

  // --- moving objects -------------------------------------------------------
  const [drag] = React.useState(() => new MoveDrag())
  React.useEffect(() => () => void drag.clearAndFinish(), [drag])

  const onBodyPointerDown = useEvent((e: React.PointerEvent<SVGSVGElement>, id: string) => {
    if (e.button !== 0 || spaceHeld) return
    e.stopPropagation()
    const toggle = e.shiftKey || e.ctrlKey || e.metaKey
    sch.selectObject(id, toggle)
    marquee.clear()
    if (toggle) return
    const content = contentRef.current
    if (!content) return
    const moving = sch.selectedObjects.has(id) ? sch.selectedObjects : new Set([id])
    drag.begin(
      planMove(content, docObjects, docWires, moving, toWorld(e.clientX, e.clientY), grid, wireCornerRadius(grid)),
    )
    e.currentTarget.setPointerCapture(e.pointerId)
  })
  const onBodyPointerMove = useEvent((e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.active) drag.track(toWorld(e.clientX, e.clientY))
  })
  const onBodyPointerUp = useEvent((e: React.PointerEvent<SVGSVGElement>) => {
    const done = drag.clearAndFinish()
    if (done && (done.dx || done.dy)) sch.moveTo(done.plan.startPositions, done.dx, done.dy)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  })
  const onBodyContextMenu = useEvent((id: string) => sch.selectObject(id))

  // --- measuring: readout under the cursor, probe tips on click ---------------
  const [hover, setHover] = React.useState<{
    target: HoverTarget
    x: number
    y: number
  } | null>(null)

  /** Track what the cursor is over, except while an interaction owns the pointer. */
  const updateHover = (e: React.PointerEvent) => {
    if (panning || spaceHeld || pending || drag.active || marquee.isDragging()) {
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

  const kindsAt = (ref: PinRef) => {
    const net = nets.netOfPin(pinKey(ref.object, ref.pin))
    if (net) return [...nets.kindsOf(net)]
    const found = resolvePin(docObjects, ref, grid)
    return found ? [found.pin.kind] : []
  }
  const autoColorFor = (from: PinRef, to?: PinRef | null): WireColorKey =>
    autoNetColor([...kindsAt(from), ...(to ? kindsAt(to) : [])])

  const finishWire = (target: PinRef) => {
    if (pending) sch.addWire(pending.from, target, pending.points, pending.chosen ? pending.color : undefined)
    setPending(null)
  }

  /** Land the pending wire on an existing one: a junction goes in at that point. */
  const tapInto = (wireId: string, clientX: number, clientY: number) => {
    if (!pending) return false
    sch.tapWire(wireId, toWorld(clientX, clientY), pending.from, pending.points, pending.chosen ? pending.color : undefined)
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

  const onPinPointerDown = useEvent((e: React.PointerEvent<SVGElement>, object: string, pin: string) => {
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
    const from = { object, pin }
    setPending({
      from,
      cursor: toWorld(e.clientX, e.clientY),
      target: null,
      points: [],
      mode: "drag",
      color: autoColorFor(from),
      chosen: false,
    })
  })
  const onPinPointerMove = useEvent((e: React.PointerEvent<SVGElement>) => {
    if (pending?.mode !== "drag") return
    const target = pinAt(e.clientX, e.clientY)
    setPending({
      ...pending,
      cursor: toWorld(e.clientX, e.clientY),
      target,
      color: pending.chosen ? pending.color : autoColorFor(pending.from, target),
    })
  })
  const onPinPointerUp = useEvent((e: React.PointerEvent<SVGElement>) => {
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
  })

  /** Bend handles of a selected wire. */
  const [bend] = React.useState(() => new BendDrag())
  React.useEffect(() => () => bend.cancel(), [bend])
  const onBendPointerDown = useEvent((e: React.PointerEvent<SVGGElement>, wire: string, index: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const content = contentRef.current
    const w = wireById.get(wire)
    if (!content || !w?.points) return
    e.currentTarget.setPointerCapture(e.pointerId)
    bend.begin(planBend(content, docObjects, w, index, grid, wireCornerRadius(grid)))
  })
  const onBendPointerMove = useEvent((e: React.PointerEvent<SVGGElement>) => {
    if (bend.active) bend.track(snapPoint(toWorld(e.clientX, e.clientY)))
  })
  const onBendPointerUp = useEvent((e: React.PointerEvent<SVGGElement>) => {
    const done = bend.clearAndFinish()
    if (done) sch.setWirePoints(done.wire, done.points)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  })
  const onInsertBend = useEvent((wireId: string, index: number, clientX: number, clientY: number) => {
    const w = wireById.get(wireId)
    if (!w) return
    const points = (w.points ?? []).slice()
    points.splice(index, 0, snapPoint(toWorld(clientX, clientY)))
    sch.setWirePoints(wireId, points)
    sch.selectWire(wireId)
  })
  const onRemoveBend = useEvent((wireId: string, index: number) => {
    const w = wireById.get(wireId)
    if (!w?.points) return
    sch.setWirePoints(
      wireId,
      w.points.filter((_, i) => i !== index),
    )
  })

  const onWirePointerDown = useEvent((e: React.PointerEvent<SVGPathElement>, id: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (measure.active) {
      const tip = probeOnWire(id, e.clientX, e.clientY)
      if (tip) measure.pick(tip)
      return
    }
    if (pending?.mode === "click" && tapInto(id, e.clientX, e.clientY)) return
    sch.selectWire(id, e.shiftKey || e.ctrlKey || e.metaKey)
    marquee.clear()
  })
  const onWirePointerEnter = useEvent((id: string) => {
    if (pending || drag.active || marquee.isDragging()) return
    setHoveredWire(id)
  })
  const onWirePointerLeave = useEvent(() => setHoveredWire(null))

  const paintSelected = useEvent((color: WireColorKey | undefined, segmentOnly = false) => {
    const ids = new Set<string>()
    for (const id of sch.selectedWires) {
      const net = segmentOnly ? undefined : nets.netOfWire(id)
      if (net) for (const w of nets.wiresOf(net)) ids.add(w)
      else ids.add(id)
    }
    sch.setWireColors([...ids].map((id) => [id, color] as const))
  })

  const autoColorAllNets = useEvent(() => {
    const entries: [string, WireColorKey | undefined][] = []
    let next = 0
    for (const net of nets.nets) {
      const color = semanticNetColor(nets.kindsOf(net)) ?? AUTO_COLOR_ORDER[next++ % AUTO_COLOR_ORDER.length]
      for (const id of nets.wiresOf(net)) entries.push([id, color])
    }
    sch.setWireColors(entries)
  })

  const clearWireColors = useEvent(() => sch.setWireColors(sch.doc.wires.map((w) => [w.id, undefined] as const)))

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
      marquee.start(e)
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
    marquee.move(e)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (endPan(e)) return
    const rect = marquee.end(e)
    onSelectionChange?.(rect)
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
  // Monaco types through an EditContext on a plain div, so the code panel counts as a text field too.
  const inTextField = (e: Event) => {
    const t = e.target as HTMLElement | null
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || !!t.closest?.('[data-slot="code-panel"]'))
  }
  const onKey = useEvent((e: KeyboardEvent) => {
    if (inTextField(e)) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (e.key === "Delete" || e.key === "Backspace") {
      sch.removeSelected()
    } else if (e.key === "Escape") {
      if (measure.active) measure.stop()
      sch.deselectAll()
      setPending(null)
      setHoveredWire(null)
    } else if (!mod && !e.altKey && WIRE_COLOR_BY_CODE.has(e.code) && (pending || sch.selectedWires.size > 0)) {
      const color = WIRE_COLOR_BY_CODE.get(e.code)
      e.preventDefault()
      if (!color) return
      if (pending) setPending({ ...pending, color, chosen: true })
      else paintSelected(color, e.shiftKey)
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
    } else if (mod && key === "j") {
      e.preventDefault()
      setCodeOpen((o) => !o)
    } else if (!mod && !e.altKey && key === "m") {
      measure.toggle()
    } else if (!mod && !e.altKey && key === "o") {
      setScopeOpen((o) => !o)
    } else if (!mod && !e.altKey && key === "l") {
      setLogicOpen((o) => !o)
    } else if (!mod && !e.altKey && key === "r") {
      if (sch.selectedObjects.size) sch.rotate(sch.selectedObjects, e.shiftKey ? -45 : 45)
    }
  })
  // Cut/copy/paste ride the native events so the system clipboard sees them too.
  const onCopy = useEvent((e: ClipboardEvent) => {
    if (inTextField(e) || !sch.selectedObjects.size) return
    e.preventDefault()
    copy()
  })
  const onCut = useEvent((e: ClipboardEvent) => {
    if (inTextField(e) || !sch.selectedObjects.size) return
    e.preventDefault()
    cut()
  })
  const onPaste = useEvent((e: ClipboardEvent) => {
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
  })
  React.useEffect(() => {
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
  }, [onKey, onCopy, onCut, onPaste])

  const cursor = panning ? "cursor-grabbing" : spaceHeld ? "cursor-grab" : "cursor-crosshair"
  const probeReading = sim.probe(PROBE_ID)
  const { selectedObjects, selectedWires, doc: schDoc, setPart } = sch
  const selectedObjectList = React.useMemo(
    () => docObjects.filter((o) => selectedObjects.has(o.id)),
    [docObjects, selectedObjects],
  )
  const selectedWireList = React.useMemo(
    () => [...selectedWires].map((id) => wireById.get(id)).filter((w) => w !== undefined),
    [selectedWires, wireById],
  )
  const activeColors = React.useMemo(() => new Set(selectedWireList.flatMap((w) => (w.color ? [w.color] : []))), [selectedWireList])
  const anyOverridden = selectedWireList.some((w) => w.color !== undefined)
  const anyWireColored = React.useMemo(() => docWires.some((w) => w.color !== undefined), [docWires])
  const objectViews = React.useMemo(
    () =>
      visibleObjects.map((o) => (
        <div key={o.id} data-body={o.id} className="absolute top-0 left-0">
          <ComponentView
            object={o}
            grid={grid}
            detail={detail}
            selected={selectedObjects.has(o.id)}
            parts={schDoc.parts}
            sim={simStore}
            onBodyPointerDown={onBodyPointerDown}
            onBodyPointerMove={onBodyPointerMove}
            onBodyPointerUp={onBodyPointerUp}
            onBodyContextMenu={onBodyContextMenu}
            onPartChange={setPart}
          />
        </div>
      )),
    [visibleObjects, grid, detail, selectedObjects, schDoc.parts, simStore, onBodyPointerDown, onBodyPointerMove, onBodyPointerUp, onBodyContextMenu, setPart],
  )
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
    <div className="flex h-full w-full overflow-hidden">
    <ContextMenu>
      <ContextMenuTrigger data-slot="dot-field" className={cn("flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background", className)} {...props}>
        <div data-slot="dot-field-stage" className="relative min-h-0 flex-1 overflow-hidden">
          <div
            ref={containerRef}
            data-slot="dot-field-viewport"
            className={cn("absolute inset-0 touch-none select-none", cursor)}
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
              ref={contentRef}
              data-slot="dot-field-content"
              className="absolute top-0 left-0 origin-top-left"
            >
              {children}
              {objectViews}
              <WireLayer
                routes={visibleRoutes}
                grid={grid}
                scale={scale}
                selected={sch.selectedWires}
                hoveredNet={hoveredNet}
                colorOf={colorOf}
                netOfWire={nets.netOfWire}
                bendsOf={bendsOf}
                flow={flow}
                onWirePointerDown={onWirePointerDown}
                onWirePointerEnter={onWirePointerEnter}
                onWirePointerLeave={onWirePointerLeave}
                onInsertBend={onInsertBend}
                onRemoveBend={onRemoveBend}
                onBendPointerDown={onBendPointerDown}
                onBendPointerMove={onBendPointerMove}
                onBendPointerUp={onBendPointerUp}
              />
              {/* Above the wires: a pin on a wire has to stay visible and clickable. */}
              <PinLayer
                objects={visibleObjects}
                grid={grid}
                detail={detail}
                connectedPins={connectedPins}
                contactPins={contactPins}
                netColor={pinNetColor}
                onPinPointerDown={onPinPointerDown}
                onPinPointerMove={onPinPointerMove}
                onPinPointerUp={onPinPointerUp}
              />
              <PendingWireLayer objects={docObjects} index={index} pending={pending} grid={grid} scale={scale} />
              <MeasureLayer tips={tips} held={heldTips} grid={grid} />
              <div
                ref={marqueeRef}
                data-slot="dot-field-selection"
                className="pointer-events-none absolute top-0 left-0 border border-primary bg-primary/10"
                style={{ display: "none" }}
              />
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
          {selectedWireList.length > 0 && selectedObjectList.length === 0 && (
            <WirePalette
              className="absolute top-3 right-3"
              active={activeColors}
              overridden={anyOverridden}
              onPick={paintSelected}
              onPointerDown={(e) => e.stopPropagation()}
            />
          )}
          <Inspector
            className="absolute top-3 right-3"
            selected={selectedObjectList}
            damage={sim.damage}
            sim={sim}
            onChange={sch.setProps}
            onSerial={sendSerial}
            onCode={(id) => {
              setCodeBoardId(id)
              setCodeOpen(true)
            }}
            onRotate={(d) => sch.rotate(sch.selectedObjects, d)}
            onDelete={sch.removeSelected}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <ScaleBar className="absolute right-4 bottom-14" scale={scale} grid={grid} />
          <ZoomControls className="absolute right-4 bottom-4" scale={scale} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={reset} />
          {hover && <FieldReadout target={hover.target} x={hover.x} y={hover.y} objects={sch.doc.objects} wires={sch.doc.wires} sim={sim} />}
        </div>
        {scopeOpen && (
          <Scope
            className="shrink-0 border-t"
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
        <ContextMenuItem disabled={!selectedBoard} onClick={() => setCodeOpen(true)}>
          Source code
          <ContextMenuShortcut>⌘J</ContextMenuShortcut>
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
        <ContextMenuItem disabled={sch.doc.wires.length === 0} onClick={autoColorAllNets}>
          Colour every net
        </ContextMenuItem>
        <ContextMenuItem disabled={!anyWireColored} onClick={clearWireColors}>
          Reset wire colours
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
            marquee.clear()
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
      {codeOpen && (
        <React.Suspense fallback={<div className="w-160 shrink-0 border-l bg-background" />}>
          <CodePanel ref={codeEditor} board={codeBoard} boards={boards} onPick={(id) => sch.selectObject(id)} onFiles={sch.setProject} onFirmware={onFirmware} onClose={() => setCodeOpen(false)} />
        </React.Suspense>
      )}
    </div>
  )
}
