import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { isOptLevel, TARGETS, type SourceFile, type Target } from "emul-shared/source"
import { build } from "../src/build.ts"

const [target, root, opt] = process.argv.slice(2) as [Target | undefined, string | undefined, string | undefined]
if (!target || !root || !TARGETS.includes(target) || (opt !== undefined && !isOptLevel(opt))) {
  console.log(`usage: node --experimental-strip-types backend/worker/scripts/try-build.ts <${TARGETS.join("|")}> <project dir> [-O0|-Og|-O1|-O2|-O3|-Os]`)
  process.exit(2)
}

async function collect(dir: string, prefix = ""): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await collect(path.join(dir, entry.name), rel)))
    else if (/\.(c|cpp|cc|h|hpp|s|S|ld)$/.test(entry.name)) out.push({ path: rel, content: await readFile(path.join(dir, entry.name), "utf8") })
  }
  return out
}

const files = await collect(root)
const started = performance.now()
const result = await build(target, files, { opt: isOptLevel(opt) ? opt : undefined })
console.log(result.log.trim())
console.log(`\n${result.ok ? "✓" : "✗"} ${target} ${root}: ${result.ok ? `${result.elf!.length} B firmware.elf` : result.error} in ${((performance.now() - started) / 1000).toFixed(1)} s`)
process.exit(result.ok ? 0 : 1)
