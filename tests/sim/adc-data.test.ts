import { describe, expect, it } from "vitest"
import { STM32F429ZI, STM32F746IG, type ChipProfile } from "@/mcu/chip"
import { parsePad, Stm32 } from "@/mcu/stm32f429"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { SimLoop } from "@/sim/loop"
import { buffer, example } from "../lib/firmware"

const FULL = 4095
const VDD = 3.3
const ADC1 = 0x40012000
const ADC2 = 0x40012100
const R = { SR: 0x00, CR1: 0x04, CR2: 0x08, SMPR2: 0x10, JOFR1: 0x14, SQR3: 0x34, JSQR: 0x38, JDR1: 0x3c, DR: 0x4c }
const CSR = 0x40012300
const CCR = 0x40012304
const CDR = 0x40012308
const DMA2 = 0x40026400
const STREAM0 = { CR: DMA2 + 0x10, NDTR: DMA2 + 0x14, PAR: DMA2 + 0x18, M0AR: DMA2 + 0x1c }
const GPIOA = { MODER: 0x40020000, PUPDR: 0x4002000c, ODR: 0x40020014 }
const DAC = { CR: 0x40007400, DHR12R1: 0x40007408 }
const RAM = 0x20008000
const ADON = 1 << 0
const CONT = 1 << 1
const DMA = 1 << 8
const DDS = 1 << 9
const EOCS = 1 << 10
const ALIGN = 1 << 11
const JSWSTART = 1 << 22
const SWSTART = 1 << 30
const EOC = 1 << 1
const JEOC = 1 << 2
const OVR = 1 << 5
const RES_SHIFT = 24
const RES_CODE: Record<number, number> = { 12: 0, 10: 1, 8: 2, 6: 3 }
const JSQR_ONE_CHANNEL = (channel: number) => channel << 15
const SMP_480 = 7
const STREAM_EN = 1 << 0
const STREAM_CIRC = 1 << 8
const STREAM_MINC = 1 << 10
const STREAM_HALF_WORDS = (1 << 11) | (1 << 13)
const STREAM_WORDS = (2 << 11) | (2 << 13)
const CCR_DUAL_REGULAR = 0b00110
const CCR_DMA_MODE_2 = 2 << 14
const CCR_DDS = 1 << 13
const CSR_OVR1 = 1 << 5
const CSR_OVR2 = 1 << 13
const MODE = { input: 0, output: 1, analog: 3 }
const PULL = { none: 0, up: 1, down: 2 }
const PA1_CHANNEL = 1
const PA4_CHANNEL = 4
const READINGS = 51
const LONE_PAD_SPREAD_LSB = 4
const CONVERSION_SECONDS = 3e-6
const RUN_SECONDS = 40e-6

const code = (volts: number, bits = 12) => Math.round((volts / VDD) * ((1 << bits) - 1))

function bare(profile: ChipProfile = STM32F429ZI, circuit = new Map<number, number>()) {
  const mcu = new Stm32(profile)
  mcu.load(buffer(example("adc-idle.elf")), "adc-idle.elf")
  mcu.run(1e-5)
  if (circuit.size) mcu.analogRead = (pad) => circuit.get(pad.port * 16 + pad.pin) ?? null
  const w = (addr: number, value: number) => mcu.bus.write(addr, value >>> 0, 4)
  const r = (addr: number) => mcu.bus.read(addr, 4) >>> 0
  const requests = { adc1: 0 }
  const forward = mcu.adc[0].onDmaRequest
  mcu.adc[0].onDmaRequest = () => {
    requests.adc1++
    forward()
  }
  return { mcu, w, r, requests }
}

function wired(pads: Record<string, number>, profile: ChipProfile = STM32F429ZI) {
  const circuit = new Map<number, number>()
  for (const [name, volts] of Object.entries(pads)) {
    const pad = parsePad(name)!
    circuit.set(pad.port * 16 + pad.pin, volts)
  }
  return bare(profile, circuit)
}

type Chip = ReturnType<typeof bare>

function padA(chip: Chip, pin: number, mode: number, pull: number, high = false) {
  const field = (reg: number, value: number) => chip.w(reg, (chip.r(reg) & ~(3 << (2 * pin))) | (value << (2 * pin)))
  field(GPIOA.MODER, mode)
  field(GPIOA.PUPDR, pull)
  chip.w(GPIOA.ODR, high ? chip.r(GPIOA.ODR) | (1 << pin) : chip.r(GPIOA.ODR) & ~(1 << pin))
}

function medianCode(chip: Chip, channel: number) {
  chip.w(ADC1 + R.SMPR2, SMP_480 << (channel * 3))
  chip.w(ADC1 + R.SQR3, channel)
  chip.w(ADC1 + R.CR2, ADON)
  const codes = Array.from({ length: READINGS }, () => {
    chip.w(ADC1 + R.CR2, ADON | SWSTART)
    chip.mcu.run(((480 + 12) / 8e6) * 1.2)
    return chip.r(ADC1 + R.DR)
  }).sort((a, b) => a - b)
  return codes[READINGS >> 1]
}

function stream0(chip: Chip, from: number, count: number, size: "half" | "word", circular = false) {
  chip.w(STREAM0.CR, 0)
  chip.w(STREAM0.PAR, from)
  chip.w(STREAM0.M0AR, RAM)
  chip.w(STREAM0.NDTR, count)
  chip.w(STREAM0.CR, (size === "half" ? STREAM_HALF_WORDS : STREAM_WORDS) | STREAM_MINC | (circular ? STREAM_CIRC : 0) | STREAM_EN)
}

describe("an ADC pad alone on its net reads what the pad itself puts on it", () => {
  it("PA4 with its own DAC1 at code 2048 and nothing wired: ADC1 IN4 reads the DAC's output, not 0 V", () => {
    const chip = bare(STM32F746IG)
    padA(chip, PA4_CHANNEL, MODE.analog, PULL.none)
    chip.w(DAC.CR, 1)
    chip.w(DAC.DHR12R1, 2048)
    const dac = chip.mcu.dac.volts(0)!
    expect(medianCode(chip, PA4_CHANNEL)).toBeNear((dac / chip.mcu.dac.vref) * FULL, LONE_PAD_SPREAD_LSB)
  })

  it.each([
    ["a push-pull output driven high", FULL, MODE.output, PULL.none, true],
    ["a push-pull output driven low", 0, MODE.output, PULL.none, false],
    ["an input with its pull-up", FULL, MODE.input, PULL.up, false],
    ["an input with its pull-down", 0, MODE.input, PULL.down, false],
    ["a floating analog pad: the 0 V a floating node leaks to", 0, MODE.analog, PULL.none, false],
  ] as const)("PA1 as %s reads %i", (_, want, mode, pull, high) => {
    const chip = bare(STM32F746IG)
    padA(chip, PA1_CHANNEL, mode, pull, high)
    expect(medianCode(chip, PA1_CHANNEL)).toBeNear(want, LONE_PAD_SPREAD_LSB)
  })

  it("a voltage the circuit puts on the pad still wins over the pad's own drive", () => {
    const chip = wired({ PA1: VDD / 2 }, STM32F746IG)
    padA(chip, PA1_CHANNEL, MODE.output, PULL.none, true)
    expect(medianCode(chip, PA1_CHANNEL)).toBeNear(FULL / 2, LONE_PAD_SPREAD_LSB)
  })

  it("on the Open746I-C in the simulator: PA4 unwired, DAC1 at 2048, ADC1 IN4 reads the DAC", async () => {
    const elf = example("adc-idle.elf")
    const doc = lab1Board.build(GRID)
    const u = doc.objects.find((o) => o.def === "open746i-c")!
    u.props = { ...u.props, firmware: "adc-idle.elf", firmwareData: elf.toString("base64") }
    const loop = new SimLoop()
    loop.setDoc(doc)
    loop.setParts({ ...doc.parts })
    loop.setRunning(true)
    let clock = 0
    loop.advance(clock)
    while (loop.booting) await new Promise((resolve) => setTimeout(resolve, 10))
    for (; clock < 10; clock += 5) loop.advance(clock)
    const mcu = (loop as unknown as { mcus: Map<string, { mcu: { mcu: Stm32 } }> }).mcus.get(u.id)!.mcu.mcu
    const w = (addr: number, value: number) => mcu.bus.write(addr, value >>> 0, 4)
    w(GPIOA.MODER, mcu.bus.read(GPIOA.MODER, 4) | (MODE.analog << (2 * PA4_CHANNEL)))
    w(DAC.CR, 1)
    w(DAC.DHR12R1, 2048)
    w(ADC1 + R.SMPR2, SMP_480 << (PA4_CHANNEL * 3))
    w(ADC1 + R.SQR3, PA4_CHANNEL)
    w(ADC1 + R.CR2, ADON)
    w(ADC1 + R.CR2, ADON | SWSTART)
    for (let i = 0; i < 4; i++) loop.advance((clock += 5))
    const dac = mcu.dac.volts(0)!
    expect(mcu.analogRead({ port: 0, pin: PA4_CHANNEL }), "no circuit voltage: the pad is on no net").toBeNull()
    expect(mcu.bus.read(ADC1 + R.DR, 4)).toBeNear((dac / mcu.dac.vref) * FULL, 3 * LONE_PAD_SPREAD_LSB)
    loop.dispose()
  })
})

describe("data alignment (RM0385 §15.4, Figures 77–79)", () => {
  it.each([
    [12, "0xfff0", 0xfff0],
    [10, "0xffc0", 0xffc0],
    [8, "0xff00", 0xff00],
    [6, "0x00fc: byte-aligned, D5…D0 in bits 7:2", 0x00fc],
  ] as const)("regular, %i-bit, left-aligned full scale reads %s", (bits, _, want) => {
    const chip = wired({ PA1: VDD })
    chip.w(ADC1 + R.SQR3, PA1_CHANNEL)
    chip.w(ADC1 + R.CR1, RES_CODE[bits] << RES_SHIFT)
    chip.w(ADC1 + R.CR2, ADON | ALIGN)
    chip.w(ADC1 + R.CR2, ADON | ALIGN | SWSTART)
    chip.mcu.run(CONVERSION_SECONDS)
    expect(chip.r(ADC1 + R.DR)).toBe(want)
  })

  function injected(volts: number, offset: number, bits: number, align: number) {
    const chip = wired({ PA1: volts })
    chip.w(ADC1 + R.JSQR, JSQR_ONE_CHANNEL(PA1_CHANNEL))
    chip.w(ADC1 + R.JOFR1, offset)
    chip.w(ADC1 + R.CR1, RES_CODE[bits] << RES_SHIFT)
    chip.w(ADC1 + R.CR2, ADON | align)
    chip.w(ADC1 + R.CR2, ADON | align | JSWSTART)
    chip.mcu.run(CONVERSION_SECONDS)
    expect(chip.r(ADC1 + R.SR) & JEOC).toBeTruthy()
    return chip.r(ADC1 + R.JDR1)
  }

  it("injected, 12-bit, left-aligned full scale: SEXT in bit 15, D11…D0 in bits 14:3", () => {
    expect(injected(VDD, 0, 12, ALIGN)).toBe(0x7ff8)
  })

  it("injected, 6-bit, left-aligned full scale: SEXT in bits 15:7, D5…D0 in bits 6:1", () => {
    expect(injected(VDD, 0, 6, ALIGN)).toBe(0x007e)
  })

  it("injected minus a smaller JOFR1: the plain difference, right- and left-aligned", () => {
    const difference = code(2.0) - 482
    expect(injected(2.0, 482, 12, 0)).toBe(difference)
    expect(injected(2.0, 482, 12, ALIGN)).toBe(difference << 3)
  })

  it("injected minus a larger JOFR1 goes negative and is sign-extended, not clamped to 0", () => {
    const difference = code(0.5) - 2000
    expect(difference).toBeLessThan(0)
    expect(injected(0.5, 2000, 12, 0), "right-aligned").toBe(difference & 0xffff)
    expect(injected(0.5, 2000, 12, ALIGN), "left-aligned").toBe((difference << 3) & 0xffff)
    const sixBit = code(0.5, 6) - 20
    expect(injected(0.5, 20, 6, 0), "6-bit, right-aligned").toBe(sixBit & 0xffff)
    expect(injected(0.5, 20, 6, ALIGN), "6-bit, left-aligned").toBe((sixBit << 1) & 0xffff)
  })
})

describe("overrun, DMA and DDS (RM0385 §15.8)", () => {
  const converting = (cr2: number) => {
    const chip = wired({ PA1: VDD / 2 })
    chip.w(ADC1 + R.SQR3, PA1_CHANNEL)
    chip.w(ADC1 + R.CR2, cr2)
    chip.w(ADC1 + R.CR2, cr2 | SWSTART)
    return chip
  }
  const regular = (chip: Chip) => chip.mcu.adc[0].converted.regular

  it("DMA = 0, EOCS = 0, continuous, DR never read: no overrun detection, the converter keeps going (§15.8.3)", () => {
    const chip = converting(ADON | CONT)
    chip.mcu.run(RUN_SECONDS)
    expect(chip.r(ADC1 + R.SR) & OVR).toBe(0)
    expect(regular(chip)).toBeGreaterThan(10)
  })

  it("EOCS = 1, DR never read: OVR on the second conversion, which is aborted, and triggers are ignored until OVR is cleared (§15.8.2)", () => {
    const chip = converting(ADON | CONT | EOCS)
    chip.mcu.run(RUN_SECONDS)
    expect(chip.r(ADC1 + R.SR) & OVR).toBeTruthy()
    expect(regular(chip)).toBe(2)
    chip.w(ADC1 + R.CR2, ADON | CONT | EOCS | SWSTART)
    chip.mcu.run(RUN_SECONDS)
    expect(regular(chip), "SWSTART while OVR = 1").toBe(2)
    chip.w(ADC1 + R.SR, ~OVR)
    chip.r(ADC1 + R.DR)
    chip.w(ADC1 + R.CR2, ADON | EOCS | SWSTART)
    chip.mcu.run(RUN_SECONDS)
    expect(regular(chip), "OVR cleared, triggered again").toBe(3)
    expect(chip.r(ADC1 + R.SR) & OVR).toBe(0)
  })

  it("DMA = 1 with no stream serving it: OVR, no request for the lost data, conversion aborted, SWSTART ignored, injected unaffected; re-armed DMA + OVR cleared + trigger resumes (§15.8.1)", () => {
    const chip = converting(ADON | CONT | DMA | DDS)
    chip.mcu.run(RUN_SECONDS)
    expect(chip.r(ADC1 + R.SR) & OVR).toBeTruthy()
    expect(regular(chip)).toBe(2)
    expect(chip.requests.adc1, "only the first conversion's request").toBe(1)
    chip.w(ADC1 + R.CR2, ADON | CONT | DMA | DDS | SWSTART)
    chip.mcu.run(RUN_SECONDS)
    expect(regular(chip), "regular triggers ignored while OVR = 1").toBe(2)
    expect(chip.requests.adc1).toBe(1)
    chip.w(ADC1 + R.JSQR, JSQR_ONE_CHANNEL(PA1_CHANNEL))
    chip.w(ADC1 + R.CR2, ADON | CONT | DMA | DDS | JSWSTART)
    chip.mcu.run(CONVERSION_SECONDS)
    expect(chip.mcu.adc[0].converted.injected, "injected conversions are not impacted").toBe(1)
    stream0(chip, ADC1 + R.DR, 4, "half")
    chip.w(ADC1 + R.SR, ~OVR)
    chip.w(ADC1 + R.CR2, ADON | CONT | DMA | DDS | SWSTART)
    chip.mcu.run(RUN_SECONDS)
    expect(chip.r(STREAM0.NDTR), "the four transfers done").toBe(0)
    for (let i = 0; i < 4; i++) expect(chip.mcu.bus.read(RAM + 2 * i, 2)).toBeNear(FULL / 2, 1)
  })

  it("DDS = 0: no request after the stream's last transfer, so no overrun; DMA written 0 then 1 starts the next block", () => {
    const chip = wired({ PA1: VDD / 2 })
    chip.w(ADC1 + R.SQR3, PA1_CHANNEL)
    stream0(chip, ADC1 + R.DR, 4, "half")
    chip.w(ADC1 + R.CR2, ADON | CONT | DMA)
    chip.w(ADC1 + R.CR2, ADON | CONT | DMA | SWSTART)
    chip.mcu.run(RUN_SECONDS)
    expect(chip.r(STREAM0.NDTR)).toBe(0)
    expect(chip.requests.adc1, "one request per transfer, none after").toBe(4)
    expect(chip.r(ADC1 + R.SR) & OVR).toBe(0)
    expect(regular(chip), "the converter itself keeps going").toBeGreaterThan(10)
    chip.w(ADC1 + R.CR2, 0)
    stream0(chip, ADC1 + R.DR, 4, "half")
    chip.w(ADC1 + R.CR2, ADON | CONT | DMA)
    chip.w(ADC1 + R.CR2, ADON | CONT | DMA | SWSTART)
    chip.mcu.run(RUN_SECONDS)
    expect(chip.r(STREAM0.NDTR)).toBe(0)
    expect(chip.requests.adc1).toBe(8)
    expect(chip.r(ADC1 + R.SR) & OVR).toBe(0)
  })

  it.each([
    ["0", 0, "one buffer, then nothing: the HAL's DMAContinuousRequests = DISABLE with a circular stream", (n: number) => expect(n).toBe(4)],
    ["1", DDS, "requests go on through every wrap", (n: number) => expect(n).toBeGreaterThan(8)],
  ] as const)("circular stream of 4, DDS = %s: %s", (_, dds, __, check) => {
    const chip = wired({ PA1: VDD / 2 })
    chip.w(ADC1 + R.SQR3, PA1_CHANNEL)
    stream0(chip, ADC1 + R.DR, 4, "half", true)
    chip.w(ADC1 + R.CR2, ADON | CONT | DMA | dds)
    chip.w(ADC1 + R.CR2, ADON | CONT | DMA | dds | SWSTART)
    chip.mcu.run(RUN_SECONDS)
    check(chip.requests.adc1)
    expect(chip.r(ADC1 + R.SR) & OVR).toBe(0)
  })
})

describe("CDR in multi-ADC mode (RM0385 §15.9, §15.13.17)", () => {
  const dualContinuous = (ccr: number) => {
    const chip = wired({ PA1: 1.0, PA2: 2.0 })
    for (const base of [ADC1, ADC2]) chip.w(base + R.SMPR2, 0)
    chip.w(ADC1 + R.SQR3, 1)
    chip.w(ADC2 + R.SQR3, 2)
    chip.w(ADC2 + R.CR2, ADON | CONT)
    chip.w(CCR, ccr)
    chip.w(ADC1 + R.CR2, ADON | CONT)
    return chip
  }

  it("DMA mode 2 with no stream reading CDR: both ADCs overrun and stop, the requests stay one deep, CDR holds the latest pair", () => {
    const chip = dualContinuous(CCR_DUAL_REGULAR | CCR_DMA_MODE_2 | CCR_DDS)
    let requests = 0
    const forward = chip.mcu.adcBlock.common.onDmaRequest
    chip.mcu.adcBlock.common.onDmaRequest = () => {
      requests++
      forward()
    }
    chip.w(ADC1 + R.CR2, ADON | CONT | SWSTART)
    chip.mcu.run(1e-3)
    expect(chip.r(CSR) & (CSR_OVR1 | CSR_OVR2), "OVR1 and OVR2").toBe(CSR_OVR1 | CSR_OVR2)
    expect(chip.mcu.adc.slice(0, 2).map((a) => a.converted.regular), "stopped on the overrun").toEqual([2, 2])
    expect(requests, "one request: the first pair").toBe(1)
    chip.mcu.run(1e-3)
    expect(requests, "and nothing more while OVR = 1").toBe(1)
    const cdr = chip.r(CDR)
    expect(cdr & 0xffff, "DATA1 = ADC1's latest").toBe(chip.r(ADC1 + R.DR))
    expect(cdr >>> 16, "DATA2 = ADC2's latest").toBe(chip.r(ADC2 + R.DR))
    expect(chip.r(CDR), "a second read: still the latest").toBe(cdr)
  })

  it("CCR.DDS = 0: the stream's 4 words and then no request, no overrun", () => {
    const chip = dualContinuous(CCR_DUAL_REGULAR | CCR_DMA_MODE_2)
    stream0(chip, CDR, 4, "word")
    let requests = 0
    const forward = chip.mcu.adcBlock.common.onDmaRequest
    chip.mcu.adcBlock.common.onDmaRequest = () => {
      requests++
      forward()
    }
    chip.w(ADC1 + R.CR2, ADON | CONT | SWSTART)
    chip.mcu.run(RUN_SECONDS)
    expect(chip.r(STREAM0.NDTR)).toBe(0)
    expect(requests).toBe(4)
    expect(chip.r(CSR) & (CSR_OVR1 | CSR_OVR2)).toBe(0)
    for (let i = 0; i < 4; i++) {
      const word = chip.mcu.bus.read(RAM + 4 * i, 4) >>> 0
      expect(word & 0xffff, "ADC1 on PA1").toBeNear(code(1.0), 1)
      expect(word >>> 16, "ADC2 on PA2").toBeNear(code(2.0), 1)
    }
  })
})

describe("EOC is still what software polls", () => {
  it("a single conversion with EOCS = 0 sets EOC, and reading DR clears it", () => {
    const chip = wired({ PA1: VDD / 2 })
    chip.w(ADC1 + R.SQR3, PA1_CHANNEL)
    chip.w(ADC1 + R.CR2, ADON)
    chip.w(ADC1 + R.CR2, ADON | SWSTART)
    chip.mcu.run(CONVERSION_SECONDS)
    expect(chip.r(ADC1 + R.SR) & EOC).toBeTruthy()
    expect(chip.r(ADC1 + R.DR)).toBeNear(FULL / 2, 1)
    expect(chip.r(ADC1 + R.SR) & EOC).toBe(0)
  })
})
