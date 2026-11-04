import * as React from "react"
import { createPortal } from "react-dom"
import { ExternalLinkIcon } from "lucide-react"
import { docUrl, hasDatasheet } from "@/schematic/datasheets"
import { familyOf, variantLabel } from "@/schematic/families"
import { ensureDefs, getDef, getDefsVersion, getMeta, subscribeDefs, type PartMeta } from "@/schematic/registry"
import type { BoardCard, ComponentDef } from "@/schematic/types"
import { usePaletteActions } from "./palette-actions"
import { SpecList, SymbolPreview } from "@/components/parts/PartFacts"
import { Skeleton } from "@/components/ui/skeleton"
import { FavouriteButton } from "./FavouriteButton"
import { HOLD_MS, hideCard, holdCard, keepCard, leavePart, releaseCard, useCardAnchor } from "./part-card"

const WIDTH = 360
/** A board's card is wide: its photo and its drawing on the bench side by side, its facts in two columns. */
const BOARD_WIDTH = 560
/** The bench drawing's width: half the board card's inner width, beside the photo. */
const BENCH_W = (BOARD_WIDTH - 2 * 16 - 12) / 2
const GAP = 8
const MARGIN = 8
/** Variant chips the card shows before "+N". */
const CHIPS = 3

/** The hover card beside the palette: what the part is, its key numbers, its datasheet. */
export function PartCard() {
  const anchor = useCardAnchor()
  // A new part, a new card: its line starts again from the top.
  return anchor ? <CardBody key={anchor.id} /> : null
}

/**
 * A faint line that runs once round the card's edge; when it closes the card is held, and the
 * pointer may cross other parts on the way to it. The wait shown, not announced.
 */
function HoldLine() {
  const line = React.useRef<SVGRectElement>(null)
  React.useEffect(() => {
    const el = line.current
    if (!el) return
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = setTimeout(holdCard, HOLD_MS)
      return () => clearTimeout(t)
    }
    const run = el.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: HOLD_MS, easing: "linear", fill: "forwards" })
    run.onfinish = holdCard
    return () => run.cancel()
  }, [])
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible text-muted-foreground/45">
      <rect ref={line} width="100%" height="100%" rx={12} fill="none" stroke="currentColor" strokeWidth={1} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} />
    </svg>
  )
}

/** The hover card beside the palette: what the part is, its key numbers, what is modelled, its datasheet. */
function CardBody() {
  const anchor = useCardAnchor()
  const version = React.useSyncExternalStore(subscribeDefs, getDefsVersion)
  const card = React.useRef<HTMLDivElement>(null)
  const [height, setHeight] = React.useState(0)

  React.useLayoutEffect(() => {
    if (card.current) setHeight(card.current.offsetHeight)
  }, [anchor, version])

  React.useEffect(() => {
    if (!anchor) return
    // Scrolling the palette or pressing anywhere else puts the card away: it would stand beside the
    // wrong row. A press on the card itself (its datasheet link, its star) is the card being used.
    const outside = (e: Event) => {
      if (!(e.target instanceof Node && card.current?.contains(e.target))) hideCard()
    }
    // A held card stays while the pointer crosses the palette towards it; out of both, it goes.
    const away = (e: PointerEvent) => {
      if (!anchor.held || !(e.target instanceof Element)) return
      if (!card.current?.contains(e.target) && !e.target.closest('[data-slot="sidebar"]')) releaseCard()
    }
    window.addEventListener("pointermove", away)
    window.addEventListener("wheel", outside, { passive: true })
    window.addEventListener("pointerdown", outside)
    window.addEventListener("keydown", hideCard)
    return () => {
      window.removeEventListener("pointermove", away)
      window.removeEventListener("wheel", outside)
      window.removeEventListener("pointerdown", outside)
      window.removeEventListener("keydown", hideCard)
    }
  }, [anchor])

  if (!anchor) return null
  const meta = getMeta(anchor.id)
  if (!meta) return null
  void version
  const def = getDef(anchor.id)
  const record = def?.datasheet
  const sheet = hasDatasheet(record) ? record : undefined
  const family = familyOf(anchor.id)
  const doc = sheet?.docs[0]

  // Beside the palette, level with the row; kept on screen, flipped up from the row's bottom near the foot.
  const room = window.innerHeight - MARGIN
  const top = Math.max(MARGIN, anchor.top + height > room ? anchor.bottom - height : anchor.top)
  const width = meta.board ? BOARD_WIDTH : WIDTH
  const left = Math.min(anchor.right + GAP, window.innerWidth - width - MARGIN)
  const subtitle = def ? [sheet?.package, `${def.pins.length} pins`, def.prefix].filter(Boolean).join(" · ") : null
  const others = family ? family.variants.filter(([id]) => id !== anchor.id) : []

  return createPortal(
    <div
      ref={card}
      data-slot="part-card"
      role="tooltip"
      onPointerEnter={keepCard}
      onPointerLeave={() => (anchor.held ? releaseCard() : leavePart())}
      className="fixed z-50 isolate flex flex-col gap-3 rounded-xl border bg-popover px-4 py-3.5 text-[13px] text-popover-foreground shadow-[0_16px_44px_rgba(0,0,0,.16)] animate-in fade-in-0 zoom-in-95 duration-100 motion-reduce:animate-none"
      style={{ top, left, width }}
    >
      <HoldLine />
      {meta.board ? (
        <BoardContent meta={meta} board={meta.board} def={def} />
      ) : (
      <>
      <div className="flex gap-3.5">
        {def ? (
          <SymbolPreview def={def} size={96} />
        ) : (
          <Skeleton className="size-24 shrink-0 rounded-[10px]" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="text-[17px] leading-tight font-semibold">{meta.name}</span>
            <FavouriteButton def={meta} className="ml-auto shrink-0" />
          </div>
          <p className="mt-0.5 text-muted-foreground">{subtitle ?? <Skeleton className="h-4 w-32" />}</p>
          {family && (
            <div className="mt-2 flex flex-wrap gap-1">
              <span className="inline-flex h-6 items-center rounded-full border border-foreground bg-foreground px-2.5 text-xs text-background">{variantLabel(anchor.id)}</span>
              {others.slice(0, CHIPS - 1).map(([id, label]) => (
                <span key={id} className="inline-flex h-6 items-center rounded-full border bg-background px-2.5 text-xs">
                  {label}
                </span>
              ))}
              {others.length > CHIPS - 1 && <span className="inline-flex h-6 items-center rounded-full border bg-background px-2.5 text-xs">+{others.length - (CHIPS - 1)}</span>}
            </div>
          )}
        </div>
      </div>
      {sheet ? <SpecList record={sheet} limit={2} /> : meta.description && <p className="line-clamp-3 text-[12.5px] text-muted-foreground">{meta.description}</p>}
      <div className="flex items-center border-t pt-2.5">
        {doc ? (
          <a href={docUrl(doc)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
            Datasheet
            <ExternalLinkIcon className="size-3.5" />
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">{record && "none" in record ? "No datasheet: not one product" : def ? "Datasheet record to come" : "Loading…"}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          click to arm ·{" "}
          <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-b-2 bg-background px-1 font-mono text-[10px] leading-none">↵</kbd>
        </span>
      </div>
      </>
      )}
    </div>,
    document.body,
  )
}

const LABEL = "text-[11px] font-medium tracking-wide text-muted-foreground uppercase"

/**
 * A board's card, as students pick a board: the real thing and how it stands on the bench, the
 * MCU and what else it carries, its manual and its chip's datasheet, and the chip on its own.
 */
function BoardContent({ meta, board, def }: { meta: PartMeta; board: BoardCard; def: ComponentDef | undefined }) {
  const { activate } = usePaletteActions()
  // The bare chip of the board's MCU, when the palette has it: its datasheet is the board's too.
  const chipId = board.mcu.toLowerCase()
  const chip = getMeta(chipId)
  React.useEffect(() => {
    if (chip) void ensureDefs([chipId])?.catch(() => {})
  }, [chip, chipId])
  const chipSheet = getDef(chipId)?.datasheet
  const chipDoc = hasDatasheet(chipSheet) ? chipSheet.docs[0] : undefined
  const sheet = hasDatasheet(def?.datasheet) ? def.datasheet : undefined
  const manual = sheet?.docs[0]
  const facts: [string, string | undefined][] = [
    ["MCU", `${board.mcu} · ${board.core}`],
    ["Clock", `${board.mhz} MHz`],
    ["Flash / RAM", board.memory],
    ["Logic", `${board.volts} V`],
    ["On board", board.onBoard.join(" · ")],
    ["Printed", board.printed],
  ]
  const link = "inline-flex items-center gap-1 font-medium text-primary hover:underline"
  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className="text-[17px] leading-tight font-semibold">{meta.name}</span>
        <span className="truncate text-muted-foreground">{[board.alias, board.vendor].filter(Boolean).join(" · ")}</span>
        <FavouriteButton def={meta} className="ml-auto shrink-0 self-center" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <figure>
          <figcaption className={LABEL}>Photo</figcaption>
          <img src={`${import.meta.env.BASE_URL}boards/${board.photo}`} alt="" className="mt-1 h-40 w-full rounded-[10px] border bg-muted/40 object-contain" />
        </figure>
        <figure>
          <figcaption className={LABEL}>On the bench</figcaption>
          {def ? <SymbolPreview def={def} width={BENCH_W} height={160} turn className="mt-1" /> : <Skeleton className="mt-1 h-40 w-full rounded-[10px]" />}
        </figure>
      </div>
      <dl className="grid grid-cols-[auto_1fr_auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-[12.5px]">
        {facts.flatMap(([k, v]) =>
          v
            ? [
                <dt key={`${k}:k`} className="text-muted-foreground">
                  {k}
                </dt>,
                <dd key={`${k}:v`} className="min-w-0">
                  {v}
                </dd>,
              ]
            : [],
        )}
      </dl>
      {board.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {board.tags.map((t) => (
            <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-semibold">
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-4 border-t pt-2.5">
        {manual && (
          <a href={docUrl(manual)} target="_blank" rel="noopener noreferrer" className={link} title={[manual.maker, manual.title].join(" · ")}>
            {manual.id}
            <ExternalLinkIcon className="size-3.5" />
          </a>
        )}
        {chipDoc && (
          <a href={docUrl(chipDoc)} target="_blank" rel="noopener noreferrer" className={link} title={[chipDoc.maker, chipDoc.title].join(" · ")}>
            Datasheet
            <ExternalLinkIcon className="size-3.5" />
          </a>
        )}
        {chip && (
          <button
            type="button"
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              hideCard()
              activate(chip, e)
            }}
          >
            Chip on its own: {chip.name} →
          </button>
        )}
      </div>
    </>
  )
}
