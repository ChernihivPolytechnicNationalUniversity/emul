import type { ContactChange } from "@/schematic/contacts"
import { getDef } from "@/schematic/registry"
import { pinKey, type Wire } from "@/schematic/types"
import { pinMarker } from "./pin-marker"

type Restore = () => void

export type ContactLook = {
  grid: number
  wires: readonly Wire[]
  netColor: (pinKey: string) => string | undefined
}

const SVG_NS = "http://www.w3.org/2000/svg"
const MARKER_ATTRIBUTES = ["r", "fill", "stroke", "class", "stroke-width", "display"] as const

function keepAttributes(element: Element, names: readonly string[]): Restore {
  const saved = names.map((name) => [name, element.getAttribute(name)] as const)
  return () => {
    for (const [name, value] of saved) {
      if (value === null) element.removeAttribute(name)
      else element.setAttribute(name, value)
    }
  }
}

function setOrRemove(element: Element, name: string, value: string | number | undefined) {
  if (value === undefined) element.removeAttribute(name)
  else element.setAttribute(name, String(value))
}

export class ContactPreview {
  private readonly pinsOf = new Map<string, { group: Element; byPin: Map<string, SVGGElement> }>()
  private readonly shown = new Map<string, { group: SVGGElement; restore: Restore }>()
  private wired: ReadonlySet<string> | null = null
  private readonly root: ParentNode
  private readonly changesAt: (dx: number, dy: number) => ReadonlyMap<string, ContactChange>
  private readonly look: ContactLook

  constructor(root: ParentNode, changesAt: (dx: number, dy: number) => ReadonlyMap<string, ContactChange>, look: ContactLook) {
    this.root = root
    this.changesAt = changesAt
    this.look = look
  }

  show(dx: number, dy: number) {
    const changes = this.changesAt(dx, dy)
    for (const [key, { group, restore }] of this.shown) {
      if (changes.has(key) && group.isConnected) continue
      restore()
      this.shown.delete(key)
    }
    for (const [key, change] of changes) {
      if (this.shown.has(key)) continue
      const group = this.pinElement(change.object.id, change.pin.id)
      if (group) this.shown.set(key, { group, restore: this.repaint(group, key, change) })
    }
  }

  private isWired(key: string) {
    this.wired ??= new Set(this.look.wires.flatMap((w) => [pinKey(w.from.object, w.from.pin), pinKey(w.to.object, w.to.pin)]))
    return this.wired.has(key)
  }

  private pinElement(object: string, pin: string): SVGGElement | undefined {
    let known = this.pinsOf.get(object)
    if (!known?.group.isConnected) {
      const group = this.root.querySelector(`[data-pins="${CSS.escape(object)}"]`)
      if (!group) return undefined
      const byPin = new Map<string, SVGGElement>()
      for (const element of group.querySelectorAll<SVGGElement>(":scope > [data-pin]")) byPin.set(element.dataset.pin!, element)
      this.pinsOf.set(object, (known = { group, byPin }))
    }
    return known.byPin.get(pin)
  }

  private colorOf(key: string, { contact, touching }: ContactChange): string | undefined {
    if (!contact) return this.isWired(key) ? this.look.netColor(key) : undefined
    for (const pin of [key, ...touching]) {
      const color = this.look.netColor(pin)
      if (color) return color
    }
    return undefined
  }

  private repaint(group: SVGGElement, key: string, change: ContactChange): Restore {
    const { object, pin, contact } = change
    const live = contact || this.isWired(key)
    const marker = pinMarker(getDef(object.def), pin.kind, live, contact, this.colorOf(key, change))
    const restore: Restore[] = []
    let circle = group.querySelector<SVGCircleElement>(":scope > [data-marker]")
    if (circle) restore.push(keepAttributes(circle, MARKER_ATTRIBUTES))
    else if (marker) {
      const hit = group.querySelector(":scope > circle")
      const added = document.createElementNS(SVG_NS, "circle")
      added.setAttribute("data-marker", "")
      added.setAttribute("cx", hit?.getAttribute("cx") ?? "0")
      added.setAttribute("cy", hit?.getAttribute("cy") ?? "0")
      added.setAttribute("vector-effect", "non-scaling-stroke")
      if (hit) hit.after(added)
      else group.prepend(added)
      restore.push(() => added.remove())
      circle = added
    }
    if (circle && marker) {
      circle.removeAttribute("display")
      circle.setAttribute("r", String(marker.radiusCells * this.look.grid))
      circle.setAttribute("class", marker.className)
      circle.setAttribute("stroke-width", String(marker.strokeWidth))
      setOrRemove(circle, "fill", marker.fill)
      setOrRemove(circle, "stroke", marker.stroke)
    } else if (circle) circle.setAttribute("display", "none")
    if (contact) {
      for (const text of group.querySelectorAll(":scope > text")) {
        restore.push(keepAttributes(text, ["display"]))
        text.setAttribute("display", "none")
      }
    }
    return () => {
      for (const undo of restore) undo()
    }
  }
}
