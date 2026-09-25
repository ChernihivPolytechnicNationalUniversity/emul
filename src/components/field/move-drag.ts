import { resolvePinIn, routeWire, snap, toPath, type Direction, type Point } from "@/schematic/geometry"
import type { PinRef, PlacedObject, Wire } from "@/schematic/types"

type Terminal = { point: Point; side: Direction; stub: number }

type ElasticWire = {
  from: Terminal
  to: Terminal
  fromMoves: boolean
  toMoves: boolean
  bends: Point[]
  paths: SVGPathElement[]
}

type RigidWire = { paths: SVGPathElement[] }

export type MovePlan = {
  origin: Point
  grid: number
  cornerRadius: number
  startPositions: ReadonlyMap<string, Point>
  bodies: HTMLElement[]
  pinGroups: SVGGElement[]
  rigidWires: RigidWire[]
  elasticWires: ElasticWire[]
}

const shifted = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy })

const snappedOffset = (plan: MovePlan, at: Point): Point => ({
  x: snap(at.x - plan.origin.x, plan.grid),
  y: snap(at.y - plan.origin.y, plan.grid),
})

function terminalOf(index: ReadonlyMap<string, PlacedObject>, ref: PinRef, grid: number): Terminal | null {
  const found = resolvePinIn(index, ref, grid)
  return found && { point: found.point, side: found.pin.side, stub: found.pin.stub ?? 1 }
}

const pathsOf = (el: Element): SVGPathElement[] => (el instanceof SVGPathElement ? [el] : [...el.querySelectorAll("path")])

function wirePaths(root: ParentNode, wireId: string): SVGPathElement[] {
  return [...root.querySelectorAll(`[data-wire="${CSS.escape(wireId)}"]`)].flatMap(pathsOf)
}

function wirePathsById(root: ParentNode): Map<string, SVGPathElement[]> {
  const byId = new Map<string, SVGPathElement[]>()
  for (const el of root.querySelectorAll<SVGElement>("[data-wire]")) {
    const id = el.dataset.wire!
    const paths = byId.get(id)
    if (paths) paths.push(...pathsOf(el))
    else byId.set(id, pathsOf(el))
  }
  return byId
}

function handlesById<T extends Element>(root: ParentNode, attribute: string): Map<string, T> {
  const byId = new Map<string, T>()
  for (const el of root.querySelectorAll<T>(`[${attribute}]`)) byId.set(el.getAttribute(attribute)!, el)
  return byId
}

export function planMove(
  root: ParentNode,
  objects: readonly PlacedObject[],
  wires: readonly Wire[],
  moving: ReadonlySet<string>,
  origin: Point,
  grid: number,
  cornerRadius: number,
  layer?: { element: HTMLElement | null; whole: boolean },
): MovePlan {
  const index = new Map(objects.map((o) => [o.id, o]))
  const startPositions = new Map<string, Point>()
  for (const o of objects) if (moving.has(o.id)) startPositions.set(o.id, { x: o.x, y: o.y })
  const bodies: HTMLElement[] = layer?.element ? [layer.element] : []
  if (layer?.whole) return { origin, grid, cornerRadius, startPositions, bodies, pinGroups: [], rigidWires: [], elasticWires: [] }

  const bodyOf = handlesById<HTMLElement>(root, "data-body")
  const pinsOf = handlesById<SVGGElement>(root, "data-pins")
  const pinGroups: SVGGElement[] = []
  for (const id of startPositions.keys()) {
    const body = bodyOf.get(id)
    if (body) bodies.push(body)
    const pins = pinsOf.get(id)
    if (pins) pinGroups.push(pins)
  }

  const wirePathsOf = wirePathsById(root)
  const rigidWires: RigidWire[] = []
  const elasticWires: ElasticWire[] = []
  for (const w of wires) {
    const fromMoves = moving.has(w.from.object)
    const toMoves = moving.has(w.to.object)
    if (!fromMoves && !toMoves) continue
    const paths = wirePathsOf.get(w.id)
    if (!paths?.length) continue
    if (fromMoves && toMoves) {
      rigidWires.push({ paths })
      continue
    }
    const from = terminalOf(index, w.from, grid)
    const to = terminalOf(index, w.to, grid)
    if (from && to) elasticWires.push({ from, to, fromMoves, toMoves, bends: w.points ?? [], paths })
  }

  return { origin, grid, cornerRadius, startPositions, bodies, pinGroups, rigidWires, elasticWires }
}

export type BendPlan = {
  wire: string
  index: number
  points: Point[]
  origin: Point
  from: Terminal
  to: Terminal
  grid: number
  cornerRadius: number
  paths: SVGPathElement[]
  originalPath: string
  handle: SVGGElement | null
}

export function planBend(
  root: ParentNode,
  objects: readonly PlacedObject[],
  wire: Wire,
  index: number,
  grid: number,
  cornerRadius: number,
): BendPlan | null {
  const points = wire.points?.slice()
  const origin = points?.[index]
  if (!points || !origin) return null
  const objectIndex = new Map(objects.map((o) => [o.id, o]))
  const from = terminalOf(objectIndex, wire.from, grid)
  const to = terminalOf(objectIndex, wire.to, grid)
  if (!from || !to) return null
  const group = root.querySelector(`[data-wire="${CSS.escape(wire.id)}"] [data-bend="${index}"]`)
  const paths = wirePaths(root, wire.id)
  return {
    wire: wire.id,
    index,
    points,
    origin,
    from,
    to,
    grid,
    cornerRadius,
    paths,
    originalPath: paths[0]?.getAttribute("d") ?? "",
    handle: group instanceof SVGGElement ? group : null,
  }
}

function restoreBend(plan: BendPlan) {
  plan.handle?.setAttribute("transform", "")
  if (plan.originalPath) for (const path of plan.paths) path.setAttribute("d", plan.originalPath)
}

export class BendDrag {
  private plan: BendPlan | null = null
  private pointer: Point | null = null
  private moved = false
  private raf = 0

  get active() {
    return this.plan !== null
  }

  begin(plan: BendPlan | null) {
    this.plan = plan
    this.pointer = null
    this.moved = false
  }

  track(at: Point) {
    if (!this.plan) return
    this.pointer = at
    if (!this.raf) this.raf = requestAnimationFrame(this.frame)
  }

  cancel() {
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    if (this.plan && this.moved) restoreBend(this.plan)
    this.plan = null
    this.pointer = null
    this.moved = false
  }

  preview(at: Point): { wire: string; points: Point[] } | null {
    if (!this.plan) return null
    const points = this.plan.points.slice()
    points[this.plan.index] = at
    return { wire: this.plan.wire, points }
  }

  clearAndFinish(): { wire: string; points: Point[] } | null {
    const plan = this.plan
    const at = this.pointer
    this.cancel()
    if (!plan || !at) return null
    const from = plan.points[plan.index]
    if (at.x === from.x && at.y === from.y) return null
    const points = plan.points.slice()
    points[plan.index] = at
    return { wire: plan.wire, points }
  }

  private frame = () => {
    this.raf = 0
    const plan = this.plan
    const at = this.pointer
    if (!plan || !at) return
    if (at.x === plan.points[plan.index].x && at.y === plan.points[plan.index].y && !this.moved) return
    this.moved = true
    const points = plan.points.slice()
    points[plan.index] = at
    const route = routeWire(plan.from.point, plan.from.side, plan.from.stub, plan.to.point, plan.to.side, plan.to.stub, plan.grid, points)
    const d = toPath(route.pts, plan.cornerRadius)
    for (const path of plan.paths) path.setAttribute("d", d)
    plan.handle?.setAttribute("transform", `translate(${at.x - plan.origin.x} ${at.y - plan.origin.y})`)
  }
}

export class MoveDrag {
  private plan: MovePlan | null = null
  private pointer: Point | null = null
  private offset: Point = { x: 0, y: 0 }
  private raf = 0

  get active() {
    return this.plan !== null
  }

  begin(plan: MovePlan) {
    this.plan = plan
    this.pointer = null
    this.offset = { x: 0, y: 0 }
  }

  track(at: Point) {
    if (!this.plan) return
    this.pointer = at
    if (!this.raf) this.raf = requestAnimationFrame(this.frame)
  }

  preview(): { ids: string[]; dx: number; dy: number } | null {
    if (!this.plan || !this.pointer) return null
    const { x: dx, y: dy } = snappedOffset(this.plan, this.pointer)
    return { ids: [...this.plan.startPositions.keys()], dx, dy }
  }

  clearAndFinish(): { plan: MovePlan; dx: number; dy: number } | null {
    const plan = this.plan
    const at = this.pointer
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    if (plan && (this.offset.x || this.offset.y)) this.paint(plan, 0, 0)
    const { x: dx, y: dy } = plan && at ? snappedOffset(plan, at) : { x: 0, y: 0 }
    this.plan = null
    this.pointer = null
    this.offset = { x: 0, y: 0 }
    return plan ? { plan, dx, dy } : null
  }

  private frame = () => {
    this.raf = 0
    const plan = this.plan
    const at = this.pointer
    if (!plan || !at) return
    const { x: dx, y: dy } = snappedOffset(plan, at)
    if (dx === this.offset.x && dy === this.offset.y) return
    this.offset = { x: dx, y: dy }
    this.paint(plan, dx, dy)
  }

  private paint(plan: MovePlan, dx: number, dy: number) {
    const moved = dx !== 0 || dy !== 0
    const cssTranslate = moved ? `translate(${dx}px, ${dy}px)` : ""
    for (const body of plan.bodies) body.style.transform = cssTranslate
    const svgTranslate = moved ? `translate(${dx} ${dy})` : ""
    for (const group of plan.pinGroups) group.setAttribute("transform", svgTranslate)

    for (const wire of plan.rigidWires) for (const path of wire.paths) path.setAttribute("transform", svgTranslate)

    for (const wire of plan.elasticWires) {
      const from = wire.fromMoves ? shifted(wire.from.point, dx, dy) : wire.from.point
      const to = wire.toMoves ? shifted(wire.to.point, dx, dy) : wire.to.point
      const route = routeWire(from, wire.from.side, wire.from.stub, to, wire.to.side, wire.to.stub, plan.grid, wire.bends)
      const d = toPath(route.pts, plan.cornerRadius)
      for (const path of wire.paths) path.setAttribute("d", d)
    }
  }
}
