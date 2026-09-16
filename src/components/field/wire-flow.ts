const FLOW_MIN = 1e-5
const FLOW_TAU = 300
const WEIGHT_GAIN = 0.8
const SETTLED = 1e-3

export function weight(i: number) {
  const a = Math.abs(i)
  if (a < FLOW_MIN) return 0
  return Math.min(1, Math.log10(a / FLOW_MIN) / 4)
}

type Ref = (el: SVGPathElement | null) => void

type Painted = { opacity: string; width: string }

/**
 * Drives the current animation of every wire straight on the DOM from one rAF loop, outside
 * React: the dash offset follows the solver's integrated charge, the stroke widens with the
 * current on a smoothed log scale. Nothing here re-renders a component.
 */
export class WireFlow {
  private bodies = new Map<string, SVGPathElement>()
  private dashes = new Map<string, SVGPathElement>()
  private bodyRefs = new Map<string, Ref>()
  private dashRefs = new Map<string, Ref>()
  private painted = new Map<string, Painted>()
  private from = new Map<string, number>()
  private to: ReadonlyMap<string, number> = new Map()
  private shown = new Map<string, number>()
  private targetWeight = new Map<string, number>()
  private nowWeight = new Map<string, number>()
  private at = 0
  private span = 50
  private live = false
  private paused = false
  private scale = 1
  private raf = 0
  private frameAt = 0

  /** A stable ref callback per wire, so React never detaches and re-attaches on a re-render. */
  bodyRef(id: string): Ref {
    return stableRef(this.bodyRefs, id, (el) => {
      if (el) this.bodies.set(id, el)
      else {
        this.bodies.delete(id)
        this.bodyRefs.delete(id)
      }
    })
  }

  dashRef(id: string): Ref {
    return stableRef(this.dashRefs, id, (el) => {
      if (el) this.dashes.set(id, el)
      else {
        this.dashes.delete(id)
        this.dashRefs.delete(id)
        this.shown.delete(id)
        this.nowWeight.delete(id)
        this.painted.delete(id)
      }
    })
  }

  setScale(scale: number) {
    this.scale = scale
  }

  push(currents: ReadonlyMap<string, number>, phases: ReadonlyMap<string, number>, live: boolean, paused: boolean) {
    const now = performance.now()
    this.span = this.at ? Math.min(250, Math.max(16, now - this.at)) : 50
    this.at = now
    this.from = new Map(this.shown)
    this.to = phases
    this.targetWeight = new Map()
    for (const [id, i] of currents) this.targetWeight.set(id, weight(i))
    const wasLive = this.live
    this.live = live
    this.paused = paused
    if (!live) {
      this.reset()
      this.stop()
      return
    }
    if (!wasLive) this.nowWeight = new Map(this.targetWeight)
    this.start()
  }

  reset() {
    this.nowWeight.clear()
    this.targetWeight.clear()
    this.shown.clear()
    this.painted.clear()
    for (const [, el] of this.dashes) {
      el.style.opacity = "0"
      el.style.strokeWidth = ""
    }
    for (const [, el] of this.bodies) el.style.strokeWidth = ""
  }

  start() {
    if (this.raf) return
    this.frameAt = performance.now()
    const frame = (now: number) => {
      this.raf = 0
      if (this.tick(now)) this.raf = requestAnimationFrame(frame)
    }
    this.raf = requestAnimationFrame(frame)
  }

  stop() {
    if (!this.raf) return
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /** One frame; returns whether anything is still moving and the loop should go on. */
  private tick(now: number): boolean {
    const dt = now - this.frameAt
    this.frameAt = now
    const k = 1 - Math.exp(-dt / FLOW_TAU)
    const slide = Math.min(1, (now - this.at) / this.span)
    let moving = false

    for (const [id, dash] of this.dashes) {
      const target = this.targetWeight.get(id) ?? 0
      const prev = this.nowWeight.get(id) ?? 0
      const w = target === 0 ? 0 : Math.abs(target - prev) < SETTLED ? target : prev + (target - prev) * k
      if (w !== prev) {
        this.nowWeight.set(id, w)
        moving = true
      }
      this.paint(id, dash, this.bodies.get(id), w)
      if (w === 0 || this.paused) continue

      const to = this.to.get(id)
      if (to === undefined) continue
      const at = this.from.get(id) ?? to
      const pos = at + (to - at) * slide
      if (pos !== this.shown.get(id)) {
        this.shown.set(id, pos)
        dash.style.strokeDashoffset = String(-pos * this.scale)
        moving = true
      }
    }
    return moving
  }

  private paint(id: string, dash: SVGPathElement, body: SVGPathElement | undefined, w: number) {
    const base = Number(body?.dataset.base) || 2
    const next: Painted = w > 0 ? { opacity: String(0.8 + 0.2 * w), width: String(base * (1 + WEIGHT_GAIN * w)) } : { opacity: "0", width: "" }
    const last = this.painted.get(id)
    if (last && last.opacity === next.opacity && last.width === next.width) return
    this.painted.set(id, next)
    dash.style.opacity = next.opacity
    dash.style.strokeWidth = next.width
    if (body) body.style.strokeWidth = next.width
  }

  dispose() {
    this.stop()
    this.bodies.clear()
    this.dashes.clear()
    this.bodyRefs.clear()
    this.dashRefs.clear()
    this.painted.clear()
  }
}

function stableRef(cache: Map<string, Ref>, id: string, make: Ref): Ref {
  let ref = cache.get(id)
  if (!ref) {
    ref = make
    cache.set(id, ref)
  }
  return ref
}
