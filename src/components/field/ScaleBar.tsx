import { cn } from "@/lib/utils"

type ScaleBarProps = React.ComponentProps<"div"> & {
  /** Screen px per world px. */
  scale: number
  /** World px per grid cell. */
  grid: number
  /** Millimetres per grid cell. */
  mmPerCell?: number
  /** Target bar length on screen, px. */
  targetPx?: number
}

const NICE = [1, 2, 5]

/** Google-Maps-style scale bar: a bar whose length is a round number of millimetres. */
export function ScaleBar({ scale, grid, mmPerCell = 2.54, targetPx = 120, className, ...props }: ScaleBarProps) {
  const pxPerMm = (scale * grid) / mmPerCell
  // Largest "nice" length (1, 2, 5 × 10^n mm) that fits within targetPx.
  const maxMm = targetPx / pxPerMm
  const exp = Math.floor(Math.log10(maxMm))
  let mm = 10 ** exp
  for (const n of NICE) if (n * 10 ** exp <= maxMm) mm = n * 10 ** exp
  const px = mm * pxPerMm
  const label = mm >= 1000 ? `${mm / 1000} m` : mm >= 10 ? `${mm / 10} cm` : `${mm} mm`

  return (
    <div
      data-slot="scale-bar"
      className={cn("pointer-events-none flex flex-col items-start gap-0.5 text-[11px] tabular-nums text-muted-foreground select-none", className)}
      {...props}
    >
      <span className="leading-none">{label}</span>
      <div
        className="h-1.5 border-x border-b border-foreground/70"
        style={{ width: px }}
      />
    </div>
  )
}
