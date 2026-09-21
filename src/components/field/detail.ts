export type FieldDetail = {
  labels: boolean
  pins: boolean
  pinMarks: boolean
  canvas: boolean
  textBoost: number
}

const LABEL_CELLS = 0.3
const LEGIBLE_LABEL_PX = 3.5
const READABLE_LABEL_PX = 7
const MAX_TEXT_BOOST = 2
const PIN_DOT_CELLS = 0.4
const VISIBLE_DOT_PX = 2
const MARK_CELLS = 0.32
const VISIBLE_MARK_PX = 0.5
const CANVAS_WORTH_IT = 600

export function fieldDetail(grid: number, scale: number, onScreen: number): FieldDetail {
  const cellPx = grid * scale
  const textBoost = Math.min(MAX_TEXT_BOOST, Math.max(1, READABLE_LABEL_PX / (cellPx * LABEL_CELLS)))
  return {
    textBoost,
    labels: cellPx * LABEL_CELLS * textBoost >= LEGIBLE_LABEL_PX,
    pins: cellPx * PIN_DOT_CELLS >= VISIBLE_DOT_PX,
    pinMarks: cellPx * MARK_CELLS >= VISIBLE_MARK_PX,
    canvas: cellPx * PIN_DOT_CELLS < VISIBLE_DOT_PX && onScreen >= CANVAS_WORTH_IT,
  }
}
