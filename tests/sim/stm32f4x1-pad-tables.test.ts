/**
 * STM32F411CE and F401CC/CE alternate-function pads against their datasheets' Table 9 (DS10314 Rev 8; DS10086 Rev 5,
 * the same as DS9716 Rev 11), for the 36 port pins the UFQFPN48 bonds out (Table 8: PA0–15, PB0–10, PB12–15,
 * PC13–15, PH0/1); every row was checked cell by cell against the rendered pages. I2S1/I2S4/I2S5, the I2Sx_ext SD
 * pads and I2S_CKIN are known gaps.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STM32F401CC, STM32F401CE, STM32F411CE, type ChipProfile } from "@/mcu/chip"
import { padName } from "@/mcu/pads"
import { i2cPads } from "@/mcu/periph/i2c"
import { i2sPads, spiPads } from "@/mcu/periph/spi"
import { timAuxPads, timPads } from "@/mcu/periph/tim"
import { usartPads } from "@/mcu/periph/usart"
import { Stm32 } from "@/mcu/stm32f429"

type AfRow = { pin: string; ufqfpn48: number; af: Record<string, string> }

const at = (pad: string, af: number) => `${pad}@${af}`
const sorted = (items: Iterable<string>) => [...new Set(items)].sort()

function padsOf(chip: ChipProfile, table: string) {
  const TABLE_9: AfRow[] = JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", table), "utf8"))
  const MAP = chip.af


  const BONDED = new Set(TABLE_9.map((r) => r.pin))

  const datasheet = new Map<string, string[]>()
  for (const row of TABLE_9)
    for (const [column, cell] of Object.entries(row.af)) {
      if (cell === "-" || cell === "") continue
      for (const signal of cell.split("/")) datasheet.set(signal, [...(datasheet.get(signal) ?? []), at(row.pin, Number(column.slice(2)))])
    }

  const mcu = new Stm32(chip)
  const USARTS = mcu.usart.map((u) => u.name)
  const SPIS = mcu.spi.map((x) => x.name)
  const I2CS = mcu.i2c.map((x) => x.name)
  const TIMS = mcu.tim.map((t) => t.spec.name)

  const emulated = new Map<string, string[]>()
  const add = (signal: string, pad: { port: number; pin: number }, af: number) => {
    if (BONDED.has(padName(pad))) emulated.set(signal, [...(emulated.get(signal) ?? []), at(padName(pad), af)])
  }
  for (const name of USARTS) for (const p of usartPads(name, MAP)) add(`${name}_${p.dir.toUpperCase()}`, p, p.af)
  for (const name of SPIS) for (const p of spiPads(name, MAP)) add(`${name}_${p.line}`, p, p.af)
  for (const name of I2CS) for (const p of i2cPads(name, MAP)) add(`${name}_${p.line}`, p, p.af)
  for (const name of SPIS) for (const p of i2sPads(name, MAP)) add(`${name.replace("SPI", "I2S")}_${p.line}`, p, p.af)
  for (const name of TIMS) for (const p of timPads(name)) add(`${name}_CH${p.channel + 1}${p.complementary ? "N" : ""}`, p, p.af)
  for (const name of TIMS) for (const p of timAuxPads(name, MAP)) add(`${name}_${p.line}`, p, p.af)

  const any = (names: string[]) => names.join("|")
  const FAMILIES = [
    { family: "USART", modelled: new RegExp(`^(${any(USARTS)})_(TX|RX)$`), instance: new RegExp(`^(${any(USARTS)})_`), unmodelled: /_(CK|CTS|RTS)$/ },
    { family: "SPI", modelled: new RegExp(`^(${any(SPIS)})_(NSS|SCK|MISO|MOSI)$`), instance: new RegExp(`^(${any(SPIS)})_`), unmodelled: /^$/ },
    // I²S is modelled on SPI2/SPI3 only (spi.ts i2sCapable); I2S1/4/5, the full-duplex ext SD pads and I2S_CKIN are not.
    { family: "I²S", modelled: /^I2S[23]_(CK|WS|SD|MCK)$/, instance: /^I2S(\d|_)/, unmodelled: /^I2S[145]_|ext_SD$|_CKIN$/ },
    { family: "I²C", modelled: new RegExp(`^(${any(I2CS)})_(SCL|SDA)$`), instance: new RegExp(`^(${any(I2CS)})_`), unmodelled: /_SMBA$/ },
    { family: "TIM", modelled: new RegExp(`^(${any(TIMS)})_(CH[1-4]N?|ETR|BKIN)$`), instance: new RegExp(`^(${any(TIMS)})_`), unmodelled: /^$/ },
  ]
  const signalsOf = (pattern: RegExp) => sorted([...datasheet.keys(), ...emulated.keys()].filter((s) => pattern.test(s)))
  return { TABLE_9, BONDED, FAMILIES, datasheet, emulated, signalsOf }
}

const CHIPS_AND_TABLES = [
  { chip: STM32F411CE, table: "ds10314/ds10314-rev8-af-ufqfpn48.json" },
  { chip: STM32F401CC, table: "ds10086/ds10086-rev5-af-ufqfpn48.json" },
  { chip: STM32F401CE, table: "ds10086/ds10086-rev5-af-ufqfpn48.json" },
]

describe.each(CHIPS_AND_TABLES)("$chip.name (UFQFPN48) alternate-function pads against its Table 9", ({ chip, table }) => {
  const { BONDED, FAMILIES, datasheet, emulated, signalsOf } = padsOf(chip, table)
  it("covers the 36 bonded port pins and no PB11 (pin 22 is VCAP_1, Table 8)", () => {
    expect(BONDED.size).toBe(36)
    expect(BONDED.has("PB11")).toBe(false)
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
})
