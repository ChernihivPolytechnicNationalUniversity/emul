import * as React from "react"
import { isOptLevel, type SourceFile } from "emul-shared/source"
import { isNetlist } from "emul-shared/hdl"
import { normalizeFiles } from "@/project/files"
import { normalizeDebug } from "@/debug/saved"
import { GRID, objectPins, snap, type FlipAxis, type Point, type Rect, type Turn } from "./geometry"
import { freeSpot, placementCheck, wireCheck, type PlacementScene } from "./placement"
import { getDef, withLibrary } from "./registry"
import { migrated, SCHEMATIC_VERSION, upgradedFrom, type SavedSchematic } from "./migrate"
import {
  emptySchematic,
  partKey,
  type ComponentDef,
  type PartState,
  type PinRef,
  type PlacedObject,
  type Schematic,
  type BoardDebug,
  type HdlModule,
} from "./types"
import { isHdlDef } from "./hdl"
import type { WireColorKey } from "./wire-colors"
import { clipOf, connectPins, moved, inNormalForm, placedObject, recoloured, removed, reoriented, tapWireAt, wiringOf, withModule, withSegments } from "./wire-edits"
import { flipSelection, rotateSelection } from "./orient"
import { flippedWithWires, TurnRun, type Landed } from "./rubber-band"
import { drawnTo, isRefusal, type DrawEnd, type Drawing, type DrawRefusal, type Near } from "./wire-draw"
import { junctionAt, type JunctionRefusal } from "./junction-tool"
import { inRect } from "./wire-select"
import { withFieldMoved, type FieldKey } from "./fields"
import type { SpatialIndex } from "./spatial"
import { WireGraph } from "./wires/graph"
import type { WireSegment } from "./wires/segment"
import { documentPins, editedObjects } from "./pin-index"
import { bodyRefusal, type BodyRefusal } from "./body-crossing"

/** A board as a file brings it: its project, build options and debugger settings re-checked. */
function checked(saved: PlacedObject): PlacedObject {
  const o = migrated(saved)
  if (!o.project && !o.build && !o.debug) return o
  const { project, build, debug, ...rest } = o
  const opt = build?.opt
  const repaired = normalizeDebug(debug)
  return { ...rest, ...(project && { project: normalizeFiles(project) }), ...(isOptLevel(opt) && { build: { opt } }), ...(repaired && { debug: repaired }) }
}

function checkedLibrary(library: unknown): HdlModule[] | undefined {
  if (!Array.isArray(library)) return undefined
  const modules = library.filter(
    (m): m is HdlModule => !!m && typeof m.id === "string" && isHdlDef(m.id) && typeof m.name === "string" && Array.isArray(m.files),
  )
  return modules.length
    ? modules.map((m) => {
        const { netlist, built, builtFrom, ...rest } = m
        const valid = isNetlist(netlist) && typeof built === "string"
        return { ...rest, files: normalizeFiles(m.files), ...(valid && { netlist, built, builtFrom }) }
      })
    : undefined
}

/** Next free designator with this prefix among `objects`. */
function nextRef(objects: readonly PlacedObject[], prefix: string): string {
  const used = new Set(objects.map((o) => o.props?.ref))
  let n = 1
  while (used.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

/** Undo depth; enough for a long session without keeping every drag frame forever. */
const HISTORY_LIMIT = 100

type History = { past: Schematic[]; present: Schematic; future: Schematic[]; edits: number }

/** A history entry made present again, carrying over what is live now (parts, projects, build and debugger settings). */
function keepLive(target: Schematic, current: Schematic): Schematic {
  const live = new Map(current.objects.map((o) => [o.id, o]))
  return {
    ...target,
    parts: current.parts,
    library: current.library,
    objects: target.objects.map((o) => {
      const now = live.get(o.id)
      if (!now || (now.project === o.project && now.build === o.build && now.debug === o.debug)) return o
      return { ...o, project: now.project, build: now.build, debug: now.debug }
    }),
  }
}

/** What copy puts on the clipboard: the picked objects, the wires among them, their part state. */
export type Clip = Pick<Schematic, "objects" | "wires" | "parts">

export const clipOnTheLattice = (clip: Clip): Clip => ({ ...clip, objects: clip.objects.map(migrated) })

export type ClipIn = { clip: Clip; notes: string[] }

type SavedClip = { objects: PlacedObject[]; wires?: unknown[]; segments?: WireSegment[]; parts?: Record<string, PartState> }

export function clipOfThisVersion(saved: SavedClip, version: number | undefined): ClipIn | null {
  const parts = saved.parts ?? {}
  if (version !== undefined && version > SCHEMATIC_VERSION) return null
  if (version === SCHEMATIC_VERSION) {
    try {
      return { clip: inNormalForm({ objects: saved.objects, wires: saved.segments ?? [], parts }), notes: [] }
    } catch {
      return null
    }
  }
  const { doc, notes } = upgradedFrom({ objects: saved.objects, wires: saved.wires ?? [], parts } as SavedSchematic, version)
  return { clip: { objects: doc.objects, wires: doc.wires, parts: doc.parts }, notes }
}

export const clipboardText = (clip: Clip) => JSON.stringify({ emul: { objects: clip.objects, wires: [], segments: clip.wires, parts: clip.parts }, version: SCHEMATIC_VERSION })

function savedClipOf(text: string | undefined): { emul: SavedClip; version: number | undefined } | null {
  let parsed: { emul?: SavedClip; version?: unknown } | null = null
  try {
    parsed = text ? (JSON.parse(text) as { emul?: SavedClip; version?: unknown }) : null
  } catch {
    return null
  }
  if (!parsed?.emul || !Array.isArray(parsed.emul.objects)) return null
  return { emul: parsed.emul, version: typeof parsed.version === "number" ? parsed.version : undefined }
}

export const clipboardDefIds = (text: string | undefined): string[] => savedClipOf(text)?.emul.objects.map((o) => o.def) ?? []

export function clipFromClipboard(text: string | undefined): ClipIn | null {
  const saved = savedClipOf(text)
  return saved && clipOfThisVersion(saved.emul, saved.version)
}

const PASTE_REACH = 24

export function pasteLanding(scene: PlacementScene, saved: Clip, offset: Point, wiresClear?: (clip: Clip, at: Point) => boolean): { clip: Clip; at: Point; clear: boolean } {
  const clip = clipOnTheLattice(saved)
  const objects = clip.objects.map((o) => ({ ...o, id: `paste:${o.id}` }))
  if (bodyRefusal(emptySchematic(), clip)) return { clip, at: offset, clear: false }
  const base: Schematic = { objects: [...scene.objects], wires: scene.routes.flatMap((r) => r.pts.slice(1).map((b, i) => ({ id: `${r.id}:${i}`, a: r.pts[i], b }))), parts: {} }
  const clearAt = (at: Point) => {
    const shifted = (p: Point) => ({ x: p.x + at.x, y: p.y + at.y })
    const after = { ...base, objects: [...base.objects, ...objects.map((o) => ({ ...o, ...shifted(o) }))], wires: [...base.wires, ...clip.wires.map((s) => ({ ...s, a: shifted(s.a), b: shifted(s.b) }))] }
    return (!wiresClear || !clip.wires.length || wiresClear(clip, at)) && !bodyRefusal(base, after)
  }
  const at = freeSpot(scene, objects, offset, false)
  if (clearAt(at)) return { clip, at, clear: true }
  const bodies = placementCheck(scene, objects)
  const covers = wireCheck(scene, objects, false)
  for (let ring = 1; ring <= PASTE_REACH; ring++) {
    const around: Point[] = []
    for (let dx = -ring; dx <= ring; dx++)
      for (let dy = -ring; dy <= ring; dy++) if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) around.push({ x: at.x + dx * scene.grid, y: at.y + dy * scene.grid })
    around.sort((p, q) => Math.hypot(p.x - at.x, p.y - at.y) - Math.hypot(q.x - at.x, q.y - at.y))
    const found = around.find((p) => !bodies(p.x, p.y) && !covers(p.x, p.y) && clearAt(p))
    if (found) return { clip, at: found, clear: true }
  }
  return { clip, at, clear: false }
}

export function pastedInto(doc: Schematic, clip: Clip, dx: number, dy: number, idOf: (old: string) => string, newId: () => string, onRefused?: (refusal: BodyRefusal) => void): Schematic {
  const ids = new Map(clip.objects.map((o) => [o.id, idOf(o.id)]))
  const objects = [...doc.objects]
  const added: PlacedObject[] = []
  for (const o of clipOnTheLattice(clip).objects) {
    const prefix = getDef(o.def)?.prefix
    const next: PlacedObject = { ...o, id: ids.get(o.id)!, x: o.x + dx, y: o.y + dy }
    if (prefix) next.props = { ...o.props, ref: nextRef(objects, prefix) }
    objects.push(next)
    added.push(next)
  }
  const wires = clip.wires.map((s) => ({ ...s, id: newId(), a: { x: s.a.x + dx, y: s.a.y + dy }, b: { x: s.b.x + dx, y: s.b.y + dy } }))
  const parts = { ...doc.parts }
  for (const [k, v] of Object.entries(clip.parts)) {
    const [object, part] = k.split(":")
    const id = ids.get(object)
    if (id) parts[partKey(id, part)] = v
  }
  const points = added.flatMap((o) => objectPins(o, GRID).map((p) => p.point))
  const result = withSegments({ ...doc, objects, parts }, wires, [], points, newId)
  const refused = bodyRefusal(doc, result)
  if (!refused) return result
  onRefused?.(refused)
  return doc
}

/** Schematic document plus selection and undo history. All coordinates are world px. */
export function useSchematic(grid: number) {
  const [history, setHistory] = React.useState<History>(() => ({ past: [], present: emptySchematic(), future: [], edits: 0 }))
  const doc = history.present
  const [graph] = React.useState(() => new WireGraph())
  const { objects: docObjects, wires: docWires, library: docLibrary } = doc
  const wiring = React.useMemo(() => wiringOf(graph, { objects: docObjects, wires: docWires, library: docLibrary }), [graph, docObjects, docWires, docLibrary])
  const wiringNow = React.useRef(wiring)
  React.useLayoutEffect(() => {
    wiringNow.current = wiring
  }, [wiring])
  const [selectedObjects, setSelectedObjects] = React.useState<ReadonlySet<string>>(() => new Set())
  const [selectedWires, setSelectedWires] = React.useState<ReadonlySet<string>>(() => new Set())
  const edits = history.edits
  const turning = React.useRef<{ ids: string; run: TurnRun; doc: Schematic } | null>(null)

  const setDoc = React.useCallback(
    (fn: (d: Schematic) => Schematic, opts: { silent?: boolean } = {}) => {
      setHistory((h) => {
        const present = fn(h.present)
        if (present === h.present) return h
        if (opts.silent) return { ...h, present }
        return { past: [...h.past.slice(1 - HISTORY_LIMIT), h.present], present, future: [], edits: h.edits + 1 }
      })
    },
    [],
  )

  const commitFrom = React.useCallback((base: Schematic, next: Schematic) => setDoc((d) => (d === base ? next : d)), [setDoc])

  /** Selection survives undo only for things that still exist. */
  const pruneSelection = React.useCallback((d: Schematic) => {
    const objects = new Set(d.objects.map((o) => o.id))
    const wires = new Set(d.wires.map((w) => w.id))
    setSelectedObjects((s) => new Set([...s].filter((id) => objects.has(id))))
    setSelectedWires((s) => new Set([...s].filter((id) => wires.has(id))))
  }, [])

  // Part state and firmware projects are live rather than edits: they are not undone, so
  // stepping through history keeps whatever the switches are set to and the code as typed.
  const undo = React.useCallback(() => {
    setHistory((h) => {
      const prev = h.past.at(-1)
      if (!prev) return h
      const present = keepLive(prev, h.present)
      pruneSelection(present)
      return { past: h.past.slice(0, -1), present, future: [h.present, ...h.future], edits: h.edits + 1 }
    })
  }, [pruneSelection])

  const redo = React.useCallback(() => {
    setHistory((h) => {
      const next = h.future[0]
      if (!next) return h
      const present = keepLive(next, h.present)
      pruneSelection(present)
      return { past: [...h.past, h.present], present, future: h.future.slice(1), edits: h.edits + 1 }
    })
  }, [pruneSelection])

  const canUndo = history.past.length > 0
  const canRedo = history.future.length > 0

  /** Place a component centered at a world point, snapped to the grid. */
  const add = React.useCallback(
    (defId: string, center: Point, options: { suppressSplice?: boolean; onRefused?: (refusal: BodyRefusal) => void } = {}) => {
      const def = getDef(defId)
      if (!def) return
      const x = snap(center.x - (def.width * grid) / 2, grid)
      const y = snap(center.y - (def.height * grid) / 2, grid)
      const probe: PlacedObject = { id: crypto.randomUUID(), def: defId, x, y, ...(def.prefix && { props: { ref: nextRef(doc.objects, def.prefix) } }) }
      const scene = { objects: doc.objects, routes: doc.wires.map((s) => ({ id: s.id, pts: [s.a, s.b], owner: [] })), grid }
      const splice = !options.suppressSplice
      const clear = wireCheck(scene, [probe], splice)(0, 0) ? freeSpot(scene, [probe], { x: 0, y: 0 }, splice) : { x: 0, y: 0 }
      const obj = { ...probe, x: x + clear.x, y: y + clear.y }
      const next = placedObject(doc, obj, undefined, options)
      if (next === doc) return
      setDoc((d) => d === doc ? next : placedObject(d, obj, undefined, options))
      setSelectedObjects(new Set([obj.id]))
      setSelectedWires(new Set())
      return obj
    },
    [doc, grid, setDoc],
  )

  const remove = React.useCallback((objects: ReadonlySet<string>, wires: ReadonlySet<string>) => {
    setDoc((d) => removed(d, objects, wires))
    setSelectedObjects((s) => new Set([...s].filter((id) => !objects.has(id))))
    setSelectedWires((s) => new Set([...s].filter((id) => !wires.has(id))))
  }, [setDoc])

  const removeSelected = React.useCallback(
    () => remove(selectedObjects, selectedWires),
    [remove, selectedObjects, selectedWires],
  )

  const clear = React.useCallback(() => {
    setDoc(emptySchematic)
    setSelectedObjects(new Set())
    setSelectedWires(new Set())
  }, [setDoc])

  const replace = React.useCallback(
    (next: Schematic) => {
      setDoc(
        () => {
          const { library, ...rest } = next
          const modules = checkedLibrary(library)
          const doc: Schematic = { ...rest, objects: next.objects.map(checked), ...(modules && { library: modules }) }
          return withLibrary(doc.library, () => inNormalForm(doc))
        },
        { silent: true },
      )
      const objects = new Set(next.objects.map((o) => o.id))
      const wires = new Set(next.wires.map((w) => w.id))
      setSelectedObjects((s) => ([...s].every((id) => objects.has(id)) ? s : new Set([...s].filter((id) => objects.has(id)))))
      setSelectedWires((s) => ([...s].every((id) => wires.has(id)) ? s : new Set([...s].filter((id) => wires.has(id)))))
    },
    [setDoc],
  )

  /** Replace the whole document (loading an example or a file; the boards' projects, build options and debugger settings are re-checked). */
  const load = React.useCallback((next: Schematic) => {
    const { library, ...rest } = next
    const modules = checkedLibrary(library)
    setHistory((h) => ({ past: [], present: { ...rest, objects: next.objects.map(checked), ...(modules && { library: modules }) }, future: [], edits: h.edits }))
    setSelectedObjects(new Set())
    setSelectedWires(new Set())
  }, [])

  const selectObject = React.useCallback((id: string, toggle = false) => {
    setSelectedWires(new Set())
    setSelectedObjects((s) => {
      if (!toggle) return s.has(id) ? s : new Set([id])
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectWires = React.useCallback((ids: readonly string[], toggle = false) => {
    setSelectedObjects(new Set())
    setSelectedWires((s) => {
      if (!toggle) return ids.every((id) => s.has(id)) && s.size === ids.length ? s : new Set(ids)
      const next = new Set(s)
      const all = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (all) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }, [])

  const selectAll = React.useCallback(() => {
    setSelectedObjects(new Set(doc.objects.map((o) => o.id)))
    setSelectedWires(new Set(doc.wires.map((w) => w.id)))
  }, [doc])

  const deselectAll = React.useCallback(() => {
    setSelectedObjects(new Set())
    setSelectedWires(new Set())
  }, [])

  const selectInRect = React.useCallback(
    (rect: Rect | null) => {
      if (!rect) return
      const picked = inRect(doc, rect, grid)
      setSelectedObjects(new Set(picked.objects))
      setSelectedWires(new Set(picked.wires))
    },
    [doc, grid],
  )

  const moveTo = React.useCallback(
    (from: ReadonlyMap<string, Point>, dx: number, dy: number) => {
      const sdx = snap(dx, grid)
      const sdy = snap(dy, grid)
      setDoc((d) => moved(d, from, sdx, sdy, undefined, wiringNow.current))
    },
    [grid, setDoc],
  )

  /** Merge props into an object (ref, value, …). */
  const setProps = React.useCallback((id: string, patch: Record<string, string>) => {
    setDoc((d) => ({
      ...d,
      objects: d.objects.map((o) => (o.id === id ? { ...o, props: { ...o.props, ...patch } } : o)),
    }))
  }, [setDoc])

  const moveField = React.useCallback((id: string, key: FieldKey, dx: number, dy: number) => {
    setDoc((d) => {
      const index = documentPins(d.objects)
      const object = index.objects.get(id)
      if (!object) return d
      const moved = withFieldMoved(object, key, dx, dy, grid)
      if (moved === object) return d
      const objects = d.objects.slice()
      objects[index.rank(object)] = moved
      return { ...d, objects: editedObjects(d.objects, objects, [id]) }
    })
  }, [setDoc, grid])

  /**
   * Swap a part for another variant of its family. The variants share their pins, so the wires
   * stay; props the new variant has no use for, or a choice it does not offer, are dropped.
   */
  const setVariant = React.useCallback((id: string, defId: string) => {
    const next = getDef(defId)
    if (!next) return
    setDoc((d) => ({
      ...d,
      objects: d.objects.map((o) => (o.id === id && o.def !== defId ? { ...o, def: defId, props: keptProps(o.props, getDef(o.def), next) } : o)),
    }))
  }, [setDoc])

  /** Replace a board's firmware sources; typing is not an undo step (see `undo`). */
  const setProject = React.useCallback((id: string, files: SourceFile[], expected?: SourceFile[]) => {
    const replace = (o: PlacedObject) => o.id === id && (expected === undefined || o.project === expected)
    setDoc((d) => ({ ...d, objects: d.objects.map((o) => (replace(o) ? { ...o, project: files } : o)) }), { silent: true })
  }, [setDoc])

  /** A board's build options; not an undo step. */
  const setBuild = React.useCallback((id: string, build: NonNullable<PlacedObject["build"]>) => {
    setDoc((d) => ({ ...d, objects: d.objects.map((o) => (o.id === id ? { ...o, build } : o)) }), { silent: true })
  }, [setDoc])

  /** A board's debugger settings (breakpoints, added sources, watches); not an undo step. */
  const setDebug = React.useCallback((id: string, fn: (d: BoardDebug) => BoardDebug) => {
    setDoc((d) => ({ ...d, objects: d.objects.map((o) => (o.id === id ? { ...o, debug: fn(o.debug ?? {}) } : o)) }), { silent: true })
  }, [setDoc])

  const setModule = React.useCallback((module: HdlModule) => {
    setDoc((d) => withModule(d, module), { silent: true })
  }, [setDoc])

  const removeModule = React.useCallback((id: string) => {
    setDoc(
      (d) => {
        if (d.objects.some((o) => o.def === id)) return d
        const library = (d.library ?? []).filter((m) => m.id !== id)
        const { library: _old, ...rest } = d
        return library.length ? { ...rest, library } : rest
      },
      { silent: true },
    )
  }, [setDoc])

  const rotate = React.useCallback(
    (ids: ReadonlySet<string>, turn: Turn, index?: SpatialIndex, wires: ReadonlySet<string> = new Set()): Landed | null => {
      if (!ids.size && !wires.size) return null
      const key = [...[...ids].sort(), "|", ...[...wires].sort()].join("\u0000")
      const known = turning.current
      const run = known && known.ids === key && known.doc === doc ? known.run : new TurnRun(doc, wiring, ids, index, wires)
      const landed = run.turned(turn)
      if (landed.refused) return landed
      turning.current = { ids: key, run, doc: landed.doc }
      commitFrom(doc, landed.doc)
      return landed
    },
    [doc, wiring, commitFrom],
  )

  const flip = React.useCallback(
    (ids: ReadonlySet<string>, axis: FlipAxis, index?: SpatialIndex, wires: ReadonlySet<string> = new Set()): Landed | null => {
      if (!ids.size && !wires.size) return null
      const landed = flippedWithWires(doc, wiring, ids, axis, undefined, index, wires)
      if (!landed.refused) commitFrom(doc, landed.doc)
      return landed
    },
    [doc, wiring, commitFrom],
  )

  const rotateAlone = React.useCallback(
    (ids: ReadonlySet<string>, turn: Turn) => {
      if (!ids.size) return
      const next = reoriented(doc, rotateSelection(doc, ids, turn, grid), ids)
      const refused = bodyRefusal(doc, next)
      if (refused) return refused
      commitFrom(doc, next)
    },
    [doc, grid, commitFrom],
  )

  const flipAlone = React.useCallback(
    (ids: ReadonlySet<string>, axis: FlipAxis) => {
      if (!ids.size) return
      const next = reoriented(doc, flipSelection(doc, ids, axis, grid), ids)
      const refused = bodyRefusal(doc, next)
      if (refused) return refused
      commitFrom(doc, next)
    },
    [doc, grid, commitFrom],
  )

  const draw = React.useCallback(
    (drawing: Drawing, target: DrawEnd, near?: Near): DrawRefusal | null => {
      const next = drawnTo(doc, wiring, drawing, target, undefined, near)
      if (isRefusal(next)) return next
      commitFrom(doc, next)
      setSelectedWires(new Set())
      return null
    },
    [doc, wiring, commitFrom],
  )

  const junction = React.useCallback(
    (at: Point): JunctionRefusal | null => {
      const next = junctionAt(doc, wiring, at)
      if ("refused" in next) return next
      commitFrom(doc, next)
      return null
    },
    [doc, wiring, commitFrom],
  )

  const land = React.useCallback((base: Schematic, landed: Landed) => commitFrom(base, landed.doc), [commitFrom])

  const addWire = React.useCallback(
    (from: PinRef, to: PinRef, points: Point[] = [], color?: WireColorKey): boolean => {
      if (from.object === to.object && from.pin === to.pin) return true
      const next = connectPins(doc, from, to, points, color, undefined, wiring)
      if (next === doc) return false
      setDoc((d) => (d === doc ? next : connectPins(d, from, to, points, color)))
      return true
    },
    [doc, wiring, setDoc],
  )

  const setWireColors = React.useCallback(
    (entries: Iterable<readonly [string, WireColorKey | undefined]>) => {
      const next = new Map(entries)
      if (next.size === 0) return
      setDoc((d) => recoloured(d, next))
    },
    [setDoc],
  )

  const tapWire = React.useCallback(
    (segmentId: string, at: Point, from: PinRef, points: Point[] = [], color?: WireColorKey): boolean => {
      const next = tapWireAt(doc, segmentId, at, from, points, color, undefined, wiring)
      if (next === doc) return false
      setDoc((d) => (d === doc ? next : tapWireAt(d, segmentId, at, from, points, color)))
      setSelectedWires(new Set())
      return true
    },
    [doc, wiring, setDoc],
  )

  const setPart = React.useCallback(
    (object: string, part: string, patch: PartState) => {
      const key = partKey(object, part)
      setDoc((d) => ({ ...d, parts: { ...d.parts, [key]: { ...d.parts[key], ...patch } } }), { silent: true })
    },
    [setDoc],
  )

  // --- clipboard ------------------------------------------------------------

  /** The selected objects with the wires that run between them, ready to paste. */
  const copySelected = React.useCallback((): Clip | null => clipOf(doc, selectedObjects, wiringNow.current, selectedWires), [doc, selectedObjects, selectedWires])

  /**
   * Add a clip's contents shifted by (dx, dy), under fresh ids and free designators, and
   * select what was added. Pasting the same clip twice yields two independent copies.
   */
  const paste = React.useCallback(
    (clip: Clip, dx: number, dy: number, onRefused?: (refusal: BodyRefusal) => void) => {
      const ids = new Map(clip.objects.map((o) => [o.id, crypto.randomUUID()]))
      const into = (d: Schematic) => pastedInto(d, clip, snap(dx, grid), snap(dy, grid), (old) => ids.get(old)!, () => crypto.randomUUID(), onRefused)
      const next = into(doc)
      if (next === doc) return false
      setDoc((d) => d === doc ? next : into(d))
      setSelectedObjects(new Set(ids.values()))
      setSelectedWires(new Set())
      return true
    },
    [doc, grid, setDoc],
  )

  return {
    doc,
    wiring,
    edits,
    selectedObjects,
    selectedWires,
    add,
    remove,
    removeSelected,
    clear,
    load,
    selectObject,
    selectWires,
    selectAll,
    deselectAll,
    selectInRect,
    moveTo,
    rotate,
    flip,
    rotateAlone,
    flipAlone,
    draw,
    junction,
    land,
    commitFrom,
    setProps,
    moveField,
    setVariant,
    setProject,
    setBuild,
    setDebug,
    setModule,
    removeModule,
    addWire,
    tapWire,
    setWireColors,
    setPart,
    replace,
    undo,
    redo,
    canUndo,
    canRedo,
    copySelected,
    paste,
  }
}

/**
 * The props a part keeps when it becomes `to`: its designator, its firmware if `to` runs one, a
 * choice `to` offers too, and a value typed into a setting both variants start alike (a gain, not
 * a part number). The rest falls back to `to`'s defaults.
 */
export function keptProps(props: Record<string, string> | undefined, from: ComponentDef | undefined, to: ComponentDef): Record<string, string> | undefined {
  if (!props) return props
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(props)) {
    const field = to.fields?.find((f) => f.key === key)
    const same = field && (field.type === "select" ? field.options.some((o) => o.value === value) : from?.defaults?.[key] === to.defaults?.[key])
    if (key === "ref" || (to.chip !== undefined && key.startsWith("firmware")) || same) kept[key] = value
  }
  return kept
}
