import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { STM32F429ZI, STM32F746IG, type ChipProfile } from "@/mcu/chip"
import { parsePad } from "@/mcu/pads"
import { Stm32 } from "@/mcu/stm32f429"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { partKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { DT } from "@/sim/speeds"
import { example } from "../lib/firmware"

const BENCH_TEXT = readFileSync(join(import.meta.dirname, "..", "data", "open746-bench", "suspects-2026-10-12.txt"), "utf8")
const SUSPECTS_ELF = example("open746-suspects.elf")
const SUSPECTS = ["PA13", "PB3", "PA14", "PD9", "PB2"]
const CONTROLS = ["PD9", "PB2"]
const SPEEDS = [0, 1, 2, 3]
const DRAINS_FROM_SPEED: Record<string, number> = { PA13: 3, PB3: 3, PA14: 2 }
const AS_ON_THE_BENCH = { USB: { on: true }, S2: { on: false }, SW1: { on: false }, MUSB: { on: false }, BOOT: { on: false }, OTG_VBUS: { on: false } }
const RCC_AHB1ENR = 0x40023830
const GPIO = (port: number) => 0x40020000 + 0x400 * port
const REG = { MODER: 0x00, OSPEEDR: 0x08, PUPDR: 0x0c, IDR: 0x10, BSRR: 0x18 }
const WATCH_US = 5000
const NEVER = 0xffff
const SOLVER_STEP_US = DT * 1e6

type Report = Record<string, Record<number, { fall: number[]; rise: number[] }>>

function parseReport(text: string): Report {
  const report: Report = {}
  for (const line of text.split(/\r?\n/)) {
    const pad = /^(P[A-K]\d+) /.exec(line)?.[1]
    if (!pad) continue
    report[pad] = {}
    for (const m of line.matchAll(/speed=(\d) fall_us=([\d,]+) rise_us=([\d,]+)/g)) report[pad][Number(m[1])] = { fall: m[2].split(",").map(Number), rise: m[3].split(",").map(Number) }
  }
  return report
}

function releaseFromOutput(chip: ChipProfile, pad: string, speed: number, high: boolean) {
  const mcu = new Stm32(chip)
  const { port, pin } = parsePad(pad)!
  const at = (reg: number) => GPIO(port) + reg
  const field = (reg: number, value: number) => mcu.bus.write(at(reg), ((mcu.bus.read(at(reg), 4) & ~(3 << (2 * pin))) | (value << (2 * pin))) >>> 0, 4)
  mcu.bus.write(RCC_AHB1ENR, 0x7ff, 4)
  field(REG.OSPEEDR, speed)
  field(REG.PUPDR, 0)
  mcu.bus.write(at(REG.BSRR), high ? 1 << pin : 1 << (pin + 16), 4)
  field(REG.MODER, 1)
  const driven = (mcu.bus.read(at(REG.IDR), 4) >>> pin) & 1
  field(REG.MODER, 0)
  return { driven, released: (mcu.bus.read(at(REG.IDR), 4) >>> pin) & 1 }
}

describe("the F746's debug-port pads drain on release from output high at speed (bench, 2026-10-12, firmware/ports/suspects.c)", () => {
  const bench = parseReport(BENCH_TEXT)

  it("is in the chip profile as measured: PA13 and PB3 from very high speed, PA14 from high; the controls never", () => {
    expect(STM32F746IG.electrical.pads!.releaseFromHighDrainsAtSpeed).toEqual(DRAINS_FROM_SPEED)
    for (const pad of SUSPECTS)
      for (const speed of SPEEDS) {
        const drains = speed >= (DRAINS_FROM_SPEED[pad] ?? Infinity)
        expect.soft(bench[pad][speed].fall.every((us) => (drains ? us === 0 : us === NEVER)), `the bench: ${pad} at speed ${speed} ${drains ? "drains" : "holds"} released from high`).toBe(true)
        expect.soft(bench[pad][speed].rise.every((us) => us === NEVER), `the bench: ${pad} at speed ${speed} holds released from low`).toBe(true)
      }
  })

  it.each(SUSPECTS)("%s on the bare chip, every speed: released from high it reads 0 only from its draining speed on; released from low it stays 0", (pad) => {
    for (const speed of SPEEDS) {
      const drains = speed >= (DRAINS_FROM_SPEED[pad] ?? Infinity)
      const fromHigh = releaseFromOutput(STM32F746IG, pad, speed, true)
      expect.soft(fromHigh, `${pad} at speed ${speed}, released from high`).toEqual({ driven: 1, released: drains ? 0 : 1 })
      expect.soft(releaseFromOutput(STM32F746IG, pad, speed, false), `${pad} at speed ${speed}, released from low`).toEqual({ driven: 0, released: 0 })
    }
  })

  it("is not on the F429, which nobody has measured", () => {
    for (const pad of ["PA13", "PB3", "PA14"]) expect(releaseFromOutput(STM32F429ZI, pad, 3, true), pad).toEqual({ driven: 1, released: 1 })
  })

  describe("on the Open746I-C, the pads wired to its strips and headers, running the bench's own firmware", () => {
    let emulated: Report
    beforeAll(() => {
      const doc = lab1Board.build(GRID)
      const u = doc.objects.find((o) => o.def === "open746i-c")!
      u.props = { ...u.props, firmware: "open746-suspects.elf", firmwareData: SUSPECTS_ELF.toString("base64") }
      const b = builder(GRID)
      const term = b.place("serial-terminal", 34, -9, { baud: "115200" })
      b.wire(u, "VCP-TX", term, "RX")
      doc.objects.push(...b.doc.objects)
      doc.wires.push(...b.doc.wires)
      const loop = new SimLoop()
      loop.setDoc(doc)
      loop.setParts({ ...doc.parts, ...Object.fromEntries(Object.entries(AS_ON_THE_BENCH).map(([part, state]) => [partKey(u.id, part), state])) })
      loop.setRunning(true)
      let clock = 0
      const text = () => loop.snapshot()?.terminals[term.id]?.text ?? ""
      for (let i = 0; i < 400 && !text().includes("SUSPECTS 1"); i++) {
        clock += 30
        loop.advance(clock)
      }
      emulated = parseReport(text().split("SUSPECTS 1")[0])
    })

    it.each(SUSPECTS)("%s: released from high it falls within one solver step exactly where the bench's did, and holds past 5 ms elsewhere; released from low it holds", (pad) => {
      for (const speed of SPEEDS) {
        const drains = (bench[pad][speed].fall[0] ?? NEVER) < WATCH_US
        const run = emulated[pad]?.[speed]
        expect(run, `${pad} at speed ${speed} reported`).toBeDefined()
        expect.soft(run.fall.every((us) => (drains ? us <= SOLVER_STEP_US : us === NEVER)), `${pad} at speed ${speed}: fall ${run.fall.join(",")} µs`).toBe(true)
        expect.soft(run.rise.every((us) => us === NEVER), `${pad} at speed ${speed}: rise ${run.rise.join(",")} µs`).toBe(true)
      }
    })

    it("leaves the controls PD9 and PB2 holding at every speed", () => {
      for (const pad of CONTROLS) for (const speed of SPEEDS) expect.soft(emulated[pad][speed].fall, `${pad} at speed ${speed}`).toEqual([NEVER, NEVER, NEVER, NEVER, NEVER])
    })
  })
})
