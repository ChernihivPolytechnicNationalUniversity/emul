/**
 * Where the text of a file the image names comes from: the board's project (when the image
 * was built from it), a file added for the debugger (read-only), ST's HAL/CMSIS and the build
 * service's own startup files as the site serves them — or nowhere yet, and the debugger asks
 * for it. Paths are matched by their trailing segments, as the line table does.
 */
import type { SourceFile } from "emul-shared/source"
import { normalizePath } from "./paths"

export type SourceRef =
  /** A file of the board's project, editable. */
  | { kind: "project"; path: string; image: string }
  /** A file added for the debugger (saved with the board), read-only. */
  | { kind: "added"; path: string; image: string }
  /** ST's library or a startup file the build service compiled in, fetched from the site. */
  | { kind: "site"; url: string; image: string }
  /** Nothing known has it. */
  | { kind: "missing"; image: string }

/** How many trailing path segments two paths share. */
export function sharedTail(a: string, b: string): number {
  const x = normalizePath(a).split("/").filter(Boolean)
  const y = normalizePath(b).split("/").filter(Boolean)
  let n = 0
  while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++
  return n
}

/**
 * The project file an image's path stands for: the one whose whole path is the tail of the
 * image's (`Core/Src/main.c` in `/tmp/emul-build-x/src/Core/Src/main.c`), the longest when
 * several are.
 */
export function projectFileFor(image: string, files: SourceFile[]): SourceFile | null {
  let best: SourceFile | null = null
  let bestLen = 0
  for (const f of files) {
    const len = normalizePath(f.path).split("/").filter(Boolean).length
    if (sharedTail(image, f.path) === len && len > bestLen) {
      best = f
      bestLen = len
    }
  }
  return best
}

/** An added source standing for an image's path: the same path, else the longest shared tail (the file name at least). */
export function addedFileFor(image: string, sources: SourceFile[]): SourceFile | null {
  let best: SourceFile | null = null
  let bestLen = 0
  for (const f of sources) {
    const n = sharedTail(image, f.path)
    if (n > bestLen) {
      best = f
      bestLen = n
    }
  }
  return best
}

/**
 * Where the site serves a file the build service compiled in: ST's HAL, CMSIS and device
 * headers under /st/, the service's startup files ("batteries") under /st/targets/.
 */
export function siteUrlFor(image: string): string | null {
  const p = normalizePath(image)
  const st = /^\/opt\/st\/(.+)$/.exec(p)
  if (st) return `/st/${st[1]}`
  const target = /\/backend\/worker\/targets\/(.+)$/.exec(p)
  if (target) return `/st/targets/${target[1]}`
  return null
}

export function resolveSource(image: string, ctx: { project: SourceFile[] | null; added: SourceFile[] }): SourceRef {
  const own = ctx.project ? projectFileFor(image, ctx.project) : null
  if (own) return { kind: "project", path: own.path, image }
  const added = addedFileFor(image, ctx.added)
  if (added) return { kind: "added", path: added.path, image }
  const url = siteUrlFor(image)
  if (url) return { kind: "site", url, image }
  return { kind: "missing", image }
}

/** Files fetched from the site, by URL; null for one the site does not have. */
const fetched = new Map<string, Promise<string | null>>()

export function fetchSiteSource(url: string): Promise<string | null> {
  let p = fetched.get(url)
  if (!p) {
    p = fetch(url)
      .then((res) => {
        // A dev server answers an unknown path with the app itself: that is not a source file.
        if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html")) return null
        return res.text()
      })
      .catch(() => null)
    fetched.set(url, p)
  }
  return p
}

/** A short string hash (FNV-1a), to tell whether a file changed since the build. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** What a firmware image was built from, as the Compile button records it on the board. */
export type BuildRecord = { opt: string; files: Record<string, string> }

export function parseBuildRecord(text: string | undefined): BuildRecord | null {
  if (!text) return null
  try {
    const r = JSON.parse(text) as BuildRecord
    return r && typeof r.files === "object" ? r : null
  } catch {
    return null
  }
}
