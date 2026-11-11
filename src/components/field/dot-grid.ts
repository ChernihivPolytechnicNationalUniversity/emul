const MIN_DOT_PX = 16

const dotLayer = (radius: number, alpha: number) =>
  `radial-gradient(color-mix(in oklch, var(--muted-foreground) ${Math.round(35 * alpha)}%, transparent) ${radius}px, transparent ${radius}px)`

export type DotGrid = { backgroundImage: string; backgroundSize: string; steps: readonly number[] }

const NO_DOTS: DotGrid = { backgroundImage: "none", backgroundSize: "auto", steps: [] }

export function dotGridStyle(grid: number, scale: number): DotGrid {
  const cellPx = grid * scale
  if (!(cellPx > 0 && cellPx < Infinity)) return NO_DOTS
  let level = 1
  while (cellPx * level < MIN_DOT_PX) level *= 2
  const step = cellPx * level
  const fine = level > 1 ? step / 2 : 0
  const fineAlpha = fine ? Math.max(0, Math.min(1, (fine - MIN_DOT_PX / 2) / (MIN_DOT_PX / 2))) : 0
  const radius = Math.max(1, Math.min(2, step / 24))
  const layered = fine > 0 && fineAlpha > 0
  return {
    backgroundImage: layered ? `${dotLayer(radius, 1)}, ${dotLayer(radius, fineAlpha)}` : dotLayer(radius, 1),
    backgroundSize: layered ? `${step}px ${step}px, ${fine}px ${fine}px` : `${step}px ${step}px`,
    steps: layered ? [step, fine] : [step],
  }
}

export const dotGridPosition = (dots: DotGrid, x: number, y: number): string =>
  dots.steps.length ? dots.steps.map((step) => `${x - step / 2}px ${y - step / 2}px`).join(", ") : `${x}px ${y}px`
