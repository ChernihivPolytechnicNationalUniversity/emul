import { DIR, orientPin, unorientOffset, type Direction, type Orientation, type PlacedPin, type Point } from "@/schematic/geometry"
import type { BodyShape, ComponentDef, Fill } from "@/schematic/types"

export const PIN_LABEL_CELLS = 0.4
export const MAX_PIN_LABEL_CELLS = 0.8

export const MONO_ADVANCE_EM = 0.6
export const KNOCKOUT_OPACITY = 0.8

const LABEL_OFFSET_CELLS = 0.45
const MARKER_CLEARANCE_CELLS = 0.25
const KNOCKOUT_PAD_EM = 0.15
const KNOCKOUT_FADE_EM = 0.5
const KNOCKOUT_HALF_HEIGHT_EM = 0.62
const RUN_BREAK_CELLS = 2.5
const LINE_TOLERANCE_CELLS = 1e-3
const TOUCH_TOLERANCE_CELLS = 1e-6
const DEGREES = 180 / Math.PI

export type LabelAnchor = "start" | "middle" | "end"

const ACROSS_ANCHOR: Record<Direction, LabelAnchor> = {
  left: "end",
  right: "start",
  top: "middle",
  bottom: "middle",
  "top-left": "end",
  "bottom-left": "end",
  "top-right": "start",
  "bottom-right": "start",
}

export type LabelGround = Exclude<Fill, "none" | "grip"> | "field"

export type Box = { x: number; y: number; w: number; h: number }

export type KnockoutAxis = "x" | "y"

export type LabelKnockout = { axis: KnockoutAxis; text: Box; solid: Box; rise: Box; fall: Box }

export type LabelRun = "across" | "along"

export type PinLabel = {
  id: string
  text: string
  dir: Point
  angle: number
  anchor: LabelAnchor
  run: LabelRun
  ground: LabelGround
}

type Placement = Pick<PinLabel, "dir" | "angle" | "anchor">

export function labelKnockout(text: string, anchor: LabelAnchor, size: number, advanceEm = MONO_ADVANCE_EM): LabelKnockout {
  const width = text.length * advanceEm * size
  const start = anchor === "start" ? 0 : anchor === "end" ? -width : -width / 2
  const half = KNOCKOUT_HALF_HEIGHT_EM * size
  const pad = KNOCKOUT_PAD_EM * size
  const fade = KNOCKOUT_FADE_EM * size
  const textBox = { x: start, y: -half, w: width, h: half * 2 }
  const solid = { x: start - pad, y: textBox.y, w: width + pad * 2, h: textBox.h }
  if (anchor !== "middle") {
    return {
      axis: "x",
      text: textBox,
      solid,
      rise: { x: solid.x - fade, y: solid.y, w: fade, h: solid.h },
      fall: { x: solid.x + solid.w, y: solid.y, w: fade, h: solid.h },
    }
  }
  return {
    axis: "y",
    text: textBox,
    solid,
    rise: { x: solid.x, y: solid.y - fade, w: solid.w, h: fade },
    fall: { x: solid.x, y: solid.y + solid.h, w: solid.w, h: fade },
  }
}

export function labelOrigin(label: Placement, size: number): Point {
  const reach = label.anchor === "middle" ? Math.max(LABEL_OFFSET_CELLS, MARKER_CLEARANCE_CELLS + KNOCKOUT_HALF_HEIGHT_EM * size) : LABEL_OFFSET_CELLS
  return { x: label.dir.x * reach, y: label.dir.y * reach }
}

export function labelFrame(label: Placement, size: number): (p: Point) => Point {
  const origin = labelOrigin(label, size)
  const cos = Math.cos(label.angle / DEGREES)
  const sin = Math.sin(label.angle / DEGREES)
  return (p) => ({ x: origin.x + p.x * cos - p.y * sin, y: origin.y + p.x * sin + p.y * cos })
}

export function boxCorners(box: Box, turn: (p: Point) => Point): Point[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map(turn)
}

export function boundsOf(points: readonly Point[]): Box {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

function across(labelAt: Direction): Placement {
  return { dir: DIR[labelAt], angle: 0, anchor: ACROSS_ANCHOR[labelAt] }
}

function along(labelAt: Direction): Placement {
  const dir = DIR[labelAt]
  const heading = Math.round(Math.atan2(dir.y, dir.x) * DEGREES)
  const readsBackwards = heading >= 90 || heading < -90
  return {
    dir,
    angle: readsBackwards ? (heading >= 90 ? heading - 180 : heading + 180) : heading,
    anchor: readsBackwards ? "end" : "start",
  }
}

const canTurn = (labelAt: Direction) => labelAt !== "left" && labelAt !== "right"

type Footprint = { box: Box; corners: Point[] }

function footprintOn(pin: PlacedPin, placement: Placement, size: number): Footprint {
  const { solid } = labelKnockout(pin.label, placement.anchor, size)
  const corners = boxCorners(solid, labelFrame(placement, size)).map((p) => ({ x: pin.x + p.x, y: pin.y + p.y }))
  return { box: boundsOf(corners), corners }
}

const boxesMeet = (a: Box, b: Box) =>
  a.x < b.x + b.w - TOUCH_TOLERANCE_CELLS &&
  b.x < a.x + a.w - TOUCH_TOLERANCE_CELLS &&
  a.y < b.y + b.h - TOUCH_TOLERANCE_CELLS &&
  b.y < a.y + a.h - TOUCH_TOLERANCE_CELLS

function depthOf(a: Footprint, b: Footprint) {
  if (!boxesMeet(a.box, b.box)) return 0
  let depth = Infinity
  for (const shape of [a.corners, b.corners]) {
    for (let i = 0; i < shape.length; i++) {
      const p = shape[i]
      const q = shape[(i + 1) % shape.length]
      const normal = { x: p.y - q.y, y: q.x - p.x }
      const length = Math.hypot(normal.x, normal.y)
      if (length === 0) continue
      const project = (points: readonly Point[]) => points.map((r) => (r.x * normal.x + r.y * normal.y) / length)
      const pa = project(a.corners)
      const pb = project(b.corners)
      depth = Math.min(depth, Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)))
      if (depth <= TOUCH_TOLERANCE_CELLS) return 0
    }
  }
  return depth
}

const overlaps = (a: Footprint, b: Footprint) => depthOf(a, b) > 0

function crowded(footprints: readonly Footprint[]): Set<number> {
  const order = footprints.map((_, i) => i).sort((a, b) => footprints[a].box.x - footprints[b].box.x)
  const hit = new Set<number>()
  for (let k = 0; k < order.length; k++) {
    const a = footprints[order[k]]
    for (let m = k + 1; m < order.length && footprints[order[m]].box.x < a.box.x + a.box.w; m++) {
      if (!overlaps(a, footprints[order[m]])) continue
      hit.add(order[k])
      hit.add(order[m])
    }
  }
  return hit
}

function crowding(run: readonly number[], placed: readonly Footprint[], candidate: readonly Footprint[]) {
  const members = new Set(run)
  let sum = 0
  run.forEach((i, n) => {
    for (const j of run.slice(n + 1)) sum += depthOf(candidate[i], candidate[j])
    placed.forEach((other, k) => {
      if (!members.has(k)) sum += depthOf(candidate[i], other)
    })
  })
  return sum
}

function runsOf(pins: readonly PlacedPin[]): number[][] {
  const lines = new Map<string, { i: number; t: number }[]>()
  pins.forEach((pin, i) => {
    if (!canTurn(pin.labelAt)) return
    const d = DIR[pin.labelAt]
    const depth = Math.round((pin.x * d.x + pin.y * d.y) / LINE_TOLERANCE_CELLS)
    const key = `${pin.labelAt}|${depth}`
    const line = lines.get(key) ?? lines.set(key, []).get(key)!
    line.push({ i, t: pin.y * d.x - pin.x * d.y })
  })
  const runs: number[][] = []
  for (const line of lines.values()) {
    line.sort((a, b) => a.t - b.t)
    let run: number[] = []
    line.forEach(({ i, t }, k) => {
      if (k > 0 && t - line[k - 1].t > RUN_BREAK_CELLS) {
        runs.push(run)
        run = []
      }
      run.push(i)
    })
    runs.push(run)
  }
  return runs
}

const paintedFill = (shape: BodyShape): LabelGround | null =>
  shape.type === "rect" && shape.fill && shape.fill !== "none" && shape.fill !== "grip" ? shape.fill : null

const covers = (shape: BodyShape, at: Point) =>
  shape.type === "rect" && paintedFill(shape) !== null && at.x >= shape.x && at.x <= shape.x + shape.w && at.y >= shape.y && at.y <= shape.y + shape.h

function groundUnder(def: ComponentDef, raw: { x: number; y: number }, pin: PlacedPin, placement: Placement, orientation: Orientation): LabelGround {
  const { text } = labelKnockout(pin.label, placement.anchor, PIN_LABEL_CELLS)
  const middle = labelFrame(placement, PIN_LABEL_CELLS)({ x: text.x + text.w / 2, y: 0 })
  const local = unorientOffset(middle, orientation)
  const at = { x: raw.x + local.x, y: raw.y + local.y }
  const under = def.body.findLast((shape) => covers(shape, at))
  return (under && paintedFill(under)) ?? "field"
}

function layOut(def: ComponentDef, orientation: Orientation): readonly PinLabel[] {
  const raws = def.pins.filter((pin) => pin.label)
  const pins = raws.map((raw) => orientPin(raw, def, orientation))
  const level = pins.map((pin) => footprintOn(pin, across(pin.labelAt), MAX_PIN_LABEL_CELLS))
  const hit = crowded(level)
  const crowdedRuns = runsOf(pins).filter((run) => run.some((i) => hit.has(i)))
  const upright = pins.map((pin) => footprintOn(pin, along(pin.labelAt), MAX_PIN_LABEL_CELLS))
  const placed = [...level]
  for (const run of crowdedRuns) for (const i of run) placed[i] = upright[i]
  const turned = new Set<number>()
  for (const run of crowdedRuns) if (crowding(run, placed, upright) < crowding(run, placed, level)) for (const i of run) turned.add(i)
  return pins.map((pin, i) => {
    const run: LabelRun = turned.has(i) ? "along" : "across"
    const placement = run === "along" ? along(pin.labelAt) : across(pin.labelAt)
    return { id: pin.id, text: pin.label, ...placement, run, ground: groundUnder(def, raws[i], pin, placement, orientation) }
  })
}

const layouts = new WeakMap<ComponentDef, Map<string, readonly PinLabel[]>>()

export function pinLabels(def: ComponentDef, orientation: Orientation): readonly PinLabel[] {
  let byOrientation = layouts.get(def)
  if (!byOrientation) {
    byOrientation = new Map()
    layouts.set(def, byOrientation)
  }
  const key = `${orientation.rotation}|${orientation.mirror}`
  const cached = byOrientation.get(key)
  if (cached) return cached
  const laid = layOut(def, orientation)
  byOrientation.set(key, laid)
  return laid
}

const indexes = new WeakMap<readonly PinLabel[], ReadonlyMap<string, PinLabel>>()

export function pinLabelById(labels: readonly PinLabel[]): ReadonlyMap<string, PinLabel> {
  let index = indexes.get(labels)
  if (!index) {
    index = new Map(labels.map((label) => [label.id, label]))
    indexes.set(labels, index)
  }
  return index
}
