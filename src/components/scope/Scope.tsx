import * as React from "react"
import { DownloadIcon, PauseIcon, PinIcon, PlayIcon, XIcon } from "lucide-react"
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
/** Panel height limits when dragged, and where it starts. */
const MIN_HEIGHT = 120
const MAX_HEIGHT = 640
const DEFAULT_HEIGHT = 224

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

/**
 * Sweep the beam freely; hold the screen on a rising edge of the trigger channel; arm once
 * and freeze on the next edge (single shot); or plot channel 1 against 2.
 */
export type ScopeMode = "sweep" | "trigger" | "single" | "xy"

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
  { value: "trigger", label: "Trig", hint: "Hold the screen on the last rising edge of the trigger channel" },
  { value: "single", label: "Single", hint: "Arm, then freeze the screen on the next rising edge of the trigger channel — for a one-off event" },
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
  const cell = side / 8
  ctx.save()
  ctx.strokeStyle = fg
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.12
  ctx.beginPath()
  for (let i = -4; i <= 4; i++) {
    const d = i * cell
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

  // Each axis is scaled to its own largest swing over the trail, so a 5 V against a 100 mV
  // still fills the box: four divisions a side, on the 1-2-5 step the swing fits in.
  const start = Math.max(0, len - n)
  let ax = 0
  let ay = 0
  for (let i = start; i < len; i++) {
    const sx = store.at(xc.id, i)
    const sy = store.at(yc.id, i)
    if (sx) ax = Math.max(ax, Math.abs(sx[0]), Math.abs(sx[1]))
    if (sy) ay = Math.max(ay, Math.abs(sy[0]), Math.abs(sy[1]))
  }
  const xdiv = niceStep((ax || 1) / 3.5)
  const ydiv = niceStep((ay || 1) / 3.5)
  const kx = cell / xdiv
  const ky = cell / ydiv

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
  ctx.fillText(`X ${xc.label}  ${formatSI(xdiv, "V", 0)}/div`, cx + side / 2 - 4, cy + side / 2 - 4)
  ctx.fillStyle = yc.color
  ctx.textAlign = "left"
  ctx.fillText(`Y ${yc.label}  ${formatSI(ydiv, "V", 0)}/div`, cx - side / 2 + 4, cy - side / 2 + 12)
  ctx.restore()
}

/** The nearest 1-2-5 step at or above `raw`. */
function niceStep(raw: number) {
  if (!(raw > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

/** A 1-2-5 vertical scale with the range inside it, never touching the edges. */
function verticalScale(vmin: number, vmax: number) {
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
  return { lo, hi, vdiv }
}

/** Less swing than this is the solver settling, not a signal; the trigger leaves it alone. */
const TRIGGER_MIN_SWING = 1e-4

/**
 * Where the trace of `id` crossed upwards through the middle of its swing over [from, len),
 * with `after` buckets still to come so the screen past it is full. `oldest` takes the first
 * such edge (a single shot arms and waits); otherwise the newest, as a repeating trigger holds
 * the latest cycle. −1 when there is none.
 */
function risingEdge(store: TraceStore, id: string, from: number, len: number, after: number, oldest: boolean) {
  let lo = Infinity
  let hi = -Infinity
  for (let i = from; i < len; i++) {
    const s = store.at(id, i)
    if (!s) continue
    if (s[0] < lo) lo = s[0]
    if (s[1] > hi) hi = s[1]
  }
  if (!(hi - lo > TRIGGER_MIN_SWING)) return -1
  const level = (lo + hi) / 2
  const last = len - after
  const crosses = (i: number) => {
    const a = store.at(id, i - 1)
    const c = store.at(id, i)
    return !!a && !!c && (a[0] + a[1]) / 2 < level && (c[0] + c[1]) / 2 >= level
  }
  if (oldest) {
    for (let i = from + 1; i <= last; i++) if (crosses(i)) return i
  } else {
    for (let i = last; i > from; i--) if (crosses(i)) return i
  }
  return -1
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

/** Text with a backing of the panel colour, so a legend stays legible over a trace. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: CanvasTextAlign, color: string, bg: string) {
  const w = ctx.measureText(text).width
  const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x
  ctx.save()
  ctx.globalAlpha = 0.75
  ctx.fillStyle = bg
  ctx.fillRect(left - 2, y - 9, w + 4, 12)
  ctx.globalAlpha = 0.9
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.fillText(text, x, y)
  ctx.restore()
}

/** Comma-separated text of everything the store holds: time, then each channel's trough and peak. */
function toCSV(store: TraceStore, channels: ScopeChannel[]) {
  const ids = channels.filter((c) => store.has(c.id))
  const len = store.length
  const lines = [["t (s)", ...ids.flatMap((c) => [`${c.label} min (V)`, `${c.label} max (V)`])].join(",")]
  for (let i = 0; i < len; i++) {
    const t = store.end - (len - i) * store.bucket
    const row = [t.toPrecision(9)]
    for (const c of ids) {
      const s = store.at(c.id, i)
      row.push(s ? s[0].toPrecision(6) : "", s ? s[1].toPrecision(6) : "")
    }
    lines.push(row.join(","))
  }
  return lines.join("\n")
}

/**
 * An oscilloscope over the probes on the field. Each column is a bucket of solver steps drawn
 * as a bar from trough to peak, so a spike one step wide still shows. Vertical scale follows
 * the signal, shared or one per channel. Free-running, the beam sweeps across and redraws the
 * trace as time passes; triggered, the screen holds the last rising edge of the trigger
 * channel a division in from the left; single shot, it arms and freezes on the next one.
 * Hovering reads the trace out; a click plants a cursor to measure from.
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
  style,
  ...props
}: ScopeProps) {
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const [height, setHeight] = React.useState(DEFAULT_HEIGHT)
  /** The screen frozen by the hold button or a single shot; the live store keeps filling behind it. */
  const [frozen, setFrozen] = React.useState<TraceStore | null>(null)
  /** Each channel on its own vertical scale rather than all on one. */
  const [split, setSplit] = React.useState(false)
  /** Which channel the trigger watches; the first one unless chosen. */
  const [trigChoice, setTrigChoice] = React.useState<string | null>(null)
  const trigId = channels.find((c) => c.id === trigChoice)?.id ?? channels[0]?.id ?? null

  // The frame loop reads the latest props through a ref; re-rendering must not restart it.
  const latest = React.useRef({ channels, win, mode, frozen, split, trigId })
  React.useEffect(() => {
    latest.current = { channels, win, mode, frozen, split, trigId }
  }, [channels, win, mode, frozen, split, trigId])
  const beam = React.useRef<Beam>({ revealed: -1, rate: 0, lastNewest: -1, lastAt: 0, frameAt: 0 })
  /** Single shot: the absolute bucket the scope was armed at, so only a later edge fires it. */
  const armed = React.useRef<number>(-1)
  /** The bucket (from the oldest kept) the shot was taken on, in the frozen store. */
  const shot = React.useRef<number>(-1)
  /** Hover position in canvas pixels, and the planted cursor's column. */
  const hover = React.useRef<{ x: number; y: number } | null>(null)
  const cursor = React.useRef<number | null>(null)

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
    // Time going backwards is the simulation started over: a single shot armed before that
    // would wait for a bucket that is now hours away.
    if (newest < b.lastNewest && armed.current > newest) armed.current = newest
    b.lastNewest = newest
    b.lastAt = now
  }, [store, version])

  // Arming: switching to single, or running again after a shot, waits for an edge newer than now.
  React.useEffect(() => {
    if (mode !== "single" || frozen) return
    armed.current = store.bucket > 0 ? Math.round(store.end / store.bucket) : 0
  }, [mode, frozen, store])

  // The shot itself is taken as batches land, not in the frame loop: a background tab gets a
  // frame a second, and the edge must be caught while it is still in the store.
  React.useEffect(() => {
    if (mode !== "single" || frozen || armed.current < 0 || trigId === null || !store.has(trigId) || store.bucket <= 0) return
    const n = Math.max(2, Math.round(win / store.bucket))
    const pre = Math.floor(n / DIVISIONS)
    const len = store.length
    if (len < n) return
    // Everything since arming is searched, not just the last screens: batches land late in
    // a background tab, and the edge must still be found wherever it sits in the store.
    const base = Math.round(store.end / store.bucket) - len
    const from = Math.min(len, Math.max(1, armed.current - base))
    const edge = risingEdge(store, trigId, from, len, n - pre, true)
    if (edge < 0) return
    armed.current = -1
    shot.current = edge
    setFrozen(store.clone())
  }, [store, version, mode, frozen, trigId, win])

  // A planted cursor measures a trace; with none left it has nothing to measure.
  React.useEffect(() => {
    if (channels.length === 0) cursor.current = null
  }, [channels.length])

  const toggleHold = React.useCallback(() => setFrozen((f) => (f ? null : store.clone())), [store])
  const exportCSV = React.useCallback(() => {
    const src = frozen ?? store
    const url = URL.createObjectURL(new Blob([toCSV(src, channels)], { type: "text/csv" }))
    const a = document.createElement("a")
    a.href = url
    a.download = "scope.csv"
    a.click()
    URL.revokeObjectURL(url)
  }, [store, frozen, channels])

  // Dragging the top edge sets the panel's height.
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = height
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH - (ev.clientY - startY))))
    const up = () => {
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
    }
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
  }

  React.useEffect(() => {
    let raf = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const el = canvas.current
      if (!el) return
      const ctx = el.getContext("2d")
      if (!ctx) return
      const { channels, win, mode, frozen, split, trigId } = latest.current
      const src = frozen ?? store
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
      const cs = getComputedStyle(el)
      const fg = cs.color
      const bg = cs.backgroundColor

      const n = src.bucket > 0 ? Math.max(2, Math.round(win / src.bucket)) : SCOPE_COLUMNS
      const len = src.length
      const ids = channels.filter((c) => src.has(c.id))
      // Buckets newer than the beam's reveal point stay hidden until it gets there; a frozen
      // screen is all there.
      const newest = frozen ? Math.round(src.end / src.bucket) - 1 : Math.floor(b.revealed)
      const hidden = frozen || b.lastNewest < 0 ? 0 : b.lastNewest - newest
      const shown = Math.max(0, len - hidden)

      if (mode === "xy") {
        drawXY(ctx, w, h, fg, src, ids, n, shown)
        return
      }

      // Where the screen starts, in buckets from the oldest kept. Untriggered, the beam
      // sweeps: each bucket has a fixed column by its time, so the newest one overwrites the
      // oldest. `sweep` maps screen column to bucket index; the newest column is the beam.
      // Triggered, the edge sits one division in, so what led up to it is seen too.
      const pre = Math.floor(n / DIVISIONS)
      let start = Math.max(0, shown - n)
      let sweep: Int32Array | null = null
      let beamCol = -1
      let trigCol = -1
      const triggered = (mode === "trigger" || mode === "single") && trigId !== null && src.has(trigId)
      const trigColor = channels.find((c) => c.id === trigId)?.color ?? fg
      if (mode === "sweep" && src.bucket > 0 && shown > 0) {
        sweep = new Int32Array(n).fill(-1)
        for (let i = Math.max(0, shown - n); i < shown; i++) {
          const col = (((newest - (shown - 1 - i)) % n) + n) % n
          sweep[col] = i
        }
        beamCol = ((newest % n) + n) % n
      } else if (triggered && len >= n) {
        // Single shot: armed, the newest data rolls by until the shot is taken; taken, the
        // screen holds the edge it was taken on. Repeating: the last edge with a screen after it.
        const edge = mode === "single" ? (frozen ? shot.current : -1) : risingEdge(src, trigId, Math.max(1, len - 2 * n), len, n - pre, false)
        start = Math.max(0, len - n)
        if (edge >= 0) {
          start = Math.max(0, edge - pre)
          trigCol = edge - start
        }
      }
      /** The bucket shown in screen column `col`, or -1. */
      const bucketAt = (col: number) => (sweep ? sweep[col] : start + col < (triggered ? len : shown) ? start + col : -1)

      // Vertical range over the last few screens rather than just this one, so the scale does
      // not jump while a sweep is half way through a cycle. On a 1-2-5 grid, shared or per channel.
      const range = (list: ScopeChannel[]) => {
        let vmin = Infinity
        let vmax = -Infinity
        for (const c of list) {
          for (let i = Math.max(0, len - SCALE_SCREENS * n); i < len; i++) {
            const s = src.at(c.id, i)
            if (!s) continue
            if (s[0] < vmin) vmin = s[0]
            if (s[1] > vmax) vmax = s[1]
          }
        }
        return verticalScale(vmin, vmax)
      }
      const shared = range(ids)
      const scales = new Map(ids.map((c) => [c.id, split ? range([c]) : shared]))
      const yOf = (c: ScopeChannel) => {
        const { lo, hi } = scales.get(c.id) ?? shared
        return (v: number) => h - ((v - lo) / (hi - lo)) * h
      }
      // The graticule follows the trigger channel's scale when they differ.
      const grid = (trigId !== null && scales.get(trigId)) || shared

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
      const gy = (v: number) => h - ((v - grid.lo) / (grid.hi - grid.lo)) * h
      for (let v = grid.lo + grid.vdiv; v < grid.hi - grid.vdiv / 2; v += grid.vdiv) {
        const yy = Math.round(gy(v)) + 0.5
        ctx.moveTo(0, yy)
        ctx.lineTo(w, yy)
      }
      ctx.stroke()
      if (grid.lo < 0 && grid.hi > 0) {
        ctx.globalAlpha = 0.35
        ctx.beginPath()
        const yy = Math.round(gy(0)) + 0.5
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
        const y = yOf(c)
        ctx.save()
        ctx.strokeStyle = c.color
        ctx.fillStyle = c.color
        ctx.lineJoin = "round"
        ctx.lineCap = "round"
        for (const r of runs) {
          // Overlap runs by a column so the joins do not show as gaps.
          const from = Math.max(0, r.from - 1)
          const band = bandPath(src, c.id, bucketAt, from, r.to, px, y)
          ctx.globalAlpha = 0.22 * r.alpha
          ctx.fill(band)
          // The band's edge drawn too: a spike narrower than a bucket is a bar up to its peak,
          // not a faint wash half way there.
          ctx.globalAlpha = 0.7 * r.alpha
          ctx.lineWidth = 1
          ctx.stroke(band)
          const mid = tracePath(src, c.id, bucketAt, from, r.to, px, y)
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

      // The beam: a bright spot on every channel at the newest column, and an erased gap ahead.
      if (sweep && beamCol >= 0 && !frozen) {
        const x = (beamCol + 1) * px
        ctx.clearRect(x, 0, Math.max(3, px * 4), h)
        for (const c of ids) {
          const i = bucketAt(beamCol)
          const s = i < 0 ? null : src.at(c.id, i)
          if (!s) continue
          ctx.save()
          ctx.fillStyle = c.color
          ctx.shadowBlur = 10
          ctx.shadowColor = c.color
          ctx.beginPath()
          ctx.arc(beamCol * px, yOf(c)((s[0] + s[1]) / 2), 2.2, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }
      }

      // Trigger point: a marker at the top of the column the edge was found in.
      if (trigCol >= 0) {
        const x = trigCol * px
        ctx.save()
        ctx.fillStyle = trigColor
        ctx.beginPath()
        ctx.moveTo(x - 4, 0)
        ctx.lineTo(x + 4, 0)
        ctx.lineTo(x, 6)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }

      ctx.font = "10px ui-monospace, monospace"
      // Cursors: the hovered column, and the planted one to measure against. Time reads from
      // the trigger point on a triggered screen, back from the beam on a sweep.
      const timeAt = (col: number) => (sweep ? -((((beamCol - col) % n) + n) % n) * src.bucket : (col - trigCol) * src.bucket)
      const hv = hover.current
      const hoverCol = hv && src.bucket > 0 ? Math.min(n - 1, Math.max(0, Math.floor(hv.x / px))) : -1
      const drawCursor = (col: number, strong: boolean) => {
        const x = Math.round(col * px) + 0.5
        ctx.save()
        ctx.strokeStyle = fg
        ctx.globalAlpha = strong ? 0.6 : 0.35
        ctx.setLineDash(strong ? [] : [3, 3])
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
        ctx.restore()
        for (const c of ids) {
          const i = bucketAt(col)
          const s = i < 0 ? null : src.at(c.id, i)
          if (!s) continue
          ctx.save()
          ctx.fillStyle = c.color
          ctx.beginPath()
          ctx.arc(col * px, yOf(c)((s[0] + s[1]) / 2), 3, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }
      }
      const planted = cursor.current
      if (planted !== null && planted < n) drawCursor(planted, true)
      if (hoverCol >= 0) drawCursor(hoverCol, false)
      const readout: { text: string; color: string }[] = []
      const mid = (c: ScopeChannel, col: number) => {
        const i = bucketAt(col)
        const s = i < 0 ? null : src.at(c.id, i)
        return s ? (s[0] + s[1]) / 2 : null
      }
      if (hoverCol >= 0) {
        const tRef = trigCol >= 0 || sweep ? "" : " from left"
        readout.push({ text: `t ${formatSI(timeAt(hoverCol), "s")}${tRef}`, color: fg })
        for (const c of ids) {
          const i = bucketAt(hoverCol)
          const s = i < 0 ? null : src.at(c.id, i)
          if (!s) continue
          // A bucket that swings more than a hairline is read out as its extremes too.
          const { lo, hi } = scales.get(c.id) ?? shared
          const span = s[1] - s[0] > (hi - lo) / 100 ? `  (${formatSI(s[0], "V")} … ${formatSI(s[1], "V")})` : ""
          readout.push({ text: `${c.label}  ${formatSI((s[0] + s[1]) / 2, "V")}${span}`, color: c.color })
        }
        if (planted !== null && planted < n && planted !== hoverCol) {
          const dt = Math.abs(timeAt(hoverCol) - timeAt(planted))
          readout.push({ text: `Δt ${formatSI(dt, "s")}  ${dt > 0 ? formatSI(1 / dt, "Hz") : ""}`, color: fg })
          for (const c of ids) {
            const a = mid(c, planted)
            const v = mid(c, hoverCol)
            if (a !== null && v !== null) readout.push({ text: `ΔV ${c.label}  ${formatSI(v - a, "V")}`, color: c.color })
          }
        }
      }
      // The readout box sits away from the hover, so it never hides what is under the cursor.
      if (readout.length) {
        const left = hv && hv.x < w / 2
        const x0 = left ? w - 8 : 8
        readout.forEach((r, k) => label(ctx, r.text, x0, 24 + k * 13, left ? "right" : "left", r.color, bg))
      }

      // Scale legend: the extremes down the left on a shared scale, volts per division top
      // right — one line per channel in its colour when each has its own.
      if (split) {
        ids.forEach((c, k) => label(ctx, `${c.label} ${formatSI(scales.get(c.id)!.vdiv, "V", 0)}/div`, w - 4, 11 + k * 13, "right", c.color, bg))
      } else {
        label(ctx, formatSI(shared.hi, "V", 1), 4, 11, "left", fg, bg)
        label(ctx, formatSI(shared.lo, "V", 1), 4, h - 4, "left", fg, bg)
        label(ctx, `${formatSI(shared.vdiv, "V", 0)}/div`, w - 4, 11, "right", fg, bg)
      }
      if (frozen) label(ctx, mode === "single" ? "SINGLE — captured" : "HOLD", w / 2, 11, "center", fg, bg)
      else if (mode === "single") label(ctx, "SINGLE — armed", w / 2, 11, "center", fg, bg)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [store])

  return (
    <div data-slot="scope" className={cn("relative flex flex-col bg-card text-card-foreground", className)} style={{ ...style, height }} {...props}>
      <div className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize hover:bg-primary/40" onPointerDown={onResizeStart} aria-label="Resize oscilloscope" />
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
        {(mode === "trigger" || mode === "single") && channels.length > 1 && (
          <Select value={trigId ?? ""} items={channels.map((c) => ({ value: c.id, label: c.label }))} onValueChange={(v) => v !== null && setTrigChoice(v)}>
            <SelectTrigger size="sm" className="h-6 w-48 text-[0.6875rem]" aria-label="Trigger channel">
              <span className="text-muted-foreground">Trig on</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {channels.map((c) => (
                <SelectItem key={c.id} value={c.id} className="font-mono text-xs">
                  <span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: c.color }} />
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
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
            if (!next) return
            // A frozen screen belongs to the mode it was taken in.
            setFrozen(null)
            onModeChange(next)
          }}
          aria-label="Display mode"
        >
          {MODES.map((m) => (
            <Tooltip key={m.value}>
              <TooltipTrigger render={<ToggleGroupItem value={m.value} className="h-6 px-2 text-[0.6875rem] aria-pressed:bg-primary aria-pressed:text-primary-foreground" />}>{m.label}</TooltipTrigger>
              <TooltipContent>{m.hint}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant={split ? "default" : "outline"} size="xs" className="h-6 px-2 text-[0.6875rem]" onClick={() => setSplit((s) => !s)} aria-pressed={split} aria-label="Separate vertical scales" />}
          >
            Split
          </TooltipTrigger>
          <TooltipContent>{split ? "Back to one vertical scale for all channels" : "Give each channel its own vertical scale, so a ripple next to a rail still shows"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant={frozen ? "default" : "outline"} size="icon-xs" className="h-6" onClick={toggleHold} aria-label={frozen ? "Run" : "Hold"} />}>
            {frozen ? <PlayIcon /> : <PauseIcon />}
          </TooltipTrigger>
          <TooltipContent>{frozen ? (mode === "single" ? "Arm again" : "Follow the live trace again") : "Freeze the screen; the simulation keeps running"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" className="h-6" onClick={exportCSV} disabled={channels.length === 0} aria-label="Export CSV" />}>
            <DownloadIcon />
          </TooltipTrigger>
          <TooltipContent>Save everything the scope holds as CSV (time, and each channel's trough and peak per sample)</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close oscilloscope">
          <XIcon />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <canvas
          ref={canvas}
          className="block h-full w-full cursor-crosshair bg-card text-foreground"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            hover.current = { x: e.clientX - r.left, y: e.clientY - r.top }
          }}
          onPointerLeave={() => {
            hover.current = null
          }}
          onClick={(e) => {
            if (mode === "xy") return
            const el = e.currentTarget
            const r = el.getBoundingClientRect()
            const src = frozen ?? store
            const n = src.bucket > 0 ? Math.max(2, Math.round(win / src.bucket)) : SCOPE_COLUMNS
            const col = Math.floor(((e.clientX - r.left) / el.clientWidth) * n)
            // Click plants the measuring cursor; a click on it takes it away.
            cursor.current = cursor.current === col ? null : col
          }}
        />
      </div>
    </div>
  )
}
