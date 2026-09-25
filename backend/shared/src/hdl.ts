export type HdlLanguage = "vhdl" | "verilog"

export function languageOf(path: string): HdlLanguage | null {
  if (/\.(vhd|vhdl)$/i.test(path)) return "vhdl"
  if (/\.(v|sv)$/i.test(path)) return "verilog"
  return null
}

export type SynthOptions = { top?: string; generics?: Record<string, string> }

const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const GENERIC_VALUE = /^(-?\d+(\.\d+)?|'[01]'|"[01xXzZ]{1,256}"|\d*'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_]{1,256}|[A-Za-z][A-Za-z0-9_]{0,63})$/

export const isIdentifier = (s: string) => IDENT.test(s)
export const isGenericValue = (s: string) => GENERIC_VALUE.test(s.trim())

export function checkSynthOptions(options: SynthOptions): string | null {
  if (options.top !== undefined && !isIdentifier(options.top)) return `not a unit name: ${options.top}`
  for (const [name, value] of Object.entries(options.generics ?? {})) {
    if (!isIdentifier(name)) return `not a generic name: ${name}`
    if (!isGenericValue(value)) return `${name}: not a value the synthesis takes: ${value}`
  }
  return null
}

export const CELL_PINS = {
  $_BUF_: ["A", "Y"],
  $_NOT_: ["A", "Y"],
  $_AND_: ["A", "B", "Y"],
  $_NAND_: ["A", "B", "Y"],
  $_OR_: ["A", "B", "Y"],
  $_NOR_: ["A", "B", "Y"],
  $_XOR_: ["A", "B", "Y"],
  $_XNOR_: ["A", "B", "Y"],
  $_ANDNOT_: ["A", "B", "Y"],
  $_ORNOT_: ["A", "B", "Y"],
  $_MUX_: ["A", "B", "S", "Y"],
  $_NMUX_: ["A", "B", "S", "Y"],
  $_AOI3_: ["A", "B", "C", "Y"],
  $_OAI3_: ["A", "B", "C", "Y"],
  $_AOI4_: ["A", "B", "C", "D", "Y"],
  $_OAI4_: ["A", "B", "C", "D", "Y"],
  $_TBUF_: ["A", "E", "Y"],
  $_DFF_P_: ["C", "D", "Q"],
  $_DFFSR_PPP_: ["C", "S", "R", "D", "Q"],
  $_DLATCH_P_: ["E", "D", "Q"],
  $_DLATCHSR_PPP_: ["E", "S", "R", "D", "Q"],
} as const

export type CellType = keyof typeof CELL_PINS

export const isCellType = (t: string): t is CellType => Object.hasOwn(CELL_PINS, t)

export type PortDirection = "input" | "output" | "inout"

export type HdlPort = { name: string; dir: PortDirection; bits: number[]; offset: number; upto: boolean }

export type HdlNetlist = {
  top: string
  language: HdlLanguage
  nets: number
  ports: HdlPort[]
  cells: [CellType, ...number[]][]
  init: number[]
}

export function portPins(port: HdlPort): { pin: string; bit: number }[] {
  const name = port.name.replace(/^\$+/, "_")
  if (port.bits.length === 1 && port.offset === 0) return [{ pin: name, bit: port.bits[0]! }]
  const n = port.bits.length
  return port.bits.map((bit, i) => ({ pin: `${name}[${port.upto ? port.offset + n - 1 - i : port.offset + i}]`, bit }))
}

export type HdlRange = { left: string; dir: "to" | "downto"; right: string }

export type HdlUnit = { name: string; language: HdlLanguage; generics: { name: string; value: string }[]; ranges: Record<string, HdlRange>; ports: boolean }

function balanced(text: string, open: number): { inner: string; end: number } | null {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "(") depth++
    else if (c === ")" && --depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 }
  }
  return null
}

function splitTop(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "(") depth++
    else if (c === ")") depth--
    else if (c === sep && depth === 0) {
      out.push(text.slice(from, i))
      from = i + 1
    }
  }
  out.push(text.slice(from))
  return out.map((s) => s.trim()).filter(Boolean)
}

function scanVhdl(text: string): HdlUnit[] {
  const src = text.replace(/--[^\n]*/g, "")
  const units: HdlUnit[] = []
  for (const m of src.matchAll(/\bentity\s+([A-Za-z]\w*)\s+is\b/gi)) {
    const rest = src.slice(m.index + m[0].length)
    const head = /^\s*generic\s*\(/i.exec(rest)
    const generics: HdlUnit["generics"] = []
    if (head) {
      const clause = balanced(rest, head[0].length - 1)
      for (const item of clause ? splitTop(clause.inner, ";") : []) {
        const g = /^(?:constant\s+)?([\w\s,]+?)\s*:\s*[^:]*?(?::=\s*([\s\S]+))?$/i.exec(item)
        if (!g) continue
        for (const name of g[1]!.split(",").map((s) => s.trim()).filter(Boolean)) generics.push({ name, value: g[2]?.trim() ?? "" })
      }
    }
    const ranges: Record<string, HdlRange> = {}
    const portAt = /\bport\s*\(/i.exec(rest)
    const clause = portAt && balanced(rest, portAt.index + portAt[0].length - 1)
    for (const item of clause ? splitTop(clause.inner, ";") : []) {
      const p = /^([\w\s,]+?)\s*:\s*(?:in|out|inout|buffer)?\s*[\w.]+\s*\(\s*([\s\S]+?)\s+(to|downto)\s+([\s\S]+?)\s*\)\s*(?::=[\s\S]*)?$/i.exec(item)
      if (!p) continue
      for (const name of p[1]!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) ranges[name] = { left: p[2]!, dir: p[3]!.toLowerCase() as HdlRange["dir"], right: p[4]! }
    }
    const header = rest.slice(0, rest.search(/\bend\b/i) + 1 || undefined)
    units.push({ name: m[1]!, language: "vhdl", generics, ranges, ports: /\bport\s*\(/i.test(header) })
  }
  return units
}

function scanVerilog(text: string): HdlUnit[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
  const units: HdlUnit[] = []
  for (const m of src.matchAll(/\bmodule\s+([A-Za-z_]\w*)/g)) {
    const after = m.index + m[0].length
    const bodyEnd = src.indexOf("endmodule", after)
    const body = src.slice(after, bodyEnd < 0 ? undefined : bodyEnd)
    const generics: HdlUnit["generics"] = []
    const add = (list: string) => {
      for (const item of splitTop(list, ",")) {
        const g = /(?:parameter\s+)?(?:(?:integer|real|signed|unsigned|logic|bit|\[[^\]]*\])\s+)*([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(item)
        if (g) generics.push({ name: g[1]!, value: g[2]!.trim() })
      }
    }
    const header = /^\s*#\s*\(/.exec(body)
    if (header) {
      const clause = balanced(body, header[0].length - 1)
      if (clause) add(clause.inner)
    }
    for (const p of body.matchAll(/(?<!local)\bparameter\b([^;]*);/g)) if (!header || p.index > (balanced(body, header[0].length - 1)?.end ?? 0)) add(p[1]!)
    const afterParams = header ? (balanced(body, header[0].length - 1)?.end ?? 0) : 0
    const list = /^\s*\(/.exec(body.slice(afterParams))
    const portList = list ? balanced(body, afterParams + list[0].length - 1) : null
    units.push({ name: m[1]!, language: "verilog", generics, ranges: {}, ports: !!portList && portList.inner.trim() !== "" })
  }
  return units
}

export function scanHdl(files: { path: string; content: string }[]): HdlUnit[] {
  return files.flatMap((f) => {
    const lang = languageOf(f.path)
    return lang === "vhdl" ? scanVhdl(f.content) : lang === "verilog" ? scanVerilog(f.content) : []
  })
}

export function guessTop(files: { path: string; content: string }[]): string | null {
  const units = scanHdl(files)
  if (units.length === 0) return null
  const benches = new Set(units.filter((u) => !u.ports).map((u) => u.name.toLowerCase()))
  const text = files
    .map((f) =>
      f.content
        .replace(/--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
        .replace(/\bmodule\s+([A-Za-z_]\w*)[\s\S]*?\bendmodule\b/g, (block, name: string) => (benches.has(name.toLowerCase()) ? "" : block))
        .replace(/\barchitecture\s+\w+\s+of\s+(\w+)\s+is[\s\S]*?(?=\barchitecture\b|$)/gi, (block, name: string) => (benches.has(name.toLowerCase()) ? "" : block)),
    )
    .join("\n")
  const used = (name: string) =>
    new RegExp(`\\bentity\\s+(\\w+\\.)?${name}\\b(?!\\s+is)|\\bcomponent\\s+${name}\\b|(?<!\\bmodule\\s+)\\b${name}\\s+(#\\s*\\(|[A-Za-z_]\\w*\\s*\\()`, "i").test(text)
  const withPorts = units.filter((u) => u.ports)
  const candidates = withPorts.length ? withPorts : units
  const free = candidates.filter((u) => !used(u.name))
  return (free.at(-1) ?? candidates.at(-1))!.name
}

export function evalInteger(expr: string, values: Record<string, string>): number | null {
  const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]))
  const tokens = expr.match(/\d+|[A-Za-z]\w*|\*\*|[-+*/()]|\S/g) ?? []
  let i = 0
  const primary = (): number => {
    const t = tokens[i++]
    if (t === undefined) throw new Error("end")
    if (t === "(") {
      const v = sum()
      if (tokens[i++] !== ")") throw new Error(")")
      return v
    }
    if (t === "-") return -primary()
    if (/^\d+$/.test(t)) return Number(t)
    const v = lower[t.toLowerCase()]
    if (v === undefined || !/^-?\d+$/.test(v.trim())) throw new Error(t)
    return Number(v.trim())
  }
  const power = (): number => {
    const base = primary()
    if (tokens[i] === "**") {
      i++
      return base ** power()
    }
    return base
  }
  const product = (): number => {
    let v = power()
    while (tokens[i] === "*" || tokens[i] === "/") v = tokens[i++] === "*" ? v * power() : Math.trunc(v / power())
    return v
  }
  const sum = (): number => {
    let v = product()
    while (tokens[i] === "+" || tokens[i] === "-") v = tokens[i++] === "+" ? v + product() : v - product()
    return v
  }
  try {
    const v = sum()
    return i === tokens.length && Number.isSafeInteger(v) ? v : null
  } catch {
    return null
  }
}

export function isNetlist(value: unknown): value is HdlNetlist {
  const n = value as HdlNetlist
  if (!n || typeof n !== "object" || typeof n.top !== "string" || (n.language !== "vhdl" && n.language !== "verilog")) return false
  if (!Number.isInteger(n.nets) || n.nets < 2 || n.nets > 4_000_000) return false
  const net = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < n.nets
  if (!Array.isArray(n.ports) || !Array.isArray(n.cells) || !Array.isArray(n.init)) return false
  for (const p of n.ports) {
    if (!p || typeof p.name !== "string" || !["input", "output", "inout"].includes(p.dir) || !Array.isArray(p.bits) || !p.bits.every(net)) return false
    if (!Number.isInteger(p.offset) || typeof p.upto !== "boolean") return false
  }
  for (const c of n.cells) {
    if (!Array.isArray(c) || typeof c[0] !== "string" || !isCellType(c[0]) || c.length !== CELL_PINS[c[0]].length + 1) return false
    for (let i = 1; i < c.length; i++) if (!net(c[i])) return false
  }
  return n.init.every(net)
}
