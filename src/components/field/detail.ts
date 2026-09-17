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
}

const LABEL_CELLS = 0.3
const LEGIBLE_LABEL_PX = 3.5
const PIN_DOT_CELLS = 0.4
const VISIBLE_DOT_PX = 2
const MARK_CELLS = 0.32
const VISIBLE_MARK_PX = 0.5

export function fieldDetail(grid: number, scale: number): FieldDetail {
  const cellPx = grid * scale
  return {
    labels: cellPx * LABEL_CELLS >= LEGIBLE_LABEL_PX,
    pins: cellPx * PIN_DOT_CELLS >= VISIBLE_DOT_PX,
    pinMarks: cellPx * MARK_CELLS >= VISIBLE_MARK_PX,
  }
}
