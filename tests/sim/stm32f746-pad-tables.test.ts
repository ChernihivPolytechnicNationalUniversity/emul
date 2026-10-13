import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STM32F429ZI, STM32F746IG } from "@/mcu/chip"
import { padName } from "@/mcu/pads"
import { adcPad, DAC_PADS } from "@/mcu/periph/adc"
import { I2C_SPECS, i2cPads } from "@/mcu/periph/i2c"
import { WKUP_V2 } from "@/mcu/periph/misc"
import { SPI_SPECS, spiPads } from "@/mcu/periph/spi"
import { TIM_SPECS, timAuxPads, timPads } from "@/mcu/periph/tim"
import { USART_SPECS, usartPads } from "@/mcu/periph/usart"
import { LTDC_PADS } from "@/sim/display"

type AfRow = { pin: string; af: Record<string, string> }
type PinRow = { port_pin: string | null; additional_functions: string[] }

const DATA = join(import.meta.dirname, "..", "data", "ds10916")
const TABLE_12: AfRow[] = JSON.parse(readFileSync(join(DATA, "ds10916-rev5-af.json"), "utf8"))
const TABLE_10: PinRow[] = JSON.parse(readFileSync(join(DATA, "ds10916-rev5-pins.json"), "utf8"))
const LQFP176_GPIOS = new Set(TABLE_10.map((p) => p.port_pin).filter((p): p is string => p !== null))

const MAP = STM32F746IG.af
const at = (pad: string, af: number) => `${pad}@${af}`
const sorted = (items: Iterable<string>) => [...new Set(items)].sort()

const datasheet = new Map<string, string[]>()
for (const row of TABLE_12)
  for (const [column, cell] of Object.entries(row.af)) {
    if (cell === "-" || cell === "") continue
    for (const signal of cell.split("/")) {
      const name = signal.replace(/_(Tx|Rx)$/, (suffix) => suffix.toUpperCase())
      datasheet.set(name, [...(datasheet.get(name) ?? []), at(row.pin, Number(column.slice(2)))])
    }
  }

const emulated = new Map<string, string[]>()
const add = (signal: string, pad: { port: number; pin: number }, af: number) => emulated.set(signal, [...(emulated.get(signal) ?? []), at(padName(pad), af)])
for (const { name } of USART_SPECS) for (const p of usartPads(name)) add(`${name}_${p.dir.toUpperCase()}`, p, p.af)
for (const { name } of SPI_SPECS) for (const p of spiPads(name, MAP)) add(`${name}_${p.line}`, p, p.af)
for (const { name } of I2C_SPECS) for (const p of i2cPads(name, MAP)) add(`${name}_${p.line}`, p, p.af)
for (const { name } of TIM_SPECS) for (const p of timPads(name)) add(`${name}_CH${p.channel + 1}${p.complementary ? "N" : ""}`, p, p.af)
for (const { name } of TIM_SPECS) for (const p of timAuxPads(name, MAP)) add(`${name}_${p.line}`, p, p.af)
const LCD_NAMES: Record<string, string> = { HS: "HSYNC", VS: "VSYNC" }
for (const [signal, pads] of Object.entries(LTDC_PADS[MAP]))
  for (const entry of pads) {
    const [pad, af] = entry.split("/")
    emulated.set(`LCD_${LCD_NAMES[signal] ?? signal}`, [...(emulated.get(`LCD_${LCD_NAMES[signal] ?? signal}`) ?? []), at(pad, Number(af))])
  }

const instances = (specs: { name: string }[]) => specs.map((s) => s.name).join("|")
const FAMILIES = [
  { family: "USART/UART", modelled: new RegExp(`^(${instances(USART_SPECS)})_(TX|RX)$`), instance: new RegExp(`^(${instances(USART_SPECS)})_`), unmodelled: /_(CK|CTS|RTS)$/ },
  { family: "SPI", modelled: new RegExp(`^(${instances(SPI_SPECS)})_(NSS|SCK|MISO|MOSI)$`), instance: new RegExp(`^(${instances(SPI_SPECS)})_`), unmodelled: /^$/ },
  { family: "I²C", modelled: new RegExp(`^(${instances(I2C_SPECS)})_(SCL|SDA)$`), instance: new RegExp(`^(${instances(I2C_SPECS)})_`), unmodelled: /_SMBA$/ },
  { family: "TIM", modelled: new RegExp(`^(${instances(TIM_SPECS)})_(CH[1-4]N?|ETR|BKIN2?)$`), instance: new RegExp(`^(${instances(TIM_SPECS)})_`), unmodelled: /^$/ },
  { family: "LTDC", modelled: /^LCD_([RGB][0-7]|CLK|HSYNC|VSYNC|DE)$/, instance: /^LCD_/, unmodelled: /^$/ },
]

const signalsOf = (pattern: RegExp) => sorted([...datasheet.keys(), ...emulated.keys()].filter((s) => pattern.test(s)))

describe("STM32F746IG alternate-function pads against DS10916 Rev 5 Table 12", () => {
  for (const { family, modelled } of FAMILIES) {
    describe(family, () => {
      const signals = signalsOf(modelled)
      it("has signals on both sides", () => {
        expect(signals.length).toBeGreaterThan(0)
      })
      it.each(signals)("%s: the same pads and AF numbers, none missing, none extra", (signal) => {
        expect(sorted(emulated.get(signal) ?? []), `${signal}: emulator (left) against Table 12`).toEqual(sorted(datasheet.get(signal) ?? []))
      })
    })
  }

  it.each(FAMILIES)("$family: every other Table 12 signal of a modelled instance is a known gap", ({ instance, modelled, unmodelled }) => {
    const gaps = [...datasheet.keys()].filter((s) => instance.test(s) && !modelled.test(s))
    expect(gaps.filter((s) => !unmodelled.test(s)), "signals neither modelled nor listed as not modelled").toEqual([])
  })

  it("puts every USART, SPI, I²C and timer pad on an LQFP176 ball", () => {
    for (const [signal, pads] of emulated) {
      if (signal.startsWith("LCD_")) continue
      for (const entry of pads) expect(LQFP176_GPIOS.has(entry.split("@")[0]), `${entry} for ${signal}`).toBe(true)
    }
  })

  it("leaves the LTDC lines on PI12–PI15, PJ and PK unbonded on the LQFP176", () => {
    const unbonded = sorted([...emulated].filter(([signal]) => signal.startsWith("LCD_")).flatMap(([, pads]) => pads.map((p) => p.split("@")[0])).filter((pad) => !LQFP176_GPIOS.has(pad)))
    expect(unbonded.every((pad) => /^P(I1[2-5]|J\d+|K\d+)$/.test(pad)), unbonded.join(" ")).toBe(true)
  })
})

describe("STM32F746IG additional functions against DS10916 Rev 5 Table 10", () => {
  const additional = new Map<string, string>()
  for (const row of TABLE_10) if (row.port_pin) for (const f of row.additional_functions) additional.set(f, row.port_pin)

  it("ADC1–3 channels 0–15 sit on the pads ADCx_INn names", () => {
    const expected = new Map<string, string>()
    for (const [f, pad] of additional) {
      const m = /^ADC(\d+)_IN(\d+)$/.exec(f)
      if (m) for (const adc of m[1]) expected.set(`ADC${adc}_IN${m[2]}`, pad)
    }
    const actual = new Map<string, string>()
    for (const adc of [1, 2, 3])
      for (let channel = 0; channel < 16; channel++) {
        const pad = adcPad(adc, channel)
        if (pad) actual.set(`ADC${adc}_IN${channel}`, padName(pad))
      }
    expect(Object.fromEntries([...actual].sort())).toEqual(Object.fromEntries([...expected].sort()))
  })

  it("DAC_OUT1/2 on PA4/PA5", () => {
    expect(DAC_PADS).toEqual([additional.get("DAC_OUT1"), additional.get("DAC_OUT2")])
  })

  it("WKUP1–6 in RM0385's order", () => {
    expect(WKUP_V2.map((key) => padName({ port: key >> 4, pin: key & 15 }))).toEqual([1, 2, 3, 4, 5, 6].map((n) => additional.get(`WKUP${n}`)))
  })
})

describe("the STM32F429ZI keeps its own tables", () => {
  it("differs from the F746 only where DS10916 does", () => {
    const f4 = STM32F429ZI.af
    const pads = (list: { port: number; pin: number; af: number }[]) => sorted(list.map((p) => at(padName(p), p.af)))
    const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x))
    const spiOnlyF4 = SPI_SPECS.flatMap(({ name }) => diff(pads(spiPads(name, f4)), pads(spiPads(name, MAP))).map((p) => `${name} ${p}`))
    const spiOnlyF7 = SPI_SPECS.flatMap(({ name }) => diff(pads(spiPads(name, MAP)), pads(spiPads(name, f4))).map((p) => `${name} ${p}`))
    const i2cOnlyF4 = I2C_SPECS.flatMap(({ name }) => diff(pads(i2cPads(name, f4)), pads(i2cPads(name, MAP))).map((p) => `${name} ${p}`))
    expect(spiOnlyF4).toEqual(["SPI1 PD7@5", "SPI1 PG10@5", "SPI1 PG11@5", "SPI1 PG9@5"])
    expect(spiOnlyF7).toEqual(["SPI3 PB2@7"])
    expect(i2cOnlyF4).toEqual(["I2C2 PB3@9", "I2C3 PB4@9"])
    expect(LTDC_PADS[f4].B3).not.toContain("PD10/14")
    expect(LTDC_PADS[f4].B4).not.toContain("PE12/14")
  })
})
