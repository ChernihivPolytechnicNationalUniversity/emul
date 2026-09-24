import * as React from "react"
import type { SourceFile, Target } from "emul-shared/source"
import { monaco, type Editor as CodeEditor } from "./monaco"
import { registerIntellisense, setContext } from "./intellisense"
import { registerDebugHover } from "./debug-hover"
import { expressionAt, isDoc, tabOf, uriOf } from "./models"
import type { Diagnostic } from "@/project/diagnostics"
import { useEvent } from "@/hooks/use-event"
import { cn } from "@/lib/utils"

/** What the menu's Undo/Redo need: whether the text has the focus, and the editor's own history. */
export type EditorHandle = {
  focused: () => boolean
  undo: () => void
  redo: () => void
  /** Put the cursor on a place in a file the panel has just made active (or is about to). */
  goTo: (path: string, line: number, col: number) => void
}

/** A breakpoint in the gutter: set and landing on code, set where the image has none, or turned off. */
export type GutterBreakpoint = { line: number; state: "verified" | "unverified" | "disabled" }
/** Where the core is (`top`), or where the selected caller's frame is (`frame`). */
export type ExecMark = { line: number; kind: "top" | "frame" }
/** What F5/F9/F10/F11 and the debug entries of the context menu ask for. */
export type DebugKey = "continue" | "stepOver" | "stepInto" | "stepOut" | "stepInstruction" | "toggleBreakpoint" | "runToCursor" | "restart"

type EditorProps = Omit<React.ComponentProps<"div">, "ref"> & {
  ref?: React.Ref<EditorHandle>
  /** The board whose files these are; models are kept per board so two `main.c` do not collide. */
  objectId: string
  files: SourceFile[]
  /** Read-only documents beside the project (sources added for the debugger, ST's library), by tab id. */
  docs: { id: string; content: string }[]
  /** The file in the editor; null shows nothing, the tabs are all closed. */
  active: string | null
  /** The chip the code is for: which symbol index answers completions. */
  target: Target
  /** The last build's diagnostics, shown as markers in the files they name. */
  diagnostics: Diagnostic[]
  /** Breakpoints of the active file. */
  breakpoints: GutterBreakpoint[]
  exec: ExecMark | null
  /** Values of the current function's variables, shown after the lines that use them. */
  inline: Map<number, string> | null
  onWrite: (path: string, content: string) => void
  /** ⌘J inside the editor, where the field's shortcuts do not reach. */
  onToggle: () => void
  onDebugKey: (key: DebugKey, line: number) => void
  /** Edits moved breakpoint lines: the line each was on and the one it is on now. */
  onBreakpointsMoved: (moves: [number, number][]) => void
  onAddWatch: (expr: string) => void
}

const OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: true, renderCharacters: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: "all",
  tabSize: 2,
  insertSpaces: true,
  bracketPairColorization: { enabled: true },
  stickyScroll: { enabled: true },
  padding: { top: 8 },
  fixedOverflowWidgets: true,
  glyphMargin: true,
}


/**
 * Models of an editor that went away, disposed a moment later: a request the editor had in
 * flight on one (a word highlight after a jump to a line) must not find it gone. An editor
 * mounted meanwhile (a remount, the panel opened again) takes its models back.
 */
const leaving = new Set<monaco.editor.ITextModel>()
let leaveTimer: ReturnType<typeof setTimeout> | undefined
function disposeLater(models: monaco.editor.ITextModel[]) {
  for (const m of models) leaving.add(m)
  clearTimeout(leaveTimer)
  leaveTimer = setTimeout(() => {
    for (const m of leaving) if (!m.isDisposed()) m.dispose()
    leaving.clear()
  }, 1000)
}

/**
 * One Monaco editor for every board: a model per file (so undo history, folding and the
 * cursor survive switching tabs, as in VS Code) and the schematic as the single source of the
 * text. Typing flows editor → document; a load or an undo flows document → editor. The
 * debugger draws in it: breakpoints in the gutter (moving with the lines they are on), the
 * line the core is at, the values of the variables beside the lines that use them.
 */
export function Editor({ ref, objectId, files, docs, active, target, diagnostics, breakpoints, exec, inline, onWrite, onToggle, onDebugKey, onBreakpointsMoved, onAddWatch, className, ...props }: EditorProps) {
  const host = React.useRef<HTMLDivElement>(null)
  const editor = React.useRef<CodeEditor | null>(null)
  /** A goTo for a file that is not the editor's model yet; the active effect takes it. */
  const pending = React.useRef<{ path: string; line: number; col: number } | null>(null)
  const reveal = (ed: CodeEditor, line: number, col: number) => {
    ed.setPosition({ lineNumber: line, column: col })
    ed.revealPositionInCenterIfOutsideViewport({ lineNumber: line, column: col })
    ed.focus()
  }
  React.useImperativeHandle(ref, () => ({
    focused: () => !!editor.current?.hasTextFocus(),
    undo: () => editor.current?.trigger("menu", "undo", null),
    redo: () => editor.current?.trigger("menu", "redo", null),
    goTo: (path, line, col) => {
      const ed = editor.current
      const model = ed?.getModel()
      if (ed && model && tabOf(model.uri) === path) reveal(ed, line, col)
      else pending.current = { path, line, col }
    },
  }))

  React.useEffect(() => {
    registerIntellisense()
    registerDebugHover()
  }, [])
  React.useEffect(() => {
    setContext({ target, files })
  }, [target, files])
  const views = React.useRef(new Map<string, monaco.editor.ICodeEditorViewState>())
  const write = useEvent(onWrite)
  const toggle = useEvent(onToggle)
  const debugKey = useEvent(onDebugKey)
  const moved = useEvent(onBreakpointsMoved)
  const addWatch = useEvent(onAddWatch)
  /** The editor's own marks (the core's line, inline values): made with each editor, so a remount (StrictMode) does not keep a dead one. */
  const marks = React.useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  /** The breakpoint decorations (on the model they are in) and the lines they were set on, to tell when an edit moves them. */
  const bpDecorations = React.useRef<{ model: monaco.editor.ITextModel | null; ids: string[]; lines: number[] }>({ model: null, ids: [], lines: [] })

  React.useEffect(() => {
    const el = host.current
    if (!el) return
    const ed = monaco.editor.create(el, { ...OPTIONS, model: null, theme: "vs" })
    editor.current = ed
    marks.current = ed.createDecorationsCollection()
    const line = () => ed.getPosition()?.lineNumber ?? 1
    // ⌘S is a reflex; the code lives in the schematic, so the browser's "save page" must not appear.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {})
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, toggle)
    // The debugger's keys, as in VS Code (F5 would reload the page if it got past).
    ed.addCommand(monaco.KeyCode.F5, () => debugKey("continue", line()))
    ed.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.CtrlCmd | monaco.KeyCode.F5, () => debugKey("restart", line()))
    ed.addCommand(monaco.KeyCode.F9, () => debugKey("toggleBreakpoint", line()))
    ed.addCommand(monaco.KeyCode.F10, () => debugKey("stepOver", line()))
    ed.addCommand(monaco.KeyCode.F11, () => debugKey("stepInto", line()))
    ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F11, () => debugKey("stepOut", line()))
    ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.F11, () => debugKey("stepInstruction", line()))
    ed.addAction({ id: "emul.runToCursor", label: "Run to Cursor", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F10], contextMenuGroupId: "debug", contextMenuOrder: 1, run: () => debugKey("runToCursor", line()) })
    ed.addAction({ id: "emul.toggleBreakpoint", label: "Toggle Breakpoint", contextMenuGroupId: "debug", contextMenuOrder: 2, run: () => debugKey("toggleBreakpoint", line()) })
    ed.addAction({
      id: "emul.addWatch",
      label: "Add to Watch",
      contextMenuGroupId: "debug",
      contextMenuOrder: 3,
      run: () => {
        const model = ed.getModel()
        const sel = ed.getSelection()
        if (!model || !sel) return
        const text = sel.isEmpty() ? expressionAt(model, sel.getPosition()) : model.getValueInRange(sel)
        if (text?.trim()) addWatch(text.trim())
      },
    })
    // The gutter: a click sets or clears a breakpoint; the pointer shows where one would go.
    const hint = ed.createDecorationsCollection()
    const subs = [
      ed.onMouseDown((e) => {
        if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return
        debugKey("toggleBreakpoint", e.target.position.lineNumber)
      }),
      ed.onMouseMove((e) => {
        const p = e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ? e.target.position : null
        hint.set(p ? [{ range: new monaco.Range(p.lineNumber, 1, p.lineNumber, 1), options: { glyphMarginClassName: "dbg-bp-hint" } }] : [])
      }),
      ed.onMouseLeave(() => hint.clear()),
      ed.onDidChangeModelContent(() => {
        const model = ed.getModel()
        if (!model) return
        if (!isDoc(model.uri)) write(tabOf(model.uri), model.getValue())
        // Breakpoints ride along with the lines they are on.
        const d = bpDecorations.current
        if (d.model !== model) return
        const moves: [number, number][] = []
        d.ids.forEach((id, i) => {
          const r = model.getDecorationRange(id)
          if (r && r.startLineNumber !== d.lines[i]) moves.push([d.lines[i], r.startLineNumber])
        })
        if (moves.length) {
          d.lines = d.ids.map((id, i) => model.getDecorationRange(id)?.startLineNumber ?? d.lines[i])
          moved(moves)
        }
      }),
    ]
    return () => {
      for (const s of subs) s.dispose()
      ed.setModel(null)
      ed.dispose()
      editor.current = null
      marks.current = null
      disposeLater(monaco.editor.getModels())
    }
  }, [write, toggle, debugKey, moved, addWatch])

  // Models follow the board's file list: created on first sight, updated when the document's
  // text moved without the editor (a load, an undo; after typing the two already agree),
  // dropped when the file is gone. Other boards' models rest until they are shown again.
  React.useEffect(() => {
    const keep = new Set<string>()
    const sync = (id: string, content: string) => {
      const uri = uriOf(objectId, id)
      keep.add(uri.toString())
      const model = monaco.editor.getModel(uri)
      if (model) leaving.delete(model)
      // LF whatever the browser's platform: the file goes to a Linux build, and the document's
      // text has to match the model's byte for byte or this effect would keep resetting it.
      if (!model) monaco.editor.createModel(content, undefined, uri).setEOL(monaco.editor.EndOfLineSequence.LF)
      else if (model.getValue() !== content) {
        model.setValue(content)
        model.setEOL(monaco.editor.EndOfLineSequence.LF)
      }
    }
    for (const f of files) sync(f.path, f.content)
    for (const d of docs) sync(d.id, d.content.replace(/\r\n?/g, "\n"))
    for (const m of monaco.editor.getModels()) {
      if (m.uri.path.startsWith(`/${objectId}/`) && !keep.has(m.uri.toString())) {
        views.current.delete(m.uri.toString())
        m.dispose()
      }
    }
  }, [objectId, files, docs])

  // Markers follow the last build: on the files it named, cleared for the rest.
  React.useEffect(() => {
    const byPath = new Map<string, Diagnostic[]>()
    for (const d of diagnostics) if (d.path) byPath.set(d.path, [...(byPath.get(d.path) ?? []), d])
    for (const m of monaco.editor.getModels()) {
      if (!m.uri.path.startsWith(`/${objectId}/`) || isDoc(m.uri)) continue
      const ds = byPath.get(tabOf(m.uri)) ?? []
      monaco.editor.setModelMarkers(
        m,
        "gcc",
        ds.map((d) => {
          const word = m.getWordAtPosition({ lineNumber: d.line, column: d.col })
          return {
            severity: d.severity === "error" ? monaco.MarkerSeverity.Error : d.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Hint,
            message: d.message,
            startLineNumber: d.line,
            startColumn: d.col,
            endLineNumber: d.line,
            endColumn: word && word.startColumn <= d.col ? word.endColumn : d.col + 1,
            source: "gcc",
          }
        }),
      )
    }
  }, [objectId, files, diagnostics])

  React.useEffect(() => {
    const ed = editor.current
    if (!ed) return
    const before = ed.getModel()
    if (before) {
      const state = ed.saveViewState()
      if (state) views.current.set(before.uri.toString(), state)
    }
    const model = active ? monaco.editor.getModel(uriOf(objectId, active)) : null
    ed.setModel(model)
    ed.updateOptions({ readOnly: !!model && isDoc(model.uri), domReadOnly: !!model && isDoc(model.uri) })
    if (model) {
      const state = views.current.get(model.uri.toString())
      if (state) ed.restoreViewState(state)
      ed.focus()
      const go = pending.current
      if (go && go.path === active) {
        pending.current = null
        reveal(ed, go.line, go.col)
      }
    }
  }, [objectId, active, docs])

  // The debugger's marks on the active file: breakpoints, the core's line, inline values.
  React.useEffect(() => {
    const model = editor.current?.getModel() ?? null
    const d = bpDecorations.current
    if (d.model && d.model !== model && !d.model.isDisposed()) d.model.deltaDecorations(d.ids, [])
    if (!model) {
      bpDecorations.current = { model: null, ids: [], lines: [] }
      return
    }
    const lines = model.getLineCount()
    const shown = breakpoints.filter((b) => b.line >= 1 && b.line <= lines)
    const ids = model.deltaDecorations(
      d.model === model ? d.ids : [],
      shown.map((b) => ({
        range: new monaco.Range(b.line, 1, b.line, 1),
        options: {
          glyphMarginClassName: `dbg-bp dbg-bp-${b.state}`,
          glyphMarginHoverMessage: { value: b.state === "verified" ? "Breakpoint" : b.state === "disabled" ? "Breakpoint (off)" : "Breakpoint: no code of the program is on this line" },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    )
    bpDecorations.current = { model, ids, lines: shown.map((b) => b.line) }
  }, [breakpoints, active, docs, files])
  React.useEffect(() => {
    const ed = editor.current
    const model = ed?.getModel()
    if (!ed || !model || !marks.current) return
    const out: monaco.editor.IModelDeltaDecoration[] = []
    const lines = model.getLineCount()
    if (exec && exec.line >= 1 && exec.line <= lines) {
      out.push({ range: new monaco.Range(exec.line, 1, exec.line, 1), options: { isWholeLine: true, className: exec.kind === "top" ? "dbg-exec-line" : "dbg-frame-line", glyphMarginClassName: exec.kind === "top" ? "dbg-exec-arrow" : "dbg-frame-arrow", stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } })
      ed.revealLineInCenterIfOutsideViewport(exec.line)
    }
    if (inline)
      for (const [line, text] of inline) {
        if (line < 1 || line > lines) continue
        const end = model.getLineMaxColumn(line)
        out.push({ range: new monaco.Range(line, end, line, end), options: { after: { content: `  ${text}`, inlineClassName: "dbg-inline-value" }, showIfCollapsed: true } })
      }
    marks.current.set(out)
  }, [exec, inline, active, docs, files])

  return (
    <div data-slot="editor" className={cn("relative min-h-0 min-w-0 flex-1", className)} {...props}>
      <div ref={host} className="absolute inset-0" />
      {!active && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Pick a file in the explorer
        </div>
      )}
    </div>
  )
}
