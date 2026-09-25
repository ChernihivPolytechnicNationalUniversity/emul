import * as React from "react"
import { toast } from "sonner"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BoardView, DebugController } from "@/debug/session"
import { addressOf, scalarOf } from "@/debug/values"
import { symbolize } from "@/debug/disasm"
import { cn } from "@/lib/utils"

const ROWS = 32
const hex = (v: number, w = 8) => (v >>> 0).toString(16).padStart(w, "0")

/**
 * Memory as a hex dump: an address or an expression (a pointer, a variable, a peripheral) to
 * start from, bytes grouped by 1, 2 or 4, the text beside them. Bytes that changed since the
 * stop before are marked; unmapped ones read `??`. A double-click on a group edits it in hex,
 * stored little-endian as the core would store it.
 */
export function MemoryView({ debug, boardId, view, at }: { debug: DebugController; boardId: string; view: BoardView; at: { addr: number; seq: number } | null }) {
  const [addr, setAddr] = React.useState(0x20000000)
  const [text, setText] = React.useState("0x20000000")
  const [group, setGroup] = React.useState<1 | 2 | 4>(1)
  const [error, setError] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState<{ addr: number; text: string; busy?: boolean } | null>(null)
  // "Show in memory" from elsewhere: a new request moves the view there.
  const [seen, setSeen] = React.useState(at)
  if (at !== seen) {
    setSeen(at)
    if (at) {
      setAddr(at.addr & ~0xf)
      setText(`0x${hex(at.addr)}`)
    }
  }

  const go = () => {
    const t = text.trim()
    if (/^(0x)?[0-9a-f]+$/i.test(t)) {
      setAddr(parseInt(t.replace(/^0x/i, ""), 16) & ~0xf)
      setError(null)
      return
    }
    const r = debug.evaluate(boardId, t)
    if (!r.value) {
      setError(r.shown.text)
      return
    }
    const env = debug.env(boardId)
    // A pointer goes where it points; anything else in memory, to where it is.
    let a = addressOf(r.value)
    try {
      const s = env ? scalarOf(env, r.value) : null
      if (s?.kind === "pointer") a = s.value
      else if (s?.kind === "int" && a === null) a = Number(BigInt.asUintN(32, s.value))
    } catch {
      // A struct or an array: its own address.
    }
    if (a === null) {
      setError("not in memory")
      return
    }
    setAddr(a & ~0xf)
    setError(null)
  }

  const commit = async (at: number, text: string) => {
    const digits = text.trim().replace(/^0x/i, "")
    if (!digits) return setEditing(null)
    if (!/^[0-9a-f]+$/i.test(digits) || BigInt(`0x${digits}`) >> BigInt(group * 8) !== 0n) {
      toast.error(`Cannot store at 0x${hex(at)}`, { description: `${group === 1 ? "a byte" : group === 2 ? "a halfword" : "a word"} is ${group * 2} hex digits` })
      return
    }
    let v = BigInt(`0x${digits}`)
    const bytes = new Uint8Array(group)
    for (let i = 0; i < group; i++, v >>= 8n) bytes[i] = Number(v & 0xffn)
    setEditing({ addr: at, text, busy: true })
    const failed = await debug.writeMemory(boardId, at, bytes)
    if (failed) {
      toast.error(`Cannot store at 0x${hex(at)}`, { description: failed })
      setEditing({ addr: at, text })
    } else setEditing(null)
  }

  const rows: React.ReactNode[] = []
  for (let i = 0; i < ROWS; i++) {
    const a = (addr + i * 16) >>> 0
    const b = view.mem ? debug.readMemory(boardId, a, 16) : null
    // The same bytes at the stop before, when they were read then.
    const old = view.prevMem?.bytes(a, 16) ?? null
    const cells: React.ReactNode[] = []
    for (let k = 0; k < 16; k += group) {
      let v = 0
      let changed = false
      for (let j = group - 1; j >= 0; j--) {
        v = v * 256 + (b ? b[k + j] : 0)
        if (b && old && old[k + j] !== b[k + j]) changed = true
      }
      const at = (a + k) >>> 0
      const edit = editing?.addr === at ? editing : null
      cells.push(
        edit ? (
          <input
            key={k}
            autoFocus
            className="h-4 rounded-sm border bg-background px-0.5 font-mono text-[11px] outline-none focus:border-primary"
            style={{ width: `${group * 2 + 1.5}ch` }}
            value={edit.text}
            readOnly={edit.busy}
            spellCheck={false}
            aria-label={`New value at 0x${hex(at)}`}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setEditing({ addr: at, text: e.target.value })}
            onBlur={() => !edit.busy && setEditing(null)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter") void commit(at, edit.text)
              else if (e.key === "Escape") setEditing(null)
            }}
          />
        ) : (
          <span
            key={k}
            className={cn("tabular-nums", changed && "rounded-sm bg-amber-200/60 dark:bg-amber-500/30", !b && "text-muted-foreground", b && "cursor-text")}
            onDoubleClick={b ? () => setEditing({ addr: at, text: hex(v, group * 2) }) : undefined}
          >
            {b ? hex(v, group * 2) : "??".repeat(group)}
          </span>
        ),
      )
    }
    const ascii = b ? [...b].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ".")).join("") : ""
    rows.push(
      <div key={a} className="flex h-5 items-center gap-3 px-2 whitespace-pre">
        <span className="text-muted-foreground">{hex(a)}</span>
        <span className="flex gap-1.5">{cells}</span>
        <span className="text-muted-foreground">{ascii}</span>
      </div>,
    )
  }
  const sym = view.mem ? symbolize(debug.info(boardId)?.symbols ?? [], addr) : ""

  return (
    <div className="flex flex-col font-mono text-[11px]">
      <form
        className="flex h-7 shrink-0 items-center gap-1 px-1"
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
      >
        <input
          className="h-5 w-64 min-w-0 rounded-sm border bg-transparent px-1 outline-none focus:bg-muted"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="0x20000000, &first, buf, GPIOA"
          aria-label="Address or expression"
        />
        <Button type="submit" variant="outline" size="xs">
          Go
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Previous page" onClick={() => setAddr((a) => (a - ROWS * 16) >>> 0)}>
          <ChevronLeftIcon />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Next page" onClick={() => setAddr((a) => (a + ROWS * 16) >>> 0)}>
          <ChevronRightIcon />
        </Button>
        <select className="h-5 rounded-sm border bg-transparent text-[11px]" value={group} onChange={(e) => setGroup(Number(e.target.value) as 1 | 2 | 4)} aria-label="Group bytes">
          <option value={1}>bytes</option>
          <option value={2}>halfwords</option>
          <option value={4}>words</option>
        </select>
        <span className="min-w-0 truncate text-muted-foreground">{error ?? sym}</span>
      </form>
      {view.mem ? rows : <div className="px-3 py-2 font-sans text-xs text-muted-foreground">Pause the bench, or stop at a breakpoint, to read memory.</div>}
    </div>
  )
}
