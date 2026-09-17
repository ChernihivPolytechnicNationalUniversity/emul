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

function terminalOf(index: ReadonlyMap<string, PlacedObject>, ref: PinRef, grid: number): Terminal | null {
  const found = resolvePinIn(index, ref, grid)
  return found && { point: found.point, side: found.pin.side, stub: found.pin.stub ?? 1 }
}

function wirePaths(root: ParentNode, wireId: string): SVGPathElement[] {
  const out: SVGPathElement[] = []
  for (const el of root.querySelectorAll(`[data-wire="${CSS.escape(wireId)}"]`)) {
    if (el instanceof SVGPathElement) out.push(el)
    else out.push(...el.querySelectorAll("path"))
  }
  return out
}

export function planMove(
  root: ParentNode,
  objects: readonly PlacedObject[],
  wires: readonly Wire[],
  moving: ReadonlySet<string>,
  origin: Point,
  grid: number,
  cornerRadius: number,
  /**
   * In the canvas band there is no per-object DOM: everything that moves is already on one
   * layer, so the whole drag is a single transform on it.
   */
  layer?: HTMLElement | null,
): MovePlan {
  const index = new Map(objects.map((o) => [o.id, o]))
  const startPositions = new Map<string, Point>()
  const bodies: HTMLElement[] = []
  const pinGroups: SVGGElement[] = []
  for (const o of objects) {
    if (!moving.has(o.id)) continue
    startPositions.set(o.id, { x: o.x, y: o.y })
    if (layer) continue
    const body = root.querySelector<HTMLElement>(`[data-body="${CSS.escape(o.id)}"]`)
    if (body) bodies.push(body)
    const pins = root.querySelector<SVGGElement>(`[data-pins="${CSS.escape(o.id)}"]`)
    if (pins) pinGroups.push(pins)
  }
  if (layer) return { origin, grid, cornerRadius, startPositions, bodies: [layer], pinGroups: [], rigidWires: [], elasticWires: [] }

  const rigidWires: RigidWire[] = []
  const elasticWires: ElasticWire[] = []
  for (const w of wires) {
    const fromMoves = moving.has(w.from.object)
    const toMoves = moving.has(w.to.object)
    if (!fromMoves && !toMoves) continue
    const paths = wirePaths(root, w.id)
    if (paths.length === 0) continue
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

  clearAndFinish(): { wire: string; points: Point[] } | null {
    const plan = this.plan
    const moved = this.moved
    const at = this.pointer
    this.cancel()
    if (!plan || !moved || !at) return null
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

  clearAndFinish(): { plan: MovePlan; dx: number; dy: number } | null {
    const plan = this.plan
    const { x: dx, y: dy } = this.offset
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    if (plan && (dx || dy)) this.paint(plan, 0, 0)
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
    const dx = snap(at.x - plan.origin.x, plan.grid)
    const dy = snap(at.y - plan.origin.y, plan.grid)
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
