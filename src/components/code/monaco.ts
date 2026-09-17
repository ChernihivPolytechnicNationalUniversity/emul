// The editor from VS Code, cut down to what a firmware project needs: the editor with all of
// its features (find, folding, multi-cursor, command palette) and the C/C++ grammar, without
// the TypeScript/CSS/JSON language services the default bundle drags in.
import * as monaco from "monaco-editor/editor/editor.api"
import "monaco-editor/features/register.all"
import "monaco-editor/languages/definitions/cpp/register"
import "monaco-editor/languages/definitions/markdown/register"
import EditorWorker from "monaco-editor/editor/editor.worker?worker"

// Tokenization and word-based suggestions run off the main thread. One worker serves every model.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

export { monaco }
export type Editor = monaco.editor.IStandaloneCodeEditor
export type Model = monaco.editor.ITextModel
