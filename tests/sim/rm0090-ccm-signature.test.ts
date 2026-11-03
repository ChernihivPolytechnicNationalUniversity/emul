import { describe, expect, it } from "vitest"
import { STM32F405RG, STM32F407VG, STM32F429ZI, type ChipProfile } from "@/mcu/chip"
import { Bus } from "@/mcu/bus"
import { Dma2d } from "@/mcu/periph/dma2d"
import { Stm32 } from "@/mcu/stm32f429"
import { buffer, example } from "../lib/firmware"

const RCC_AHB1ENR = 0x40023830
const DMA2EN = 1 << 22
const DMA2 = 0x40026400
const LISR = DMA2 + 0x00
const LIFCR = DMA2 + 0x08
const S0CR = DMA2 + 0x10
const S0NDTR = DMA2 + 0x14
const S0PAR = DMA2 + 0x18
const S0M0AR = DMA2 + 0x1c
const MEMORY_TO_MEMORY_WORDS = (2 << 6) | (1 << 9) | (1 << 10) | (2 << 11) | (2 << 13)
const EN = 1
const TCIF0 = 1 << 5
const TEIF0 = 1 << 3

const CCM = 0x10000000
const SRAM_SCRATCH = 0x20001000
const SRAM_TARGET = 0x20001100
const MOVS_R0_1 = 0x2001
const B_SELF = 0xe7fe

function idleImage(chip: ChipProfile): ArrayBuffer {
  const image = buffer(example("adc-idle.elf")).slice(0)
  const sram = chip.memory.find((m) => m.name === "SRAM")!
  new DataView(image).setUint32(0x1000, sram.base + sram.size, true)
  return image
}

function bare(chip: ChipProfile) {
  const mcu = new Stm32(chip)
  mcu.load(idleImage(chip), "adc-idle.elf")
  mcu.run(1e-5)
  expect(mcu.cpu.halted).toBeNull()
  const w = (addr: number, value: number) => mcu.bus.write(addr, value >>> 0, 4)
  const r = (addr: number) => mcu.bus.read(addr, 4) >>> 0
  return { mcu, w, r }
}

function dmaCopy(chip: ChipProfile, from: number, to: number) {
  const { mcu, w, r } = bare(chip)
  w(from, 0x12345678)
  w(to, 0xcafef00d)
  w(RCC_AHB1ENR, r(RCC_AHB1ENR) | DMA2EN)
  w(LIFCR, 0x3d)
  w(S0PAR, from)
  w(S0M0AR, to)
  w(S0NDTR, 1)
  w(S0CR, MEMORY_TO_MEMORY_WORDS | EN)
  mcu.run(1e-4)
  return { lisr: r(LISR), ndtr: r(S0NDTR), enabled: (r(S0CR) & EN) !== 0, destination: r(to) }
}

describe.each([STM32F405RG, STM32F407VG, STM32F429ZI])("$name: the CCM is on the CPU's data bus only (RM0090 §2.1, §2.3.1)", (chip) => {
  it("copies SRAM to SRAM by DMA (the control case)", () => {
    const got = dmaCopy(chip, SRAM_SCRATCH, SRAM_TARGET)
    expect.soft(got.lisr & TCIF0, "TCIF0").toBe(TCIF0)
    expect.soft(got.destination).toBe(0x12345678)
  })

  it.each([
    ["from the CCM", CCM, SRAM_TARGET],
    ["into the CCM", SRAM_SCRATCH, CCM + 0x100],
  ])("refuses a DMA transfer %s: transfer error, stream disabled, nothing moved", (_, from, to) => {
    const got = dmaCopy(chip, from, to)
    expect.soft(got.lisr & TEIF0, "TEIF0").toBe(TEIF0)
    expect.soft(got.lisr & TCIF0, "no TCIF0").toBe(0)
    expect.soft(got.enabled, "EN cleared").toBe(false)
    expect.soft(got.ndtr, "NDTR untouched").toBe(1)
    expect.soft(got.destination, "destination untouched").toBe(0xcafef00d)
  })

  it.each([
    ["compiled blocks", true],
    ["the interpreter", false],
  ])("halts on an instruction fetched from the CCM (%s), and runs the same code from SRAM", (_, jit) => {
    const { mcu } = bare(chip)
    mcu.cpu.jit = jit
    for (const at of [CCM, SRAM_SCRATCH]) {
      mcu.bus.write(at, MOVS_R0_1, 2)
      mcu.bus.write(at + 2, B_SELF, 2)
    }
    mcu.cpu.r[0] = 0
    mcu.cpu.sleeping = false
    mcu.cpu.pc = SRAM_SCRATCH
    mcu.run(1e-5)
    expect.soft(mcu.cpu.halted, "SRAM runs").toBeNull()
    expect.soft(mcu.cpu.r[0], "SRAM ran MOVS").toBe(1)
    mcu.cpu.r[0] = 0
    mcu.cpu.sleeping = false
    mcu.cpu.pc = CCM
    expect(mcu.run(1e-5)).toBe(false)
    expect.soft(mcu.cpu.r[0], "nothing ran from the CCM").toBe(0)
    expect.soft(mcu.cpu.halted?.message).toBe("fault at 0x10000000: instruction fetch: read16 at 0x10000000: CCM is on the CPU's data bus only")
  })

  it("lets the CPU read and write the CCM as data", () => {
    const { w, r } = bare(chip)
    w(CCM + 0x40, 0xa5a55a5a)
    expect(r(CCM + 0x40)).toBe(0xa5a55a5a)
  })
})

describe.each([
  [STM32F405RG, 1024],
  [STM32F407VG, 1024],
  [STM32F429ZI, 2048],
])("$name's electronic signature (RM0090 §39, DS8626 §6.3.21–22)", (chip, flashKb) => {
  it("answers the 96-bit unique ID at 0x1FFF7A10 and the flash size at 0x1FFF7A22", () => {
    const { mcu } = bare(chip)
    const uid = [0, 4, 8].map((o) => mcu.bus.read(0x1fff7a10 + o, 4) >>> 0)
    expect.soft(uid.some((word) => word !== 0), "UID").toBe(true)
    expect.soft(mcu.bus.read(0x1fff7a22, 2), "F_SIZE in KB").toBe(flashKb)
  })

  it("keeps the OTP blank (0x1FFF7800–0x1FFF7A0F reads 0xFF) and refuses a plain store to the signature", () => {
    const { mcu } = bare(chip)
    expect.soft(mcu.bus.read(0x1fff7800, 4) >>> 0).toBe(0xffffffff)
    expect.soft(mcu.bus.read(0x1fff7a0c, 4) >>> 0).toBe(0xffffffff)
    expect(() => mcu.bus.write(0x1fff7a22, 0, 2)).toThrow()
  })

  it("holds TS_CAL1/TS_CAL2 and VREFIN_CAL in its ROM at the datasheet's typical codes for 3.3 V (the ROM's words, not an ADC conversion)", () => {
    const { mcu } = bare(chip)
    const half = (at: number) => mcu.bus.read(at, 2)
    const volts = (code: number) => (code / 4095) * 3.3
    expect.soft(volts(half(0x1fff7a2a)), "VREFIN_CAL").toBeCloseTo(1.21, 2)
    expect.soft(volts(half(0x1fff7a2c)), "TS_CAL1 at 30 °C").toBeCloseTo(0.76 + 5 * 2.5e-3, 2)
    expect.soft(volts(half(0x1fff7a2e)), "TS_CAL2 at 110 °C").toBeCloseTo(0.76 + 85 * 2.5e-3, 2)
  })
})

describe("STM32F429ZI: the LTDC is not on the CPU's data bus either (RM0090 §2.3.1)", () => {
  const LTDC = 0x40016800
  const RCC_APB2ENR = 0x40023844
  const LTDCEN = 1 << 26
  const RED_RGB565 = 0xf800
  const PIXEL_CLOCK_WITHOUT_PLLSAI = 9e6
  function frameFrom(framebuffer: number) {
    const { mcu, w } = bare(STM32F429ZI)
    w(RCC_APB2ENR, LTDCEN)
    mcu.ltdc.pixelClock = () => PIXEL_CLOCK_WITHOUT_PLLSAI
    mcu.bus.write(framebuffer, RED_RGB565, 2)
    w(LTDC + 0x08, 0)
    w(LTDC + 0x0c, 0)
    w(LTDC + 0x10, (1 << 16) | 1)
    w(LTDC + 0x14, (2 << 16) | 2)
    w(LTDC + 0x88, 0x00010001)
    w(LTDC + 0x8c, 0x00010001)
    w(LTDC + 0x94, 2)
    w(LTDC + 0x98, 255)
    w(LTDC + 0xac, framebuffer)
    w(LTDC + 0xb0, 0x00020005)
    w(LTDC + 0xb4, 1)
    w(LTDC + 0x84, 1)
    w(LTDC + 0x24, 1)
    w(LTDC + 0x18, 1)
    const out = new Uint8ClampedArray(4)
    const composed = mcu.ltdc.compose(out, 1, 1)
    return { composed, rgba: [...out], features: [...mcu.unmodelled.features.keys()], mcu, w }
  }

  it("shows a framebuffer in SRAM (the control case)", () => {
    const frame = frameFrom(SRAM_SCRATCH)
    expect.soft(frame.composed, "composed").toBe(true)
    expect.soft(frame.rgba, "the red pixel").toEqual([255, 0, 0, 255])
    expect.soft(frame.features.filter((f) => f.startsWith("LTDC")), "nothing reported").toEqual([])
  })

  it("does not read a framebuffer in the CCM: the layer shows its default colour and the inspector says why", () => {
    const frame = frameFrom(CCM)
    expect.soft(frame.composed, "composed").toBe(true)
    expect.soft(frame.rgba, "not the red pixel").not.toEqual([255, 0, 0, 255])
    expect.soft(frame.features.some((f) => f.startsWith("LTDC layer 1 framebuffer at 0x10000000") && f.includes("CCM")), "reported as unmodelled").toBe(true)
  })

  it("reports a CCM framebuffer once per layer and composition, not once per line", () => {
    const { mcu, w } = frameFrom(CCM)
    w(LTDC + 0x10, (1 << 16) | 8)
    w(LTDC + 0x14, (2 << 16) | 9)
    w(LTDC + 0x8c, 0x00080001)
    w(LTDC + 0xb4, 8)
    w(LTDC + 0x24, 1)
    mcu.unmodelled.features.clear()
    mcu.ltdc.compose(new Uint8ClampedArray(4 * 8), 1, 8)
    const counts = [...mcu.unmodelled.features.entries()].filter(([f]) => f.startsWith("LTDC layer 1"))
    expect.soft(counts.map(([, n]) => n), "one report for eight lines").toEqual([1])
  })
})

describe("STM32F405RG: the 4 KB backup SRAM of the board's \"(192+4) KB\" (RM0090 §5.1.2, the STM32-H405 UM §1.1)", () => {
  const BKPSRAM = 0x40024000
  const RCC_APB1ENR = 0x40023840
  const PWREN = 1 << 28
  const PWR_CR = 0x40007000
  const DBP = 1 << 8
  const BKPSRAMEN = 1 << 18
  const WORD = 0x5a17c0de

  it("reads zero with BKPSRAMEN clear, ignores writes until DBP is set, then holds 4 KB, last word at 0x4002 4FFC", () => {
    const { w, r } = bare(STM32F405RG)
    expect.soft(r(BKPSRAM), "interface clock off").toBe(0)
    w(RCC_AHB1ENR, BKPSRAMEN)
    w(BKPSRAM, WORD)
    expect.soft(r(BKPSRAM), "written before DBP").toBe(0)
    w(RCC_APB1ENR, PWREN)
    w(PWR_CR, DBP)
    w(BKPSRAM, WORD)
    w(BKPSRAM + 0xffc, ~WORD >>> 0)
    expect.soft(r(BKPSRAM), "first word").toBe(WORD)
    expect.soft(r(BKPSRAM + 0xffc), "last word, 4 KB up").toBe(~WORD >>> 0)
  })
})

describe("STM32F429ZI: DMA2D is an AHB master, off the CCM too (RM0090 §2.3.1, §11.3.14: a bus error sets TEIF)", () => {
  const DMA2D = 0x4002b000
  const DMA2DEN = 1 << 23
  const R = { CR: 0x00, ISR: 0x04, FGMAR: 0x0c, FGPFCCR: 0x1c, FGCMAR: 0x2c, OPFCCR: 0x34, OCOLR: 0x38, OMAR: 0x3c, NLR: 0x44 }
  const TEIF = 1
  const TCIF = 2
  const CTCIF = 1 << 4
  const RED_RGB565 = 0xf800
  function dma2d() {
    const { mcu, w, r } = bare(STM32F429ZI)
    w(RCC_AHB1ENR, DMA2DEN)
    const reg = (name: keyof typeof R, value?: number) => (value === undefined ? r(DMA2D + R[name]) : w(DMA2D + R[name], value))
    return { mcu, reg }
  }
  const fill = (target: number) => {
    const { mcu, reg } = dma2d()
    mcu.bus.write(target, 0, 2)
    reg("OPFCCR", 2)
    reg("OCOLR", RED_RGB565)
    reg("OMAR", target)
    reg("NLR", 0x00010001)
    reg("CR", (3 << 16) | 1)
    return { isr: reg("ISR") as number, pixel: mcu.bus.read(target, 2) }
  }

  it("fills a pixel in SRAM (the control case): TCIF, the pixel written", () => {
    const got = fill(SRAM_SCRATCH)
    expect.soft(got.isr & (TEIF | TCIF), "flags").toBe(TCIF)
    expect.soft(got.pixel, "written").toBe(RED_RGB565)
  })

  it("refuses to fill one in the CCM: TEIF, no TCIF, the CCM untouched", () => {
    const got = fill(CCM)
    expect.soft(got.isr & (TEIF | TCIF), "flags").toBe(TEIF)
    expect.soft(got.pixel, "untouched").toBe(0)
  })

  it("refuses a copy out of the CCM into SRAM, and leaves SRAM untouched", () => {
    const { mcu, reg } = dma2d()
    mcu.bus.write(CCM, RED_RGB565, 2)
    mcu.bus.write(SRAM_TARGET, 0, 2)
    reg("FGPFCCR", 2)
    reg("OPFCCR", 2)
    reg("FGMAR", CCM)
    reg("OMAR", SRAM_TARGET)
    reg("NLR", 0x00010001)
    reg("CR", 1)
    expect.soft((reg("ISR") as number) & (TEIF | TCIF), "flags").toBe(TEIF)
    expect.soft(mcu.bus.read(SRAM_TARGET, 2), "untouched").toBe(0)
  })

  it("walks off the end of SRAM into reserved space as a bus error: TEIF, the rows before it written, nothing thrown at the core", () => {
    const { mcu, reg } = dma2d()
    const sram = STM32F429ZI.memory.find((m) => m.name === "SRAM")!
    const last = sram.base + sram.size - 4
    mcu.bus.write(last, 0, 4)
    reg("OPFCCR", 2)
    reg("OCOLR", RED_RGB565)
    reg("OMAR", last)
    reg("NLR", 0x00010003)
    reg("CR", (3 << 16) | 1)
    expect.soft((reg("ISR") as number) & (TEIF | TCIF), "flags").toBe(TEIF)
    expect.soft(mcu.bus.read(last, 2), "row 0").toBe(RED_RGB565)
    expect.soft(mcu.bus.read(last + 2, 2), "row 1").toBe(RED_RGB565)
    expect.soft(mcu.cpu.halted, "the core runs on").toBeNull()
  })

  it("refuses to load a CLUT from the CCM: TEIF, not CTCIF", () => {
    const { reg } = dma2d()
    reg("FGCMAR", CCM)
    reg("FGPFCCR", 5 | (1 << 5))
    expect.soft((reg("ISR") as number) & (TEIF | CTCIF), "flags").toBe(TEIF)
  })
})

describe("DMA2D against CPU-only memory between its rows: each row is checked, not the rectangle's corners (RAM put around the CCM to isolate the guard; on the F429 that space is reserved)", () => {
  const CCM_BASE = 0x10000000
  const OUT = 0x20000000
  const UNTOUCHED = 0x55555555
  function fixture() {
    const bus = new Bus([
      { name: "FLASH", base: 0x08000000, size: 0x1000, kind: "flash" },
      { name: "BEFORE", base: 0x0fff0000, size: 0x10000, kind: "ram" },
      { name: "CCM", base: CCM_BASE, size: 0x10000, kind: "ram", cpuDataOnly: true },
      { name: "AFTER", base: 0x10010000, size: 0x10000, kind: "ram" },
      { name: "SRAM", base: OUT, size: 0x20000, kind: "ram" },
    ])
    const d = new Dma2d()
    d.bus = bus
    for (let i = 0; i < 4; i++) bus.write32(OUT + 4 * i, UNTOUCHED)
    const reg = (offset: number, value: number) => d.write(offset, value, 4)
    return { bus, d, reg }
  }

  it("an ARGB8888 copy whose second row lands in the CCM (1 pixel × 3 lines, FGOR 16383, from 0x0FFFFFFC): row 0 copied, then TEIF", () => {
    const { bus, d, reg } = fixture()
    bus.write32(0x0ffffffc, 0xff0000ff)
    bus.write32(0x1000fffc, 0xffccccff)
    bus.write32(0x1001fffc, 0xff00ff00)
    reg(0x0c, 0x0ffffffc)
    reg(0x10, 16383)
    reg(0x1c, 0)
    reg(0x34, 0)
    reg(0x3c, OUT)
    reg(0x44, 0x00010003)
    reg(0x00, 1)
    expect.soft(d.read(0x04, 4) & 3, "TEIF, no TCIF").toBe(1)
    expect.soft(bus.read32(OUT) >>> 0, "row 0, from below the CCM").toBe(0xff0000ff)
    expect.soft(bus.read32(OUT + 4) >>> 0, "row 1 never read out of the CCM").toBe(UNTOUCHED)
    expect.soft(bus.read32(OUT + 8) >>> 0, "row 2 not reached").toBe(UNTOUCHED)
  })

  for (const [format, name] of [[8, "L4"], [10, "A4"]] as const) {
    it(`a ${name} copy whose half-byte rows step into the CCM one byte a line (1 pixel × 3 lines from 0x0FFFFFFE): rows 0 and 1 written, then TEIF`, () => {
      const { bus, d, reg } = fixture()
      reg(0x0c, 0x0ffffffe)
      reg(0x10, 0)
      reg(0x1c, format)
      reg(0x20, 0x123456)
      reg(0x34, 0)
      reg(0x3c, OUT)
      reg(0x44, 0x00010003)
      reg(0x00, 1)
      expect.soft(d.read(0x04, 4) & 3, "TEIF, no TCIF").toBe(1)
      expect.soft(bus.read32(OUT) >>> 0, "row 0 written").not.toBe(UNTOUCHED)
      expect.soft(bus.read32(OUT + 4) >>> 0, "row 1 written").not.toBe(UNTOUCHED)
      expect.soft(bus.read32(OUT + 8) >>> 0, "row 2, the CCM's, not").toBe(UNTOUCHED)
    })
  }
})
