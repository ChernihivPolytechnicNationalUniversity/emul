import type { Point } from "@/schematic/geometry"
import type { HeldChannel, ProbePoint, Tips } from "./use-measure"

const LIVE_COLOR = "#ef4444"

/**
 * The probe tips on the field, drawn in world coordinates above everything else: a coloured
 * ring with a + for the live lead, a − for the common one, and a dashed span between them.
 * The probe being placed is red; channels held for the oscilloscope keep their own colour.
 */
export function MeasureLayer({ tips, held, grid, hairline }: { tips: Tips; held: HeldChannel[]; grid: number; hairline: number }) {
  if (!tips.a && held.length === 0) return null
  return (
    <svg data-slot="probe-tips" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      {held.map((c) => (
        <Pair key={c.id} a={c.tips.a} b={c.tips.b} color={c.color} grid={grid} hairline={hairline} />
      ))}
      {tips.a && <Pair a={tips.a} b={tips.b} color={LIVE_COLOR} grid={grid} hairline={hairline} />}
    </svg>
  )
}

function Pair({ a, b, color, grid, hairline }: { a: ProbePoint; b: ProbePoint | null; color: string; grid: number; hairline: number }) {
  return (
    <g>
      {b && (
        <line
          x1={a.at.x}
          y1={a.at.y}
          x2={b.at.x}
          y2={b.at.y}
          stroke={color}
          strokeOpacity={0.6}
          strokeWidth={Math.max(1, hairline)}
          strokeDasharray={`${grid * 0.25} ${grid * 0.25}`}
        />
      )}
      <Tip at={a.at} grid={grid} hairline={hairline} color={color} live />
      {b && <Tip at={b.at} grid={grid} hairline={hairline} color={color} />}
    </g>
  )
}

function Tip({ at, grid, hairline, color, live = false }: { at: Point; grid: number; hairline: number; color: string; live?: boolean }) {
  const r = grid * 0.34
  return (
    <g>
      <circle cx={at.x} cy={at.y} r={r} className="fill-background" stroke={color} strokeWidth={Math.max(1.5, hairline * 2.5)} />
      <path
        d={live ? `M${at.x - r * 0.45} ${at.y} H${at.x + r * 0.45} M${at.x} ${at.y - r * 0.45} V${at.y + r * 0.45}` : `M${at.x - r * 0.45} ${at.y} H${at.x + r * 0.45}`}
        stroke={color}
        strokeWidth={Math.max(1.5, hairline * 2)}
        strokeLinecap="round"
      />
    </g>
  )
}
