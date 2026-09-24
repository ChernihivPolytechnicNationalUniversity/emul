/**
 * A core running ahead of the solver over quiet steps (`SimLoop.quietSteps`) must leave the
 * simulation exactly where stepping in lockstep does: every example with firmware runs twice,
 * batched and step by step, and the node voltages, the core's registers and cycle count and
 * what the UI shows must agree after every tick — through touches and typed text too.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { cubeDemo, lab1Board, lab1RunningLight, lcdDemo, nucleoAdc, nucleoBlink, nucleoI2c, nucleoPwm, nucleoSerial, nucleoSquare, touchDemo, type Example } from "@/schematic/examples"
import { partKey } from "@/schematic/types"
import type { LocalCore } from "@/sim/core-host"
import { SimLoop } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

const CASES: [Example, Record<string, string>][] = [
  [nucleoBlink, { U1: "nucleo-blink.elf" }],
  [nucleoSquare, { U1: "nucleo-square.elf" }],
  [nucleoPwm, { U1: "nucleo-pwm.elf" }],
  [nucleoSerial, { U1: "nucleo-uart.elf" }],
  [nucleoI2c, { U1: "nucleo-i2c.elf" }],
  [nucleoAdc, { U1: "nucleo-adc.elf" }],
  [lab1Board, { U1: "lab1-f746.elf" }],
  [lab1RunningLight, { U1: "lab1-running-light.elf" }],
  [lcdDemo, { U1: "open746-lcd.elf" }],
  [touchDemo, { U1: "open746-touch.elf" }],
  [cubeDemo, { U1: "open746-cube.elf" }],
]

function build(ex: Example, firmware: Record<string, string>) {
  const doc = ex.build(GRID)
  for (const [ref, name] of Object.entries(firmware)) {
    const obj = doc.objects.find((o) => o.props?.ref === ref)!
    obj.props = { ...obj.props, firmware: name, firmwareData: exampleBase64(name) }
  }
  return doc
}

function start(built: ReturnType<typeof build>, quietMax: number) {
  const doc = structuredClone(built)
  const loop = new SimLoop()
  loop.quietMax = quietMax
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  loop.advance(0)
  return { doc, loop }
}

/** Everything that must match: the engine's state, the core's, and the snapshot bar the wall-clock fields. */
function state(loop: SimLoop) {
  const l = loop as unknown as { engine: { time: number; v: Float64Array }; mcus: Map<string, { mcu: LocalCore }> }
  const cores = [...l.mcus.values()].map(({ mcu }) => {
    const c = mcu.mcu.cpu
    return { cycles: c.cycles, instructions: c.instructions, pc: c.pc, r: [...c.r], time: mcu.mcu.time }
  })
  const { displays: _d, rate: _r, trace: _t, ...snap } = loop.snapshot()!
  return JSON.stringify({ time: l.engine.time, v: [...l.engine.v], cores, snap })
}

/** Where two states part, for the failure message. */
function firstDiff(x: unknown, y: unknown, path = ""): string {
  if (typeof x !== "object" || x === null || typeof y !== "object" || y === null) return x === y ? "" : `${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`
  const a = x as Record<string, unknown>
  const b = y as Record<string, unknown>
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`)
    if (d) return d
  }
  return ""
}

describe("quiet steps", () => {
  it.each(CASES.map(([ex, fw]) => [ex.id, ex, fw] as const))("%s runs the same batched as in lockstep", (_id, ex, fw) => {
    const doc = build(ex, fw)
    const a = start(doc, 500)
    const b = start(doc, 1)
    let batched = 0
    const la = a.loop as unknown as { quietStep: (...x: unknown[]) => void }
    const quietStep = la.quietStep.bind(a.loop)
    la.quietStep = (...x: unknown[]) => {
      batched++
      quietStep(...x)
    }
    const lcd = a.doc.objects.find((o) => o.def === "lcd7-f")
    const term = a.doc.objects.find((o) => o.def === "serial-terminal")
    for (let tick = 1; tick <= 40; tick++) {
      // Input between ticks, as the UI gives it: a touch held for a while, then a release; a line typed.
      if (lcd && (tick === 4 || tick === 25)) {
        const press = tick === 4 ? { pressed: true, x: 500, y: 300 } : { pressed: false }
        for (const s of [a, b]) s.loop.setParts({ ...s.doc.parts, [partKey(lcd.id, "PANEL")]: press })
      }
      if (term && tick === 5) for (const s of [a, b]) s.loop.sendSerial(term.id, "hi")
      a.loop.advance(tick * 30)
      b.loop.advance(tick * 30)
      const sa = state(a.loop)
      const sb = state(b.loop)
      if (sa !== sb) expect.fail(`after tick ${tick}: ${firstDiff(JSON.parse(sa), JSON.parse(sb))}`)
    }
    a.loop.dispose()
    b.loop.dispose()
    if (ex === cubeDemo || ex === nucleoBlink) expect(batched, "steps taken as quiet").toBeGreaterThan(1000)
  })
})
