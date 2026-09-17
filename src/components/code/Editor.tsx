import * as React from "react"
import type { SourceFile, Target } from "emul-shared/source"
import { monaco, type Editor as CodeEditor } from "./monaco"
import { registerIntellisense, setContext } from "./intellisense"
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

type EditorProps = Omit<React.ComponentProps<"div">, "ref"> & {
  ref?: React.Ref<EditorHandle>
  /** The board whose files these are; models are kept per board so two `main.c` do not collide. */
  objectId: string
  files: SourceFile[]
  /** The file in the editor; null shows nothing, the tabs are all closed. */
  active: string | null
  /** The chip the code is for: which symbol index answers completions. */
  target: Target
  /** The last build's diagnostics, shown as markers in the files they name. */
  diagnostics: Diagnostic[]
  onWrite: (path: string, content: string) => void
  /** ⌘J inside the editor, where the field's shortcuts do not reach. */
  onToggle: () => void
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
}

const uriOf = (objectId: string, path: string) => monaco.Uri.file(`/${objectId}/${path}`)

/**
 * One Monaco editor for every board: a model per file (so undo history, folding and the
 * cursor survive switching tabs, as in VS Code) and the schematic as the single source of the
 * text. Typing flows editor → document; a load or an undo flows document → editor.
 */
export function Editor({ ref, objectId, files, active, target, diagnostics, onWrite, onToggle, className, ...props }: EditorProps) {
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
      if (ed && model && pathOf(model.uri) === path) reveal(ed, line, col)
      else pending.current = { path, line, col }
    },
  }))

  React.useEffect(() => {
    registerIntellisense()
  }, [])
  React.useEffect(() => {
    setContext({ target, files })
  }, [target, files])
  const views = React.useRef(new Map<string, monaco.editor.ICodeEditorViewState>())
  const write = useEvent(onWrite)
  const toggle = useEvent(onToggle)

  React.useEffect(() => {
    const el = host.current
    if (!el) return
    const ed = monaco.editor.create(el, { ...OPTIONS, model: null, theme: "vs" })
    editor.current = ed
    // ⌘S is a reflex; the code lives in the schematic, so the browser's "save page" must not appear.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {})
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, toggle)
    const sub = ed.onDidChangeModelContent(() => {
      const model = ed.getModel()
      if (model) write(pathOf(model.uri), model.getValue())
    })
    return () => {
      sub.dispose()
      ed.dispose()
      editor.current = null
      for (const m of monaco.editor.getModels()) m.dispose()
    }
  }, [write, toggle])

  // Models follow the board's file list: created on first sight, updated when the document's
  // text moved without the editor (a load, an undo; after typing the two already agree),
  // dropped when the file is gone. Other boards' models rest until they are shown again.
  React.useEffect(() => {
    const keep = new Set<string>()
    for (const f of files) {
      const uri = uriOf(objectId, f.path)
      keep.add(uri.toString())
      const model = monaco.editor.getModel(uri)
      // LF whatever the browser's platform: the file goes to a Linux build, and the document's
      // text has to match the model's byte for byte or this effect would keep resetting it.
      if (!model) monaco.editor.createModel(f.content, undefined, uri).setEOL(monaco.editor.EndOfLineSequence.LF)
      else if (model.getValue() !== f.content) {
        model.setValue(f.content)
        model.setEOL(monaco.editor.EndOfLineSequence.LF)
      }
    }
    for (const m of monaco.editor.getModels()) {
      if (m.uri.path.startsWith(`/${objectId}/`) && !keep.has(m.uri.toString())) {
        views.current.delete(m.uri.toString())
        m.dispose()
      }
    }
  }, [objectId, files])

  // Markers follow the last build: on the files it named, cleared for the rest.
  React.useEffect(() => {
    const byPath = new Map<string, Diagnostic[]>()
    for (const d of diagnostics) if (d.path) byPath.set(d.path, [...(byPath.get(d.path) ?? []), d])
    for (const m of monaco.editor.getModels()) {
      if (!m.uri.path.startsWith(`/${objectId}/`)) continue
      const ds = byPath.get(pathOf(m.uri)) ?? []
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
  }, [objectId, active])

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

/** The project path a model was created at (`/<object>/Core/Src/main.c`). */
const pathOf = (uri: monaco.Uri) => uri.path.split("/").slice(2).join("/")
