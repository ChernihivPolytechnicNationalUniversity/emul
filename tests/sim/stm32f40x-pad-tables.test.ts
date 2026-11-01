/**
 * STM32F405/F407 alternate-function pads against DS8626 Rev 12 Table 9 (all 140 port pins, PA–PI; I²S
 * signals included, I2Sx_ext_SD and I2S_CKIN listed as known gaps),
 * and which of them each package bonds out (Table 2, Table 7: LQFP100 PA–PE + PH0/1, LQFP64 PA–PC +
 * PD2 + PH0/1).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STM32F405RG, STM32F407VG } from "@/mcu/chip"
import { padName } from "@/mcu/pads"
import { I2C_SPECS, i2cPads } from "@/mcu/periph/i2c"
import { i2sPads, SPI_SPECS, spiPads } from "@/mcu/periph/spi"
import { TIM_SPECS, timAuxPads, timPads } from "@/mcu/periph/tim"
import { USART_SPECS, usartPads } from "@/mcu/periph/usart"
import { Stm32 } from "@/mcu/stm32f429"

type AfRow = { pin: string; af: Record<string, string> }
const TABLE_9: AfRow[] = JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", "ds8626", "ds8626-rev12-af.json"), "utf8"))

const MAP = STM32F407VG.af
const at = (pad: string, af: number) => `${pad}@${af}`
const sorted = (items: Iterable<string>) => [...new Set(items)].sort()

const datasheet = new Map<string, string[]>()
for (const row of TABLE_9)
  for (const [column, cell] of Object.entries(row.af)) {
    if (cell === "-" || cell === "") continue
    for (const signal of cell.split("/")) datasheet.set(signal, [...(datasheet.get(signal) ?? []), at(row.pin, Number(column.slice(2)))])
  }

const mcu = new Stm32(STM32F407VG)
const present = (specs: { name: string }[], have: { name: string }[]) => specs.filter((s) => have.some((h) => h.name === s.name))
const USARTS = present(USART_SPECS, mcu.usart)
const SPIS = present(SPI_SPECS, mcu.spi)
const I2CS = present(I2C_SPECS, mcu.i2c)

const emulated = new Map<string, string[]>()
const add = (signal: string, pad: { port: number; pin: number }, af: number) => emulated.set(signal, [...(emulated.get(signal) ?? []), at(padName(pad), af)])
for (const { name } of USARTS) for (const p of usartPads(name)) add(`${name}_${p.dir.toUpperCase()}`, p, p.af)
for (const { name } of SPIS) for (const p of spiPads(name, MAP)) add(`${name}_${p.line}`, p, p.af)
for (const { name } of I2CS) for (const p of i2cPads(name, MAP)) add(`${name}_${p.line}`, p, p.af)
for (const { name } of SPIS) for (const p of i2sPads(name, MAP)) add(`${name.replace("SPI", "I2S")}_${p.line}`, p, p.af)
for (const { name } of TIM_SPECS) for (const p of timPads(name)) add(`${name}_CH${p.channel + 1}${p.complementary ? "N" : ""}`, p, p.af)
for (const { name } of TIM_SPECS) for (const p of timAuxPads(name, MAP)) add(`${name}_${p.line}`, p, p.af)

const instances = (specs: { name: string }[]) => specs.map((s) => s.name).join("|")
const FAMILIES = [
  { family: "USART/UART", modelled: new RegExp(`^(${instances(USARTS)})_(TX|RX)$`), instance: new RegExp(`^(${instances(USARTS)})_`), unmodelled: /_(CK|CTS|RTS)$/ },
  { family: "SPI", modelled: new RegExp(`^(${instances(SPIS)})_(NSS|SCK|MISO|MOSI)$`), instance: new RegExp(`^(${instances(SPIS)})_`), unmodelled: /^$/ },
  // I2S2/I2S3 on SPI2/SPI3 (RM0090 §28.2.2); the full-duplex I2Sx_ext SD pads and the external I2S_CKIN clock are not modelled.
  { family: "I²S", modelled: /^I2S[23]_(CK|WS|SD|MCK)$/, instance: /^I2S(\d|_)/, unmodelled: /(ext_SD|^I2S_CKIN)$/ },
  { family: "I²C", modelled: new RegExp(`^(${instances(I2CS)})_(SCL|SDA)$`), instance: new RegExp(`^(${instances(I2CS)})_`), unmodelled: /_SMBA$/ },
  { family: "TIM", modelled: new RegExp(`^(${instances(TIM_SPECS)})_(CH[1-4]N?|ETR|BKIN)$`), instance: new RegExp(`^(${instances(TIM_SPECS)})_`), unmodelled: /^$/ },
]
const signalsOf = (pattern: RegExp) => sorted([...datasheet.keys(), ...emulated.keys()].filter((s) => pattern.test(s)))

describe("STM32F405/F407 alternate-function pads against DS8626 Rev 12 Table 9", () => {
  it("uses its own map for both parts", () => {
    expect(STM32F405RG.af).toBe(MAP)
  })

  for (const { family, modelled } of FAMILIES) {
    describe(family, () => {
      const signals = signalsOf(modelled)
      it("has signals on both sides", () => {
        expect(signals.length).toBeGreaterThan(0)
      })
      it.each(signals)("%s: the same pads and AF numbers, none missing, none extra", (signal) => {
        expect(sorted(emulated.get(signal) ?? []), `${signal}: emulator (left) against Table 9`).toEqual(sorted(datasheet.get(signal) ?? []))
      })
    })
  }

  it.each(FAMILIES)("$family: every other Table 9 signal of a modelled instance is a known gap", ({ instance, modelled, unmodelled }) => {
    const gaps = [...datasheet.keys()].filter((s) => instance.test(s) && !modelled.test(s))
    expect(gaps.filter((s) => !unmodelled.test(s)), "signals neither modelled nor listed as not modelled").toEqual([])
  })

  it("has no pad on GPIOJ or GPIOK (the F40x stops at GPIOI)", () => {
    for (const [signal, pads] of emulated) for (const entry of pads) expect(entry, signal).toMatch(/^P[A-I]\d+@/)
  })
})
