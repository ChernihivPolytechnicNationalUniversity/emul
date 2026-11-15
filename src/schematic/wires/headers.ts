import { GRID } from "../grid"
import { isPrintedName, printedBox, printedGrowth } from "../printed-text"
import { getDef } from "../registry"
import type { BodyShape, ComponentDef, PinDef, PlacedObject, Point, Side } from "../types"
import type { WirePin } from "./segment"

type Printed = Extract<BodyShape, { type: "text" }>

type DefHeader = { readonly outer: readonly string[]; readonly reach: number | null }

const OUTWARD: Record<Side, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } }

const NAME_ROW_CELLS = 0.5
const NAME_REACH_CELLS = 2
const PLACES = 1e6

const dot = (p: Point, d: Point) => p.x * d.x + p.y * d.y

const acrossOf = (d: Point): Point => ({ x: Math.abs(d.y), y: Math.abs(d.x) })

function farthestEdge(name: Printed, growth: number, d: Point): number {
  const box = printedBox(name, growth)
  return Math.max(dot({ x: box.x, y: box.y }, d), dot({ x: box.x + box.w, y: box.y + box.h }, d), dot({ x: box.x + box.w, y: box.y }, d), dot({ x: box.x, y: box.y + box.h }, d))
}

function nameReach(def: ComponentDef, outer: readonly PinDef[], d: Point): number | null {
  const growth = printedGrowth(def)
  const names = def.body.filter((s): s is Printed => isPrintedName(s))
  const a = acrossOf(d)
  let edge: number | null = null
  for (const p of outer) {
    const name = names.find((s) => {
      const off = { x: s.x - p.x, y: s.y - p.y }
      return Math.abs(dot(off, a)) < NAME_ROW_CELLS && dot(off, d) > 0 && dot(off, d) < NAME_REACH_CELLS
    })
    if (!name) continue
    const reach = farthestEdge(name, growth.get(name) ?? 1, d)
    edge = edge === null ? reach : Math.max(edge, reach)
  }
  return edge === null ? null : edge - Math.max(...outer.map((p) => dot(p, d)))
}

const byDef = new WeakMap<ComponentDef, ReadonlyMap<string, DefHeader>>()

function headersOf(def: ComponentDef): ReadonlyMap<string, DefHeader> {
  const known = byDef.get(def)
  if (known) return known
  const at = new Map(def.pins.map((p) => [`${p.x},${p.y}`, p]))
  const ahead = (p: PinDef) => at.get(`${p.x + OUTWARD[p.side].x},${p.y + OUTWARD[p.side].y}`)
  const groups = new Map<string, PinDef[]>()
  if (def.pinsAreSockets)
    for (const p of def.pins) {
      if (!(p.side in OUTWARD) || ahead(p)) continue
      const key = `${p.connector ?? ""}|${p.side}`
      const group = groups.get(key)
      if (group) group.push(p)
      else groups.set(key, [p])
    }
  const outerOf = new Map<string, DefHeader>()
  for (const outer of groups.values()) {
    const header = { outer: outer.map((p) => p.id), reach: nameReach(def, outer, OUTWARD[outer[0].side]) }
    for (const p of outer) outerOf.set(p.id, header)
  }
  const byPin = new Map<string, DefHeader>()
  for (const p of def.pins) {
    if (!(p.side in OUTWARD)) continue
    let front = p
    for (let next = ahead(front); next; next = ahead(front)) front = next
    const header = outerOf.get(front.id)
    if (header && front.side === p.side) byPin.set(p.id, header)
  }
  byDef.set(def, byPin)
  return byPin
}

export type HeaderSide = {
  readonly out: Point
  readonly across: Point
  readonly outerAt: number
  readonly clearAt: number
  readonly from: number
  readonly to: number
}

export const alongOut = (p: Point, out: Point) => dot(p, out) / GRID

export const alongAcross = (p: Point, out: Point) => dot(p, acrossOf(out)) / GRID

export type PinsOf = (object: PlacedObject, id: string) => WirePin | undefined

function placed(object: PlacedObject, header: DefHeader, pinOf: PinsOf): HeaderSide | null {
  const outer = header.outer.flatMap((id) => {
    const pin = pinOf(object, id)
    return pin?.out ? [pin] : []
  })
  if (!outer.length) return null
  const out = outer[0].out!
  const outerAt = Math.max(...outer.map((p) => alongOut(p.at, out)))
  const clearAt = header.reach === null ? outerAt + 1 : Math.floor(Math.round((outerAt + header.reach) * PLACES) / PLACES) + 1
  const across = outer.map((p) => alongAcross(p.at, out))
  return { out, across: acrossOf(out), outerAt, clearAt, from: Math.min(...across), to: Math.max(...across) }
}

export function headerOfPin(object: PlacedObject, pin: string, pinOf: PinsOf): HeaderSide | null {
  const def = getDef(object.def)
  const header = def && headersOf(def).get(pin)
  return header ? placed(object, header, pinOf) : null
}

