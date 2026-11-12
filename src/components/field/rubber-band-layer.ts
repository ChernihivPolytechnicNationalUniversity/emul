import type { Run } from "@/schematic/circuit"
import { BODY_MASK } from "./body-mask"
import type { Point } from "@/schematic/geometry"
import { wireColorVar, type WireColorKey } from "@/schematic/wire-colors"
import type { DragFrame } from "@/schematic/wires/drag"
import { pointKey, samePoint, type WireSegment } from "@/schematic/wires/segment"
import type { WireSheet } from "@/schematic/wires/sheet"
import { casingWidth, SELECTED_WIRE_PX, WIRE_PX } from "./wire-style"

const SVG_NS = "http://www.w3.org/2000/svg"

export type RubberLook = {
  runOf: (segment: string) => Run | undefined
  colorOfRun: (run: string) => WireColorKey
  colorOfNet: (net: string) => WireColorKey
  sheet: WireSheet
  ringRadius: number
  casingTrim: number
  dotRadius: () => number
  pixel: () => number
}

export type BandPiece = { readonly a: Point; readonly b: Point; readonly color: WireColorKey }

export type BandMark = { readonly at: Point; readonly color: WireColorKey }

export type BandMarks = { readonly open: readonly BandMark[]; readonly dots: readonly BandMark[] }

const isEndOf = (s: { a: Point; b: Point }, p: Point) => samePoint(s.a, p) || samePoint(s.b, p)

const passesThrough = (s: { a: Point; b: Point }, p: Point) =>
  !isEndOf(s, p) &&
  (s.b.x - s.a.x) * (p.y - s.a.y) === (s.b.y - s.a.y) * (p.x - s.a.x) &&
  p.x >= Math.min(s.a.x, s.b.x) &&
  p.x <= Math.max(s.a.x, s.b.x) &&
  p.y >= Math.min(s.a.y, s.b.y) &&
  p.y <= Math.max(s.a.y, s.b.y)

function linesOf(drawn: readonly BandPiece[]) {
  const rows = new Map<number, BandPiece[]>()
  const columns = new Map<number, BandPiece[]>()
  const slants: BandPiece[] = []
  for (const piece of drawn) {
    const line = piece.a.y === piece.b.y ? rows.get(piece.a.y) ?? rows.set(piece.a.y, []).get(piece.a.y)! : piece.a.x === piece.b.x ? columns.get(piece.a.x) ?? columns.set(piece.a.x, []).get(piece.a.x)! : slants
    line.push(piece)
  }
  return (p: Point) => [...(rows.get(p.y) ?? []), ...(columns.get(p.x) ?? []), ...slants]
}

export function bandMarks(drawn: readonly BandPiece[], sheet: WireSheet, hidden: ReadonlySet<string>, carried: ReadonlyMap<string, Point>): BandMarks {
  const ends = new Map<string, { at: Point; count: number; color: WireColorKey }>()
  for (const piece of drawn)
    for (const at of [piece.a, piece.b]) {
      const key = pointKey(at)
      const end = ends.get(key)
      if (end) end.count++
      else ends.set(key, { at, count: 1, color: piece.color })
    }
  const landed = new Map<string, number>()
  for (const at of carried.values()) landed.set(pointKey(at), (landed.get(pointKey(at)) ?? 0) + 1)
  const near = linesOf(drawn)
  const open: BandMark[] = []
  const dots: BandMark[] = []
  for (const [key, { at, count, color }] of ends) {
    const staticEnds = sheet.endsAt(at).filter((s) => !hidden.has(s.id)).length
    const passing = sheet.through(at).filter((s) => !hidden.has(s.id) && !isEndOf(s, at)).length + near(at).filter((s) => passesThrough(s, at)).length
    const pins = sheet.pinsAt(at).filter((p) => !carried.has(p.key)).length + (landed.get(key) ?? 0)
    const meeting = count + staticEnds + 2 * passing + pins
    if (meeting === 1) open.push({ at, color })
    else if (meeting >= 3) dots.push({ at, color })
  }
  return { open, dots }
}

export function bandCasings(drawn: readonly { readonly a: Point; readonly b: Point }[], trim: number): { a: Point; b: Point }[] {
  const ends = new Map<string, number>()
  for (const { a, b } of drawn) for (const p of [a, b]) ends.set(pointKey(p), (ends.get(pointKey(p)) ?? 0) + 1)
  const lone = (p: Point) => ends.get(pointKey(p)) === 1
  return drawn.map(({ a, b }) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    const t = length ? Math.min(trim, length / 2) / length : 0
    const inward = (from: Point, to: Point) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    return { a: lone(a) ? inward(a, b) : a, b: lone(b) ? inward(b, a) : b }
  })
}

const SVG_MARKS = "[data-slot=wire-marks] > [data-junction], [data-slot=wire-marks] > [data-dangling], [data-corner]"

const markPoint = (element: Element) => element.getAttribute("data-junction") ?? element.getAttribute("data-dangling") ?? element.getAttribute("data-corner")

export class RubberBandLayer {
  private readonly root: ParentNode
  private readonly look: RubberLook
  private readonly hidden = new Map<string, { element: SVGElement; display: string }[]>()
  private readonly hiddenMarks = new Map<SVGElement, { at: string; display: string }>()
  private marksAt: Map<string, SVGElement[]> | null = null
  private layer: SVGGElement | null = null
  private readonly always: ReadonlySet<string>

  constructor(root: ParentNode, look: RubberLook, always: ReadonlySet<string> = new Set()) {
    this.root = root
    this.look = look
    this.always = always
  }

  private host(): SVGGElement | null {
    if (this.layer?.isConnected) return this.layer
    this.layer = this.root.querySelector<SVGGElement>("[data-slot=rubber-band] > g")
    return this.layer
  }

  show(frame: DragFrame) {
    const runs = new Map<string, Run>()
    for (const id of this.always) {
      const run = this.look.runOf(id)
      if (run) runs.set(run.id, run)
    }
    for (const id of frame.replaced) {
      const run = this.look.runOf(id)
      if (run) runs.set(run.id, run)
    }
    for (const [id, saved] of this.hidden) {
      if (runs.has(id)) continue
      for (const { element, display } of saved) element.style.display = display
      this.hidden.delete(id)
    }
    for (const id of runs.keys()) {
      if (this.hidden.has(id)) continue
      const saved = [...this.root.querySelectorAll<SVGElement>(`[data-wire="${CSS.escape(id)}"]`)].map((element) => ({ element, display: element.style.display }))
      for (const { element } of saved) element.style.display = "none"
      this.hidden.set(id, saved)
    }
    const drawn: BandPiece[] = []
    const kept = (s: WireSegment) => !frame.replaced.has(s.id)
    for (const run of runs.values()) for (const s of run.segments) if (kept(s)) drawn.push({ a: s.a, b: s.b, color: s.color ?? this.look.colorOfRun(run.id) })
    for (const piece of frame.pieces) {
      const run = piece.source !== undefined ? this.look.runOf(piece.source) : undefined
      drawn.push({ a: piece.a, b: piece.b, color: piece.color ?? (run ? this.look.colorOfRun(run.id) : this.look.colorOfNet(piece.net)) })
    }
    const hiddenSegments = new Set<string>()
    const covered = new Set<string>()
    for (const run of runs.values()) {
      for (const s of run.segments) hiddenSegments.add(s.id)
      for (const p of run.points) covered.add(pointKey(p))
    }
    for (const piece of drawn) {
      covered.add(pointKey(piece.a))
      covered.add(pointKey(piece.b))
    }
    this.hideMarks(covered)
    this.paint(drawn, frame.blocked, drawn.length ? bandMarks(drawn, this.look.sheet, hiddenSegments, frame.pins) : { open: [], dots: [] })
  }

  clear() {
    for (const saved of this.hidden.values()) for (const { element, display } of saved) element.style.display = display
    this.hidden.clear()
    this.hideMarks(new Set())
    this.marksAt = null
    this.paint([], false, { open: [], dots: [] })
  }

  private markIndex(): Map<string, SVGElement[]> {
    if (this.marksAt) return this.marksAt
    const index = new Map<string, SVGElement[]>()
    for (const element of this.root.querySelectorAll<SVGElement>(SVG_MARKS)) {
      const at = markPoint(element)
      if (at === null) continue
      const list = index.get(at)
      if (list) list.push(element)
      else index.set(at, [element])
    }
    return (this.marksAt = index)
  }

  private hideMarks(points: ReadonlySet<string>) {
    for (const [element, saved] of this.hiddenMarks) {
      if (points.has(saved.at) && element.isConnected) continue
      element.style.display = saved.display
      this.hiddenMarks.delete(element)
    }
    if (!points.size) return
    const index = this.markIndex()
    for (const at of points)
      for (const element of index.get(at) ?? []) {
        if (this.hiddenMarks.has(element) || !element.isConnected) continue
        this.hiddenMarks.set(element, { at, display: element.style.display })
        element.style.display = "none"
      }
  }

  private paint(drawn: readonly BandPiece[], blocked: boolean, marks: BandMarks) {
    const layer = this.host()
    if (!layer) return
    layer.replaceChildren()
    layer.toggleAttribute("data-blocked", blocked)
    const casings = document.createElementNS(SVG_NS, "g")
    casings.setAttribute("mask", BODY_MASK)
    layer.append(casings)
    for (const { a, b } of bandCasings(drawn, this.look.casingTrim)) {
      const path = document.createElementNS(SVG_NS, "path")
      path.setAttribute("d", `M${a.x} ${a.y} L${b.x} ${b.y}`)
      path.setAttribute("fill", "none")
      path.setAttribute("stroke", "var(--background)")
      path.setAttribute("stroke-width", String(casingWidth(WIRE_PX)))
      path.setAttribute("stroke-linecap", "butt")
      path.setAttribute("vector-effect", "non-scaling-stroke")
      path.setAttribute("data-band-casing", "")
      casings.append(path)
    }
    for (const { a, b, color } of drawn) {
      const path = document.createElementNS(SVG_NS, "path")
      path.setAttribute("d", `M${a.x} ${a.y} L${b.x} ${b.y}`)
      path.setAttribute("fill", "none")
      path.setAttribute("stroke", blocked ? "var(--destructive)" : wireColorVar(color))
      path.setAttribute("stroke-width", String(blocked ? SELECTED_WIRE_PX : WIRE_PX))
      path.setAttribute("stroke-linecap", "round")
      path.setAttribute("vector-effect", "non-scaling-stroke")
      path.setAttribute("data-piece", `${a.x} ${a.y} ${b.x} ${b.y}`)
      layer.append(path)
    }
    const stroke = (color: WireColorKey) => (blocked ? "var(--destructive)" : wireColorVar(color))
    const dotR = this.look.dotRadius()
    for (const { at, color } of marks.dots) {
      const dot = document.createElementNS(SVG_NS, "g")
      dot.setAttribute("data-band-junction", pointKey(at))
      dot.append(circle(at, dotR, stroke(color)))
      layer.append(dot)
    }
    for (const { at, color } of marks.open) {
      const ring = circle(at, this.look.ringRadius, "var(--background)")
      ring.setAttribute("data-band-dangling", pointKey(at))
      ring.setAttribute("stroke", stroke(color))
      ring.setAttribute("stroke-width", String(blocked ? SELECTED_WIRE_PX : WIRE_PX))
      ring.setAttribute("vector-effect", "non-scaling-stroke")
      layer.append(ring)
    }
  }
}

function circle(at: Point, r: number, fill: string): SVGCircleElement {
  const element = document.createElementNS(SVG_NS, "circle")
  element.setAttribute("cx", String(at.x))
  element.setAttribute("cy", String(at.y))
  element.setAttribute("r", String(r))
  element.setAttribute("fill", fill)
  return element
}
