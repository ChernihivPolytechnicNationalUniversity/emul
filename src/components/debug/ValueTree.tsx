import * as React from "react"
import { toast } from "sonner"
import { ChevronRightIcon, PencilIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { strip, typeName } from "@/debug/types"
import { children, show, type Env, type Radix, type Shown, type Value } from "@/debug/values"
import { Pending } from "@/debug/eval"
import { editText, settable } from "@/debug/assign"
import { cn } from "@/lib/utils"

/** A top-level entry of a tree: a variable, a watch, a register group. */
export type TreeRoot = {
  key: string
  name: string
  value: Value | null
  /** The text when there is no value to expand (an error, a watch still to evaluate). */
  shown?: Shown
  /** Extra controls at the end of the row (a watch's remove button). */
  actions?: React.ReactNode
  title?: string
}

type Props = {
  env: Env | null
  /** The same frame over the memory of the stop before: a value that reads differently there is marked. */
  before: Env | null
  roots: TreeRoot[]
  radix: Radix
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
  /** A row's name double-clicked: the text for the watch list or the memory view. */
  onPick?: (root: TreeRoot, path: string) => void
  /** Set a value to a C expression; resolves to why it could not be, or null. Without it nothing is editable. */
  onAssign?: (value: Value, text: string) => Promise<string | null>
  className?: string
}

/** How many children a node shows before a "more" row. */
const PAGE = 100

/**
 * Values as a tree, the way a debugger's variables pane shows them: name, value, type on
 * hover; structs, arrays and pointers open on demand. Values that changed since the stop
 * before are marked. A number, a pointer or a string can be set: its pencil, or a
 * double-click on the value, edits it in place (Enter sets it, Escape leaves it).
 */
export function ValueTree({ env, before, roots, radix, expanded, onToggle, onPick, onAssign, className }: Props) {
  const rows: React.ReactNode[] = []
  const [limits, setLimits] = React.useState<Record<string, number>>({})
  const [editing, setEditing] = React.useState<{ key: string; text: string; busy?: boolean } | null>(null)

  const commit = async (key: string, name: string, value: Value, text: string) => {
    if (!onAssign || !text.trim()) return setEditing(null)
    setEditing({ key, text, busy: true })
    const error = await onAssign(value, text)
    if (error) {
      toast.error(`Cannot set ${name}`, { description: error })
      setEditing({ key, text })
    } else setEditing(null)
  }

  const add = (key: string, depth: number, name: string, value: Value | null, shownIn: Shown | undefined, root: TreeRoot, path: string) => {
    const shown = shownIn ?? (env && value ? show(env, value, radix) : { text: "", expandable: false })
    const open = shown.expandable && expanded.has(key)
    // What the same place held at the stop before (nothing to say when that was not read).
    let changed = false
    if (before && value && !shown.pending && !shown.error) {
      const was = show(before, value, radix)
      changed = !was.pending && !was.error && was.text !== shown.text
    }
    const canSet = !!onAssign && !!value && !shown.pending && !shown.error && settable(value)
    const start = () => setEditing({ key, text: editText(shown.text) })
    const edit = editing?.key === key ? editing : null
    rows.push(
      <div
        key={key}
        className="group flex h-5 min-w-0 items-center gap-1 pr-2 hover:bg-accent/60"
        style={{ paddingLeft: 4 + depth * 12 }}
        title={value ? `${typeName(value.type)}${shown.error ? `\n${shown.text}` : ""}` : root.title}
      >
        <button type="button" className={cn("flex size-4 shrink-0 items-center justify-center text-muted-foreground", !shown.expandable && "invisible")} onClick={() => onToggle(key)} aria-label={open ? "Collapse" : "Expand"}>
          <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        </button>
        <span className="shrink-0 text-violet-700 dark:text-violet-300" onDoubleClick={() => onPick?.(root, path)}>
          {name}
        </span>
        <span className="shrink-0 text-muted-foreground">=</span>
        {edit && value ? (
          <input
            autoFocus
            className="h-4 min-w-0 flex-1 rounded-sm border bg-background px-1 font-mono text-[11px] outline-none focus:border-primary"
            value={edit.text}
            readOnly={edit.busy}
            spellCheck={false}
            aria-label={`New value of ${name}`}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setEditing({ key, text: e.target.value })}
            onBlur={() => !edit.busy && setEditing(null)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter") void commit(key, name, value, edit.text)
              else if (e.key === "Escape") setEditing(null)
            }}
          />
        ) : (
          <span
            className={cn("min-w-0 truncate", shown.error && "text-muted-foreground italic", shown.pending && "text-muted-foreground", changed && "rounded-sm bg-amber-200/60 px-0.5 dark:bg-amber-500/30", canSet && "cursor-text")}
            onDoubleClick={canSet ? start : undefined}
          >
            {shown.text}
          </span>
        )}
        {(canSet || (depth === 0 && root.actions)) && !edit && (
          <span className="ml-auto flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            {canSet && (
              <Button variant="ghost" size="icon-xs" aria-label={`Set ${name}`} title="Set the value (or double-click it)" onClick={start}>
                <PencilIcon />
              </Button>
            )}
            {depth === 0 && root.actions}
          </span>
        )}
      </div>,
    )
    if (!open || !env || !value) return
    const limit = limits[key] ?? PAGE
    let kids: ReturnType<typeof children>
    try {
      kids = children(env, value, 0, limit + 1)
    } catch (e) {
      rows.push(
        <div key={`${key}/…`} className="h-5 text-muted-foreground italic" style={{ paddingLeft: 24 + depth * 12 }}>
          {e instanceof Pending ? "…" : `<${(e as Error).message}>`}
        </div>,
      )
      return
    }
    // The expression each child stands for, so a double-click can watch it.
    const arrow = strip(value.type).kind === "pointer" ? "->" : "."
    for (const k of kids.slice(0, limit)) add(`${key}/${k.name}`, depth + 1, k.name, k.value, undefined, root, k.deref ? `*(${path})` : k.name.startsWith("[") ? `${path}${k.name}` : k.name.startsWith("<") ? path : `${path}${arrow}${k.name}`)
    if (kids.length > limit)
      rows.push(
        <button key={`${key}/more`} type="button" className="h-5 text-left text-sky-700 hover:underline dark:text-sky-400" style={{ paddingLeft: 24 + depth * 12 }} onClick={() => setLimits((l) => ({ ...l, [key]: limit + PAGE }))}>
          more…
        </button>,
      )
  }
  for (const r of roots) add(r.key, 0, r.name, r.value, r.shown, r, r.name)
  return <div className={cn("min-w-0 font-mono text-[11px] leading-5", className)}>{rows}</div>
}
