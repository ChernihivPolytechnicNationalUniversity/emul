/** Screen widths on offer, in seconds. */
export const TIMEBASES = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5] as const
/** Samples across one screen; the worker's bucket is the timebase divided by this. */
export const SCOPE_COLUMNS = 500
