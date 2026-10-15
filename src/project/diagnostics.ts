/**
 * GCC's diagnostics out of a build log, for the editor's markers and the Output pane's links:
 *
 *   Core/Src/main.c:12:3: error: 'x' undeclared (first use in this function)
 *   Core/Src/main.c:12:3: note: each undeclared identifier is reported only once …
 *
 * Paths are as the compiler saw them, relative to the project (the worker's cwd); a battery
 * or a HAL file comes with an absolute path and is reported without a file to open.
 */
export type Severity = "error" | "warning" | "note"
export type Diagnostic = { path: string | null; line: number; col: number; severity: Severity; message: string }

const LINE = /^(.+?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)$/

/** SDCC: `main.c:15: error 20: Undefined identifier 'x'`, `main.c:7: syntax error: token -> '0' ; column 35`. */
const SDCC = /^([^:\s][^:]*?):(\d+): (?:(error|warning) \d+|(syntax error)): (.*?)(?: ; column (\d+))?$/
/** gpasm: `main.asm:8:Error[113]   Symbol not previously defined: "x"`. */
const GPASM = /^([^:\s][^:]*?):(\d+):(Error|Warning|Message)\[\d+\]\s+(.*)$/

export function parseDiagnostic(line: string): Diagnostic | null {
  const path = (file: string) => (file.startsWith("/") ? null : file.replace(/^\.\//, ""))
  const s = SDCC.exec(line)
  if (s) return { path: path(s[1]!), line: Number(s[2]), col: s[6] ? Number(s[6]) : 1, severity: s[4] ? "error" : (s[3] as Severity), message: s[4] ? `syntax error: ${s[5]}` : s[5]! }
  const g = GPASM.exec(line)
  if (g) return { path: path(g[1]!), line: Number(g[2]), col: 1, severity: g[3] === "Error" ? "error" : g[3] === "Warning" ? "warning" : "note", message: g[4]! }
  const m = LINE.exec(line)
  if (!m) return null
  const file = m[1]!
  return {
    path: file.startsWith("/") ? null : file.replace(/^\.\//, ""),
    line: Number(m[2]),
    col: Number(m[3]),
    severity: m[4] === "fatal error" ? "error" : (m[4] as Severity),
    message: m[5]!,
  }
}

export function parseDiagnostics(log: string): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const line of log.split("\n")) {
    const d = parseDiagnostic(line)
    if (d) out.push(d)
  }
  return out
}
