import { runsOf, type Run } from "@/schematic/circuit"
import { boxesMeet, segmentBox } from "@/schematic/body-crossing"
import { bendsOf, dragConflictMarks, type Stretch } from "@/schematic/conflict-marks"
import { BoxIndex } from "@/schematic/spatial"
import { BODY_EDGE_CELLS, BODY_MASK, type BodyMaskShapes, type CarriedCover } from "./body-mask"
import type { Point, Rect } from "@/schematic/geometry"
import { wireColorVar, type WireColorKey } from "@/schematic/wire-colors"
import { turnsAtPins, type Leads } from "@/schematic/wire-look"
import type { DragFrame } from "@/schematic/wires/drag"
import { normalise } from "@/schematic/wires/normal-form"
import { onLattice, pointKey, samePoint, type WirePin, type WireSegment } from "@/schematic/wires/segment"
import type { WireSheet } from "@/schematic/wires/sheet"
import { SELECTION_BANDS } from "./selection-geometry"
import { conflictCutPaths, conflictGlowPaths, leadPatchPaths, wireCasingPath, wireStrokePath } from "./wire-paths"
import { CASING_PX, casingWidth, CONFLICT_PX, glowCutWidth, WIRE_PX } from "./wire-style"

const SVG_NS = "http://www.w3.org/2000/svg"

export type RubberLook = {
  runOf: (segment: string) => Run | undefined
  colorOfRun: (run: string) => WireColorKey
  colorOfNet: (net: string) => WireColorKey
  sheet: WireSheet
  grid: number
  ringRadius: number
  dotRadius: () => number
  pixel: () => number
}

export type BandPiece = { readonly a: Point; readonly b: Point; readonly color: WireColorKey }

export type BandMark = { readonly at: Point; readonly color: WireColorKey }

export type BandMarks = { readonly open: readonly BandMark[]; readonly dots: readonly BandMark[] }

export type BandRun = { readonly id: string; readonly pts: readonly Point[]; readonly leads?: Leads; readonly color: WireColorKey }

export type BandLook = Pick<RubberLook, "runOf" | "colorOfRun" | "colorOfNet" | "sheet">

export type Band = { readonly lifted: ReadonlyMap<string, Run>; readonly wires: readonly BandRun[]; readonly marks: BandMarks; readonly covered: ReadonlySet<string> }

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

const liesOn = (s: { a: Point; b: Point }, p: Point) =>
  (s.b.x - s.a.x) * (p.y - s.a.y) === (s.b.y - s.a.y) * (p.x - s.a.x) &&
  p.x >= Math.min(s.a.x, s.b.x) &&
  p.x <= Math.max(s.a.x, s.b.x) &&
  p.y >= Math.min(s.a.y, s.b.y) &&
  p.y <= Math.max(s.a.y, s.b.y)

function pinsLanded(sheet: WireSheet, carried: ReadonlyMap<string, Point>): WirePin[] {
  const landed: WirePin[] = []
  for (const [key, at] of carried) {
    const pin = sheet.pin(key)
    if (pin) landed.push({ ...pin, at })
  }
  return landed
}

const alongOf = (s: { a: Point; b: Point }) => {
  const dx = s.b.x - s.a.x
  const dy = s.b.y - s.a.y
  return (p: Point) => (p.x - s.a.x) * dx + (p.y - s.a.y) * dy
}

function uncovered(s: WireSegment, covering: readonly WireSegment[]): WireSegment[] {
  if (!covering.length) return [s]
  const along = alongOf(s)
  const end = along(s.b)
  const cuts = [s.a, s.b, ...covering.flatMap((t) => [t.a, t.b]).filter((p) => along(p) > 0 && along(p) < end)].sort((p, q) => along(p) - along(q))
  const left: WireSegment[] = []
  for (let i = 1; i < cuts.length; i++) {
    const [a, b] = [cuts[i - 1], cuts[i]]
    if (samePoint(a, b)) continue
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    if (!covering.some((t) => liesOn(t, middle))) left.push({ id: `${s.id}:${i}`, a, b, color: s.color })
  }
  return left
}

const offTheField = (segments: readonly WireSegment[], sheet: WireSheet, hidden: ReadonlySet<string>) => segments.flatMap((s) => uncovered(s, sheet.alongSegment(s).filter((t) => !hidden.has(t.id))))

type Contacts = { pins: WirePin[]; junctions: WirePin[] }

function contactsOf(segments: readonly WireSegment[], sheet: WireSheet, hidden: ReadonlySet<string>, carried: ReadonlyMap<string, Point>): Contacts {
  const pins = new Map<string, WirePin>()
  const junctions = new Map<string, WirePin>()
  const junction = (at: Point) => junctions.set(pointKey(at), { key: `junction:${pointKey(at)}`, at })
  const landed = pinsLanded(sheet, carried)
  for (const s of segments) {
    for (const mark of sheet.marksOn(s)) {
      if (mark.segment && !hidden.has(mark.segment.id)) junction(mark.at)
      if (mark.pin && !carried.has(mark.pin.key)) pins.set(mark.pin.key, mark.pin)
    }
    for (const pin of landed) if (liesOn(s, pin.at)) pins.set(pin.key, pin)
    for (const at of [s.a, s.b]) if (sheet.through(at).some((t) => !hidden.has(t.id))) junction(at)
  }
  const wired = new Set(junctions.keys())
  const free = [...pins.values()].filter((pin) => !wired.has(pointKey(pin.at)))
  return { pins: free, junctions: [...junctions.values(), ...[...pins.values()].filter((pin) => wired.has(pointKey(pin.at)))] }
}

function normalBand(segments: readonly WireSegment[], stops: readonly WirePin[]): readonly WireSegment[] {
  const onGrid = segments.filter((s) => onLattice(s.a) && onLattice(s.b))
  if (!onGrid.length) return segments
  let serial = 0
  const normal = normalise(onGrid, stops, undefined, () => `band:n${++serial}`)
  return onGrid.length === segments.length ? normal : [...normal, ...segments.filter((s) => !onLattice(s.a) || !onLattice(s.b))]
}

export function bandRuns(drawn: readonly BandPiece[], sheet: WireSheet, hidden: ReadonlySet<string>, carried: ReadonlyMap<string, Point>, blocked = false): BandRun[] {
  const segments: WireSegment[] = []
  drawn.forEach(({ a, b, color }, i) => {
    if (!samePoint(a, b)) segments.push({ id: `band:${i}`, a, b, color })
  })
  const shown = blocked ? segments : offTheField(segments, sheet, hidden)
  if (!shown.length) return []
  const { pins, junctions } = contactsOf(shown, sheet, hidden, carried)
  const stops = [...pins, ...junctions]
  const runs = runsOf(normalBand(shown, stops), stops)
  const { leads } = turnsAtPins(runs, pins)
  return runs.map((run) => {
    const lead = leads.get(run.id)
    return { id: run.id, pts: run.points, color: run.segments[0].color!, ...(lead && { leads: lead }) }
  })
}

export function bandOf(frame: DragFrame, look: BandLook, always: ReadonlySet<string> = new Set()): Band {
  const lifted = new Map<string, Run>()
  for (const id of [...always, ...frame.replaced]) {
    const run = look.runOf(id)
    if (run) lifted.set(run.id, run)
  }
  const drawn: BandPiece[] = []
  for (const run of lifted.values()) for (const s of run.segments) if (!frame.replaced.has(s.id)) drawn.push({ a: s.a, b: s.b, color: s.color ?? look.colorOfRun(run.id) })
  for (const piece of frame.pieces) {
    const run = piece.source !== undefined ? look.runOf(piece.source) : undefined
    drawn.push({ a: piece.a, b: piece.b, color: piece.color ?? (run ? look.colorOfRun(run.id) : look.colorOfNet(piece.net)) })
  }
  const hidden = new Set<string>()
  const covered = new Set<string>()
  for (const run of lifted.values()) {
    for (const s of run.segments) hidden.add(s.id)
    for (const p of run.points) covered.add(pointKey(p))
  }
  for (const piece of drawn) {
    covered.add(pointKey(piece.a))
    covered.add(pointKey(piece.b))
  }
  const marks = drawn.length ? bandMarks(drawn, look.sheet, hidden, frame.pins) : { open: [], dots: [] }
  return { lifted, wires: bandRuns(drawn, look.sheet, hidden, frame.pins, frame.blocked), marks, covered }
}

export const bandGlow = (frame: DragFrame, wires: readonly BandRun[], grid: number): string[] => (frame.blocked ? conflictGlowPaths(dragConflictMarks(frame, undefined, grid).stretches, bendsOf(wires.map((w) => w.pts)), grid) : [])

export type BandCover = CarriedCover & { readonly runsNear: (box: Rect) => Iterable<string> }

export function runsNear(wires: readonly WireSegment[], runOf: (segment: string) => Run | undefined, grid: number): (box: Rect) => Set<string> {
  let index: BoxIndex<WireSegment> | null = null
  return (box) => {
    index ??= new BoxIndex(wires, segmentBox, 16 * grid)
    const runs = new Set<string>()
    index.some(box, (s) => {
      const run = boxesMeet(segmentBox(s), box) ? runOf(s.id) : undefined
      if (run) runs.add(run.id)
      return false
    })
    return runs
  }
}

const CARRIED_MASK_ID = "rubber-band-carried-mask"

const CARRIED_MASK = `url(#${CARRIED_MASK_ID})`

const EVERYWHERE = { x: -1e7, y: -1e7, width: 2e7, height: 2e7 }

const ORIGIN: Point = { x: 0, y: 0 }

const CONFLICT_GLOW_REACH_PX = 1 + 2.5 + 6

const CASINGS_KEEP_OFF_PX = Math.max(CONFLICT_GLOW_REACH_PX, ...SELECTION_BANDS.map((band) => band.margin)) + 2

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
  private readonly cover: BandCover | undefined
  private carried: { defs: SVGDefsElement; shifted: SVGGElement; glowing: SVGGElement } | null = null
  private readonly coveredCasings = new Map<string, SVGElement[]>()

  constructor(root: ParentNode, look: RubberLook, always: ReadonlySet<string> = new Set(), cover?: BandCover) {
    this.root = root
    this.look = look
    this.always = always
    this.cover = cover
  }

  private carriedMask(): { shifted: SVGGElement; glowing: SVGGElement } | null {
    if (this.carried?.defs.isConnected) return this.carried
    const svg = this.host()?.parentNode
    if (!this.cover || !svg) return null
    const defs = document.createElementNS(SVG_NS, "defs")
    const mask = svgElement("mask", { id: CARRIED_MASK_ID, maskUnits: "userSpaceOnUse", ...EVERYWHERE })
    const everywhere = svgElement("rect", { ...EVERYWHERE, fill: "white" })
    const shifted = document.createElementNS(SVG_NS, "g")
    appendMaskShapes(shifted, this.cover.shapes, Math.max(BODY_EDGE_CELLS * this.look.grid, 2 * CASINGS_KEEP_OFF_PX * this.look.pixel()))
    const glowing = document.createElementNS(SVG_NS, "g")
    mask.append(everywhere, shifted, glowing)
    defs.append(mask)
    svg.append(defs)
    this.carried = { defs, shifted, glowing }
    return this.carried
  }

  private coverCarried(offset: Point, glow: readonly string[], glowing: readonly Stretch[]) {
    const cover = this.cover
    const mask = cover && this.carriedMask()
    if (!cover || !mask) return
    mask.shifted.setAttribute("transform", `translate(${offset.x} ${offset.y})`)
    const px = this.look.pixel()
    mask.glowing.replaceChildren(...glow.map((d) => svgElement("path", { d, fill: "none", stroke: "black", "stroke-width": glowCutWidth(px), "stroke-linecap": "round", "stroke-linejoin": "round" })))
    const reach = Math.max(this.look.grid, (CASINGS_KEEP_OFF_PX + casingWidth(WIRE_PX)) * px)
    const grown = (box: Rect, by: Point) => ({ x: box.x + by.x - reach, y: box.y + by.y - reach, w: box.w + 2 * reach, h: box.h + 2 * reach })
    const near = new Set<string>()
    for (const box of [...cover.boxes.map((b) => grown(b, offset)), ...glowing.map((s) => grown(boxOfPoints(s), ORIGIN))]) for (const run of cover.runsNear(box)) near.add(run)
    for (const [run, casings] of this.coveredCasings) {
      if (near.has(run) && casings.every((c) => c.isConnected)) continue
      for (const casing of casings) casing.removeAttribute("mask")
      this.coveredCasings.delete(run)
    }
    for (const run of near) {
      if (this.coveredCasings.has(run)) continue
      const casings = [...this.root.querySelectorAll<SVGElement>(`[data-casing][data-wire="${CSS.escape(run)}"]`)]
      for (const casing of casings) casing.setAttribute("mask", CARRIED_MASK)
      this.coveredCasings.set(run, casings)
    }
  }

  private uncoverCarried() {
    for (const casings of this.coveredCasings.values()) for (const casing of casings) casing.removeAttribute("mask")
    this.coveredCasings.clear()
    this.carried?.defs.remove()
    this.carried = null
  }

  private glowHost(): SVGGElement | null {
    return this.root.querySelector<SVGGElement>("[data-slot=conflict-glow] > g[data-band]")
  }

  private host(): SVGGElement | null {
    if (this.layer?.isConnected) return this.layer
    this.layer = this.root.querySelector<SVGGElement>("[data-slot=rubber-band] > g")
    return this.layer
  }

  show(frame: DragFrame, offset: Point = ORIGIN) {
    const band = bandOf(frame, this.look, this.always)
    for (const [id, saved] of this.hidden) {
      if (band.lifted.has(id)) continue
      for (const { element, display } of saved) element.style.display = display
      this.hidden.delete(id)
    }
    for (const id of band.lifted.keys()) {
      if (this.hidden.has(id)) continue
      const saved = [...this.root.querySelectorAll<SVGElement>(`[data-wire="${CSS.escape(id)}"]`)].map((element) => ({ element, display: element.style.display }))
      for (const { element } of saved) element.style.display = "none"
      this.hidden.set(id, saved)
    }
    this.hideMarks(band.covered)
    const glowing = frame.blocked ? dragConflictMarks(frame, undefined, this.look.grid).stretches : []
    const glow = glowing.length ? conflictGlowPaths(glowing, bendsOf(band.wires.map((w) => w.pts)), this.look.grid) : []
    this.coverCarried(offset, conflictCutPaths(glowing, this.look.grid), glowing)
    this.paint(band.wires, frame.blocked, band.marks, glow)
  }

  clear() {
    for (const saved of this.hidden.values()) for (const { element, display } of saved) element.style.display = display
    this.hidden.clear()
    this.hideMarks(new Set())
    this.marksAt = null
    this.uncoverCarried()
    this.paint([], false, { open: [], dots: [] }, [])
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

  private paint(wires: readonly BandRun[], blocked: boolean, marks: BandMarks, glow: readonly string[]) {
    const layer = this.host()
    if (!layer) return
    layer.replaceChildren()
    layer.toggleAttribute("data-blocked", blocked)
    const { grid } = this.look
    const px = this.look.pixel()
    this.glowHost()?.replaceChildren(...(glow.length ? [conflictGlow(glow, px)] : []))
    const casings = document.createElementNS(SVG_NS, "g")
    casings.setAttribute("mask", BODY_MASK)
    let outer: SVGGElement = casings
    if (this.carried) outer = wrapped(outer, CARRIED_MASK)
    layer.append(outer)
    for (const wire of wires) casings.append(stroked(wireCasingPath(wire, grid), "var(--background)", casingWidth(WIRE_PX), "butt"))
    for (const wire of wires) for (const d of leadPatchPaths(wire, this.look.pixel())) layer.append(stroked(d, "var(--background)", WIRE_PX + CASING_PX, "butt", "miter"))
    for (const wire of wires) {
      const path = stroked(wireStrokePath(wire, grid), wireColorVar(wire.color), WIRE_PX, "round")
      path.setAttribute("data-points", wire.pts.map((p) => `${p.x},${p.y}`).join(" "))
      layer.append(path)
    }
    const dotR = this.look.dotRadius()
    for (const { at, color } of marks.dots) {
      const dot = document.createElementNS(SVG_NS, "g")
      dot.setAttribute("data-band-junction", pointKey(at))
      dot.append(circle(at, dotR, wireColorVar(color)))
      layer.append(dot)
    }
    for (const { at, color } of marks.open) {
      const ring = circle(at, this.look.ringRadius, "var(--background)")
      ring.setAttribute("data-band-dangling", pointKey(at))
      ring.setAttribute("stroke", wireColorVar(color))
      ring.setAttribute("stroke-width", String(WIRE_PX))
      ring.setAttribute("vector-effect", "non-scaling-stroke")
      layer.append(ring)
    }
  }
}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value))
  return element
}

function appendMaskShapes(parent: SVGGElement, shapes: BodyMaskShapes, width: number) {
  const black = { fill: "black", stroke: "black", "stroke-width": width, "stroke-linejoin": "round", "stroke-linecap": "round" }
  for (const points of shapes.bodies) parent.append(svgElement("polygon", { points: points.map((p) => `${p.x},${p.y}`).join(" "), ...black }))
  for (const [a, b] of shapes.leads) parent.append(svgElement("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...black }))
  for (const r of shapes.texts) parent.append(svgElement("rect", { x: r.x, y: r.y, width: r.w, height: r.h, ...black }))
}

function boxOfPoints(points: readonly Point[]): Rect {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

function wrapped(inner: SVGGElement, mask: string): SVGGElement {
  const outer = svgElement("g", { mask })
  outer.append(inner)
  return outer
}

function conflictGlow(paths: readonly string[], px: number): SVGGElement {
  const glow = document.createElementNS(SVG_NS, "g")
  glow.setAttribute("data-conflict-glow", "")
  glow.style.setProperty("--conflict-px", `${px}px`)
  for (const d of paths) glow.append(stroked(d, "var(--conflict)", CONFLICT_PX, "round"))
  return glow
}

function stroked(d: string, stroke: string, width: number, cap: "butt" | "round", join: "round" | "miter" = "round"): SVGPathElement {
  const path = document.createElementNS(SVG_NS, "path")
  path.setAttribute("d", d)
  path.setAttribute("fill", "none")
  path.setAttribute("stroke", stroke)
  path.setAttribute("stroke-width", String(width))
  path.setAttribute("stroke-linecap", cap)
  path.setAttribute("stroke-linejoin", join)
  path.setAttribute("vector-effect", "non-scaling-stroke")
  return path
}

function circle(at: Point, r: number, fill: string): SVGCircleElement {
  const element = document.createElementNS(SVG_NS, "circle")
  element.setAttribute("cx", String(at.x))
  element.setAttribute("cy", String(at.y))
  element.setAttribute("r", String(r))
  element.setAttribute("fill", fill)
  return element
}
