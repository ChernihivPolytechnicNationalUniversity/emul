/** Corner rounding of a wire bend, in grid cells. */
const CORNER = 0.3

export const wireCornerRadius = (grid: number) => CORNER * grid
