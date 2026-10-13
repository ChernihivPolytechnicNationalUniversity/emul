import type { BodyShape, ComponentDef, Fill, PartDef, PinDef, Point, Side } from "./types"

export type Box = { x: number; y: number; w: number; h: number }

type Text = Extract<BodyShape, { type: "text" }>

export type Block = { fill: Exclude<Fill, "none" | "grip">; points: Point[]; box: Box; area: number }

export const PRINTED_ADVANCE_EM = 0.6
const SANS_ADVANCE_EM = { narrow: 0.3, lower: 0.56, wide: 0.86, other: 0.68 }

const sansAdvance = (char: string) =>
  /[Iil1.,:;·'|! ]/.test(char) ? SANS_ADVANCE_EM.narrow : /[MWmw]/.test(char) ? SANS_ADVANCE_EM.wide : /[a-z]/.test(char) ? SANS_ADVANCE_EM.lower : SANS_ADVANCE_EM.other

export const textEms = (text: string, mono: boolean) => (mono ? text.length * PRINTED_ADVANCE_EM : [...text].reduce((sum, char) => sum + sansAdvance(char), 0))
export const PRINTED_HALF_HEIGHT_EM = 0.62
export const MAX_PRINTED_GROWTH = 2
const GROWTH_STEP = 0.05
export const PIN_MARK_CELLS = 0.25
export const CLEARANCE_CELLS = 0.06
const CONTACT_DOT_CELLS = 0.15
const ARC_SAMPLES = 6
const EPSILON = 1e-6
const TOUCH_CELLS = 1e-3

export const isPrintedName = (shape: BodyShape): boolean => shape.type === "text" && !!shape.printed && !!shape.mono

const DIRECTION: Record<number, Point> = { 0: { x: 1, y: 0 }, 90: { x: 0, y: 1 }, [-90]: { x: 0, y: -1 } }

export function grownAt(text: Text, factor: number): Point {
  const from = text.growsFrom
  return from ? { x: from.x + (text.x - from.x) * factor, y: from.y + (text.y - from.y) * factor } : { x: text.x, y: text.y }
}

export function printedBox(text: Text, factor = 1): Box {
  const at = grownAt(text, factor)
  const size = (text.size ?? 0.4) * factor
  const length = textEms(text.text, !!text.mono) * size
  const half = PRINTED_HALF_HEIGHT_EM * size
  const anchor = text.anchor ?? "middle"
  const [from, to] = anchor === "start" ? [0, length] : anchor === "end" ? [-length, 0] : [-length / 2, length / 2]
  const along = DIRECTION[text.rotate ?? 0] ?? DIRECTION[0]
  const xs = [at.x + along.x * from, at.x + along.x * to]
  const ys = [at.y + along.y * from, at.y + along.y * to]
  const across = { x: Math.abs(along.y) * half, y: Math.abs(along.x) * half }
  const x = Math.min(...xs) - across.x
  const y = Math.min(...ys) - across.y
  return { x, y, w: Math.max(...xs) + across.x - x, h: Math.max(...ys) + across.y - y }
}

const COMMAND = /[MmLlHhVvAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g

function arcPoints(from: Point, to: Point, r: number, large: boolean, sweep: boolean): Point[] {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  const chord = { x: to.x - from.x, y: to.y - from.y }
  const half = Math.hypot(chord.x, chord.y) / 2
  if (half < EPSILON || r < EPSILON) return [to]
  const rise = Math.sqrt(Math.max(0, r * r - half * half))
  const side = large === sweep ? -1 : 1
  const centre = { x: mid.x - (chord.y / (half * 2)) * rise * side, y: mid.y + (chord.x / (half * 2)) * rise * side }
  const start = Math.atan2(from.y - centre.y, from.x - centre.x)
  let span = Math.atan2(to.y - centre.y, to.x - centre.x) - start
  if (sweep && span < 0) span += Math.PI * 2
  if (!sweep && span > 0) span -= Math.PI * 2
  return Array.from({ length: ARC_SAMPLES }, (_, i) => {
    const angle = start + (span * (i + 1)) / ARC_SAMPLES
    return { x: centre.x + Math.cos(angle) * r, y: centre.y + Math.sin(angle) * r }
  })
}

export function subpathPoints(d: string): Point[][] {
  const tokens = d.match(COMMAND) ?? []
  const outlines: Point[][] = []
  let points: Point[] = []
  let at = { x: 0, y: 0 }
  let command = "M"
  let i = 0
  const number = () => Number(tokens[i++])
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) command = tokens[i++]
    const upper = command.toUpperCase()
    const base = command !== upper ? at : { x: 0, y: 0 }
    if (upper === "Z") {
      if (points.length) outlines.push(points)
      points = []
      continue
    }
    if (upper === "M") {
      if (points.length) outlines.push(points)
      at = { x: base.x + number(), y: base.y + number() }
      points = [at]
      command = command === "m" ? "l" : "L"
      continue
    }
    if (upper === "H") at = { x: base.x + number(), y: at.y }
    else if (upper === "V") at = { x: at.x, y: base.y + number() }
    else if (upper === "A") {
      const r = number()
      number()
      number()
      const large = number() === 1
      const sweep = number() === 1
      const to = { x: base.x + number(), y: base.y + number() }
      points.push(...arcPoints(at, to, r, large, sweep))
      at = to
      continue
    } else at = { x: base.x + number(), y: base.y + number() }
    points.push(at)
  }
  if (points.length) outlines.push(points)
  return outlines
}

function boxOfPoints(points: readonly Point[]): Box {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

function areaOf(points: readonly Point[]) {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    sum += p.x * q.y - q.x * p.y
  }
  return Math.abs(sum) / 2
}

const blockFrom = (fill: Block["fill"], points: Point[]): Block => ({ fill, points, box: boxOfPoints(points), area: areaOf(points) })

const rectPoints = (x: number, y: number, w: number, h: number): Point[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
]

export type Rule = [Point, Point]

export function rulesOf(body: readonly BodyShape[]): Rule[] {
  return body.flatMap((shape) => {
    if (shape.type !== "art" || shape.fill !== "none") return []
    return shape.d.split(/(?=M)/).flatMap((sub) => {
      const points = subpathPoints(sub)[0] ?? []
      const closed = /z\s*$/i.test(sub)
      const ends = closed ? [...points, points[0]] : points
      return ends.slice(1).map((to, i): Rule => [ends[i], to])
    })
  })
}

export function ruleCrossesBox([a, b]: Rule, box: Box) {
  const inner = shrunk(box)
  let from = 0
  let to = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  for (const [step, room] of [
    [-dx, a.x - inner.x],
    [dx, inner.x + inner.w - a.x],
    [-dy, a.y - inner.y],
    [dy, inner.y + inner.h - a.y],
  ]) {
    if (Math.abs(step) < EPSILON) {
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

const ruleBox = ([a, b]: Rule): Box => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) })

const touchesBox = (a: Box, b: Box) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h

export function marksOf(body: readonly BodyShape[]): Point[][] {
  return body.flatMap((shape) => (shape.type === "art" && !shape.fill ? subpathPoints(shape.d).filter((points) => points.length >= 3) : []))
}

export function blocksOf(body: readonly BodyShape[]): Block[] {
  return body.flatMap((shape): Block[] => {
    if (shape.type === "rect" && shape.fill && shape.fill !== "none" && shape.fill !== "grip") {
      const r = Math.min(shape.rx ?? 0, shape.w / 2, shape.h / 2)
      const d = r > 0
        ? `M${shape.x + r} ${shape.y}H${shape.x + shape.w - r}A${r} ${r} 0 0 1 ${shape.x + shape.w} ${shape.y + r}V${shape.y + shape.h - r}A${r} ${r} 0 0 1 ${shape.x + shape.w - r} ${shape.y + shape.h}H${shape.x + r}A${r} ${r} 0 0 1 ${shape.x} ${shape.y + shape.h - r}V${shape.y + r}A${r} ${r} 0 0 1 ${shape.x + r} ${shape.y}Z`
        : ""
      return [blockFrom(shape.fill, d ? subpathPoints(d)[0] : rectPoints(shape.x, shape.y, shape.w, shape.h))]
    }
    if (shape.type === "art" && shape.fill && shape.fill !== "none" && shape.fill !== "grip") {
      const fill = shape.fill
      return subpathPoints(shape.d).filter((points) => points.length >= 3).map((points) => blockFrom(fill, points))
    }
    return []
  })
}

export function pointInPolygon(p: Point, polygon: readonly Point[]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export const boxesMeet = (a: Box, b: Box) => a.x < b.x + b.w - EPSILON && b.x < a.x + a.w - EPSILON && a.y < b.y + b.h - EPSILON && b.y < a.y + a.h - EPSILON

const cornersOf = (box: Box) => rectPoints(box.x, box.y, box.w, box.h)

function segmentsCross(a: Point, b: Point, c: Point, d: Point) {
  const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = side(c, d, a)
  const d2 = side(c, d, b)
  const d3 = side(a, b, c)
  const d4 = side(a, b, d)
  return ((d1 > EPSILON && d2 < -EPSILON) || (d1 < -EPSILON && d2 > EPSILON)) && ((d3 > EPSILON && d4 < -EPSILON) || (d3 < -EPSILON && d4 > EPSILON))
}

const inBox = (p: Point, box: Box) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h

const strictlyInside = (p: Point, box: Box) => p.x > box.x + EPSILON && p.x < box.x + box.w - EPSILON && p.y > box.y + EPSILON && p.y < box.y + box.h - EPSILON

const shrunk = (box: Box): Box => ({ x: box.x + TOUCH_CELLS, y: box.y + TOUCH_CELLS, w: box.w - TOUCH_CELLS * 2, h: box.h - TOUCH_CELLS * 2 })

export function boxMeetsPolygon(outer: Box, polygon: readonly Point[], bounds: Box = boxOfPoints(polygon)) {
  if (!boxesMeet(outer, bounds)) return false
  const box = shrunk(outer)
  const corners = cornersOf(box)
  if (pointInPolygon({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, polygon)) return true
  if (corners.some((c) => pointInPolygon(c, polygon))) return true
  if (polygon.some((p) => strictlyInside(p, box))) return true
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    for (let k = 0; k < 4; k++) if (segmentsCross(a, b, corners[k], corners[(k + 1) % 4])) return true
  }
  return false
}

export const boxInside = (box: Box, polygon: readonly Point[]) => cornersOf(shrunk(box)).every((c) => pointInPolygon(c, polygon))

export function homeOf(blocks: readonly Block[], at: Point): Block | undefined {
  let home: Block | undefined
  for (const block of blocks) if ((!home || block.area < home.area) && inBox(at, block.box) && pointInPolygon(at, block.points)) home = block
  return home
}

const grown = (box: Box, by: number): Box => ({ x: box.x - by, y: box.y - by, w: box.w + by * 2, h: box.h + by * 2 })

const around = (at: Point, half: number): Box => ({ x: at.x - half, y: at.y - half, w: half * 2, h: half * 2 })

function spanBox(points: readonly Point[], pad: number): Box {
  const box = boxOfPoints(points)
  return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 }
}

const OPEN_LEVER_DEGREES = -28

const USB_DRAWING = {
  receptacle: { w: 2.4, h: 1.2 },
  boot: { across: 1.8, alongX: 1.9, alongY: 1.4 },
  cable: { length: 6, width: 0.3 },
  label: { below: 0.45, size: 0.3, widest: "USB (unplugged)" },
} as const

const SIDE_DIRECTION: Record<Side, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } }

function unionOf(boxes: readonly Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
}

function usbDrawingBox(part: Extract<PartDef, { type: "usb" }>): Box {
  const { receptacle, boot, cable, label } = USB_DRAWING
  const dir = SIDE_DIRECTION[part.side]
  const bootEnd = { x: part.x + dir.x * boot.alongX, y: part.y + dir.y * boot.alongY }
  const cableEnd = { x: bootEnd.x + dir.x * cable.length, y: bootEnd.y + dir.y * cable.length }
  const bootBox = spanBox([{ x: part.x, y: part.y }, bootEnd], 0)
  const labelSize = { w: textEms(label.widest, true) * label.size, h: PRINTED_HALF_HEIGHT_EM * label.size * 2 }
  const labelY = part.y + receptacle.h / 2 + label.below
  return unionOf([
    { x: part.x - receptacle.w / 2, y: part.y - receptacle.h / 2, w: receptacle.w, h: receptacle.h },
    dir.x ? { x: bootBox.x, y: part.y - boot.across / 2, w: bootBox.w, h: boot.across } : { x: part.x - boot.across / 2, y: bootBox.y, w: boot.across, h: bootBox.h },
    spanBox([bootEnd, cableEnd], cable.width / 2),
    { x: part.x - labelSize.w / 2, y: labelY - labelSize.h / 2, w: labelSize.w, h: labelSize.h },
  ])
}

export function switchContacts(part: Extract<PartDef, { type: "switch" }>): Point[] {
  const pivot = { x: part.x, y: part.y }
  if (part.throws) return [pivot, part.throws.on, part.throws.off]
  const end = part.vertical ? { x: part.x, y: part.y + part.span } : { x: part.x + part.span, y: part.y }
  const turn = (OPEN_LEVER_DEGREES * Math.PI) / 180
  const v = { x: end.x - pivot.x, y: end.y - pivot.y }
  const open = { x: pivot.x + v.x * Math.cos(turn) - v.y * Math.sin(turn), y: pivot.y + v.x * Math.sin(turn) + v.y * Math.cos(turn) }
  return [pivot, end, open]
}

export function partBox(part: PartDef): Box | null {
  const at = { x: part.x, y: part.y }
  switch (part.type) {
    case "led":
      return part.style === "glow" ? null : { x: part.x - 0.35, y: part.y - 0.25, w: 0.7, h: 0.5 }
    case "button":
      return around(at, (part.size ?? 1.6) / 2)
    case "switch":
      return spanBox(switchContacts(part), CONTACT_DOT_CELLS)
    case "usb":
      return usbDrawingBox(part)
    case "link":
      return { x: part.x - part.w / 2, y: part.y - part.h / 2, w: part.w, h: part.h }
    default:
      return null
  }
}

type Obstacle = { box: Box; points?: Point[] }

type Fitting = { home: Block | undefined; anchor: Point; unit: Box; neighbours: number[]; obstacles: Obstacle[]; rules: Rule[] }

const scaled = ({ anchor, unit }: Fitting, f: number): Box => ({ x: anchor.x + (unit.x - anchor.x) * f, y: anchor.y + (unit.y - anchor.y) * f, w: unit.w * f, h: unit.h * f })

export type Growth = ReadonlyMap<BodyShape, number>

const samePoint = (a: Point | undefined, b: Point | undefined) => !!a && !!b && a.x === b.x && a.y === b.y

export function fitPrinted(body: readonly BodyShape[], pins: readonly PinDef[], parts: readonly PartDef[]): Growth {
  const blocks = blocksOf(body)
  const fixedObstacles: Obstacle[] = [
    ...pins.map((pin) => ({ box: around(pin, PIN_MARK_CELLS) })),
    ...parts.flatMap((part) => {
      const box = partBox(part)
      return box ? [{ box }] : []
    }),
    ...body.flatMap((shape) => (shape.type === "soon" ? [{ box: { x: shape.x, y: shape.y, w: shape.w, h: shape.h } }] : [])),
    ...marksOf(body).map((points) => ({ box: boxOfPoints(points), points })),
  ].map((o) => ({ ...o, box: grown(o.box, CLEARANCE_CELLS) }))
  const texts = body.filter((shape): shape is Text => shape.type === "text" && !!shape.printed)
  const rules = rulesOf(body)
  const fittings: Fitting[] = texts.map((text) => {
    const home = homeOf(blocks, text)
    const max = printedBox(text, MAX_PRINTED_GROWTH)
    const obstacles = [
      ...blocks.filter((block) => block !== home && boxesMeet(block.box, max) && !pointInPolygon(text, block.points)).map((block) => ({ box: block.box, points: block.points })),
      ...fixedObstacles.filter((o) => boxesMeet(o.box, max)),
    ]
    const reach = grown(max, CLEARANCE_CELLS)
    return { home, anchor: text.growsFrom ?? { x: text.x, y: text.y }, unit: printedBox(text, 1), neighbours: [], obstacles, rules: rules.filter((rule) => touchesBox(ruleBox(rule), reach)) }
  })
  const maxima = fittings.map((fitting) => grown(scaled(fitting, MAX_PRINTED_GROWTH), CLEARANCE_CELLS))
  const order = fittings.map((_, i) => i).sort((a, b) => maxima[a].x - maxima[b].x)
  const linesOfOneLabel = (i: number, j: number) => samePoint(texts[i].growsFrom, texts[j].growsFrom)
  for (let k = 0; k < order.length; k++) {
    const a = maxima[order[k]]
    for (let m = k + 1; m < order.length && maxima[order[m]].x < a.x + a.w; m++) {
      if (!boxesMeet(a, maxima[order[m]]) || linesOfOneLabel(order[k], order[m])) continue
      fittings[order[k]].neighbours.push(order[m])
      fittings[order[m]].neighbours.push(order[k])
    }
  }
  const keys = new Map<string, number>()
  const groupOf = texts.map((text, i) => {
    const key = text.group !== undefined ? `g${text.group}` : `t${i}`
    if (!keys.has(key)) keys.set(key, keys.size)
    return keys.get(key)!
  })
  const members: number[][] = Array.from({ length: keys.size }, () => [])
  groupOf.forEach((g, i) => members[g].push(i))
  const factor = new Float64Array(keys.size).fill(1)
  const names = members.map((group) => group.some((i) => isPrintedName(texts[i])))
  const boxes: Box[] = fittings.map((fitting) => scaled(fitting, 1))
  const fits = (i: number) => {
    const fitting = fittings[i]
    const box = boxes[i]
    if (fitting.home && !boxInside(box, fitting.home.points)) return false
    const padded = grown(box, CLEARANCE_CELLS)
    for (const o of fitting.obstacles) if (o.points ? boxMeetsPolygon(padded, o.points, o.box) : boxesMeet(box, o.box)) return false
    for (const rule of fitting.rules) if (ruleCrossesBox(rule, padded)) return false
    for (const j of fitting.neighbours) if (boxesMeet(padded, boxes[j])) return false
    return true
  }
  const steps = Math.round((MAX_PRINTED_GROWTH - 1) / GROWTH_STEP)
  for (const namesFirst of [true, false]) {
    const growing = Uint8Array.from(names, (name) => (name === namesFirst ? 1 : 0))
    for (let step = 0; step <= steps; step++) {
      const f = 1 + step * GROWTH_STEP
      let any = false
      for (let g = 0; g < members.length; g++) {
        if (!growing[g]) continue
        any = true
        for (const i of members[g]) boxes[i] = scaled(fittings[i], f)
      }
      if (!any) break
      const failing: number[] = []
      for (let g = 0; g < members.length; g++) if (growing[g] && !members[g].every(fits)) failing.push(g)
      for (let g = 0; g < members.length; g++) if (growing[g]) factor[g] = f
      for (const g of failing) {
        growing[g] = 0
        factor[g] = Math.max(1, f - GROWTH_STEP)
        for (const i of members[g]) boxes[i] = scaled(fittings[i], factor[g])
      }
    }
  }
  return new Map(texts.map((text, i) => [text, Math.round(factor[groupOf[i]] * 100) / 100]))
}

const growths = new WeakMap<ComponentDef, Growth>()

export function printedGrowth(def: ComponentDef): Growth {
  const cached = growths.get(def)
  if (cached) return cached
  const growth = def.body.some((shape) => shape.type === "text" && shape.printed) ? fitPrinted(def.body, def.pins, def.parts) : new Map<BodyShape, number>()
  growths.set(def, growth)
  return growth
}
