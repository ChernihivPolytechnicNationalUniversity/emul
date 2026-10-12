import { objectSize, orientationOf, orientOffset, placedText, type Orientation, type Point, type Rect } from "@/schematic/geometry"
import { blocksOf, boxMeetsPolygon, homeOf, isPrintedName, printedGrowth } from "@/schematic/printed-text"
import { getDef } from "@/schematic/registry"
import type { BodyShape, ComponentDef, PlacedObject } from "@/schematic/types"
import { textBoost } from "./body-paint"
import { boundsOf, boxCorners, labelKnockout, MONO_ADVANCE_EM, type LabelAnchor, type LabelGround } from "./pin-label"

type Text = Extract<BodyShape, { type: "text" }>

export type PrintedName = { shape: Text; ground: LabelGround }

export type PlacedName = { id: string; shape: Text; ground: LabelGround; growth: number; x: number; y: number; from: Point; angle: number; anchor: LabelAnchor }

const names = new WeakMap<ComponentDef, readonly PrintedName[]>()

export function printedNames(def: ComponentDef): readonly PrintedName[] {
  const cached = names.get(def)
  if (cached) return cached
  const blocks = blocksOf(def.body)
  const found = def.body.filter((shape): shape is Text => isPrintedName(shape)).map((shape): PrintedName => ({ shape, ground: homeOf(blocks, shape)?.fill ?? "field" }))
  names.set(def, found)
  return found
}

function perOrientation<T>(compute: (def: ComponentDef, orientation: Orientation) => T) {
  const cache = new WeakMap<ComponentDef, Map<string, T>>()
  return (def: ComponentDef, orientation: Orientation): T => {
    const byOrientation = cache.get(def) ?? new Map<string, T>()
    cache.set(def, byOrientation)
    const key = `${orientation.rotation}|${orientation.mirror}`
    if (byOrientation.has(key)) return byOrientation.get(key)!
    const value = compute(def, orientation)
    byOrientation.set(key, value)
    return value
  }
}

function orientedIn(def: ComponentDef, orientation: Orientation) {
  const box = objectSize(def, orientation.rotation)
  return (p: Point): Point => {
    const at = orientOffset({ x: p.x - def.width / 2, y: p.y - def.height / 2 }, orientation)
    return { x: at.x + box.w / 2, y: at.y + box.h / 2 }
  }
}

export const printedNameLayout = perOrientation((def, orientation): readonly PlacedName[] => {
  const growth = printedGrowth(def)
  const onField = orientedIn(def, orientation)
  return printedNames(def).map(({ shape, ground }, i) => {
    const at = onField(shape)
    const placed = placedText(shape.anchor ?? "middle", shape.rotate ?? 0, orientation)
    return { id: `printed-${i}`, shape, ground, growth: growth.get(shape) ?? 1, ...at, from: shape.growsFrom ? onField(shape.growsFrom) : at, angle: placed.angle, anchor: placed.anchor }
  })
})

const bodyOutlines = perOrientation((def, orientation): readonly (readonly Point[])[] => {
  const onField = orientedIn(def, orientation)
  return blocksOf(def.body).map((block) => block.points.map(onField))
})

const coveredBy = (box: Rect, bodies: readonly (readonly Point[])[]) => bodies.some((outline) => boxMeetsPolygon(box, outline))

export const printedNameSize = (name: PlacedName, boost: number) => (name.shape.size ?? 0.4) * textBoost(name.shape, boost, name.growth)

export function printedNameAt(name: PlacedName, size: number): Point {
  const factor = size / (name.shape.size ?? 0.4)
  return { x: name.from.x + (name.x - name.from.x) * factor, y: name.from.y + (name.y - name.from.y) * factor }
}

export function printedNameBox(name: PlacedName, size: number, advanceEm: number): Rect {
  const { solid } = labelKnockout(name.shape.text, name.anchor, size, advanceEm)
  const turn = (name.angle * Math.PI) / 180
  const cos = Math.cos(turn)
  const sin = Math.sin(turn)
  const at = printedNameAt(name, size)
  return boundsOf(boxCorners(solid, (p) => ({ x: at.x + p.x * cos - p.y * sin, y: at.y + p.x * sin + p.y * cos })))
}

export type NameMetrics = { grid: number; boost: number; advanceEm: number }

export function printedNameOnField(object: PlacedObject, name: PlacedName, { grid, boost, advanceEm }: NameMetrics): Rect {
  const box = printedNameBox(name, printedNameSize(name, boost), advanceEm)
  return { x: object.x + box.x * grid, y: object.y + box.y * grid, w: box.w * grid, h: box.h * grid }
}

let measuredAdvanceEm: number | undefined

export function monoAdvanceEm() {
  if (measuredAdvanceEm !== undefined) return measuredAdvanceEm
  if (typeof document === "undefined") return MONO_ADVANCE_EM
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()
  const context = document.createElement("canvas").getContext("2d")
  if (!family || !context) return MONO_ADVANCE_EM
  context.font = `100px ${family}`
  measuredAdvanceEm = context.measureText("0").width / 100 || MONO_ADVANCE_EM
  return measuredAdvanceEm
}

function dockedAbove(objects: readonly PlacedObject[], contacts: ReadonlyMap<string, string>): ReadonlyMap<string, readonly PlacedObject[]> {
  const order = new Map(objects.map((object, i) => [object.id, i]))
  const touching = new Map<string, Set<string>>()
  for (const [key, root] of contacts) {
    const id = key.slice(0, key.indexOf(":"))
    const group = touching.get(root)
    if (group) group.add(id)
    else touching.set(root, new Set([id]))
  }
  const above = new Map<string, Set<string>>()
  for (const group of touching.values())
    for (const below of group)
      for (const over of group) {
        if ((order.get(over) ?? -1) <= (order.get(below) ?? Infinity)) continue
        const covers = above.get(below)
        if (covers) covers.add(over)
        else above.set(below, new Set([over]))
      }
  const byId = new Map(objects.map((object) => [object.id, object]))
  return new Map([...above].map(([id, over]) => [id, [...over].flatMap((cover) => byId.get(cover) ?? [])]))
}

function bodiesOnField(objects: readonly PlacedObject[], grid: number): Point[][] {
  return objects.flatMap((object) => {
    const def = getDef(object.def)
    return def ? bodyOutlines(def, orientationOf(object)).map((outline) => outline.map((p) => ({ x: object.x + p.x * grid, y: object.y + p.y * grid }))) : []
  })
}

const NO_NAMES: ReadonlySet<Text> = new Set()

export function namesUnderDocked(objects: readonly PlacedObject[], contacts: ReadonlyMap<string, string>, metrics: NameMetrics): (object: PlacedObject) => ReadonlySet<Text> {
  if (!contacts.size) return () => NO_NAMES
  const docked = dockedAbove(objects, contacts)
  return (object) => {
    const covers = docked.get(object.id)
    const def = getDef(object.def)
    if (!covers || !def) return NO_NAMES
    const bodies = bodiesOnField(covers, metrics.grid)
    const covered = printedNameLayout(def, orientationOf(object)).filter((name) => coveredBy(printedNameOnField(object, name, metrics), bodies))
    return new Set(covered.map((name) => name.shape))
  }
}

function segmentMeetsBox(p: Point, q: Point, box: Rect) {
  let from = 0
  let to = 1
  const dx = q.x - p.x
  const dy = q.y - p.y
  for (const [step, room] of [
    [-dx, p.x - box.x],
    [dx, box.x + box.w - p.x],
    [-dy, p.y - box.y],
    [dy, box.y + box.h - p.y],
  ]) {
    if (step === 0) {
      if (room < 0) return false
      continue
    }
    const t = room / step
    if (step < 0) from = Math.max(from, t)
    else to = Math.min(to, t)
    if (from > to) return false
  }
  return true
}

export function crossedBy(box: Rect, lines: readonly (readonly Point[])[]) {
  for (const pts of lines) for (let i = 1; i < pts.length; i++) if (segmentMeetsBox(pts[i - 1], pts[i], box)) return true
  return false
}
