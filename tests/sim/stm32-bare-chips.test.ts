/**
 * The STM32 profiles the boards carry, as bare chips in the palette: every signal pin of the
 * package at its datasheet number, and the board's own firmware running on the chip with
 * nothing but a crystal and an LED drawn around it.
 *
 * Pin numbers: DS8626 Rev 9 Table 7 (STM32F405/407, LQFP64 and LQFP100 columns), DS10314 Rev 8
 * Table 8 (STM32F411, UFQFPN48), DS9716 Rev 11 and DS10086 Rev 5 Table 8 (STM32F401xC/xE,
 * UFQFPN48). I/O counts: Table 2 of each (F407Vx 82, F405RG 51, F411Cx and F401Cx 36).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { FIRMWARE } from "../lib/firmware"

const LQFP100 = { VBAT: 6, PC13: 7, PH0: 12, PH1: 13, NRST: 14, VSSA: 20, VDDA: 22, PA0: 23, PA13: 72, PA14: 76, PD2: 83, BOOT0: 94, PE1: 98, PE2: 1 }
const LQFP64 = { VBAT: 1, PC13: 2, PH0: 5, PH1: 6, NRST: 7, VSSA: 12, VDDA: 13, PA0: 14, PA13: 46, PA14: 49, PD2: 54, BOOT0: 60, PB9: 62 }
const UFQFPN48 = { VBAT: 1, PC13: 2, PH0: 5, PH1: 6, NRST: 7, VSSA: 8, VDDA: 9, PA0: 10, PA13: 34, PA14: 37, BOOT0: 44, PB9: 46 }

const CHIPS = [
  { id: "stm32f407vg", name: "STM32F407VG", pkg: "LQFP100", io: 82, at: LQFP100, vdd: [11, 19, 28, 50, 75, 100], vss: [10, 27, 74, 99], ports: "ABCDEH" },
  { id: "stm32f405rg", name: "STM32F405RG", pkg: "LQFP64", io: 51, at: LQFP64, vdd: [19, 32, 48, 64], vss: [18, 63], ports: "ABCDH" },
  { id: "stm32f411ce", name: "STM32F411CE", pkg: "UFQFPN48", io: 36, at: UFQFPN48, vdd: [24, 36, 48], vss: [23, 35, 47], ports: "ABCH" },
  { id: "stm32f401cc", name: "STM32F401CC", pkg: "UFQFPN48", io: 36, at: UFQFPN48, vdd: [24, 36, 48], vss: [23, 35, 47], ports: "ABCH" },
  { id: "stm32f401ce", name: "STM32F401CE", pkg: "UFQFPN48", io: 36, at: UFQFPN48, vdd: [24, 36, 48], vss: [23, 35, 47], ports: "ABCH" },
]

describe.each(CHIPS)("bare $id ($pkg)", ({ id, name, pkg, io, at, vdd, vss, ports }) => {
  const def = getDef(id)!

  it("is in the palette's Microcontrollers with its own core", () => {
    expect(def).toBeDefined()
    expect(def.category).toBe("mcus")
    expect(def.chip).toBe(id)
    expect(def.name).toBe(name)
    expect(def.info?.Package).toBe(pkg)
  })

  it("brings out every I/O the package bonds, and only those", () => {
    const gpio = def.pins.filter((p) => p.mcu)
    expect(gpio).toHaveLength(io)
    expect(new Set(gpio.map((p) => p.id[1]))).toEqual(new Set(ports))
  })

  it("numbers its pins as the datasheet's pin table", () => {
    for (const [pin, n] of Object.entries(at)) expect.soft(def.pins.find((p) => p.id === pin)?.connectorPin, pin).toBe(n)
    expect(def.pins.find((p) => p.id === "VDD")!.note).toBe(`all ${vdd.length} VDD pads: pins ${vdd.join(", ")}`)
    expect(def.pins.find((p) => p.id === "VSS")!.note).toBe(`all ${vss.length} VSS pads: pins ${vss.join(", ")}`)
  })
})

/**
 * The board's starting project on the bare chip: VDD/VDDA on +3V3, the board's crystal with
 * 20 pF to ground on PH0/PH1, an LED from +3V3 through 1 kΩ into the board's LED pin, which the
 * firmware toggles. Sampled every 5 ms for 2 s.
 */
describe.each([
  { id: "stm32f407vg", elf: "discovery-running-light", xtal: "8 MHz", pin: "PD12", hclk: 168e6 },
  { id: "stm32f405rg", elf: "h405-blink", xtal: "8 MHz", pin: "PC12", hclk: 168e6 },
  { id: "stm32f411ce", elf: "blackpill-blink", xtal: "25 MHz", pin: "PC13", hclk: 100e6 },
  { id: "stm32f401cc", elf: "blackpill-f401cc-blink", xtal: "25 MHz", pin: "PC13", hclk: 84e6 },
  { id: "stm32f401ce", elf: "blackpill-f401ce-blink", xtal: "25 MHz", pin: "PC13", hclk: 84e6 },
])("bare $id running $elf", ({ id, elf, xtal, pin, hclk }) => {
  it(`runs at ${hclk / 1e6} MHz from the ${xtal} crystal and blinks an LED on ${pin}`, () => {
    const { doc, place, wire } = builder(GRID)
    const dd = place(id, 0, 0, { firmware: `${elf}.elf`, firmwareData: readFileSync(join(FIRMWARE, "prebuilt", `${elf}.U1.elf`)).toString("base64") })
    const v33 = place("supply", -10, 0, { value: "+3V3", voltage: "3.3 V" })
    const gnd = place("ground", -10, 10)
    wire(v33, "V", dd, "VDD")
    wire(v33, "V", dd, "VDDA")
    wire(dd, "VSS", gnd, "GND")
    wire(dd, "VSSA", gnd, "GND")
    const zq = place("crystal", 30, 0, { value: xtal })
    const c1 = place("capacitor", 34, -4, { value: "20 pF" })
    const c2 = place("capacitor", 34, 4, { value: "20 pF" })
    wire(dd, "PH0", zq, "1")
    wire(dd, "PH1", zq, "2")
    wire(zq, "1", c1, "1")
    wire(zq, "2", c2, "1")
    wire(c1, "2", gnd, "GND")
    wire(c2, "2", gnd, "GND")
    const r = place("resistor", 30, 20, { value: "1 kΩ" })
    const led = place("led", 36, 20, { value: "red" })
    wire(v33, "V", led, "1")
    wire(led, "2", r, "1")
    wire(r, "2", dd, pin)

    const loop = new SimLoop()
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    let onsets = 0
    let was = false
    for (let ms = 5; ms <= 2000; ms += 5) {
      loop.advance(ms)
      const on = !!loop.snapshot()!.parts[partKey(led.id, "LED")]?.on
      if (on && !was) onsets++
      was = on
    }
    const core = (loop as unknown as { mcus: Map<string, { mcu: { mcu: { clocks: { hclk: number }; cpu: { halted: unknown } } } }> }).mcus.get(dd.id)!.mcu.mcu
    expect(core.cpu.halted).toBeNull()
    expect(core.clocks.hclk).toBe(hclk)
    expect(onsets).toBeGreaterThanOrEqual(2)
  })
})
