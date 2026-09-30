import { DIR, type Direction, type Point } from "@/schematic/geometry"
import type { BodyShape, ComponentDef, Fill } from "@/schematic/types"

export const PIN_LABEL_CELLS = 0.3

export const MONO_ADVANCE_EM = 0.6
export const KNOCKOUT_OPACITY = 0.8

const LABEL_OFFSET_CELLS = 0.45
const KNOCKOUT_PAD_EM = 0.15
const KNOCKOUT_FADE_EM = 0.5
const KNOCKOUT_HALF_HEIGHT_EM = 0.62

export type LabelAnchor = "start" | "middle" | "end"

const ANCHOR: Record<Direction, LabelAnchor> = {
  left: "end",
  right: "start",
  top: "middle",
  bottom: "middle",
  "top-left": "end",
  "bottom-left": "end",
  "top-right": "start",
  "bottom-right": "start",
}

export type LabelGround = Exclude<Fill, "none" | "grip"> | "field"

export type Box = { x: number; y: number; w: number; h: number }

export type KnockoutAxis = "x" | "y"

export type LabelKnockout = { axis: KnockoutAxis; text: Box; solid: Box; rise: Box; fall: Box }

export function pinLabelOffset(labelAt: Direction) {
  const dir = DIR[labelAt]
  return { x: dir.x * LABEL_OFFSET_CELLS, y: dir.y * LABEL_OFFSET_CELLS, anchor: ANCHOR[labelAt] }
}

export function pinLabelKnockout(text: string, labelAt: Direction, boost: number, advanceEm = MONO_ADVANCE_EM): LabelKnockout {
  const size = PIN_LABEL_CELLS * boost
  const { x, y, anchor } = pinLabelOffset(labelAt)
  const width = text.length * advanceEm * size
  const start = anchor === "start" ? x : anchor === "end" ? x - width : x - width / 2
  const half = KNOCKOUT_HALF_HEIGHT_EM * size
  const pad = KNOCKOUT_PAD_EM * size
  const fade = KNOCKOUT_FADE_EM * size
  const textBox = { x: start, y: y - half, w: width, h: half * 2 }
  const solid = { x: start - pad, y: textBox.y, w: width + pad * 2, h: textBox.h }
  if (anchor !== "middle") {
    return {
      axis: "x",
      text: textBox,
      solid,
      rise: { x: solid.x - fade, y: solid.y, w: fade, h: solid.h },
      fall: { x: solid.x + solid.w, y: solid.y, w: fade, h: solid.h },
    }
  }
  return {
    axis: "y",
    text: textBox,
    solid,
    rise: { x: solid.x, y: solid.y - fade, w: solid.w, h: fade },
    fall: { x: solid.x, y: solid.y + solid.h, w: solid.w, h: fade },
  }
}

const paintedFill = (shape: BodyShape): LabelGround | null =>
  shape.type === "rect" && shape.fill && shape.fill !== "none" && shape.fill !== "grip" ? shape.fill : null

const covers = (shape: BodyShape, at: Point) =>
  shape.type === "rect" && paintedFill(shape) !== null && at.x >= shape.x && at.x <= shape.x + shape.w && at.y >= shape.y && at.y <= shape.y + shape.h

const grounds = new WeakMap<ComponentDef, ReadonlyMap<string, LabelGround>>()

export function pinLabelGround(def: ComponentDef, pinId: string): LabelGround {
  let byPin = grounds.get(def)
  if (!byPin) {
    const map = new Map<string, LabelGround>()
    for (const pin of def.pins) {
      if (!pin.label) continue
      const { text } = pinLabelKnockout(pin.label, pin.labelAt, 1)
      const middle = { x: pin.x + text.x + text.w / 2, y: pin.y + text.y + text.h / 2 }
      const under = def.body.findLast((shape) => covers(shape, middle))
      map.set(pin.id, (under && paintedFill(under)) ?? "field")
    }
    byPin = map
    grounds.set(def, map)
  }
  return byPin.get(pinId) ?? "field"
}
