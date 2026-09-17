import type { Target } from "emul-shared/source"

/**
 * What the editor knows about a chip: ST's HAL, the device header and the CMSIS core as one
 * index per target, generated at build time by `scripts/symbols.ts` from the same pinned
 * sources the worker compiles against, served as `/symbols/<target>.json`.
 */
export type Param = { type: string; name: string; doc?: string }
export type Member = { name: string; type?: string; doc?: string }
export type Sym =
  | { kind: "function"; name: string; ret: string; params: Param[]; doc?: string; retval?: string; file: string }
  | { kind: "macro"; name: string; params?: string[]; value: string; doc?: string; file: string }
  | { kind: "type"; name: string; of: "struct" | "enum" | "alias"; members?: Member[]; doc?: string; file: string }
  | { kind: "enumerator"; name: string; type: string; value?: string; doc?: string; file: string }

export type SymbolIndex = {
  target: Target
  symbols: Sym[]
  /** Header file names a program may `#include`. */
  headers: string[]
  /** Every symbol by name (a macro and a function may share one; the macro then aliases it). */
  byName: Map<string, Sym[]>
}

const cache = new Map<Target, Promise<SymbolIndex>>()

/** Loaded once per chip and kept; a few hundred KB compressed, so not before the editor asks. */
export function loadSymbols(target: Target): Promise<SymbolIndex> {
  let p = cache.get(target)
  if (!p) {
    p = fetch(`/symbols/${target}.json`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status} ${res.statusText}`))))
      .then((raw: Omit<SymbolIndex, "byName">) => {
        const byName = new Map<string, Sym[]>()
        for (const s of raw.symbols) {
          const list = byName.get(s.name)
          if (list) list.push(s)
          else byName.set(s.name, [s])
        }
        return { ...raw, byName }
      })
    cache.set(target, p)
    p.catch(() => cache.delete(target))
  }
  return p
}

/** `ret name(type a, type b)` as a C declaration, for hovers and signature help. */
export function signature(s: Sym): string {
  switch (s.kind) {
    case "function":
      return `${s.ret} ${s.name}(${s.params.map((p) => `${p.type} ${p.name}`.trim()).join(", ") || "void"})`
    case "macro":
      return `#define ${s.name}${s.params ? `(${s.params.join(", ")})` : ""}${s.value ? ` ${s.value}` : ""}`
    case "type":
      return s.of === "alias" ? `typedef ${s.doc ?? "…"} ${s.name}` : `typedef ${s.of} { … } ${s.name}`
    case "enumerator":
      return `${s.name}${s.value ? ` = ${s.value}` : ""}  (${s.type})`
  }
}

/** The symbol's documentation as markdown: the declaration, the brief, the parameters. */
export function documentation(s: Sym): string {
  const parts = ["```c\n" + signature(s) + "\n```"]
  if (s.kind === "type" && s.of !== "alias" && s.doc) parts.push(s.doc)
  else if (s.kind !== "type" && s.doc) parts.push(s.doc)
  if (s.kind === "function") {
    const ps = s.params.filter((p) => p.doc)
    if (ps.length) parts.push(ps.map((p) => `- \`${p.name}\` — ${p.doc}`).join("\n"))
    if (s.retval && s.retval !== "None") parts.push(`*Returns:* ${s.retval}`)
  }
  if (s.kind === "type" && s.members?.length) {
    const shown = s.members.slice(0, 24)
    parts.push(shown.map((m) => `- \`${m.type ? `${m.type} ` : ""}${m.name}\`${m.doc ? ` — ${m.doc}` : ""}`).join("\n") + (s.members.length > shown.length ? `\n- … ${s.members.length - shown.length} more` : ""))
  }
  parts.push(`*${s.file}*`)
  return parts.join("\n\n")
}
