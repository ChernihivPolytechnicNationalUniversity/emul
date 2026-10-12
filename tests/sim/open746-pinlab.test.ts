import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseElf } from "@/mcu/elf"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { buffer, example } from "../lib/firmware"

const FIELDS = ["passes", "vdda_mv", "target", "rise_mv_min", "rise_mv_max", "fall_mv_min", "fall_mv_max", "high_mv", "low_mv", "pull_up_mv", "pull_down_mv", "wired_mv"] as const
const THRESHOLDS = ["rise_mv_min", "rise_mv_max", "fall_mv_min", "fall_mv_max"] as const
const LEVELS = ["high_mv", "low_mv", "pull_up_mv", "pull_down_mv", "wired_mv"] as const
type Field = (typeof FIELDS)[number]
type Measured = (typeof THRESHOLDS)[number] | (typeof LEVELS)[number]
type Spread = { min: number; max: number }
type Bench = { vdda_mv: Spread & { mean: number }; targets: Record<string, Record<Measured, Spread>> }

const BENCH: Bench = JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", "open746-bench", "pinlab-2026-10-12.json"), "utf8"))
const PINLAB_ELF = example("open746-pinlab.elf")
const LAB = parseElf(buffer(PINLAB_ELF)).symbols.find((s) => s.name === "lab")!.value
const AS_ON_THE_BENCH = { USB: { on: true }, S2: { on: false }, SW1: { on: false }, MUSB: { on: false }, BOOT: { on: false }, OTG_VBUS: { on: false } }
const DAC_PIN = "PA4"

const mid = (s: Spread) => (s.min + s.max) / 2
const LSB_MV = 3300 / 4095
const UNLOADED = BENCH.targets.PA5
const BENCH_ADC_ERROR_MV = Math.max(mid(UNLOADED.low_mv), BENCH.vdda_mv.mean - mid(UNLOADED.high_mv))
const LEVEL_MARGIN_MV = BENCH_ADC_ERROR_MV + LSB_MV
const EDGES = [
  ["rise_mv_min", "rise_mv_max"],
  ["fall_mv_min", "fall_mv_max"],
] as const
const edgeMid = (target: string, [first, last]: readonly [Measured, Measured]) => (mid(BENCH.targets[target][first]) + mid(BENCH.targets[target][last])) / 2
const PAD_TO_PAD_SCATTER_MV = Math.max(
  ...EDGES.map((edge) => {
    const mids = Object.keys(BENCH.targets).map((t) => edgeMid(t, edge))
    const mean = mids.reduce((a, b) => a + b) / mids.length
    return Math.max(...mids.map((m) => Math.abs(m - mean)))
  }),
)
const THRESHOLD_MARGIN_MV = PAD_TO_PAD_SCATTER_MV + 2 * LSB_MV

const LED4_UNDER_LED3 = "LED4 sits 8 mV under LED3 at the pull-up's 39 µA (1721–1722 mV on PI8 against 1729–1731 on PH4), as it sat 22 mV under it at 1.45 mA on 2026-10-06 (1.779 against 1.801 V); the board's one LED model is LED3's"
const FLAG_NOT_STATIC = "the MIC2025's flag is not static: the bench read 2 mV driven low, 1.44 V pulled up and 1.06 V pulled down, the last above its undisturbed 0.80 V, which no fixed equivalent gives"
const FLOATING = "a floating pad sits where its leakage puts it, which the model does not carry"
const EXPECTED_DIFFERENCES: Record<string, Partial<Record<Measured, string>>> = {
  PI8: { pull_up_mv: LED4_UNDER_LED3 },
  PE3: { low_mv: FLAG_NOT_STATIC, pull_up_mv: FLAG_NOT_STATIC, pull_down_mv: FLAG_NOT_STATIC },
}
const differenceOf = (target: string, field: Measured) => EXPECTED_DIFFERENCES[target]?.[field] ?? (field === "wired_mv" && target !== "PE3" ? FLOATING : undefined)

const board = getDef("open746i-c")!
const stripPin = (pad: string) => board.pins.find((p) => /^P(18|19|20|21)-/.test(p.id) && p.mcu === pad)!.id
const padIndex = (pad: string) => (pad.charCodeAt(1) - 65) * 16 + Number(pad.slice(2))

async function pinLab(target: string) {
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "open746-pinlab.elf", firmwareData: PINLAB_ELF.toString("base64") }
  const lead = builder(GRID)
  lead.wire(u, stripPin(DAC_PIN), u, stripPin(target))
  doc.wires.push(...lead.doc.wires)
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts({ ...doc.parts, ...Object.fromEntries(Object.entries(AS_ON_THE_BENCH).map(([part, state]) => [partKey(u.id, part), state])) })
  loop.setRunning(true)
  let clock = 0
  let lab = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<Field, number>
  for (let i = 0; i < 400 && lab.passes < 1; i++) {
    clock += 30
    loop.advance(clock)
    const reply = await loop.inspect(u.id, { ranges: [{ addr: LAB, size: FIELDS.length * 4 }] })
    const view = new DataView(reply!.memory[0].bytes.buffer, reply!.memory[0].bytes.byteOffset)
    lab = Object.fromEntries(FIELDS.map((f, k) => [f, view.getUint32(k * 4, true)])) as Record<Field, number>
  }
  return { lab, halted: loop.snapshot()?.mcus[u.id]?.halted ?? null }
}

const outside = (value: number, bench: Spread, margin: number) => Math.max(bench.min - value, value - bench.max) - margin

describe("the pin lab of 2026-10-12 (firmware/ports/pinlab.c), run on the simulated Open746I-C as on the bench", () => {
  it("states its margins: the bench ADC's own error plus a step for levels, the pads' scatter plus two DAC steps for thresholds", () => {
    expect(BENCH_ADC_ERROR_MV).toBeNear(2.4, 0.05)
    expect(PAD_TO_PAD_SCATTER_MV, "PA13's falling edge, 1358.5 mV against the eight pads' 1339.6").toBeNear(18.9, 0.1)
  })

  it.each(Object.keys(BENCH.targets))("%s: finds the pad on PA4's lead, and reads its thresholds and levels as the bench did", async (target) => {
    const { lab, halted } = await pinLab(target)
    const bench = BENCH.targets[target]
    expect(halted).toBeNull()
    expect(lab.passes, "a pass completed").toBeGreaterThan(0)
    expect(lab.target, "the pad wired to PA4").toBe(padIndex(target))
    expect.soft(outside(lab.vdda_mv, BENCH.vdda_mv, LSB_MV), `VDDA ${lab.vdda_mv} mV against ${BENCH.vdda_mv.min}–${BENCH.vdda_mv.max}`).toBeLessThanOrEqual(0)
    for (const field of THRESHOLDS) {
      const gap = outside(lab[field], bench[field], THRESHOLD_MARGIN_MV)
      expect.soft(gap, `${field} ${lab[field]} mV against ${bench[field].min}–${bench[field].max} ± ${THRESHOLD_MARGIN_MV.toFixed(1)}`).toBeLessThanOrEqual(0)
    }
    for (const field of LEVELS) {
      const gap = outside(lab[field], bench[field], LEVEL_MARGIN_MV)
      const why = differenceOf(target, field)
      const said = `${field} ${lab[field]} mV against ${bench[field].min}–${bench[field].max} ± ${LEVEL_MARGIN_MV.toFixed(1)}`
      if (why) expect.soft(gap, `expected to differ (${why}): ${said}`).toBeGreaterThan(0)
      else expect.soft(gap, said).toBeLessThanOrEqual(0)
    }
  })
})
