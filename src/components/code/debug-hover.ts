import { monaco } from "./monaco"
import { expressionAt, objectOf, tabOf } from "./models"

/**
 * The value of what the pointer is over, while a core is stopped: the word under it with its
 * member chain (`htim7.Instance->CNT`), evaluated in the selected frame. The code panel says
 * how (`setDebugHover`); Monaco merges this hover with the symbol documentation.
 */
type Evaluate = (object: string, tab: string, expr: string) => { text: string; type: string } | null
let evaluate: Evaluate | null = null

export function setDebugHover(fn: Evaluate | null) {
  evaluate = fn
}

let registered = false
export function registerDebugHover() {
  if (registered) return
  registered = true
  monaco.languages.registerHoverProvider(["c", "cpp"], {
    provideHover(model, position) {
      if (!evaluate) return null
      const expr = expressionAt(model, position)
      const word = model.getWordAtPosition(position)
      if (!expr || !word || /^\d/.test(word.word)) return null
      const r = evaluate(objectOf(model.uri), tabOf(model.uri), expr)
      if (!r) return null
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [{ value: `\`\`\`c\n${expr} = ${r.text}\n\`\`\`` }, { value: `*${r.type}*` }],
      }
    },
  })
}
