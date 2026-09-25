import type { Peer } from "@/collab/use-live"
import { AnimalIcon } from "./Avatar"

export function LiveCursors({ peers }: { peers: readonly Peer[] }) {
  return (
    <>
      {peers.map((p) =>
        p.wire && p.wire.length > 1 ? (
          <svg key={`w${p.clientId}`} className="pointer-events-none absolute top-0 left-0 z-20 overflow-visible" width={1} height={1}>
            <polyline
              points={p.wire.map((q) => `${q.x},${q.y}`).join(" ")}
              fill="none"
              stroke={p.color}
              strokeWidth={2}
              strokeDasharray="6 5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : null,
      )}
      {peers.map((p) =>
        p.cursor ? (
          <div
            key={p.clientId}
            className="pointer-events-none absolute top-0 left-0 z-30 origin-top-left transition-transform duration-75 ease-linear"
            style={{ transform: `translate(${p.cursor.x}px, ${p.cursor.y}px) scale(calc(1 / var(--field-scale, 1)))` }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" className="drop-shadow-sm">
              <path d="M2 2 L16 8 L9 10 L7 16 Z" fill={p.color} stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span
              className="absolute top-4 left-3 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-white shadow-sm"
              style={{ backgroundColor: p.color }}
            >
              <AnimalIcon animal={p.animal} className="size-3" />
              {p.name}
            </span>
          </div>
        ) : null,
      )}
    </>
  )
}
