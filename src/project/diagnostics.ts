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

export function parseDiagnostic(line: string): Diagnostic | null {
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
