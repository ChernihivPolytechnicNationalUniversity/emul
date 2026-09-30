import { MAX_PIN_LABEL_CELLS, PIN_LABEL_CELLS } from "./pin-label"
import { DEFAULT_TEXT_SCALE } from "./text-scale"

export type FieldDetail = {
  labels: boolean
  pins: boolean
  pinMarks: boolean
  canvas: boolean
  textScale: number
  textBoost: number
  pinLabelSize: number
}

const LEGIBLE_LABEL_PX = 3.5
const READABLE_LABEL_PX = 7
const MAX_TEXT_BOOST = 2
const PIN_DOT_CELLS = 0.4
const VISIBLE_DOT_PX = 2
const MARK_CELLS = 0.32
const VISIBLE_MARK_PX = 0.5
const CANVAS_WORTH_IT = 600

export function fieldDetail(grid: number, scale: number, onScreen: number, textScale = DEFAULT_TEXT_SCALE): FieldDetail {
  const cellPx = grid * scale
  const chosenPx = cellPx * PIN_LABEL_CELLS * textScale
  const zoomBoost = Math.min(Math.max(1, MAX_TEXT_BOOST / textScale), Math.max(1, READABLE_LABEL_PX / chosenPx))
  const textBoost = textScale * zoomBoost
  return {
    textScale,
    textBoost,
    pinLabelSize: Math.min(MAX_PIN_LABEL_CELLS, PIN_LABEL_CELLS * textBoost),
    labels: chosenPx * zoomBoost >= LEGIBLE_LABEL_PX,
    pins: cellPx * PIN_DOT_CELLS >= VISIBLE_DOT_PX,
    pinMarks: cellPx * MARK_CELLS >= VISIBLE_MARK_PX,
    canvas: cellPx * PIN_DOT_CELLS < VISIBLE_DOT_PX && onScreen >= CANVAS_WORTH_IT,
  }
}
