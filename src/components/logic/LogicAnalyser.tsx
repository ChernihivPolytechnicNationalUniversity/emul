import * as React from "react"
import { PauseIcon, PinIcon, PlayIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatSI } from "@/sim/units"
import { decodeI2c, decodeSpi, decodeUart, levelAt, type EdgeSeries, type Frame } from "@/sim/protocols"
import type { ScopeChannel } from "@/components/scope/Scope"
import type { LogicStore } from "./logic-store"

/** Screen widths on offer, in seconds: from a few SPI clocks to a whole second. */
export const LOGIC_SPANS = [20e-6, 50e-6, 100e-6, 200e-6, 500e-6, 1e-3, 2e-3, 5e-3, 10e-3, 20e-3, 50e-3, 0.1, 0.2, 0.5, 1] as const
const ROW = 34
const LABEL_W = 0
const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000]

export type Protocol = "none" | "uart" | "spi" | "i2c"

/** Decoder settings: which channel plays which bus signal (channel ids), and the bus options. */
export type DecoderConfig = {
  protocol: Protocol
  /** Signal role → channel id. */
  roles: Record<string, string>
  baud: number
  cpol: 0 | 1
  cpha: 0 | 1
}

const PROTOCOLS: { value: Protocol; label: string }[] = [
  { value: "none", label: "No decoder" },
  { value: "uart", label: "UART" },
  { value: "spi", label: "SPI" },
  { value: "i2c", label: "I²C" },
]
const SPAN_ITEMS = LOGIC_SPANS.map((t) => ({ value: String(t), label: formatSI(t, "s", 0) }))
const BAUD_ITEMS = BAUDS.map((b) => ({ value: String(b), label: `${b} Bd` }))
const MODE_ITEMS = ["00", "01", "10", "11"].map((m) => ({ value: m, label: `Mode ${Number(m[0]) * 2 + Number(m[1])}` }))

export const DEFAULT_DECODER: DecoderConfig = { protocol: "none", roles: {}, baud: 115200, cpol: 0, cpha: 0 }

const ROLES: Record<Protocol, { key: string; label: string; optional?: boolean }[]> = {
  none: [],
  uart: [{ key: "rx", label: "Data" }],
  spi: [
    { key: "sck", label: "SCK" },
    { key: "mosi", label: "MOSI", optional: true },
    { key: "miso", label: "MISO", optional: true },
    { key: "cs", label: "CS", optional: true },
  ],
  i2c: [
    { key: "sda", label: "SDA" },
    { key: "scl", label: "SCL" },
  ],
}

type Props = React.ComponentProps<"div"> & {
  store: LogicStore
  version: number
  channels: ScopeChannel[]
  span: number
  onSpanChange: (seconds: number) => void
  decoder: DecoderConfig
  onDecoderChange: (d: DecoderConfig) => void
  canHold: boolean
  onHold: () => void
  onRelease: (id: string) => void
  onClose: () => void
}

/** Run the configured decoder over the channels' edges inside [from, to]; frames carry the channel id to draw on. */
function decode(store: LogicStore, cfg: DecoderConfig, from: number, to: number): { channel: string; frame: Frame }[] {
  const series = (role: string): EdgeSeries | null => {
    const id = cfg.roles[role]
    return id ? store.edges(id) : null
  }
  const out: { channel: string; frame: Frame }[] = []
  // Decode a little before the window so a frame straddling the left edge is drawn.
  const pre = from - (to - from)
  if (cfg.protocol === "uart") {
    const rx = series("rx")
    if (rx) for (const f of decodeUart(rx, { baud: cfg.baud }, pre, to)) out.push({ channel: cfg.roles.rx, frame: f })
  } else if (cfg.protocol === "spi") {
    const sck = series("sck")
    const mosi = series("mosi")
    const miso = series("miso")
    if (sck)
      for (const f of decodeSpi(sck, mosi, miso, series("cs"), { cpol: cfg.cpol, cpha: cfg.cpha }, pre, to))
        out.push({ channel: f.channel === 1 ? cfg.roles.miso : (cfg.roles.mosi ?? cfg.roles.sck), frame: f })
  } else if (cfg.protocol === "i2c") {
    const sda = series("sda")
    const scl = series("scl")
    if (sda && scl) for (const f of decodeI2c(sda, scl, pre, to)) out.push({ channel: cfg.roles.sda, frame: f })
  }
  return out.filter((f) => f.frame.end >= from && f.frame.start <= to)
}

/**
 * Logic analyser: every probe is a channel drawn as a digital waveform from the exact-time
 * edges the simulation recorded, over a window that follows the newest sample (or holds
 * still), with a UART/SPI/I²C decoder writing the bytes over the signals. Wheel to zoom,
 * drag to pan while held.
 */
export function LogicAnalyser({ className, store, version, channels, span, onSpanChange, decoder, onDecoderChange, canHold, onHold, onRelease, onClose, ...props }: Props) {
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const [held, setHeld] = React.useState(false)
  /** Right edge of the window while held, in simulated seconds. */
  const [holdEnd, setHoldEnd] = React.useState(0)
  const drag = React.useRef<{ x: number; end: number } | null>(null)

  const followEnd = () => (store.lastEdge > 0 && store.end - store.lastEdge > span * 0.2 ? store.lastEdge + span * 0.2 : store.end)
  const toggleHold = () => {
    if (!held) setHoldEnd(followEnd())
    setHeld(!held)
  }

  // Redraw on every store change and on settings changes.
  React.useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext("2d")
    if (!ctx) return
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
    // Following, the window ends a little after the newest edge, not at "now": a bursty bus
    // (an SPI transfer every 10 ms) would otherwise sit in the empty gap off the left edge.
    const end = held ? holdEnd : store.lastEdge > 0 && store.end - store.lastEdge > span * 0.2 ? store.lastEdge + span * 0.2 : store.end
    const from = end - span
    const x = (t: number) => LABEL_W + ((t - from) / span) * (w - LABEL_W)

    // Time grid: ten divisions, labelled with the time before the right edge.
    ctx.save()
    ctx.strokeStyle = fg
    ctx.fillStyle = fg
    ctx.font = "10px ui-monospace, monospace"
    ctx.textAlign = "center"
    for (let i = 0; i <= 10; i++) {
      const xx = Math.round(LABEL_W + (i / 10) * (w - LABEL_W)) + 0.5
      ctx.globalAlpha = 0.12
      ctx.beginPath()
      ctx.moveTo(xx, 0)
      ctx.lineTo(xx, h)
      ctx.stroke()
      if (i > 0 && i < 10) {
        ctx.globalAlpha = 0.5
        ctx.fillText(`−${formatSI(span * (1 - i / 10), "s", 2)}`, xx, h - 3)
      }
    }
    ctx.restore()

    const ids = channels.filter((c) => store.has(c.id))
    const frames = decoder.protocol === "none" ? [] : decode(store, decoder, from, end)
    ids.forEach((c, row) => {
      const s = store.edges(c.id)
      if (!s) return
      const top = 6 + row * ROW
      const yHigh = top + 6
      const yLow = top + ROW - 10
      ctx.save()
      ctx.strokeStyle = c.color
      ctx.lineWidth = 1.5
      ctx.lineJoin = "miter"
      ctx.beginPath()
      // Start at the level in force at the left edge, then every edge inside the window.
      let level = levelAt(s, from)
      let px = x(from)
      ctx.moveTo(px, level ? yHigh : yLow)
      let i = 0
      // Binary search to the first edge after `from`.
      let lo = 0
      let hi = s.count
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (s.times[mid] <= from) lo = mid + 1
        else hi = mid
      }
      i = lo
      // Edges denser than a pixel collapse into a filled block.
      let lastPx = -Infinity
      for (; i < s.count && s.times[i] <= end; i++) {
        const t = s.times[i]
        const nx = x(t)
        const nl = s.levels[i] === 1
        if (nx - lastPx < 0.8 && nx - px < 0.8) {
          level = nl
          continue
        }
        ctx.lineTo(nx, level ? yHigh : yLow)
        ctx.lineTo(nx, nl ? yHigh : yLow)
        level = nl
        lastPx = px
        px = nx
      }
      ctx.lineTo(x(end), level ? yHigh : yLow)
      ctx.stroke()
      // Channel label and the level at the right edge.
      ctx.font = "10px ui-monospace, monospace"
      ctx.textAlign = "left"
      ctx.globalAlpha = 0.85
      ctx.fillStyle = c.color
      ctx.fillText(c.label, LABEL_W + 4, top + 4 + 8)
      ctx.restore()

      // Decoded frames over this channel.
      for (const f of frames) {
        if (f.channel !== c.id) continue
        const a = x(f.frame.start)
        const b = x(f.frame.end)
        const mid = (yHigh + yLow) / 2
        ctx.save()
        const color = f.frame.kind === "error" ? "#ef4444" : f.frame.kind === "control" ? "#a855f7" : c.color
        ctx.fillStyle = color
        ctx.strokeStyle = color
        if (b - a < 3) {
          // A point event (START/STOP): a marker with the text above.
          ctx.globalAlpha = 0.9
          ctx.beginPath()
          ctx.moveTo(a, yHigh - 2)
          ctx.lineTo(a, yLow + 2)
          ctx.stroke()
          ctx.font = "bold 10px ui-monospace, monospace"
          ctx.textAlign = "center"
          ctx.fillText(f.frame.text, a, top + 5)
        } else {
          ctx.globalAlpha = 0.18
          ctx.fillRect(a, yHigh - 3, b - a, yLow - yHigh + 6)
          ctx.globalAlpha = 0.9
          ctx.lineWidth = 1
          ctx.strokeRect(Math.round(a) + 0.5, yHigh - 3 + 0.5, Math.round(b - a), yLow - yHigh + 6)
          ctx.font = "10px ui-monospace, monospace"
          ctx.textAlign = "center"
          ctx.fillStyle = fg
          const text = ctx.measureText(f.frame.text).width < b - a - 4 ? f.frame.text : ctx.measureText(f.frame.text.split(" ")[0]).width < b - a - 4 ? f.frame.text.split(" ")[0] : ""
          if (text) ctx.fillText(text, (a + b) / 2, mid + 3.5)
        }
        ctx.restore()
      }
    })
    if (store.dropped) {
      ctx.save()
      ctx.fillStyle = "#ef4444"
      ctx.font = "10px ui-monospace, monospace"
      ctx.textAlign = "right"
      ctx.fillText("edges dropped: the bus is faster than the analyser keeps up with", w - 4, 11)
      ctx.restore()
    }
  }, [store, version, channels, span, decoder, held, holdEnd])

  // Wheel zooms around the cursor; a drag pans (and holds the screen). The wheel listener is
  // attached by hand so it can be non-passive: the page must not scroll under the analyser.
  // Several wheel events can land before React re-renders: the span they step from is tracked here.
  const spanNow = React.useRef(span)
  React.useEffect(() => {
    spanNow.current = span
  }, [span])
  const zoom = (e: WheelEvent) => {
    e.preventDefault()
    const cur = spanNow.current
    const i = LOGIC_SPANS.indexOf(cur as (typeof LOGIC_SPANS)[number])
    const next = LOGIC_SPANS[Math.max(0, Math.min(LOGIC_SPANS.length - 1, (i < 0 ? 5 : i) + (e.deltaY > 0 ? 1 : -1)))]
    if (next === cur) return
    spanNow.current = next
    const el = canvas.current
    if (held && el) {
      // Keep the time under the cursor where it is.
      const frac = (e.clientX - el.getBoundingClientRect().left - LABEL_W) / (el.clientWidth - LABEL_W)
      setHoldEnd((end) => end - cur + frac * cur + (1 - frac) * next)
    }
    onSpanChange(next)
  }
  const zoomRef = React.useRef(zoom)
  React.useEffect(() => {
    zoomRef.current = zoom
  })
  React.useEffect(() => {
    const el = canvas.current
    if (!el) return
    const handler = (e: WheelEvent) => zoomRef.current(e)
    el.addEventListener("wheel", handler, { passive: false })
    return () => el.removeEventListener("wheel", handler)
  }, [])
  const onPointerDown = (e: React.PointerEvent) => {
    const end = held ? holdEnd : followEnd()
    if (!held) {
      setHeld(true)
      setHoldEnd(end)
    }
    drag.current = { x: e.clientX, end }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    const el = canvas.current
    if (!d || !el) return
    const dt = ((e.clientX - d.x) / (el.clientWidth - LABEL_W)) * span
    setHoldEnd(Math.min(store.end, d.end - dt))
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const roles = ROLES[decoder.protocol]
  const setRole = (key: string, id: string) => onDecoderChange({ ...decoder, roles: { ...decoder.roles, [key]: id } })
  // A newly assigned protocol takes the channels in order, which is what a probe-in-order student expects.
  const setProtocol = (p: Protocol) => {
    const r: Record<string, string> = {}
    ROLES[p].forEach((role, i) => {
      if (channels[i]) r[role.key] = channels[i].id
    })
    onDecoderChange({ ...decoder, protocol: p, roles: r })
  }

  return (
    <div data-slot="logic-analyser" className={cn("flex flex-col bg-card text-card-foreground", className)} {...props}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2">
        <span className="text-xs font-medium">Logic analyser</span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {channels.map((c) => (
            <span key={c.id} className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-1.5 text-[0.6875rem] tabular-nums" style={{ borderColor: c.color }}>
              <span className="size-2 rounded-full" style={{ background: c.color }} />
              <span className="max-w-40 truncate font-mono text-muted-foreground">{c.label}</span>
              {c.live ? (
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-xs" className="-mr-1 size-5" disabled={!canHold} onClick={onHold} aria-label="Hold as channel" />}>
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
          {channels.length === 0 && <span className="text-[0.6875rem] text-muted-foreground">Put the probe (M) on a signal; hold it to add channels.</span>}
        </div>
        <Select value={decoder.protocol} items={PROTOCOLS} onValueChange={(v) => v !== null && setProtocol(v as Protocol)}>
          <SelectTrigger size="sm" className="h-6 w-20 text-[0.6875rem]" aria-label="Decoder">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {PROTOCOLS.map((p) => (
              <SelectItem key={p.value} value={p.value} className="text-xs">
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {roles.map((role) => (
          <Select key={role.key} value={decoder.roles[role.key] ?? ""} items={[{ value: "", label: "—" }, ...channels.map((c) => ({ value: c.id, label: c.label }))]} onValueChange={(v) => setRole(role.key, v ?? "")}>
            <SelectTrigger size="sm" className="h-6 w-28 text-[0.6875rem]" aria-label={role.label}>
              <span className="text-muted-foreground">{role.label}</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {role.optional && <SelectItem value="" className="text-xs">—</SelectItem>}
              {channels.map((c) => (
                <SelectItem key={c.id} value={c.id} className="text-xs">
                  <span className="inline-block size-2 rounded-full" style={{ background: c.color }} /> {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
        {decoder.protocol === "uart" && (
          <Select value={String(decoder.baud)} items={BAUD_ITEMS} onValueChange={(v) => v !== null && onDecoderChange({ ...decoder, baud: Number(v) })}>
            <SelectTrigger size="sm" className="h-6 w-24 text-[0.6875rem] tabular-nums" aria-label="Baud">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {BAUDS.map((b) => (
                <SelectItem key={b} value={String(b)} className="text-xs tabular-nums">
                  {b} Bd
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {decoder.protocol === "spi" && (
          <Select value={`${decoder.cpol}${decoder.cpha}`} items={MODE_ITEMS} onValueChange={(v) => v !== null && onDecoderChange({ ...decoder, cpol: Number(v[0]) as 0 | 1, cpha: Number(v[1]) as 0 | 1 })}>
            <SelectTrigger size="sm" className="h-6 w-20 text-[0.6875rem]" aria-label="SPI mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {["00", "01", "10", "11"].map((m) => (
                <SelectItem key={m} value={m} className="text-xs">
                  Mode {Number(m[0]) * 2 + Number(m[1])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={String(span)} items={SPAN_ITEMS} onValueChange={(v) => v !== null && onSpanChange(Number(v))}>
          <SelectTrigger size="sm" className="h-6 w-24 text-[0.6875rem] tabular-nums" aria-label="Span">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {LOGIC_SPANS.map((t) => (
              <SelectItem key={t} value={String(t)} className="text-xs tabular-nums">
                {formatSI(t, "s", 0)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger render={<Button variant={held ? "default" : "outline"} size="icon-xs" className="h-6" onClick={toggleHold} aria-label={held ? "Follow" : "Hold"} />}>
            {held ? <PlayIcon /> : <PauseIcon />}
          </TooltipTrigger>
          <TooltipContent>{held ? "Follow the newest samples again" : "Hold the screen (drag to pan, wheel to zoom)"}</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close logic analyser">
          <XIcon />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <canvas
          ref={canvas}
          className="block h-full w-full cursor-ew-resize text-foreground"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
    </div>
  )
}
