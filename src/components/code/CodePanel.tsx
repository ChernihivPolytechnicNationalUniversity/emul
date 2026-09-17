import * as React from "react"
import { toast } from "sonner"
import { CpuIcon, HammerIcon, LoaderCircleIcon, XIcon } from "lucide-react"
import { SOURCE_LIMITS, type SourceFile, type Target } from "emul-shared/source"
import { Button } from "@/components/ui/button"
import { fetchArtifact, fetchText, submitBuild, waitForJob } from "@/project/api"
import { parseDiagnostic, parseDiagnostics, type Diagnostic } from "@/project/diagnostics"
import { createFile, removeFile, renameFile, renameFolder, writeFile } from "@/project/files"
import { TEMPLATE_MAIN, template } from "@/project/template"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"
import { formatSI } from "@/sim/units"
import { cn } from "@/lib/utils"
import { Editor, type EditorHandle } from "./Editor"
import { Explorer } from "./Explorer"
import { Tabs } from "./Tabs"

/** Panel width limits when dragged, and where it starts. */
const MIN_WIDTH = 420
const MAX_WIDTH = 0.7
const DEFAULT_WIDTH = 640
const EXPLORER_WIDTH = 176

type CodePanelProps = Omit<React.ComponentProps<"div">, "ref"> & {
  /** The menu's Undo/Redo go to the editor while the text has the focus. */
  ref?: React.Ref<EditorHandle | null>
  /** The board or chip whose code is shown; null when there is none to show. */
  board: PlacedObject | null
  /** Every object on the schematic that can hold code, for the picker. */
  boards: PlacedObject[]
  onPick: (id: string) => void
  onFiles: (id: string, files: SourceFile[]) => void
  /** A build produced an image: load it on the board as the inspector's "Load…" would. */
  onFirmware: (id: string, name: string, bytes: Uint8Array) => void
  onClose: () => void
}

/** Tabs are the editor's, not the schematic's: kept here per board, lost with the page. */
type TabState = { open: string[]; active: string | null }

type Build =
  | { phase: "running"; startedAt: number }
  | { phase: "done"; ok: boolean; log: string; error: string | null; durationMs: number; diagnostics: Diagnostic[] }

/** What a board is called in the panel: its designator, else the component's name. */
const boardName = (o: PlacedObject) => o.props?.ref || getDef(o.def)?.name || o.def

/**
 * The code side of the bench, docked to the right of the schematic: the selected board's
 * sources in an explorer, tabs and the editor, and a Compile button that sends them to the
 * build service and loads the firmware that comes back onto that board. Keys and pointer
 * events stop here so the field behind it does not act on them.
 */
export function CodePanel({ ref, board, boards, onPick, onFiles, onFirmware, onClose, className, style, ...props }: CodePanelProps) {
  const [width, setWidth] = React.useState(DEFAULT_WIDTH)
  const editor = React.useRef<EditorHandle | null>(null)
  // The field's Undo/Redo reach the editor through this panel; the editor may not be mounted (no board).
  React.useImperativeHandle(ref, () => ({
    focused: () => !!editor.current?.focused(),
    undo: () => editor.current?.undo(),
    redo: () => editor.current?.redo(),
    goTo: (path, line, col) => editor.current?.goTo(path, line, col),
  }))
  const [tabs, setTabs] = React.useState<Record<string, TabState>>({})
  const [builds, setBuilds] = React.useState<Record<string, Build>>({})

  const id = board?.id ?? null
  const def = board ? getDef(board.def) : undefined
  const chip = def?.chip as Target | undefined
  const files = board?.project

  // A board opened for the first time gets the template, so there is something to build.
  React.useEffect(() => {
    if (board && !board.project) onFiles(board.id, template())
  }, [board, onFiles])

  const tab: TabState = (id ? tabs[id] : undefined) ?? { open: [], active: null }
  // No tabs yet: start on main.c (the template's) or the first file, as an IDE opens a project.
  const first = files?.find((f) => f.path === TEMPLATE_MAIN)?.path ?? files?.[0]?.path ?? null
  const active = tab.active ?? (tab.open.length === 0 ? first : null)
  const open = tab.open.length === 0 && first ? [first] : tab.open

  const setTab = (next: Partial<TabState>) => {
    if (id) setTabs((t) => ({ ...t, [id]: { open, active, ...next } }))
  }
  const openFile = (path: string) => setTab({ open: open.includes(path) ? open : [...open, path], active: path })

  const create = (raw: string) => {
    if (!id || !files) return
    const r = createFile(files, raw)
    onFiles(id, r.files)
    openFile(r.path)
  }
  const rename = (path: string, raw: string, folder: boolean) => {
    if (!id || !files) return
    const r = folder ? renameFolder(files, path, raw) : renameFile(files, path, raw)
    onFiles(id, r.files)
    // Tabs follow the files.
    setTab({ open: open.map((p) => r.moved.get(p) ?? p), active: active ? (r.moved.get(active) ?? active) : null })
  }
  const remove = (path: string) => {
    if (!id || !files) return
    const before = { files, open, active }
    onFiles(id, removeFile(files, path))
    const gone = (p: string) => p === path || p.startsWith(path + "/")
    const rest = open.filter((p) => !gone(p))
    const i = active ? open.indexOf(active) : -1
    setTab({ open: rest, active: active && gone(active) ? (rest[Math.min(i, rest.length - 1)] ?? null) : active })
    toast(`Deleted ${path}`, {
      action: {
        label: "Undo",
        onClick: () => {
          onFiles(id, before.files)
          setTab(before)
        },
      },
    })
  }
  const write = React.useCallback(
    (path: string, content: string) => {
      if (!id || !files) return
      const next = writeFile(files, path, content)
      if (next) onFiles(id, next)
      else toast.error("File too large", { description: `A source file is at most ${SOURCE_LIMITS.fileBytes / 1024} KB; the last edit was not kept.` })
    },
    [id, files, onFiles],
  )

  const build = id ? builds[id] : undefined
  const compile = async () => {
    if (!id || !chip || !files || !board) return
    const startedAt = Date.now()
    setBuilds((b) => ({ ...b, [id]: { phase: "running", startedAt } }))
    let done: Build
    try {
      const job = await waitForJob(await submitBuild(chip, files))
      const log = job.artifacts.find((a) => a.name === "build.log")
      const elf = job.artifacts.find((a) => a.name === "firmware.elf")
      const ok = !!job.result?.ok && !!elf
      if (elf && ok) onFirmware(id, "firmware.elf", await fetchArtifact(elf))
      const text = log ? await fetchText(log) : ""
      done = {
        phase: "done",
        ok,
        log: text,
        error: job.result?.error ?? job.error ?? (job.result?.ok && !elf ? "the build left no firmware.elf" : null),
        durationMs: job.result?.durationMs ?? Date.now() - startedAt,
        diagnostics: parseDiagnostics(text),
      }
    } catch (e) {
      done = { phase: "done", ok: false, log: "", error: (e as Error).message, durationMs: Date.now() - startedAt, diagnostics: [] }
    }
    setBuilds((b) => ({ ...b, [id]: done }))
    if (done.ok) toast.success(`${boardName(board)} programmed`, { description: `Built in ${formatSI(done.durationMs / 1000, "s", 2)}.` })
  }

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const max = window.innerWidth * MAX_WIDTH
    const move = (ev: PointerEvent) => setWidth(Math.min(max, Math.max(MIN_WIDTH, startW + (startX - ev.clientX))))
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  return (
    <div
      data-slot="code-panel"
      className={cn("relative flex min-h-0 shrink-0 border-l bg-background", className)}
      style={{ ...style, width }}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      {...props}
    >
      <div className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/40" onPointerDown={onResizeStart} aria-label="Resize code panel" />
      {board && id && files ? (
        <>
          <Explorer className="border-r" style={{ width: EXPLORER_WIDTH }} files={files} active={active} onOpen={openFile} onCreate={create} onRename={rename} onRemove={remove} />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-8 shrink-0 items-stretch border-b">
              <Tabs className="min-w-0 flex-1" open={open} active={active} onActivate={openFile} onChange={(o, a) => setTab({ open: o, active: a })} />
              <div className="flex shrink-0 items-center gap-1.5 bg-sidebar pr-1 pl-2 text-xs">
                <CpuIcon className="size-3.5 text-muted-foreground" />
                <span className="font-medium">{boardName(board)}</span>
                <span className="text-muted-foreground">{def?.name}</span>
                <Button size="xs" className="ml-1" onClick={() => void compile()} disabled={!chip || build?.phase === "running"}>
                  {build?.phase === "running" ? <LoaderCircleIcon className="animate-spin" /> : <HammerIcon />}
                  Compile
                </Button>
                {build?.phase === "done" && !build.ok && (
                  <span className="rounded-sm bg-destructive/10 px-1.5 font-mono text-[0.6875rem] text-destructive" title="Errors in the last build">
                    {build.diagnostics.filter((d) => d.severity === "error").length || "!"}
                  </span>
                )}
                <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close code panel">
                  <XIcon />
                </Button>
              </div>
            </div>
            <Editor ref={editor} objectId={id} files={files} active={active} target={chip ?? "stm32f429zi"} diagnostics={build?.phase === "done" ? build.diagnostics : []} onWrite={write} onToggle={onClose} />
            {build && (
              <Output
                build={build}
                onGoTo={(d) => {
                  if (!d.path || !files.some((f) => f.path === d.path)) return
                  openFile(d.path)
                  editor.current?.goTo(d.path, d.line, d.col)
                }}
                onClose={() => setBuilds((b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== id)))}
              />
            )}
          </div>
        </>
      ) : (
        <Picker boards={boards} onPick={onPick} onClose={onClose} />
      )}
    </div>
  )
}

/** The build's log under the editor, as an IDE's output pane; a diagnostic's line opens the place. */
function Output({ build, onGoTo, onClose }: { build: Build; onGoTo: (d: Diagnostic) => void; onClose: () => void }) {
  const pre = React.useRef<HTMLPreElement>(null)
  React.useEffect(() => {
    // Errors are what the student came for: start at the first one, else at the end.
    const first = pre.current?.querySelector<HTMLElement>("[data-severity=error]")
    if (first) first.scrollIntoView({ block: "start" })
    else pre.current?.scrollTo(0, pre.current.scrollHeight)
  }, [build])
  const text = build.phase === "done" ? build.log : ""
  // The log usually carries the error already; say it once more only when it does not.
  const error = build.phase === "done" && build.error && !text.includes(build.error) ? build.error : null
  const lines = React.useMemo(() => text.split("\n").map((line) => ({ line, d: parseDiagnostic(line) })), [text])
  return (
    <div className="flex h-40 shrink-0 flex-col border-t">
      <div className="flex h-7 shrink-0 items-center gap-2 bg-sidebar px-2 text-xs">
        <span className="font-medium tracking-wider text-muted-foreground uppercase">Output</span>
        {build.phase === "running" ? (
          <span className="text-muted-foreground">building…</span>
        ) : (
          <span className={cn("font-mono", build.ok ? "text-emerald-600" : "text-destructive")}>
            {build.ok ? "ok" : "failed"} · {formatSI(build.durationMs / 1000, "s", 2)}
          </span>
        )}
        <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={onClose} aria-label="Close output">
          <XIcon />
        </Button>
      </div>
      <pre ref={pre} className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">
        {lines.map(({ line, d }, i) =>
          d ? (
            <button
              key={i}
              type="button"
              data-severity={d.severity}
              className={cn(
                "block w-full cursor-pointer text-left hover:bg-accent/60",
                d.severity === "error" ? "text-destructive" : d.severity === "warning" ? "text-amber-700" : "text-muted-foreground",
              )}
              onClick={() => onGoTo(d)}
            >
              {line}
            </button>
          ) : (
            <span key={i} className="block">
              {line}
            </span>
          ),
        )}
        {error && <span className="text-destructive">{`error: ${error}\n`}</span>}
      </pre>
    </div>
  )
}

/** Nothing selected that holds code: say so, and offer what is on the schematic. */
function Picker({ boards, onPick, onClose }: { boards: PlacedObject[]; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center border-b bg-sidebar pr-1 pl-3 text-xs">
        <span className="font-medium tracking-wider text-muted-foreground uppercase">Code</span>
        <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={onClose} aria-label="Close code panel">
          <XIcon />
        </Button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        {boards.length ? (
          <>
            <p>Code belongs to a board or chip. Select one on the schematic, or pick it here:</p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {boards.map((b) => (
                <Button key={b.id} variant="outline" size="sm" onClick={() => onPick(b.id)}>
                  <CpuIcon />
                  {boardName(b)}
                  <span className="text-muted-foreground">{getDef(b.def)?.name}</span>
                </Button>
              ))}
            </div>
          </>
        ) : (
          <p>Code belongs to a board or chip. Add one from the Components sidebar first.</p>
        )}
      </div>
    </div>
  )
}
