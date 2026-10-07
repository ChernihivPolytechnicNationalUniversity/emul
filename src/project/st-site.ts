import type { StSite } from "./cubeide"

const NOT_ON_SITE = "ST drivers are missing on this site (run pnpm st-sources)."

export async function stSite(): Promise<StSite> {
  const res = await fetch("/st/index.json")
  const index = res.ok ? ((await res.json().catch(() => null)) as { files?: unknown } | null) : null
  if (!Array.isArray(index?.files)) throw new Error(NOT_ON_SITE)
  return {
    files: index.files.filter((f): f is string => typeof f === "string"),
    read: async (path) => {
      const file = await fetch(`/st/${path}`)
      if (!file.ok) throw new Error(`/st/${path}: ${file.status} ${file.statusText}`)
      return new Uint8Array(await file.arrayBuffer())
    },
  }
}
