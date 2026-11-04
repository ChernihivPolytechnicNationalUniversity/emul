import * as React from "react"
import { cn } from "cn"
import { citedDoc, citeLabel, docUrl } from "@/schematic/datasheets"
import {
  type Characteristic,
  type Colour,
  type Condition,
  formatCharacteristic,
  formatCondition,
  formatNumber,
  type Glyph,
  KINDS,
  type Level,
  type Quantity,
} from "@/schematic/characteristics"
import type { Datasheet } from "@/schematic/types"

// The characteristics as rows: glyph · label · visual · number and page. Everything about how a
// row looks comes from the registry (its kind's visual, glyph, label, quantity); a part's record
// gives only numbers. Marks by shape: a band for the range, a dot for typ, a red tick and hatch
// beyond the abs max, an arc for hysteresis, a dashed outline for an estimate.

const H = 28
const RED = "var(--color-red-600)"
const GREEN = "var(--color-green-600)"

const num = (l: Level | undefined, vcc: number) => (l === undefined ? undefined : typeof l === "number" ? l : l.times !== undefined ? l.times * vcc : vcc + (l.offset ?? 0))

/** A glyph per quantity family, drawn at 14 px. */
function GlyphIcon({ glyph }: { glyph: Glyph }) {
  const p = { stroke: "currentColor", strokeWidth: 1.4, fill: "none" }
  const body: Record<Glyph, React.ReactNode> = {
    rail: <><path d="M2 3h10M2 11h10" {...p} /><path d="M7 3v8" {...p} strokeDasharray="1.5 1.5" /></>,
    arrow: <path d="M2 7h9M8 4l3 3-3 3" {...p} />,
    sine: <path d="M1 7c1.5-5 3-5 4.5 0s3 5 4.5 0 2-3 3-1" {...p} />,
    clock: <><circle cx="7" cy="7" r="5.2" {...p} /><path d="M7 4v3l2 1.5" {...p} /></>,
    thermo: <><path d="M7 2v7" {...p} strokeWidth={2.2} strokeLinecap="round" /><circle cx="7" cy="10.5" r="2.2" fill="currentColor" /></>,
    zigzag: <path d="M1 7h2l1.5-3 2 6 2-6 2 6 1.5-3h1" {...p} />,
    speaker: <><path d="M2 5h2.5L8 2v10L4.5 9H2z" fill="currentColor" /><path d="M10 4.5c1 1.5 1 3.5 0 5" {...p} /></>,
    prism: <path d="M7 2l5 9H2z" {...p} />,
    chip: <><rect x="3.5" y="3.5" width="7" height="7" rx="1" {...p} /><path d="M5.5 1.5v2M8.5 1.5v2M5.5 10.5v2M8.5 10.5v2" {...p} /></>,
    battery: <><rect x="2" y="4" width="9" height="6" rx="1" {...p} /><path d="M12 6v2" {...p} /></>,
    gear: <><circle cx="7" cy="7" r="2.2" {...p} /><path d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2" {...p} /></>,
  }
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden>
      {body[glyph]}
    </svg>
  )
}

/**
 * A band on a linear scale: the value's min–max as a band, typ as a dot, a typ with only a max as a
 * dot and a whisker up to it; the abs max hatched beyond its red tick. Several colours of one LED
 * share the scale, each in its own colour, a little apart.
 */
function RangeBar({ cs, w: W, show }: { cs: Characteristic[]; w: number; show?: number }) {
  const vals = cs.flatMap((c) => [c.value?.min, c.value?.typ, c.value?.max, c.limit?.max, c.limit?.min].map((l) => num(l, 0)).filter((n): n is number => n !== undefined))
  const sym = cs.some((c) => c.value?.sym || c.limit?.sym)
  const top = Math.max(...vals.map(Math.abs), 1e-12) * 1.15
  const lo = sym ? -top : Math.min(0, ...vals)
  const hi = top
  const x = (n: number) => 4 + ((n - lo) / (hi - lo)) * (W - 8)
  const drawn = show === undefined ? cs : [cs[show]]
  const limits = [...new Set(drawn.flatMap((c) => (c.limit ? (c.limit.sym ? [num(c.limit.max, 0)!, -num(c.limit.max, 0)!] : [num(c.limit.max, 0), num(c.limit.min, 0)].filter((n): n is number => n !== undefined)) : [])))]
  const q = KINDS[cs[0].kind].quantity
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <defs>
        <pattern id="abs-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" stroke={RED} strokeWidth="1" opacity=".45" />
        </pattern>
      </defs>
      <line x1={x(lo)} x2={x(hi)} y1={11} y2={11} className="stroke-muted-foreground/50" />
      {limits.map((l) => (l > 0 ? <rect key={l} x={x(l)} y={6} width={x(hi) - x(l)} height={10} fill="url(#abs-hatch)" /> : <rect key={l} x={x(lo)} y={6} width={x(l) - x(lo)} height={10} fill="url(#abs-hatch)" />))}
      {drawn.map((c, i) => {
        const v = c.value
        if (!v) return null
        const y = 11 + (i - (drawn.length - 1) / 2) * 4
        const ink = c.colour ? COLOURS[c.colour] : undefined
        const min = v.sym ? -num(v.max, 0)! : num(v.min, 0)
        const max = num(v.max, 0)
        const typ = num(v.typ, 0)
        const dash = v.approx ? "2 1.5" : undefined
        return (
          <g key={i}>
            {min !== undefined && max !== undefined && max > min && (
              <rect x={x(min)} y={y - (drawn.length > 1 ? 2 : 5)} width={Math.max(2, x(max) - x(min))} height={drawn.length > 1 ? 4 : 10} rx={2} fill={ink ?? GREEN} fillOpacity={ink ? 0.35 : 0.18} stroke={ink ?? GREEN} strokeDasharray={dash}>
                <title>{`${formatNumber(min, q)} … ${formatNumber(max, q)}`}</title>
              </rect>
            )}
            {min === undefined && typ !== undefined && max !== undefined && (
              <g stroke={ink ?? "currentColor"} className={ink ? undefined : "text-foreground"} strokeDasharray={dash}>
                <line x1={x(typ)} x2={x(max)} y1={y} y2={y} strokeWidth={1.4} />
                <line x1={x(max)} x2={x(max)} y1={y - 3} y2={y + 3} strokeWidth={1.4}>
                  <title>{`max ${formatNumber(max, q)}`}</title>
                </line>
              </g>
            )}
            {typ !== undefined && (
              <circle cx={x(typ)} cy={y} r={3} fill={ink ?? "currentColor"} className={ink ? undefined : "fill-foreground"}>
                <title>{`typ ${formatNumber(typ, q)}`}</title>
              </circle>
            )}
          </g>
        )
      })}
      {limits.map((l) => <line key={`t${l}`} x1={x(l)} x2={x(l)} y1={3} y2={17} stroke={RED} strokeWidth={2} />)}
      {limits.filter((l) => l > 0).map((l) => <text key={`n${l}`} x={Math.min(x(l), W - 2)} y={26} fontSize={9} textAnchor={x(l) > W - 24 ? "end" : "middle"} fill={RED}>{formatNumber(l, q)}</text>)}
    </svg>
  )
}

/** Marks on a GND–VCC rail: the zone a value claims, a tick at it, an arc to its release. */
function RailBar({ c, w: W }: { c: Characteristic; w: number }) {
  const supply = (c.at ?? []).find((a): a is Extract<Condition, { supply: number }> => "supply" in a)?.supply
  const v = c.value!
  const vcc = supply ?? 1
  const x = (n: number) => 4 + (n / vcc) * (W - 8)
  const lo = num(v.min, vcc)
  const hi = num(v.max, vcc)
  const at = num(v.typ, vcc) ?? lo ?? hi
  const zone = lo !== undefined ? [lo, hi ?? vcc] : hi !== undefined ? [0, hi] : undefined
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <rect x={4} y={7} width={W - 8} height={8} rx={2} className="fill-muted stroke-border" />
      {zone && <rect x={x(zone[0])} y={7} width={x(zone[1]) - x(zone[0])} height={8} fill="var(--color-blue-500)" fillOpacity={0.25} />}
      {at !== undefined && <line x1={x(at)} x2={x(at)} y1={3} y2={19} className="stroke-foreground" strokeWidth={1.6} />}
      {v.release !== undefined && at !== undefined && <path d={`M${x(at)} 4 Q ${(x(at) + x(v.release)) / 2} -2 ${x(v.release)} 4`} fill="none" stroke="var(--color-violet-500)" strokeWidth={1.2} />}
      <text x={4} y={26} fontSize={9} className="fill-muted-foreground">GND</text>
      <text x={W - 4} y={26} fontSize={9} textAnchor="end" className="fill-muted-foreground">VCC</text>
    </svg>
  )
}

/** Decades of a log quantity, with the anchors a student knows. */
const DECADES: Partial<Record<Quantity, [number, number, [number, string][]]>> = {
  time: [-9, 0, [[-9, "ns"], [-6, "µs"], [-3, "ms"], [0, "s"]]],
  frequency: [0, 9, [[0, "Hz"], [3, "kHz"], [6, "MHz"], [9, "GHz"]]],
  current: [-9, 0, [[-9, "nA"], [-6, "µA"], [-3, "mA"], [0, "A"]]],
  slewRate: [5, 9, [[6, "1"], [8, "100"]]],
  capacitance: [-12, -3, [[-12, "pF"], [-9, "nF"], [-6, "µF"]]],
  memory: [1, 7, [[2, "100 B"], [3, "1 KB"], [6, "1 MB"]]],
}

/** A decade ruler with a pointer at the value. */
function LogRuler({ c, w: W }: { c: Characteristic; w: number }) {
  const q = KINDS[c.kind].quantity
  const [a, b, anchors] = DECADES[q] ?? [-9, 9, []]
  const v = c.value!
  const n = num(v.typ, 0) ?? num(v.max, 0) ?? num(v.min, 0)!
  const x = (e: number) => 4 + ((Math.min(b, Math.max(a, e)) - a) / (b - a)) * (W - 8)
  const at = x(Math.log10(Math.abs(n)))
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <line x1={x(a)} x2={x(b)} y1={10} y2={10} className="stroke-muted-foreground/50" />
      {Array.from({ length: b - a + 1 }, (_, i) => a + i).map((e) => <line key={e} x1={x(e)} x2={x(e)} y1={(e - a) % 3 ? 8 : 6} y2={(e - a) % 3 ? 12 : 14} className="stroke-muted-foreground/50" />)}
      {anchors.map(([e, t]) => <text key={e} x={x(e)} y={26} fontSize={9} textAnchor={e === a ? "start" : e === b ? "end" : "middle"} className="fill-muted-foreground">{t}</text>)}
      <path d={`M${at - 3.5} 1 h7 l-3.5 4z`} className="fill-foreground" />
      <line x1={at} x2={at} y1={4} y2={15} className="stroke-foreground" strokeWidth={1.8} strokeDasharray={v.approx ? "2 1.5" : undefined} />
    </svg>
  )
}

/** A sound level against what a student has heard. */
function LevelMeter({ c, w: W }: { c: Characteristic; w: number }) {
  const v = c.value!
  const lo = 20
  const hi = 130
  const x = (d: number) => 4 + ((d - lo) / (hi - lo)) * (W - 8)
  const typ = num(v.typ, 0) ?? num(v.min, 0)!
  const min = num(v.min, 0)
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <rect x={4} y={7} width={W - 8} height={6} rx={3} className="fill-muted" />
      <rect x={4} y={7} width={x(typ) - 4} height={6} rx={3} fill="var(--color-amber-500)" />
      {min !== undefined && <line x1={x(min)} x2={x(min)} y1={4} y2={16} className="stroke-foreground" strokeWidth={1.4} />}
      {([[30, "whisper"], [60, "talk"], [85, "alarm"], [120, "pain"]] as const).map(([d, t]) => <text key={d} x={x(d)} y={26} fontSize={9} textAnchor="middle" className="fill-muted-foreground">{t}</text>)}
    </svg>
  )
}

/** A wavelength as its colour (CIE-ish, enough to tell red from amber from green). */
function wavelengthColour(nm: number) {
  const stops: [number, string][] = [[450, "#4f46e5"], [470, "#2563eb"], [500, "#06b6d4"], [525, "#16a34a"], [570, "#eab308"], [590, "#f59e0b"], [610, "#f97316"], [630, "#ef4444"], [660, "#b91c1c"]]
  return (stops.find(([w]) => nm <= w) ?? stops[stops.length - 1])[1]
}

const COLOURS: Record<Colour, string> = { red: "#ef4444", green: "#16a34a", blue: "#2563eb", white: "#e5e7eb", yellow: "#eab308" }

function Swatch({ c }: { c: Characteristic }) {
  const nm = (num(c.value?.typ, 0) ?? num(c.value?.min, 0) ?? 0) * 1e9
  return <span className="inline-block h-3.5 w-8 rounded-[4px] border" style={{ background: wavelengthColour(nm) }} aria-hidden />
}

function Visual({ cs, w }: { cs: Characteristic[]; w: number }) {
  const c = cs[0]
  const visual = KINDS[c.kind].visual
  if (visual === "tokens") return <span />
  if (visual === "swatch") return <Swatch c={c} />
  if (!c.value && visual !== "range") return <span />
  if (visual === "range") return <RangeBar cs={cs} w={w} />
  if (visual === "rail") return <RailBar c={c} w={w} />
  if (visual === "log") return <LogRuler c={c} w={w} />
  return <LevelMeter c={c} w={w} />
}

function Page({ record, c }: { record: Datasheet; c: Characteristic }) {
  const cite = c.cite
  if (!cite.page && !cite.at) return null
  const doc = citedDoc(record, cite)
  return (
    <a href={docUrl(doc, cite.page)} target="_blank" rel="noopener noreferrer" title={`${doc.id}, ${citeLabel(cite)}`} className="text-[10.5px] text-muted-foreground/70 tabular-nums hover:text-primary hover:underline">
      {cite.page ? `p. ${cite.page}` : citeLabel(cite)}
    </a>
  )
}

/** What the row's number is per, as a chip: "×pin". */
const PER: Record<NonNullable<Characteristic["per"]>, string> = { pin: "×pin", amp: "×amp", segment: "×seg", package: "×pkg", channel: "×ch" }

/** Measures the row's width, so the visual spans it. */
function useWidth() {
  const ref = React.useRef<HTMLDivElement>(null)
  const [w, setW] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const seen = new ResizeObserver(() => setW(el.clientWidth))
    seen.observe(el)
    return () => seen.disconnect()
  }, [])
  return [ref, w] as const
}

/** One characteristic: glyph, label, its conditions as chips and the number on a line; its visual and page under them. */
function Row({ record, cs }: { record: Datasheet; cs: Characteristic[] }) {
  const c = cs[0]
  const k = KINDS[c.kind]
  const chips = [...(c.at ?? []).map(formatCondition), ...(c.per ? [PER[c.per]] : [])]
  const text = formatCharacteristic(c)
  const [value, limit] = text.split(" ⚠ ")
  const [frame, w] = useWidth()
  return (
    <li className="py-1">
      <div className="flex items-baseline gap-2">
        <span className="self-center">
          <GlyphIcon glyph={k.glyph} />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden">
          <span className="shrink-0 text-[11.5px] text-muted-foreground">{k.label}</span>
          {chips.map((t) => (
            <span key={t} className="shrink-0 rounded-[3px] bg-muted px-1 font-mono text-[9.5px] leading-[14px] text-muted-foreground">
              {t}
            </span>
          ))}
        </span>
        {cs.length === 1 && (
          <span className={cn("text-right text-[12.5px] font-medium tabular-nums", c.set ? "min-w-0 font-mono text-[11.5px]" : "whitespace-nowrap")}>
            {value || <span className="text-red-600">⚠ {limit}</span>}
          </span>
        )}
      </div>
      {cs.length === 1 ? (
        <div className="flex items-end gap-2 pl-[22px]">
          <div ref={frame} className="min-w-0 flex-1">
            {w > 0 && <Visual cs={cs} w={w} />}
          </div>
          <Page record={record} c={c} />
        </div>
      ) : (
        // One lane per colour on a shared scale, each with its own number.
        <div className="pl-[22px]">
          {cs.map((g, i) => {
            const [v, lim] = formatCharacteristic(g).split(" ⚠ ")
            return (
              <div key={i} className="flex items-center gap-2">
                <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: g.colour ? COLOURS[g.colour] : undefined }} />
                <div ref={i === 0 ? frame : undefined} className="min-w-0 flex-1">
                  {w > 0 && <RangeBar cs={cs} w={w} show={i} />}
                </div>
                <span className="w-[52px] shrink-0 text-right text-[12px] font-medium tabular-nums">{v || <span className="text-red-600">⚠ {lim}</span>}</span>
              </div>
            )
          })}
          <div className="text-right">
            <Page record={record} c={c} />
          </div>
        </div>
      )}
    </li>
  )
}

/** One kind given per colour (an RGB LED's red, green, blue) under the same conditions: one row, one scale. */
function groups(rows: readonly Characteristic[]): Characteristic[][] {
  const out: Characteristic[][] = []
  for (const c of rows) {
    const last = out[out.length - 1]
    const same = last && c.colour && last[0].colour && last[0].kind === c.kind && KINDS[c.kind].visual === "range" && JSON.stringify(last[0].at ?? []) === JSON.stringify(c.at ?? [])
    if (same) last.push(c)
    else out.push([c])
  }
  return out
}

/** The part's characteristics, one row each (colours of one kind together), in the record's order. */
export function CharacteristicList({ record, limit, className }: { record: Datasheet; limit?: number; className?: string }) {
  const rows = groups(record.characteristics ?? [])
  if (!rows.length) return null
  return (
    <ul className={cn("flex flex-col", className)}>
      {(limit ? rows.slice(0, limit) : rows).map((cs, i) => (
        <Row key={`${cs[0].kind}${i}`} record={record} cs={cs} />
      ))}
    </ul>
  )
}
