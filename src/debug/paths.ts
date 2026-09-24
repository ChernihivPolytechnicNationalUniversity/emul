/**
 * Source paths as debug information spells them (Unix, Windows, relative). Kept apart from
 * the DWARF reader so the page can match paths without carrying the reader.
 */

/** Forward slashes, no `.` segments, `..` folded where there is something to fold. */
export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, "/")
  const abs = p.startsWith("/")
  const drive = /^[A-Za-z]:\//.test(p) ? p.slice(0, 2) : ""
  const parts: string[] = []
  for (const seg of (drive ? p.slice(3) : p).split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop()
    else if (seg === ".." && (abs || drive)) continue
    else parts.push(seg)
  }
  return (drive ? `${drive}/` : abs ? "/" : "") + parts.join("/")
}

export const isAbsolute = (p: string) => p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p)
