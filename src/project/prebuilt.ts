import type { BuildOptions, SourceFile, Target } from "emul-shared/source"
import { contentHash, type BuildRecord } from "@/debug/sources"
import { bytesToBase64 } from "@/lib/bytes"
import { buildOptions, buildTarget } from "@/project/board-build"
import type { Example } from "@/schematic/examples"
import { getDef } from "@/schematic/registry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import manifest from "../../firmware/prebuilt/manifest.json"

/**
 * The examples' firmware, built ahead of time: every board an example hands sources to comes
 * with the image the build service makes of them, so an example opens programmed and Run is
 * all it takes. The images are made by `pnpm example-firmware` with the service's own code and
 * live in firmware/prebuilt/, each with what it was built from; tests/firmware/prebuilt.test.ts
 * fails once an example's sources move on without them. Editing the code afterwards is the
 * usual Compile, which replaces the image like any build.
 */

/** One image in firmware/prebuilt/manifest.json, under its example's id and board designator. */
export type PrebuiltEntry = {
  target: Target
  options: BuildOptions
  /** Each source's {@link contentHash}, as a {@link BuildRecord} keeps them. */
  files: Record<string, string>
  /** SHA-256 of the sources and of the build service's own files, for the staleness test. */
  sources: string
  toolchain: string
  /** The image's file name in firmware/prebuilt/. */
  elf: string
  bytes: number
}
export type PrebuiltManifest = Record<string, Record<string, PrebuiltEntry>>

export const prebuilt = manifest as PrebuiltManifest

// As hashed assets, so they are cached for good and only fetched for the example opened. The
// try is for the test scripts under tsx, outside Vite (see projects.ts).
const images: Record<string, () => Promise<string>> = (() => {
  try {
    return import.meta.glob("../../firmware/prebuilt/*.elf", { query: "?url", import: "default" }) as Record<string, () => Promise<string>>
  } catch {
    return {}
  }
})()

/** A board an example programs: what the Compile button would send for it. */
export type ExampleBoard = { ref: string; board: PlacedObject; target: Target; options: BuildOptions; files: SourceFile[] }

/**
 * An example's bench with its sources on the boards, as the Examples menu opens it, and the
 * builds those boards stand for. `errors` names the boards whose code would not load.
 */
export async function exampleBench(example: Example, grid: number): Promise<{ doc: Schematic; boards: ExampleBoard[]; errors: string[] }> {
  const doc = example.build(grid)
  const boards: ExampleBoard[] = []
  const errors: string[] = []
  for (const p of example.projects ?? []) {
    const board = doc.objects.find((o) => o.props?.ref === p.ref)
    if (!board) continue
    if (p.opt) board.build = { ...board.build, opt: p.opt }
    try {
      board.project = await p.load()
    } catch (e) {
      errors.push(`${p.ref}: ${(e as Error).message}`)
      continue
    }
    const def = getDef(board.def)
    const target = buildTarget(def)
    if (def && target) boards.push({ ref: p.ref, board, target, options: buildOptions(board, def, target), files: board.project })
  }
  return { doc, boards, errors }
}

export const fileHashes = (files: readonly SourceFile[]): Record<string, string> => Object.fromEntries(files.map((f) => [f.path, contentHash(f.content)]))

const sameRecord = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/** The prebuilt image for a board, if there is one and it was built from exactly what the board now has. */
export function prebuiltFor(exampleId: string, b: ExampleBoard): PrebuiltEntry | null {
  const entry = prebuilt[exampleId]?.[b.ref]
  if (!entry || entry.target !== b.target) return null
  if (!sameRecord(entry.options, b.options) || !sameRecord(entry.files, fileHashes(b.files))) return null
  return entry
}

/**
 * Put each board's prebuilt image on it, as a Compile would (the image, and the record of what
 * it was built from that the debugger reads). True when every board that has code got one: a
 * board without stays as it was, waiting for Compile. A stale or missing image is never put on.
 */
export async function programExample(exampleId: string, boards: readonly ExampleBoard[]): Promise<boolean> {
  let all = boards.length > 0
  for (const b of boards) {
    const entry = prebuiltFor(exampleId, b)
    const load = entry && images[`../../firmware/prebuilt/${entry.elf}`]
    if (!entry || !load) {
      all = false
      continue
    }
    try {
      const res = await fetch(await load())
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      const record: BuildRecord = { opt: b.options.opt ?? "", files: entry.files }
      b.board.props = { ...b.board.props, firmware: "firmware.elf", firmwareData: bytesToBase64(bytes), firmwareBuild: JSON.stringify(record) }
    } catch {
      // Offline or the asset is gone: the board is left for Compile, as without an image.
      all = false
    }
  }
  return all
}
