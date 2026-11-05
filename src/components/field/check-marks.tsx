import type { Finding } from "@/schematic/checker"
import { checkKeyOf, isWarning } from "@/components/explorer/problems"

const MARK_CELLS = 0.4

export function CheckMarks({ findings, active, grid }: { findings: readonly Finding[]; active: string | null; grid: number }) {
  if (!findings.length) return null
  return (
    <svg data-slot="check-marks" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      {findings.map((f) => {
        const key = checkKeyOf(f)
        return (
          <circle
            key={key}
            data-finding={f.kind}
            data-at={`${f.at.x},${f.at.y}`}
            cx={f.at.x}
            cy={f.at.y}
            r={MARK_CELLS * grid}
            fill="none"
            stroke={isWarning(f) ? "var(--warning)" : "var(--muted-foreground)"}
            strokeWidth={key === active ? 3 : 1.5}
            strokeDasharray={isWarning(f) ? undefined : "3 2"}
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
    </svg>
  )
}
