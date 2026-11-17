const CORNER = 0.3
const CASING_TRIM = 0.25

export const WIRE_PX = 2
export const SELECTED_WIRE_PX = 3
export const CASING_PX = 3
export const CROSSING_GAP_PX = 3

export const casingWidth = (wirePx: number) => wirePx + 2 * CROSSING_GAP_PX
export const CONFLICT_PX = casingWidth(WIRE_PX)
const CONFLICT_BLUR_PX = 3
const CONFLICT_REACH_PX = CONFLICT_PX / 2 + 3 * CONFLICT_BLUR_PX
export const glowCutWidth = (px: number) => 2 * (CONFLICT_REACH_PX * px + (casingWidth(WIRE_PX) / 2) * Math.max(1, px))
export const WIRE_HIT_PX = 20

export const wireCornerRadius = (grid: number) => CORNER * grid
export const casingTrim = (grid: number) => CASING_TRIM * grid

const DOT_CELLS = 0.2
const DOT_PER_WIRE = 1.5

export const OPEN_END_CELLS = 0.14
const OPEN_END_CLEARANCE_PX = 4

const OPEN_END_REACH_PX = 7

export const openEndReach = (grid: number, scale: number) => Math.max(OPEN_END_REACH_PX / scale, OPEN_END_CELLS * grid + OPEN_END_CLEARANCE_PX / scale)

export const dotRadius = (grid: number, wireWidth: number) => Math.max(DOT_CELLS * grid, DOT_PER_WIRE * wireWidth)
