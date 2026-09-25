/**
 * The sources the build service compiles into every program that the project does not have —
 * ST's HAL and CMSIS at the pinned tags, the chips' startup files and the service's own
 * "batteries" — copied where the site serves them (`/st/…`), so the debugger can step into
 * HAL_GPIO_Init or Reset_Handler and show the code. The paths mirror the build image's:
 * `/opt/st/<rest>` is served as `/st/<rest>`, `backend/worker/targets/<rest>` as
 * `/st/targets/<rest>` (src/debug/sources.ts maps them). Only what the chips of TARGETS
 * include is copied: the family's HAL, its device header and the CMSIS core.
 *
 *   pnpm st-sources <st root> <out dir>      e.g. pnpm st-sources /tmp/st public/st
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"

const st = process.argv[2]
const out = process.argv[3]
if (!st || !out) {
  console.error("usage: pnpm st-sources <st root> <out dir>")
  process.exit(1)
}

const targetsDir = join(import.meta.dirname, "..", "backend", "worker", "targets")
const SOURCE = /\.(c|h|s|S|inc)$/
let files = 0
let bytes = 0

function copy(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  files++
  bytes += statSync(from).size
}

/** Every source file under a directory, into the same place under `to`. */
function tree(from: string, to: string, keep: (name: string) => boolean = (n) => SOURCE.test(n)) {
  if (!existsSync(from)) return
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const p = join(from, e.name)
    if (e.isDirectory()) tree(p, join(to, e.name), keep)
    else if (keep(e.name)) copy(p, join(to, e.name))
  }
}

// The CMSIS core headers every chip includes.
tree(join(st, "core", "Include"), join(out, "core", "Include"))
const families = new Set<string>()
const devices = new Set<string>()
for (const target of readdirSync(targetsDir)) {
  const spec = join(targetsDir, target, "target.json")
  if (!existsSync(spec)) continue
  const t = JSON.parse(readFileSync(spec, "utf8")) as { family: string; defines: string[] }
  families.add(t.family)
  // -DSTM32F746xx names the device header stm32f746xx.h.
  for (const d of t.defines) {
    const m = /^-D(STM32F\w+xx)$/.exec(d)
    if (m) devices.add(`${t.family}:${m[1].toLowerCase()}.h`)
  }
}
for (const family of families) {
  tree(join(st, family, "hal", "Src"), join(out, family, "hal", "Src"), (n) => SOURCE.test(n) && !n.includes("template"))
  tree(join(st, family, "hal", "Inc"), join(out, family, "hal", "Inc"))
  const include = join(st, family, "cmsis", "Include")
  // The family header and the system header; of the device headers, only the targets'.
  const keep = (n: string) => /^stm32f\dxx\.h$/.test(n) || /^system_stm32f\dxx\.h$/.test(n) || devices.has(`${family}:${n}`)
  tree(include, join(out, family, "cmsis", "Include"), keep)
}
// The build service's own files: linker scripts are not sources, the rest is.
tree(targetsDir, join(out, "targets"))

const index = { files, bytes, families: [...families], devices: [...devices].map((d) => d.split(":")[1]) }
writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2))
console.log(`${files} files, ${(bytes / 1e6).toFixed(1)} MB into ${relative(process.cwd(), out) || out}`)
