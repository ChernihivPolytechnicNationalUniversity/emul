import { PointGrid } from "./contacts"
import { diagonalSquare, GRID, isDiagonal, objectPins, objectRect, objectSize, orientationOf, orientOffset, rotationAllowed, unionOf, type Point, type Rect } from "./geometry"
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
  const pins = doc.objects.flatMap(pinsBefore)
  const index = new PointGrid<Touch>()
  index.add(pins)
  const contacts = new Union()
  for (const p of pins)
    for (const q of index.at(p.x, p.y)) {
      contacts.join(p.key, q.key)
      nets.join(p.key, q.key)
    }
  const groups = new Map<string, Set<string>>()
  for (const p of pins) {
    const root = contacts.find(p.key)
    groups.set(root, (groups.get(root) ?? new Set<string>()).add(p.key))
  }
  return { netOf: (key) => nets.find(key), touching: [...groups.values()].filter((group) => group.size > 1).map((group) => [...group]) }
}

function circuitNow(doc: Schematic): (key: string) => string {
  const nets = buildNets(doc.objects, doc.wires, GRID)
  return (key) => nets.netOfPin(key) ?? key
}

type Option = { object: PlacedObject; cost: number }

const SHIFT_COST = 1000
const NEAREST = 4
const EXHAUSTIVE = 4096
const SEARCH_BUDGET = 200_000
const JOIN_WEIGHT = 10
const RINGS = [2, 4]
const FAR_CELLS = 1.5

const byCost = (a: Option, b: Option) => a.cost - b.cost

function ringOffsets(reach: number, inner: number, top: (ring: number) => number): [number, number][] {
  const out: [number, number][] = []
  const within = (d: number) => d >= 1 - inner && d <= top(inner)
  for (let dx = 1 - reach; dx <= top(reach); dx++)
    for (let dy = 1 - reach; dy <= top(reach); dy++) {
      if (within(dx) && within(dy)) {
        dy = top(inner)
        continue
      }
      out.push([dx, dy])
    }
  return out
}

function pinsMiddleBefore(o: PlacedObject, def: ComponentDef): Point {
  const [a, b] = def.pins
  const at = orientOffset({ x: (a.x + b.x) / 2 - def.width / 2, y: (a.y + b.y) / 2 - def.height / 2 }, orientationOf(o))
  const box = sizeBefore(def, o.rotation ?? 0)
  return { x: o.x / GRID + box.w / 2 + at.x, y: o.y / GRID + box.h / 2 + at.y }
}

function squaresAround(o: PlacedObject, def: ComponentDef, reach: number, inner: number): Option[] {
  const middle = pinsMiddleBefore(o, def)
  const half = diagonalSquare(def)! / 2
  const x0 = Math.floor(middle.x - half)
  const y0 = Math.floor(middle.y - half)
  return ringOffsets(reach, inner, (ring) => ring)
    .map(([dx, dy]): Option => ({ object: { ...o, x: (x0 + dx) * GRID, y: (y0 + dy) * GRID }, cost: (x0 + dx + half - middle.x) ** 2 + (y0 + dy + half - middle.y) ** 2 }))
    .sort(byCost)
}

function turnedTo(o: PlacedObject, def: ComponentDef, rotation: Rotation): PlacedObject {
  const before = sizeBefore(asDrawnBefore(def), o.rotation ?? 0)
  const size = objectSize(def, rotation)
  const { rotation: _diagonal, ...rest } = o
  return { ...rest, ...(rotation && { rotation }), x: Math.round(o.x / GRID + before.w / 2 - size.w / 2) * GRID, y: Math.round(o.y / GRID + before.h / 2 - size.h / 2) * GRID }
}

const shifted = (o: PlacedObject, dx: number, dy: number): PlacedObject => ({ ...o, x: o.x + dx * GRID, y: o.y + dy * GRID })

function shiftsOf(placements: readonly Option[], reach: number, inner: number): Option[] {
  const out: Option[] = []
  const offsets = ringOffsets(reach, inner, (ring) => ring - 1)
  for (const { object, cost } of placements)
    for (const [dx, dy] of offsets) out.push({ object: dx || dy ? shifted(object, dx, dy) : object, cost: cost + (dx || dy ? SHIFT_COST + dx * dx + dy * dy : 0) })
  return out.sort(byCost)
}

const turnedBack = (o: PlacedObject) => ((o.rotation ?? 0) - 45) as Rotation
const turnedForth = (o: PlacedObject) => (((o.rotation ?? 0) + 45) % 360) as Rotation

function optionsFor(o: PlacedObject, def: ComponentDef, reach: number, inner = 0): Option[] {
  if (isDiagonal(o.rotation ?? 0) && diagonalSquare(def) !== null) return squaresAround(o, def, reach, inner)
  if (isDiagonal(o.rotation ?? 0))
    return shiftsOf(
      [
        { object: turnedTo(o, def, turnedBack(o)), cost: 0 },
        { object: turnedTo(o, def, turnedForth(o)), cost: 0.5 },
      ],
      reach,
      inner,
    )
  return shiftsOf([{ object: o, cost: 0 }], reach, inner)
}

export function onARightAngle(o: PlacedObject, def: ComponentDef): PlacedObject {
  return turnedTo(o, def, turnedBack(o))
}

export function uprightOnTheLattice(o: PlacedObject): PlacedObject {
  const def = getDef(o.def)
  return def && !rotationAllowed(def, o.rotation ?? 0) ? onARightAngle(o, def) : o
}

type Pin = { key: string; net: string; x: number; y: number }

const pointOf = (p: Point) => `${p.x},${p.y}`

function pinsOf(o: PlacedObject, netOf: (key: string) => string): Pin[] {
  return objectPins(o, GRID).flatMap(({ key, pin, point }) => (pin.kind === "nc" ? [] : [{ key, net: netOf(key), x: point.x, y: point.y }]))
}

class Occupancy {
  private readonly pins = new PointGrid<Pin>()

  add(pins: readonly Pin[]) {
    this.pins.add(pins)
  }

  remove(pins: readonly Pin[]) {
    for (const pin of pins) this.pins.remove(pin)
  }

  score(pins: readonly Pin[]): number | null {
    let joins = 0
    for (const pin of pins)
      for (const there of this.pins.at(pin.x, pin.y)) {
        if (there.net !== pin.net) return null
        joins++
      }
    return joins
  }
}

type Mover = { id: string; options: Option[]; pins: Pin[][] }

const valueOf = (joins: number, option: Option) => joins * JOIN_WEIGHT - option.cost

function bestOfTheNearest(cluster: readonly Mover[], taken: Occupancy): number[] | null {
  const widths = cluster.map((m) => Math.min(NEAREST, m.options.length))
  const assignments = widths.reduce((n, w) => n * w, 1)
  if (assignments > EXHAUSTIVE) return null
  let best: { pick: number[]; value: number } | null = null
  for (let k = 0; k < assignments; k++) {
    const pick = cluster.map((_, i) => Math.floor(k / widths.slice(0, i).reduce((n, w) => n * w, 1)) % widths[i])
    let value: number | null = 0
    const placed: Pin[][] = []
    for (let i = 0; i < cluster.length && value !== null; i++) {
      const pins = cluster[i].pins[pick[i]]
      const joins = taken.score(pins)
      if (joins === null) value = null
      else {
        value += valueOf(joins, cluster[i].options[pick[i]])
        taken.add(pins)
        placed.push(pins)
      }
    }
    for (const pins of placed) taken.remove(pins)
    if (value !== null && (!best || value > best.value)) best = { pick, value }
  }
  return best?.pick ?? null
}

function firstThatFits(cluster: readonly Mover[], taken: Occupancy): number[] | null {
  if (cluster.some((m) => m.pins.every((pins) => taken.score(pins) === null))) return null
  let budget = SEARCH_BUDGET
  const ranked = (m: Mover): number[] => {
    budget -= m.options.length
    const fits: { k: number; value: number }[] = []
    m.options.forEach((option, k) => {
      const joins = taken.score(m.pins[k])
      if (joins !== null) fits.push({ k, value: valueOf(joins, option) })
    })
    return fits.sort((a, b) => b.value - a.value).map((fit) => fit.k)
  }
  const choices = [ranked(cluster[0])]
  const tried = [0]
  const placed: Pin[][] = []
  while (placed.length < cluster.length && budget > 0) {
    const i = placed.length
    if (tried[i] >= choices[i].length) {
      if (i === 0) break
      taken.remove(placed.pop()!)
      continue
    }
    const pins = cluster[i].pins[choices[i][tried[i]++]]
    taken.add(pins)
    placed.push(pins)
    if (placed.length < cluster.length) {
      choices[placed.length] = ranked(cluster[placed.length])
      tried[placed.length] = 0
    }
  }
  const found = placed.length === cluster.length ? cluster.map((_, i) => choices[i][tried[i] - 1]) : null
  for (const pins of placed) taken.remove(pins)
  return found
}

function solve(cluster: readonly Mover[], taken: Occupancy): Map<string, Option> | null {
  const pick = bestOfTheNearest(cluster, taken) ?? firstThatFits(cluster, taken)
  return pick && new Map(cluster.map((m, i) => [m.id, m.options[pick[i]]]))
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const BODY_BUCKET = 8 * GRID

class Bodies {
  private readonly buckets = new Map<string, Rect[]>()

  private keys(r: Rect): string[] {
    const keys: string[] = []
    for (let x = Math.floor(r.x / BODY_BUCKET); x <= Math.floor((r.x + r.w) / BODY_BUCKET); x++)
      for (let y = Math.floor(r.y / BODY_BUCKET); y <= Math.floor((r.y + r.h) / BODY_BUCKET); y++) keys.push(`${x},${y}`)
    return keys
  }

  add(r: Rect) {
    for (const key of this.keys(r)) {
      const bucket = this.buckets.get(key)
      if (bucket) bucket.push(r)
      else this.buckets.set(key, [r])
    }
  }

  overlaps(r: Rect): boolean {
    return this.keys(r).some((key) => this.buckets.get(key)?.some((other) => overlaps(r, other)))
  }
}

type Room = { taken: Occupancy; bodies: Bodies; extent: Rect }

function nearestClear(o: PlacedObject, def: ComponentDef, room: Room, netOf: (key: string) => string): Option | null {
  const { extent } = room
  const size = objectRect(o, GRID)
  const outside = Math.max(o.x - extent.x, extent.x + extent.w - o.x, o.y - extent.y, extent.y + extent.h - o.y) + Math.max(size.w, size.h)
  const limit = Math.ceil(outside / GRID) + RINGS[1] + 4
  for (let reach = 1; reach <= limit; reach++) {
    let best: { option: Option; value: number } | null = null
    for (const option of optionsFor(o, def, reach, reach - 1)) {
      const rect = objectRect(option.object, GRID)
      if (reach > RINGS[1] && room.bodies.overlaps(rect)) continue
      const joins = room.taken.score(pinsOf(option.object, netOf))
      if (joins !== null && (!best || valueOf(joins, option) > best.value)) best = { option, value: valueOf(joins, option) }
    }
    if (best) return best.option
  }
  return null
}

function clustersOf(movers: readonly Mover[]): Mover[][] {
  const groups = new Union()
  const firstAt = new Map<string, string>()
  for (const m of movers) {
    groups.find(m.id)
    for (const pins of m.pins)
      for (const pin of pins) {
        const other = firstAt.get(pointOf(pin))
        if (other === undefined) firstAt.set(pointOf(pin), m.id)
        else groups.join(other, m.id)
      }
  }
  const clusters = new Map<string, Mover[]>()
  for (const m of movers) clusters.set(groups.find(m.id), [...(clusters.get(groups.find(m.id)) ?? []), m])
  return [...clusters.values()]
}

const nameOf = (o: PlacedObject) => o.props?.ref || getDef(o.def)?.name || o.def

const listed = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`)

const cells = (n: number) => `${n} cell${n === 1 ? "" : "s"}`

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

function noteOn(o: PlacedObject, placed: PlacedObject, def: ComponentDef): string | null {
  if (isDiagonal(o.rotation ?? 0) && diagonalSquare(def) !== null) {
    const was = pinsMiddleBefore(o, def)
    const half = diagonalSquare(def)! / 2
    const away = Math.hypot(placed.x / GRID + half - was.x, placed.y / GRID + half - was.y)
    return away > FAR_CELLS ? `${nameOf(o)} moved ${cells(Math.round(away))} onto the grid: nearer, its pins would have touched another net's.` : null
  }
  if (isDiagonal(o.rotation ?? 0)) {
    const turned = turnedTo(o, def, (placed.rotation ?? 0) as Rotation)
    const away = Math.round(Math.hypot(placed.x - turned.x, placed.y - turned.y) / GRID)
    return `${nameOf(o)} stood at ${o.rotation}°, which it cannot take now: turned to ${placed.rotation ?? 0}°${away ? `, ${cells(away)} from where it stood, as nearer its pins would have touched another net's` : ""}.`
  }
  if (placed.x === o.x && placed.y === o.y) return null
  return `${nameOf(o)} moved ${cells(Math.round(Math.hypot(placed.x - o.x, placed.y - o.y) / GRID))}: its pins, now on the grid, would have touched another net's where it stood.`
}

export function partsOnTheLattice(doc: Schematic, newId: () => string = () => crypto.randomUUID()): { doc: Schematic; notes: string[] } {
  const moving = doc.objects.filter((o) => {
    const def = getDef(o.def)
    return def && (isDiagonal(o.rotation ?? 0) || changedByTheLattice(def))
  })
  if (!moving.length) return { doc, notes: [] }
  const before = circuitBefore(doc)
  const movingIds = new Set(moving.map((o) => o.id))
  const room: Room = { taken: new Occupancy(), bodies: new Bodies(), extent: unionOf(doc.objects.map((o) => objectRect(o, GRID))) }
  for (const o of doc.objects)
    if (!movingIds.has(o.id)) {
      room.taken.add(pinsOf(o, before.netOf))
      room.bodies.add(objectRect(o, GRID))
    }
  const original = new Map(moving.map((o) => [o.id, o]))
  const moverOf = (o: PlacedObject, reach: number): Mover => {
    const options = optionsFor(o, getDef(o.def)!, reach)
    return { id: o.id, options, pins: options.map((option) => pinsOf(option.object, before.netOf)) }
  }
  const chosen = new Map<string, PlacedObject>()
  for (const cluster of clustersOf(moving.map((o) => moverOf(o, RINGS[0])))) {
    const picked = solve(cluster, room.taken) ?? solve(cluster.map((m) => moverOf(original.get(m.id)!, RINGS[1])), room.taken)
    for (const m of cluster) {
      const o = original.get(m.id)!
      const option = picked?.get(m.id) ?? nearestClear(o, getDef(o.def)!, room, before.netOf) ?? m.options[0]
      const rect = objectRect(option.object, GRID)
      chosen.set(m.id, option.object)
      room.taken.add(pinsOf(option.object, before.netOf))
      room.bodies.add(rect)
      room.extent = unionOf([room.extent, rect])
    }
  }
  const objects = doc.objects.map((o) => chosen.get(o.id) ?? o)
  const byId = new Map(objects.map((o) => [o.id, o]))
  const folded = doc.wires.filter((w) => (movingIds.has(w.from.object) || movingIds.has(w.to.object)) && meetsItself(w, byId))
  let wires = doc.wires.filter((w) => !folded.includes(w))
  const now = circuitNow({ ...doc, objects, wires })
  const joined = new Union()
  const rejoined: Wire[] = []
  for (const [first, ...rest] of before.touching)
    for (const key of rest) {
      if (joined.find(now(key)) === joined.find(now(first))) continue
      joined.join(now(key), now(first))
      rejoined.push({ id: newId(), from: refOf(first), to: refOf(key) })
    }
  wires = [...wires, ...rejoined]
  const upgraded: Schematic = { ...doc, objects, wires }
  const notes = moving.flatMap((o) => noteOn(o, byId.get(o.id)!, getDef(o.def)!) ?? [])
  if (folded.length) {
    const met = [...new Set(folded.flatMap((w) => [w.from.object, w.to.object]))].map((id) => nameOf(byId.get(id)!)).sort()
    notes.push(`${listed(met)} now meet pin to pin on the grid, so the ${folded.length === 1 ? "wire" : `${folded.length} wires`} between those pins went.`)
  }
  for (const w of rejoined) notes.push(`${pinName(`${w.from.object}:${w.from.pin}`, byId)} and ${pinName(`${w.to.object}:${w.to.pin}`, byId)} touched where they stood before; a wire joins them now.`)
  const was = partition(doc, before.netOf)
  const is = partition(upgraded, circuitNow(upgraded))
  const astray = [...new Set([...was.keys()].filter((key) => was.get(key) !== is.get(key)).map((key) => refOf(key).object))].flatMap((id) => (byId.has(id) ? [nameOf(byId.get(id)!)] : [])).sort()
  if (astray.length) notes.push(`The circuit round ${listed(astray)} could not be kept exactly: check its connections.`)
  return { doc: upgraded, notes }
}
