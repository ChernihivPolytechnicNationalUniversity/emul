import * as React from "react"
import { PinIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatSI } from "@/sim/units"
import type { TraceStore } from "./trace-store"

/** Screen widths on offer, in seconds. */
export const TIMEBASES = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5] as const
/** Samples across one screen; the worker's bucket is the timebase divided by this. */
export const SCOPE_COLUMNS = 500
const DIVISIONS = 10
/** How many screens of history set the vertical scale. */
const SCALE_SCREENS = 4
/**
 * Phosphor persistence, in steps behind the beam. Brightness falls as (1 − age)^POWER: the
 * trace is at full strength right behind the spot, a fifth of it half a screen back and gone
 * before the beam comes round again, as on a real tube at this sweep.
 */
const PERSISTENCE_RUNS = 16
const PERSISTENCE_POWER = 2.5

export type ScopeChannel = {
  id: string
  /** What the channel is across, e.g. "R1.2 → ground". */
  label: string
  color: string
  /** Latest instantaneous reading, if the probe is on a live net. */
  value?: number
  /** The probe being placed rather than a held channel. */
  live?: boolean
}

/** Sweep the beam freely, hold it on a rising edge of channel 1, or plot channel 1 against 2. */
export type ScopeMode = "sweep" | "trigger" | "xy"

type ScopeProps = React.ComponentProps<"div"> & {
  store: TraceStore
  /** Bumped with the store, so the canvas redraws. */
  version: number
  channels: ScopeChannel[]
  window: number
  onWindowChange: (seconds: number) => void
  mode: ScopeMode
  onModeChange: (mode: ScopeMode) => void
  canHold: boolean
  onHold: () => void
  onRelease: (id: string) => void
  onClose: () => void
}

const MODES: { value: ScopeMode; label: string; hint: string }[] = [
  { value: "sweep", label: "Sweep", hint: "Free-running: the beam sweeps and redraws as time passes" },
  { value: "trigger", label: "Trig", hint: "Hold the screen on a rising edge of the first channel" },
  { value: "xy", label: "XY", hint: "Plot channel 1 on X against channel 2 on Y, with the last screen's worth of trail" },
]

/**
 * XY mode: the beam goes where the two channels point it, so two sines make a Lissajous
 * figure, a phase shift an ellipse. The trail is the last screen's worth of buckets, fading
 * towards the older end, so the figure is seen being traced rather than just standing.
 */
function drawXY(ctx: CanvasRenderingContext2D, w: number, h: number, fg: string, store: TraceStore, ids: ScopeChannel[], n: number, len: number) {
  const side = Math.min(w, h)
  const cx = w / 2
  const cy = h / 2
  ctx.save()
  ctx.strokeStyle = fg
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.12
  ctx.beginPath()
  for (let i = -4; i <= 4; i++) {
    const d = (i / 8) * side
    ctx.moveTo(Math.round(cx + d) + 0.5, cy - side / 2)
    ctx.lineTo(Math.round(cx + d) + 0.5, cy + side / 2)
    ctx.moveTo(cx - side / 2, Math.round(cy + d) + 0.5)
    ctx.lineTo(cx + side / 2, Math.round(cy + d) + 0.5)
  }
  ctx.stroke()
  ctx.globalAlpha = 0.35
  ctx.beginPath()
  ctx.moveTo(Math.round(cx) + 0.5, cy - side / 2)
  ctx.lineTo(Math.round(cx) + 0.5, cy + side / 2)
  ctx.moveTo(cx - side / 2, Math.round(cy) + 0.5)
  ctx.lineTo(cx + side / 2, Math.round(cy) + 0.5)
  ctx.stroke()
  ctx.restore()
  if (ids.length < 2) return
  const [xc, yc] = ids

  // Each axis is scaled to its own largest swing over the trail, so a 5 V against a 100 mV still fills the box.
  const start = Math.max(0, len - n)
  let ax = 0
  let ay = 0
  for (let i = start; i < len; i++) {
    const sx = store.at(xc.id, i)
    const sy = store.at(yc.id, i)
    if (sx) ax = Math.max(ax, Math.abs(sx[0]), Math.abs(sx[1]))
    if (sy) ay = Math.max(ay, Math.abs(sy[0]), Math.abs(sy[1]))
  }
  const kx = ax > 1e-9 ? (side * 0.45) / niceStep(ax) : 0
  const ky = ay > 1e-9 ? (side * 0.45) / niceStep(ay) : 0

  // The trail in runs of rising opacity, oldest first; the newest run is solid.
  const RUNS = PERSISTENCE_RUNS
  const per = Math.max(1, Math.ceil((len - start) / RUNS))
  ctx.save()
  ctx.lineWidth = 1.6
  ctx.lineJoin = "round"
  ctx.lineCap = "round"
  ctx.strokeStyle = yc.color
  ctx.shadowBlur = 6
  ctx.shadowColor = yc.color
  for (let r = 0; r < RUNS; r++) {
    const from = start + r * per
    const to = Math.min(len, from + per + 1)
    if (from >= len) break
    ctx.globalAlpha = ((r + 1) / RUNS) ** PERSISTENCE_POWER
    ctx.beginPath()
    let open = false
    for (let i = from; i < to; i++) {
      const sx = store.at(xc.id, i)
      const sy = store.at(yc.id, i)
      if (!sx || !sy) {
        open = false
        continue
      }
      const x = cx + ((sx[0] + sx[1]) / 2) * kx
      const y = cy - ((sy[0] + sy[1]) / 2) * ky
      if (open) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
      open = true
    }
    ctx.stroke()
  }
  // The beam itself.
  const sx = store.at(xc.id, len - 1)
  const sy = store.at(yc.id, len - 1)
  if (sx && sy) {
    ctx.globalAlpha = 1
    ctx.fillStyle = yc.color
    ctx.shadowBlur = 10
    ctx.beginPath()
    ctx.arc(cx + ((sx[0] + sx[1]) / 2) * kx, cy - ((sy[0] + sy[1]) / 2) * ky, 2.4, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
  // Axis legend in the corners.
  ctx.save()
  ctx.font = "10px ui-monospace, monospace"
  ctx.globalAlpha = 0.7
  ctx.fillStyle = xc.color
  ctx.textAlign = "right"
  ctx.fillText(`X ${xc.label}  ${formatSI(niceStep(ax || 1), "V", 0)}/div`, cx + side / 2 - 4, cy + side / 2 - 4)
  ctx.fillStyle = yc.color
  ctx.textAlign = "left"
  ctx.fillText(`Y ${yc.label}  ${formatSI(niceStep(ay || 1), "V", 0)}/div`, cx - side / 2 + 4, cy - side / 2 + 12)
  ctx.restore()
}

/** The nearest 1-2-5 step at or above `raw`. */
function niceStep(raw: number) {
  if (!(raw > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

/**
 * How the trace is lit. The beam is what the sweep looks like on an analogue scope: a bright
 * spot with the trace fading behind it, drawn at 60 fps with the spot advancing steadily
 * between the worker's batches rather than jumping when they land.
 */
type Beam = {
  /** Newest bucket index (absolute, since the store's epoch) the display has revealed. */
  revealed: number
  /** Buckets per real millisecond, estimated from the batches as they arrive. */
  rate: number
  lastNewest: number
  lastAt: number
  frameAt: number
}

/** Path through the middle of each bucket over [from, to], skipping columns without data. */
function tracePath(store: TraceStore, id: string, bucketAt: (col: number) => number, from: number, to: number, px: number, y: (v: number) => number) {
  const path = new Path2D()
  let open = false
  for (let col = from; col <= to; col++) {
    const i = bucketAt(col)
    const s = i < 0 ? null : store.at(id, i)
    if (!s) {
      open = false
      continue
    }
    const x = col * px
    const yy = y((s[0] + s[1]) / 2)
    if (open) path.lineTo(x, yy)
    else path.moveTo(x, yy)
    open = true
  }
  return path
}

/** Band between trough and peak over [from, to]; visible where a bucket spans more than a hairline. */
function bandPath(store: TraceStore, id: string, bucketAt: (col: number) => number, from: number, to: number, px: number, y: (v: number) => number) {
  const path = new Path2D()
  let open = false
  for (let col = from; col <= to; col++) {
    const i = bucketAt(col)
    const s = i < 0 ? null : store.at(id, i)
    if (!s) {
      open = false
      continue
    }
    if (open) path.lineTo(col * px, y(s[1]))
    else path.moveTo(col * px, y(s[1]))
    open = true
  }
  for (let col = to; col >= from; col--) {
    const i = bucketAt(col)
    const s = i < 0 ? null : store.at(id, i)
    if (s) path.lineTo(col * px, y(s[0]))
  }
  path.closePath()
  return path
}

/**
 * An oscilloscope over the probes on the field. Each column is a bucket of solver steps drawn
 * as a bar from trough to peak, so a spike one step wide still shows. Vertical scale follows
 * the signal. Free-running, the beam sweeps across and redraws the trace as time passes;
 * triggered, the screen holds the last rising edge of the first channel at its left edge.
 */
export function Scope({
  store,
  version,
  channels,
  window: win,
  onWindowChange,
  mode,
  onModeChange,
  canHold,
  onHold,
  onRelease,
  onClose,
  className,
  ...props
}: ScopeProps) {
  const canvas = React.useRef<HTMLCanvasElement>(null)
  // The frame loop reads the latest props through a ref; re-rendering must not restart it.
  const latest = React.useRef({ channels, win, mode })
  React.useEffect(() => {
    latest.current = { channels, win, mode }
  }, [channels, win, mode])
  const beam = React.useRef<Beam>({ revealed: -1, rate: 0, lastNewest: -1, lastAt: 0, frameAt: 0 })

  // Each batch from the worker updates the beam's speed estimate; the frame loop does the rest.
  React.useEffect(() => {
    const b = beam.current
    const now = performance.now()
    const newest = store.bucket > 0 ? Math.round(store.end / store.bucket) - 1 : -1
    if (newest < 0) return
    if (b.lastNewest >= 0 && newest > b.lastNewest && now > b.lastAt) {
      const rate = (newest - b.lastNewest) / (now - b.lastAt)
      b.rate = b.rate > 0 ? b.rate + (rate - b.rate) * 0.3 : rate
    }
    // A fresh store, or a jump the beam cannot catch up with, snaps it to the data.
    if (b.revealed < 0 || newest < b.revealed || newest - b.revealed > 2 * SCOPE_COLUMNS) b.revealed = newest
    b.lastNewest = newest
    b.lastAt = now
  }, [store, version])

  React.useEffect(() => {
    let raf = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const el = canvas.current
      if (!el) return
      const ctx = el.getContext("2d")
      if (!ctx) return
      const { channels, win, mode } = latest.current
      const b = beam.current
      const dt = b.frameAt ? now - b.frameAt : 0
      b.frameAt = now
      // Reveal at the estimated rate, never past what has actually arrived.
      if (b.lastNewest >= 0) b.revealed = Math.min(b.lastNewest, b.revealed + b.rate * dt)

      const dpr = window.devicePixelRatio || 1
      const w = el.clientWidth
      const h = el.clientHeight
      if (el.width !== w * dpr || el.height !== h * dpr) {
        el.width = w * dpr
        el.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const fg = getComputedStyle(el).color

      const n = store.bucket > 0 ? Math.max(2, Math.round(win / store.bucket)) : SCOPE_COLUMNS
      const len = store.length
      const ids = channels.filter((c) => store.has(c.id))
      // Buckets newer than the beam's reveal point stay hidden until it gets there.
      const hidden = b.lastNewest >= 0 ? b.lastNewest - Math.floor(b.revealed) : 0
      const shown = Math.max(0, len - hidden)

      if (mode === "xy") {
        drawXY(ctx, w, h, fg, store, ids, n, shown)
        return
      }

      // Where the screen starts, in buckets from the oldest kept. Untriggered, the beam
      // sweeps: each bucket has a fixed column by its time, so the newest one overwrites the
      // oldest. `sweep` maps screen column to bucket index; the newest column is the beam.
      let start = Math.max(0, shown - n)
      let sweep: Int32Array | null = null
      let beamCol = -1
      if (mode === "sweep" && store.bucket > 0 && shown > 0) {
        sweep = new Int32Array(n).fill(-1)
        const newest = Math.floor(b.revealed)
        for (let i = Math.max(0, shown - n); i < shown; i++) {
          const col = (((newest - (shown - 1 - i)) % n) + n) % n
          sweep[col] = i
        }
        beamCol = ((newest % n) + n) % n
      } else if (mode === "trigger" && ids.length && len >= n) {
        const first = ids[0].id
        const from = Math.max(1, len - 2 * n)
        let lo = Infinity
        let hi = -Infinity
        for (let i = from; i < len; i++) {
          const s = store.at(first, i)
          if (!s) continue
          if (s[0] < lo) lo = s[0]
          if (s[1] > hi) hi = s[1]
        }
        const level = (lo + hi) / 2
        start = Math.max(0, len - n)
        if (hi - lo > 1e-9) {
          for (let i = len - n; i > from; i--) {
            const a = store.at(first, i - 1)
            const c = store.at(first, i)
            if (a && c && (a[0] + a[1]) / 2 < level && (c[0] + c[1]) / 2 >= level) {
              start = i
              break
            }
          }
        }
      }
      /** The bucket shown in screen column `col`, or -1. */
      const bucketAt = (col: number) => (sweep ? sweep[col] : start + col < (mode === "trigger" ? len : shown) ? start + col : -1)

      // Vertical range over the last few screens rather than just this one, so the scale does
      // not jump while a sweep is half way through a cycle. On a 1-2-5 grid.
      let vmin = Infinity
      let vmax = -Infinity
      for (const c of ids) {
        for (let i = Math.max(0, len - SCALE_SCREENS * n); i < len; i++) {
          const s = store.at(c.id, i)
          if (!s) continue
          if (s[0] < vmin) vmin = s[0]
          if (s[1] > vmax) vmax = s[1]
        }
      }
      if (!(vmin <= vmax)) {
        vmin = -1
        vmax = 1
      }
      if (vmax - vmin < 1e-6) {
        vmin -= 0.5
        vmax += 0.5
      }
      const vdiv = niceStep((vmax - vmin) / 4)
      let lo = Math.floor(vmin / vdiv) * vdiv
      let hi = Math.ceil(vmax / vdiv) * vdiv
      if (lo === vmin) lo -= vdiv
      if (hi === vmax) hi += vdiv
      const y = (v: number) => h - ((v - lo) / (hi - lo)) * h

      // Graticule.
      ctx.save()
      ctx.strokeStyle = fg
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.12
      ctx.beginPath()
      for (let i = 1; i < DIVISIONS; i++) {
        const x = Math.round((i / DIVISIONS) * w) + 0.5
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
      }
      for (let v = lo + vdiv; v < hi - vdiv / 2; v += vdiv) {
        const yy = Math.round(y(v)) + 0.5
        ctx.moveTo(0, yy)
        ctx.lineTo(w, yy)
      }
      ctx.stroke()
      if (lo < 0 && hi > 0) {
        ctx.globalAlpha = 0.35
        ctx.beginPath()
        const yy = Math.round(y(0)) + 0.5
        ctx.moveTo(0, yy)
        ctx.lineTo(w, yy)
        ctx.stroke()
      }
      ctx.restore()

      // Traces. A sweep is drawn in runs of age, oldest first and dimmest, the way phosphor
      // fades behind the beam; a triggered screen is one bright run. Each run is a soft band
      // from trough to peak under a glowing line through the middle.
      const px = w / n
      type Run = { from: number; to: number; alpha: number }
      const runs: Run[] = []
      if (sweep) {
        const parts = PERSISTENCE_RUNS
        const per = Math.ceil(n / parts)
        // Oldest is the column just ahead of the beam; walk forward from there.
        for (let k = 0; k < parts; k++) {
          const a = beamCol + 1 + k * per
          const bEnd = Math.min(beamCol + n, a + per - 1)
          if (a > bEnd) break
          const alpha = ((k + 1) / parts) ** PERSISTENCE_POWER
          // A run may wrap past the right edge; split it there.
          if (a >= n) runs.push({ from: a - n, to: bEnd - n, alpha })
          else if (bEnd >= n) {
            runs.push({ from: a, to: n - 1, alpha })
            runs.push({ from: 0, to: bEnd - n, alpha })
          } else runs.push({ from: a, to: bEnd, alpha })
        }
      } else runs.push({ from: 0, to: n - 1, alpha: 1 })

      for (const c of ids) {
        ctx.save()
        ctx.strokeStyle = c.color
        ctx.fillStyle = c.color
        ctx.lineJoin = "round"
        ctx.lineCap = "round"
        for (const r of runs) {
          // Overlap runs by a column so the joins do not show as gaps.
          const from = Math.max(0, r.from - 1)
          ctx.globalAlpha = 0.22 * r.alpha
          ctx.fill(bandPath(store, c.id, bucketAt, from, r.to, px, y))
          const mid = tracePath(store, c.id, bucketAt, from, r.to, px, y)
          ctx.globalAlpha = 0.35 * r.alpha
          ctx.lineWidth = 5
          ctx.shadowBlur = 8
          ctx.shadowColor = c.color
          ctx.stroke(mid)
          ctx.shadowBlur = 0
          ctx.globalAlpha = r.alpha
          ctx.lineWidth = 1.6
          ctx.stroke(mid)
        }
        ctx.restore()
      }

      // Scale legend: the extremes down the left, volts per division top right.
      ctx.save()
      ctx.font = "10px ui-monospace, monospace"
      ctx.fillStyle = fg
      ctx.globalAlpha = 0.6
      ctx.textAlign = "left"
      ctx.fillText(formatSI(hi, "V", 1), 4, 11)
      ctx.fillText(formatSI(lo, "V", 1), 4, h - 4)
      ctx.textAlign = "right"
      ctx.fillText(`${formatSI(vdiv, "V", 0)}/div`, w - 4, 11)
      ctx.restore()

      // The beam: a bright spot on every channel at the newest column, and an erased gap ahead.
      if (sweep && beamCol >= 0) {
        const x = (beamCol + 1) * px
        ctx.clearRect(x, 0, Math.max(3, px * 4), h)
        for (const c of ids) {
          const i = bucketAt(beamCol)
          const s = i < 0 ? null : store.at(c.id, i)
          if (!s) continue
          ctx.save()
          ctx.fillStyle = c.color
          ctx.shadowBlur = 10
          ctx.shadowColor = c.color
          ctx.beginPath()
          ctx.arc(beamCol * px, y((s[0] + s[1]) / 2), 2.2, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [store])

  return (
    <div data-slot="scope" className={cn("flex flex-col bg-card text-card-foreground", className)} {...props}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2">
        <span className="text-xs font-medium">Oscilloscope</span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {channels.map((c) => (
            <span
              key={c.id}
              className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-1.5 text-[0.6875rem] tabular-nums"
              style={{ borderColor: c.color }}
            >
              <span className="size-2 rounded-full" style={{ background: c.color }} />
              <span className="max-w-40 truncate font-mono text-muted-foreground">{c.label}</span>
              {c.value !== undefined && <span>{formatSI(c.value, "V")}</span>}
              {c.live ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<Button variant="ghost" size="icon-xs" className="-mr-1 size-5" disabled={!canHold} onClick={onHold} aria-label="Hold as channel" />}
                  >
                    <PinIcon />
                  </TooltipTrigger>
                  <TooltipContent>{canHold ? "Keep this probe as a channel and free the probe" : "All channels in use"}</TooltipContent>
                </Tooltip>
              ) : (
                <Button variant="ghost" size="icon-xs" className="-mr-1 size-5" onClick={() => onRelease(c.id)} aria-label="Remove channel">
                  <XIcon />
                </Button>
              )}
            </span>
          ))}
          {channels.length === 0 && <span className="text-[0.6875rem] text-muted-foreground">Put the probe (M) on a point to get a trace.</span>}
          {mode === "xy" && channels.length === 1 && (
            <span className="text-[0.6875rem] text-muted-foreground">XY needs two channels: hold this one, then probe the second.</span>
          )}
        </div>
        <Select value={String(win)} items={TIMEBASES.map((t) => ({ value: String(t), label: `${formatSI(t / DIVISIONS, "s", 0)}/div` }))} onValueChange={(v) => v !== null && onWindowChange(Number(v))}>
          <SelectTrigger size="sm" className="h-6 w-24 text-[0.6875rem] tabular-nums" aria-label="Timebase">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {TIMEBASES.map((t) => (
              <SelectItem key={t} value={String(t)} className="text-xs tabular-nums">
                {formatSI(t / DIVISIONS, "s", 0)}/div
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup
          size="sm"
          variant="outline"
          spacing={0}
          value={[mode]}
          onValueChange={(v) => {
            const next = (v as ScopeMode[])[0]
            if (next) onModeChange(next)
          }}
          aria-label="Display mode"
        >
          {MODES.map((m) => (
            <Tooltip key={m.value}>
              <TooltipTrigger render={<ToggleGroupItem value={m.value} className="h-6 px-2 text-[0.6875rem]" />}>{m.label}</TooltipTrigger>
              <TooltipContent>{m.hint}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close oscilloscope">
          <XIcon />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <canvas ref={canvas} className="block h-full w-full text-foreground" />
      </div>
    </div>
  )
}
