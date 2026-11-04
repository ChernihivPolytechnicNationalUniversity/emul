import * as React from "react"
import { ExternalLinkIcon } from "lucide-react"
import { cn } from "cn"
import { citedDoc, citeLabel, docUrl, DOCS, hasDatasheet } from "@/schematic/datasheets"
import { GRID, objectRect } from "@/schematic/geometry"
import type { Claim, ComponentDef, Datasheet, NoDatasheet, PlacedObject } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import { FieldCanvas } from "@/components/field/FieldCanvas"
import { SymbolRaster } from "@/components/field/symbol-raster"

// What a part is, as the hover card and the inspector's Part tab show it: the symbol as the field
// draws it, the numbers with their datasheet page, what is modelled and what is not, the documents.

const previewRaster = new SymbolRaster()
const NO_ROUTES: never[] = []
const wireColor = (): WireColorKey => "black"

/** The part's own symbol, drawn by the field's painter and fitted into a square. */
export function SymbolPreview({ def, size, className }: { def: ComponentDef; size: number; className?: string }) {
  const object = React.useMemo<PlacedObject>(() => ({ id: "preview", def: def.id, x: 0, y: 0, props: { ...def.defaults } }), [def])
  const box = objectRect(object, GRID)
  const view = { x: box.x - GRID, y: box.y - GRID, w: box.w + 2 * GRID, h: box.h + 2 * GRID }
  const scale = Math.min(size / view.w, size / view.h)
  return (
    <div className={cn("relative shrink-0 overflow-hidden rounded-[10px] border bg-muted/40", className)} style={{ width: size, height: size }} aria-hidden>
      <div className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${(size - view.w * scale) / 2}px, ${(size - view.h * scale) / 2}px) scale(${scale}) translate(${-view.x}px, ${-view.y}px)` }}>
        <FieldCanvas objects={[object]} routes={NO_ROUTES} view={view} grid={GRID} scale={scale} colorOf={wireColor} raster={previewRaster} />
      </div>
    </div>
  )
}

/** A link into a document at the cited page; plain grey text when the record names no page. */
function CiteLink({ record, cite }: { record: Datasheet; cite: Claim["cite"] }) {
  const label = citeLabel(cite)
  if (!label) return null
  const doc = citedDoc(record, cite)
  const className = "text-[11px] whitespace-nowrap text-muted-foreground/70 tabular-nums"
  return doc ? (
    <a href={docUrl(doc, cite?.page)} target="_blank" rel="noopener noreferrer" className={cn(className, "hover:text-primary hover:underline")} title={`${doc.id}${doc.rev ? ` rev ${doc.rev}` : ""}, ${label}`}>
      {label}
    </a>
  ) : (
    <span className={className}>{label}</span>
  )
}

/** The key numbers: name, value, page. */
export function SpecList({ record, limit, className }: { record: Datasheet; limit?: number; className?: string }) {
  const specs = limit ? record.specs.slice(0, limit) : record.specs
  if (!specs.length) return null
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
      <ul className="mt-1 space-y-0.5 text-[12.5px] leading-normal">
        {claims.map((c) => (
          <li key={c.what}>
            {c.what} {hasDatasheet(record) && <CiteLink record={record} cite={c.cite} />}
            {c.test && <span className="ml-1 font-mono text-[10.5px] text-muted-foreground/70">{c.test}</span>}
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

/** The documents: each to the maker's copy, its archived copy beside it, and when the link was checked. */
export function DocLinks({ record }: { record: Datasheet }) {
  const docs = record.docs.map((k) => DOCS[k]).filter((d) => d !== undefined)
  const checked = docs.map((d) => d.checked).sort()[0]
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t pt-2.5 text-[12.5px]">
      {docs.map((d) => (
        <React.Fragment key={d.id}>
          <a href={d.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
            {d.id}
            {d.rev && ` rev ${d.rev}`}
            <ExternalLinkIcon className="size-3" />
          </a>
          {d.archive && (
            <a href={d.archive} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline" title={`Archived copy of ${d.id}`}>
              archive
              <ExternalLinkIcon className="size-3" />
            </a>
          )}
        </React.Fragment>
      ))}
      {checked && <span className="ml-auto text-[11.5px] text-muted-foreground">checked {checked}</span>}
    </div>
  )
}

/**
 * A chip's package pins as its datasheet draws a DIP: 1 at the top left, counting down the left
 * and back up the right. From the part's own pins, so it cannot disagree with the model. Only a
 * package with every pin numbered 1…n and few enough to read (a board's headers are not a package).
 */
export function Pinout({ def }: { def: ComponentDef }) {
  const numbered = def.pins.filter((p) => p.connectorPin !== undefined && !p.connector)
  const n = numbered.length
  const byNumber = new Map(numbered.map((p) => [p.connectorPin!, p]))
  if (n < 3 || n > 28 || n % 2 !== 0 || byNumber.size !== n || ![...byNumber.keys()].every((k) => k >= 1 && k <= n)) return null
  const half = n / 2
  const name = (k: number) => byNumber.get(k)!.label || byNumber.get(k)!.id
  return (
    <figure className="w-fit shrink-0 rounded-[10px] border px-2 py-2.5">
      <div className="rounded-sm border-[1.4px] border-foreground/85 px-1.5 py-1 font-mono text-[11px] leading-5">
        {Array.from({ length: half }, (_, i) => (
          <div key={i} className="flex justify-between gap-4">
            <span>
              {i + 1} {name(i + 1)}
            </span>
            <span>
              {name(n - i)} {n - i}
            </span>
          </div>
        ))}
      </div>
      <figcaption className="mt-1.5 text-center text-[11px] text-muted-foreground">pinout</figcaption>
    </figure>
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
