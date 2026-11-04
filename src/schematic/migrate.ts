import { diagonalSquare, GRID, isDiagonal, objectPins, objectSize, orientationOf, orientOffset, orientPin, pinPoint, rotationAllowed, type Point } from "./geometry"
import { BOARD_IN_1_28, RENUMBERED_SINCE_1_28 } from "./migrate-open746i-c"
import { buildNets } from "./nets"
import { getDef, getPin } from "./registry"
import { partKey, type ComponentDef, type PinRef, type PlacedObject, type Rotation, type Schematic, type Wire } from "./types"

const savedAsHctSelect = (o: PlacedObject) => o.def === "hc595" && o.props?.value === "74HCT595"

function renamedChip(o: PlacedObject): PlacedObject {
  if (!savedAsHctSelect(o)) return o
  const { value: _part, ...props } = o.props ?? {}
  return { ...o, def: "hct595", props }
}

export function migrated(saved: PlacedObject): PlacedObject {
  const o = renamedChip(saved)
  const def = getDef(o.def)
  return def && !rotationAllowed(def, o.rotation ?? 0) ? onARightAngle(o, def) : o
}

export type VersionedSchematic = Schematic & { version?: number }

export type Upgrade = { doc: Schematic; notes: string[] }

const steps: ((doc: Schematic) => Upgrade)[] = [open746HeadersAsOnTheBoard, partsOnTheLattice]

export const SCHEMATIC_VERSION = steps.length + 1

export function versionOf(doc: Schematic): number {
  const { version } = doc as VersionedSchematic
  return typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : 1
}

export const stamped = (doc: Schematic): VersionedSchematic => ({ ...doc, version: SCHEMATIC_VERSION })

export function upgraded(doc: Schematic): Upgrade {
  const from = versionOf(doc)
  if (from >= SCHEMATIC_VERSION) return { doc, notes: [] }
  const notes: string[] = []
  let now = doc
  for (const step of steps.slice(from - 1)) {
    const next = step(now)
    now = next.doc
    notes.push(...next.notes)
  }
  return { doc: stamped(now), notes }
}

const OPEN746 = "open746i-c"
const LCD7 = "lcd7-f"
const FFC_LINES = Array.from({ length: 40 }, (_, i) => i + 1)

const boardName = (board: PlacedObject) => board.props?.ref || "Open746I-C"

const STRIP_PIN = /^P(18|19|20|21)-\d+$/

const wiredToTheStrips = (doc: Schematic, boards: readonly PlacedObject[]) =>
  doc.wires.some((w) => [w.from, w.to].some((end) => STRIP_PIN.test(end.pin) && boards.some((b) => b.id === end.object)))

function open746HeadersAsOnTheBoard(doc: Schematic): Upgrade {
  const boards = doc.objects.filter((o) => o.def === OPEN746)
  const def = getDef(OPEN746)
  if (!boards.length || !def || wiredToTheStrips(doc, boards)) return { doc, notes: [] }
  const moved = new Map<string, string[]>()
  const renumbered = (end: PinRef): PinRef => {
    const now = boards.some((b) => b.id === end.object) ? RENUMBERED_SINCE_1_28.get(end.pin) : undefined
    if (!now) return end
    moved.set(end.object, [...(moved.get(end.object) ?? []), end.pin])
    return { ...end, pin: now }
  }
  const wires = doc.wires.map((w): Wire => {
    const from = renumbered(w.from)
    const to = renumbered(w.to)
    return from === w.from && to === w.to ? w : { ...w, from, to }
  })
  const objects = doc.objects.map((o) => (o.def === LCD7 ? redockedOnP15(o, boards, def) : o))
  const notes = boards.flatMap((board) => [...renumberingNote(board, moved.get(board.id)), ...solderedJmp1Note(doc, board)])
  return { doc: { ...doc, objects, wires }, notes }
}

function renumberingNote(board: PlacedObject, ends: readonly string[] | undefined): string[] {
  if (!ends?.length) return []
  const headers = [...new Set(ends.map((pin) => pin.split("-")[0]))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
  return [`${boardName(board)}: ${ends.length} wire ${ends.length === 1 ? "end" : "ends"} on ${headers.join(", ")} moved to keep the same signals, now that these pins are numbered as on the board itself.`]
}

function solderedJmp1Note(doc: Schematic, board: PlacedObject): string[] {
  if (doc.parts?.[partKey(board.id, "JMP1")]?.on !== false) return []
  return [`${boardName(board)}: JMP1 was open in this project. On the board it is a 0 Ω resistor soldered in place, not a jumper, so the SD card detect on P6-9 now always reaches PC13.`]
}

function p15LineIn1_28(board: PlacedObject, def: ComponentDef, line: number): Point | null {
  const pin = getPin(def, `P15-${line}`)
  if (!pin) return null
  const { width, height, p15Line1 } = BOARD_IN_1_28
  const cell = { x: p15Line1.x + ((line - 1) % 20), y: p15Line1.y + (line > 20 ? 1 : 0) }
  const at = orientPin({ ...pin, ...cell }, { ...def, width, height }, orientationOf(board))
  return { x: board.x + at.x * GRID, y: board.y + at.y * GRID }
}

const samePoint = (a: Point | null, b: Point | null) => !!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5

const dockedIn1_28 = (lcd: PlacedObject, board: PlacedObject, def: ComponentDef) =>
  FFC_LINES.every((line) => samePoint(pinPoint(lcd, String(line), GRID), p15LineIn1_28(board, def, line)))

function redockedOnP15(lcd: PlacedObject, boards: readonly PlacedObject[], def: ComponentDef): PlacedObject {
  const board = boards.find((b) => dockedIn1_28(lcd, b, def))
  const was = board && p15LineIn1_28(board, def, 1)
  const now = board && pinPoint(board, "P15-1", GRID)
  if (!was || !now) return lcd
  return { ...lcd, x: lcd.x + now.x - was.x, y: lcd.y + now.y - was.y }
}

const hullOnADiagonal = (def: ComponentDef) => (def.width + def.height) * Math.SQRT1_2

const nameOf = (o: PlacedObject) => o.props?.ref || getDef(o.def)?.name || o.def

function pinsMiddleBefore(o: PlacedObject, def: ComponentDef): Point {
  const [a, b] = def.pins
  const at = orientOffset({ x: (a.x + b.x) / 2 - def.width / 2, y: (a.y + b.y) / 2 - def.height / 2 }, orientationOf(o))
  const half = hullOnADiagonal(def) / 2
  return { x: o.x / GRID + half + at.x, y: o.y / GRID + half + at.y }
}

type Placement = { object: PlacedObject; cost: number }

const NEAREST_SQUARES = 4
const SQUARES_AROUND = 2

function squaresAround(o: PlacedObject, def: ComponentDef): Placement[] {
  const middle = pinsMiddleBefore(o, def)
  const half = diagonalSquare(def)! / 2
  const x0 = Math.floor(middle.x - half)
  const y0 = Math.floor(middle.y - half)
  const out: Placement[] = []
  for (let x = x0 - SQUARES_AROUND + 1; x <= x0 + SQUARES_AROUND; x++) {
    for (let y = y0 - SQUARES_AROUND + 1; y <= y0 + SQUARES_AROUND; y++) {
      out.push({ object: { ...o, x: x * GRID, y: y * GRID }, cost: (x + half - middle.x) ** 2 + (y + half - middle.y) ** 2 })
    }
  }
  return out.sort((a, b) => a.cost - b.cost)
}

function turnedTo(o: PlacedObject, def: ComponentDef, rotation: Rotation, dx: number, dy: number): Placement {
  const half = hullOnADiagonal(def) / 2
  const size = objectSize(def, rotation)
  const { rotation: _diagonal, ...rest } = o
  return {
    object: { ...rest, ...(rotation && { rotation }), x: (Math.round(o.x / GRID + half - size.w / 2) + dx) * GRID, y: (Math.round(o.y / GRID + half - size.h / 2) + dy) * GRID },
    cost: dx * dx + dy * dy + (rotation === (o.rotation ?? 0) - 45 ? 0 : 0.5),
  }
}

function onARightAngle(o: PlacedObject, def: ComponentDef): PlacedObject {
  return turnedTo(o, def, ((o.rotation ?? 0) - 45) as Rotation, 0, 0).object
}

function rightAnglesAround(o: PlacedObject, def: ComponentDef): Placement[] {
  const out: Placement[] = []
  for (const rotation of [(o.rotation ?? 0) - 45, ((o.rotation ?? 0) + 45) % 360] as Rotation[])
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(turnedTo(o, def, rotation, dx, dy))
  return out.sort((a, b) => a.cost - b.cost)
}

type PinAt = { key: string; net: string; point: string }

function netsOf(doc: Schematic): (key: string) => string {
  const nets = buildNets(doc.objects, doc.wires, GRID)
  return (key) => nets.netOfPin(key) ?? key
}

function pinsBefore(o: PlacedObject, def: ComponentDef): { key: string; at: string }[] {
  const half = hullOnADiagonal(def) / 2
  return def.pins.flatMap((pin) => {
    if (pin.kind === "nc") return []
    const at = orientOffset({ x: pin.x - def.width / 2, y: pin.y - def.height / 2 }, orientationOf(o))
    return [{ key: `${o.id}:${pin.id}`, at: `${(o.x / GRID + half + at.x).toFixed(6)},${(o.y / GRID + half + at.y).toFixed(6)}` }]
  })
}

function netsBefore(doc: Schematic, diagonal: ReadonlySet<string>): (key: string) => string {
  const nets = buildNets(doc.objects.filter((o) => !diagonal.has(o.id)), doc.wires, GRID)
  const parent = new Map<string, string>()
  const find = (key: string): string => {
    const up = parent.get(key)
    return up === undefined || up === key ? key : find(up)
  }
  const firstAt = new Map<string, string>()
  for (const o of doc.objects) {
    const def = diagonal.has(o.id) ? getDef(o.def) : undefined
    for (const pin of def ? pinsBefore(o, def) : []) {
      const net = nets.netOfPin(pin.key) ?? pin.key
      const other = firstAt.get(pin.at)
      if (other === undefined) firstAt.set(pin.at, net)
      else if (find(other) !== find(net)) parent.set(find(net), find(other))
    }
  }
  return (key) => find(nets.netOfPin(key) ?? key)
}

const pinsAt = (o: PlacedObject, netOf: (key: string) => string): PinAt[] =>
  objectPins(o, GRID).flatMap(({ key, pin, point }) => (pin.kind === "nc" ? [] : [{ key, net: netOf(key), point: `${point.x},${point.y}` }]))

const JOIN_WEIGHT = 10
const EXHAUSTIVE_ASSIGNMENTS = 4096

function chooseFor(cluster: readonly string[], options: ReadonlyMap<string, Placement[]>, fixed: ReadonlyMap<string, readonly PinAt[]>, netOf: (key: string) => string): Map<string, Placement> | null {
  const pins = new Map(cluster.map((id) => [id, options.get(id)!.map((p) => pinsAt(p.object, netOf))]))
  const score = (choice: ReadonlyMap<string, number>): number | null => {
    const at = new Map<string, string[]>()
    let cost = 0
    for (const [id, i] of choice) {
      cost += options.get(id)![i].cost
      for (const pin of pins.get(id)![i]) at.set(pin.point, [...(at.get(pin.point) ?? []), pin.net])
    }
    let joins = 0
    for (const [point, nets] of at) {
      const all = [...nets, ...(fixed.get(point) ?? []).map((pin) => pin.net)]
      if (all.some((net) => net !== all[0])) return null
      joins += all.length - 1
    }
    return joins * JOIN_WEIGHT - cost
  }
  const widths = cluster.map((id) => Math.min(NEAREST_SQUARES, options.get(id)!.length))
  const assignments = widths.reduce((n, w) => n * w, 1)
  let best: { choice: Map<string, number>; score: number } | null = null
  if (assignments <= EXHAUSTIVE_ASSIGNMENTS) {
    for (let k = 0; k < assignments; k++) {
      const choice = new Map<string, number>()
      let rest = k
      cluster.forEach((id, i) => {
        choice.set(id, rest % widths[i])
        rest = Math.floor(rest / widths[i])
      })
      const s = score(choice)
      if (s !== null && (!best || s > best.score)) best = { choice, score: s }
    }
  }
  if (!best) {
    const choice = new Map<string, number>()
    for (let round = 0; round < 3; round++) {
      for (const id of cluster) {
        let pick: { i: number; score: number } | null = null
        for (let i = 0; i < options.get(id)!.length; i++) {
          const s = score(new Map([...choice, [id, i]]))
          if (s !== null && (!pick || s > pick.score)) pick = { i, score: s }
        }
        if (pick) choice.set(id, pick.i)
      }
    }
    const s = choice.size === cluster.length ? score(choice) : null
    if (s !== null) best = { choice, score: s }
  }
  return best && new Map([...best.choice].map(([id, i]) => [id, options.get(id)![i]]))
}

function clustersOf(options: ReadonlyMap<string, Placement[]>, netOf: (key: string) => string): string[][] {
  const parent = new Map([...options.keys()].map((id) => [id, id]))
  const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!))
  const firstAt = new Map<string, string>()
  for (const [id, placements] of options) {
    for (const placement of placements.slice(0, NEAREST_SQUARES)) {
      for (const pin of pinsAt(placement.object, netOf)) {
        const other = firstAt.get(pin.point)
        if (other === undefined) firstAt.set(pin.point, id)
        else parent.set(find(other), find(id))
      }
    }
  }
  const clusters = new Map<string, string[]>()
  for (const id of options.keys()) clusters.set(find(id), [...(clusters.get(find(id)) ?? []), id])
  return [...clusters.values()]
}

function newlyJoined(before: (key: string) => string, after: (key: string) => string, objects: readonly PlacedObject[]): string[] {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const pinName = (key: string) => {
    const split = key.indexOf(":")
    const object = byId.get(key.slice(0, split))
    return `${object ? nameOf(object) : key.slice(0, split)} ${key.slice(split + 1)}`
  }
  const firstOf = new Map<string, string>()
  const joined: string[] = []
  for (const o of objects) {
    for (const { key } of objectPins(o, GRID)) {
      const net = after(key)
      const seen = firstOf.get(net)
      if (seen === undefined) firstOf.set(net, key)
      else if (before(seen) !== before(key)) joined.push(`${pinName(seen)} and ${pinName(key)}`)
    }
  }
  return joined
}

const meetsItself = (wire: Wire, objects: ReadonlyMap<string, PlacedObject>) => {
  const ends = [wire.from, wire.to].map((end) => {
    const object = objects.get(end.object)
    const pin = object && objectPins(object, GRID).find((p) => p.pin.id === end.pin)
    return pin && pin.pin.kind !== "nc" ? `${pin.point.x},${pin.point.y}` : null
  })
  return ends[0] !== null && ends[0] === ends[1]
}

const listed = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`)

function partsOnTheLattice(doc: Schematic): Upgrade {
  if (!doc.objects.some((o) => isDiagonal(o.rotation ?? 0))) return { doc, notes: [] }
  const options = new Map<string, Placement[]>()
  for (const o of doc.objects) {
    const def = getDef(o.def)
    if (def && isDiagonal(o.rotation ?? 0)) options.set(o.id, diagonalSquare(def) !== null ? squaresAround(o, def) : rightAnglesAround(o, def))
  }
  const netOf = netsBefore(doc, new Set(options.keys()))
  const fixed = new Map<string, PinAt[]>()
  for (const o of doc.objects) if (!options.has(o.id)) for (const pin of pinsAt(o, netOf)) fixed.set(pin.point, [...(fixed.get(pin.point) ?? []), pin])
  const chosen = new Map<string, Placement>()
  for (const cluster of clustersOf(options, netOf)) {
    const picked = chooseFor(cluster, options, fixed, netOf)
    for (const id of cluster) chosen.set(id, picked?.get(id) ?? options.get(id)![0])
  }
  const moved = doc.objects.map((o) => chosen.get(o.id)?.object ?? o)
  const byId = new Map(moved.map((o) => [o.id, o]))
  const folded = doc.wires.filter((w) => (chosen.has(w.from.object) || chosen.has(w.to.object)) && meetsItself(w, byId))
  const upgraded: Schematic = { ...doc, objects: moved, wires: doc.wires.filter((w) => !folded.includes(w)) }
  const notes = doc.objects.flatMap((o) => {
    const now = byId.get(o.id)!
    return options.has(o.id) && !isDiagonal(now.rotation ?? 0) ? [`${nameOf(o)} stood at ${o.rotation}°, where only a two-pin part can stand now: turned to ${now.rotation ?? 0}°.`] : []
  })
  if (folded.length) {
    const met = [...new Set(folded.flatMap((w) => [w.from.object, w.to.object]))].map((id) => nameOf(byId.get(id)!)).sort()
    notes.push(`${listed(met)} now meet pin to pin on the grid, so the ${folded.length === 1 ? "wire" : `${folded.length} wires`} between those pins went.`)
  }
  const joined = newlyJoined(netOf, netsOf(upgraded), moved)
  if (joined.length) notes.push(`Parts moved onto the grid now touch, so these pins are connected: ${joined.join("; ")}.`)
  return { doc: upgraded, notes }
}
