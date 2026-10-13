import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { parseElf } from "@/mcu/elf"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { partKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { DT } from "@/sim/speeds"
import { buffer, example } from "../lib/firmware"

type Census = { finding: string; up: number; down: number; fall_us: number; rise_us: number }

const BENCH: Record<string, Census> = JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", "open746-bench", "census-2026-10-12.json"), "utf8"))
const CENSUS_ELF = example("open746-census.elf")
const CENSUS = parseElf(buffer(CENSUS_ELF)).symbols.find((s) => s.name === "census")!.value
const PADS = 140
const FINDINGS = ["follows", "held-high", "held-low", "serial"]
const AS_ON_THE_BENCH = { USB: { on: true }, S2: { on: false }, SW1: { on: false }, MUSB: { on: false }, BOOT: { on: false }, OTG_VBUS: { on: false } }
const WATCH_US = 5000
const BENCH_FAST_US = 10
const SOLVER_STEP_US = DT * 1e6
const padName = (pad: number) => `P${String.fromCharCode(65 + (pad >> 4))}${pad & 15}`
const classOf = (us: number, fastBelow: number) => (us >= WATCH_US ? "holds" : us < fastBelow ? "fast" : `${us} µs`)

async function emulatedCensus() {
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "open746-census.elf", firmwareData: CENSUS_ELF.toString("base64") }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts({ ...doc.parts, ...Object.fromEntries(Object.entries(AS_ON_THE_BENCH).map(([part, state]) => [partKey(u.id, part), state])) })
  loop.setRunning(true)
  let clock = 0
  let passes = 0
  let bytes: Uint8Array = new Uint8Array()
  for (let i = 0; i < 400 && passes < 1; i++) {
    clock += 30
    loop.advance(clock)
    const reply = await loop.inspect(u.id, { ranges: [{ addr: CENSUS, size: 4 + PADS * 8 }] })
    bytes = reply!.memory[0].bytes
    passes = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const table: Record<string, Census> = {}
  for (let pad = 0; pad < PADS; pad++) {
    const at = 4 + pad * 8
    table[padName(pad)] = { finding: FINDINGS[view.getUint8(at)], up: view.getUint8(at + 1), down: view.getUint8(at + 2), fall_us: view.getUint16(at + 4, true), rise_us: view.getUint16(at + 6, true) }
  }
  return { passes, table, halted: loop.snapshot()?.mcus[u.id]?.halted ?? null }
}

describe("the pin census of 2026-10-12 (firmware/ports/census.c), run on the simulated Open746I-C as on the bench", () => {
  let emulated: Awaited<ReturnType<typeof emulatedCensus>>
  beforeAll(async () => {
    emulated = await emulatedCensus()
    if (process.env.CENSUS_OUT) writeFileSync(process.env.CENSUS_OUT, JSON.stringify(emulated.table, null, 1))
  })

  it("completes a pass over all 140 pads without a fault", () => {
    expect(emulated.halted).toBeNull()
    expect(emulated.passes).toBeGreaterThan(0)
    expect(Object.keys(BENCH)).toHaveLength(PADS)
  })

  it.each(Object.keys(BENCH))("%s: same finding, pull readings, and fall and rise class as the bench", (pad) => {
    const bench = BENCH[pad]
    const model = emulated.table[pad]
    expect.soft({ finding: model.finding, up: model.up, down: model.down }).toEqual({ finding: bench.finding, up: bench.up, down: bench.down })
    expect.soft(classOf(model.fall_us, SOLVER_STEP_US + 1), `fall: the bench ${bench.fall_us} µs, the model ${model.fall_us} µs`).toBe(classOf(bench.fall_us, BENCH_FAST_US))
    expect.soft(classOf(model.rise_us, SOLVER_STEP_US + 1), `rise: the bench ${bench.rise_us} µs, the model ${model.rise_us} µs`).toBe(classOf(bench.rise_us, BENCH_FAST_US))
  })
})
