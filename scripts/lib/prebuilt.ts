/**
 * What a prebuilt example image depends on, as hashes for firmware/prebuilt/manifest.json:
 * the sources a board is given, and the build service's own files for its target (the code,
 * the batteries, the pinned HAL or Arduino core). Shared by scripts/example-firmware.ts, which
 * writes them, and tests/firmware/prebuilt.test.ts, which fails when they no longer hold.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { SourceFile, Target } from "emul-shared/source"

export const ROOT = join(import.meta.dirname, "..", "..")
export const PREBUILT_DIR = join(ROOT, "firmware", "prebuilt")
export const MANIFEST = join(PREBUILT_DIR, "manifest.json")

const WORKER = join(ROOT, "backend", "worker")

/** Path order and the separators make the hash about the files, not how they were listed. */
export function sourcesHash(files: readonly SourceFile[]): string {
  const h = createHash("sha256")
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) h.update(`${f.path}\0${f.content}\0`)
  return h.digest("hex")
}

const filesIn = (dir: string) =>
  readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isFile())
    .sort()

/** The worker's files a build for `target` reads or is made with; a change to any is a new image. */
export function toolchainFiles(target: Target): string[] {
  const avr = target === "atmega328p"
  return [
    join(WORKER, "src", "build.ts"),
    join(WORKER, "src", "arduino.ts"),
    ...filesIn(join(WORKER, "targets", target)),
    ...(avr ? [] : filesIn(join(WORKER, "targets", "common"))),
    ...(avr ? [join(WORKER, "toolchain", "stage-arduino.sh")] : [join(WORKER, "toolchain", "stage-st.sh"), join(WORKER, "toolchain", "build-hal.sh")]),
  ]
}

export function toolchainHash(target: Target): string {
  const h = createHash("sha256")
  for (const p of toolchainFiles(target)) h.update(`${p.slice(ROOT.length)}\0`).update(readFileSync(p)).update("\0")
  return h.digest("hex")
}
