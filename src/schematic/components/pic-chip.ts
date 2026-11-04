import { PIC_CHIPS, vddMin, type PicProfile } from "@/mcu/pic/chip"
import { ChipIcon } from "../icons"
import type { BodyShape, ComponentDef, Element, PinDef, PinKind, PropField } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Claim, Datasheet } from "../types"
import type { Characteristic } from "../characteristics"

/**
 * PIC16F62x parts as bare chips, drawn like the AVR ones: an IC body with every package pin, names
 * inside, package pin numbers over the stubs. The electrical model comes from the chip profile:
 * the supply load, one CMOS driver per I/O pin with the absolute maximum ratings (DS40044G §17.0);
 * RA4 and RA5/MCLR take up to 14 V (RA5 has no output driver, RA4 only the N-channel one).
 */

type Package = { name: string; pins: [number, string][]; source: string }

const WIDTH = 10
const TOP = 4
const STUB = 2

/** Alternate functions for the pin notes (DS40044G Table 3-2). */
export const PIC_ALT: Record<string, string> = {
  RA0: "AN0: comparator input",
  RA1: "AN1: comparator input",
  RA2: "AN2: comparator input / VREF: voltage reference output",
  RA3: "AN3: comparator input / CMP1: comparator 1 output",
  RA4: "T0CKI: Timer0 clock input / CMP2: comparator 2 output; open drain, Schmitt input, up to 14 V",
  RA5: "MCLR: reset input (active low) when MCLRE = 1 / VPP: programming voltage — 10–13.5 V with RB6/RB7 low enters Program/Verify; input only",
  RA6: "OSC2: crystal output / CLKOUT: FOSC/4 in RC and INTOSC modes with CLKOUT",
  RA7: "OSC1: crystal input / CLKIN: external clock in / RC (A parts) or ER (PIC16F627/628) bias pin",
  RB0: "INT: external interrupt",
  RB1: "RX: USART receive / DT: synchronous data",
  RB2: "TX: USART transmit / CK: synchronous clock",
  RB3: "CCP1: capture input / compare and PWM output",
  RB4: "PGM: low-voltage programming input when LVP = 1 (then no pull-up and no interrupt-on-change)",
  RB5: "interrupt-on-change",
  RB6: "T1OSO: Timer1 oscillator output / T1CKI: Timer1 clock input / PGC: programming clock",
  RB7: "T1OSI: Timer1 oscillator input / PGD: programming data",
  VDD: "Supply, 3.0–5.5 V (LF parts 2.0–5.5 V)",
  VSS: "Ground",
}
/** Short names shown inside the body next to the port name. */
const SHORT: Record<string, string> = { RA5: "MCLR", RA6: "OSC2", RA7: "OSC1", RB1: "RX", RB2: "TX", RB3: "CCP1" }

type Group = { names: string[]; kind?: PinKind }

export function picChip(chip: PicProfile, pkg: Package, description: string, id = chip.id.toLowerCase()): ComponentDef {
  const byName = new Map<string, number[]>()
  for (const [n, name] of pkg.pins) byName.set(name, [...(byName.get(name) ?? []), n])
  const port = (letter: string): Group => ({ names: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `R${letter}${i}`) })
  const left: Group[] = [{ names: ["VDD"], kind: "power" }, { names: ["VSS"], kind: "gnd" }, port("A")]
  const right: Group[] = [port("B")]

  const decorations: BodyShape[] = []
  const column = (groups: Group[], x: number, side: "left" | "right"): PinDef[] => {
    const pins: PinDef[] = []
    const out = side === "left" ? -1 : 1
    let y = TOP
    for (const [gi, g] of groups.entries()) {
      if (gi > 0) decorations.push({ type: "path", d: `M${x} ${y - 0.5} h${out * -1.5}`, muted: true })
      for (const name of g.names) {
        const nums = byName.get(name) ?? []
        const isPort = /^R[AB]\d$/.test(name)
        pins.push({
          id: name,
          label: SHORT[name] ? `${name}/${SHORT[name]}` : name,
          x,
          y,
          side,
          labelAt: side === "left" ? "right" : "left",
          kind: g.kind ?? (/^RA[0-3]$/.test(name) ? "analog" : "digital"),
          stub: STUB,
          mcu: isPort ? name : undefined,
          connector: pkg.name,
          connectorPin: nums[0],
          note: PIC_ALT[name] ?? (nums.length > 1 ? `pins ${nums.join(", ")}, joined on the die` : undefined),
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
    { type: "text", x: WIDTH / 2, y: 2.8, text: `PIC16 · ${pkg.name}`, size: 0.3, muted: true },
    { type: "path", d: `M0.6 ${TOP - 0.6} H${WIDTH - 0.6}`, muted: true },
    ...decorations,
  ]
  const pads = pins.filter((p) => p.mcu).map((p) => p.id)
  const e = chip.electrical
  const vddText = `${chip.lowVoltage ? e.vddMinLf : e.vddMin}–${e.vddMax} V`
  return {
    id,
    name: pkg.name === "PDIP-18" ? chip.name : `${chip.name} ${pkg.name}`,
    description,
    keywords: ["PIC", "PIC16", "Microchip", "16F628", "16F627", "16F648"],
    category: "mcus",
    icon: ChipIcon,
    prefix: "DD",
    width: WIDTH,
    height,
    body,
    pins,
    parts: [],
    model: [{ kind: "GND", node: "VSS" }, ...picMcuModel(chip, { vdd: "VDD", gnd: "VSS", pads })],
    hideIdle: true,
    chip: chip.id,
    mcuPower: "VDD",
    mcuReset: "RA5",
    fields: picFields(),
    info: {
      // MCU: `${chip.name}, PIC16 mid-range 8-bit, ${chip.flashWords} words Flash, ${ramBytes(chip)} B RAM, ${chip.eepromBytes} B EEPROM${chip.grade < 20e6 ? `, up to ${chip.grade / 1e6} MHz` : ""}`
      "Flash/RAM/EEPROM": `${chip.flashWords} words/${ramBytes(chip)} B/${chip.eepromBytes} B`,
      ...(chip.grade < 20e6 ? { "Clock grade": `up to ${chip.grade / 1e6} MHz` } : {}),
      Supply: vddText,
      Package: pkg.name,
      // "Absolute maximum": `VDD ${e.vddAbsMax} V; I/O pins −0.3 V to VDD + ${e.pinAboveVdd} V, ${e.pinCurrentMax * 1e3} mA each, ${e.portsCurrentMax * 1e3} mA all ports; MCLR and RA4 ${e.mclrMax} V`
      "Absolute maximum": `VDD ${e.vddAbsMax} V`,
      "MCLR/RA4 maximum": `${e.mclrMax} V`,
      "Pin voltage": `−0.3 V to VDD+${e.pinAboveVdd} V`,
      "Pin current": `${e.pinCurrentMax * 1e3} mA, ports ${e.portsCurrentMax * 1e3} mA`,
      // Configuration: "the configuration word at 2007h comes from the HEX image (__CONFIG / #pragma config); the field here overrides it"
      Configuration: "from HEX 2007h, field overrides",
      // Source (in the datasheet record): pkg.source
    },
  }
}

/** Data RAM: the GPR ranges, which already hold the 16 common bytes at 70h–7Fh (Table 4-1): 224 or 256 B (device table). */
function ramBytes(chip: PicProfile): number {
  return chip.gpr.reduce((n, [a, b]) => n + b - a + 1, 0)
}

/** The configuration word (hex); empty keeps what the image's 2007h holds (erased: 3FFFh). */
export function picFields(): PropField[] {
  return [{ key: "config", label: "Configuration word", type: "text", placeholder: "from the HEX image (2007h)" }]
}

/**
 * The electrical side of a PIC16F62x: the supply as a load the loop sets from the core's state,
 * and a CMOS driver per pad. The engine's driver has one resistance for both ways: the sink figure,
 * 0.6 V at 8.5 mA (D080; decision D47). PORTB's weak pull-up is the D070 typical, 200 µA at 5 V into
 * a grounded pin. Exceeding 25 mA a pin, VDD + 0.3 V, or 14 V on RA4/MCLR, burns the part.
 */
export function picMcuModel(chip: PicProfile, at: { vdd: string; gnd: string; pads: string[] }): Element[] {
  const e = chip.electrical
  const pin = { current: e.pinCurrentMax, aboveSupply: e.pinAboveVdd, fail: "short" } as const
  return [
    { kind: "R", a: at.vdd, b: at.gnd, value: e.vdd / byVdd5(e.iddIntosc), live: "$idd", supply: true, limits: { voltage: e.vddAbsMax, fail: "short" } },
    ...at.pads.map(
      (node): Element => ({
        kind: "GPIO",
        node,
        vddNode: at.vdd,
        drive: { ohms: e.sinkOhms },
        pull: node.startsWith("RB") ? e.vdd / e.pullUpCurrent.typ : undefined,
        limits: node === "RA4" || node === "RA5" ? { current: e.pinCurrentMax, voltage: e.mclrMax, fail: "short" } : pin,
      }),
    ),
  ]
}
const byVdd5 = (t: [number, number][]) => t.find(([v]) => v === 5.0)?.[1] ?? t[t.length - 1][1]

// PDIP-18 / SOIC-18 (DS40044G Pin Diagrams p.4; DS40300C Fig 1-1, the same pins).
const PDIP18: Package = {
  name: "PDIP-18",
  source: "Microchip DS40044G Pin Diagrams (18-pin PDIP, SOIC), Table 3-2",
  pins: [
    [1, "RA2"], [2, "RA3"], [3, "RA4"], [4, "RA5"], [5, "VSS"], [6, "RB0"], [7, "RB1"], [8, "RB2"], [9, "RB3"],
    [10, "RB4"], [11, "RB5"], [12, "RB6"], [13, "RB7"], [14, "VDD"], [15, "RA6"], [16, "RA7"], [17, "RA0"], [18, "RA1"],
  ],
}

export const picChips: ComponentDef[] = PIC_CHIPS.map((c) =>
  picChip(c, PDIP18, `${c.lowVoltage ? "Low-voltage" : "8-bit"} PIC16 MCU, ${c.flashWords / 1024}K Flash`),
)

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = picChips

// --- datasheet records -----------------------------------------------------------------------
// The numbers come from each part's own sheet: DS40044G for the A parts, DS40300C for the original
// PIC16F627/628 (PDF page indices). Program memory is 14-bit words, given here in bytes (words × 14 / 8).
// Temperature: the industrial grade (I, −40 to 85 °C).

type Page = { page: number; at: string }
type PicSheet = {
  doc?: string
  supply: Page
  absMax: Page
  memory: Page
  /** The V–F graph for a 20 MHz part, the ordering grade for a 4 MHz one. */
  clock20: Page
  clock4?: Page
  grades: Page
  comparator: Page
  intosc: Page
  drive: Page
}
const SHEET_A: PicSheet = {
  supply: { page: 137, at: "§17.1 D001" },
  absMax: { page: 135, at: "§17.0 Absolute Maximum Ratings" },
  memory: { page: 3, at: "Device table" },
  clock20: { page: 136, at: "Figures 17-1, 17-2" },
  grades: { page: 179, at: "Product Identification System" },
  comparator: { page: 142, at: "Table 17-2 D300, D303" },
  intosc: { page: 145, at: "Table 17-5 F13" },
  drive: { page: 140, at: "§17.4 D090" },
}
const SHEET_ORIGINAL: PicSheet = {
  doc: "mchp-ds40300c",
  supply: { page: 132, at: "§17.1 D001" },
  absMax: { page: 129, at: "§17.0 Absolute Maximum Ratings" },
  memory: { page: 3, at: "Device table" },
  clock20: { page: 130, at: "Figure 17-2" },
  clock4: { page: 169, at: "Product Identification System, Frequency Range" },
  grades: { page: 169, at: "Product Identification System" },
  comparator: { page: 135, at: "Table 17-1 D300, 300" },
  intosc: { page: 138, at: "Table 17-4 INTRC" },
  drive: { page: 134, at: "§17.2 D090" },
}

function picCharacteristics(chip: PicProfile, s: PicSheet): Characteristic[] {
  const e = chip.electrical
  const cite = (p: Page) => (s.doc ? { doc: s.doc, ...p } : p)
  return [
    { kind: "supply", value: { min: vddMin(chip), max: e.vddMax }, limit: { max: e.vddAbsMax }, cite: cite(s.supply), limitCite: cite(s.absMax) },
    chip.grade < 20e6
      ? { kind: "clock", value: { max: chip.grade }, cite: cite(s.clock4 ?? s.grades) }
      : { kind: "clock", value: { max: chip.grade }, at: [{ supply: 4.5 }], cite: cite(s.clock20) },
    { kind: "flash", value: { typ: (chip.flashWords * 14) / 8 }, cite: cite(s.memory) },
    { kind: "ram", value: { typ: ramBytes(chip) }, cite: cite(s.memory) },
    { kind: "eeprom", value: { typ: chip.eepromBytes }, cite: cite(s.memory) },
    { kind: "ioPins", value: { typ: 16 }, cite: cite(s.memory) },
    { kind: "pinCurrent", limit: { max: e.pinCurrentMax, sym: true }, per: "pin", cite: cite(s.absMax) },
    { kind: "temperature", value: { min: -40, max: 85 }, limit: { min: -40, max: 125 }, cite: cite(s.grades), limitCite: cite(s.absMax) },
  ]
}

const claim = (what: string, test: string): Claim => ({ what, test: `tests/firmware/${test}.test.ts` })
const PIC_MODELLED: Claim[] = [
  claim("PIC16 core, 35 instructions", "pic-flags"),
  { what: "Runs real HEX firmware", test: "tests/sim/pic-bench.test.ts" },
  claim("Timer0, Timer1, Timer2 and CCP", "pic-timers"),
  claim("USART asynchronous and synchronous", "pic-usart"),
  claim("Comparators and voltage reference", "pic-analog"),
  claim("Data EEPROM write timing", "pic-eeprom"),
  claim("ICSP Program/Verify mode", "pic-icsp"),
  claim("Clock limits by supply reported", "pic-clock"),
  claim("Resets, watchdog and Sleep", "pic-soc"),
]
const MODELLED_A: Claim[] = [...PIC_MODELLED, { what: "Supply current follows the core", test: "tests/sim/core-supply-load.test.ts" }]
const MODELLED_ORIGINAL: Claim[] = [...PIC_MODELLED, claim("Original silicon errata", "pic-original")]

function picNotModelled(s: PicSheet): Claim[] {
  const cite = (p: Page) => (s.doc ? { doc: s.doc, ...p } : p)
  return [
    { what: "Comparator offset and response time", cite: cite(s.comparator) },
    { what: "INTOSC frequency tolerance", cite: cite(s.intosc) },
    { what: "Source drive weaker than sink", cite: cite(s.drive) },
  ]
}

const RECORDS: Record<string, Datasheet> = Object.fromEntries(
  PIC_CHIPS.map((chip) => {
    const sheet = chip.revisionA ? SHEET_A : SHEET_ORIGINAL
    const docs: Datasheet["docs"] = chip.revisionA
      ? [DOCS["mchp-ds40044g"], DOCS["mchp-ds33023a"], DOCS["mchp-ds41196g"]]
      : [DOCS["mchp-ds40044g"], DOCS["mchp-ds40300c"], DOCS["mchp-ds33023a"], DOCS["mchp-ds30034d"], DOCS["mchp-ds80073f"]]
    const record: Datasheet = {
      maker: "Microchip",
      package: PDIP18.name,
      docs,
      specs: [],
      characteristics: picCharacteristics(chip, sheet),
      modelled: chip.revisionA ? MODELLED_A : MODELLED_ORIGINAL,
      notModelled: picNotModelled(sheet),
    }
    return [chip.id.toLowerCase(), record]
  }),
)
for (const def of defs) def.datasheet ??= RECORDS[def.id]
