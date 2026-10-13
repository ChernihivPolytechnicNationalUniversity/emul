import { beforeAll, describe, expect, it } from "vitest"
import { STM32F746IG } from "@/mcu/chip"
import { parseElf } from "@/mcu/elf"
import { heldVolts, rainMaxOhms } from "@/mcu/periph/adc"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { buffer, example } from "../lib/firmware"

const HOLD = STM32F746IG.adc.sampleHold!
const PIN_FARADS = STM32F746IG.electrical.pinCapacitance
const ADC_HZ = 27e6
const SAMPLE_CYCLES = [3, 15, 28, 56, 84, 112, 144, 480]
const FULL = 4095
const QUARTER_LSB = 0.25
const POT_OHMS = 10e3
const SERIES_OHMS = 2e3
const WIPER = 0.5
const SOURCE_OHMS = POT_OHMS * WIPER * (1 - WIPER) + SERIES_OHMS
const SCANS = 256
const ODE_STEPS = 200000
const SETTLE_SCANS = 8
const NOISE_SD_LSB = Math.sqrt(0.7727 * 1.331 ** 2 + 0.2273 * 3.859 ** 2)
const MEAN_TOLERANCE_LSB = 3 * (NOISE_SD_LSB / Math.sqrt(SCANS - SETTLE_SCANS)) + 0.5
const window = (k: number) => (k - 0.5) / ADC_HZ

function integrate(previous: number, source: { volts: number; ohms: number; farads: number }, seconds: number) {
  let pad = source.volts
  let cap = previous
  const dt = seconds / ODE_STEPS
  for (let i = 0; i < ODE_STEPS; i++) {
    const fromSource = (source.volts - pad) / source.ohms
    const intoCap = (pad - cap) / HOLD.switchOhms
    pad += ((fromSource - intoCap) / source.farads) * dt
    cap += (intoCap / HOLD.farads) * dt
  }
  return cap
}

describe("the F746 sample-and-hold charges C_ADC through the source impedance (DS10916 Table 63, Equation 1)", () => {
  it.each(SAMPLE_CYCLES.filter((k) => rainMaxOhms(k, ADC_HZ, 12, HOLD) > 0))("at R_AIN max for %i cycles a full-scale step settles to exactly 1/4 LSB, as Equation 1 promises", (k) => {
    const rain = rainMaxOhms(k, ADC_HZ, 12, HOLD)
    const vref = 3.3
    const held = heldVolts(vref, { volts: 0, ohms: rain, farads: 0 }, HOLD, window(k))
    expect((held / vref) * (FULL + 1), "error in LSB").toBeNear(QUARTER_LSB, 1e-9)
  })

  it("Equation 1 itself: 3 cycles at 27 MHz cannot settle to 1/4 LSB through any source, 15 cycles allow about 7.8 kΩ", () => {
    expect(rainMaxOhms(3, ADC_HZ, 12, HOLD)).toBeLessThan(0)
    expect(rainMaxOhms(15, ADC_HZ, 12, HOLD)).toBeNear(7835, 1)
  })

  it.each([
    ["the lab's pot and series resistor on a 5 pF pad", SOURCE_OHMS, PIN_FARADS],
    ["a 100 kΩ source on a 5 pF pad", 100e3, PIN_FARADS],
    ["a stiff source on a 100 pF pad", 10, 100e-12],
  ])("with the pad's own capacitance the two-pole charge matches a numerical integration: %s", (_, ohms, farads) => {
    const source = { volts: 1.2, ohms, farads }
    for (const k of [3, 15]) expect(heldVolts(3.3, source, HOLD, window(k)), `${k} cycles`).toBeNear(integrate(3.3, source, window(k)), 1e-5)
  })

  it("an open pad only shares charge: C_ADC and the pad meet at their charge-weighted mean", () => {
    const held = heldVolts(3.3, { volts: 0, ohms: Infinity, farads: PIN_FARADS }, HOLD, window(480))
    expect(held).toBeNear((3.3 * HOLD.farads) / (HOLD.farads + PIN_FARADS), 1e-9)
  })
})

describe("on the Open746I-C: a 10 kΩ pot through 2 kΩ on A2, A3 on 3.3 V, scanned by ADC3 at 27 MHz into memory by DMA", () => {
  const elf = example("adc-sample-hold.elf")
  const AT = parseElf(buffer(elf)).symbols.find((s) => s.name === "sample_hold")!.value
  const loop = new SimLoop()
  let clock = 0
  let snap: Snapshot
  let boardId = ""
  const runMs = (ms: number) => {
    const end = clock + ms
    while (clock < end) {
      clock = Math.min(end, clock + 1)
      loop.advance(clock)
    }
    snap = loop.snapshot()!
  }
  const word = (value: number) => new Uint8Array(new Uint32Array([value]).buffer)
  async function scan(code: number, request: number) {
    await loop.inspect(boardId, { write: [{ kind: "memory", addr: AT, bytes: word(code) }, { kind: "memory", addr: AT + 4, bytes: word(request) }] })
    for (let tries = 0; tries < 100; tries++) {
      runMs(1)
      const reply = await loop.inspect(boardId, { ranges: [{ addr: AT + 8, size: 4 + 4 * SCANS }] })
      const bytes = reply!.memory[0].bytes
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      if (view.getUint32(0, true) !== request) continue
      const codes = Array.from({ length: 2 * SCANS }, (_, i) => view.getUint16(4 + 2 * i, true))
      return { reference: codes.filter((_, i) => i % 2 === 0).slice(SETTLE_SCANS), source: codes.filter((_, i) => i % 2 === 1).slice(SETTLE_SCANS) }
    }
    throw new Error("the scan never finished")
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

  beforeAll(async () => {
    const doc = lab1Board.build(GRID)
    const u = doc.objects.find((o) => o.def === "open746i-c")!
    boardId = u.id
    u.props = { ...u.props, firmware: "adc-sample-hold.elf", firmwareData: elf.toString("base64") }
    const b = builder(GRID)
    const pot = b.place("potentiometer", 90, 4, { value: "10 kΩ", pos: String(WIPER) })
    const series = b.place("resistor", 90, 12, { value: "2 kΩ" })
    b.wire(u, "CN2-4", pot, "1")
    b.wire(pot, "2", u, "CN2-6")
    b.wire(pot, "W", series, "1")
    b.wire(series, "2", u, "CN3-3")
    b.wire(u, "CN3-4", u, "CN2-4")
    doc.objects.push(...b.doc.objects)
    doc.wires.push(...b.doc.wires)
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    loop.advance(clock)
    while (loop.booting) await new Promise((resolve) => setTimeout(resolve, 10))
    runMs(5)
  })

  const expected = (k: number) => {
    const rail = snap.pinVoltage[pinKey(boardId, "CN2-4")]
    const wiper = snap.pinVoltage[pinKey(boardId, "CN3-3")]
    let reference = 0
    let source = 0
    for (let i = 0; i < SETTLE_SCANS * 4; i++) {
      reference = heldVolts(source, { volts: rail, ohms: 0, farads: PIN_FARADS }, HOLD, window(k))
      source = heldVolts(reference, { volts: wiper, ohms: SOURCE_OHMS, farads: PIN_FARADS }, HOLD, window(k))
    }
    return { wiperCode: (wiper / rail) * FULL, sourceCode: (source / rail) * FULL, referenceCode: (reference / rail) * FULL, railCode: FULL }
  }

  it("480 cycles: the pot's channel reads its wiper within the noise, and the DMA filled the buffer scan by scan", async () => {
    const codes = await scan(7, 1)
    const want = expected(480)
    expect(codes.source).toHaveLength(SCANS - SETTLE_SCANS)
    expect(mean(codes.source), "A2 mean code").toBeNear(want.wiperCode, MEAN_TOLERANCE_LSB)
    expect(mean(codes.reference), "A3 mean code, clipped at full scale").toBeNear(FULL, MEAN_TOLERANCE_LSB + 2)
  })

  it("3 cycles: C_ADC carries the 3.3 V of A3 into A2 — the visible error the 2 kΩ and a short sampling time make", async () => {
    const codes = await scan(0, 2)
    const want = expected(3)
    expect(want.sourceCode - want.wiperCode, "predicted error, LSB").toBeGreaterThan(200)
    expect(mean(codes.source), "A2 mean code: the two-pole charge from A3's held voltage").toBeNear(want.sourceCode, MEAN_TOLERANCE_LSB)
    expect(mean(codes.reference), "A3 mean code: charged through R_ADC alone from A2's").toBeNear(want.referenceCode, MEAN_TOLERANCE_LSB)
  })

  it("15 cycles, Equation 1's 7.8 kΩ above the 4.5 kΩ source: the error is gone again", async () => {
    const codes = await scan(1, 3)
    expect(mean(codes.source), "A2 mean code").toBeNear(expected(15).wiperCode, MEAN_TOLERANCE_LSB)
  })
})
