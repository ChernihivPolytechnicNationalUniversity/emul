import * as React from "react"
import { toast } from "sonner"
import { CpuIcon, HammerIcon, LoaderCircleIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { OPT_LEVELS, SOURCE_LIMITS, type OptLevel, type SourceFile, type Target } from "emul-shared/source"
import { Button } from "@/components/ui/button"
import { fetchArtifact, fetchText, submitBuild, waitForJob } from "@/project/api"
import { parseDiagnostic, parseDiagnostics, type Diagnostic } from "@/project/diagnostics"
import { createFile, removeFile, renameFile, renameFolder, writeFile } from "@/project/files"
import { TEMPLATE_MAIN, template } from "@/project/template"
import { getDef } from "@/schematic/registry"
import type { BoardDebug, PlacedObject } from "@/schematic/types"
import { formatSI } from "@/sim/units"
import { cn } from "@/lib/utils"
import { useEvent } from "@/hooks/use-event"
import type { BreakpointSpec } from "@/debug/protocol"
import { provideAnalysis, type DebugController } from "@/debug/session"
import { parseFirmware } from "@/mcu/elf"
import { MemorySnapshot } from "@/debug/memory"
import { DebugInfo } from "@/debug/info"
import { unwind } from "@/debug/unwind"
import { evaluateExpression, Pending } from "@/debug/eval"
import { assignment, registerAssignment } from "@/debug/assign"
import { contentHash, fetchSiteSource, resolveSource, sharedTail, type BuildRecord, type SourceRef } from "@/debug/sources"
import { show, variableValue } from "@/debug/values"
import { typeName } from "@/debug/types"
import { DebugToolbar } from "@/components/debug/DebugToolbar"
import { DebugPanel, type PanelTab } from "@/components/debug/DebugPanel"
import { DisassemblyView } from "@/components/debug/DisassemblyView"
import { SourceMissing } from "@/components/debug/SourceMissing"
import { useBenchRunning, useDebugView } from "@/components/debug/use-debug"
import { Editor, type DebugKey, type EditorHandle, type ExecMark, type GutterBreakpoint } from "./Editor"
import { Explorer } from "./Explorer"
import { ProgramSources } from "./ProgramSources"
import { Tabs } from "./Tabs"
import { setDebugHover } from "./debug-hover"

// The debugger's analysis travels with this panel's chunk, not with the page.
provideAnalysis({ parseFirmware, MemorySnapshot, DebugInfo, unwind, evaluateExpression, Pending, show, assignment, registerAssignment })

/** Panel width limits when dragged, and where it starts. */
const MIN_WIDTH = 420
const MAX_WIDTH = 0.7
const DEFAULT_WIDTH = 640
const EXPLORER_WIDTH = 176
/** What a board compiles at until its project says otherwise: a Debug build, as CubeIDE starts one. */
export const DEFAULT_BUILD_OPT: OptLevel = "-O0"
/** What each level is for, in the select's tooltip. */
const OPT_HELP = "Optimization: -O0 is a Debug build (every line steps, every variable is visible); -Og debugs well and runs faster; -O2 is a Release build (fast, hard to follow); -O3 fastest; -Os smallest"
const DISASM = "@disasm"

type CodePanelProps = Omit<React.ComponentProps<"div">, "ref"> & {
  /** The menu's Undo/Redo go to the editor while the text has the focus. */
  ref?: React.Ref<EditorHandle | null>
  /** The board or chip whose code is shown; null when there is none to show. */
  board: PlacedObject | null
  /** Every object on the schematic that can hold code, for the picker. */
  boards: PlacedObject[]
  onPick: (id: string) => void
  onFiles: (id: string, files: SourceFile[]) => void
  /** A build produced an image: load it on the board as the inspector's "Load…" would, with what it was built from. */
  onFirmware: (id: string, name: string, bytes: Uint8Array, build: BuildRecord) => void
  onBuild: (id: string, build: NonNullable<PlacedObject["build"]>) => void
  onDebug: (id: string, fn: (d: BoardDebug) => BoardDebug) => void
  debug: DebugController
  onClose: () => void
}

/** Tabs are the editor's, not the schematic's: kept here per board, lost with the page. */
type TabState = { open: string[]; active: string | null }

type Build =
  | { phase: "running"; startedAt: number }
  | { phase: "done"; ok: boolean; log: string; error: string | null; durationMs: number; diagnostics: Diagnostic[] }

/** What a board is called in the panel: its designator, else the component's name. */
const boardName = (o: PlacedObject) => o.props?.ref || getDef(o.def)?.name || o.def

/** The tab a source opens in: a project file under its path, the debugger's read-only and missing ones by the path the image names them by. */
const tabOfRef = (r: SourceRef) => (r.kind === "project" ? r.path : r.kind === "missing" ? `@missing:${r.image}` : `@src:${r.kind === "added" ? r.path : r.image}`)
/** The path breakpoints in a tab are keyed by: a project path, or the image's own path. */
const keyOfTab = (tab: string | null) => (!tab || tab === DISASM ? null : tab.startsWith("@") ? tab.replace(/^@(src|missing):/, "") : tab)

/**
 * The code side of the bench, docked to the right of the schematic: the selected board's
 * sources in an explorer, tabs and the editor, a Compile button that sends them to the build
 * service and loads the firmware that comes back onto that board — and the debugger over that
 * firmware: breakpoints in the gutter, the core's line in the editor, the values beside it and
 * under the pointer, the disassembly, and the views of the panel below. Keys and pointer
 * events stop here so the field behind it does not act on them.
 */
export function CodePanel({ ref, board, boards, onPick, onFiles, onFirmware, onBuild, onDebug, debug, onClose, className, style, ...props }: CodePanelProps) {
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
  const [panel, setPanel] = React.useState<{ open: boolean; tab: PanelTab; height: number }>({ open: false, tab: "output", height: 200 })
  const [memoryAt, setMemoryAt] = React.useState<{ addr: number; seq: number } | null>(null)
  /** ST library files fetched from the site, by the path the image names them by: text, null when the site has none, undefined while asked. */
  const [site, setSite] = React.useState<Record<string, string | null | undefined>>({})

  const id = board?.id ?? null
  const def = board ? getDef(board.def) : undefined
  const chip = def?.chip as Target | undefined
  const files = board?.project
  const opt = board?.build?.opt ?? DEFAULT_BUILD_OPT
  const bps = React.useMemo(() => board?.debug?.breakpoints ?? [], [board?.debug?.breakpoints])
  const added = React.useMemo(() => board?.debug?.sources ?? [], [board?.debug?.sources])
  const watches = board?.debug?.watches ?? []

  // --- the debugger ---------------------------------------------------------------------------
  const view = useDebugView(debug, id)
  const running = useBenchRunning(debug)
  const info = debug.info(id)
  const dboard = debug.board(id)
  React.useEffect(() => debug.focus(id), [debug, id])
  const stopped = !!view.regs && !running
  const setDebug = React.useCallback((fn: (d: BoardDebug) => BoardDebug) => id && onDebug(id, fn), [id, onDebug])
  const setBreakpoints = React.useCallback((list: BreakpointSpec[]) => setDebug((d) => ({ ...d, breakpoints: list })), [setDebug])

  // A board opened for the first time gets the template, so there is something to build —
  // unless it has a program from elsewhere, whose sources are then the ones to add.
  React.useEffect(() => {
    if (board && !board.project && !board.props?.firmwareData) onFiles(board.id, template())
  }, [board, onFiles])

  const project = React.useMemo(() => files ?? [], [files])
  const resolve = React.useCallback((image: string) => resolveSource(image, { project: dboard?.project ?? null, added }), [dboard?.project, added])
  const docs = React.useMemo(() => {
    const out = added.map((f) => ({ id: `@src:${f.path}`, content: f.content }))
    for (const [image, text] of Object.entries(site)) if (typeof text === "string" && !added.some((f) => f.path === image)) out.push({ id: `@src:${image}`, content: text })
    return out
  }, [added, site])
  const hasDoc = (tab: string) => docs.some((d) => d.id === tab)
  /** Fetch an ST library file the image names, once. */
  const want = React.useCallback(
    (r: SourceRef) => {
      if (r.kind !== "site" || r.image in site) return
      setSite((s) => ({ ...s, [r.image]: undefined }))
      void fetchSiteSource(r.url).then((text) => setSite((s) => ({ ...s, [r.image]: text })))
    },
    [site],
  )

  const tab: TabState = (id ? tabs[id] : undefined) ?? { open: [], active: null }
  // No tabs yet: start on main.c (the template's) or the first file, as an IDE opens a project.
  const first = project.find((f) => f.path === TEMPLATE_MAIN)?.path ?? project[0]?.path ?? null
  const active = tab.active ?? (tab.open.length === 0 ? first : null)
  const open = tab.open.length === 0 && first ? [first] : tab.open

  const setTab = (next: Partial<TabState>) => {
    if (id) setTabs((t) => ({ ...t, [id]: { open, active, ...next } }))
  }
  const openFile = (path: string) => setTab({ open: open.includes(path) ? open : [...open, path], active: path })
  /** Open a file the image names, wherever its text is (or say it is nowhere). */
  const openSource = (image: string, line?: number) => {
    const r = resolve(image)
    want(r)
    const t = tabOfRef(r)
    openFile(t)
    if (line) editor.current?.goTo(t, line, 1)
  }

  // A stop (or another frame picked in the call stack) shows its line, and the views under it.
  const frame = view.frames[view.frame]
  const showStop = useEvent((object: string) => {
    if (object !== id) return
    const v = debug.view(id)
    const f = v.frames[v.frame]
    setPanel((p) => (p.open && p.tab !== "output" ? p : { ...p, open: true, tab: p.tab === "output" ? "variables" : p.tab }))
    if (active === DISASM) return
    if (f?.file && f.line) openSource(f.file, f.line)
    else openFile(DISASM)
  })
  React.useEffect(() => debug.onShow(showStop), [debug, showStop])
  // Opened on a board that is already stopped: its line, as if it had just stopped.
  React.useEffect(() => {
    if (id && debug.view(id).regs) showStop(id)
  }, [debug, id, showStop])

  /** The source tab a frame's location opens in. */
  const tabOfFrame = (f: typeof frame) => (f?.file ? tabOfRef(resolve(f.file)) : null)
  const exec: ExecMark | null = (() => {
    if (!stopped || !active) return null
    const top = view.frames[0]
    if (view.frame === 0) return top && tabOfFrame(top) === active ? { line: top.line, kind: "top" } : null
    if (frame && tabOfFrame(frame) === active) return { line: frame.line, kind: "frame" }
    return top && tabOfFrame(top) === active ? { line: top.line, kind: "top" } : null
  })()

  // Breakpoints of the active tab, shown where the core will put them.
  const key = keyOfTab(active)
  const lineBps = bps.filter((b): b is BreakpointSpec & { kind: "line" } => b.kind === "line" && b.path === key)
  const gutter: GutterBreakpoint[] = lineBps.map((b) => {
    const r = info?.lines.resolve(b.path, b.line)
    const ok = !!r && r.addrs.length > 0
    return { line: ok ? r!.line : b.line, state: !b.enabled ? "disabled" : ok || !info ? "verified" : "unverified" }
  })
  const toggleBreakpoint = (line: number) => {
    if (!key) return
    const hit = lineBps.find((b) => b.line === line || info?.lines.resolve(b.path, b.line)?.line === line)
    if (hit) setBreakpoints(bps.filter((b) => b.id !== hit.id))
    else setBreakpoints([...bps, { id: crypto.randomUUID(), kind: "line", path: key, line, enabled: true }])
  }
  const onBreakpointsMoved = (moves: [number, number][]) => {
    if (!key) return
    const to = new Map(moves)
    setBreakpoints(bps.map((b) => (b.kind === "line" && b.path === key && to.has(b.line) ? { ...b, line: to.get(b.line)! } : b)))
  }

  // Addresses breakpoints are on, for the disassembly's gutter.
  const bpAddrs = React.useMemo(() => {
    const out = new Set<number>()
    for (const b of bps) {
      if (!b.enabled) continue
      if (b.kind === "address") out.add(b.address)
      else if (b.kind === "line") for (const a of info?.lines.resolve(b.path, b.line)?.addrs ?? []) out.add(a)
      else for (const s of info?.symbols ?? []) if (s.type === "func" && s.name === b.name) out.add(info!.lines.postPrologue(s.value, s.value + s.size))
    }
    return out
  }, [bps, info])
  const toggleAddress = (addr: number) => {
    const hit = bps.find((b) => b.kind === "address" && b.address === addr)
    if (hit) return setBreakpoints(bps.filter((b) => b !== hit))
    // A line breakpoint that landed here goes too.
    const line = bps.find((b) => b.kind === "line" && info?.lines.resolve(b.path, b.line)?.addrs.includes(addr))
    if (line) return setBreakpoints(bps.filter((b) => b !== line))
    setBreakpoints([...bps, { id: crypto.randomUUID(), kind: "address", address: addr, enabled: true }])
  }

  // The text of a line of any file the image names, for the disassembly and the inline values.
  const textOf = React.useCallback(
    (tabId: string) => (tabId.startsWith("@") ? (docs.find((d) => d.id === tabId)?.content ?? null) : (project.find((f) => f.path === tabId)?.content ?? null)),
    [docs, project],
  )
  const sourceLine = React.useCallback(
    (image: string, line: number) => {
      const r = resolveSource(image, { project: dboard?.project ?? null, added })
      const text = r.kind === "missing" ? null : textOf(tabOfRef(r))
      return text?.split("\n")[line - 1]?.trim() ?? null
    },
    [textOf, dboard?.project, added],
  )

  // Values beside the lines of the frame's function that use them, up to the line it is at.
  const inline = (() => {
    if (!stopped || !frame?.fn || !exec || !id || !active) return null
    const text = textOf(active)
    const env = debug.env(id)
    if (!text || !env) return null
    const vars = debug.locals(id)
    const lines = text.split("\n")
    const from = Math.max(1, frame.fn.declLine || exec.line - 30, exec.line - 60)
    const out = new Map<number, string>()
    for (let l = from; l <= exec.line; l++) {
      const words = new Set(lines[l - 1]?.match(/[A-Za-z_]\w*/g) ?? [])
      const parts: string[] = []
      for (const v of vars) {
        if (!words.has(v.name)) continue
        const s = show(env, variableValue(env, v), debug.radix)
        if (s.pending) continue
        parts.push(`${v.name} = ${s.text.length > 40 ? `${s.text.slice(0, 39)}…` : s.text}`)
      }
      if (parts.length) out.set(l, parts.join(", "))
    }
    return out
  })()

  // The hover: the value of what the pointer is over, in the selected frame.
  React.useEffect(() => {
    setDebugHover((object, _tab, expr) => {
      if (object !== id || !stopped) return null
      const r = debug.evaluate(id, expr)
      if (!r.value) return null
      return { text: r.shown.text, type: typeName(r.value.type) }
    })
    return () => setDebugHover(null)
  }, [debug, id, stopped, view.version])

  // --- the debugger's keys and buttons ---------------------------------------------------------
  const instructions = active === DISASM
  const act = (k: DebugKey, line?: number) => {
    if (!id) return
    // Breakpoints go in before there is a program; everything else needs one.
    if (k === "toggleBreakpoint") return line && toggleBreakpoint(line)
    if (!board?.props?.firmwareData) return
    switch (k) {
      case "continue":
        return running ? debug.pause() : debug.continue()
      case "stepOver":
        return debug.step(id, instructions ? { kind: "instruction", over: true } : { kind: "over" })
      case "stepInto":
        return debug.step(id, instructions ? { kind: "instruction" } : { kind: "into" })
      case "stepOut":
        return debug.stepOut(id)
      case "stepInstruction":
        return debug.step(id, { kind: "instruction" })
      case "restart":
        return debug.restart(id)
      case "runToCursor": {
        const r = key && line ? info?.lines.resolve(key, line) : null
        if (!r?.addrs.length) return toast("No code of the program on that line")
        return debug.runTo(id, r.addrs[0])
      }
    }
  }
  const onPanelKey = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    const k: DebugKey | null = e.key === "F5" ? (e.shiftKey && (e.ctrlKey || e.metaKey) ? "restart" : "continue") : e.key === "F10" ? "stepOver" : e.key === "F11" ? (e.shiftKey ? "stepOut" : e.altKey ? "stepInstruction" : "stepInto") : null
    if (k) {
      e.preventDefault()
      act(k)
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault()
      openFile(active === DISASM ? (tabOfFrame(frame) ?? first ?? DISASM) : DISASM)
    }
  }

  /** Add source files the image names: each to the file it stands for (the one missing here, when this is for it). */
  const addSources = async (picked: File[], forImage?: string) => {
    if (!id) return
    const images = info ? info.lines.sourceFiles().map((f) => info.lines.files[f]) : []
    const add: SourceFile[] = []
    const skipped: string[] = []
    for (const f of picked) {
      if (!/\.(c|h|cpp|hpp|cc|s|S|inc)$/i.test(f.name)) continue
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
      const candidates = forImage && forImage.split("/").pop() === f.name ? [forImage] : images.filter((p) => p.split("/").pop() === f.name)
      const match = candidates.sort((a, b) => sharedTail(b, rel) - sharedTail(a, rel))[0]
      if (!match || resolve(match).kind === "project") {
        if (picked.length === 1) skipped.push(f.name)
        continue
      }
      if (f.size > SOURCE_LIMITS.fileBytes) {
        toast.error(`${f.name} is too large`, { description: `A source file is at most ${SOURCE_LIMITS.fileBytes / 1024} KB.` })
        continue
      }
      add.push({ path: match, content: (await f.text()).replace(/\r\n?/g, "\n") })
    }
    if (skipped.length) toast(`${skipped.join(", ")} is not one of the program's sources`)
    if (!add.length) return
    setDebug((d) => ({ ...d, sources: [...(d.sources ?? []).filter((s) => !add.some((a) => a.path === s.path)), ...add] }))
    toast.success(`${add.length} source file${add.length === 1 ? "" : "s"} added`, { description: "Kept with the board, read-only; the debugger shows them where the program runs." })
    // What was missing opens as the source now.
    const now = (t: string) => (t.startsWith("@missing:") && add.some((a) => a.path === t.slice(9)) ? `@src:${t.slice(9)}` : t)
    setTab({ open: open.map(now), active: active ? now(active) : null })
  }

  // --- the project -----------------------------------------------------------------------------
  const create = (raw: string) => {
    if (!id) return
    const r = createFile(project, raw)
    onFiles(id, r.files)
    openFile(r.path)
  }
  const rename = (path: string, raw: string, folder: boolean) => {
    if (!id) return
    const r = folder ? renameFolder(project, path, raw) : renameFile(project, path, raw)
    onFiles(id, r.files)
    // Tabs follow the files.
    setTab({ open: open.map((p) => r.moved.get(p) ?? p), active: active ? (r.moved.get(active) ?? active) : null })
  }
  const remove = (path: string) => {
    if (!id) return
    const before = { files: project, open, active }
    onFiles(id, removeFile(project, path))
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
    setPanel((p) => ({ ...p, open: true, tab: "output" }))
    // What the image is built from, so the debugger knows the project's files are its sources.
    const record: BuildRecord = { opt, files: Object.fromEntries(files.map((f) => [f.path, contentHash(f.content)])) }
    let done: Build
    try {
      const job = await waitForJob(await submitBuild(chip, files, { opt }))
      const log = job.artifacts.find((a) => a.name === "build.log")
      const elf = job.artifacts.find((a) => a.name === "firmware.elf")
      const ok = !!job.result?.ok && !!elf
      if (elf && ok) onFirmware(id, "firmware.elf", await fetchArtifact(elf), record)
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
    if (done.ok) toast.success(`${boardName(board)} programmed`, { description: `Built at ${opt} in ${formatSI(done.durationMs / 1000, "s", 2)}.` })
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

  // The program's other sources, for the explorer's second section.
  const programSources = React.useMemo(() => {
    if (!info) return []
    return info.lines
      .sourceFiles()
      .map((f) => resolve(info.lines.files[f]))
      .filter((r) => r.kind !== "project" && !/\.(ld|inc)$/.test(r.image))
  }, [info, resolve])

  // What the editor area shows: the source, the disassembly, or a source that is not here
  // (still coming from the site, or to be added).
  const pendingSite = active?.startsWith("@src:") && !hasDoc(active) ? active.slice(5) : null
  const main: { kind: "editor" } | { kind: "disasm" } | { kind: "missing"; image: string; loading: boolean } =
    active === DISASM
      ? { kind: "disasm" }
      : active?.startsWith("@missing:")
        ? { kind: "missing", image: active.slice(9), loading: false }
        : pendingSite
          ? { kind: "missing", image: pendingSite, loading: site[pendingSite] === undefined && resolve(pendingSite).kind === "site" }
          : { kind: "editor" }
  const staleFile = dboard?.build && active && !active.startsWith("@") && dboard.build.files[active] !== undefined && dboard.build.files[active] !== contentHash(textOf(active) ?? "")
  const where = frame?.file ? `${frame.file.split("/").pop()}:${frame.line}` : view.regs ? `0x${view.regs.r[15].toString(16).padStart(8, "0")}` : null
  const hasImage = !!board?.props?.firmwareData

  const output = build ? <Output build={build} onGoTo={(d) => {
    if (!d.path || !project.some((f) => f.path === d.path)) return
    openFile(d.path)
    editor.current?.goTo(d.path, d.line, d.col)
  }} /> : null

  return (
    <div
      data-slot="code-panel"
      className={cn("relative flex min-h-0 shrink-0 border-l bg-background", className)}
      style={{ ...style, width }}
      onKeyDown={onPanelKey}
      onPointerDown={(e) => e.stopPropagation()}
      onCopy={(e) => e.stopPropagation()}
      onCut={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
      {...props}
    >
      <div className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/40" onPointerDown={onResizeStart} aria-label="Resize code panel" />
      {board && id ? (
        <>
          <div className="flex min-h-0 shrink-0 flex-col border-r" style={{ width: EXPLORER_WIDTH }}>
            <Explorer className="min-h-0 flex-1" files={project} active={active} onOpen={openFile} onCreate={create} onRename={rename} onRemove={remove} />
            {info && (programSources.length > 0 || !dboard?.project) && (
              <ProgramSources className="max-h-[45%]" sources={programSources} active={active} tabOf={tabOfRef} onOpen={(r) => openSource(r.image)} onAdd={(f) => void addSources(f)} />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-8 shrink-0 items-stretch border-b">
              <Tabs className="min-w-0 flex-1" open={open} active={active} onActivate={openFile} onChange={(o, a) => setTab({ open: o, active: a })} />
              <div className="flex shrink-0 items-center gap-1.5 bg-sidebar pr-1 pl-2 text-xs">
                <CpuIcon className="size-3.5 text-muted-foreground" />
                <span className="font-medium">{boardName(board)}</span>
                <select
                  className="h-6 w-14 rounded-md border bg-background px-0.5 text-xs"
                  value={opt}
                  onChange={(e) => onBuild(id, { ...board.build, opt: e.target.value as OptLevel })}
                  title={OPT_HELP}
                  aria-label="Optimization level"
                >
                  {OPT_LEVELS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
                <Button size="xs" onClick={() => void compile()} disabled={!chip || !files || build?.phase === "running"}>
                  {build?.phase === "running" ? <LoaderCircleIcon className="animate-spin" /> : <HammerIcon />}
                  Compile
                </Button>
                {build?.phase === "done" && !build.ok && (
                  <button type="button" className="rounded-sm bg-destructive/10 px-1.5 font-mono text-[0.6875rem] text-destructive" title="Errors in the last build" onClick={() => setPanel((p) => ({ ...p, open: true, tab: "output" }))}>
                    {build.diagnostics.filter((d) => d.severity === "error").length || "!"}
                  </button>
                )}
                <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close code panel">
                  <XIcon />
                </Button>
              </div>
            </div>
            {hasImage && (
              <DebugToolbar
                view={view}
                running={running}
                where={where}
                instructions={instructions}
                disassembly={active === DISASM}
                onContinue={() => act("continue")}
                onPause={() => act("continue")}
                onStepOver={() => act("stepOver")}
                onStepInto={() => act("stepInto")}
                onStepOut={() => act("stepOut")}
                onStepInstruction={() => act("stepInstruction")}
                onRestart={() => act("restart")}
                onDisassembly={() => openFile(active === DISASM ? (tabOfFrame(frame) ?? first ?? DISASM) : DISASM)}
              />
            )}
            {staleFile && (
              <div className="flex shrink-0 items-center gap-1.5 border-b bg-amber-100/70 px-2 py-0.5 text-[11px] text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
                <TriangleAlertIcon className="size-3.5 shrink-0" />
                Edited since the last build: the program runs the file as it was, so lines may not match. Compile to bring them together.
              </div>
            )}
            {main.kind === "disasm" && <DisassemblyView debug={debug} boardId={id} view={view} breakpoints={bpAddrs} onToggleBreakpoint={toggleAddress} sourceLine={sourceLine} onOpenSource={(p, l) => openSource(p, l)} />}
            {main.kind === "missing" && (
              <SourceMissing
                path={main.image}
                line={frame?.file === main.image ? frame.line : 0}
                fn={frame?.file === main.image ? frame.name : null}
                loading={main.loading}
                onAddFiles={(f) => void addSources(f, main.image)}
                onDisassembly={() => openFile(DISASM)}
              />
            )}
            <Editor
              ref={editor}
              className={cn(main.kind !== "editor" && "hidden")}
              objectId={id}
              files={project}
              docs={docs}
              active={main.kind === "editor" ? active : null}
              target={chip ?? "stm32f429zi"}
              diagnostics={build?.phase === "done" ? build.diagnostics : []}
              breakpoints={gutter}
              exec={exec}
              inline={inline}
              onWrite={write}
              onToggle={onClose}
              onDebugKey={act}
              onBreakpointsMoved={onBreakpointsMoved}
              onAddWatch={(e) => {
                if (!watches.includes(e)) setDebug((d) => ({ ...d, watches: [...(d.watches ?? []), e] }))
                setPanel((p) => ({ ...p, open: true, tab: "watch" }))
              }}
            />
            {panel.open ? (
              <DebugPanel
                debug={debug}
                boardId={id}
                chip={chip ?? "stm32f429zi"}
                view={view}
                info={info}
                tab={panel.tab}
                onTab={(t) => setPanel((p) => ({ ...p, tab: t }))}
                output={output}
                watches={watches}
                onWatches={(list) => setDebug((d) => ({ ...d, watches: list }))}
                breakpoints={bps}
                onBreakpoints={setBreakpoints}
                catchFaults={board.debug?.catchFaults ?? true}
                onCatchFaults={(on) => setDebug((d) => ({ ...d, catchFaults: on }))}
                onReveal={(b) => {
                  if (b.kind === "line") {
                    const t = project.some((f) => f.path === b.path) ? b.path : tabOfRef(resolve(b.path))
                    openFile(t)
                    editor.current?.goTo(t, b.line, 1)
                  } else openFile(DISASM)
                }}
                memoryAt={memoryAt}
                onMemory={(addr) => {
                  setMemoryAt({ addr, seq: (memoryAt?.seq ?? 0) + 1 })
                  setPanel((p) => ({ ...p, tab: "memory" }))
                }}
                height={panel.height}
                onHeight={(h) => setPanel((p) => ({ ...p, height: h }))}
                onClose={() => setPanel((p) => ({ ...p, open: false }))}
              />
            ) : (
              (hasImage || build) && (
                <div className="flex h-6 shrink-0 items-center gap-3 border-t bg-sidebar px-2 text-[11px] text-muted-foreground">
                  {(["output", "variables", "watch", "stack", "breakpoints"] as PanelTab[]).map((t) => (
                    <button key={t} type="button" className="uppercase hover:text-foreground" onClick={() => setPanel((p) => ({ ...p, open: true, tab: t }))}>
                      {t === "stack" ? "call stack" : t}
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
        </>
      ) : (
        <Picker boards={boards} onPick={onPick} onClose={onClose} />
      )}
    </div>
  )
}

/** The build's log, as an IDE's output pane; a diagnostic's line opens the place. */
function Output({ build, onGoTo }: { build: Build; onGoTo: (d: Diagnostic) => void }) {
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-6 shrink-0 items-center gap-2 px-2 text-xs">
        {build.phase === "running" ? (
          <span className="text-muted-foreground">building…</span>
        ) : (
          <span className={cn("font-mono", build.ok ? "text-emerald-600" : "text-destructive")}>
            {build.ok ? "ok" : "failed"} · {formatSI(build.durationMs / 1000, "s", 2)}
          </span>
        )}
      </div>
      <pre ref={pre} className="min-h-0 flex-1 overflow-auto px-3 pb-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">
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
