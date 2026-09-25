import * as React from "react"
import { CircleCheckIcon, FilePlusIcon, HammerIcon, LoaderCircleIcon, Trash2Icon, TriangleAlertIcon, UploadIcon, XIcon } from "lucide-react"
import { guessTop, languageOf, scanHdl, type HdlNetlist } from "emul-shared/hdl"
import { sourcePath, type SourceFile } from "emul-shared/source"
import { Button } from "@/components/ui/button"
import { monaco, type Editor as CodeEditor } from "@/components/code/monaco"
import { fetchText, submitSynth, waitForJob } from "@/project/api"
import { isModified, sourceKey } from "@/schematic/hdl"
import type { HdlModule } from "@/schematic/types"
import { cn } from "@/lib/utils"
import { useEvent } from "@/hooks/use-event"
import { HDL_ACCEPT, mergeFiles, readHdlFiles } from "./files"
import { languageId, registerHdlLanguages } from "./languages"

registerHdlLanguages()

const MIN_WIDTH = 420
const MAX_WIDTH = 0.7
const DEFAULT_WIDTH = 620

type Diagnostic = { path: string; line: number; col: number; severity: "error" | "warning"; message: string }

type Build = { phase: "running" } | { phase: "done"; ok: boolean; log: string; error: string | null; diagnostics: Diagnostic[] }

const DIAGNOSTIC = /^(?:ERROR:\s*)?(?:.*?\bin line\s+)?([\w./-]+\.(?:vhdl?|s?v)):(\d+)(?::(\d+))?:\s*(.*)$/i

function parseDiagnostics(log: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const seen = new Set<string>()
  for (const line of log.split("\n")) {
    const m = DIAGNOSTIC.exec(line.trim())
    if (!m) continue
    const key = `${m[1]}:${m[2]}:${m[3] ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    const rest = m[4]!
    const severity = /warning/i.test(rest) && !/error/i.test(rest) ? "warning" : /error|ERROR/.test(line) ? "error" : "warning"
    out.push({ path: m[1]!, line: Number(m[2]), col: Number(m[3] ?? 1), severity, message: rest.replace(/^(error|warning|note):\s*/i, "").replace(/^ERROR:\s*/, "") })
  }
  return out
}

type HdlPanelProps = Omit<React.ComponentProps<"div">, "onChange"> & {
  module: HdlModule
  placed: number
  onChange: (module: HdlModule) => void
  onDelete: (id: string) => void
  onClose: () => void
}

export function HdlPanel({ module, placed, onChange, onDelete, onClose, className, style, ...props }: HdlPanelProps) {
  const [width, setWidth] = React.useState(DEFAULT_WIDTH)
  const [activeByModule, setActiveByModule] = React.useState<Record<string, string>>({})
  const [builds, setBuilds] = React.useState<Record<string, Build>>({})
  const [adding, setAdding] = React.useState<string | null>(null)
  const [logOpen, setLogOpen] = React.useState(false)
  const latest = React.useRef(module)
  React.useLayoutEffect(() => {
    latest.current = module
  })
  const fileInput = React.useRef<HTMLInputElement>(null)
  const editorApi = React.useRef<{ goTo: (path: string, line: number, col: number) => void } | null>(null)

  const files = module.files
  const active = files.find((f) => f.path === activeByModule[module.id])?.path ?? files[0]?.path ?? null
  const setActive = (path: string) => setActiveByModule((a) => ({ ...a, [module.id]: path }))
  const build = builds[module.id]
  const units = React.useMemo(() => scanHdl(files), [files])
  const autoTop = React.useMemo(() => guessTop(files), [files])
  const top = module.top && units.some((u) => u.name === module.top) ? module.top : undefined
  const unit = units.find((u) => u.name === (top ?? autoTop))
  const modified = isModified(module)

  const update = (patch: Partial<HdlModule>) => onChange({ ...latest.current, ...patch })

  const write = useEvent((path: string, content: string) => {
    const m = latest.current
    if (m.files.find((f) => f.path === path)?.content === content) return
    onChange({ ...m, files: m.files.map((f) => (f.path === path ? { ...f, content } : f)) })
  })

  const compile = useEvent(async () => {
    const m = latest.current
    const id = m.id
    setBuilds((b) => ({ ...b, [id]: { phase: "running" } }))
    const generics = Object.fromEntries(Object.entries(m.generics ?? {}).filter(([, v]) => v.trim() !== ""))
    const key = sourceKey(m)
    try {
      const jobId = await submitSynth(m.files, { top: m.top || undefined, generics })
      const job = await waitForJob(jobId)
      const logArtifact = job.artifacts.find((a) => a.name === "build.log")
      const log = logArtifact ? await fetchText(logArtifact) : ""
      const ok = !!job.result?.ok
      const error = job.result?.error ?? job.error
      if (ok) {
        const netArtifact = job.artifacts.find((a) => a.name === "netlist.json")
        if (!netArtifact) throw new Error("the service returned no netlist")
        const netlist = JSON.parse(await fetchText(netArtifact)) as HdlNetlist
        onChange({ ...latest.current, netlist, built: jobId, builtFrom: key })
      }
      setBuilds((b) => ({ ...b, [id]: { phase: "done", ok, log, error, diagnostics: parseDiagnostics(error && !log.includes(error) ? `${log}\n${error}` : log) } }))
      if (!ok) setLogOpen(true)
    } catch (e) {
      setBuilds((b) => ({ ...b, [id]: { phase: "done", ok: false, log: "", error: (e as Error).message, diagnostics: [] } }))
      setLogOpen(true)
    }
  })

  const addFile = (raw: string) => {
    const path = sourcePath(raw)
    setAdding(null)
    if (!path || !languageOf(path) || files.some((f) => f.path === path)) return
    update({ files: [...files, { path, content: "" }] })
    setActive(path)
  }

  const removeFile = (path: string) => {
    if (files.length <= 1) return
    update({ files: files.filter((f) => f.path !== path) })
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

  const errors = build?.phase === "done" ? build.diagnostics.filter((d) => d.severity === "error").length : 0

  return (
    <div
      data-slot="hdl-panel"
      className={cn("relative flex min-h-0 shrink-0 flex-col border-l bg-background", className)}
      style={{ ...style, width }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onCopy={(e) => e.stopPropagation()}
      onCut={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
      {...props}
    >
      <div className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/40" onPointerDown={onResizeStart} aria-label="Resize HDL panel" />
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b bg-sidebar pr-1 pl-3 text-xs">
        <input
          className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 font-medium hover:border-border focus:border-border focus:bg-background focus:outline-none"
          value={module.name}
          onChange={(e) => update({ name: e.target.value })}
          aria-label="Component name"
        />
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">
          {files.some((f) => languageOf(f.path) === "verilog") ? "Verilog" : "VHDL"}
        </span>
        <Button size="xs" onClick={() => void compile()} disabled={build?.phase === "running" || files.length === 0}>
          {build?.phase === "running" ? <LoaderCircleIcon className="animate-spin" /> : <HammerIcon />}
          Build
        </Button>
        {build?.phase === "done" && !build.ok && (
          <button type="button" className="rounded-sm bg-destructive/10 px-1.5 font-mono text-[0.6875rem] text-destructive" title="Errors in the last build" onClick={() => setLogOpen(true)}>
            {errors || "!"}
          </button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onDelete(module.id)}
          disabled={placed > 0}
          title={placed > 0 ? `Remove its ${placed} instance${placed > 1 ? "s" : ""} from the field first` : "Delete the component"}
          aria-label="Delete component"
        >
          <Trash2Icon />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close HDL panel">
          <XIcon />
        </Button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Top</span>
          <select className="h-6 rounded-md border bg-background px-1 text-xs" value={top ?? ""} onChange={(e) => update({ top: e.target.value || undefined })} aria-label="Top-level unit">
            <option value="">{autoTop ? `auto (${autoTop})` : "auto"}</option>
            {units.map((u) => (
              <option key={`${u.language}:${u.name}`} value={u.name}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        {unit?.generics.map((g) => (
          <label key={g.name} className="flex items-center gap-1.5">
            <span className="font-mono text-muted-foreground">{g.name}</span>
            <input
              className="h-6 w-20 rounded-md border bg-background px-1.5 font-mono text-xs"
              value={module.generics?.[g.name] ?? ""}
              placeholder={g.value || "—"}
              onChange={(e) => {
                const next = { ...latest.current.generics, [g.name]: e.target.value }
                if (!e.target.value) delete next[g.name]
                update({ generics: next })
              }}
            />
          </label>
        ))}
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          {module.netlist && !modified && <CircleCheckIcon className="size-3.5 text-emerald-600" />}
          {module.netlist ? `${module.netlist.top} · ${module.netlist.cells.length} cells` : "not built yet"}
        </span>
      </div>

      {module.netlist && modified && build?.phase !== "running" && (
        <div className="flex shrink-0 items-center gap-1.5 border-b bg-amber-100/70 px-2 py-0.5 text-[11px] text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          Edited since the last build: the field runs the component as it was built. Build to update it.
        </div>
      )}

      <div className="flex h-8 shrink-0 items-stretch border-b bg-sidebar text-xs">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {files.map((f) => (
            <div
              key={f.path}
              className={cn("group flex shrink-0 items-center gap-1 border-r pr-1 pl-3", f.path === active ? "bg-background" : "text-muted-foreground hover:text-foreground")}
            >
              <button type="button" className="font-mono" onClick={() => setActive(f.path)}>
                {f.path}
              </button>
              {files.length > 1 && (
                <button type="button" className="rounded-sm p-0.5 opacity-0 group-hover:opacity-100 hover:bg-muted" onClick={() => removeFile(f.path)} aria-label={`Remove ${f.path}`}>
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
          ))}
          {adding !== null && (
            <input
              autoFocus
              className="w-36 shrink-0 border-r bg-background px-2 font-mono text-xs focus:outline-none"
              value={adding}
              placeholder="name.vhd"
              onChange={(e) => setAdding(e.target.value)}
              onBlur={() => setAdding(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addFile(adding)
                else if (e.key === "Escape") setAdding(null)
              }}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1">
          <Button variant="ghost" size="icon-xs" onClick={() => setAdding("")} title="New file" aria-label="New file">
            <FilePlusIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={() => fileInput.current?.click()} title="Add files from disk" aria-label="Add files from disk">
            <UploadIcon />
          </Button>
        </div>
      </div>

      <HdlEditor ref={editorApi} className="min-h-0 flex-1" moduleId={module.id} files={files} active={active} diagnostics={build?.phase === "done" ? build.diagnostics : []} onWrite={write} />

      {build?.phase === "done" &&
        (logOpen ? (
          <div className="flex h-44 shrink-0 flex-col border-t">
            <div className="flex h-6 shrink-0 items-center border-b bg-sidebar px-2 text-[11px] text-muted-foreground uppercase">
              Output
              <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={() => setLogOpen(false)} aria-label="Close output">
                <XIcon />
              </Button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-[11px] leading-4 whitespace-pre-wrap">
              {build.error && !build.log.includes(build.error) && <div className="text-destructive">{build.error}</div>}
              {build.log.split("\n").map((line, i) => {
                const d = parseDiagnostics(line)[0]
                return (
                  <div
                    key={i}
                    className={cn(d && "cursor-pointer hover:bg-muted", d?.severity === "error" && "text-destructive", d?.severity === "warning" && "text-amber-700 dark:text-amber-300")}
                    onClick={() => {
                      if (!d || !files.some((f) => f.path === d.path)) return
                      setActive(d.path)
                      editorApi.current?.goTo(d.path, d.line, d.col)
                    }}
                  >
                    {line || " "}
                  </div>
                )
              })}
            </pre>
          </div>
        ) : (
          <div className="flex h-6 shrink-0 items-center gap-3 border-t bg-sidebar px-2 text-[11px] text-muted-foreground">
            <button type="button" className="uppercase hover:text-foreground" onClick={() => setLogOpen(true)}>
              output
            </button>
            {build.ok && <span>built in the service</span>}
          </div>
        ))}

      <input
        ref={fileInput}
        type="file"
        multiple
        accept={HDL_ACCEPT}
        className="hidden"
        onChange={async (e) => {
          const list = Array.from(e.target.files ?? [])
          e.target.value = ""
          if (!list.length) return
          const added = await readHdlFiles(list)
          if (!added.length) return
          update({ files: mergeFiles(latest.current.files, added) })
          setActive(added[0]!.path)
        }}
      />
    </div>
  )
}

type HdlEditorProps = {
  ref: React.Ref<{ goTo: (path: string, line: number, col: number) => void } | null>
  className?: string
  moduleId: string
  files: SourceFile[]
  active: string | null
  diagnostics: Diagnostic[]
  onWrite: (path: string, content: string) => void
}

const uriOf = (moduleId: string, path: string) => monaco.Uri.file(`/hdl/${moduleId.replace(/[^\w-]/g, "_")}/${path}`)

function modelFor(moduleId: string, file: SourceFile): monaco.editor.ITextModel {
  const uri = uriOf(moduleId, file.path)
  const known = monaco.editor.getModel(uri)
  if (known) {
    if (known.getValue() !== file.content) known.setValue(file.content)
    return known
  }
  return monaco.editor.createModel(file.content, languageId(file.path), uri)
}

function HdlEditor({ ref, className, moduleId, files, active, diagnostics, onWrite }: HdlEditorProps) {
  const host = React.useRef<HTMLDivElement>(null)
  const [editor, setEditor] = React.useState<CodeEditor | null>(null)

  React.useEffect(() => {
    const ed = monaco.editor.create(host.current!, {
      automaticLayout: true,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
      insertSpaces: true,
      padding: { top: 8 },
      fixedOverflowWidgets: true,
      model: null,
      theme: "vs",
    })
    setEditor(ed)
    return () => ed.dispose()
  }, [])

  const file = files.find((f) => f.path === active) ?? null

  React.useEffect(() => {
    if (!editor) return
    if (!file) {
      editor.setModel(null)
      return
    }
    const model = modelFor(moduleId, file)
    if (editor.getModel() !== model) editor.setModel(model)
  }, [editor, moduleId, file])

  React.useEffect(() => {
    if (!editor) return
    const sub = editor.onDidChangeModelContent(() => {
      const model = editor.getModel()
      if (!model) return
      const path = model.uri.path.split("/").slice(3).join("/")
      onWrite(path, model.getValue())
    })
    return () => sub.dispose()
  }, [editor, onWrite])

  React.useEffect(() => {
    for (const f of files) {
      const model = monaco.editor.getModel(uriOf(moduleId, f.path))
      if (!model) continue
      monaco.editor.setModelMarkers(
        model,
        "hdl",
        diagnostics
          .filter((d) => d.path === f.path)
          .map((d) => ({
            severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
            message: d.message,
            startLineNumber: d.line,
            startColumn: d.col,
            endLineNumber: d.line,
            endColumn: model.getLineMaxColumn(Math.min(Math.max(1, d.line), model.getLineCount())),
          })),
      )
    }
  }, [diagnostics, files, moduleId])

  React.useImperativeHandle(ref, () => ({
    goTo: (path, line, col) => {
      const f = files.find((x) => x.path === path)
      if (!editor || !f) return
      const model = modelFor(moduleId, f)
      if (editor.getModel() !== model) editor.setModel(model)
      editor.setPosition({ lineNumber: line, column: col })
      editor.revealLineInCenter(line)
      editor.focus()
    },
  }))

  return <div ref={host} className={className} />
}
