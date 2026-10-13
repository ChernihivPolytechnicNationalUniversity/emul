import { describe, expect, it } from "vitest"
import { STM32F429ZI, STM32F746IG, type NoiseMixture } from "@/mcu/chip"
import { DAC_LFSR_PRELOAD, lfsrNext, MixtureNoise } from "@/mcu/periph/adc"
import { parsePad, Stm32 } from "@/mcu/stm32f429"
import { BENCH_DAC_CODES, benchCodes, benchResiduals, mean, median, quantile, type BenchPath } from "../lib/adc-bench"
import { buffer, example } from "../lib/firmware"

const NOISE = STM32F746IG.adc.noise!
const DRAWS = 200000
const Z99 = 2.576
const QUANTILES = [0.01, 0.025, 0.05, 0.1, 0.25, 0.75, 0.9, 0.95, 0.975, 0.99]
const GAUSSIAN_KURTOSIS = 3
const FULL = 4095

const ADC = [0x40012000, 0x40012100, 0x40012200]
const R = { SR: 0x00, CR1: 0x04, CR2: 0x08, SMPR1: 0x0c, SMPR2: 0x10, SQR1: 0x2c, SQR3: 0x34, JSQR: 0x38, JDR1: 0x3c, DR: 0x4c }
const CCR = 0x40012304
const CDR = 0x40012308
const DAC = { CR: 0x40007400, SWTRIGR: 0x40007404, DHR12R1: 0x40007408, DOR1: 0x4000742c }
const DMA2 = 0x40026400
const STREAM0 = { CR: DMA2 + 0x10, NDTR: DMA2 + 0x14, PAR: DMA2 + 0x18, M0AR: DMA2 + 0x1c }
const TIM6 = 0x40001000
const RCC_APB1ENR = 0x40023840
const TIM6EN = 1 << 4
const GPIOA_MODER = 0x40020000
const RAM = 0x20008000
const ADON = 1 << 0
const CONT = 1 << 1
const SWSTART = 1 << 30
const JSWSTART = 1 << 22
const EOC = 1 << 1
const JEOC = 1 << 2
const TSVREFE = 1 << 23
const SMP_480 = 7
const ADC_CYCLES_PER_SECOND = 8e6
const CONVERSION_480 = (480 + 12) / ADC_CYCLES_PER_SECOND
const VREFINT = 17
const PA4_CHANNEL = 4

type Mixture = NoiseMixture

function generated(mixture: Mixture, seed: number): number[] {
  const noise = new MixtureNoise(seed)
  const offsets = new MixtureNoise(seed ^ 0x55555555)
  return Array.from({ length: DRAWS }, () => {
    const u = offsets.uniform() - 0.5
    return Math.round(u + noise.draw(mixture)) - Math.round(u)
  })
}

function kurtosis(xs: number[]) {
  const m = mean(xs)
  const v = mean(xs.map((x) => (x - m) ** 2))
  return mean(xs.map((x) => (x - m) ** 4)) / (v * v)
}

function quantileInterval(sorted: number[], p: number): [number, number] {
  const n = sorted.length
  const spread = Z99 * Math.sqrt(n * p * (1 - p))
  return [sorted[Math.max(0, Math.floor(n * p - spread))], sorted[Math.min(n - 1, Math.ceil(n * p + spread))]]
}

function within(xs: number[], lsb: number) {
  return xs.filter((x) => Math.abs(x) <= lsb).length / xs.length
}

describe("ADC noise: the bench's mixture, generated deterministically", () => {
  const paths: [BenchPath, string, Mixture][] = [
    ["vrefint", "the ADC alone (VREFINT, 900 readings)", NOISE.alone],
    ["pa4", "through the DAC buffer (PA4, 700 readings off the rails)", NOISE.throughDacBuffer],
  ]

  it("is the same sequence for the same seed, and starts over on a reseed", () => {
    const a = new MixtureNoise(NOISE.seed)
    const b = new MixtureNoise(NOISE.seed)
    const first = Array.from({ length: 1000 }, () => a.draw(NOISE.alone))
    expect(Array.from({ length: 1000 }, () => b.draw(NOISE.alone))).toEqual(first)
    a.reseed()
    expect(Array.from({ length: 1000 }, () => a.draw(NOISE.alone))).toEqual(first)
  })

  describe.each(paths)("%s: %s", (path, _, mixture) => {
    const bench = benchResiduals(path).sort((x, y) => x - y)
    const model = generated(mixture, NOISE.seed).sort((x, y) => x - y)

    it.each(QUANTILES)("its %f quantile lies inside the bench's 99 % distribution-free interval", (p) => {
      const [lo, hi] = quantileInterval(bench, p)
      const q = quantile(model, p)
      expect(q, `model ${q}, bench interval ${lo}…${hi}`).toBeGreaterThanOrEqual(lo)
      expect(q).toBeLessThanOrEqual(hi)
    })

    it("puts as many readings within ±1 LSB of the median as the bench does", () => {
      const share = within(bench, 1)
      expect(within(model, 1)).toBeNear(share, Z99 * Math.sqrt((share * (1 - share)) / bench.length))
    })

    it("is heavy-tailed like the bench, not Gaussian", () => {
      expect(kurtosis(bench), "bench kurtosis").toBeGreaterThan(GAUSSIAN_KURTOSIS + 1)
      expect(kurtosis(model), "model kurtosis").toBeGreaterThan(GAUSSIAN_KURTOSIS + 1)
    })
  })

  it("is uncorrelated from one conversion to the next, like the bench's (lag-1 ≈ 0)", () => {
    const noise = new MixtureNoise(NOISE.seed)
    const xs = Array.from({ length: DRAWS }, () => noise.draw(NOISE.throughDacBuffer))
    const m = mean(xs)
    let num = 0
    let den = 0
    for (let i = 0; i < xs.length; i++) {
      den += (xs[i] - m) ** 2
      if (i) num += (xs[i] - m) * (xs[i - 1] - m)
    }
    expect(Math.abs(num / den)).toBeLessThan(Z99 / Math.sqrt(DRAWS))
  })
})

function bareF746(chip = STM32F746IG) {
  const mcu = new Stm32(chip)
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

function convertMany(chip: ReturnType<typeof bareF746>, adc: number, channel: number, count: number): number[] {
  const { mcu, w, r } = chip
  const base = ADC[adc - 1]
  w(base + (channel < 10 ? R.SMPR2 : R.SMPR1), SMP_480 << ((channel % 10) * 3))
  w(base + R.SQR3, channel)
  w(base + R.CR2, ADON)
  return Array.from({ length: count }, () => {
    w(base + R.CR2, ADON | SWSTART)
    mcu.run(CONVERSION_480 * 1.2)
    expect(r(base + R.SR) & EOC).toBeTruthy()
    return r(base + R.DR)
  })
}

describe("the F746's ADC applies the noise of the path a pad sits on", () => {
  it("VREFINT: the ADC-alone path, centred on the factory calibration, as wide as the bench's", () => {
    const chip = bareF746()
    chip.w(CCR, TSVREFE)
    const codes = convertMany(chip, 1, VREFINT, 900)
    const centre = median(codes)
    expect(centre, "median at VDDA = 3.3 V").toBe(STM32F746IG.factory!.vrefintCal.value)
    const bench = benchResiduals("vrefint")
    const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)))
    expect(sd(codes), "spread in LSB").toBeNear(sd(bench), Z99 * sd(bench) * Math.sqrt(2 / bench.length) * 2)
    expect(Math.max(...codes.map((c) => Math.abs(c - centre))), "no reading wilder than the bench's own worst").toBeLessThanOrEqual(Math.max(...bench.map(Math.abs)) + 2)
  })

  it.each(BENCH_DAC_CODES)("DAC code %i on PA4, read back through the buffered output: the bench's mean code", (code) => {
    const chip = bareF746()
    chip.w(GPIOA_MODER, (chip.r(GPIOA_MODER) & ~(3 << (2 * PA4_CHANNEL))) | (3 << (2 * PA4_CHANNEL)))
    chip.w(DAC.CR, 1)
    chip.w(DAC.DHR12R1, code)
    const codes = convertMany(chip, 1, PA4_CHANNEL, 100)
    const bench = benchCodes("pa4", code)
    const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)))
    const tolerance = Z99 * Math.sqrt((sd(bench) ** 2 + sd(codes) ** 2) / bench.length) + BENCH_LINE_RESIDUAL_LSB
    expect(mean(codes), `bench mean ${mean(bench).toFixed(2)} ± ${tolerance.toFixed(2)}`).toBeNear(mean(bench), tolerance)
    expect(sd(codes), "spread: the DAC-buffer path's, several LSB, not the ADC alone's 2").toBeGreaterThan(sd(benchResiduals("vrefint")) * 1.5)
  })
})

const BENCH_LINE_RESIDUAL_LSB = 1.5
const DS10916_TABLE_74 = { buffered: { lowest: 0.2, headroom: 0.2 }, offsetLsb: 12, midCode: 0x800 }

describe("DAC: the buffered output's swing, BOFF, and the wave generators (RM0385 §16.3.8–16.3.9, exam Q23–Q24)", () => {
  it("the buffered output stops short of the rails by what the bench saw, inside the swing DS10916 Table 74 guarantees", () => {
    const chip = bareF746()
    chip.w(DAC.CR, 1)
    const at = (code: number) => {
      chip.w(DAC.DHR12R1, code)
      return chip.mcu.dac.volts(0)!
    }
    const vdda = chip.mcu.dac.vref
    expect(at(0), "code 0").toBeGreaterThan(0.02)
    expect(at(0), "code 0").toBeLessThanOrEqual(DS10916_TABLE_74.buffered.lowest)
    expect(at(FULL), "code 4095").toBeLessThan(vdda - 0.02)
    expect(at(FULL), "code 4095").toBeGreaterThanOrEqual(vdda - DS10916_TABLE_74.buffered.headroom)
    expect((at(DS10916_TABLE_74.midCode) / vdda) * FULL - DS10916_TABLE_74.midCode, "offset at mid-scale, LSB").toBeLessThanOrEqual(DS10916_TABLE_74.offsetLsb)
  })

  it("BOFF1 = 1 bypasses the buffer: the full 0 … VREF+ range, and the inspector says the 15 kΩ is not modelled", () => {
    const chip = bareF746()
    chip.w(DAC.CR, 1 | 2)
    chip.w(DAC.DHR12R1, 0)
    expect(chip.mcu.dac.volts(0)).toBe(0)
    chip.w(DAC.DHR12R1, FULL)
    expect(chip.mcu.dac.volts(0)).toBeNear(chip.mcu.dac.vref, 1e-12)
    expect([...chip.mcu.unmodelled.features.keys()].join("\n")).toMatch(/DAC1 with its output buffer off/)
  })

  it("the F429, with no bench fit, keeps the ideal transfer", () => {
    const chip = bareF746(STM32F429ZI)
    chip.w(DAC.CR, 1)
    chip.w(DAC.DHR12R1, 0)
    expect(chip.mcu.dac.volts(0)).toBe(0)
  })

  const NOISE_WAVE = (mamp: number) => 1 | (1 << 2) | (7 << 3) | (1 << 6) | (mamp << 8)
  const TRIANGLE_WAVE = (mamp: number, tsel: number) => 1 | (1 << 2) | (tsel << 3) | (2 << 6) | (mamp << 8)

  it("noise: DOR runs 0xAAA, 0xD55, … through every one of the 4095 non-zero LFSR states and back", () => {
    const chip = bareF746()
    chip.w(DAC.DHR12R1, 0)
    chip.w(DAC.CR, NOISE_WAVE(11))
    const seen: number[] = []
    for (let i = 0; i <= 4095; i++) {
      chip.w(DAC.SWTRIGR, 1)
      seen.push(chip.r(DAC.DOR1))
    }
    expect(seen.slice(0, 2)).toEqual([DAC_LFSR_PRELOAD, 0xd55])
    expect(new Set(seen.slice(0, 4095)).size).toBe(4095)
    expect(seen[4095], "period 4095").toBe(DAC_LFSR_PRELOAD)
    expect(seen.includes(0), "the all-zero state never occurs").toBe(false)
    let lfsr = DAC_LFSR_PRELOAD
    for (let i = 0; i < 10; i++) lfsr = lfsrNext(lfsr)
    expect(seen[10]).toBe(lfsr)
  })

  it("noise with MAMP = 3 adds only LFSR bits 3:0 to DHR, and saturates at 4095 instead of wrapping", () => {
    const chip = bareF746()
    chip.w(DAC.DHR12R1, 2000)
    chip.w(DAC.CR, NOISE_WAVE(3))
    const low: number[] = []
    for (let i = 0; i < 64; i++) {
      chip.w(DAC.SWTRIGR, 1)
      low.push(chip.r(DAC.DOR1))
    }
    expect(Math.min(...low)).toBeGreaterThanOrEqual(2000)
    expect(Math.max(...low)).toBeLessThanOrEqual(2015)
    expect(new Set(low).size, "uses the masked range").toBeGreaterThan(8)
    chip.w(DAC.DHR12R1, 4090)
    for (let i = 0; i < 64; i++) {
      chip.w(DAC.SWTRIGR, 1)
      expect(chip.r(DAC.DOR1)).toBeLessThanOrEqual(FULL)
    }
  })

  it("clearing WAVE1 resets the LFSR to 0xAAA", () => {
    const chip = bareF746()
    chip.w(DAC.CR, NOISE_WAVE(11))
    for (let i = 0; i < 5; i++) chip.w(DAC.SWTRIGR, 1)
    chip.w(DAC.CR, 1 | (1 << 2) | (7 << 3))
    chip.w(DAC.CR, NOISE_WAVE(11))
    chip.w(DAC.SWTRIGR, 1)
    expect(chip.r(DAC.DOR1)).toBe(DAC_LFSR_PRELOAD)
  })

  it("triangle with MAMP = 2 on TIM6 TRGO at 10 kHz: DHR + 1 … DHR + 7 … DHR, a 14-trigger period, 714 Hz", () => {
    const chip = bareF746()
    chip.w(DAC.DHR12R1, 100)
    chip.w(DAC.CR, TRIANGLE_WAVE(2, 0))
    const dor: number[] = []
    const forward = chip.mcu.dac.onOutput
    chip.mcu.dac.onOutput = (ch, v) => {
      if (ch === 0 && v !== null) dor.push(chip.mcu.dac.output(0))
      forward(ch, v)
    }
    chip.w(RCC_APB1ENR, chip.r(RCC_APB1ENR) | TIM6EN)
    chip.w(TIM6 + 0x28, 15)
    chip.w(TIM6 + 0x2c, 99)
    chip.w(TIM6 + 0x14, 1)
    chip.w(TIM6 + 0x04, 2 << 4)
    chip.w(TIM6 + 0x00, 1)
    chip.mcu.run(0.0028 + 50e-6)
    expect(dor.slice(0, 14)).toEqual([101, 102, 103, 104, 105, 106, 107, 106, 105, 104, 103, 102, 101, 100])
    expect(dor.slice(14, 28), "and again").toEqual(dor.slice(0, 14))
    expect(dor, "one step per TRGO: the UG that loads PSC (MMS = 000 puts UG on TRGO), then 28 updates in 2.8 ms — 10 kHz / 14 = 714 Hz").toHaveLength(1 + 28)
  })
})

function dma2Stream0(chip: ReturnType<typeof bareF746>, channel: number, size: 2 | 4, from: number, count: number) {
  const bits = size === 4 ? 2 : 1
  chip.w(STREAM0.CR, 0)
  chip.w(STREAM0.PAR, from)
  chip.w(STREAM0.M0AR, RAM)
  chip.w(STREAM0.NDTR, count)
  chip.w(STREAM0.CR, (channel << 25) | (bits << 13) | (bits << 11) | (1 << 10) | 1)
  return () => Array.from({ length: count }, (_, i) => chip.mcu.bus.read(RAM + i * size, size) >>> 0)
}

const code = (v: number) => (v / 3.3) * FULL
const SPREAD = 14

describe("multi-ADC modes (CCR.MULTI, RM0385 §15.9; exam Q18)", () => {
  const voltages = { PA1: 1.0, PA2: 1.5, PA3: 2.0 }
  const chipWithInputs = () => {
    const chip = bareF746()
    for (const [pad, v] of Object.entries(voltages)) chip.setPad(pad, v)
    for (const base of ADC) {
      chip.w(base + R.SMPR2, 0)
      chip.w(base + R.CR2, ADON)
    }
    return chip
  }
  const step = (chip: ReturnType<typeof bareF746>) => chip.mcu.run(4e-6)

  it("dual regular simultaneous, DMA mode 2: one SWSTART on ADC1 converts on both, CDR packs ADC2 | ADC1 into each DMA word", () => {
    const chip = chipWithInputs()
    chip.w(ADC[0] + R.SQR3, 1)
    chip.w(ADC[1] + R.SQR3, 2)
    chip.w(CCR, 0b00110 | (2 << 14) | (1 << 13))
    const words = dma2Stream0(chip, 0, 4, CDR, 4)
    for (let i = 0; i < 4; i++) {
      chip.w(ADC[0] + R.CR2, ADON | SWSTART)
      step(chip)
    }
    expect(chip.mcu.adc.map((a) => a.converted.regular)).toEqual([4, 4, 0])
    for (const word of words()) {
      expect(word & 0xffff, "ADC1 on PA1").toBeNear(code(voltages.PA1), SPREAD)
      expect(word >>> 16, "ADC2 on PA2").toBeNear(code(voltages.PA2), SPREAD)
    }
  })

  it("triple regular simultaneous, DMA mode 1: half-words ADC1, ADC2, ADC3 in turn", () => {
    const chip = chipWithInputs()
    ADC.forEach((base, i) => chip.w(base + R.SQR3, i + 1))
    chip.w(CCR, 0b10110 | (1 << 14) | (1 << 13))
    const halves = dma2Stream0(chip, 0, 2, CDR, 6)
    for (let i = 0; i < 2; i++) {
      chip.w(ADC[0] + R.CR2, ADON | SWSTART)
      step(chip)
    }
    const want = [voltages.PA1, voltages.PA2, voltages.PA3].map(code)
    halves().forEach((h, i) => expect(h, `item ${i}`).toBeNear(want[i % 3], SPREAD))
  })

  it("dual injected simultaneous: JSWSTART on ADC1 fills JDR1 of both and raises both JEOCs", () => {
    const chip = chipWithInputs()
    chip.w(ADC[0] + R.JSQR, 1 << 15)
    chip.w(ADC[1] + R.JSQR, 2 << 15)
    chip.w(CCR, 0b00101)
    chip.w(ADC[0] + R.CR2, ADON | JSWSTART)
    step(chip)
    expect(chip.r(ADC[0] + R.SR) & JEOC).toBeTruthy()
    expect(chip.r(ADC[1] + R.SR) & JEOC).toBeTruthy()
    expect(chip.r(ADC[0] + R.JDR1)).toBeNear(code(voltages.PA1), SPREAD)
    expect(chip.r(ADC[1] + R.JDR1)).toBeNear(code(voltages.PA2), SPREAD)
  })

  it("dual alternate trigger: the injected triggers go to ADC1, ADC2, ADC1, …", () => {
    const chip = chipWithInputs()
    chip.w(ADC[0] + R.JSQR, 1 << 15)
    chip.w(ADC[1] + R.JSQR, 2 << 15)
    chip.w(CCR, 0b01001)
    const seen: number[][] = []
    for (let i = 0; i < 3; i++) {
      chip.w(ADC[0] + R.CR2, ADON | JSWSTART)
      step(chip)
      seen.push(chip.mcu.adc.map((a) => a.converted.injected))
    }
    expect(seen).toEqual([
      [1, 0, 0],
      [1, 1, 0],
      [2, 1, 0],
    ])
  })

  it("dual interleaved, continuous, DELAY = 20 cycles: ADC2 runs 20 ADC clocks behind ADC1; DMA mode 2 pairs them", () => {
    const chip = chipWithInputs()
    chip.w(ADC[0] + R.SQR3, 1)
    chip.w(ADC[1] + R.SQR3, 1)
    chip.w(ADC[1] + R.CR2, ADON | CONT)
    chip.w(CCR, 0b00111 | (15 << 8) | (2 << 14) | (1 << 13))
    const words = dma2Stream0(chip, 0, 4, CDR, 3)
    const conversion = 15 / ADC_CYCLES_PER_SECOND
    const delay = 20 / ADC_CYCLES_PER_SECOND
    chip.w(ADC[0] + R.CR2, ADON | CONT | SWSTART)
    const at = (seconds: number) => {
      chip.mcu.run(seconds)
      return chip.mcu.adc.slice(0, 2).map((a) => a.converted.regular)
    }
    expect(at(conversion + delay / 4), "ADC1 done once, ADC2 still sampling").toEqual([1, 0])
    expect(at(delay), "ADC2's first lands DELAY after ADC1's").toEqual([2, 1])
    chip.mcu.run(4 * conversion)
    for (const word of words()) {
      expect(word & 0xffff).toBeNear(code(voltages.PA1), SPREAD)
      expect(word >>> 16).toBeNear(code(voltages.PA1), SPREAD)
    }
  })

  it("reserved MULTI codes and DMA mode 1 in dual mode are reported, not silently ignored", () => {
    const chip = chipWithInputs()
    chip.w(CCR, 0b00011)
    chip.w(CCR, 0b00110 | (1 << 14))
    chip.w(ADC[0] + R.CR2, ADON | SWSTART)
    step(chip)
    const report = [...chip.mcu.unmodelled.features.keys()].join("\n")
    expect(report).toMatch(/MULTI = 00011 is reserved/)
    expect(report).toMatch(/DMA mode 1 in dual mode/)
  })

  it("injected discontinuous mode (JDISCEN): one injected channel per trigger, JEOC after the last", () => {
    const chip = chipWithInputs()
    chip.w(ADC[0] + R.JSQR, (1 << 20) | (1 << 10) | (2 << 15))
    chip.w(ADC[0] + R.CR1, 1 << 12)
    chip.w(ADC[0] + R.CR2, ADON | JSWSTART)
    step(chip)
    expect(chip.mcu.adc[0].converted.injected).toBe(1)
    expect(chip.r(ADC[0] + R.SR) & JEOC).toBe(0)
    chip.w(ADC[0] + R.CR2, ADON | JSWSTART)
    step(chip)
    expect(chip.mcu.adc[0].converted.injected).toBe(2)
    expect(chip.r(ADC[0] + R.SR) & JEOC).toBeTruthy()
  })
})
