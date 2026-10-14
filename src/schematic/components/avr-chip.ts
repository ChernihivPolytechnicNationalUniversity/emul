import { ATMEGA328P, type AvrProfile } from "@/mcu/avr/chip"
import { ChipIcon } from "../icons"
import type { BodyShape, ComponentDef, Element, PinDef, PinKind } from "../types"

/**
 * AVR parts as bare chips, drawn like the STM32 ones: an IC body with every package pin,
 * names inside, package pin numbers over the stubs. The electrical model is generated from
 * the chip profile: the supply load, RESET's pull-up, one CMOS driver per I/O pin with the
 * absolute maximum ratings (DS40002061B §29.1) — PC0–PC6 are powered from AVCC, the others
 * from VCC (§1.1.2, pin descriptions).
 */

type Package = { name: string; pins: [number, string][]; source: string }

const WIDTH = 10
const TOP = 4
const STUB = 2

/** Alternate functions for the pin notes (DS40002061B Tables 14-3, 14-6, 14-9). */
const ALT: Record<string, string> = {
  PB0: "ICP1 / CLKO / PCINT0",
  PB1: "OC1A / PCINT1",
  PB2: "SS / OC1B / PCINT2",
  PB3: "MOSI / OC2A / PCINT3",
  PB4: "MISO / PCINT4",
  PB5: "SCK / PCINT5",
  PB6: "XTAL1 / TOSC1 / PCINT6",
  PB7: "XTAL2 / TOSC2 / PCINT7",
  PC0: "ADC0 / PCINT8",
  PC1: "ADC1 / PCINT9",
  PC2: "ADC2 / PCINT10",
  PC3: "ADC3 / PCINT11",
  PC4: "ADC4 / SDA / PCINT12",
  PC5: "ADC5 / SCL / PCINT13",
  PC6: "RESET (active low, internal pull-up) unless RSTDISBL is programmed / PCINT14",
  PD0: "RXD / PCINT16",
  PD1: "TXD / PCINT17",
  PD2: "INT0 / PCINT18",
  PD3: "INT1 / OC2B / PCINT19",
  PD4: "XCK / T0 / PCINT20",
  PD5: "T1 / OC0B / PCINT21",
  PD6: "AIN0 / OC0A / PCINT22",
  PD7: "AIN1 / PCINT23",
  AVCC: "Supply of the ADC and of PC0–PC6: connect to VCC (through an LC filter if the ADC is used)",
  AREF: "ADC reference input",
}
/** Short names shown inside the body next to the port name. */
const SHORT: Record<string, string> = { PB6: "XTAL1", PB7: "XTAL2", PC6: "RESET", PD0: "RXD", PD1: "TXD" }

type Group = { names: string[]; kind?: PinKind }

export function avrChip(chip: AvrProfile, pkg: Package, description: string): ComponentDef {
  const byName = new Map<string, number[]>()
  for (const [n, name] of pkg.pins) byName.set(name, [...(byName.get(name) ?? []), n])
  const port = (letter: string): Group => ({
    names: pkg.pins
      .map(([, n]) => n)
      .filter((n) => new RegExp(`^P${letter}\\d$`).test(n))
      .sort(),
  })
  const left: Group[] = [{ names: ["VCC", "AVCC"], kind: "power" }, { names: ["AREF"] }, { names: ["GND"], kind: "gnd" }, port("C")]
  const right: Group[] = [port("B"), port("D")]

  const decorations: BodyShape[] = []
  const column = (groups: Group[], x: number, side: "left" | "right"): PinDef[] => {
    const pins: PinDef[] = []
    const out = side === "left" ? -1 : 1
    let y = TOP
    for (const [gi, g] of groups.entries()) {
      if (gi > 0) decorations.push({ type: "path", d: `M${x} ${y - 0.5} h${out * -1.5}`, muted: true })
      for (const name of g.names) {
        const nums = byName.get(name) ?? []
        const isPort = /^P[B-D]\d$/.test(name)
        pins.push({
          id: name,
          label: SHORT[name] ? `${name}/${SHORT[name]}` : name,
          x,
          y,
          side,
          labelAt: side === "left" ? "right" : "left",
          kind: g.kind ?? (name === "AREF" ? "analog" : "digital"),
          stub: STUB,
          mcu: isPort ? name : undefined,
          connector: pkg.name,
          connectorPin: nums[0],
          note: ALT[name] ?? (nums.length > 1 ? `pins ${nums.join(", ")}, joined on the die` : undefined),
        })
        decorations.push({ type: "text", x: x + out * 1.1, y: y - 0.32, text: String(nums[0]), size: 0.22, muted: true })
        y++
      }
      y++
    }
    return pins
  }
  const pins: PinDef[] = [...column(left, 0, "left"), ...column(right, WIDTH, "right")]
  const height = Math.max(...pins.map((p) => p.y)) + 1
  const body: BodyShape[] = [
    { type: "rect", x: 0, y: 0, w: WIDTH, h: height, rx: 0.2, fill: "board" },
    { type: "circle", cx: 0.8, cy: 0.8, r: 0.22, fill: "foreground" },
    { type: "text", x: WIDTH / 2, y: 1.2, text: "{ref}", size: 0.45 },
    { type: "text", x: WIDTH / 2, y: 2.05, text: chip.name, size: 0.5 },
    { type: "text", x: WIDTH / 2, y: 2.8, text: `AVR · ${pkg.name}`, size: 0.3, muted: true },
    { type: "path", d: `M0.6 ${TOP - 0.6} H${WIDTH - 0.6}`, muted: true },
    ...decorations,
  ]
  const pads = pins.filter((p) => p.mcu)
  const model: Element[] = [{ kind: "GND", node: "GND" }, ...avrMcuModel(chip, { vcc: "VCC", avcc: "AVCC", gnd: "GND", pads: pads.map((p) => ({ node: p.id, avcc: /^PC/.test(p.id), reset: p.id === "PC6" })) })]
  const e = chip.electrical
  const f = chip.factoryFuses
  const hex = (v: number) => `0x${v.toString(16).toUpperCase().padStart(2, "0")}`
  return {
    id: chip.id.toLowerCase(),
    name: chip.name,
    description,
    keywords: ["AVR", "ATmega", "Arduino", "328P"],
    category: "Chips",
    icon: ChipIcon,
    prefix: "DD",
    width: WIDTH,
    height,
    body,
    pins,
    parts: [],
    model,
    hideIdle: true,
    chip: chip.id,
    mcuPower: "VCC",
    mcuReset: "PC6",
    mcuVref: "AREF",
    fields: [
      { key: "fuseLow", label: "Low fuse", type: "text", placeholder: `${hex(f.low)} (factory)` },
      { key: "fuseHigh", label: "High fuse", type: "text", placeholder: `${hex(f.high)} (factory)` },
      { key: "fuseExtended", label: "Extended fuse", type: "text", placeholder: `${hex(f.extended)} (factory)` },
      {
        key: "revision",
        label: "Silicon revision",
        type: "select",
        options: [...chip.revisions].reverse().map((r) => {
          const errata = Object.entries(chip.errata).filter(([, revs]) => revs.includes(r)).map(([id]) => id)
          return { value: r, label: `Rev. ${r}${errata.length ? ` · errata ${errata.join(", ")}` : ""}` }
        }),
      },
    ],
    info: {
      MCU: `${chip.name}, AVR 8-bit, ${chip.flashBytes / 1024} KB Flash, ${(chip.ramEnd - 0xff) / 1024} KB SRAM, ${chip.eepromBytes} B EEPROM`,
      Package: pkg.name,
      "Absolute maximum": `VCC ${e.vddMax} V; I/O pins −0.5 V to VCC + ${e.pinAboveVcc} V, ${e.pinCurrentMax * 1e3} mA each, ${e.supplyCurrentMax * 1e3} mA through VCC/GND; RESET ${e.resetVoltageMax} V`,
      Fuses: `as shipped: low ${hex(f.low)} (internal 8 MHz RC ÷ 8), high ${hex(f.high)}, extended ${hex(f.extended)}; an .elf with a .fuse section sets them, so do the fields here`,
      Errata: `Silicon Errata DS80000855C, by revision: ${Object.entries(chip.errata).map(([id, revs]) => `${id} (Rev. ${revs.join("/")})`).join(", ")}`,
      Source: pkg.source,
    },
  }
}

/**
 * The electrical side of an AVR: the supply as a load the loop sets from the core's state,
 * and a CMOS driver per pad. A pad's pull-up is RPU (RESET's is RRST); exceeding a pin's 40 mA
 * or VCC + 0.5 V, or VCC 6 V, burns the part.
 */
export function avrMcuModel(chip: AvrProfile, at: { vcc: string; avcc: string; gnd: string; pads: { node: string; avcc: boolean; reset: boolean }[] }): Element[] {
  const e = chip.electrical
  const pin = { current: e.pinCurrentMax, aboveSupply: e.pinAboveVcc, fail: "short" } as const
  return [
    { kind: "R", a: at.vcc, b: at.gnd, value: e.vdd / (e.idd.activePerMHz * 1), live: "$idd", supply: true, limits: { voltage: e.vddMax, fail: "short" } },
    ...at.pads.map(
      (p): Element => ({
        kind: "GPIO",
        node: p.node,
        vddNode: p.avcc ? at.avcc : at.vcc,
        drive: { ohms: e.outputOhms },
        capacitance: e.pinCapacitance,
        pull: p.reset ? e.resetPullUp : e.pullUp,
        limits: p.reset ? { ...pin, aboveSupply: undefined, voltage: e.resetVoltageMax } : pin,
      }),
    ),
  ]
}

// PDIP-28 (DS40002061B Figure 1-1, 28 PDIP).
const PDIP28: Package = {
  name: "PDIP-28",
  source: "Microchip DS40002061B Figure 1-1 (28 PDIP), §1.1",
  pins: [
    [1, "PC6"], [2, "PD0"], [3, "PD1"], [4, "PD2"], [5, "PD3"], [6, "PD4"], [7, "VCC"],
    [8, "GND"], [9, "PB6"], [10, "PB7"], [11, "PD5"], [12, "PD6"], [13, "PD7"], [14, "PB0"],
    [15, "PB1"], [16, "PB2"], [17, "PB3"], [18, "PB4"], [19, "PB5"], [20, "AVCC"], [21, "AREF"],
    [22, "GND"], [23, "PC0"], [24, "PC1"], [25, "PC2"], [26, "PC3"], [27, "PC4"], [28, "PC5"],
  ],
}

export const atmega328p = avrChip(ATMEGA328P, PDIP28, "8-bit AVR MCU, PDIP-28 — the Arduino Uno/Nano chip")
