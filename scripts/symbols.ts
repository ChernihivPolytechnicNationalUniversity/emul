/**
 * The editor's knowledge of a chip: every function, macro, type and enumerator of ST's HAL,
 * the device header and the CMSIS core, with their doxygen text, as one JSON per target for
 * the completion, hover and signature providers (src/project/symbols.ts). Built from the same
 * pinned sources the worker compiles against (backend/worker/toolchain/stage-st.sh), at site
 * build time; a regex pass over the headers is enough for a reference this regular.
 *
 *   pnpm symbols <st root> <out dir>      e.g. pnpm symbols /tmp/st public/symbols
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type Param = { type: string; name: string; doc?: string }
export type Sym =
  | { kind: "function"; name: string; ret: string; params: Param[]; doc?: string; retval?: string; file: string }
  | { kind: "macro"; name: string; params?: string[]; value: string; doc?: string; file: string }
  | { kind: "type"; name: string; of: "struct" | "enum" | "alias"; members?: { name: string; type?: string; doc?: string }[]; doc?: string; file: string }
  | { kind: "enumerator"; name: string; type: string; value?: string; doc?: string; file: string }
export type Index = { target: string; symbols: Sym[]; headers: string[] }

const st = process.argv[2]
const out = process.argv[3]
if (!st || !out) {
  console.error("usage: pnpm symbols <st root> <out dir>")
  process.exit(1)
}

const targetsDir = join(import.meta.dirname, "..", "backend", "worker", "targets")

/** The text of a doxygen block, one line per tag: "@brief …", "@param x …". */
function docOf(block: string | undefined): { doc?: string; params: Record<string, string>; retval?: string } {
  if (!block) return { params: {} }
  const lines = block
    .split("\n")
    .map((l) => l.replace(/^\s*\/?\*+\/?\s?/, "").replace(/\s*\*\/\s*$/, "").trimEnd())
    .filter((l) => !/^@\{|^@\}|^\s*$/.test(l))
  const params: Record<string, string> = {}
  let brief = ""
  let retval: string | undefined
  let cur: { kind: "brief" | "param" | "retval" | "other"; name?: string } = { kind: "other" }
  for (const raw of lines) {
    const l = raw.replace(/^[@\\](brief|details|note|param|retval|return|arg|warning)\b/, "@$1")
    const tag = /^@(\w+)\s*(?:\[[^\]]*\]\s*)?(.*)$/.exec(l)
    if (tag) {
      const [, t, rest] = tag
      if (t === "brief" || t === "details") {
        brief += (brief ? "\n" : "") + rest
        cur = { kind: "brief" }
      } else if (t === "param") {
        const m = /^(\w+)\s*(.*)$/.exec(rest!)
        if (m) {
          params[m[1]!] = m[2]!
          cur = { kind: "param", name: m[1] }
        }
      } else if (t === "retval" || t === "return") {
        retval = retval ? `${retval}; ${rest}` : rest
        cur = { kind: "retval" }
      } else if (t === "note" || t === "warning") {
        brief += `\n\n*${t}:* ${rest}`
        cur = { kind: "brief" }
      } else cur = { kind: "other" }
    } else if (cur.kind === "brief") brief += " " + l.trim()
    else if (cur.kind === "param") params[cur.name!] += " " + l.trim()
    else if (cur.kind === "retval") retval += " " + l.trim()
  }
  return { doc: brief.trim() || undefined, params, retval }
}

/** Split "GPIO_TypeDef *GPIOx, uint16_t GPIO_Pin" into typed names. */
function paramsOf(list: string): Param[] {
  const s = list.replace(/\s+/g, " ").trim()
  if (!s || s === "void") return []
  return s.split(",").map((p) => {
    const t = p.trim()
    const m = /^(.*?)\s*\**\s*([A-Za-z_]\w*)\s*(\[[^\]]*\])?$/.exec(t)
    if (!m || !m[1]) return { type: t, name: "" }
    const stars = t.slice(m[1].length, t.indexOf(m[2]!)).replace(/\s/g, "")
    return { type: (m[1] + stars).trim(), name: m[2]! + (m[3] ?? "") }
  })
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "return", "sizeof", "do", "else", "defined"])

/** Every symbol in one file. Doc blocks are the `/** … *\/` right before a declaration. */
function scan(text: string, file: string, syms: Sym[]) {
  const src = text.replace(/\r\n?/g, "\n")
  const seen = new Set<string>()
  const add = (s: Sym) => {
    const key = `${s.kind}:${s.name}`
    if (seen.has(key)) return
    seen.add(key)
    syms.push(s)
  }
  const DOC = "(?:/\\*\\*(?:(?!\\*/)[\\s\\S])*?\\*/\\s*)?"

  // Functions defined or declared at the top level, with the comment before them.
  const fn = new RegExp(`(?:^|\\n)(${DOC})((?:__STATIC_INLINE|__STATIC_FORCEINLINE|static\\s+inline|static|inline|extern|__weak|__WEAK|__IO|const|volatile|unsigned|signed|struct|enum)?[\\w\\s\\*]*?)\\b([A-Za-z_]\\w*)\\s*\\(([^;{}()]*)\\)\\s*(?:\\{|;)`, "g")
  for (const m of src.matchAll(fn)) {
    const [, docBlock, retRaw, name, params] = m
    const ret = retRaw!.replace(/\b(__STATIC_INLINE|__STATIC_FORCEINLINE|static|inline|extern|__weak|__WEAK)\b/g, "").replace(/\s+/g, " ").trim()
    if (!ret || KEYWORDS.has(name!) || /^(typedef|return|else)$/.test(ret) || ret.includes("#") || name!.startsWith("__ASM")) continue
    if (/^[A-Z_]+$/.test(name!) && !name!.includes("_")) continue
    const d = docOf(docBlock)
    const ps = paramsOf(params!).map((p) => (d.params[p.name] ? { ...p, doc: d.params[p.name] } : p))
    add({ kind: "function", name: name!, ret, params: ps, doc: d.doc, retval: d.retval, file })
  }

  // Macros: object-like and function-like, with the trailing or leading comment as doc.
  const mac = new RegExp(`(?:^|\\n)(${DOC})[ \\t]*#[ \\t]*define[ \\t]+([A-Za-z_]\\w*)(\\([^)]*\\))?[ \\t]*((?:[^\\n\\\\]|\\\\\\n)*)`, "g")
  for (const m of src.matchAll(mac)) {
    const [, docBlock, name, args, valueRaw] = m
    if (/_H__?$|_H$/i.test(name!) && !valueRaw!.trim()) continue
    let value = valueRaw!.replace(/\\\n/g, " ")
    let doc = docOf(docBlock).doc
    const trailing = /\/\*!?<?\s*([\s\S]*?)\*\/\s*$/.exec(value)
    if (trailing) {
      doc ??= trailing[1]!.replace(/\s+/g, " ").trim()
      value = value.slice(0, trailing.index)
    }
    value = value.replace(/\s+/g, " ").trim()
    if (value.length > 120) value = value.slice(0, 117) + "…"
    add({ kind: "macro", name: name!, params: args ? args.slice(1, -1).split(",").map((a) => a.trim()).filter(Boolean) : undefined, value, doc, file })
  }

  // typedef struct { … } Name; and typedef enum { … } Name;
  const agg = new RegExp(`(?:^|\\n)(${DOC})typedef\\s+(struct|enum)\\s*(?:\\w+\\s*)?\\{([\\s\\S]*?)\\}\\s*([A-Za-z_]\\w*)\\s*;`, "g")
  for (const m of src.matchAll(agg)) {
    const [, docBlock, of, body, name] = m
    const doc = docOf(docBlock).doc
    if (of === "struct") {
      const members: { name: string; type?: string; doc?: string }[] = []
      // One member per line, its comment after the semicolon: comments are folded onto one line first.
      const flat = body!.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/\s*\n\s*\*?\s*/g, " "))
      for (const line of flat.split("\n")) {
        const dd = /^\s*(?:(?:__IO|__I|__O)\s+)?([\w\s*]+?)\s*\**\s*([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;\s*(?:\/\*!?<?\s*([\s\S]*?)\*\/)?/.exec(line)
        if (!dd) continue
        members.push({ name: dd[2]! + (dd[3] ?? ""), type: dd[1]!.trim() || undefined, doc: dd[4]?.replace(/\s+/g, " ").trim() || undefined })
      }
      add({ kind: "type", name: name!, of, members, doc, file })
    } else {
      const members: { name: string; doc?: string }[] = []
      for (const line of body!.split("\n")) {
        const em = /^\s*([A-Za-z_]\w*)\s*(?:=\s*([^,/]+?))?\s*,?\s*(?:\/\*!?<?\s*([\s\S]*?)\*\/)?\s*$/.exec(line)
        if (!em || !em[1]) continue
        const edoc = em[3]?.replace(/\s+/g, " ").trim()
        members.push({ name: em[1], doc: edoc })
        add({ kind: "enumerator", name: em[1], type: name!, value: em[2]?.trim(), doc: edoc, file })
      }
      add({ kind: "type", name: name!, of, members, doc, file })
    }
  }
  // typedef Base Name;
  for (const m of src.matchAll(/(?:^|\n)typedef\s+((?:const\s+|unsigned\s+|signed\s+|struct\s+)?[A-Za-z_]\w*(?:\s*\*)*)\s+([A-Za-z_]\w*)\s*;/g)) {
    add({ kind: "type", name: m[2]!, of: "alias", doc: m[1]!.replace(/\s+/g, " "), file })
  }
}

function build(target: string) {
  const spec = JSON.parse(readFileSync(join(targetsDir, target, "target.json"), "utf8")) as { family: string; cpu: string[]; defines: string[] }
  const family = join(st, spec.family)
  const device = spec.defines.find((d) => /^-DSTM32F\d/.test(d))!.slice(2).toLowerCase()
  const core = /cortex-m7/.test(spec.cpu.join(" ")) ? "core_cm7.h" : "core_cm4.h"
  const syms: Sym[] = []
  const headers: string[] = []
  const file = (path: string, name: string) => scan(readFileSync(path, "utf8"), name, syms)

  file(join(st, "core", "Include", core), core)
  file(join(st, "core", "Include", "cmsis_gcc.h"), "cmsis_gcc.h")
  file(join(family, "cmsis", "Include", `${device}.h`), `${device}.h`)
  const halInc = join(family, "hal", "Inc")
  for (const name of readdirSync(halInc).sort()) {
    if (!name.endsWith(".h") || name.includes("template")) continue
    headers.push(name)
    file(join(halInc, name), name)
  }
  const halSrc = join(family, "hal", "Src")
  for (const name of readdirSync(halSrc).sort()) {
    if (!name.endsWith(".c") || name.includes("template")) continue
    file(join(halSrc, name), name)
  }
  // The target's own batteries: the interrupt handler names a program may define.
  for (const name of readdirSync(join(targetsDir, target))) {
    if (name.endsWith(".h")) {
      headers.push(name)
      file(join(targetsDir, target, name), name)
    }
  }
  for (const name of ["stm32f4xx.h", "stm32f7xx.h", `${device}.h`, core, "cmsis_gcc.h"]) if (!headers.includes(name)) headers.push(name)

  // A prototype in a header and a definition in a .c: keep the one with the doc.
  const best = new Map<string, Sym>()
  for (const s of syms) {
    const key = `${s.kind}:${s.name}`
    const prev = best.get(key)
    if (!prev || (!prev.doc && s.doc)) best.set(key, s)
  }
  const index: Index = { target, symbols: [...best.values()], headers }
  // ST's header style is what the regexes know; should it change, fail the build here rather
  // than ship an editor that has quietly forgotten the HAL.
  const expect = (name: string, kind: Sym["kind"], withDoc: boolean) => {
    const s = best.get(`${kind}:${name}`)
    if (!s || (withDoc && !s.doc)) throw new Error(`${target}: ${kind} ${name} not found${withDoc ? " with its documentation" : ""} — the ST headers changed shape?`)
  }
  expect("HAL_GPIO_Init", "function", true)
  expect("HAL_Delay", "function", true)
  expect("__HAL_RCC_GPIOA_CLK_ENABLE", "macro", false)
  expect("GPIO_PIN_0", "macro", true)
  expect("GPIO_TypeDef", "type", false)
  expect("GPIO_InitTypeDef", "type", false)
  expect("EXTI15_10_IRQn", "enumerator", true)
  expect("HAL_OK", "enumerator", false)
  if ((best.get("type:GPIO_InitTypeDef") as Extract<Sym, { kind: "type" }>).members?.[0]?.doc === undefined) throw new Error(`${target}: struct member docs missing`)
  mkdirSync(out, { recursive: true })
  const json = JSON.stringify(index)
  writeFileSync(join(out, `${target}.json`), json)
  const by = (k: Sym["kind"]) => index.symbols.filter((s) => s.kind === k).length
  console.log(`${target}: ${index.symbols.length} symbols (${by("function")} functions, ${by("macro")} macros, ${by("type")} types, ${by("enumerator")} enumerators), ${(json.length / 1024).toFixed(0)} KB`)
}

for (const target of readdirSync(targetsDir)) if (target !== "common") build(target)
