import { bendReach, closestOnRoute, liesOnRoute, resolvePinIn, routeWire, snap, toPath, trimRouteEnds, type Point, type WireEnd } from "@/schematic/geometry"
import type { PinRef, PlacedObject, Wire } from "@/schematic/types"

type Terminal = WireEnd

type ElasticWire = {
  from: Terminal
  to: Terminal
  fromMoves: boolean
  toMoves: boolean
  bends: Point[]
  paths: WirePaths
}

type WirePaths = { full: SVGPathElement[]; casings: SVGPathElement[] }

type RigidWire = { elements: SVGElement[] }

type Movable = HTMLElement | SVGSVGElement

export type MovePlan = {
  root: ParentNode
  origin: Point
  grid: number
  cornerRadius: number
  casingTrim: number
  startPositions: ReadonlyMap<string, Point>
  bodies: Movable[]
  svgGroups: SVGGElement[]
  rigidWires: RigidWire[]
  elasticWires: ElasticWire[]
  blocked?: (dx: number, dy: number) => boolean
  contacts?: { show: (dx: number, dy: number) => void }
}

const shifted = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy })

const HANDLE_ATTRIBUTES = ["data-pins", "data-plate"] as const

function reattach(plan: MovePlan) {
  for (let i = 0; i < plan.svgGroups.length; i++) {
    const group = plan.svgGroups[i]
    if (group.isConnected) continue
    const handle = HANDLE_ATTRIBUTES.find((name) => group.hasAttribute(name))
    const fresh = handle && plan.root.querySelector<SVGGElement>(`[${handle}="${CSS.escape(group.getAttribute(handle)!)}"]`)
    if (fresh) plan.svgGroups[i] = fresh
  }
}

const snappedOffset = (plan: MovePlan, at: Point): Point => ({
  x: snap(at.x - plan.origin.x, plan.grid),
  y: snap(at.y - plan.origin.y, plan.grid),
})

function terminalOf(index: ReadonlyMap<string, PlacedObject>, ref: PinRef, grid: number): Terminal | null {
  const found = resolvePinIn(index, ref, grid)
  return found && { point: found.point, side: found.pin.side, stub: found.pin.stub ?? 1 }
}

const pathsOf = (el: Element): SVGPathElement[] => (el instanceof SVGPathElement ? [el] : [...el.querySelectorAll("path")])

function splitCasings(paths: SVGPathElement[]): WirePaths {
  return { full: paths.filter((p) => !p.hasAttribute("data-casing")), casings: paths.filter((p) => p.hasAttribute("data-casing")) }
}

function wirePaths(root: ParentNode, wireId: string): WirePaths {
  return splitCasings([...root.querySelectorAll(`[data-wire="${CSS.escape(wireId)}"]`)].flatMap(pathsOf))
}

function setRoute(paths: WirePaths, pts: Point[], cornerRadius: number, casingTrim: number) {
  const d = toPath(pts, cornerRadius)
  for (const path of paths.full) path.setAttribute("d", d)
  if (paths.casings.length) {
    const casing = toPath(trimRouteEnds(pts, casingTrim), cornerRadius)
    for (const path of paths.casings) path.setAttribute("d", casing)
  }
}

function wireElementsById(root: ParentNode, carried: Element | null): Map<string, SVGElement[]> {
  const byId = new Map<string, SVGElement[]>()
  for (const el of root.querySelectorAll<SVGElement>("[data-wire]")) {
    if (carried?.contains(el)) continue
    const id = el.dataset.wire!
    const elements = byId.get(id)
    if (elements) elements.push(el)
    else byId.set(id, [el])
  }
  return byId
}

function selectionCarriedWhole(root: ParentNode, moving: ReadonlySet<string>, wires: readonly Wire[]): SVGSVGElement | null {
  const layer = root.querySelector<SVGSVGElement>("[data-slot=selection]")
  if (!layer) return null
  for (const plate of layer.querySelectorAll<SVGElement>("[data-plate]")) if (!moving.has(plate.dataset.plate!)) return null
  const byId = new Map(wires.map((w) => [w.id, w]))
  for (const band of layer.querySelectorAll<SVGElement>("[data-wire]")) {
    const w = byId.get(band.dataset.wire!)
    if (!w || !moving.has(w.from.object) || !moving.has(w.to.object)) return null
  }
  return layer
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
  casingTrim: number,
  layer?: { element: HTMLElement | null; whole: boolean },
): MovePlan {
  const index = new Map(objects.map((o) => [o.id, o]))
  const startPositions = new Map<string, Point>()
  for (const o of objects) if (moving.has(o.id)) startPositions.set(o.id, { x: o.x, y: o.y })
  const bodies: Movable[] = layer?.element ? [layer.element] : []
  if (layer?.whole) return { root, origin, grid, cornerRadius, casingTrim, startPositions, bodies, svgGroups: [], rigidWires: [], elasticWires: [] }

  const bodyOf = handlesById<HTMLElement>(root, "data-body")
  const pinsOf = handlesById<SVGGElement>(root, "data-pins")
  const svgGroups: SVGGElement[] = []
  for (const id of startPositions.keys()) {
    const body = bodyOf.get(id)
    if (body) bodies.push(body)
    const pins = pinsOf.get(id)
    if (pins) svgGroups.push(pins)
  }
  const selection = selectionCarriedWhole(root, moving, wires)
  if (selection) bodies.push(selection)
  else for (const plate of root.querySelectorAll<SVGGElement>("[data-plate]")) if (moving.has(plate.dataset.plate!)) svgGroups.push(plate)

  const wireElementsOf = wireElementsById(root, selection)
  const rigidWires: RigidWire[] = []
  const elasticWires: ElasticWire[] = []
  for (const w of wires) {
    const fromMoves = moving.has(w.from.object)
    const toMoves = moving.has(w.to.object)
    if (!fromMoves && !toMoves) continue
    const elements = wireElementsOf.get(w.id)
    if (!elements?.length) continue
    if (fromMoves && toMoves) {
      rigidWires.push({ elements })
      continue
    }
    const from = terminalOf(index, w.from, grid)
    const to = terminalOf(index, w.to, grid)
    if (from && to) elasticWires.push({ from, to, fromMoves, toMoves, bends: w.points ?? [], paths: splitCasings(elements.flatMap(pathsOf)) })
  }

  return { root, origin, grid, cornerRadius, casingTrim, startPositions, bodies, svgGroups, rigidWires, elasticWires }
}

export type BendPlan = {
  wire: string
  index: number
  points: Point[]
  origin: Point
  start: Point
  from: Terminal
  to: Terminal
  grid: number
  cornerRadius: number
  casingTrim: number
  paths: WirePaths
  original: ReadonlyMap<SVGPathElement, string>
  handle: SVGGElement | null
}

export function planBend(
  root: ParentNode,
  objects: readonly PlacedObject[],
  wire: Wire,
  index: number,
  grid: number,
  cornerRadius: number,
  casingTrim: number,
): BendPlan | null {
  const points = wire.points?.slice()
  const stored = points?.[index]
  if (!points || !stored) return null
  const objectIndex = new Map(objects.map((o) => [o.id, o]))
  const from = terminalOf(objectIndex, wire.from, grid)
  const to = terminalOf(objectIndex, wire.to, grid)
  if (!from || !to) return null
  const group = root.querySelector(`[data-wire="${CSS.escape(wire.id)}"] [data-bend="${index}"]`)
  const drawn = group?.querySelector("circle")
  const origin = drawn ? { x: Number(drawn.getAttribute("cx")), y: Number(drawn.getAttribute("cy")) } : stored
  const route = routeWire(from.point, from.side, from.stub, to.point, to.side, to.stub, grid, points).pts
  const onWire = liesOnRoute(route, stored) ? stored : closestOnRoute(route, stored)
  const paths = wirePaths(root, wire.id)
  return {
    wire: wire.id,
    index,
    points,
    origin,
    start: { x: snap(onWire.x, grid), y: snap(onWire.y, grid) },
    from,
    to,
    grid,
    cornerRadius,
    casingTrim,
    paths,
    original: new Map([...paths.full, ...paths.casings].map((path) => [path, path.getAttribute("d") ?? ""])),
    handle: group instanceof SVGGElement ? group : null,
  }
}

function restoreBend(plan: BendPlan) {
  plan.handle?.setAttribute("transform", "")
  for (const [path, d] of plan.original) path.setAttribute("d", d)
}

export class BendDrag {
  private plan: BendPlan | null = null
  private reached: Point | null = null
  private moved = false
  private raf = 0

  get active() {
    return this.plan !== null
  }

  begin(plan: BendPlan | null) {
    this.plan = plan
    this.reached = null
    this.moved = false
  }

  track(pointer: Point) {
    const plan = this.plan
    if (!plan) return
    const from = this.reached ?? plan.start
    const reached = bendReach(plan.from, plan.to, plan.points, plan.index, from, pointer, plan.grid)
    if (!reached) return
    this.reached = reached
    if (!this.raf) this.raf = requestAnimationFrame(this.frame)
  }

  cancel() {
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    if (this.plan && this.moved) restoreBend(this.plan)
    this.plan = null
    this.reached = null
    this.moved = false
  }

  preview(): { wire: string; points: Point[] } | null {
    if (!this.plan || !this.reached) return null
    const points = this.plan.points.slice()
    points[this.plan.index] = this.reached
    return { wire: this.plan.wire, points }
  }

  clearAndFinish(): { wire: string; points: Point[] } | null {
    const plan = this.plan
    const at = this.reached
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
    const at = this.reached
    if (!plan || !at) return
    if (at.x === plan.points[plan.index].x && at.y === plan.points[plan.index].y && !this.moved) return
    this.moved = true
    const points = plan.points.slice()
    points[plan.index] = at
    const route = routeWire(plan.from.point, plan.from.side, plan.from.stub, plan.to.point, plan.to.side, plan.to.stub, plan.grid, points)
    setRoute(plan.paths, route.pts, plan.cornerRadius, plan.casingTrim)
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
    reattach(plan)
    for (const group of plan.svgGroups) group.setAttribute("transform", svgTranslate)
    const blocked = moved && (plan.blocked?.(dx, dy) ?? false)
    for (const element of [...plan.bodies, ...plan.svgGroups]) element.toggleAttribute("data-blocked", blocked)
    plan.contacts?.show(dx, dy)

    for (const wire of plan.rigidWires) for (const element of wire.elements) element.setAttribute("transform", svgTranslate)

    for (const wire of plan.elasticWires) {
      const from = wire.fromMoves ? shifted(wire.from.point, dx, dy) : wire.from.point
      const to = wire.toMoves ? shifted(wire.to.point, dx, dy) : wire.to.point
      const route = routeWire(from, wire.from.side, wire.from.stub, to, wire.to.side, wire.to.stub, plan.grid, wire.bends)
      setRoute(wire.paths, route.pts, plan.cornerRadius, plan.casingTrim)
    }
  }
}
