export const FIRST_FRAME_MS = 1000 / 60

export function easeFactor(elapsedMs: number, tauMs: number) {
  return elapsedMs > 0 ? 1 - Math.exp(-elapsedMs / tauMs) : 0
}

export function progress(elapsedMs: number, spanMs: number) {
  if (!(elapsedMs > 0) || !(spanMs > 0)) return 0
  return Math.min(1, elapsedMs / spanMs)
}

export function frameClock() {
  let last = Number.NaN
  return (now: number) => {
    const first = Number.isNaN(last)
    const elapsed = first ? FIRST_FRAME_MS : now - last
    last = first ? now : Math.max(last, now)
    return elapsed
  }
}
