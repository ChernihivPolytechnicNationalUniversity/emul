import { languageOf } from "emul-shared/hdl"
import { SOURCE_LIMITS, sourcePath, type SourceFile } from "emul-shared/source"

export const HDL_ACCEPT = ".vhd,.vhdl,.v,.sv"

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia",
  ы: "y", э: "e", ё: "io", ъ: "",
}

export function safeName(name: string): string {
  const dot = name.lastIndexOf(".")
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""]
  const ascii = [...stem]
    .map((c) => {
      const lower = c.toLowerCase()
      const t = CYRILLIC[lower]
      if (t === undefined) return c
      return c === lower ? t : t.charAt(0).toUpperCase() + t.slice(1)
    })
    .join("")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 60)
  return `${ascii || "source"}${ext.toLowerCase()}`
}

export async function readHdlFiles(list: FileList | File[]): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  for (const f of Array.from(list)) {
    const path = sourcePath(safeName(f.name))
    if (!path || !languageOf(path)) continue
    files.push({ path, content: (await f.text()).replace(/\r\n?/g, "\n") })
  }
  return files
}

export function mergeFiles(into: SourceFile[], add: SourceFile[]): SourceFile[] {
  const byPath = new Map(into.map((f) => [f.path, f]))
  for (const f of add) byPath.set(f.path, f)
  return [...byPath.values()].slice(0, SOURCE_LIMITS.files)
}
