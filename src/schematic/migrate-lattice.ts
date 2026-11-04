import { PointGrid } from "./contacts"
import { diagonalSquare, GRID, isDiagonal, objectPins, objectSize, orientationOf, orientOffset, rotationAllowed, type Point } from "./geometry"
import { buildNets } from "./nets"
import { getDef } from "./registry"
import type { ComponentDef, PinDef, PinRef, PlacedObject, Rotation, Schematic, Wire } from "./types"

const BEFORE_THE_LATTICE: Record<string, { height?: number; pins?: Record<string, Point> }> = {
  oscillator: { pins: { OUT: { x: 4, y: 1.5 } } },
  tp4056: { pins: { GND: { x: 4.5, y: 8 } } },
  dw03: { pins: { GND: { x: 1, y: 3.5 }, VM: { x: 7, y: 3.5 } } },
  mt3608: { pins: { GND: { x: 4.5, y: 6 } } },
  lp2985: { pins: { GND: { x: 4.5, y: 6 } } },
  "oled-ssd1306-i2c-32": { height: 5.6 },
  "open746i-c": { pins: { VBAT: { x: 18.3, y: 12.43 }, "VREF+": { x: 19.3, y: 12.43 }, BOOT0: { x: 15.02, y: 33.72 } } },
}

const changedByTheLattice = (def: ComponentDef) => def.id in BEFORE_THE_LATTICE

const drawnBefore = new WeakMap<ComponentDef, ComponentDef>()

function asDrawnBefore(def: ComponentDef): ComponentDef {
  const was = BEFORE_THE_LATTICE[def.id]
  if (!was) return def
  const cached = drawnBefore.get(def)
  if (cached) return cached
  const pins = def.pins.map((pin): PinDef => (was.pins?.[pin.id] ? { ...pin, ...was.pins[pin.id] } : pin))
  const old = { ...def, height: was.height ?? def.height, pins }
  drawnBefore.set(def, old)
  return old
}

const R = Math.SQRT1_2

function sizeBefore(def: ComponentDef, rotation: Rotation) {
  const c = rotation % 90 ? R : rotation % 180 ? 0 : 1
  const s = rotation % 90 ? R : rotation % 180 ? 1 : 0
  return { w: def.width * c + def.height * s, h: def.width * s + def.height * c }
}

type Touch = { key: string; x: number; y: number }

function pinsBefore(o: PlacedObject): Touch[] {
  const def = getDef(o.def)
  if (!def) return []
  const old = asDrawnBefore(def)
  const orientation = orientationOf(o)
  const box = sizeBefore(old, orientation.rotation)
  return old.pins.flatMap((pin) => {
    if (pin.kind === "nc") return []
    const at = orientOffset({ x: pin.x - old.width / 2, y: pin.y - old.height / 2 }, orientation)
    return [{ key: `${o.id}:${pin.id}`, x: o.x + (at.x + box.w / 2) * GRID, y: o.y + (at.y + box.h / 2) * GRID }]
  })
}

class Union {
  private readonly parent = new Map<string, string>()

  find(key: string): string {
    let root = key
    for (let up = this.parent.get(root); up !== undefined && up !== root; up = this.parent.get(root)) root = up
    for (let at = key; at !== root; ) {
      const up = this.parent.get(at)!
      this.parent.set(at, root)
      at = up
    }
    return root
  }

  join(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb)
  }
}

function circuitBefore(doc: Schematic): { netOf: (key: string) => string; touching: string[][] } {
  const nets = new Union()
  for (const w of doc.wires) nets.join(`${w.from.object}:${w.from.pin}`, `${w.to.object}:${w.to.pin}`)
  const index = new PointGrid<Touch>()
  const pins = doc.objects.flatMap(pinsBefore)
  index.add(pins)
  const touching: string[][] = []
  const seen = new Set<string>()
  for (const p of pins) {
    if (seen.has(p.key)) continue
    const group = index.at(p.x, p.y).map((q) => q.key)
    for (const key of group) seen.add(key)
    if (group.length < 2) continue
    touching.push(group)
    for (const key of group) nets.join(group[0], key)
  }
  return { netOf: (key) => nets.find(key), touching }
}

function circuitNow(doc: Schematic): (key: string) => string {
  const nets = buildNets(doc.objects, doc.wires, GRID)
  return (key) => nets.netOfPin(key) ?? key
}

type Option = { object: PlacedObject; cost: number }

const SHIFT_COST = 1000
const NEAREST = 4
const EXHAUSTIVE = 4096
const JOIN_WEIGHT = 10
const RINGS = [2, 4]
const FAR_CELLS = 1.5

function pinsMiddleBefore(o: PlacedObject, def: ComponentDef): Point {
  const [a, b] = def.pins
  const at = orientOffset({ x: (a.x + b.x) / 2 - def.width / 2, y: (a.y + b.y) / 2 - def.height / 2 }, orientationOf(o))
  const box = sizeBefore(def, o.rotation ?? 0)
  return { x: o.x / GRID + box.w / 2 + at.x, y: o.y / GRID + box.h / 2 + at.y }
}

function squaresAround(o: PlacedObject, def: ComponentDef, reach: number): Option[] {
  const middle = pinsMiddleBefore(o, def)
  const half = diagonalSquare(def)! / 2
  const x0 = Math.floor(middle.x - half)
  const y0 = Math.floor(middle.y - half)
  const out: Option[] = []
  for (let x = x0 - reach + 1; x <= x0 + reach; x++)
    for (let y = y0 - reach + 1; y <= y0 + reach; y++) out.push({ object: { ...o, x: x * GRID, y: y * GRID }, cost: (x + half - middle.x) ** 2 + (y + half - middle.y) ** 2 })
  return out.sort((a, b) => a.cost - b.cost)
}

function turnedTo(o: PlacedObject, def: ComponentDef, rotation: Rotation): PlacedObject {
  const before = sizeBefore(asDrawnBefore(def), o.rotation ?? 0)
  const size = objectSize(def, rotation)
  const { rotation: _diagonal, ...rest } = o
  return { ...rest, ...(rotation && { rotation }), x: Math.round(o.x / GRID + before.w / 2 - size.w / 2) * GRID, y: Math.round(o.y / GRID + before.h / 2 - size.h / 2) * GRID }
}

const shifted = (o: PlacedObject, dx: number, dy: number): PlacedObject => ({ ...o, x: o.x + dx * GRID, y: o.y + dy * GRID })

function shiftsOf(placements: readonly { object: PlacedObject; cost: number }[], reach: number): Option[] {
  const out: Option[] = []
  for (const { object, cost } of placements)
    for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) out.push({ object: dx || dy ? shifted(object, dx, dy) : object, cost: cost + (dx || dy ? SHIFT_COST + dx * dx + dy * dy : 0) })
  return out.sort((a, b) => a.cost - b.cost)
}

function optionsFor(o: PlacedObject, def: ComponentDef, reach: number): Option[] {
  if (isDiagonal(o.rotation ?? 0) && diagonalSquare(def) !== null) return squaresAround(o, def, reach)
  if (isDiagonal(o.rotation ?? 0)) {
    const back = turnedTo(o, def, ((o.rotation ?? 0) - 45) as Rotation)
    const forth = turnedTo(o, def, (((o.rotation ?? 0) + 45) % 360) as Rotation)
    return shiftsOf([{ object: back, cost: 0 }, { object: forth, cost: 0.5 }], reach - 1)
  }
  return shiftsOf([{ object: o, cost: 0 }], reach - 1)
}

export function onARightAngle(o: PlacedObject, def: ComponentDef): PlacedObject {
  return turnedTo(o, def, ((o.rotation ?? 0) - 45) as Rotation)
}

export function uprightOnTheLattice(o: PlacedObject): PlacedObject {
  const def = getDef(o.def)
  return def && !rotationAllowed(def, o.rotation ?? 0) ? onARightAngle(o, def) : o
}

type Pin = { key: string; net: string; point: string }

const pointOf = (p: Point) => `${p.x},${p.y}`

function pinsOf(o: PlacedObject, netOf: (key: string) => string): Pin[] {
  return objectPins(o, GRID).flatMap(({ key, pin, point }) => (pin.kind === "nc" ? [] : [{ key, net: netOf(key), point: pointOf(point) }]))
}

class Occupancy {
  private readonly nets = new Map<string, string[]>()

  add(pins: readonly Pin[]) {
    for (const pin of pins) this.nets.set(pin.point, [...(this.nets.get(pin.point) ?? []), pin.net])
  }

  remove(pins: readonly Pin[]) {
    for (const pin of pins) {
      const at = this.nets.get(pin.point)!
      at.splice(at.indexOf(pin.net), 1)
      if (!at.length) this.nets.delete(pin.point)
    }
  }

  score(pins: readonly Pin[]): number | null {
    let joins = 0
    for (const pin of pins) {
      const there = this.nets.get(pin.point) ?? []
      if (there.some((net) => net !== pin.net)) return null
      joins += there.length
    }
    return joins
  }
}

type Mover = { id: string; options: Option[]; pins: Pin[][] }

function solve(cluster: readonly Mover[], taken: Occupancy): Map<string, Option> | null {
  const widths = cluster.map((m) => Math.min(NEAREST, m.options.length))
  const assignments = widths.reduce((n, w) => n * w, 1)
  let best: { pick: number[]; score: number } | null = null
  if (assignments <= EXHAUSTIVE) {
    for (let k = 0; k < assignments; k++) {
      const pick = cluster.map((_, i) => Math.floor(k / widths.slice(0, i).reduce((n, w) => n * w, 1)) % widths[i])
      let score: number | null = 0
      const placed: Pin[][] = []
      for (let i = 0; i < cluster.length && score !== null; i++) {
        const pins = cluster[i].pins[pick[i]]
        const joins = taken.score(pins)
        if (joins === null) score = null
        else {
          score += joins * JOIN_WEIGHT - cluster[i].options[pick[i]].cost
          taken.add(pins)
          placed.push(pins)
        }
      }
      for (const pins of placed) taken.remove(pins)
      if (score !== null && (!best || score > best.score)) best = { pick, score }
    }
  }
  if (best) return new Map(cluster.map((m, i) => [m.id, m.options[best!.pick[i]]]))
  const chosen = new Map<string, Option>()
  const added: Pin[][] = []
  const undo = () => added.forEach((pins) => taken.remove(pins))
  for (const m of cluster) {
    let pick = -1
    let pickScore = -Infinity
    m.options.forEach((option, i) => {
      const joins = taken.score(m.pins[i])
      if (joins !== null && joins * JOIN_WEIGHT - option.cost > pickScore) {
        pick = i
        pickScore = joins * JOIN_WEIGHT - option.cost
      }
    })
    if (pick < 0) {
      undo()
      return null
    }
    chosen.set(m.id, m.options[pick])
    taken.add(m.pins[pick])
    added.push(m.pins[pick])
  }
  undo()
  return chosen
}

function clustersOf(movers: readonly Mover[]): Mover[][] {
  const groups = new Union()
  const firstAt = new Map<string, string>()
  for (const m of movers) {
    groups.find(m.id)
    for (const pins of m.pins)
      for (const pin of pins) {
        const other = firstAt.get(pin.point)
        if (other === undefined) firstAt.set(pin.point, m.id)
        else groups.join(other, m.id)
      }
  }
  const clusters = new Map<string, Mover[]>()
  for (const m of movers) clusters.set(groups.find(m.id), [...(clusters.get(groups.find(m.id)) ?? []), m])
  return [...clusters.values()]
}

const nameOf = (o: PlacedObject) => o.props?.ref || getDef(o.def)?.name || o.def

const listed = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`)

function meetsItself(wire: Wire, objects: ReadonlyMap<string, PlacedObject>) {
  const ends = [wire.from, wire.to].map((end) => {
    const object = objects.get(end.object)
    const pin = object && objectPins(object, GRID).find((p) => p.pin.id === end.pin)
    return pin && pin.pin.kind !== "nc" ? pointOf(pin.point) : null
  })
  return ends[0] !== null && ends[0] === ends[1]
}

const refOf = (key: string): PinRef => ({ object: key.slice(0, key.indexOf(":")), pin: key.slice(key.indexOf(":") + 1) })

function pinName(key: string, objects: ReadonlyMap<string, PlacedObject>) {
  const { object, pin } = refOf(key)
  const o = objects.get(object)
  return `${o ? nameOf(o) : object} ${pin}`
}

function partition(doc: Schematic, netOf: (key: string) => string): Map<string, string> {
  const groups = new Map<string, string[]>()
  for (const o of doc.objects) for (const { key } of objectPins(o, GRID)) groups.set(netOf(key), [...(groups.get(netOf(key)) ?? []), key])
  const out = new Map<string, string>()
  for (const keys of groups.values()) {
    const first = [...keys].sort()[0]
    for (const key of keys) out.set(key, first)
  }
  return out
}

export function partsOnTheLattice(doc: Schematic, newId: () => string = () => crypto.randomUUID()): { doc: Schematic; notes: string[] } {
  const moving = doc.objects.filter((o) => {
    const def = getDef(o.def)
    return def && (isDiagonal(o.rotation ?? 0) || changedByTheLattice(def))
  })
  if (!moving.length) return { doc, notes: [] }
  const before = circuitBefore(doc)
  const movingIds = new Set(moving.map((o) => o.id))
  const taken = new Occupancy()
  for (const o of doc.objects) if (!movingIds.has(o.id)) taken.add(pinsOf(o, before.netOf))
  const chosen = new Map<string, PlacedObject>()
  const forced: string[] = []
  const moverOf = (o: PlacedObject, reach: number): Mover => {
    const options = optionsFor(o, getDef(o.def)!, reach)
    return { id: o.id, options, pins: options.map((option) => pinsOf(option.object, before.netOf)) }
  }
  const pending = moving.map((o) => moverOf(o, RINGS[0]))
  for (const cluster of clustersOf(pending)) {
    let picked = solve(cluster, taken)
    if (!picked) picked = solve(cluster.map((m) => moverOf(doc.objects.find((o) => o.id === m.id)!, RINGS[1])), taken)
    for (const m of cluster) {
      const option = picked?.get(m.id) ?? m.options[0]
      if (!picked) forced.push(m.id)
      chosen.set(m.id, option.object)
      taken.add(pinsOf(option.object, before.netOf))
    }
  }
  const objects = doc.objects.map((o) => chosen.get(o.id) ?? o)
  const byId = new Map(objects.map((o) => [o.id, o]))
  const folded = doc.wires.filter((w) => (movingIds.has(w.from.object) || movingIds.has(w.to.object)) && meetsItself(w, byId))
  let wires = doc.wires.filter((w) => !folded.includes(w))
  const now = circuitNow({ ...doc, objects, wires })
  const rejoined: Wire[] = []
  for (const group of before.touching) {
    for (const key of group.slice(1)) {
      if (now(key) === now(group[0]) || rejoined.some((w) => [`${w.from.object}:${w.from.pin}`, `${w.to.object}:${w.to.pin}`].includes(key))) continue
      rejoined.push({ id: newId(), from: refOf(group[0]), to: refOf(key) })
    }
  }
  wires = [...wires, ...rejoined]
  const upgraded: Schematic = { ...doc, objects, wires }
  const notes: string[] = []
  for (const o of moving) {
    const def = getDef(o.def)!
    const placed = byId.get(o.id)!
    if (isDiagonal(o.rotation ?? 0) && diagonalSquare(def) !== null && isDiagonal(placed.rotation ?? 0)) {
      const was = pinsMiddleBefore(o, def)
      const half = diagonalSquare(def)! / 2
      const away = Math.hypot(placed.x / GRID + half - was.x, placed.y / GRID + half - was.y)
      if (away > FAR_CELLS) notes.push(`${nameOf(o)} moved ${Math.round(away)} cells onto the grid: nearer, its pins would have touched another net's.`)
    }
    if (isDiagonal(o.rotation ?? 0) && !isDiagonal(placed.rotation ?? 0)) notes.push(`${nameOf(o)} stood at ${o.rotation}°, which it cannot take now: turned to ${placed.rotation ?? 0}°.`)
    else if (!isDiagonal(o.rotation ?? 0) && changedByTheLattice(def) && (placed.x !== o.x || placed.y !== o.y)) notes.push(`${nameOf(o)} moved ${Math.round(Math.hypot(placed.x - o.x, placed.y - o.y) / GRID)} cell${Math.hypot(placed.x - o.x, placed.y - o.y) > GRID ? "s" : ""}: its pins, now on the grid, would have touched another net's where it stood.`)
  }
  if (folded.length) {
    const met = [...new Set(folded.flatMap((w) => [w.from.object, w.to.object]))].map((id) => nameOf(byId.get(id)!)).sort()
    notes.push(`${listed(met)} now meet pin to pin on the grid, so the ${folded.length === 1 ? "wire" : `${folded.length} wires`} between those pins went.`)
  }
  for (const w of rejoined) notes.push(`${pinName(`${w.from.object}:${w.from.pin}`, byId)} and ${pinName(`${w.to.object}:${w.to.pin}`, byId)} touched where they stood before; a wire joins them now.`)
  const was = partition(doc, before.netOf)
  const is = partition(upgraded, circuitNow(upgraded))
  const astray = [...new Set([...was.keys()].filter((key) => was.get(key) !== is.get(key)).map((key) => refOf(key).object))].flatMap((id) => (byId.has(id) ? [nameOf(byId.get(id)!)] : [])).sort()
  if (astray.length) notes.push(`The circuit round ${listed(astray)} could not be kept exactly: check its connections.`)
  else if (forced.length) notes.push(`${listed(forced.map((id) => nameOf(byId.get(id)!)).sort())} found no spot on the grid nearby that keeps clear of every other net; check where they stand.`)
  return { doc: upgraded, notes }
}
