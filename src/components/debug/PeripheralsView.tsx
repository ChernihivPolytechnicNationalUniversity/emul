import * as React from "react"
import { ChevronRightIcon } from "lucide-react"
import type { BoardView, DebugController } from "@/debug/session"
import { loadPeripheralMap, type PeripheralMap } from "@/debug/peripherals"
import { cn } from "@/lib/utils"

type Block = { name: string; base: number; group: string; registers: { name: string; offset: number; size: number; access?: string; fields?: { name: string; pos: number; width: number }[] }[] }

const hex = (v: number, w = 8) => (v >>> 0).toString(16).padStart(w, "0")

/**
 * The MCU's peripheral registers by block, as CubeIDE's SFR view shows them: GPIOA → MODER,
 * ODR…, each with its bit-fields. The map is ST's device header (generated at site build
 * time); without it, the registers the emulator models. Values are read without side effects:
 * looking at USART DR does not take the byte.
 */
export function PeripheralsView({ debug, boardId, chip, view }: { debug: DebugController; boardId: string; chip: string; view: BoardView }) {
  const [map, setMap] = React.useState<PeripheralMap | null | "none">(null)
  const [modelled, setModelled] = React.useState<Block[] | null>(null)
  const [filter, setFilter] = React.useState("")
  const [open, setOpen] = React.useState<Set<string>>(() => new Set())
  React.useEffect(() => {
    let live = true
    loadPeripheralMap(chip).then((m) => live && setMap(m ?? "none"))
    return () => {
      live = false
    }
  }, [chip])
  React.useEffect(() => {
    if (map !== "none" || modelled || !view.regs) return
    void debug.modelledBlocks(boardId).then((b) => setModelled(b.map((x) => ({ name: x.name, base: x.base, group: x.name.replace(/\d+$/, ""), registers: x.registers.map((r) => ({ ...r, size: 4 })) }))))
  }, [map, modelled, view.regs, debug, boardId])

  const blocks: Block[] = map && map !== "none" ? map.peripherals.map((p) => ({ name: p.name, base: p.base, group: p.group, registers: map.types[p.type]?.registers ?? [] })) : (modelled ?? [])
  const shown = filter ? blocks.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()) || b.registers.some((r) => `${b.name}->${r.name}`.toLowerCase().includes(filter.toLowerCase()))) : blocks
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  if (!view.regs) return <div className="px-3 py-2 text-xs text-muted-foreground">Pause the bench, or stop at a breakpoint, to read the registers.</div>
  return (
    <div className="flex flex-col font-mono text-[11px]">
      <div className="flex h-7 shrink-0 items-center gap-2 px-1">
        <input
          className="h-5 w-56 rounded-sm border bg-transparent px-1 outline-none focus:bg-muted"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Filter: GPIOB, TIM7, ODR…"
          aria-label="Filter peripherals"
        />
        <span className="font-sans text-muted-foreground">{map === "none" ? "Registers the emulator models (no device map on this site)" : map ? `${map.peripherals.length} blocks from ${map.source}` : "loading…"}</span>
      </div>
      {shown.map((b) => {
        const isOpen = open.has(b.name) || (!!filter && shown.length <= 3)
        return (
          <div key={b.name}>
            <button type="button" className="flex h-5 w-full items-center gap-1 px-1 text-left hover:bg-accent/60" onClick={() => toggle(b.name)}>
              <ChevronRightIcon className={cn("size-3 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
              <span className="text-violet-700 dark:text-violet-300">{b.name}</span>
              <span className="text-muted-foreground">0x{hex(b.base)}</span>
            </button>
            {isOpen &&
              b.registers.map((r) => {
                const bytes = debug.readMemory(boardId, b.base + r.offset, Math.max(1, r.size))
                let v: number | null = null
                if (bytes) {
                  v = 0
                  for (let i = bytes.length - 1; i >= 0; i--) v = v * 256 + bytes[i]
                }
                const key = `${b.name}.${r.name}`
                const fieldsOpen = open.has(key)
                return (
                  <div key={key}>
                    <button type="button" className="flex h-5 w-full items-center gap-2 pr-2 pl-6 text-left hover:bg-accent/60" onClick={() => r.fields?.length && toggle(key)}>
                      <span className={cn("w-3 text-muted-foreground", !r.fields?.length && "invisible")}>{fieldsOpen ? "▾" : "▸"}</span>
                      <span className="w-28 shrink-0 truncate">{r.name}</span>
                      <span className="w-12 shrink-0 text-muted-foreground">+0x{r.offset.toString(16)}</span>
                      <span className={cn("tabular-nums", v === null && "text-muted-foreground")}>{v === null ? "…" : `0x${hex(v, r.size * 2)}`}</span>
                      {r.access && r.access !== "rw" && <span className="text-muted-foreground">{r.access === "r" ? "read-only" : "write-only"}</span>}
                    </button>
                    {fieldsOpen &&
                      v !== null &&
                      r.fields!.map((f) => {
                        const fv = Math.floor(v! / 2 ** f.pos) % 2 ** f.width
                        return (
                          <div key={f.name} className="flex h-5 items-center gap-2 pr-2 pl-14">
                            <span className="w-28 shrink-0 truncate text-muted-foreground">{f.name}</span>
                            <span className="w-16 shrink-0 text-muted-foreground">{f.width === 1 ? `[${f.pos}]` : `[${f.pos + f.width - 1}:${f.pos}]`}</span>
                            <span className="tabular-nums">{f.width === 1 ? fv : `0x${fv.toString(16)} (${fv})`}</span>
                          </div>
                        )
                      })}
                  </div>
                )
              })}
          </div>
        )
      })}
    </div>
  )
}
