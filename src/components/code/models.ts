import { monaco } from "./monaco"

/**
 * Where the editor keeps a board's documents: project files at `/<object>/<path>`, read-only
 * ones (sources added for the debugger, ST's library) under `/<object>/@doc/` with their tab
 * id encoded, so the extension still tells Monaco the language.
 */
const DOC = "@doc"

export const uriOf = (objectId: string, id: string) => (id.startsWith("@") ? monaco.Uri.file(`/${objectId}/${DOC}/${encodeURIComponent(id)}`) : monaco.Uri.file(`/${objectId}/${id}`))

/** The tab id a model was created for: a project path, or a read-only document's id. */
export const tabOf = (uri: monaco.Uri) => {
  const parts = uri.path.split("/")
  return parts[2] === DOC ? decodeURIComponent(parts.slice(3).join("/")) : parts.slice(2).join("/")
}
export const objectOf = (uri: monaco.Uri) => uri.path.split("/")[1] ?? ""
export const isDoc = (uri: monaco.Uri) => uri.path.split("/")[2] === DOC

/**
 * The expression under the cursor for a hover or a watch: the word, with the member chain
 * before it (`uart.Init.BaudRate`, `hdma->Instance`, `buf[i].x`).
 */
export function expressionAt(model: monaco.editor.ITextModel, pos: monaco.IPosition): string | null {
  const word = model.getWordAtPosition(pos)
  if (!word) return null
  const line = model.getLineContent(pos.lineNumber)
  let start = word.startColumn - 1
  const end = word.endColumn - 1
  for (;;) {
    const m = /(?:\w+(?:\[[^\]]*\])*(?:\.|->))$/.exec(line.slice(0, start))
    if (!m) break
    start -= m[0].length
  }
  return line.slice(start, end)
}
