import type { SourceFile, Target } from "emul-shared/source"
import { documentation, loadSymbols, signature, type Sym, type SymbolIndex } from "@/project/symbols"
import { monaco } from "./monaco"

/**
 * Completion, hover and signature help for C on an STM32, without a language server: the
 * chip's symbol index (HAL, CMSIS, the device header — see `scripts/symbols.ts`) plus what
 * the project's own files declare, found with the same regular expressions. `#include "…"`
 * completes to the project's headers and the HAL's. `x->` and `x.` complete to the members
 * of x's struct when x is a peripheral (`GPIOA`) or a variable declared with a `…TypeDef`.
 */

type Context = { target: Target; files: SourceFile[] }
let context: Context | null = null
let index: SymbolIndex | null = null
let indexFor: Target | null = null
let projectCache: { files: SourceFile[]; symbols: Sym[] } | null = null

/** Called by the editor whenever the board or its files change. */
export function setContext(next: Context) {
  context = next
  if (indexFor !== next.target) {
    indexFor = next.target
    index = null
    loadSymbols(next.target).then(
      (ix) => {
        if (indexFor === next.target) index = ix
      },
      () => {
        // No index served (a dev build without `pnpm symbols`): the project's own symbols still work.
      },
    )
  }
}

const LANGUAGES = ["c", "cpp"]
const WORD = /[A-Za-z_]\w*/

/** The project's functions, macros and types, re-scanned when the files change. */
function projectSymbols(): Sym[] {
  if (!context) return []
  if (projectCache && projectCache.files === context.files) return projectCache.symbols
  const symbols: Sym[] = []
  for (const f of context.files) {
    if (!/\.(c|h|cpp|hpp|cc)$/i.test(f.path)) continue
    const file = f.path.slice(f.path.lastIndexOf("/") + 1)
    for (const m of f.content.matchAll(/(?:^|\n)((?:static\s+|inline\s+|extern\s+|const\s+|unsigned\s+|volatile\s+)*[A-Za-z_]\w*(?:\s*\*+|\s+)+)([A-Za-z_]\w*)\s*\(([^;{}()]*)\)\s*(?:\{|;)/g)) {
      const ret = m[1]!.replace(/\b(static|inline|extern)\b/g, "").replace(/\s+/g, " ").trim()
      if (!ret || /^(return|else|typedef)$/.test(ret) || /^(if|for|while|switch|sizeof)$/.test(m[2]!)) continue
      const params = m[3]!.replace(/\s+/g, " ").trim()
      symbols.push({
        kind: "function",
        name: m[2]!,
        ret,
        params:
          params && params !== "void"
            ? params.split(",").map((p) => {
                const t = p.trim()
                const d = /^(.*?)\s*\**\s*([A-Za-z_]\w*)$/.exec(t)
                return d ? { type: t.slice(0, t.length - d[2]!.length).trim(), name: d[2]! } : { type: t, name: "" }
              })
            : [],
        file,
      })
    }
    for (const m of f.content.matchAll(/(?:^|\n)[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(\([^)]*\))?[ \t]*([^\n]*)/g)) {
      symbols.push({ kind: "macro", name: m[1]!, params: m[2] ? m[2].slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean) : undefined, value: m[3]!.trim(), file })
    }
    for (const m of f.content.matchAll(/typedef\s+(struct|enum)\s*\w*\s*\{([\s\S]*?)\}\s*([A-Za-z_]\w*)\s*;/g)) {
      const members = [...m[2]!.matchAll(/^\s*(?:[\w\s*]+?\s+)?\**([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*[;,=]/gm)].map((x) => ({ name: x[1]! }))
      symbols.push({ kind: "type", name: m[3]!, of: m[1] as "struct" | "enum", members, file })
    }
  }
  projectCache = { files: context.files, symbols }
  return symbols
}

function lookup(name: string): Sym[] {
  const own = projectSymbols().filter((s) => s.name === name)
  return own.length ? own : (index?.byName.get(name) ?? [])
}

/** The struct a base expression has: `GPIOA` → GPIO_TypeDef, `gpio` → what its declaration says. */
function structOf(base: string, model: monaco.editor.ITextModel): Sym | undefined {
  const byName = (name: string) => [...projectSymbols(), ...(index?.symbols ?? [])].find((s) => s.kind === "type" && s.name === name)
  for (const s of lookup(base)) {
    if (s.kind === "macro") {
      const m = /\(\s*\(\s*([A-Za-z_]\w*)\s*\*\s*\)/.exec(s.value)
      if (m) return byName(m[1]!)
    }
  }
  // A declaration in the open file: `GPIO_InitTypeDef gpio`, `TIM_HandleTypeDef *htim`.
  const decl = new RegExp(`\\b([A-Za-z_]\\w*)\\s*\\*?\\s*\\b${base}\\b\\s*(?:=|;|,|\\)|\\[)`, "g")
  for (const m of model.getValue().matchAll(decl)) {
    const t = byName(m[1]!)
    if (t) return t
  }
  return undefined
}

const KIND: Record<Sym["kind"], monaco.languages.CompletionItemKind> = {
  function: monaco.languages.CompletionItemKind.Function,
  macro: monaco.languages.CompletionItemKind.Constant,
  type: monaco.languages.CompletionItemKind.Struct,
  enumerator: monaco.languages.CompletionItemKind.EnumMember,
}

function item(s: Sym, range: monaco.IRange): monaco.languages.CompletionItem {
  const callable = s.kind === "function" || (s.kind === "macro" && s.params)
  const params = s.kind === "function" ? s.params.map((p) => p.name || p.type) : s.kind === "macro" ? (s.params ?? []) : []
  return {
    label: { label: s.name, detail: callable ? `(${params.join(", ")})` : undefined, description: s.kind === "function" ? s.ret : s.kind === "enumerator" ? s.type : undefined },
    kind: s.kind === "macro" && s.params ? monaco.languages.CompletionItemKind.Function : KIND[s.kind],
    detail: signature(s),
    documentation: { value: documentation(s) },
    insertText: callable ? `${s.name}(${params.map((p, i) => `\${${i + 1}:${p}}`).join(", ")})` : s.name,
    insertTextRules: callable ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    sortText: (s.kind === "function" ? "1" : s.kind === "enumerator" ? "2" : s.kind === "macro" ? "3" : "4") + s.name,
    range,
  }
}

let registered = false

/** Register the providers once; they read `context` and the index as they go. */
export function registerIntellisense() {
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider(LANGUAGES, {
    triggerCharacters: [".", ">", '"', "<"],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const range: monaco.IRange = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
      const line = model.getLineContent(position.lineNumber)
      const before = line.slice(0, word.startColumn - 1)

      const include = /^\s*#\s*include\s*(["<])([^">]*)$/.exec(before)
      if (include) {
        const own = (context?.files ?? []).filter((f) => /\.(h|hpp)$/i.test(f.path)).map((f) => f.path.slice(f.path.lastIndexOf("/") + 1))
        const names = include[1] === '"' ? [...new Set([...own, ...(index?.headers ?? [])])] : (index?.headers ?? [])
        const close = include[1] === '"' ? '"' : ">"
        const rest = line.slice(word.endColumn - 1)
        return {
          suggestions: names.map((n, i) => ({
            label: n,
            kind: monaco.languages.CompletionItemKind.File,
            insertText: rest.startsWith(close) ? n : n + close,
            sortText: (own.includes(n) ? "0" : "1") + String(i).padStart(4, "0"),
            range,
          })),
        }
      }

      const member = /([A-Za-z_]\w*)\s*(->|\.)\s*$/.exec(before)
      if (member) {
        const type = structOf(member[1]!, model)
        if (type?.kind === "type" && type.members) {
          return {
            suggestions: type.members.map((m) => ({
              label: { label: m.name, description: m.type },
              kind: monaco.languages.CompletionItemKind.Field,
              detail: m.type ? `${m.type} ${m.name}` : m.name,
              documentation: m.doc,
              insertText: m.name,
              range,
            })),
          }
        }
        return { suggestions: [] }
      }

      const seen = new Set<string>()
      const suggestions: monaco.languages.CompletionItem[] = []
      for (const s of projectSymbols()) {
        if (seen.has(s.name)) continue
        seen.add(s.name)
        suggestions.push(item(s, range))
      }
      for (const s of index?.symbols ?? []) {
        if (seen.has(s.name)) continue
        seen.add(s.name)
        suggestions.push(item(s, range))
      }
      return { suggestions }
    },
  })

  monaco.languages.registerHoverProvider(LANGUAGES, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position)
      if (!word) return null
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1)
      const member = /([A-Za-z_]\w*)\s*(->|\.)\s*$/.exec(before)
      if (member) {
        const type = structOf(member[1]!, model)
        const m = type?.kind === "type" ? type.members?.find((x) => x.name === word.word) : undefined
        if (!m || !type) return null
        return { range, contents: [{ value: "```c\n" + `${m.type ?? ""} ${type.name}::${m.name}`.trim() + "\n```" }, ...(m.doc ? [{ value: m.doc }] : [])] }
      }
      const syms = lookup(word.word)
      if (!syms.length) return null
      return { range, contents: syms.slice(0, 2).map((s) => ({ value: documentation(s) })) }
    },
  })

  monaco.languages.registerSignatureHelpProvider(LANGUAGES, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp(model, position) {
      // Walk back over the text before the cursor to the unclosed "(" and the name before it.
      const text = model.getValueInRange({ startLineNumber: Math.max(1, position.lineNumber - 20), startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column })
      let depth = 0
      let commas = 0
      let open = -1
      for (let i = text.length - 1; i >= 0; i--) {
        const ch = text[i]
        if (ch === ")" || ch === "]") depth++
        else if (ch === "(" || ch === "[") {
          if (depth === 0 && ch === "(") {
            open = i
            break
          }
          depth--
        } else if (ch === "," && depth === 0) commas++
        else if (ch === ";" && depth === 0) return null
      }
      if (open < 0) return null
      const name = WORD.exec(text.slice(0, open).match(/([A-Za-z_]\w*)\s*$/)?.[1] ?? "")?.[0]
      if (!name) return null
      const syms = lookup(name).filter((s) => s.kind === "function" || (s.kind === "macro" && s.params))
      if (!syms.length) return null
      const signatures = syms.map((s) => ({
        label: signature(s),
        documentation: s.doc ? { value: s.doc } : undefined,
        parameters:
          s.kind === "function"
            ? s.params.map((p) => ({ label: `${p.type} ${p.name}`.trim(), documentation: p.doc ? { value: p.doc } : undefined }))
            : (s.kind === "macro" ? (s.params ?? []) : []).map((p) => ({ label: p })),
      }))
      return {
        value: { signatures, activeSignature: 0, activeParameter: Math.min(commas, Math.max(0, (signatures[0]?.parameters.length ?? 1) - 1)) },
        dispose() {},
      }
    },
  })
}
