import { printedBox } from "./printed-text"
import type { BodyShape, Fill } from "./types"

export type Mm = { x: number; y: number }

export type MmBox = { x0: number; y0: number; x1: number; y1: number }

export type BoardFrame = { originX: number; originY: number; cellsPerMm: number }

export type Paint = Exclude<Fill, "grip"> | "mark"

export type TextStyle = { size: number; anchor?: "start" | "middle" | "end"; rotate?: number; mono?: boolean; muted?: boolean; inverse?: boolean; growsFrom?: Mm }

type Text = Extract<BodyShape, { type: "text" }>

const fixed = (v: number) => Math.round(v * 100) / 100

const ORDER: readonly Paint[] = ["board", "zone", "none", "connector", "chip", "foreground", "mark"]

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const TEXT_INSET_CELLS = 0.05

type Shared = { paths: Map<Paint, string[]>; texts: Text[] }

let groups = 0

export class Artwork {
  private readonly shared: Shared
  private readonly frame: BoardFrame
  private readonly dx: number
  private readonly dy: number
  private readonly group: number | undefined
  private readonly clip: MmBox | undefined

  constructor(frame: BoardFrame, offset: Mm = { x: 0, y: 0 }, shared?: Shared, group?: number, clip?: MmBox) {
    this.frame = frame
    this.dx = offset.x
    this.dy = offset.y
    this.shared = shared ?? { paths: new Map(), texts: [] }
    this.group = group
    this.clip = clip
  }

  private nextGroup() {
    return ++groups
  }

  moved(by: Mm): Artwork {
    return new Artwork(this.frame, { x: this.dx + by.x, y: this.dy + by.y }, this.shared, this.nextGroup(), this.clip)
  }

  grouped(): Artwork {
    return this.moved({ x: 0, y: 0 })
  }

  within(box: MmBox): Artwork {
    return new Artwork(this.frame, { x: this.dx, y: this.dy }, this.shared, this.group, box)
  }

  cellX(mm: number) {
    return fixed((mm + this.dx + this.frame.originX) * this.frame.cellsPerMm)
  }

  cellY(mm: number) {
    return fixed((mm + this.dy + this.frame.originY) * this.frame.cellsPerMm)
  }

  cells(mm: number) {
    return fixed(mm * this.frame.cellsPerMm)
  }

  private add(paint: Paint, d: string) {
    const parts = this.shared.paths.get(paint) ?? []
    parts.push(d)
    this.shared.paths.set(paint, parts)
    return this
  }

  private clipped(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    if (!this.clip) return [x0, y0, x1, y1]
    const { x0: left, y0: top, x1: right, y1: bottom } = this.clip
    const x = (v: number) => clamp(v + this.dx, left, right) - this.dx
    const y = (v: number) => clamp(v + this.dy, top, bottom) - this.dy
    return [x(x0), y(y0), x(x1), y(y1)]
  }

  private roundedRect(x0: number, y0: number, x1: number, y1: number, radius: number) {
    const x = this.cellX(Math.min(x0, x1))
    const y = this.cellY(Math.min(y0, y1))
    const w = this.cells(Math.abs(x1 - x0))
    const h = this.cells(Math.abs(y1 - y0))
    const r = Math.min(this.cells(radius), w / 2, h / 2)
    if (r <= 0) return `M${x} ${y}h${w}v${h}h${fixed(-w)}Z`
    return `M${fixed(x + r)} ${y}H${fixed(x + w - r)}A${r} ${r} 0 0 1 ${fixed(x + w)} ${fixed(y + r)}V${fixed(y + h - r)}A${r} ${r} 0 0 1 ${fixed(x + w - r)} ${fixed(y + h)}H${fixed(x + r)}A${r} ${r} 0 0 1 ${x} ${fixed(y + h - r)}V${fixed(y + r)}A${r} ${r} 0 0 1 ${fixed(x + r)} ${y}Z`
  }

  private circlePath(cx: number, cy: number, radius: number) {
    const x = this.cellX(cx)
    const y = this.cellY(cy)
    const r = this.cells(radius)
    return `M${fixed(x - r)} ${y}A${r} ${r} 0 1 0 ${fixed(x + r)} ${y}A${r} ${r} 0 1 0 ${fixed(x - r)} ${y}Z`
  }

  private polyPath(points: readonly Mm[], closed: boolean) {
    return points.map((p, i) => `${i ? "L" : "M"}${this.cellX(p.x)} ${this.cellY(p.y)}`).join("") + (closed ? "Z" : "")
  }

  private roundedPolyPath(points: readonly Mm[], radius: number) {
    const cell = points.map((p) => ({ x: this.cellX(p.x), y: this.cellY(p.y) }))
    const r = this.cells(radius)
    const corners = cell.map((at, i) => {
      const before = cell[(i + cell.length - 1) % cell.length]
      const after = cell[(i + 1) % cell.length]
      const back = { x: before.x - at.x, y: before.y - at.y }
      const ahead = { x: after.x - at.x, y: after.y - at.y }
      const backLength = Math.hypot(back.x, back.y)
      const aheadLength = Math.hypot(ahead.x, ahead.y)
      const turn = (at.x - before.x) * ahead.y - (at.y - before.y) * ahead.x
      const opening = Math.acos(clamp((back.x * ahead.x + back.y * ahead.y) / (backLength * aheadLength), -1, 1))
      const reach = Math.min(r / Math.tan(opening / 2), backLength / 2, aheadLength / 2)
      const bend = reach * Math.tan(opening / 2)
      return {
        from: { x: fixed(at.x + (back.x / backLength) * reach), y: fixed(at.y + (back.y / backLength) * reach) },
        to: { x: fixed(at.x + (ahead.x / aheadLength) * reach), y: fixed(at.y + (ahead.y / aheadLength) * reach) },
        radius: fixed(bend),
        sweep: turn > 0 ? 1 : 0,
      }
    })
    return corners.map((c, i) => `${i ? "L" : "M"}${c.from.x} ${c.from.y}A${c.radius} ${c.radius} 0 0 ${c.sweep} ${c.to.x} ${c.to.y}`).join("") + "Z"
  }

  rect(paint: Paint, x0: number, y0: number, x1: number, y1: number, radius = 0) {
    return this.add(paint, this.roundedRect(...this.clipped(x0, y0, x1, y1), radius))
  }

  circle(paint: Paint, cx: number, cy: number, radius: number) {
    return this.add(paint, this.circlePath(cx, cy, radius))
  }

  polygon(paint: Paint, points: readonly Mm[], radius = 0) {
    return this.add(paint, radius > 0 ? this.roundedPolyPath(points, radius) : this.polyPath(points, true))
  }

  outline(x0: number, y0: number, x1: number, y1: number, radius = 0) {
    return this.add("none", this.roundedRect(...this.clipped(x0, y0, x1, y1), radius))
  }

  line(points: readonly Mm[]) {
    return this.add("none", this.polyPath(points, false))
  }

  private inside(shape: Text): Text {
    if (!this.clip) return shape
    const box = printedBox(shape)
    const left = this.cellX(this.clip.x0 - this.dx) + TEXT_INSET_CELLS
    const top = this.cellY(this.clip.y0 - this.dy) + TEXT_INSET_CELLS
    const right = this.cellX(this.clip.x1 - this.dx) - TEXT_INSET_CELLS
    const bottom = this.cellY(this.clip.y1 - this.dy) - TEXT_INSET_CELLS
    const dx = Math.max(0, left - box.x) - Math.max(0, box.x + box.w - right)
    const dy = Math.max(0, top - box.y) - Math.max(0, box.y + box.h - bottom)
    return dx || dy ? { ...shape, x: fixed(shape.x + dx), y: fixed(shape.y + dy) } : shape
  }

  text(text: string, x: number, y: number, { size, anchor, rotate, mono, muted, inverse, growsFrom }: TextStyle) {
    this.shared.texts.push(this.inside({
      type: "text",
      x: this.cellX(x),
      y: this.cellY(y),
      text,
      size,
      printed: true,
      ...(anchor && anchor !== "middle" ? { anchor } : {}),
      ...(rotate ? { rotate } : {}),
      ...(mono ? { mono } : {}),
      ...(muted ? { muted } : {}),
      ...(inverse ? { inverse } : {}),
      ...(this.group !== undefined ? { group: this.group } : {}),
      ...(growsFrom ? { growsFrom: { x: this.cellX(growsFrom.x), y: this.cellY(growsFrom.y) } } : {}),
    }))
    return this
  }

  shapes(): BodyShape[] {
    const art: BodyShape[] = []
    for (const paint of ORDER) {
      const d = this.shared.paths.get(paint)
      if (!d?.length) continue
      art.push(paint === "mark" ? { type: "art", d: d.join(""), muted: true } : { type: "art", d: d.join(""), fill: paint })
    }
    return [...art, ...this.shared.texts]
  }
}
