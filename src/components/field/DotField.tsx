import * as React from "react"
import { flushSync } from "react-dom"
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
import { GRID as FIELD_GRID, objectPins, objectRect, resolvePin, routeBox, snap, touches, unionOf, type FlipAxis, type Point, type Turn } from "@/schematic/geometry"
import { SpatialIndex } from "@/schematic/spatial"
import { fieldDetail } from "./detail"
import { savedTextScale, saveTextScale } from "./text-scale"
import { autoNetColor, semanticNetColor, wireColorVar, AUTO_COLOR_ORDER, DEFAULT_SIGNAL_COLOR, WIRE_COLOR_BY_CODE, type WireColorKey } from "@/schematic/wire-colors"
import { partKey, pinKey, type PinRef, type PlacedObject, type Schematic } from "@/schematic/types"
import { getDef, notifyLibrary, partInitial, pinName, setLibrary } from "@/schematic/registry"
import { newModuleId, TEMPLATES } from "@/schematic/hdl"
import type { HdlLanguage } from "emul-shared/hdl"
import { languageOf } from "emul-shared/hdl"
import type { SourceFile } from "emul-shared/source"
import { bytesToBase64 } from "@/lib/bytes"
import { useEvent } from "@/hooks/use-event"
import { clipboardText, clipFromClipboard, pasteLanding, useSchematic, type Clip } from "@/schematic/use-schematic"
import { nearestOn, travellingWires } from "@/schematic/wire-edits"
import { CONTACT_OPENED, DRAG_REFUSED, PartDrag, SegmentDrag, TURN_REFUSED, UNLAID, WIRES_REFUSED, type Landed } from "@/schematic/rubber-band"
import { DRAW_REFUSED, PASTE_REFUSED, laysClear, drawEndAt, flipPosture, isRefusal, pointerAt, previewOf, startDrawing, withCorner, withoutCorner, type DrawEnd, type Drawing, type DrawRefusal } from "@/schematic/wire-draw"
import { NO_CROSSING } from "@/schematic/junction-tool"
import { changeMessage, netChanges } from "@/schematic/net-names"
import { chainOf, segmentNearest } from "@/schematic/wire-select"
import type { DragFrame } from "@/schematic/wires/drag"
import { samePoint } from "@/schematic/wires/segment"
import { announceUpgrade } from "@/hooks/use-projects"
import { contactCheck, designatorRects, freeSpot, landingOffset, placementCheck, type PlacementScene } from "@/schematic/placement"
import { toast } from "sonner"
import { DT } from "@/sim/speeds"
import { useSimulation } from "@/sim/use-simulation"
import { boardFromObject, DebugController } from "@/debug/session"
import type { BuildRecord } from "@/debug/sources"
import { Scope, type ScopeMode } from "@/components/scope/Scope"
import { SCOPE_COLUMNS, TIMEBASES } from "@/components/scope/timebase"
import { TraceStore } from "@/components/scope/trace-store"
import { LogicAnalyser } from "@/components/logic/LogicAnalyser"
import { LOGIC_SPANS, DEFAULT_DECODER, type DecoderConfig } from "@/components/logic/decoder-config"
import { LogicStore } from "@/components/logic/logic-store"
import type { EditorHandle } from "@/components/code/Editor"
import { PanelLoading } from "@/components/code/PanelLoading"
import { Button } from "@/components/ui/button"

/** Monaco is a few megabytes; it loads the first time the code panel opens, not with the page. */
const CodePanel = React.lazy(() => import("@/components/code/CodePanel").then((m) => ({ default: m.CodePanel })))
const HdlPanel = React.lazy(() => import("@/components/hdl/HdlPanel").then((m) => ({ default: m.HdlPanel })))
import { ComponentView } from "./ComponentView"
import { SelectionLayer } from "./SelectionLayer"
import { MeasureLayer } from "./MeasureLayer"
import { PinLayer } from "./PinLayer"
import { FieldReadout, type RunEnds, ProbeReadout, type HoverTarget } from "./Readout"
import { ScaleBar } from "./ScaleBar"
import { SimControls } from "./SimControls"
import { FieldCanvas } from "./FieldCanvas"
import { marksBesideTheBand, wireMarks } from "./wire-marks"
import { dotRadius, OPEN_END_CELLS, WIRE_HIT_PX } from "./wire-style"
import { exportPng } from "./export-image"
import { useThemeName } from "./field-palette"
import { TextCanvas } from "./TextCanvas"
import { labelArea, labelCanvasFits, SymbolRaster, TextRaster } from "./symbol-raster"
import { PendingWireLayer, WireLayer, type PendingLook } from "./WireLayer"
import { RubberBandLayer, type RubberLook } from "./rubber-band-layer"
import { GhostLayer, type Ghost } from "./GhostLayer"
import { MoveDrag, planMove } from "./move-drag"
import { ContactPreview } from "./contact-preview"
import { contactsAfterMove } from "@/schematic/contacts"
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
  merge: (doc: Schematic) => void
  /** The document as it stands, for saving. */
  doc: () => Schematic
  exportPng: () => Promise<Blob | null>
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
  rotate: (turn: Turn) => void
  flip: (axis: FlipAxis) => void
  zoomIn: () => void
  zoomOut: () => void
  resetView: () => void
  toggleRun: () => void
  restart: () => void
  setSpeed: (speed: number) => void
  setTextScale: (scale: number) => void
  toggleProbe: () => void
  toggleScope: () => void
  toggleLogic: () => void
  toggleCode: () => void
  /** Show the code of the board with this designator. */
  openCode: (ref: string) => void
  newHdl: (language: HdlLanguage) => void
  importHdl: (files: SourceFile[]) => void
  openHdl: (id: string) => void
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
  textScale: number
  probing: boolean
  scope: boolean
  logic: boolean
  code: boolean
}

type DotFieldProps = Omit<React.ComponentProps<typeof ContextMenuTrigger>, "ref" | "onChange"> & {
  ref?: React.Ref<DotFieldHandle>
  grid?: number
  onSelectionChange?: (rect: Rect | null) => void
  /** Called whenever the schematic document changes. */
  onChange?: (doc: Schematic) => void
  /** Called whenever something the menu shows changes. */
  onStateChange?: (state: FieldState) => void
  onPointerWorld?: (point: Point | null) => void
  onMovePreview?: (move: { ids: string[]; dx: number; dy: number } | null) => void
  onWirePreview?: (points: Point[] | null) => void
  ghosts?: readonly Ghost[]
  projectName?: string
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
/** How far a finger may wander and still have tapped, px. */
const TAP_SLOP = 8

const CLEAR_OF_CONTROLS_PX = 80

const PINS_WORTH_RASTERISING = 1200
const PINS_WORTH_KEEPING_RASTERISED = 800

function targetAt(clientX: number, clientY: number): HoverTarget | null {
  const el = document.elementFromPoint(clientX, clientY)
  if (!el) return null
  const pinEl = el.closest<SVGElement>("[data-pin]")
  const objEl = pinEl?.closest<SVGElement>("[data-object]")
  if (pinEl && objEl) return { kind: "pin", ref: { object: objEl.dataset.object!, pin: pinEl.dataset.pin! } }
  const wire = el.closest<SVGElement>("[data-wire]")?.dataset.wire
  return wire ? { kind: "wire", id: wire } : null
}

const keyRef = (key: string): PinRef => ({ object: key.slice(0, key.indexOf(":")), pin: key.slice(key.indexOf(":") + 1) })

type Pending = { d: Drawing; mode: "drag" | "click"; target: DrawEnd | null; moved: boolean }

const FLASH_MS = 1400

export function DotField({ ref, className, grid = GRID, onSelectionChange, onChange, onStateChange, onPointerWorld, onMovePreview, onWirePreview, ghosts, projectName, children, ...props }: DotFieldProps) {
  const { containerRef, contentRef, overlayRef, scale, view, worldPerPixel, panning, spaceHeld, zoomIn, zoomOut, reset, fitTo, reveal, toWorld, isPanStart, startPan, movePan, endPan, setOnPinchStart } = useViewport(grid)
  const marquee = useSelection(toWorld, worldPerPixel, grid)
  const { boxRef: marqueeRef } = marquee
  const sch = useSchematic(grid)
  setLibrary(sch.doc.library)
  React.useEffect(() => notifyLibrary(), [sch.doc.library])
  const [hdlId, setHdlId] = React.useState<string | null>(null)
  const hdlOpen = sch.doc.library?.find((m) => m.id === hdlId) ?? null
  const measure = useMeasure()
  const [simRunning, setSimRunning] = React.useState(false)
  const onFailure = React.useCallback(
    (f: { ref: string; damage: { reason: string } }) => toast.error(`${f.ref} burnt out`, { description: f.damage.reason }),
    [],
  )
  // Simulated seconds per real second; 1 is real time.
  const [speed, setSpeed] = React.useState(1)
  const [textScale, setTextScale] = React.useState(savedTextScale)
  React.useEffect(() => void saveTextScale(textScale), [textScale])

  // --- oscilloscope -----------------------------------------------------------
  const [scopeOpen, setScopeOpen] = React.useState(false)
  const [scopeWindow, setScopeWindow] = React.useState<number>(TIMEBASES[4])
  const [scopeMode, setScopeMode] = React.useState<ScopeMode>("sweep")
  const [trace] = React.useState(() => new TraceStore())
  const [traceVersion, setTraceVersion] = React.useState(0)
  const onTrace = React.useCallback<NonNullable<Parameters<typeof useSimulation>[3]>["onTrace"] & object>(
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
  const onLogic = React.useCallback<NonNullable<Parameters<typeof useSimulation>[3]>["onLogic"] & object>(
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
  // An image goes onto the board with what it was built from, which the debugger reads (nothing
  // for one from elsewhere, whose sources the debugger then asks for).
  const onFirmware = useEvent((id: string, name: string, bytes: Uint8Array, build?: BuildRecord) => {
    const obj = sch.doc.objects.find((o) => o.id === id)
    const def = obj && getDef(obj.def)
    const boot = def?.mcuProgramBoot
    if (def && boot && !(sch.doc.parts[partKey(id, boot)] ?? partInitial(def, boot)).on) {
      toast.error(`${obj.props?.ref || getDef(obj.def)?.name} not programmed`, {
        description: "Flashing goes through the ST bootloader. Set BOOT to SYSTEM and compile again.",
      })
      return false
    }
    sch.setProps(id, { firmware: name, firmwareData: bytesToBase64(bytes), firmwareBuild: build ? JSON.stringify(build) : "" })
    return true
  })

  // --- the debugger ----------------------------------------------------------------
  // One controller for the bench: it reaches the cores through the simulation worker (set
  // below, once the hook has made it) and drives Run/Pause and the code panel.
  const [debug] = React.useState(
    () =>
      new DebugController({
        setRunning: (running) => setSimRunning(running),
        reveal: (object) => {
          setCodeBoardId(object)
          setCodeOpen(true)
        },
      }),
  )
  React.useEffect(() => debug.sync(boards.map((o) => boardFromObject(o, getDef(o.def)?.chip ?? ""))), [debug, boards])
  React.useEffect(() => debug.onRunning(simRunning), [debug, simRunning])

  const { objects: docObjects, wires: docWires } = sch.doc
  const { wiring } = sch
  const nets = wiring.nets
  const { sim, simStore, restart, started, sendSerial, debug: debugApi } = useSimulation(sch.doc, wiring.circuit, simRunning, {
    speed,
    probes: measure.probes,
    onFailure,
    traceBucket,
    onTrace,
    logic: logicOpen,
    onLogic,
    onDebugStop: (stops) => debug.onStop(stops),
    onRunning: setSimRunning,
  })
  React.useLayoutEffect(() => debug.attach(debugApi), [debug, debugApi])
  const index = React.useMemo(() => new SpatialIndex(docObjects, grid), [docObjects, grid])
  const routes = wiring.routes
  const wireById = React.useMemo(() => new Map(docWires.map((w) => [w.id, w])), [docWires])
  const runById = React.useMemo(() => new Map(wiring.runs.map((r) => [r.id, r])), [wiring.runs])
  const selectedRuns = React.useMemo(() => {
    const ids = new Set<string>()
    for (const id of sch.selectedWires) {
      const run = wiring.runBySegment.get(id)
      if (run) ids.add(run.id)
    }
    return ids
  }, [sch.selectedWires, wiring.runBySegment])

  const visibleObjects = React.useMemo(() => (view.w > 0 ? index.query(view) : docObjects), [index, view, docObjects])
  const visibleRoutes = React.useMemo(() => (view.w > 0 ? routes.filter((r) => touches(routeBox(r), view)) : routes), [routes, view])
  const detail = React.useMemo(() => fieldDetail(grid, scale, visibleObjects.length, textScale), [grid, scale, visibleObjects, textScale])
  const sheetText = React.useMemo(() => ({ boost: detail.textBoost, pinSize: detail.pinLabelSize }), [detail.textBoost, detail.pinLabelSize])

  const dragLayerRef = React.useRef<HTMLDivElement>(null)
  const [lifted, setLifted] = React.useState<ReadonlySet<string>>(() => new Set())
  const [banded, setBanded] = React.useState<ReadonlySet<string>>(() => new Set())
  const liftedObjects = React.useMemo(() => (lifted.size ? visibleObjects.filter((o) => lifted.has(o.id)) : []), [visibleObjects, lifted])
  const staticObjects = React.useMemo(() => (lifted.size ? visibleObjects.filter((o) => !lifted.has(o.id)) : visibleObjects), [visibleObjects, lifted])
  const liftedWires = React.useMemo(() => {
    if (!lifted.size) return new Set<string>()
    const ids = new Set<string>()
    for (const id of travellingWires(sch.doc, lifted, wiring)) {
      const run = wiring.runBySegment.get(id)
      if (run) ids.add(run.id)
    }
    return ids
  }, [sch.doc, wiring, lifted])
  const liftedRoutes = React.useMemo(() => (liftedWires.size ? visibleRoutes.filter((r) => liftedWires.has(r.id)) : []), [visibleRoutes, liftedWires])
  const bandRuns = React.useMemo(() => {
    const ids = new Set<string>()
    for (const id of banded) {
      const run = wiring.runBySegment.get(id)
      if (run) ids.add(run.id)
    }
    return ids
  }, [banded, wiring])
  const staticRoutes = React.useMemo(() => (liftedWires.size || bandRuns.size ? visibleRoutes.filter((r) => !liftedWires.has(r.id) && !bandRuns.has(r.id)) : visibleRoutes), [visibleRoutes, liftedWires, bandRuns])

  const [textRaster] = React.useState(() => new TextRaster())
  const [symbolRaster] = React.useState(() => new SymbolRaster())
  const visiblePins = React.useMemo(() => visibleObjects.reduce((sum, o) => sum + (getDef(o.def)?.pins.length ?? 0), 0), [visibleObjects])
  const [rasterising, setRasterising] = React.useState(false)
  const worthIt = detail.labels && visiblePins >= (rasterising ? PINS_WORTH_KEEPING_RASTERISED : PINS_WORTH_RASTERISING)
  if (worthIt !== rasterising) setRasterising(worthIt)
  const labelsOnCanvas = worthIt && labelCanvasFits(view, scale)
  const sheeted = React.useCallback(
    (object: PlacedObject) =>
      nets.contacts.size === 0 || !objectPins(object, grid).some((p) => nets.contacts.has(p.key)),
    [nets.contacts, grid],
  )
  const onSheet = React.useMemo(() => (labelsOnCanvas ? sheeted : undefined), [labelsOnCanvas, sheeted])
  const labelledObjects = React.useMemo(
    () => (labelsOnCanvas ? staticObjects.filter(sheeted) : []),
    [labelsOnCanvas, staticObjects, sheeted],
  )
  const liftedLabels = React.useMemo(
    () => (labelsOnCanvas ? liftedObjects.filter(sheeted) : []),
    [labelsOnCanvas, liftedObjects, sheeted],
  )
  const liftedArea = React.useMemo(() => labelArea(liftedLabels, grid), [liftedLabels, grid])
  const autoColor = React.useMemo(() => {
    const m = new Map<string, WireColorKey>()
    for (const net of nets.nets) m.set(net, autoNetColor(nets.kindsOf(net)))
    return m
  }, [nets])
  const colorOf = React.useCallback(
    (runId: string): WireColorKey => {
      const chosen = runById.get(runId)?.segments[0].color
      if (chosen) return chosen
      const net = nets.netOfWire(runId)
      return (net === undefined ? undefined : autoColor.get(net)) ?? DEFAULT_SIGNAL_COLOR
    },
    [runById, nets, autoColor],
  )
  const bandPoints = React.useMemo(() => {
    const points = new Set<string>()
    for (const id of bandRuns) for (const p of runById.get(id)?.points ?? []) points.add(`${p.x},${p.y}`)
    return points
  }, [bandRuns, runById])
  const staticMarks = React.useMemo(() => marksBesideTheBand(wireMarks(staticRoutes, wiring.dots, wiring.dangling, wiring.corners, colorOf, true), bandPoints), [staticRoutes, wiring.dots, wiring.dangling, wiring.corners, colorOf, bandPoints])
  const liftedMarks = React.useMemo(() => wireMarks(liftedRoutes, wiring.dots, wiring.dangling, wiring.corners, colorOf, false), [liftedRoutes, wiring.dots, wiring.dangling, wiring.corners, colorOf])
  const pinNetColor = React.useCallback(
    (key: string) => {
      const net = nets.netOfPin(key)
      const wire = net && nets.wiresOf(net)[0]
      return wire ? wireColorVar(colorOf(wire)) : undefined
    },
    [nets, colorOf],
  )
  const [hoveredWire, setHoveredWire] = React.useState<string | null>(null)
  const [lit, setLit] = React.useState<ReadonlySet<string>>(EMPTY_IDS)
  const [flash, setFlash] = React.useState<ReadonlySet<string>>(EMPTY_IDS)
  const pointerAtClient = React.useRef<{ x: number; y: number } | null>(null)
  const { takePastedNets } = sch
  const seenNets = React.useRef(wiring.circuit.nets)
  const seenEdits = React.useRef(sch.edits)
  React.useEffect(() => {
    const before = [...seenNets.current, ...takePastedNets()]
    seenNets.current = wiring.circuit.nets
    if (seenEdits.current === sch.edits) return
    seenEdits.current = sch.edits
    const change = netChanges(before, wiring.circuit.nets)
    const message = changeMessage(sch.doc.objects, change)
    if (!message) return
    toast.info(message)
    const flashing = new Set<string>()
    for (const j of change.joined) flashing.add(nets.netOfPin(j.into[0]) ?? "")
    for (const s of change.split) for (const g of s.into) flashing.add(nets.netOfPin(g[0]) ?? "")
    setFlash(flashing)
    const timer = setTimeout(() => setFlash(EMPTY_IDS), FLASH_MS)
    return () => clearTimeout(timer)
  }, [wiring, sch.edits, sch.doc.objects, nets, takePastedNets])
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
  const scene = useEvent((): PlacementScene => ({ objects: docObjects, routes, grid }))
  const revealPlaced = (objects: readonly PlacedObject[], dx: number, dy: number) => {
    const landed = objects.map((o) => ({ ...o, x: o.x + dx, y: o.y + dy }))
    if (landed.length) reveal(unionOf(landed.flatMap((o) => [objectRect(o, grid), ...designatorRects(o, grid)])), CLEAR_OF_CONTROLS_PX)
  }
  const pasteFree = useEvent((saved: Clip, dx: number, dy: number) => {
    const shifted = (clip: Clip, at: Point) => clip.wires.map((s) => ({ a: { x: s.a.x + at.x, y: s.a.y + at.y }, b: { x: s.b.x + at.x, y: s.b.y + at.y } }))
    const { clip: c, at, clear } = pasteLanding(scene(), saved, { x: dx, y: dy }, (clip, at) => laysClear(wiring, shifted(clip, at)))
    if (!clear) {
      toast.error(PASTE_REFUSED.title, { description: PASTE_REFUSED.why })
      return
    }
    pasteClip(c, at.x, at.y)
    revealPlaced(c.objects, snap(at.x, grid), snap(at.y, grid))
  })
  const addFree = useEvent((defId: string, center: Point) => {
    const def = getDef(defId)
    if (!def) return sch.add(defId, center)
    const probe: PlacedObject = { id: "placing", def: defId, x: snap(center.x - (def.width * grid) / 2, grid), y: snap(center.y - (def.height * grid) / 2, grid) }
    const at = freeSpot(scene(), [probe])
    const added = sch.add(defId, { x: center.x + at.x, y: center.y + at.y })
    if (added) revealPlaced([added], 0, 0)
    return added
  })
  const copy = React.useCallback(() => {
    const c = copySelected()
    if (!c) return
    setClip(c)
    pasted.current = 0
    navigator.clipboard?.writeText(clipboardText(c)).catch(() => {})
  }, [copySelected])
  const paste = React.useCallback(
    (c: Clip | null = clip) => {
      if (!c) return
      pasted.current += 1
      pasteFree(c, pasted.current * grid, pasted.current * grid)
    },
    [clip, pasteFree, grid],
  )
  const duplicate = React.useCallback(() => {
    const c = copySelected()
    if (c) pasteFree(c, grid, grid)
  }, [copySelected, pasteFree, grid])
  const cut = React.useCallback(() => {
    copy()
    sch.removeSelected()
  }, [copy, sch])

  const initialDoc = React.useRef(sch.doc)
  React.useEffect(() => {
    if (sch.doc !== initialDoc.current) onChange?.(sch.doc)
  }, [sch.doc, onChange])
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
        textScale,
        probing: measure.active,
        scope: scopeOpen,
        logic: logicOpen,
        code: codeOpen,
      }),
    [onStateChange, hasSelection, hasObjects, isEmpty, sch.canUndo, sch.canRedo, clip, simRunning, started, speed, textScale, measure.active, scopeOpen, logicOpen, codeOpen],
  )

  /** World point under the last right-click, used by the "Add" submenu. */
  const menuPoint = React.useRef<Point>({ x: 0, y: 0 })

  const viewCenter = React.useCallback((): Point => {
    const el = containerRef.current
    const r = el?.getBoundingClientRect()
    return toWorld((r?.left ?? 0) + (el?.clientWidth ?? 0) / 2, (r?.top ?? 0) + (el?.clientHeight ?? 0) / 2)
  }, [containerRef, toWorld])

  const theme = useThemeName()
  const exportImage = useEvent(async () => {
    const host = containerRef.current
    if (!host) return null
    return exportPng({ host, theme, objects: docObjects, routes, grid, colorOf, symbols: symbolRaster, texts: textRaster, textScale, marks: wireMarks(routes, wiring.dots, wiring.dangling, wiring.corners, colorOf, true) })
  })

  const [unlaid, setUnlaid] = React.useState<{ at: readonly Point[]; edits: number } | null>(null)
  const reportLanding = useEvent((landed: Landed, gesture: "drop" | "turn" = "drop") => {
    if (landed.refused) {
      const text = landed.refused.length ? (gesture === "turn" ? TURN_REFUSED : DRAG_REFUSED) : WIRES_REFUSED
      toast.error(text.title, { description: text.why })
    }
    if (!landed.unlaid.length) return
    for (const kept of [true, false]) {
      const some = landed.unlaid.filter((u) => u.kept === kept)
      if (!some.length) continue
      const names = some.map((u) => (u.pin ? pinName(landed.doc.objects, keyRef(u.pin)) : "a wire"))
      const text = kept ? UNLAID : CONTACT_OPENED
      toast.warning(`${names.join(", ")}: ${text.title}`, { description: text.why })
    }
    setUnlaid({ at: landed.unlaid.map((u) => u.at), edits: sch.edits + 1 })
  })

  const turn = useEvent((direction: Turn, alone = false) => {
    if (alone) {
      sch.rotateAlone(sch.selectedObjects, direction)
      return
    }
    const landed = sch.rotate(sch.selectedObjects, direction, index, sch.selectedWires)
    if (landed) reportLanding(landed, "turn")
  })
  const mirror = useEvent((axis: FlipAxis, alone = false) => {
    if (alone) {
      sch.flipAlone(sch.selectedObjects, axis)
      return
    }
    const landed = sch.flip(sch.selectedObjects, axis, index, sch.selectedWires)
    if (landed) reportLanding(landed, "turn")
  })
  const { load } = sch
  React.useImperativeHandle(
    ref,
    () => ({
      addAtCenter: (defId) => addFree(defId, viewCenter()),
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
      merge: sch.replace,
      doc: () => sch.doc,
      exportPng: exportImage,
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
      rotate: (direction) => turn(direction),
      flip: (axis) => mirror(axis),
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
      setTextScale,
      toggleProbe: measure.toggle,
      toggleScope: () => setScopeOpen((o) => !o),
      toggleLogic: () => setLogicOpen((o) => !o),
      toggleCode: () => setCodeOpen((o) => !o),
      openCode: (ref) => {
        const board = sch.doc.objects.find((o) => o.props?.ref === ref)
        if (board) setCodeBoardId(board.id)
        setCodeOpen(true)
      },
      newHdl: (language) => {
        const taken = new Set((sch.doc.library ?? []).map((m) => m.name))
        let n = 1
        while (taken.has(`${language === "vhdl" ? "counter" : "counter_v"}${n > 1 ? n : ""}`)) n++
        const name = `${language === "vhdl" ? "counter" : "counter_v"}${n > 1 ? n : ""}`
        const id = newModuleId()
        sch.setModule({ id, name, files: [TEMPLATES[language](name)] })
        setHdlId(id)
      },
      importHdl: (files) => {
        const hdl = files.filter((f) => languageOf(f.path))
        if (!hdl.length) return
        const id = newModuleId()
        const name = hdl[0]!.path.replace(/^.*\//, "").replace(/\.[^.]+$/, "")
        sch.setModule({ id, name, files: hdl })
        setHdlId(id)
      },
      openHdl: (id) => setHdlId(id),
    }),
    [addFree, load, viewCenter, fitTo, grid, sch, undo, redo, cut, copy, paste, duplicate, zoomIn, zoomOut, reset, restart, trace, logic, measure.toggle, exportImage, turn, mirror],
  )

  // --- moving objects -------------------------------------------------------
  const [drag] = React.useState(() => new MoveDrag())
  React.useEffect(() => () => void drag.clearAndFinish(), [drag])

  const liftedRunsOf = (moving: ReadonlySet<string>) => {
    const ids = new Set<string>()
    for (const id of travellingWires(sch.doc, moving, wiring)) {
      const run = wiring.runBySegment.get(id)
      if (run) ids.add(run.id)
    }
    return ids
  }
  const bandDotRadius = useEvent(() => dotRadius(grid, scale))
  const bandPixel = useEvent(() => 1 / scale)
  const rubberLook = useEvent((): RubberLook => ({
    runOf: (segment) => wiring.runBySegment.get(segment),
    colorOfRun: colorOf,
    colorOfNet: (net) => {
      const run = nets.wiresOf(net)[0]
      return run ? colorOf(run) : DEFAULT_SIGNAL_COLOR
    },
    sheet: wiring.sheet,
    ringRadius: OPEN_END_CELLS * grid,
    dotRadius: bandDotRadius,
    pixel: bandPixel,
  }))
  const dragging = React.useRef<{ kind: "parts"; drag: PartDrag; base: Schematic; detach: boolean; bodies: (dx: number, dy: number) => boolean } | { kind: "segment"; drag: SegmentDrag; base: Schematic } | null>(null)
  const litBy = React.useRef("")
  const lightJoins = useEvent((joins: readonly (readonly [string, string])[]) => {
    const key = joins.map((j) => j.join("+")).join(" ")
    if (key === litBy.current) return
    litBy.current = key
    setLit(joins.length ? new Set(joins.flat()) : EMPTY_IDS)
  })
  const rubberNow = React.useRef<RubberBandLayer | null>(null)
  const rubberFor = (content: ParentNode, frameAt: (dx: number, dy: number) => DragFrame, always: ReadonlySet<string> = EMPTY_IDS) => {
    const layer = new RubberBandLayer(content, rubberLook(), always)
    rubberNow.current = layer
    const still = frameAt(0, 0)
    return {
      show: (dx: number, dy: number) => {
        const frame = frameAt(dx, dy)
        layer.show(frame)
        lightJoins(frame.joins)
      },
      clear: () => {
        if (always.size) layer.show(still)
        else layer.clear()
        lightJoins([])
      },
    }
  }
  const endRubber = () => {
    rubberNow.current?.clear()
    rubberNow.current = null
  }
  const beginMove = useEvent((e: React.PointerEvent, id: string, toggle: boolean) => {
    flushSync(() => sch.selectObject(id, toggle))
    marquee.clear()
    if (toggle) return
    const content = contentRef.current
    if (!content) return
    const moving = sch.selectedObjects.has(id) ? sch.selectedObjects : new Set([id])
    if (detail.canvas || labelsOnCanvas) setLifted(moving)
    const pinsDrawn = detail.pins && !detail.canvas
    const detach = e.altKey
    const partDrag = new PartDrag(sch.doc, wiring, { objects: moving }, { detach, index })
    const bodies = placementCheck(scene(), docObjects.filter((o) => moving.has(o.id)))
    dragging.current = { kind: "parts", drag: partDrag, base: sch.doc, detach, bodies }
    const band = detail.canvas && !detach ? partDrag.touched : EMPTY_IDS
    if (band.size) setBanded(band)
    drag.begin({
      ...planMove(content, docObjects, !detach && moving.size === docObjects.length ? liftedRunsOf(moving) : EMPTY_IDS, moving, toWorld(e.clientX, e.clientY), grid, {
        element: detail.canvas || labelsOnCanvas ? dragLayerRef.current : null,
        whole: detail.canvas,
      }),
      blocked: (dx, dy) => bodies(dx, dy) || partDrag.blocked(dx, dy),
      contacts: pinsDrawn ? new ContactPreview(content, contactsAfterMove(docObjects, moving, grid, (area) => index.query(area)), { grid, wired: (key: string) => nets.connected(key), netColor: pinNetColor }) : undefined,
      rubber: detach ? undefined : rubberFor(content, (dx, dy) => partDrag.frame(dx, dy), band),
    })
  })

  const beginSegmentDrag = useEvent((e: React.PointerEvent, segment: string) => {
    const content = contentRef.current
    if (!content) return
    const segmentDrag = new SegmentDrag(sch.doc, wiring, segment, index)
    dragging.current = { kind: "segment", drag: segmentDrag, base: sch.doc }
    const band = detail.canvas ? segmentDrag.touched : EMPTY_IDS
    if (band.size) setBanded(band)
    drag.begin({
      ...planMove(content, docObjects, EMPTY_IDS, EMPTY_IDS, toWorld(e.clientX, e.clientY), grid),
      rubber: rubberFor(content, (dx, dy) => segmentDrag.frame(dx, dy), band),
    })
  })

  const trackMove = useEvent((at: Point) => {
    drag.track(at)
    const move = drag.preview()
    if (move) onMovePreview?.(move)
  })

  const abandonDrag = useEvent(() => {
    if (!dragging.current) return
    dragging.current = null
    drag.clearAndFinish()
    endRubber()
    onMovePreview?.(null)
    if (lifted.size) setLifted(EMPTY_IDS)
    if (banded.size) setBanded(EMPTY_IDS)
  })
  React.useLayoutEffect(() => {
    if (dragging.current && dragging.current.base !== sch.doc) abandonDrag()
  }, [sch.doc, abandonDrag])

  const endMove = useEvent(() => {
    onMovePreview?.(null)
    if (lifted.size) setLifted(EMPTY_IDS)
    if (banded.size) setBanded(EMPTY_IDS)
    const done = drag.clearAndFinish()
    endRubber()
    const kind = dragging.current
    dragging.current = null
    if (!done || (!done.dx && !done.dy)) return
    if (kind?.kind === "segment") {
      const landed = kind.drag.landed(done.dx, done.dy)
      reportLanding(landed)
      sch.land(kind.base, landed)
      return
    }
    const blocked = kind?.kind === "parts" && !kind.detach ? kind.bodies : done.plan.blocked
    const landNearest = (refuse: (dx: number, dy: number) => boolean) =>
      landingOffset([refuse, contactCheck(scene(), docObjects.filter((o) => done.plan.startPositions.has(o.id)))], done.dx, done.dy, grid)
    const at = blocked?.(done.dx, done.dy) ? landNearest(blocked) : { x: done.dx, y: done.dy }
    if (!at.x && !at.y) return
    if (!kind) {
      sch.moveTo(done.plan.startPositions, at.x, at.y)
      return
    }
    const landed = kind.drag.landed(at.x, at.y)
    reportLanding(landed)
    sch.land(kind.base, landed)
  })

  const onBodyPointerDown = useEvent((e: React.PointerEvent<SVGSVGElement>, id: string) => {
    if (e.button !== 0 || spaceHeld) return
    e.stopPropagation()
    beginMove(e, id, e.shiftKey || e.ctrlKey || e.metaKey)
    e.currentTarget.setPointerCapture(e.pointerId)
  })
  const onBodyPointerMove = useEvent((e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.active) trackMove(toWorld(e.clientX, e.clientY))
  })
  const onBodyPointerUp = useEvent((e: React.PointerEvent<SVGSVGElement>) => {
    endMove()
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  })

  const objectAt = useEvent((clientX: number, clientY: number): string | null => {
    const at = toWorld(clientX, clientY)
    let found: string | null = null
    for (const o of index.query({ x: at.x, y: at.y, w: 0, h: 0 })) {
      const r = objectRect(o, grid)
      if (at.x >= r.x && at.x <= r.x + r.w && at.y >= r.y && at.y <= r.y + r.h) found = o.id
    }
    return found
  })
  const onBodyContextMenu = useEvent((id: string) => sch.selectObject(id))

  // --- measuring: readout under the cursor, probe tips on click ---------------
  const [hover, setHover] = React.useState<{
    target: HoverTarget
    x: number
    y: number
  } | null>(null)

  const hoverAt = React.useRef<{ x: number; y: number } | null>(null)
  const hoverFrame = React.useRef(0)
  const probeHover = useEvent(() => {
    hoverFrame.current = 0
    const at = hoverAt.current
    if (!at) return
    const target = targetAt(at.x, at.y)
    setHover((prev) => (target ? { target, x: at.x, y: at.y } : prev === null ? prev : null))
  })
  const forgetHover = useEvent(() => {
    hoverAt.current = null
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current)
    hoverFrame.current = 0
    setHover((prev) => (prev === null ? prev : null))
  })
  React.useEffect(() => () => void (hoverFrame.current && cancelAnimationFrame(hoverFrame.current)), [])
  const updateHover = (e: React.PointerEvent) => {
    if (panning || spaceHeld || pending || drag.active || marquee.isDragging()) {
      forgetHover()
      return
    }
    hoverAt.current = { x: e.clientX, y: e.clientY }
    if (!hoverFrame.current) hoverFrame.current = requestAnimationFrame(probeHover)
  }

  /** A probe tip on a pin sits on the pin; one on a wire sits where the wire was clicked. */
  const probeAtPin = (ref: PinRef): ProbePoint | null => {
    const found = resolvePin(sch.doc.objects, ref, grid)
    return found && { ref, at: found.point, label: pinName(sch.doc.objects, ref) }
  }
  const runEnds = (runId: string): RunEnds | null => {
    const run = runById.get(runId)
    if (!run) return null
    const pinAtPoint = (p: Point) => wiring.pins.find((q) => q.at.x === p.x && q.at.y === p.y)
    const label = (p: Point) => {
      const pin = pinAtPoint(p)
      if (pin) return pinName(sch.doc.objects, { object: pin.key.slice(0, pin.key.indexOf(":")), pin: pin.key.slice(pin.key.indexOf(":") + 1) })
      return wiring.dangling.some((q) => q.x === p.x && q.y === p.y) ? "open end" : "branch"
    }
    const net = nets.netOfWire(runId)
    const key = net === undefined ? undefined : nets.pinsOf(net)[0]
    const ref = key ? { object: key.slice(0, key.indexOf(":")), pin: key.slice(key.indexOf(":") + 1) } : null
    return { from: label(run.points[0]), to: label(run.points[run.points.length - 1]), ref }
  }
  const probeOnWire = (runId: string, clientX: number, clientY: number): ProbePoint | null => {
    const net = nets.netOfWire(runId)
    const key = net === undefined ? undefined : nets.pinsOf(net)[0]
    if (!key) return null
    const ref = { object: key.slice(0, key.indexOf(":")), pin: key.slice(key.indexOf(":") + 1) }
    return { ref, at: toWorld(clientX, clientY), label: pinName(sch.doc.objects, ref), onWire: true }
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
  const [pending, setPending] = React.useState<Pending | null>(null)
  const [armed, setArmed] = React.useState<Point | null>(null)
  const preview = React.useMemo(() => (pending ? previewOf(sch.doc, wiring, pending.d, pending.target ?? undefined, (area) => index.query(area)) : null), [pending, sch.doc, wiring, index])
  React.useEffect(() => {
    onWirePreview?.(preview ? [...preview.points] : null)
  }, [preview, onWirePreview])
  React.useEffect(() => {
    if (!preview) return
    lightJoins(preview.joins.map((g) => [nets.netOfPin(g[0]) ?? "", nets.netOfPin(g[g.length - 1]) ?? ""] as const))
    return () => lightJoins([])
  }, [preview, nets, lightJoins])
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
  const colorOfEnd = (end: DrawEnd | null): WireColorKey | undefined => {
    if (!end) return undefined
    if (end.kind === "pin") return autoColorFor(keyRef(end.key))
    if (end.kind === "wire") {
      const run = wiring.runBySegment.get(end.segment)
      return run && colorOf(run.id)
    }
    if (end.kind === "end") {
      const s = wiring.sheet.endsAt(end.at)[0]
      const run = s && wiring.runBySegment.get(s.id)
      return run && colorOf(run.id)
    }
    return undefined
  }
  const pendingLook: PendingLook | null =
    pending && preview
      ? {
          points: preview.points,
          corners: pending.d.corners,
          color: pending.d.color ?? colorOfEnd(pending.d.from) ?? colorOfEnd(pending.target) ?? DEFAULT_SIGNAL_COLOR,
          refused: !!preview.refused,
          landing: !!pending.target && pending.target.kind !== "field",
        }
      : null

  const endUnder = (clientX: number, clientY: number): DrawEnd => {
    const under = targetAt(clientX, clientY)
    const world = toWorld(clientX, clientY)
    if (under?.kind === "pin") {
      const key = pinKey(under.ref.object, under.ref.pin)
      const pin = wiring.sheet.pin(key)
      if (pin) return { kind: "pin", key, at: pin.at }
    }
    if (under?.kind === "wire") {
      const run = runById.get(under.id)
      if (run) {
        const id = segmentNearest(run, world)
        const s = run.segments.find((segment) => segment.id === id)!
        return drawEndAt(wiring, nearestOn(s, world))
      }
    }
    return drawEndAt(wiring, snapPoint(world))
  }

  const openEndNear = (clientX: number, clientY: number): DrawEnd | null => {
    const world = toWorld(clientX, clientY)
    const reach = WIRE_HIT_PX / 2 / scale
    const end = wiring.dangling.find((q) => Math.abs(q.x - world.x) <= reach && Math.abs(q.y - world.y) <= reach)
    return end ? drawEndAt(wiring, end) : null
  }

  const refuse = (refusal: DrawRefusal) => {
    if (refusal.refused === "nothing") return
    const text = DRAW_REFUSED[refusal.refused]
    toast.error(text.title, { description: text.why })
  }

  const startAt = (from: DrawEnd, mode: Pending["mode"]): boolean => {
    const started = startDrawing(wiring, from)
    if (isRefusal(started)) {
      refuse(started)
      return false
    }
    setPending({ d: started, mode, target: null, moved: false })
    sch.deselectAll()
    return true
  }

  const finish = (target: DrawEnd): boolean => {
    if (!pending) return false
    if (target.kind === "pin" && pending.d.from.kind === "pin" && pending.d.from.key === target.key && !pending.d.corners.length) return false
    const refusal = sch.draw(pending.d, target, (area) => index.query(area))
    if (refusal) {
      refuse(refusal)
      setPending({ ...pending, mode: "click", target: null })
      return false
    }
    setPending(null)
    return true
  }

  const follow = (clientX: number, clientY: number) => {
    if (!pending) return
    const under = endUnder(clientX, clientY)
    setPending({ ...pending, d: pointerAt(pending.d, under.at), target: under.kind === "field" ? null : under, moved: true })
  }

  const releaseDrawing = (clientX: number, clientY: number) => {
    if (pending?.mode !== "drag") return
    const under = endUnder(clientX, clientY)
    const own = samePoint(under.at, pending.d.from.at) || (under.kind === "pin" && pending.d.from.kind === "pin" && under.key === pending.d.from.key)
    if (under.kind !== "field" && !own && finish(under)) return
    if (!pending.moved || own || samePoint(under.at, pending.d.from.at)) {
      setPending({ ...pending, mode: "click", target: null })
      return
    }
    const cornered = withCorner(sch.doc, wiring, pointerAt(pending.d, under.at), under.at)
    if (isRefusal(cornered)) {
      refuse(cornered)
      setPending({ ...pending, mode: "click", target: null })
      return
    }
    setPending({ d: cornered, mode: "click", target: null, moved: true })
  }

  const onPinPointerDown = useEvent((e: React.PointerEvent<SVGElement>, object: string, pin: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (measure.active) {
      const tip = probeAtPin({ object, pin })
      if (tip) measure.pick(tip)
      return
    }
    const key = pinKey(object, pin)
    const at = wiring.sheet.pin(key)?.at
    if (!at) return
    if (pending?.mode === "click") {
      finish({ kind: "pin", key, at })
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    startAt({ kind: "pin", key, at }, "drag")
  })
  const onPinPointerMove = useEvent((e: React.PointerEvent<SVGElement>) => {
    if (pending?.mode === "drag") follow(e.clientX, e.clientY)
  })
  const onPinPointerUp = useEvent((e: React.PointerEvent<SVGElement>) => {
    if (pending?.mode !== "drag") return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    releaseDrawing(e.clientX, e.clientY)
  })

  const wirePress = React.useRef<{ segment: string; x: number; y: number; pointer: number; element: Element } | null>(null)
  const onWirePointerDown = useEvent((e: React.PointerEvent<SVGPathElement>, id: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (measure.active) {
      const tip = probeOnWire(id, e.clientX, e.clientY)
      if (tip) measure.pick(tip)
      return
    }
    const under = endUnder(e.clientX, e.clientY)
    if (pending?.mode === "click") {
      finish(under)
      return
    }
    if (under.kind === "end") {
      e.currentTarget.setPointerCapture(e.pointerId)
      startAt(under, "drag")
      return
    }
    const run = runById.get(id)
    if (!run) return
    const toggle = e.shiftKey || e.ctrlKey || e.metaKey
    if (e.detail >= 2) {
      const chain = chainOf(wiring, segmentNearest(run, toWorld(e.clientX, e.clientY)))
      sch.selectWires([...chain], toggle)
      marquee.clear()
      return
    }
    const segment = segmentNearest(run, toWorld(e.clientX, e.clientY))
    sch.selectWires([segment], toggle)
    marquee.clear()
    if (toggle) return
    e.currentTarget.setPointerCapture(e.pointerId)
    wirePress.current = { segment, x: e.clientX, y: e.clientY, pointer: e.pointerId, element: e.currentTarget }
  })
  const onWirePointerEnter = useEvent((id: string) => {
    if (pending || drag.active || marquee.isDragging()) return
    setHoveredWire(id)
  })
  const onWirePointerLeave = useEvent(() => setHoveredWire(null))

  const paintSelected = useEvent((color: WireColorKey | undefined, segmentOnly = false) => {
    const ids = new Set<string>()
    for (const id of sch.selectedWires) {
      const net = segmentOnly ? undefined : wiring.view.netOfSegment(id)
      if (net) for (const w of wiring.view.segmentsOf(net)) ids.add(w)
      else ids.add(id)
    }
    sch.setWireColors([...ids].map((id) => [id, color] as const))
  })

  const autoColorAllNets = useEvent(() => {
    const entries: [string, WireColorKey | undefined][] = []
    let next = 0
    for (const net of nets.nets) {
      const color = semanticNetColor(nets.kindsOf(net)) ?? AUTO_COLOR_ORDER[next++ % AUTO_COLOR_ORDER.length]
      for (const id of wiring.view.segmentsOf(net)) entries.push([id, color])
    }
    sch.setWireColors(entries)
  })

  const clearWireColors = useEvent(() => sch.setWireColors(sch.doc.wires.map((w) => [w.id, undefined] as const)))

  /** Where a finger came down on bare field: lifted there without travelling, it was a tap. */
  const tap = React.useRef<Point | null>(null)
  // A second finger turns whatever the first one started into a pinch: nothing it began lands.
  const cancelGesture = useEvent(() => {
    if (drag.active) abandonDrag()
    dragging.current = null
    wirePress.current = null
    if (pending?.mode === "drag") setPending(null)
    marquee.clear()
    forgetHover()
    tap.current = null
  })
  React.useEffect(() => setOnPinchStart(cancelGesture), [setOnPinchStart, cancelGesture])

  // --- field pointer handling: pan or marquee --------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isPanStart(e)) startPan(e)
    // A click on bare field while probing is a miss, not a selection.
    else if (measure.active) return
    else if (e.button === 0 && pending?.mode === "click") {
      const under = endUnder(e.clientX, e.clientY)
      if (under.kind !== "field" || e.detail >= 2) {
        finish(under)
        return
      }
      const cornered = withCorner(sch.doc, wiring, pointerAt(pending.d, under.at), under.at)
      if (isRefusal(cornered)) refuse(cornered)
      else setPending({ ...pending, d: cornered, target: null })
    } else if (e.button === 0) {
      const onCanvas = detail.canvas ? objectAt(e.clientX, e.clientY) : null
      if (onCanvas) {
        e.currentTarget.setPointerCapture(e.pointerId)
        beginMove(e, onCanvas, e.shiftKey || e.ctrlKey || e.metaKey)
        return
      }
      const end = openEndNear(e.clientX, e.clientY)
      if (end) {
        e.currentTarget.setPointerCapture(e.pointerId)
        startAt(end, "drag")
        return
      }
      // A finger on bare field pans, the way every map does; a tap clears the selection.
      if (e.pointerType === "touch") {
        tap.current = { x: e.clientX, y: e.clientY }
        startPan(e)
        return
      }
      sch.deselectAll()
      marquee.start(e)
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    pointerAtClient.current = { x: e.clientX, y: e.clientY }
    onPointerWorld?.(toWorld(e.clientX, e.clientY))
    if (movePan(e)) return
    const press = wirePress.current
    if (press && !drag.active && Math.hypot(e.clientX - press.x, e.clientY - press.y) >= TAP_SLOP) {
      wirePress.current = null
      beginSegmentDrag({ clientX: press.x, clientY: press.y } as React.PointerEvent, press.segment)
    }
    if (drag.active) {
      trackMove(toWorld(e.clientX, e.clientY))
      return
    }
    if (pending) {
      follow(e.clientX, e.clientY)
      return
    }
    if (armed) {
      setArmed(endUnder(e.clientX, e.clientY).at)
      return
    }
    updateHover(e)
    marquee.move(e)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const tapped = tap.current && Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) < TAP_SLOP
    tap.current = null
    if (tapped && e.type === "pointerup") {
      sch.deselectAll()
      setHoveredWire(null)
    }
    if (endPan(e)) return
    wirePress.current = null
    if (drag.active) {
      endMove()
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
      return
    }
    if (pending?.mode === "drag") {
      releaseDrawing(e.clientX, e.clientY)
      return
    }
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
    addFree(defId, toWorld(e.clientX, e.clientY))
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
    const pointer = pointerAtClient.current
    if (pending && e.key === "Backspace") {
      e.preventDefault()
      setPending({ ...pending, d: withoutCorner(pending.d) })
    } else if (pending && e.key === "Enter") {
      e.preventDefault()
      const last = pending.d.corners.at(-1)
      finish(last ? { kind: "field", at: last } : (pending.target ?? { kind: "field", at: snapPoint(pending.d.cursor) }))
    } else if (pending && !mod && (e.key === "/" || e.code === "Slash")) {
      e.preventDefault()
      setPending({ ...pending, d: flipPosture(pending.d) })
    } else if (e.key === "Delete" || e.key === "Backspace") {
      sch.removeSelected()
    } else if (e.key === "Escape") {
      if (measure.active) measure.stop()
      sch.deselectAll()
      setPending(null)
      setArmed(null)
      setHoveredWire(null)
    } else if (!mod && !e.altKey && WIRE_COLOR_BY_CODE.has(e.code) && (pending || sch.selectedWires.size > 0)) {
      const color = WIRE_COLOR_BY_CODE.get(e.code)
      e.preventDefault()
      if (!color) return
      if (pending) setPending({ ...pending, d: { ...pending.d, color } })
      else paintSelected(color, e.shiftKey)
    } else if (!mod && !e.altKey && !pending && (key === "w" || e.code === "KeyW") && pointer) {
      e.preventDefault()
      setArmed(endUnder(pointer.x, pointer.y).at)
    } else if (!mod && !e.altKey && !pending && (key === "j" || e.code === "KeyJ") && pointer) {
      e.preventDefault()
      const refusal = sch.junction(snapPoint(toWorld(pointer.x, pointer.y)))
      if (refusal) toast.error(NO_CROSSING.title, { description: NO_CROSSING.why })
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
    } else if (!mod && e.code === "KeyR") {
      e.preventDefault()
      if (sch.selectedObjects.size || (!e.altKey && sch.selectedWires.size)) turn(e.shiftKey ? -1 : 1, e.altKey)
    } else if (!mod && (e.code === "KeyX" || e.code === "KeyY")) {
      e.preventDefault()
      if (sch.selectedObjects.size || (!e.altKey && sch.selectedWires.size)) mirror(e.code === "KeyX" ? "horizontal" : "vertical", e.altKey)
    }
  })
  // Cut/copy/paste ride the native events so the system clipboard sees them too.
  const onCopy = useEvent((e: ClipboardEvent) => {
    if (inTextField(e) || (!sch.selectedObjects.size && !sch.selectedWires.size)) return
    e.preventDefault()
    copy()
  })
  const onCut = useEvent((e: ClipboardEvent) => {
    if (inTextField(e) || (!sch.selectedObjects.size && !sch.selectedWires.size)) return
    e.preventDefault()
    cut()
  })
  const onPaste = useEvent((e: ClipboardEvent) => {
    if (inTextField(e)) return
    e.preventDefault()
    const external = clipFromClipboard(e.clipboardData?.getData("text/plain"))
    if (external) announceUpgrade(external.notes)
    paste(external?.clip)
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

  const cursor = panning ? "cursor-grabbing" : spaceHeld ? "cursor-grab" : "cursor-precise"
  const probeReading = sim.probe(PROBE_ID)
  const { selectedObjects, selectedWires, doc: schDoc, setPart } = sch
  const selectedObjectList = React.useMemo(
    () => docObjects.filter((o) => selectedObjects.has(o.id)),
    [docObjects, selectedObjects],
  )
  const selectedSegments = React.useMemo(
    () =>
      [...selectedWires].flatMap((id) => {
        const s = wireById.get(id)
        const run = s && wiring.runBySegment.get(id)
        return s && run ? [{ id, run: run.id, a: s.a, b: s.b }] : []
      }),
    [selectedWires, wireById, wiring.runBySegment],
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
            sheeted={labelsOnCanvas && sheeted(o)}
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
    [visibleObjects, grid, detail, labelsOnCanvas, sheeted, selectedObjects, schDoc.parts, simStore, onBodyPointerDown, onBodyPointerMove, onBodyPointerUp, onBodyContextMenu, setPart],
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
    <div className="relative flex h-full w-full overflow-hidden">
    <ContextMenu>
      <ContextMenuTrigger data-slot="dot-field" className={cn("flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background", className)} {...props}>
        <div data-slot="dot-field-stage" className="relative min-h-0 flex-1 overflow-hidden">
          <div
            ref={containerRef}
            data-slot="dot-field-viewport"
            className={cn("absolute inset-0 touch-none select-none", cursor)}
            onPointerDownCapture={(e) => {
              // A long press opens the field menu without a contextmenu event on iOS: add there.
              if (e.pointerType === "touch") menuPoint.current = toWorld(e.clientX, e.clientY)
              wirePress.current = null
              if (e.button !== 0) return
              if (drag.active) {
                e.stopPropagation()
                endMove()
              } else if (pending?.mode === "drag") {
                e.stopPropagation()
                releaseDrawing(e.clientX, e.clientY)
              } else if (armed) {
                e.stopPropagation()
                setArmed(null)
                startAt(endUnder(e.clientX, e.clientY), "click")
              }
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              forgetHover()
              onPointerWorld?.(null)
            }}
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
              <div ref={overlayRef} data-slot="dot-field-overlay" className="contents">
                {children}
              </div>
              {detail.canvas ? (
                <>
                  <FieldCanvas objects={staticObjects} routes={staticRoutes} view={view} grid={grid} scale={scale} colorOf={colorOf} raster={symbolRaster} selectedObjects={selectedObjects} selectedWires={selectedRuns} marks={staticMarks} />
                  <div ref={dragLayerRef} data-slot="field-drag-layer" className="pointer-events-none absolute top-0 left-0">
                    {lifted.size > 0 && <FieldCanvas objects={liftedObjects} routes={liftedRoutes} view={view} grid={grid} scale={scale} colorOf={colorOf} raster={symbolRaster} selectedObjects={selectedObjects} selectedWires={selectedRuns} marks={liftedMarks} />}
                  </div>
                </>
              ) : (
                <>
                  {objectViews}
                  <div ref={dragLayerRef} data-slot="field-drag-layer" className="pointer-events-none absolute top-0 left-0">
                    {liftedArea && <TextCanvas objects={liftedLabels} view={liftedArea} grid={grid} scale={scale} text={sheetText} raster={textRaster} />}
                  </div>
                </>
              )}
              {!detail.canvas && <SelectionLayer objects={visibleObjects} segments={selectedSegments} selectedObjects={selectedObjects} grid={grid} />}
              {!detail.canvas && (
              <WireLayer
                routes={visibleRoutes}
                grid={grid}
                scale={scale}
                selected={selectedRuns}
                hoveredNet={hoveredNet}
                lit={lit}
                flash={flash}
                colorOf={colorOf}
                netOfWire={nets.netOfWire}
                dots={wiring.dots}
                dangling={wiring.dangling}
                corners={wiring.corners}
                flow={flow}
                onWirePointerDown={onWirePointerDown}
                onWirePointerEnter={onWirePointerEnter}
                onWirePointerLeave={onWirePointerLeave}
              />
              )}
              {labelsOnCanvas && <TextCanvas objects={labelledObjects} view={view} grid={grid} scale={scale} text={sheetText} raster={textRaster} />}
              <svg data-slot="rubber-band" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
                <g />
              </svg>
              {unlaid && unlaid.edits === sch.edits && (
                <svg data-slot="unlaid" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
                  {unlaid.at.map((p) => (
                    <circle key={`${p.x},${p.y}`} data-unlaid={`${p.x},${p.y}`} cx={p.x} cy={p.y} r={0.45 * grid} fill="none" stroke="var(--destructive)" strokeWidth={2} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
                  ))}
                </svg>
              )}
              <PendingWireLayer pending={pendingLook} grid={grid} scale={scale} part="route" />
              {/* Above the wires: a pin on a wire has to stay visible and clickable. */}
              <PinLayer
                objects={visibleObjects}
                grid={grid}
                detail={detail}
                connected={nets.connected}
                contacts={nets.contacts}
                selected={sch.selectedObjects}
                sheeted={onSheet}
                routes={visibleRoutes}
                netColor={pinNetColor}
                onPinPointerDown={onPinPointerDown}
                onPinPointerMove={onPinPointerMove}
                onPinPointerUp={onPinPointerUp}
              />
              <PendingWireLayer pending={pendingLook} grid={grid} scale={scale} part="marks" />
              {armed && <PendingWireLayer pending={{ points: [armed], corners: [], color: DEFAULT_SIGNAL_COLOR, refused: false, landing: false }} grid={grid} scale={scale} part="marks" />}
              {ghosts && ghosts.length > 0 && (
                <GhostLayer ghosts={ghosts} objects={docObjects} grid={grid} scale={scale} colorOf={colorOf} raster={symbolRaster} />
              )}
              <MeasureLayer tips={tips} held={heldTips} grid={grid} />
              <div
                ref={marqueeRef}
                data-slot="dot-field-selection"
                className="pointer-events-none absolute top-0 left-0 border border-selection bg-selection/10"
                style={{ display: "none" }}
              />
            </div>
          </div>

          <ProbeReadout
            className="absolute bottom-16 left-4 max-md:bottom-24"
            tips={tips}
            reading={probeReading}
            sim={sim}
            onClear={measure.clear}
            onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
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
            onTouchStart={(e) => e.stopPropagation()}
          />
          {selectedWireList.length > 0 && selectedObjectList.length === 0 && (
            <WirePalette
              className="absolute top-3 right-3"
              active={activeColors}
              overridden={anyOverridden}
              onPick={paintSelected}
              onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            />
          )}
          {/* On a phone the inspector spans the top beside the palette button, at most half the field high. */}
          <Inspector
            className="absolute top-3 right-3 max-md:left-14 max-md:w-auto max-md:max-h-[45%]"
            selected={selectedObjectList}
            damage={sim.damage}
            sim={sim}
            onChange={sch.setProps}
            onFirmware={onFirmware}
            onSerial={sendSerial}
            onCode={(id) => {
              setCodeBoardId(id)
              setCodeOpen(true)
            }}
            onHdl={setHdlId}
            onRotate={(d) => turn(d)}
            onFlip={(axis) => mirror(axis)}
            onDelete={sch.removeSelected}
            onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
          {/* A phone has no Escape: a wire left hanging in click mode needs a way out. */}
          {pending?.mode === "click" && (
            <Button
              size="sm"
              variant="secondary"
              className="absolute bottom-16 left-1/2 -translate-x-1/2 shadow-md md:hidden"
              onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
              onClick={() => setPending(null)}
            >
              Cancel wire
            </Button>
          )}
          <ScaleBar className="absolute right-4 bottom-14" scale={scale} grid={grid} />
          <ZoomControls className="absolute right-4 bottom-4" scale={scale} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={reset} />
          {hover && <FieldReadout target={hover.target} x={hover.x} y={hover.y} objects={sch.doc.objects} runEnds={runEnds} sim={sim} />}
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
            onTouchStart={(e) => e.stopPropagation()}
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
            onTouchStart={(e) => e.stopPropagation()}
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
                  <ContextMenuItem key={def.id} onClick={() => addFree(def.id, menuPoint.current)}>
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
        <ContextMenuItem disabled={!hasSelection} onClick={cut}>
          Cut
          <ContextMenuShortcut>⌘X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onClick={copy}>
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
        <ContextMenuItem disabled={!hasObjects} onClick={() => turn(1)}>
          Rotate clockwise
          <ContextMenuShortcut>R</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasObjects} onClick={() => turn(-1)}>
          Rotate counter-clockwise
          <ContextMenuShortcut>⇧R</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasObjects} onClick={() => mirror("horizontal")}>
          Mirror horizontally
          <ContextMenuShortcut>X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasObjects} onClick={() => mirror("vertical")}>
          Mirror vertically
          <ContextMenuShortcut>Y</ContextMenuShortcut>
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
        <React.Suspense fallback={<PanelLoading className="w-160" />}>
          <CodePanel
            ref={codeEditor}
            board={codeBoard}
            boards={boards}
            onPick={(id) => sch.selectObject(id)}
            onFiles={sch.setProject}
            onFirmware={onFirmware}
            onBuild={sch.setBuild}
            onDebug={sch.setDebug}
            debug={debug}
            onClose={() => setCodeOpen(false)}
            projectName={projectName}
          />
        </React.Suspense>
      )}
      {hdlOpen && (
        <React.Suspense fallback={<PanelLoading className="w-155" explorer={false} />}>
          <HdlPanel
            module={hdlOpen}
            placed={sch.doc.objects.filter((o) => o.def === hdlOpen.id).length}
            onChange={sch.setModule}
            onDelete={(id) => {
              sch.removeModule(id)
              setHdlId(null)
            }}
            onClose={() => setHdlId(null)}
          />
        </React.Suspense>
      )}
    </div>
  )
}
