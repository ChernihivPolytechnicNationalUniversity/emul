import { beforeAll, describe, expect, it } from "vitest"
import { STM32F746IG } from "@/mcu/chip"
import { parseElf } from "@/mcu/elf"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { BENCH_SINGLE_READING_SPREAD_LSB } from "../lib/adc-bench"
import { buffer, example } from "../lib/firmware"

const ELF = "adc-f767-exemplar.elf"
const TRIGGER_HZ = 96e6 / (95 + 1) / (499 + 1)
const RUN_SECONDS = 0.1
const SETTLED_MS = 20
const SAMPLES = 32
const NINE_BITS = 8
const TRUNCATIONS = 2
const NOISE_OF_A_MEAN = 0.5
const FULL = 4095
const PA3 = "P19-3"
const PA4 = "P19-4"
const RAIL = "CN2-4"
const GROUND = "CN2-6"

describe("the lecturer's STM32F767ZI_ADC exemplar ported to the Open746I-C: TIM5 TRGO at 2 kHz starts regular VREFINT and injected IN3/IN4 on ADC1", () => {
  const elf = example(ELF)
  const AT = parseElf(buffer(elf)).symbols.find((s) => s.name === "exemplar")!.value
  const loop = new SimLoop()
  let snap: Snapshot
  let boardId = ""
  let words: number[] = []
  let halfway: number[] = []
  const read = async () => {
    const reply = await loop.inspect(boardId, { ranges: [{ addr: AT, size: 28 }] })
    const bytes = reply!.memory[0].bytes
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return Array.from({ length: 7 }, (_, i) => view.getUint32(4 * i, true))
  }

  beforeAll(async () => {
    const doc = lab1Board.build(GRID)
    const u = doc.objects.find((o) => o.def === "open746i-c")!
    boardId = u.id
    u.props = { ...u.props, firmware: ELF, firmwareData: elf.toString("base64") }
    const b = builder(GRID)
    const divider = (pad: string, top: string, bottom: string, y: number) => {
      const upper = b.place("resistor", 90, y, { value: top })
      const lower = b.place("resistor", 90, y + 4, { value: bottom })
      b.wire(u, RAIL, upper, "1")
      b.wire(upper, "2", u, pad)
      b.wire(u, pad, lower, "1")
      b.wire(lower, "2", u, GROUND)
    }
    divider(PA3, "10 kΩ", "10 kΩ", 4)
    divider(PA4, "10 kΩ", "20 kΩ", 12)
    doc.objects.push(...b.doc.objects)
    doc.wires.push(...b.doc.wires)
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    let clock = 0
    loop.advance(clock)
    while (loop.booting) await new Promise((resolve) => setTimeout(resolve, 10))
    const runTo = (ms: number) => {
      while (clock < ms) {
        clock += 5
        loop.advance(clock)
      }
    }
    runTo(SETTLED_MS)
    halfway = await read()
    runTo(SETTLED_MS + RUN_SECONDS * 1000)
    snap = loop.snapshot()!
    words = await read()
  })

  type Field = "flag" | "conversions" | "timerEvents" | "vrefint" | "averages" | "meanIn3" | "meanIn4"
  const FIELDS: Field[] = ["flag", "conversions", "timerEvents", "vrefint", "averages", "meanIn3", "meanIn4"]
  const field = (name: Field) => words[FIELDS.indexOf(name)]
  const gained = (name: Field) => field(name) - halfway[FIELDS.indexOf(name)]

  it("runs at 96 MHz with nothing unmodelled", () => {
    const mcu = snap.mcus[boardId]
    expect(mcu?.running).toBe(true)
    expect(mcu?.sysclk).toBe(96e6)
    expect(mcu?.unmodelled).toEqual([])
  })

  it("TIM5 updates at 2 kHz and every TRGO converts once: regular EOC count = TIM5 events (EXTSEL 0100 = TIM5_TRGO on the F7)", () => {
    expect(gained("timerEvents"), "TIM5 CC1 events in 0.1 s").toBeNear(TRIGGER_HZ * RUN_SECONDS, 1)
    expect(gained("conversions"), "regular conversions in the same 0.1 s").toBeNear(gained("timerEvents"), 1)
  })

  it("the injected pair rides the same TRGO (JEXTSEL 1100): the 9-bit means of IN3 and IN4 are the dividers' voltages", () => {
    const rail = snap.pinVoltage[pinKey(boardId, RAIL)]
    const nine = (pad: string) => ((snap.pinVoltage[pinKey(boardId, pad)] / rail) * FULL) / NINE_BITS
    expect(gained("averages"), "32-pair rounds averaged in 0.1 s").toBeGreaterThanOrEqual(Math.floor((TRIGGER_HZ * RUN_SECONDS) / (2 * SAMPLES)) - 1)
    for (const [name, pad] of [
      ["meanIn3", PA3],
      ["meanIn4", PA4],
    ] as const) {
      expect(field(name), `${pad}: at most the >> 3 and the / 32 truncations below the divider's 9-bit code`).toBeGreaterThan(nine(pad) - TRUNCATIONS)
      expect(field(name), `${pad}: and not above it`).toBeLessThanOrEqual(nine(pad) + NOISE_OF_A_MEAN)
    }
  })

  it("the regular rank is VREFINT: the factory calibration within one reading's noise", () => {
    expect(field("vrefint")).toBeNear(STM32F746IG.factory!.vrefintCal.value, BENCH_SINGLE_READING_SPREAD_LSB)
  })
})
