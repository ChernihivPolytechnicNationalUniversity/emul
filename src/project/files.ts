import { SOURCE_LIMITS, sourcePath, type SourceFile } from "emul-shared/source"

/**
 * Edits on a board's firmware sources, each returning a new list (the object on the schematic
 * holds it). They throw with a message fit for a toast when a path is not a source path,
 * already exists, or the project is full — the same rules the API applies.
 */

/** Folder-aware order: `Core/Inc/main.h` before `Core/Src/main.c`, stable for the explorer and the manifest. */
const byPath = (a: SourceFile, b: SourceFile) => a.path.localeCompare(b.path, "en")

const NOT_A_PATH = (raw: string) => `"${raw}" is not a source path (letters, digits, . _ -, a source extension)`

/** Files from a schematic file or another tool: repair what is off rather than refuse it. */
export function normalizeFiles(files: unknown): SourceFile[] {
  if (!Array.isArray(files)) return []
  const seen = new Set<string>()
  const out: SourceFile[] = []
  for (const f of files as Partial<SourceFile>[]) {
    const path = typeof f?.path === "string" ? sourcePath(f.path) : null
    if (!path || seen.has(path) || typeof f.content !== "string") continue
    seen.add(path)
    out.push({ path, content: f.content.replace(/\r\n?/g, "\n") })
  }
  return out.sort(byPath)
}

export function createFile(files: SourceFile[], rawPath: string, content = ""): { files: SourceFile[]; path: string } {
  const path = sourcePath(rawPath)
  if (!path) throw new Error(NOT_A_PATH(rawPath))
  if (files.some((f) => f.path === path)) throw new Error(`${path} already exists`)
  if (files.length >= SOURCE_LIMITS.files) throw new Error(`A project holds at most ${SOURCE_LIMITS.files} files`)
  return { files: [...files, { path, content }].sort(byPath), path }
}

/** Rename one file; the result maps the old path to the new one for tabs to follow. */
export function renameFile(files: SourceFile[], from: string, rawTo: string): { files: SourceFile[]; moved: Map<string, string> } {
  const to = sourcePath(rawTo)
  if (!to) throw new Error(NOT_A_PATH(rawTo))
  const moved = new Map<string, string>()
  if (to === from) return { files, moved }
  if (files.some((f) => f.path === to)) throw new Error(`${to} already exists`)
  moved.set(from, to)
  return { files: files.map((f) => (f.path === from ? { ...f, path: to } : f)).sort(byPath), moved }
}

/** Move every file under a folder, keeping the rest of each path. */
export function renameFolder(files: SourceFile[], from: string, rawTo: string): { files: SourceFile[]; moved: Map<string, string> } {
  const to = rawTo.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  const moved = new Map<string, string>()
  if (to === from) return { files, moved }
  for (const f of files) {
    if (!f.path.startsWith(from + "/")) continue
    const next = sourcePath(to + f.path.slice(from.length))
    if (!next) throw new Error(`"${rawTo}" is not a folder name (letters, digits, . _ -)`)
    if (files.some((o) => o.path === next) && !moved.has(next)) throw new Error(`${next} already exists`)
    moved.set(f.path, next)
  }
  return { files: files.map((f) => (moved.has(f.path) ? { ...f, path: moved.get(f.path)! } : f)).sort(byPath), moved }
}

/** Remove a file, or every file under a folder path. */
export function removeFile(files: SourceFile[], path: string): SourceFile[] {
  return files.filter((f) => f.path !== path && !f.path.startsWith(path + "/"))
}

/** Null when the text is over the per-file limit: the caller keeps what it had. */
export function writeFile(files: SourceFile[], path: string, content: string): SourceFile[] | null {
  if (content.length > SOURCE_LIMITS.fileBytes) return null
  return files.map((f) => (f.path === path ? { ...f, content } : f))
}
