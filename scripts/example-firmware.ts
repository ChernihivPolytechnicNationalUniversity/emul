/**
 * Builds the firmware of every example with code into firmware/prebuilt/, so an example opens
 * programmed (src/project/prebuilt.ts) and nobody waits on the build service to see it run.
 * Each board is built by the service's own code (backend/worker/src/build.ts) from exactly the
 * sources and options the Examples menu gives it — loaded through Vite, as the site loads them —
 * and the manifest keeps what each image came from; tests/firmware/prebuilt.test.ts fails once
 * that no longer holds. Images already current are left alone; a toolchain that is not there
 * is skipped with a note, so ARM and AVR can be built in separate runs:
 *
 *   pnpm example-firmware [--force] [example id…]          ARM, with ST_ROOT and HAL_ROOT laid out
 *                                                           by backend/worker/toolchain/{stage-st,build-hal}.sh
 *   pnpm example-firmware-avr                               AVR, in the emul-arduino image
 *
 * ARM_GCC defaults to the 14.2 toolchain the firmware Makefiles use; AVR_GCC and ARDUINO_ROOT
 * to the worker's own (/opt/arduino).
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createServer } from "vite"
import type { Target } from "emul-shared/source"
import type { Example } from "@/schematic/examples"
import type * as Prebuilt from "@/project/prebuilt"
import { MANIFEST, PREBUILT_DIR, ROOT, sourcesHash, toolchainHash } from "./lib/prebuilt"

const args = process.argv.slice(2)
const force = args.includes("--force")
const only = new Set(args.filter((a) => !a.startsWith("--")))

process.env.ARM_GCC ??= join(homedir(), "tools", "arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi", "bin", "arm-none-eabi-")
const ST_ROOT = (process.env.ST_ROOT ??= "/opt/st")
const HAL_ROOT = (process.env.HAL_ROOT ??= "/opt/hal")
const ARDUINO_ROOT = (process.env.ARDUINO_ROOT ??= "/opt/arduino")
const { build } = await import("../backend/worker/src/build.ts")

const runs = (cmd: string) => {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}
/** Why a target cannot be built here, or null when it can. */
function missing(target: Target): string | null {
  if (target === "atmega328p") {
    if (!runs(`${process.env.AVR_GCC ?? "avr-"}gcc`)) return "no avr-gcc"
    return existsSync(ARDUINO_ROOT) ? null : `no ArduinoCore-avr at ${ARDUINO_ROOT}`
  }
  if (target.startsWith("pic")) return "PIC images are not prebuilt yet"
  if (!runs(`${process.env.ARM_GCC}gcc`)) return `no ${process.env.ARM_GCC}gcc`
  if (!existsSync(join(ST_ROOT, "core", "Include"))) return `no ST sources at ${ST_ROOT}`
  return existsSync(join(HAL_ROOT, target, "libhal.a")) ? null : `no ${join(HAL_ROOT, target, "libhal.a")}`
}

const vite = await createServer({ root: ROOT, logLevel: "error", appType: "custom", server: { middlewareMode: true, hmr: false } })
let failed = false
try {
  const { examples } = (await vite.ssrLoadModule("/src/schematic/examples.ts")) as { examples: Example[] }
  const { exampleBench, fileHashes } = (await vite.ssrLoadModule("/src/project/prebuilt.ts")) as typeof Prebuilt
  const { GRID } = (await vite.ssrLoadModule("/src/schematic/geometry.ts")) as { GRID: number }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Prebuilt.PrebuiltManifest
  const next: Prebuilt.PrebuiltManifest = {}
  mkdirSync(PREBUILT_DIR, { recursive: true })

  for (const example of examples) {
    if (!example.projects?.length) continue
    const { boards, errors } = await exampleBench(example, GRID)
    for (const e of errors) console.error(`✗ ${example.id} ${e}`)
    failed ||= errors.length > 0
    for (const b of boards) {
      const old = manifest[example.id]?.[b.ref]
      const keep = () => old && ((next[example.id] ??= {})[b.ref] = old)
      if (only.size && !only.has(example.id)) {
        keep()
        continue
      }
      const sources = sourcesHash(b.files)
      const toolchain = toolchainHash(b.target)
      const elf = `${example.id}.${b.ref}.elf`
      const current = old && old.sources === sources && old.toolchain === toolchain && JSON.stringify(old.options) === JSON.stringify(b.options) && existsSync(join(PREBUILT_DIR, elf))
      if (current && !force) {
        keep()
        console.log(`· ${example.id} ${b.ref}: up to date`)
        continue
      }
      const why = missing(b.target)
      if (why) {
        keep()
        console.log(`- ${example.id} ${b.ref} (${b.target}): skipped, ${why}${old ? " (the old image stays, stale)" : ""}`)
        continue
      }
      const started = performance.now()
      const out = await build(b.target, b.files, b.options)
      if (!out.ok || !out.elf) {
        failed = true
        keep()
        console.error(`✗ ${example.id} ${b.ref}: ${out.error}\n${out.log.slice(-3000)}`)
        continue
      }
      writeFileSync(join(PREBUILT_DIR, elf), out.elf)
      ;(next[example.id] ??= {})[b.ref] = { target: b.target, options: b.options, files: fileHashes(b.files), sources, toolchain, elf, bytes: out.elf.length }
      console.log(`✓ ${example.id} ${b.ref} (${b.target} ${b.options.opt}): ${out.elf.length} B in ${((performance.now() - started) / 1000).toFixed(1)} s`)
    }
  }

  // Images of examples that are gone, or no longer have that board, go too.
  for (const [id, refs] of Object.entries(manifest))
    for (const [ref, entry] of Object.entries(refs)) if (!next[id]?.[ref]) rmSync(join(PREBUILT_DIR, entry.elf), { force: true })
  const sorted = Object.fromEntries(Object.keys(next).sort().map((id) => [id, next[id]]))
  writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`)
} finally {
  await vite.close()
}
process.exit(failed ? 1 : 0)
