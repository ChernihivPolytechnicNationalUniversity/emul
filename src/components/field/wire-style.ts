const CORNER = 0.3
const CASING_TRIM = 0.25

export const WIRE_PX = 2
export const SELECTED_WIRE_PX = 3
export const CASING_PX = 3

export const wireCornerRadius = (grid: number) => CORNER * grid
export const casingTrim = (grid: number) => CASING_TRIM * grid
