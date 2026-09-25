import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { languageOf } from "emul-shared/hdl"
import type { SourceFile } from "emul-shared/source"
import { synth } from "../src/synth.ts"

const [root, top, ...pairs] = process.argv.slice(2)
if (!root) {
  console.log("usage: node --experimental-strip-types backend/worker/scripts/try-synth.ts <sources dir> [top|-] [NAME=value…]")
  process.exit(2)
}

async function collect(dir: string, prefix = ""): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await collect(path.join(dir, entry.name), rel)))
    else if (languageOf(entry.name)) out.push({ path: rel, content: await readFile(path.join(dir, entry.name), "utf8") })
  }
  return out
}

const generics = Object.fromEntries(pairs.map((p) => p.split("=", 2) as [string, string]))
const result = await synth(await collect(root), { top: top && top !== "-" ? top : undefined, generics })
console.log(result.log.trim())
if (result.netlist) console.log(JSON.stringify(result.netlist))
console.log(`\n${result.ok ? "✓" : "✗"} ${root}${result.error ? `: ${result.error}` : ""}`)
process.exit(result.ok ? 0 : 1)
