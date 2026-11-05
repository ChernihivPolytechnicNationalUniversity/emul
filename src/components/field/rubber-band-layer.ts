import type { Run } from "@/schematic/circuit"
import type { Point } from "@/schematic/geometry"
import { wireColorVar, type WireColorKey } from "@/schematic/wire-colors"
import type { DragFrame } from "@/schematic/wires/drag"
import type { WireSegment } from "@/schematic/wires/segment"
import { CASING_PX, WIRE_PX } from "./wire-style"

const SVG_NS = "http://www.w3.org/2000/svg"

export type RubberLook = {
  runOf: (segment: string) => Run | undefined
  colorOfRun: (run: string) => WireColorKey
  colorOfNet: (net: string) => WireColorKey
}

type Drawn = { readonly a: Point; readonly b: Point; readonly color: WireColorKey }

export class RubberBandLayer {
  private readonly root: ParentNode
  private readonly look: RubberLook
  private readonly hidden = new Map<string, { element: SVGElement; display: string }[]>()
  private layer: SVGGElement | null = null

  constructor(root: ParentNode, look: RubberLook) {
    this.root = root
    this.look = look
  }

  private host(): SVGGElement | null {
    if (this.layer?.isConnected) return this.layer
    this.layer = this.root.querySelector<SVGGElement>("[data-slot=rubber-band] > g")
    return this.layer
  }

  show(frame: DragFrame) {
    const runs = new Map<string, Run>()
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
    const drawn: Drawn[] = []
    const kept = (s: WireSegment) => !frame.replaced.has(s.id)
    for (const run of runs.values()) for (const s of run.segments) if (kept(s)) drawn.push({ a: s.a, b: s.b, color: s.color ?? this.look.colorOfRun(run.id) })
    for (const piece of frame.pieces) {
      const run = piece.source !== undefined ? this.look.runOf(piece.source) : undefined
      drawn.push({ a: piece.a, b: piece.b, color: piece.color ?? (run ? this.look.colorOfRun(run.id) : this.look.colorOfNet(piece.net)) })
    }
    this.paint(drawn, frame.blocked)
  }

  clear() {
    for (const saved of this.hidden.values()) for (const { element, display } of saved) element.style.display = display
    this.hidden.clear()
    this.paint([], false)
  }

  private paint(drawn: readonly Drawn[], blocked: boolean) {
    const layer = this.host()
    if (!layer) return
    layer.replaceChildren()
    layer.toggleAttribute("data-blocked", blocked)
    for (const casing of [true, false])
      for (const { a, b, color } of drawn) {
        const path = document.createElementNS(SVG_NS, "path")
        path.setAttribute("d", `M${a.x} ${a.y} L${b.x} ${b.y}`)
        path.setAttribute("fill", "none")
        path.setAttribute("stroke", casing ? "var(--background)" : blocked ? "var(--destructive)" : wireColorVar(color))
        path.setAttribute("stroke-width", String(casing ? WIRE_PX + CASING_PX : WIRE_PX))
        path.setAttribute("stroke-linecap", casing ? "butt" : "round")
        path.setAttribute("vector-effect", "non-scaling-stroke")
        if (!casing) path.setAttribute("data-piece", `${a.x} ${a.y} ${b.x} ${b.y}`)
        layer.append(path)
      }
  }
}
