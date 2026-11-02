/**
 * The examples' prebuilt images (firmware/prebuilt/, src/project/prebuilt.ts) against what
 * they claim to be built from: an example's sources or options changed, or the build
 * service's files for the target, and its image is stale — rebuild with `pnpm example-firmware`
 * (and `pnpm example-firmware-avr` for the Nano). Then the one the landing page opens, run.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { exampleBench, fileHashes, prebuilt, prebuiltFor } from "@/project/prebuilt"
import { examples } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { partKey, type Schematic } from "@/schematic/types"
import { nucleoShiftRegister } from "@/schematic/timers"
import { SimLoop } from "@/sim/loop"
import { PREBUILT_DIR, sourcesHash, toolchainHash } from "../../scripts/lib/prebuilt"

const REBUILD = "stale: run `pnpm example-firmware` (`pnpm example-firmware-avr` for an AVR board)"

describe("prebuilt example firmware", () => {
  const withCode = examples.filter((e) => e.projects?.length)

  it.each(withCode.map((e) => [e.id, e] as const))("%s has a current image for every board", async (_, example) => {
    const { boards, errors } = await exampleBench(example, GRID)
    expect(errors).toEqual([])
    expect(boards.length, "every project lands on a board").toBe(example.projects!.length)
    for (const b of boards) {
      const entry = prebuilt[example.id]?.[b.ref]
      expect(entry, `${b.ref}: no image, ${REBUILD}`).toBeDefined()
      if (!entry) continue
      expect.soft(entry.target, `${b.ref}: target`).toBe(b.target)
      expect.soft(entry.options, `${b.ref}: build options, ${REBUILD}`).toEqual(b.options)
      expect.soft(entry.sources, `${b.ref}: sources, ${REBUILD}`).toBe(sourcesHash(b.files))
      expect.soft(entry.files, `${b.ref}: sources, ${REBUILD}`).toEqual(fileHashes(b.files))
      expect.soft(entry.toolchain, `${b.ref}: the build service's files for ${b.target}, ${REBUILD}`).toBe(toolchainHash(b.target))
      const elf = join(PREBUILT_DIR, entry.elf)
      expect.soft(existsSync(elf) && statSync(elf).size, `${b.ref}: ${entry.elf}`).toBe(entry.bytes)
      expect.soft(prebuiltFor(example.id, b), `${b.ref}: the site would put it on`).toBe(entry)
    }
  })

  it("has no image for an example or board that is gone", () => {
    const boards = new Set(withCode.flatMap((e) => e.projects!.map((p) => `${e.id}/${p.ref}`)))
    const listed = Object.entries(prebuilt).flatMap(([id, refs]) => Object.keys(refs).map((ref) => `${id}/${ref}`))
    expect(listed.filter((k) => !boards.has(k))).toEqual([])
  })

  it("is not put on a board whose code was edited", async () => {
    const { boards } = await exampleBench(nucleoShiftRegister, GRID)
    const b = boards[0]!
    expect(prebuiltFor(nucleoShiftRegister.id, b)).not.toBeNull()
    const edited = { ...b, files: b.files.map((f) => (f.path.endsWith("main.c") ? { ...f, content: `${f.content}\n// edited\n` } : f)) }
    expect(prebuiltFor(nucleoShiftRegister.id, edited)).toBeNull()
    expect(prebuiltFor(nucleoShiftRegister.id, { ...b, options: { opt: "-O2" } })).toBeNull()
  })
})

describe("the landing page's example, as prebuilt", () => {
  it("runs the light along the eight LEDs", async () => {
    const { doc, boards } = await exampleBench(nucleoShiftRegister, GRID)
    const entry = prebuiltFor(nucleoShiftRegister.id, boards[0]!)!
    boards[0]!.board.props = { ...boards[0]!.board.props, firmware: "firmware.elf", firmwareData: readFileSync(join(PREBUILT_DIR, entry.elf)).toString("base64") }
    const leds = doc.objects.filter((o) => o.def === "led")
    const order: number[] = []
    run(doc, 1.2, (parts) => {
      const lit = leds.map((led) => parts[partKey(led.id, "LED")]?.on ?? false)
      const k = lit.indexOf(true)
      if (lit.filter(Boolean).length === 1 && order[order.length - 1] !== k) order.push(k)
    })
    expect.soft(order.length, "steps seen in 1.2 s").toBeGreaterThan(7)
    for (let k = 1; k < order.length; k++) expect.soft(order[k], `step ${k}`).toBe((order[k - 1]! + 1) % 8)
  })
})

function run(doc: Schematic, seconds: number, each: (parts: Schematic["parts"]) => void) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  for (let clock = 0; clock <= seconds * 1000; clock++) {
    loop.advance(clock)
    each(loop.snapshot()!.parts)
  }
}
