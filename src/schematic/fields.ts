import { bodyAndLeads } from "./body"
import { DIR, framePoint, orientationOf, orientPin, standsOnItsDiagonal, unorientOffset, type Direction, type Orientation, type Point, type Rect, type TextAnchor } from "./geometry"
import { getDef } from "./registry"
import type { BodyShape, ComponentDef, PlacedObject } from "./types"

export type FieldKey = "ref" | "value"

export type FieldSide = "right" | "top" | "left" | "bottom"

export type FieldTemplate = { key: FieldKey; text: string; size: number; muted: boolean }

export type PlacedField = { object: string; key: FieldKey; text: string; at: Point; box: Rect; angle: 0 | -90; anchor: TextAnchor; side: FieldSide; moved: boolean }

const KEYS: readonly FieldKey[] = ["ref", "value"]
const FIELD_TEXT = /\{(ref|value)\}/
const DEFAULT_SIZE = 0.4
const TEXT_ADVANCE_EM = 0.55
const HPADDING = 0.25
const VPADDING = 0.15
const FIELD_GRID = 0.5
const WIDE = 3

type TextShape = Extract<BodyShape, { type: "text" }>

const isFieldText = (shape: BodyShape): shape is TextShape => shape.type === "text" && FIELD_TEXT.test(shape.text)

export const drawsAsField = (shape: BodyShape): boolean => isFieldText(shape)

const templateCache = new WeakMap<ComponentDef, readonly FieldTemplate[]>()

export function fieldTemplates(def: ComponentDef): readonly FieldTemplate[] {
  const cached = templateCache.get(def)
  if (cached) return cached
  const texts = def.body.filter(isFieldText)
  const templates = KEYS.flatMap((key): FieldTemplate[] => {
    const shape = texts.find((s) => s.text.includes(`{${key}}`) && (key === "ref" || !s.text.includes("{ref}")))
    return shape ? [{ key, text: shape.text, size: shape.size ?? DEFAULT_SIZE, muted: !!shape.muted }] : []
  })
  templateCache.set(def, templates)
  return templates
}

const bodyCache = new WeakMap<ComponentDef, readonly BodyShape[]>()

export function bodyWithoutFields(def: ComponentDef): readonly BodyShape[] {
  let found = bodyCache.get(def)
  if (!found) bodyCache.set(def, (found = def.body.filter((s) => !isFieldText(s))))
  return found
}

type SideVector = { name: FieldSide; x: -1 | 0 | 1; y: -1 | 0 | 1 }

const SIDES: Record<FieldSide, SideVector> = {
  right: { name: "right", x: 1, y: 0 },
  top: { name: "top", x: 0, y: -1 },
  left: { name: "left", x: -1, y: 0 },
  bottom: { name: "bottom", x: 0, y: 1 },
}

const sidesOfDirection = (direction: Direction): FieldSide[] => {
  const d = DIR[direction]
  return [...(d.x > 0.1 ? ["right" as const] : d.x < -0.1 ? ["left" as const] : []), ...(d.y > 0.1 ? ["bottom" as const] : d.y < -0.1 ? ["top" as const] : [])]
}

type Placement = { def: ComponentDef; orientation: Orientation; body: Rect; pins: { at: Point; inner: Point; sides: FieldSide[] }[] }

function placementOf(def: ComponentDef, orientation: Orientation): Placement {
  const { box, leads } = bodyAndLeads(def)
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((p) => framePoint(def, orientation, p))
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const body = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  const pins = def.pins.map((pin) => {
    const placed = orientPin(pin, def, orientation)
    const lead = leads.find(([at]) => Math.abs(at.x - pin.x) < 1e-6 && Math.abs(at.y - pin.y) < 1e-6)
    const inner = lead ? framePoint(def, orientation, lead[1]) : { x: placed.x, y: placed.y }
    return { at: { x: placed.x, y: placed.y }, inner, sides: sidesOfDirection(placed.side) }
  })
  return { def, orientation, body, pins }
}

const isPowerSymbol = (def: ComponentDef) => def.pins.length === 1 && (def.pins[0].kind === "gnd" || def.pins[0].kind === "power")

const swap = <T>(list: T[], i: number, j: number) => {
  const t = list[i]
  list[i] = list[j]
  list[j] = t
}

function preferredSides(p: Placement): FieldSide[] {
  const sides: FieldSide[] = ["right", "top", "left", "bottom"]
  const turn = ((p.orientation.rotation % 360) + 360) % 360
  if (isPowerSymbol(p.def)) {
    if (turn === 0) {
      swap(sides, 0, 1)
      swap(sides, 1, 3)
    } else if (turn === 90) {
      swap(sides, 0, 2)
      swap(sides, 1, 2)
    } else if (turn === 180) swap(sides, 0, 3)
    else if (turn === 270) swap(sides, 1, 2)
    return sides
  }
  if (p.orientation.mirror && (turn === 0 || turn === 180)) swap(sides, 0, 2)
  if (p.body.h > 0 && p.body.w / p.body.h > WIDE) {
    swap(sides, 0, 1)
    swap(sides, 1, 3)
  }
  return sides
}

const pinsOn = (p: Placement, side: FieldSide) => p.pins.filter((pin) => pin.sides.includes(side))

function chosenSide(p: Placement): { side: SideVector; pins: number } {
  const order = preferredSides(p).map((name) => ({ side: SIDES[name], pins: pinsOn(p, name).length }))
  const empty = order.find((s) => s.pins === 0)
  if (empty) return empty
  return order.reduce((best, s) => (s.pins < best.pins ? s : best))
}

export function autoplaceSide(def: ComponentDef, orientation: Orientation): FieldSide {
  return chosenSide(placementOf(def, orientation)).side.name
}

const roundAway = (v: number, up: boolean) => {
  const steps = v / FIELD_GRID
  const whole = Math.round(steps)
  if (Math.abs(steps - whole) < 1e-9) return whole * FIELD_GRID
  return (up ? Math.ceil(steps) : Math.floor(steps)) * FIELD_GRID
}

const roundedUp = (h: number) => Math.ceil(h / FIELD_GRID - 1e-9) * FIELD_GRID

const widthOf = (text: string, size: number) => text.length * TEXT_ADVANCE_EM * size

function propsOf(def: ComponentDef, object: PlacedObject): Record<string, string> {
  const props = { ...def.defaults, ...object.props }
  return def.derive ? { ...props, ...def.derive(props) } : props
}

type Sized = { template: FieldTemplate; text: string; w: number; h: number }

const boxAt = (at: Point, anchor: TextAnchor, w: number, h: number): Rect => ({ x: anchor === "start" ? at.x : anchor === "end" ? at.x - w : at.x - w / 2, y: at.y - h / 2, w, h })

function autoplaced(p: Placement, fields: readonly Sized[]): Placed[] {
  const { side, pins } = chosenSide(p)
  const width = Math.max(...fields.map((f) => f.w))
  const height = fields.reduce((sum, f) => sum + roundedUp(f.h), 0)
  const centre = { x: p.body.x + p.body.w / 2, y: p.body.y + p.body.h / 2 }
  const offsetX = (p.body.w + width) / 2 + (side.x ? HPADDING : 0)
  const offsetY = (p.body.h + height) / 2 + (!side.x && side.y ? VPADDING : 0)
  let x = centre.x + side.x * offsetX - width / 2
  let y = centre.y + side.y * offsetY - height / 2
  if (pins > 0) {
    const onSide = pinsOn(p, side.name)
    const points = onSide.flatMap((pin) => [pin.at, pin.inner])
    if (side.y) x = Math.max(...points.map((q) => q.x)) + HPADDING * 2
    else y = Math.min(...points.map((q) => q.y)) - (height + VPADDING * 2)
  }
  const justified: TextAnchor = pins > 0 ? (side.y ? "start" : "middle") : side.x > 0 ? "start" : side.x < 0 ? "end" : "middle"
  let top = y
  return fields.map((f) => {
    const padding = roundedUp(f.h) - f.h
    let atY = top + padding / 2 + f.h / 2
    top += padding + f.h
    let atX = justified === "start" ? x : justified === "end" ? x + width : x + width / 2
    if (side.x) atX = roundAway(atX, side.x >= 0)
    if (side.y) atY = roundAway(atY, side.y >= 0)
    return { at: { x: atX, y: atY }, anchor: justified, side: side.name }
  })
}

type Placed = { at: Point; anchor: TextAnchor; side: FieldSide }

function bodyCorners(def: ComponentDef, orientation: Orientation): Point[] {
  const { box } = bodyAndLeads(def)
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((p) => framePoint(def, orientation, p))
}

function besideTheDiagonal(def: ComponentDef, orientation: Orientation, fields: readonly Sized[]): Placed[] {
  const [a, b] = def.pins.map((pin) => orientPin(pin, def, orientation))
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  const across = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length }
  const up = across.y < 0 ? across : { x: -across.x, y: -across.y }
  const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const corners = bodyCorners(def, orientation)
  return fields.map((f, i) => {
    const n = i === 0 ? up : { x: -up.x, y: -up.y }
    const reach = Math.max(...corners.map((p) => (p.x - centre.x) * n.x + (p.y - centre.y) * n.y)) + VPADDING
    const corner = { x: centre.x, y: centre.y + reach / n.y }
    const anchor: TextAnchor = n.x >= 0 ? "start" : "end"
    return { at: { x: corner.x, y: corner.y + (n.y < 0 ? -f.h / 2 : f.h / 2) }, anchor, side: n.y < 0 ? "top" : "bottom" }
  })
}

const placedCache = new WeakMap<PlacedObject, { grid: number; def: ComponentDef; fields: readonly PlacedField[] }>()

export function placedFields(object: PlacedObject, grid: number, def: ComponentDef | undefined = getDef(object.def)): readonly PlacedField[] {
  if (!def) return []
  const cached = placedCache.get(object)
  if (cached && cached.grid === grid && cached.def === def) return cached.fields
  const props = propsOf(def, object)
  const sized = fieldTemplates(def).flatMap((template): Sized[] => {
    const text = template.text.replace(/\{(\w+)\}/g, (_, key: string) => props[key] ?? "")
    return text.trim() ? [{ template, text, w: widthOf(text, template.size), h: template.size }] : []
  })
  const orientation = orientationOf(object)
  const automatic: Placed[] = !sized.length ? [] : standsOnItsDiagonal(def, orientation.rotation) && def.pins.length === 2 ? besideTheDiagonal(def, orientation, sized) : autoplaced(placementOf(def, orientation), sized)
  const fields = sized.map((f, i): PlacedField => {
    const moved = object.fieldAt?.[f.template.key]
    const local = moved ? framePoint(def, orientation, moved) : automatic[i].at
    const anchor = moved ? "middle" : automatic[i].anchor
    const at = { x: object.x + local.x * grid, y: object.y + local.y * grid }
    return { object: object.id, key: f.template.key, text: f.text, at, box: boxAt(at, anchor, f.w * grid, f.h * grid), angle: 0, anchor, side: automatic[i].side, moved: !!moved }
  })
  placedCache.set(object, { grid, def, fields })
  return fields
}

export function withFieldAt(object: PlacedObject, key: FieldKey, middle: Point, grid: number, def: ComponentDef): PlacedObject {
  const local = { x: (middle.x - object.x) / grid, y: (middle.y - object.y) / grid }
  const orientation = orientationOf(object)
  const frame = framePoint(def, orientation, { x: def.width / 2, y: def.height / 2 })
  const back = unorientOffset({ x: local.x - frame.x, y: local.y - frame.y }, orientation)
  return { ...object, fieldAt: { ...object.fieldAt, [key]: { x: def.width / 2 + back.x, y: def.height / 2 + back.y } } }
}

export function withFieldMoved(object: PlacedObject, key: FieldKey, dx: number, dy: number, grid: number, def: ComponentDef | undefined = getDef(object.def)): PlacedObject {
  const field = def && placedFields(object, grid, def).find((f) => f.key === key)
  if (!def || !field) return object
  return withFieldAt(object, key, { x: field.box.x + field.box.w / 2 + dx, y: field.box.y + field.box.h / 2 + dy }, grid, def)
}
