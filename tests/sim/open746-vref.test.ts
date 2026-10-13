import { beforeAll, describe, expect, it } from "vitest"
import { STM32F746IG } from "@/mcu/chip"
import { parseElf } from "@/mcu/elf"
import { parsePad, Stm32 } from "@/mcu/stm32f429"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey, type Element } from "@/schematic/types"
import { referenceProblem, SimLoop, type McuStatus, type Snapshot } from "@/sim/loop"
import { BENCH_SINGLE_READING_SPREAD_LSB } from "../lib/adc-bench"
import { buffer, example } from "../lib/firmware"

const board = getDef("open746i-c")!
const ELF = "adc-f767-exemplar.elf"
const FULL = 4095
const NINE_BITS = 8
const TRUNCATIONS = 2
const NOISE_OF_A_MEAN = 0.5
const EXTERNAL_REFERENCE_VOLTS = 2.5
const AMS1117_VOLTS = 3.29
const CALIBRATION_VDDA = 3.3
const VREFINT_CAL = STM32F746IG.factory!.vrefintCal.value
const SETTLED_MS = 20
const RUN_MS = 100
const PA3 = "P19-3"
const PA4 = "P19-4"
const RAIL = "CN2-4"
const GROUND = "CN2-6"

type Reference = "fitted" | "external" | "nothing"
type Field = "flag" | "conversions" | "timerEvents" | "vrefint" | "averages" | "meanIn3" | "meanIn4"
const FIELDS: Field[] = ["flag", "conversions", "timerEvents", "vrefint", "averages", "meanIn3", "meanIn4"]

async function exemplarOn(reference: Reference) {
  const elf = example(ELF)
  const at = parseElf(buffer(elf)).symbols.find((s) => s.name === "exemplar")!.value
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
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
  if (reference === "external") {
    const source = b.place("dc-source", 80, 30, { value: `${EXTERNAL_REFERENCE_VOLTS} V` })
    b.wire(source, "+", u, "VREF+")
    b.wire(source, "-", u, GROUND)
  }
  doc.objects.push(...b.doc.objects)
  doc.wires.push(...b.doc.wires)
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts({ ...doc.parts, ...(reference === "fitted" ? {} : { [partKey(u.id, "VREFJ")]: { on: false } }) })
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  while (loop.booting) await new Promise((resolve) => setTimeout(resolve, 10))
  while (clock < SETTLED_MS + RUN_MS) {
    clock += 5
    loop.advance(clock)
  }
  const snap: Snapshot = loop.snapshot()!
  const reply = await loop.inspect(u.id, { ranges: [{ addr: at, size: 4 * FIELDS.length }] })
  const bytes = reply!.memory[0].bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const words = FIELDS.map((_, i) => view.getUint32(4 * i, true))
  const field = (name: Field) => words[FIELDS.indexOf(name)]
  const volts = (pin: string) => snap.pinVoltage[pinKey(u.id, pin)]
  const nine = (pad: string, referenceVolts: number) => ((volts(pad) / referenceVolts) * FULL) / NINE_BITS
  const mcu: McuStatus = snap.mcus[u.id]
  return { field, volts, nine, mcu }
}

const meanMatches = (got: number, want: number) => got > want - TRUNCATIONS && got <= want + NOISE_OF_A_MEAN

describe("VREF+ on the Open746I-C is a net of its own: the POWER JMP's VREF+ cap ties it to 3.3 V (Core746I schematic, VREF+1)", () => {
  it("is a wireable pin, P16-34 of the module, and the reference the board hands its MCU", () => {
    const pin = board.pins.find((p) => p.id === "VREF+")!
    expect(pin.connector).toBe("P16")
    expect(pin.connectorPin).toBe(34)
    expect(board.mcuVref).toBe("VREF+")
    const cap = (board.model as Element[]).find((e): e is Extract<Element, { kind: "SW" }> => e.kind === "SW" && e.part === "VREFJ")!
    expect([cap.a, cap.b, cap.closed]).toEqual(["VREF+", "$3v3", "on"])
    expect(board.parts.find((p) => p.id === "VREFJ")).toMatchObject({ type: "switch", initial: { on: true } })
  })
})

describe("the ADC exemplar on the Open746I-C against each reference VREF+ can have", () => {
  let fitted: Awaited<ReturnType<typeof exemplarOn>>
  let external: Awaited<ReturnType<typeof exemplarOn>>
  let nothing: Awaited<ReturnType<typeof exemplarOn>>

  beforeAll(async () => {
    fitted = await exemplarOn("fitted")
    external = await exemplarOn("external")
    nothing = await exemplarOn("nothing")
  })

  it("as shipped, the cap fitted: VREF+ is the 3.3 V rail and the readings are today's, with no complaint", () => {
    expect(fitted.volts("VREF+")).toBeNear(AMS1117_VOLTS, 0.01)
    expect(meanMatches(fitted.field("meanIn3"), fitted.nine(PA3, fitted.volts(RAIL))), `IN3 ${fitted.field("meanIn3")}`).toBe(true)
    expect(meanMatches(fitted.field("meanIn4"), fitted.nine(PA4, fitted.volts(RAIL))), `IN4 ${fitted.field("meanIn4")}`).toBe(true)
    expect(fitted.field("vrefint")).toBeNear(VREFINT_CAL, BENCH_SINGLE_READING_SPREAD_LSB)
    expect(fitted.mcu.reference).toBeNull()
    expect(fitted.mcu.unmodelled).toEqual([])
  })

  it("the cap off and 2.5 V wired to the VREF+ pin: every code scales by 3.29 / 2.5, VREFINT included", () => {
    expect(external.volts("VREF+")).toBeNear(EXTERNAL_REFERENCE_VOLTS, 1e-3)
    expect(meanMatches(external.field("meanIn3"), external.nine(PA3, EXTERNAL_REFERENCE_VOLTS)), `IN3 ${external.field("meanIn3")}`).toBe(true)
    expect(meanMatches(external.field("meanIn4"), external.nine(PA4, EXTERNAL_REFERENCE_VOLTS)), `IN4 ${external.field("meanIn4")}`).toBe(true)
    expect(external.field("meanIn3"), "half the rail against 2.5 V reads above half scale").toBeGreaterThan(fitted.field("meanIn3") * 1.25)
    expect(external.field("vrefint")).toBeNear((VREFINT_CAL * CALIBRATION_VDDA) / EXTERNAL_REFERENCE_VOLTS, BENCH_SINGLE_READING_SPREAD_LSB)
    expect(external.mcu.reference, "2.5 V is inside DS10916 Table 63 at VDDA 3.29 V").toBeNull()
  })

  it("the cap off and nothing on the pin: the reference collapses, every input above 0 V reads full scale, and the inspector says why", () => {
    expect(nothing.volts("VREF+")).toBeNear(0, 1e-3)
    expect(nothing.field("meanIn3")).toBe(FULL >> 3)
    expect(nothing.field("meanIn4")).toBe(FULL >> 3)
    expect(nothing.field("vrefint")).toBe(FULL)
    expect(nothing.field("conversions"), "the ADC still converts, on the same trigger").toBeGreaterThan(100)
    expect(nothing.mcu.reference).toBe("VREF+ floating: no ADC/DAC reference")
  })
})

describe("what the inspector says about a reference outside DS10916 Table 63 (1.7 V to VDDA, within 1.2 V of it)", () => {
  const VDDA = AMS1117_VOLTS
  const wired = { grounded: false, wired: true }

  it.each([
    [AMS1117_VOLTS, wired, null],
    [2.5, wired, null],
    [0, { grounded: false, wired: false }, "VREF+ floating: no ADC/DAC reference"],
    [0, { grounded: true, wired: true }, "VREF+ grounded: no ADC/DAC reference"],
    [1.5, wired, "VREF+ at 1.50 V: under the 1.7 V the ADC and DAC need (DS10916 Tables 63 and 74)"],
    [2.0, wired, "VREF+ at 2.00 V: 1.2 V or more under VDDA (3.29 V), outside DS10916 Table 63"],
    [3.6, wired, "VREF+ at 3.60 V: above VDDA (3.29 V), which DS10916 Table 63 does not allow"],
  ] as const)("%s V (%o) → %s", (volts, wiring, problem) => {
    expect(referenceProblem(volts, VDDA, wiring)).toBe(problem)
  })
})

function bareF746() {
  const mcu = new Stm32(STM32F746IG)
  mcu.load(buffer(example("adc-idle.elf")), "adc-idle.elf")
  mcu.run(1e-5)
  const volts = new Map<number, number>()
  mcu.analogRead = (pad) => volts.get(pad.port * 16 + pad.pin) ?? null
  const w = (addr: number, value: number) => mcu.bus.write(addr, value >>> 0, 4)
  const r = (addr: number) => mcu.bus.read(addr, 4) >>> 0
  const setPad = (name: string, v: number) => {
    const pad = parsePad(name)!
    volts.set(pad.port * 16 + pad.pin, v)
  }
  return { mcu, w, r, setPad }
}

const ADC1 = 0x40012000
const ADC = { SR: 0x00, SMPR1: 0x0c, SMPR2: 0x10, SQR3: 0x34, CR2: 0x08, DR: 0x4c }
const CCR = 0x40012304
const DAC = { CR: 0x40007400, DHR12R1: 0x40007408 }
const ADON = 1 << 0
const SWSTART = 1 << 30
const EOC = 1 << 1
const TSVREFE = 1 << 23
const SMP_480 = 7
const CONVERSION_480_SECONDS = ((480 + 12) / 8e6) * 1.2
const VREFINT = 17
const PA1_CHANNEL = 1
const DAC_EN1 = 1
const DAC_BOFF1 = 2
const READINGS = 101

function medianCode(chip: ReturnType<typeof bareF746>, channel: number) {
  const { mcu, w, r } = chip
  w(ADC1 + (channel < 10 ? ADC.SMPR2 : ADC.SMPR1), SMP_480 << ((channel % 10) * 3))
  w(ADC1 + ADC.SQR3, channel)
  w(ADC1 + ADC.CR2, ADON)
  const codes = Array.from({ length: READINGS }, () => {
    w(ADC1 + ADC.CR2, ADON | SWSTART)
    mcu.run(CONVERSION_480_SECONDS)
    expect(r(ADC1 + ADC.SR) & EOC).toBeTruthy()
    return r(ADC1 + ADC.DR)
  }).sort((a, b) => a - b)
  return codes[READINGS >> 1]
}

describe("the core's ADC and DAC take their full scale from VREF+ once the circuit sets it (RM0385 §15.3, §16.3)", () => {
  it("an input of half the reference reads half scale, and VREFINT reads its calibration scaled by 3.3 V / VREF+", () => {
    const chip = bareF746()
    chip.mcu.setReference(EXTERNAL_REFERENCE_VOLTS)
    chip.setPad("PA1", EXTERNAL_REFERENCE_VOLTS / 2)
    expect(medianCode(chip, PA1_CHANNEL)).toBeNear(FULL / 2, 1)
    chip.w(CCR, TSVREFE)
    expect(medianCode(chip, VREFINT)).toBeNear((VREFINT_CAL * CALIBRATION_VDDA) / EXTERNAL_REFERENCE_VOLTS, 1)
  })

  it("VDDA moving no longer moves a reference the circuit has set", () => {
    const chip = bareF746()
    chip.mcu.setReference(EXTERNAL_REFERENCE_VOLTS)
    chip.mcu.setSupply(3.0)
    chip.setPad("PA1", EXTERNAL_REFERENCE_VOLTS / 2)
    expect(medianCode(chip, PA1_CHANNEL)).toBeNear(FULL / 2, 1)
  })

  it("with VREF+ at 0 V any input above 0 V reads full scale and 0 V reads 0: the comparator measures every bit against nothing", () => {
    const chip = bareF746()
    chip.mcu.setReference(0)
    chip.setPad("PA1", 0.05)
    expect(medianCode(chip, PA1_CHANNEL)).toBe(FULL)
    chip.setPad("PA1", 0)
    expect(medianCode(chip, PA1_CHANNEL)).toBe(0)
  })

  it("the DAC puts out code / 4095 × VREF+, and with VREF+ gone its buffer sits at its floor", () => {
    const chip = bareF746()
    chip.mcu.setReference(EXTERNAL_REFERENCE_VOLTS)
    chip.w(DAC.CR, DAC_EN1 | DAC_BOFF1)
    chip.w(DAC.DHR12R1, FULL)
    expect(chip.mcu.dac.volts(0)).toBeNear(EXTERNAL_REFERENCE_VOLTS, 1e-9)
    chip.w(DAC.DHR12R1, 2048)
    expect(chip.mcu.dac.volts(0)).toBeNear((2048 / FULL) * EXTERNAL_REFERENCE_VOLTS, 1e-9)
    chip.w(DAC.CR, DAC_EN1)
    chip.mcu.setReference(0)
    expect(chip.mcu.dac.volts(0)).toBe(STM32F746IG.dac.buffered!.floorVolts)
  })
})
