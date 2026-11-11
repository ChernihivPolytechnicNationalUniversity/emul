const CORNER = 0.3
const CASING_TRIM = 0.25

export const WIRE_PX = 2
export const SELECTED_WIRE_PX = 3
export const CASING_PX = 3
export const CROSSING_GAP_PX = 3

export const casingWidth = (wirePx: number) => wirePx + 2 * CROSSING_GAP_PX
export const WIRE_HIT_PX = 14

export const wireCornerRadius = (grid: number) => CORNER * grid
export const casingTrim = (grid: number) => CASING_TRIM * grid

const DOT_CELLS = 0.2
const DOT_MIN_PX = 1.5 * WIRE_PX
const DOT_MAX_PX = 2.5 * WIRE_PX

export const OPEN_END_CELLS = 0.14
const OPEN_END_CLEARANCE_PX = 4

export const openEndReach = (grid: number, scale: number) => Math.max(WIRE_HIT_PX / 2 / scale, OPEN_END_CELLS * grid + OPEN_END_CLEARANCE_PX / scale)

export const dotRadius = (grid: number, scale: number) => Math.min(Math.max(DOT_CELLS * grid * scale, DOT_MIN_PX), DOT_MAX_PX) / scale
