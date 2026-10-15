import { PIC_CHIPS, type PicProfile } from "@/mcu/pic/chip"
import { ChipIcon } from "../icons"
import type { BodyShape, ComponentDef, Element, PinDef, PinKind, PropField } from "../types"

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
    category: "Chips",
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
      MCU: `${chip.name}, PIC16 mid-range 8-bit, ${chip.flashWords} words Flash, ${chip.gpr.reduce((n, [a, b]) => n + b - a + 1, 0) + 16} B RAM, ${chip.eepromBytes} B EEPROM${chip.grade < 20e6 ? `, up to ${chip.grade / 1e6} MHz` : ""}`,
      Supply: vddText,
      Package: pkg.name,
      "Absolute maximum": `VDD ${e.vddAbsMax} V; I/O pins −0.3 V to VDD + ${e.pinAboveVdd} V, ${e.pinCurrentMax * 1e3} mA each, ${e.portsCurrentMax * 1e3} mA all ports; MCLR and RA4 ${e.mclrMax} V`,
      Configuration: "the configuration word at 2007h comes from the HEX image (__CONFIG / #pragma config); the field here overrides it",
      Source: pkg.source,
    },
  }
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

const DESCRIPTION: Record<string, string> = {
  PIC16F627A: "8-bit PIC16 MCU, 1K words Flash, PDIP-18",
  PIC16F628A: "8-bit PIC16 MCU, 2K words Flash, PDIP-18 — the classic hobby PIC",
  PIC16F648A: "8-bit PIC16 MCU, 4K words Flash, PDIP-18",
}
export const picChips: ComponentDef[] = PIC_CHIPS.map((c) =>
  picChip(c, PDIP18, DESCRIPTION[c.id] ?? `8-bit PIC16 MCU, ${c.flashWords / 1024}K words Flash, PDIP-18${c.revisionA ? "" : " — the original (non-A) silicon, DS40300C"}${c.grade < 20e6 ? `, ${c.grade / 1e6} MHz grade` : ""}${c.lowVoltage ? ", 2.0 V LF part" : ""}`),
)
