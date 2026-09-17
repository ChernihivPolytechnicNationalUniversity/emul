/**
 * What is worth drawing at the current zoom, decided by legibility rather than by a frame budget.
 *
 * Only what a reader could not resolve is dropped, and both thresholds are counted in cells
 * because that is what the things are drawn in: a pin label is 0.3 cells tall, a pin dot 0.4
 * across. Body shapes are never dropped — a component keeps its symbol at every zoom. An earlier
 * pass replaced small symbols with a plain rectangle; measured, it saved 5 % of the field's nodes,
 * which does not buy a schematic that stops looking like one.
 */
export type FieldDetail = {
  /** Any text — pin labels, designators, meter readouts — is large enough to read. */
  labels: boolean
  /** Pin dots and interactive parts are large enough to see and to aim at. */
  pins: boolean
  /**
   * Too small to aim at, but still worth a mark: the pin rows are most of what a chip symbol
   * looks like, and without them it empties into a rectangle. `PinLayer` draws them as one path
   * per kind per object, so a 148-pin chip costs three nodes.
   */
  pinMarks: boolean
  /**
   * Nothing on the field is individually interactive any more, so the whole static picture goes
   * on one canvas instead of into the DOM. Two conditions, and the second is why: below the
   * `pins` zoom there is no label to read, no dot to aim at and no part to click, so the canvas
   * gives up nothing that was still on offer — but crossing between the two ways of drawing
   * costs a frame, so it is only worth crossing when there is enough on screen for the canvas to
   * pay it back. A small schematic stays in the DOM at every zoom. FIELD.md §11.
   */
  canvas: boolean
}

const LABEL_CELLS = 0.3
const LEGIBLE_LABEL_PX = 3.5
const PIN_DOT_CELLS = 0.4
const VISIBLE_DOT_PX = 2
const MARK_CELLS = 0.32
const VISIBLE_MARK_PX = 0.5
/** Below this many objects on screen the DOM is comfortable and the switch is not worth a frame. */
const CANVAS_WORTH_IT = 600

export function fieldDetail(grid: number, scale: number, onScreen: number): FieldDetail {
  const cellPx = grid * scale
  return {
    labels: cellPx * LABEL_CELLS >= LEGIBLE_LABEL_PX,
    pins: cellPx * PIN_DOT_CELLS >= VISIBLE_DOT_PX,
    pinMarks: cellPx * MARK_CELLS >= VISIBLE_MARK_PX,
    canvas: cellPx * PIN_DOT_CELLS < VISIBLE_DOT_PX && onScreen >= CANVAS_WORTH_IT,
  }
}
