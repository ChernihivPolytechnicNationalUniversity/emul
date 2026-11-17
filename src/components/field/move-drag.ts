import { snap, type Point } from "@/schematic/geometry"
import type { PlacedObject } from "@/schematic/types"

type RigidWire = { elements: SVGElement[] }

type Movable = HTMLElement | SVGSVGElement

export type MovePlan = {
  root: ParentNode
  origin: Point
  grid: number
  startPositions: ReadonlyMap<string, Point>
  bodies: Movable[]
  svgGroups: SVGGElement[]
  rigidWires: RigidWire[]
  hiddenMarks?: SVGElement[]
  blocked?: (dx: number, dy: number) => boolean
  conflicting?: (dx: number, dy: number) => ReadonlySet<string>
  pixel?: () => number
  contacts?: { show: (dx: number, dy: number) => void }
  rubber?: { show: (dx: number, dy: number) => void; clear: () => void }
}

const HANDLE_ATTRIBUTES = ["data-pins", "data-plate"] as const

const NOTHING: ReadonlySet<string> = new Set()

const partOf = (element: Element) => element.getAttribute("data-body") ?? element.getAttribute("data-pins")

function inConflict(element: Element, conflicting: ReadonlySet<string>): boolean {
  const part = partOf(element)
  if (part !== null) return conflicting.has(part)
  return element.getAttribute("data-slot") === "field-drag-layer" && conflicting.size > 0
}

function markConflict(element: HTMLElement | SVGElement, on: boolean, px: number) {
  element.toggleAttribute("data-conflict", on)
  if (on) element.style.setProperty("--conflict-px", `${px}px`)
  else element.style.removeProperty("--conflict-px")
}

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

function selectionCarriedWhole(root: ParentNode, moving: ReadonlySet<string>, travelling: ReadonlySet<string>): SVGSVGElement | null {
  const layer = root.querySelector<SVGSVGElement>("[data-slot=selection]")
  if (!layer) return null
  for (const plate of layer.querySelectorAll<SVGElement>("[data-plate]")) if (!moving.has(plate.dataset.plate!)) return null
  for (const band of layer.querySelectorAll<SVGElement>("[data-wire]")) if (!travelling.has(band.dataset.wire!)) return null
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
  travelling: ReadonlySet<string>,
  moving: ReadonlySet<string>,
  origin: Point,
  grid: number,
  layer?: { element: HTMLElement | null; whole: boolean },
): MovePlan {
  const startPositions = new Map<string, Point>()
  for (const o of objects) if (moving.has(o.id)) startPositions.set(o.id, { x: o.x, y: o.y })
  const bodies: Movable[] = layer?.element ? [layer.element] : []
  if (layer?.whole) return { root, origin, grid, startPositions, bodies, svgGroups: [], rigidWires: [] }

  const bodyOf = handlesById<HTMLElement>(root, "data-body")
  const pinsOf = handlesById<SVGGElement>(root, "data-pins")
  const svgGroups: SVGGElement[] = []
  for (const id of startPositions.keys()) {
    const body = bodyOf.get(id)
    if (body) bodies.push(body)
    const pins = pinsOf.get(id)
    if (pins) svgGroups.push(pins)
  }
  const selection = selectionCarriedWhole(root, moving, travelling)
  if (selection) bodies.push(selection)
  else for (const plate of root.querySelectorAll<SVGGElement>("[data-plate]")) if (moving.has(plate.dataset.plate!)) svgGroups.push(plate)

  const wireElementsOf = wireElementsById(root, selection)
  const rigidWires: RigidWire[] = []
  for (const id of travelling) {
    const elements = wireElementsOf.get(id)
    if (elements?.length) rigidWires.push({ elements })
  }

  const hiddenMarks: SVGElement[] = []
  for (const mark of root.querySelectorAll<SVGElement>("[data-slot=wires] [data-wires]")) {
    if (selection?.contains(mark)) continue
    const wires = mark.dataset.wires!.split(" ")
    const carried = wires.filter((id) => travelling.has(id)).length
    if (carried === wires.length) rigidWires.push({ elements: [mark] })
    else if (carried > 0) hiddenMarks.push(mark)
  }

  return { root, origin, grid, startPositions, bodies, svgGroups, rigidWires, hiddenMarks }
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
    if (plan.root instanceof Element) plan.root.toggleAttribute("data-dragging", true)
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
    if (plan?.root instanceof Element) plan.root.removeAttribute("data-dragging")
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
    const conflicting = moved ? (plan.conflicting?.(dx, dy) ?? NOTHING) : NOTHING
    const px = plan.pixel?.() ?? 1
    for (const element of [...plan.bodies, ...plan.svgGroups]) {
      element.toggleAttribute("data-blocked", blocked)
      markConflict(element, inConflict(element, conflicting), px)
    }
    plan.contacts?.show(dx, dy)
    if (moved) plan.rubber?.show(dx, dy)
    else plan.rubber?.clear()

    for (const wire of plan.rigidWires) for (const element of wire.elements) element.setAttribute("transform", svgTranslate)
    for (const mark of plan.hiddenMarks ?? []) mark.style.visibility = moved ? "hidden" : ""
  }
}
