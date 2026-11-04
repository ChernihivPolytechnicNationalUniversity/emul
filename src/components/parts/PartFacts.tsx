import * as React from "react"
import { ArchiveIcon, CheckIcon, ExternalLinkIcon, MinusIcon } from "lucide-react"
import { cn } from "cn"
import { citedDoc, citeLabel, docUrl, hasDatasheet, shortRev } from "@/schematic/datasheets"
import { GRID, objectRect } from "@/schematic/geometry"
import type { Claim, ComponentDef, Datasheet, DocKind, DocRecord, NoDatasheet, PlacedObject } from "@/schematic/types"
import { PartDrawing } from "@/components/field/GhostLayer"
import { fieldDetail } from "@/components/field/detail"
import { SimStore } from "@/sim/sim-store"

// What a part is, as the hover card and the inspector's Part tab show it: the symbol as the field
// draws it, the numbers with their datasheet page, what is modelled and what is not, the documents.

/** Nothing runs in a preview: no readings, no glow. */
const idle = new SimStore()

/**
 * The part's own symbol as the field draws it (body, labels, pins), fitted into a box of `size`
 * (or `width` × `height`). With `turn`, a part that fits the box better on its side (a tall board
 * in a wide box) is drawn turned a quarter, as it can be placed. A faint outline keeps a white
 * board's edge visible on a light ground at a small scale, where its own 1-cell line is a hairline.
 */
export function SymbolPreview({ def, size, width = size, height = size, maxHeight, turn, fill, className }: { def: ComponentDef; size?: number; width?: number; height?: number; maxHeight?: number; turn?: boolean; fill?: boolean; className?: string }) {
  const upright = React.useMemo(() => objectRect({ id: "preview", def: def.id, x: 0, y: 0 }, GRID), [def])
  // `fill`: as wide as the place it stands in (the inspector's column), measured.
  const frame = React.useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = frame.current
    if (!fill || !el) return
    const seen = new ResizeObserver(() => setMeasured(el.clientWidth))
    seen.observe(el)
    return () => seen.disconnect()
  }, [fill])
  const w = fill ? measured || (width ?? 96) : (width ?? 96)
  // With `maxHeight` the box grows to the part's own proportions (a tall chip is drawn tall, not shrunk into a square), from `height` up to it.
  const tall = (upright.h + 2 * GRID) / (upright.w + 2 * GRID)
  const h = maxHeight ? Math.round(Math.min(maxHeight, Math.max(height ?? 96, tall * w))) : (height ?? 96)
  const fit = (bw: number, bh: number) => Math.min(w / (bw + 2 * GRID), h / (bh + 2 * GRID))
  const quarter = !!turn && fit(upright.h, upright.w) > fit(upright.w, upright.h) * 1.15
  const object = React.useMemo<PlacedObject>(() => ({ id: "preview", def: def.id, x: 0, y: 0, rotation: quarter ? 90 : 0, props: { ...def.defaults } }), [def, quarter])
  const box = objectRect(object, GRID)
  const view = { x: box.x - GRID, y: box.y - GRID, w: box.w + 2 * GRID, h: box.h + 2 * GRID }
  const scale = Math.min(w / view.w, h / view.h)
  // A preview is never a crowd of parts: always the drawn detail, never the zoomed-out canvas.
  const detail = React.useMemo(() => ({ ...fieldDetail(GRID, scale, 1), canvas: false }), [scale])
  return (
    <div ref={frame} className={cn("relative shrink-0 overflow-hidden rounded-[10px] border bg-muted/40", fill && "w-full", className)} style={{ width: fill ? undefined : w, height: h }} aria-hidden>
      <div
        className="absolute top-0 left-0 origin-top-left drop-shadow-[0_0_0.6px_rgba(0,0,0,.55)] dark:drop-shadow-[0_0_0.6px_rgba(255,255,255,.5)]"
        style={{ transform: `translate(${(w - view.w * scale) / 2}px, ${(h - view.h * scale) / 2}px) scale(${scale}) translate(${-view.x}px, ${-view.y}px)` }}
      >
        <PartDrawing object={object} grid={GRID} detail={detail} sim={idle} />
      </div>
    </div>
  )
}

/** A link into a document at the cited page; plain grey text when the record names no page. */
function CiteLink({ record, cite }: { record: Datasheet; cite: Claim["cite"] }) {
  const full = citeLabel(cite)
  if (!full) return null
  // The page alone in the line; the section or table it is in, in the tip.
  const label = cite?.page ? `p. ${cite.page}` : full
  const doc = citedDoc(record, cite)
  const className = "text-[11px] whitespace-nowrap text-muted-foreground/70 tabular-nums"
  return doc ? (
    <a href={docUrl(doc, cite?.page)} target="_blank" rel="noopener noreferrer" className={cn(className, "hover:text-primary hover:underline")} title={`${doc.id}${doc.rev ? ` rev ${doc.rev}` : ""}, ${full}`}>
      {label}
    </a>
  ) : (
    <span className={className} title={full}>
      {label}
    </span>
  )
}

/**
 * The key numbers: name, value, page. In a row each beside the card's preview; `stacked` in a
 * narrow column (the inspector): the name and its page on one line, the value under them, whole.
 */
export function SpecList({ record, limit, stacked, className }: { record: Datasheet; limit?: number; stacked?: boolean; className?: string }) {
  const specs = limit ? record.specs.slice(0, limit) : record.specs
  if (!specs.length) return null
  if (stacked)
    return (
      <dl className={cn("grid gap-y-2 text-[12.5px]", className)}>
        {specs.map((s) => (
          <div key={s.label}>
            <dt className="flex items-baseline gap-2 text-[11.5px] text-muted-foreground">
              {s.label}
              <span className="ml-auto">
                <CiteLink record={record} cite={s.cite} />
              </span>
            </dt>
            <dd className="leading-snug tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>
    )
  return (
    <dl className={cn("grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 gap-y-1.5 text-[12.5px]", className)}>
      {specs.map((s) => (
        <React.Fragment key={s.label}>
          <dt className="text-muted-foreground">{s.label}</dt>
          <dd className="tabular-nums">{s.value}</dd>
          <dd className="text-right">
            <CiteLink record={record} cite={s.cite} />
          </dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

function Claims({ title, claims, record, tone }: { title: string; claims: Claim[]; record: Datasheet | NoDatasheet; tone: "ok" | "warn" }) {
  if (!claims.length) return null
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold">
        <span className={cn("size-[7px] rounded-full", tone === "ok" ? "bg-green-600" : "bg-amber-600")} />
        {title}
      </p>
      {/* One line each: its mark, the claim, its page in a column of its own, so a wrapped claim never runs into the next. */}
      <ul className="mt-1.5 grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1 text-[12.5px] leading-snug">
        {claims.map((c) => (
          <li key={`${c.part ?? ""}${c.what}`} className="contents">
            {tone === "ok" ? <CheckIcon aria-hidden className="mt-[3px] size-3 text-green-600" /> : <MinusIcon aria-hidden className="mt-[3px] size-3 text-amber-600" />}
            <span>
              {c.part && <span className="mr-1 text-muted-foreground">{c.part}</span>}
              {c.what}
            </span>
            <span className="text-right">{hasDatasheet(record) && <CiteLink record={record} cite={c.cite} />}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** What the model does, with its tests, and what it leaves out, with the page that says so. */
export function ModelClaims({ record }: { record: Datasheet | NoDatasheet }) {
  return (
    <div className="flex flex-col gap-2.5">
      <Claims title="Modelled" claims={record.modelled} record={record} tone="ok" />
      <Claims title={`Not modelled · ${record.notModelled.length}`} claims={record.notModelled} record={record} tone="warn" />
    </div>
  )
}

/** What a document is, as the list labels it, and the colour of its kind. */
const DOC_KINDS: Record<DocKind, [label: string, colour: string]> = {
  datasheet: ["Datasheet", "text-blue-600"],
  catalogue: ["Catalogue", "text-blue-600"],
  referenceManual: ["Ref. manual", "text-teal-600"],
  coreManual: ["Core manual", "text-teal-600"],
  errata: ["Errata", "text-red-600"],
  programmingSpec: ["Prog. spec", "text-teal-600"],
  userManual: ["Manual", "text-orange-600"],
  schematic: ["Schematic", "text-violet-600"],
  pinout: ["Pinout", "text-violet-600"],
  appNote: ["App note", "text-muted-foreground"],
  productPage: ["Product page", "text-muted-foreground"],
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/**
 * The documents, one to a line: what kind it is, its number and short revision, open and archive.
 * When the links were last seen to work sits in the header, a green dot and a month.
 */
export function DocLinks({ docs, label = "Documents" }: { docs: readonly DocRecord[]; label?: string }) {
  const checked = docs.map((d) => d.checked).sort()[0]
  const [year, month] = checked ? checked.split("-").map(Number) : []
  const icon = "inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
  return (
    <div className="border-t pt-2.5 text-[12.5px]">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
        {checked && (
          <span className="ml-auto flex items-center gap-1 text-[11px] whitespace-nowrap text-green-700 dark:text-green-500" title={`Links checked ${checked}`}>
            <span className="size-1.5 rounded-full bg-green-600" />
            links ok · {MONTHS[month - 1]} {year}
          </span>
        )}
      </div>
      <ul className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5">
        {docs.map((d) => {
          const [kind, colour] = DOC_KINDS[d.kind]
          const rev = shortRev(d.rev)
          return (
            <li key={d.key} className="contents">
              <span className={cn("text-[11px] whitespace-nowrap", colour)}>{kind}</span>
              <a href={d.url} target="_blank" rel="noopener noreferrer" className="truncate py-0.5 hover:underline" title={[d.maker, d.title, d.rev && `rev ${d.rev}`, d.note].filter(Boolean).join(" · ")}>
                <span className="font-medium">{d.id}</span>
                <span className="ml-1.5 text-[11px] text-muted-foreground tabular-nums">{rev || "—"}</span>
              </a>
              <span className="flex gap-0.5">
                <a href={d.url} target="_blank" rel="noopener noreferrer" className={icon} title={`Open ${d.id}`} aria-label={`Open ${d.id}`}>
                  <ExternalLinkIcon className="size-3" />
                </a>
                {d.archive ? (
                  <a href={d.archive} target="_blank" rel="noopener noreferrer" className={icon} title={`Archived copy of ${d.id}`} aria-label={`Archived copy of ${d.id}`}>
                    <ArchiveIcon className="size-3" />
                  </a>
                ) : (
                  <span className="size-5" />
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** The part's reference notes (`info`): what a board carries, where its LEDs and buttons sit. */
export function Details({ info, skip }: { info: Record<string, string>; skip?: ReadonlySet<string> }) {
  const rows = Object.entries(info).filter(([k]) => !skip?.has(k))
  if (!rows.length) return null
  return (
    <dl className="grid gap-1.5 text-[12.5px]">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className="text-[11.5px] font-medium text-muted-foreground">{k}</dt>
          <dd className="leading-normal">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
