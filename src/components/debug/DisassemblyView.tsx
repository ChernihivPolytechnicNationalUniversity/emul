import * as React from "react"
import { CrosshairIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BoardView, DebugController } from "@/debug/session"
import { disassemble, rangeAround, type DisasmLine } from "@/debug/disasm"
import { MemorySnapshot } from "@/debug/memory"
import { cn } from "@/lib/utils"

type Props = {
  debug: DebugController
  boardId: string
  view: BoardView
  /** Addresses a breakpoint is on (address breakpoints, and line ones as resolved). */
  breakpoints: ReadonlySet<number>
  onToggleBreakpoint: (addr: number) => void
  sourceLine: (path: string, line: number) => string | null
  onOpenSource: (path: string, line: number) => void
}

const hex = (v: number) => (v >>> 0).toString(16).padStart(8, "0")

/**
 * The instructions around the PC — or around any address or function — as the core's
 * decoder reads them, with the source lines they came from between them. Available whatever
 * the image: with no debug information it is the only view there is. The gutter sets
 * breakpoints on instructions; a branch's target is a link.
 */
export function DisassemblyView({ debug, boardId, view, breakpoints, onToggleBreakpoint, sourceLine, onOpenSource }: Props) {
  const fw = debug.image(boardId)
  const info = debug.info(boardId)
  const pc = view.regs?.r[15] ?? null
  const framePc = view.frames[view.frame]?.pc ?? pc
  const [anchor, setAnchor] = React.useState<number | null>(null)
  const [text, setText] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const scroller = React.useRef<HTMLDivElement>(null)
  // While the core runs, the image's own flash is what there is to read.
  const idleMem = React.useMemo(() => new MemorySnapshot(fw?.segments ?? []), [fw])
  const mem = view.mem ?? idleMem
  const symbols = fw?.symbols ?? []
  const at = anchor ?? framePc ?? fw?.entry ?? symbols.find((s) => s.name === "main")?.value ?? 0x08000000
  const range = rangeAround(symbols, at & ~1)
  // A function's worth of instructions decodes in a millisecond or two: every render reads the memory as it now is.
  const lines: DisasmLine[] = disassemble({ read: (a, n) => mem.bytes(a, n), symbols, mapping: fw?.mapping ?? [], lines: info?.lines ?? null, sourceLine }, range.start, range.end)
  React.useEffect(() => debug.requestMissing(boardId))
  // Follow the PC to its row.
  React.useEffect(() => {
    scroller.current?.querySelector<HTMLElement>("[data-current]")?.scrollIntoView({ block: "center" })
  }, [framePc, range.start])

  const go = () => {
    const t = text.trim()
    if (!t) return setAnchor(null)
    if (/^(0x)?[0-9a-f]+$/i.test(t)) {
      setAnchor(parseInt(t.replace(/^0x/i, ""), 16))
      setError(null)
      return
    }
    const sym = symbols.find((s) => s.name === t && s.type === "func")
    if (sym) {
      setAnchor(sym.value)
      setError(null)
    } else setError(`no function "${t}"`)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col font-mono text-[12px]">
      <form
        className="flex h-7 shrink-0 items-center gap-1 border-b px-1"
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
      >
        <input
          className="h-5 w-56 rounded-sm border bg-transparent px-1 text-[11px] outline-none focus:bg-muted"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Go to a function or an address"
          aria-label="Function or address"
        />
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Follow the PC" title="Follow the PC" onClick={() => setAnchor(null)} disabled={anchor === null}>
          <CrosshairIcon />
        </Button>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{error ?? (range.name ? `${range.name} · 0x${hex(range.start)}–0x${hex(range.end)}` : `0x${hex(range.start)}`)}</span>
      </form>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto py-1">
        {lines.map((l, i) => {
          switch (l.kind) {
            case "label":
              return (
                <div key={i} className="mt-1 px-2 text-sky-700 dark:text-sky-400">
                  {"<"}
                  {l.text}
                  {">:"}
                </div>
              )
            case "source":
              return (
                <button key={i} type="button" className="block w-full truncate px-2 pl-8 text-left text-muted-foreground italic hover:bg-accent/60" onClick={() => onOpenSource(l.path, l.line)} title={l.path}>
                  {l.path.split("/").pop()}:{l.line} {l.text ?? ""}
                </button>
              )
            case "unreadable":
              return (
                <div key={i} className="flex px-2 text-muted-foreground">
                  <span className="w-6" />
                  <span className="w-20">{hex(l.addr)}</span> ??
                </div>
              )
            default: {
              const current = l.addr === pc
              const frameRow = l.addr === framePc && !current
              const bp = breakpoints.has(l.addr)
              return (
                <div key={i} data-current={l.addr === framePc ? "" : undefined} className={cn("group flex h-[18px] items-center whitespace-pre", current && "bg-yellow-200/70 dark:bg-yellow-500/25", frameRow && "bg-emerald-200/50 dark:bg-emerald-500/20")}>
                  <button type="button" className="flex w-6 shrink-0 items-center justify-center" onClick={() => l.kind === "insn" && onToggleBreakpoint(l.addr)} aria-label={bp ? "Remove breakpoint" : "Set breakpoint"}>
                    {bp ? <span className="size-2.5 rounded-full bg-red-600" /> : l.kind === "insn" && <span className="size-2.5 rounded-full bg-red-600/0 group-hover:bg-red-600/30" />}
                  </button>
                  <span className="w-4 shrink-0 text-amber-600">{current ? "▶" : frameRow ? "›" : ""}</span>
                  <span className="w-20 shrink-0 text-muted-foreground">{hex(l.addr)}</span>
                  <span className="w-24 shrink-0 text-muted-foreground/70">{l.bytes}</span>
                  {l.kind === "insn" ? (
                    <>
                      <span className="w-16 shrink-0 text-violet-700 dark:text-violet-300">{l.mnemonic}</span>
                      {l.target !== null ? (
                        <button type="button" className="text-left hover:underline" onClick={() => setAnchor(l.target)}>
                          {l.operands}
                        </button>
                      ) : (
                        <span>{l.operands}</span>
                      )}
                      {l.comment && <span className="ml-3 text-muted-foreground">{l.comment}</span>}
                    </>
                  ) : (
                    <>
                      <span className="text-muted-foreground">{l.text}</span>
                      {l.comment && <span className="ml-3 text-muted-foreground">{l.comment}</span>}
                    </>
                  )}
                </div>
              )
            }
          }
        })}
      </div>
    </div>
  )
}
