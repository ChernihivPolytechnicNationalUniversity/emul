import * as React from "react"
import { isOptLevel, type SourceFile } from "emul-shared/source"
import { normalizeFiles } from "@/project/files"
import { normalizeDebug } from "@/debug/saved"
import { intersects, objectRect, objectSize, snap, type Point, type Rect } from "./geometry"
import { getDef } from "./registry"
import {
  emptySchematic,
  partKey,
  type PartState,
  type PinRef,
  type PlacedObject,
  type Rotation,
  type Schematic,
  type BoardDebug,
  type Wire,
} from "./types"
import type { WireColorKey } from "./wire-colors"
import { connectPins, tapWireAt } from "./wiring"

/** A board as a file brings it: its project, build options and debugger settings re-checked. */
function checked(o: PlacedObject): PlacedObject {
  if (!o.project && !o.build && !o.debug) return o
  const { project, build, debug, ...rest } = o
  const opt = build?.opt
  const repaired = normalizeDebug(debug)
  return { ...rest, ...(project && { project: normalizeFiles(project) }), ...(isOptLevel(opt) && { build: { opt } }), ...(repaired && { debug: repaired }) }
}

function recolor(w: Wire, color: WireColorKey | undefined): Wire {
  const { color: _previous, ...rest } = w
  return color ? { ...rest, color } : rest
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

type History = { past: Schematic[]; present: Schematic; future: Schematic[] }

/** A history entry made present again, carrying over what is live now (parts, projects, build and debugger settings). */
function keepLive(target: Schematic, current: Schematic): Schematic {
  const live = new Map(current.objects.map((o) => [o.id, o]))
  return {
    ...target,
    parts: current.parts,
    objects: target.objects.map((o) => {
      const now = live.get(o.id)
      if (!now || (now.project === o.project && now.build === o.build && now.debug === o.debug)) return o
      return { ...o, project: now.project, build: now.build, debug: now.debug }
    }),
  }
}

/** What copy puts on the clipboard: the picked objects, the wires among them, their part state. */
export type Clip = Pick<Schematic, "objects" | "wires" | "parts">

/** Schematic document plus selection and undo history. All coordinates are world px. */
export function useSchematic(grid: number) {
  const [history, setHistory] = React.useState<History>(() => ({ past: [], present: emptySchematic(), future: [] }))
  const doc = history.present
  const [selectedObjects, setSelectedObjects] = React.useState<ReadonlySet<string>>(() => new Set())
  const [selectedWires, setSelectedWires] = React.useState<ReadonlySet<string>>(() => new Set())

  const setDoc = React.useCallback(
    (fn: (d: Schematic) => Schematic, opts: { silent?: boolean } = {}) => {
      setHistory((h) => {
        const present = fn(h.present)
        if (present === h.present) return h
        if (opts.silent) return { ...h, present }
        return { past: [...h.past.slice(1 - HISTORY_LIMIT), h.present], present, future: [] }
      })
    },
    [],
  )

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
      return { past: h.past.slice(0, -1), present, future: [h.present, ...h.future] }
    })
  }, [pruneSelection])

  const redo = React.useCallback(() => {
    setHistory((h) => {
      const next = h.future[0]
      if (!next) return h
      const present = keepLive(next, h.present)
      pruneSelection(present)
      return { past: [...h.past, h.present], present, future: h.future.slice(1) }
    })
  }, [pruneSelection])

  const canUndo = history.past.length > 0
  const canRedo = history.future.length > 0

  /** Place a component centered at a world point, snapped to the grid. */
  const add = React.useCallback(
    (defId: string, center: Point) => {
      const def = getDef(defId)
      if (!def) return
      const obj: PlacedObject = {
        id: crypto.randomUUID(),
        def: defId,
        x: snap(center.x - (def.width * grid) / 2, grid),
        y: snap(center.y - (def.height * grid) / 2, grid),
      }
      setDoc((d) => {
        if (def.prefix) obj.props = { ref: nextRef(d.objects, def.prefix) }
        return { ...d, objects: [...d.objects, obj] }
      })
      setSelectedObjects(new Set([obj.id]))
      setSelectedWires(new Set())
      return obj
    },
    [grid, setDoc],
  )

  /** Remove objects (with their wires and part state) and wires. */
  const remove = React.useCallback((objects: ReadonlySet<string>, wires: ReadonlySet<string>) => {
    setDoc((d) => ({
      objects: d.objects.filter((o) => !objects.has(o.id)),
      wires: d.wires.filter(
        (w) => !wires.has(w.id) && !objects.has(w.from.object) && !objects.has(w.to.object),
      ),
      parts: Object.fromEntries(
        Object.entries(d.parts).filter(([k]) => !objects.has(k.split(":")[0])),
      ),
    }))
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

  /** Replace the whole document (loading an example or a file; the boards' projects, build options and debugger settings are re-checked). */
  const load = React.useCallback(
    (next: Schematic) => {
      setDoc(() => ({ ...next, objects: next.objects.map(checked) }))
      setSelectedObjects(new Set())
      setSelectedWires(new Set())
    },
    [setDoc],
  )

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

  const selectWire = React.useCallback((id: string, toggle = false) => {
    setSelectedObjects(new Set())
    setSelectedWires((s) => {
      if (!toggle) return s.has(id) ? s : new Set([id])
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
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
      setSelectedObjects(
        new Set(doc.objects.filter((o) => intersects(objectRect(o, grid), rect)).map((o) => o.id)),
      )
      setSelectedWires(new Set())
    },
    [doc.objects, grid],
  )

  const moveTo = React.useCallback(
    (from: ReadonlyMap<string, Point>, dx: number, dy: number) => {
      const sdx = snap(dx, grid)
      const sdy = snap(dy, grid)
      setDoc((d) => ({
        ...d,
        objects: d.objects.map((o) => {
          const p = from.get(o.id)
          return p ? { ...o, x: p.x + sdx, y: p.y + sdy } : o
        }),
        // Bends of wires whose both ends move travel along.
        wires: d.wires.map((w) =>
          w.points && from.has(w.from.object) && from.has(w.to.object)
            ? { ...w, points: w.points.map((p) => ({ x: p.x + sdx, y: p.y + sdy })) }
            : w,
        ),
      }))
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

  /** Replace a board's firmware sources; typing is not an undo step (see `undo`). */
  const setProject = React.useCallback((id: string, files: SourceFile[]) => {
    setDoc((d) => ({ ...d, objects: d.objects.map((o) => (o.id === id ? { ...o, project: files } : o)) }), { silent: true })
  }, [setDoc])

  /** A board's build options; not an undo step. */
  const setBuild = React.useCallback((id: string, build: NonNullable<PlacedObject["build"]>) => {
    setDoc((d) => ({ ...d, objects: d.objects.map((o) => (o.id === id ? { ...o, build } : o)) }), { silent: true })
  }, [setDoc])

  /** A board's debugger settings (breakpoints, added sources, watches); not an undo step. */
  const setDebug = React.useCallback((id: string, fn: (d: BoardDebug) => BoardDebug) => {
    setDoc((d) => ({ ...d, objects: d.objects.map((o) => (o.id === id ? { ...o, debug: fn(o.debug ?? {}) } : o)) }), { silent: true })
  }, [setDoc])

  /** Rotate objects by ±45° around their centers, keeping the centre on the grid. */
  const rotate = React.useCallback(
    (ids: ReadonlySet<string>, delta: 45 | -45) => {
      setDoc((d) => ({
        ...d,
        objects: d.objects.map((o) => {
          if (!ids.has(o.id)) return o
          const def = getDef(o.def)
          if (!def) return o
          const rotation = (((o.rotation ?? 0) + delta + 360) % 360) as Rotation
          const before = objectSize(def, o.rotation)
          const after = objectSize(def, rotation)
          const cx = o.x + (before.w * grid) / 2
          const cy = o.y + (before.h * grid) / 2
          return { ...o, rotation, x: snap(cx - (after.w * grid) / 2, grid), y: snap(cy - (after.h * grid) / 2, grid) }
        }),
      }))
    },
    [grid, setDoc],
  )

  /** Connect two pins, optionally through bend points. Duplicate and self connections are ignored. */
  const addWire = React.useCallback(
    (from: PinRef, to: PinRef, points: Point[] = [], color?: WireColorKey) => {
      setDoc((d) => connectPins(d, from, to, points, color))
    },
    [setDoc],
  )

  const setWireColors = React.useCallback(
    (entries: Iterable<readonly [string, WireColorKey | undefined]>) => {
      const next = new Map(entries)
      if (next.size === 0) return
      setDoc((d) => ({
        ...d,
        wires: d.wires.map((w) => (next.has(w.id) ? recolor(w, next.get(w.id)) : w)),
      }))
    },
    [setDoc],
  )

  /**
   * Tap an existing wire at `at` (any world point near it): a junction goes in where the point
   * projects onto the wire, the wire is split through it and a new wire runs from `from` to
   * the junction. Wires join pins, so a branch off the middle of one needs a node to branch at.
   */
  const tapWire = React.useCallback(
    (wireId: string, at: Point, from: PinRef, points: Point[] = [], color?: WireColorKey) => {
      setDoc((d) => tapWireAt(d, wireId, at, from, grid, points, color))
      setSelectedWires(new Set())
    },
    [grid, setDoc],
  )

  const setWirePoints = React.useCallback(
    (id: string, points: Point[]) => {
      setDoc((d) => ({
        ...d,
        wires: d.wires.map((w) => (w.id === id ? { ...w, points: points.length ? points : undefined } : w)),
      }))
    },
    [setDoc],
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
  const copySelected = React.useCallback((): Clip | null => {
    if (selectedObjects.size === 0) return null
    const objects = doc.objects.filter((o) => selectedObjects.has(o.id))
    const wires = doc.wires.filter((w) => selectedObjects.has(w.from.object) && selectedObjects.has(w.to.object))
    const parts = Object.fromEntries(Object.entries(doc.parts).filter(([k]) => selectedObjects.has(k.split(":")[0])))
    return { objects, wires, parts }
  }, [doc, selectedObjects])

  /**
   * Add a clip's contents shifted by (dx, dy), under fresh ids and free designators, and
   * select what was added. Pasting the same clip twice yields two independent copies.
   */
  const paste = React.useCallback(
    (clip: Clip, dx: number, dy: number) => {
      const ids = new Map(clip.objects.map((o) => [o.id, crypto.randomUUID()]))
      const sdx = snap(dx, grid)
      const sdy = snap(dy, grid)
      const remap = (p: PinRef): PinRef => ({ object: ids.get(p.object) ?? p.object, pin: p.pin })
      setDoc((d) => {
        const objects = [...d.objects]
        for (const o of clip.objects) {
          const prefix = getDef(o.def)?.prefix
          const next: PlacedObject = { ...o, id: ids.get(o.id)!, x: o.x + sdx, y: o.y + sdy }
          if (prefix) next.props = { ...o.props, ref: nextRef(objects, prefix) }
          objects.push(next)
        }
        const wires = clip.wires
          .filter((w) => ids.has(w.from.object) && ids.has(w.to.object))
          .map((w) => ({
            ...w,
            id: crypto.randomUUID(),
            from: remap(w.from),
            to: remap(w.to),
            points: w.points?.map((p) => ({ x: p.x + sdx, y: p.y + sdy })),
          }))
        const parts = { ...d.parts }
        for (const [k, v] of Object.entries(clip.parts)) {
          const [object, part] = k.split(":")
          const id = ids.get(object)
          if (id) parts[partKey(id, part)] = v
        }
        return { ...d, objects, wires: [...d.wires, ...wires], parts }
      })
      setSelectedObjects(new Set(ids.values()))
      setSelectedWires(new Set())
    },
    [grid, setDoc],
  )

  return {
    doc,
    selectedObjects,
    selectedWires,
    add,
    remove,
    removeSelected,
    clear,
    load,
    selectObject,
    selectWire,
    selectAll,
    deselectAll,
    selectInRect,
    moveTo,
    rotate,
    setProps,
    setProject,
    setBuild,
    setDebug,
    addWire,
    tapWire,
    setWirePoints,
    setWireColors,
    setPart,
    undo,
    redo,
    canUndo,
    canRedo,
    copySelected,
    paste,
  }
}
