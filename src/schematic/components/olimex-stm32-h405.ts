import { STM32F405RG } from "@/mcu/chip"
import { BoardIcon } from "../icons"
import { mcuModel } from "../mcu-model"
import type { ComponentDef, Element, ModelElement, PartDef, PinDef, PinKind } from "../types"
import { LED_COLORS } from "./basic"
import { AT, BOARD_MM, BOOT_BRIDGES, BRIDGE_PITCH, boardArt, extPad, FRAME, jtagPad, PLATE, USBP_E } from "./olimex-stm32-h405-art"

const at = (mm: { x: number; y: number }) => ({ x: Math.round((mm.x + FRAME.originX) * FRAME.cellsPerMm * 100) / 100, y: Math.round((mm.y + FRAME.originY) * FRAME.cellsPerMm * 100) / 100 })

type Row = [number, string, string?, string?]

const EXT1: Row[] = [
  [1, "PA11", "PA11", "USB D− through R22 22 Ω"], [2, "PA8", "PA8"], [3, "PA12", "PA12", "USB D+ through R21 22 Ω; the DISC circuit's 1.5 kΩ (R20) pulls it up"], [4, "PA9", "PA9", "Not VBUS on this board: a free pin"],
  [5, "3.3V"], [6, "GND"], [7, "PA10", "PA10"], [8, "PC10", "PC10"],
  [9, "PC11", "PC11", "DISC: through R27 1 kΩ to Q3's base, 47 kΩ (R26) to 3.3 V. Q3 clamps it near 0.65 V, so as an input it reads low even with the pull-up; low with VBUS present switches 1.5 kΩ onto D+"],
  [10, "PC12", "PC12", "STAT LED through R4 2 kΩ and LED_E (lit when low)"],
  [11, "PD2", "PD2"], [12, "PB5", "PB5"], [13, "PB6", "PB6"], [14, "PA6", "PA6"],
  [15, "PB7", "PB7"], [16, "PB8", "PB8"], [17, "PB9", "PB9"], [18, "PA5", "PA5"],
  [19, "PC0", "PC0"], [20, "PC1", "PC1"], [21, "PB0", "PB0"], [22, "PA7", "PA7"],
  [23, "VBAT", undefined, "VBAT; the VBAT bridge (closed as shipped) ties it to 3.3 V"], [24, "PC13", "PC13"], [25, "RST", "NRST"], [26, "PB1", "PB1"],
]
const EXT2: Row[] = [
  [1, "VDDA", undefined, "3.3 V through the ferrite L1"], [2, "PC2", "PC2"], [3, "AGND", undefined, "VSSA, joined to GND by R16 0 Ω"], [4, "PA0", "PA0", "BUT through R19 560 Ω; R18 10 kΩ pull-up and C18 100 nF at the switch (low when pressed)"],
  [5, "3.3V"], [6, "GND"], [7, "PA2", "PA2"], [8, "PA1", "PA1"],
  [9, "PC3", "PC3"], [10, "PA3", "PA3"], [11, "PA4", "PA4"], [12, "PC4", "PC4", "USB_P: VBUS through R1 15 kΩ / R29 22 kΩ and the USBP_E bridge (closed as shipped)"],
  [13, "PC5", "PC5"], [14, "PB10", "PB10"], [15, "PB11", "PB11"], [16, "PB13", "PB13"],
  [17, "PB12", "PB12"], [18, "PB14", "PB14"], [19, "PB15", "PB15"], [20, "PC6", "PC6"],
  [21, "PC7", "PC7"], [22, "PC8", "PC8"], [23, "+5V_USB", undefined, "Raw USB VBUS, before D1"], [24, "PC9", "PC9"],
  [25, "GND"], [26, "VIN", undefined, "The regulator's input, after D1 and D2; no reverse-polarity protection of its own"],
]
const JTAG_ROWS: Row[] = [
  [1, "3.3V"], [2, "3.3V"],
  [3, "TRST", "PB4", "R23 10 kΩ to 3.3 V; the R-T bridge (open as shipped) joins it to RST"], [4, "GND"],
  [5, "TDI", "PA15", "R13 10 kΩ to 3.3 V"], [6, "GND"],
  [7, "TMS", "PA13", "SWDIO; R6 10 kΩ to 3.3 V"], [8, "GND"],
  [9, "TCK", "PA14", "SWCLK; R5 10 kΩ to 3.3 V"], [10, "GND"],
  [11, "RTCK", undefined, "R24 10 kΩ to GND (the UM's table calls it GND)"], [12, "GND"],
  [13, "TDO", "PB3", "SWO; R25 10 kΩ to 3.3 V"], [14, "GND"],
  [15, "RST", "NRST"], [16, "GND"],
  [17, "NC", undefined, "ARM's DBGRQ, which debuggers leave unconnected; R2 10 kΩ to GND on this board (the UM's table calls it GND)"], [18, "GND"],
  [19, "5V", undefined, "A debugger's 5 V supply: through D2 (1N5819S) to VIN, R3 47 kΩ to GND (the UM's table calls it GND)"], [20, "GND"],
]

function kindOf(label: string, mcu?: string): PinKind {
  if (label === "GND" || label === "AGND") return "gnd"
  if (/^(3\.3V|VDDA|VBAT|\+5V_USB|VIN|5V)$/.test(label)) return "power"
  return mcu ? "digital" : "nc"
}

const WIDTH = Math.ceil(at({ x: PLATE.x1, y: 0 }).x + 0.75)
const HEIGHT = Math.ceil(at({ x: 0, y: PLATE.y1 }).y + 0.75)

function ext(connector: "EXT1" | "EXT2", rows: Row[]): PinDef[] {
  return rows.map(([pin, label, mcu, note]) => {
    const odd = pin % 2 === 1
    const { x, y } = at(extPad(connector, pin))
    const top = connector === "EXT2"
    return {
      id: `${connector}-${pin}`,
      label,
      x,
      y,
      side: top ? "top" : "bottom",
      labelAt: top ? (odd ? "bottom" : "top") : odd ? "top" : "bottom",
      kind: kindOf(label, mcu),
      stub: top ? y : HEIGHT - y,
      mcu,
      connector,
      connectorPin: pin,
      note,
      printed: true,
    } satisfies PinDef
  })
}

const JTAG_PULLED_DOWN = [11, 17]

function jtag(rows: Row[]): PinDef[] {
  return rows.map(([pin, label, mcu, note]) => {
    const odd = pin % 2 === 1
    const { x, y } = at(jtagPad(pin))
    return {
      id: `JTAG-${pin}`,
      label,
      x,
      y,
      side: "right",
      labelAt: odd ? "left" : "right",
      kind: JTAG_PULLED_DOWN.includes(pin) ? "node" : kindOf(label, mcu),
      stub: WIDTH - x,
      mcu,
      connector: "JTAG",
      connectorPin: pin,
      note,
      printed: true,
    } satisfies PinDef
  })
}

const pins: PinDef[] = [...ext("EXT2", EXT2), ...ext("EXT1", EXT1), ...jtag(JTAG_ROWS)]

const changeover = (id: string, label: string, centre: { x: number; y: number }): PartDef => ({
  type: "switch",
  id,
  label,
  ...at(centre),
  span: Math.round(BRIDGE_PITCH * FRAME.cellsPerMm * 100) / 100,
  throws: { on: at({ x: centre.x - BRIDGE_PITCH, y: centre.y }), off: at({ x: centre.x + BRIDGE_PITCH, y: centre.y }) },
})

const usbpE = at({ x: USBP_E.x0, y: USBP_E.y })

const parts: PartDef[] = [
  { type: "led", id: "PWR", label: "PWR", ...at(AT.pwr), color: LED_COLORS.red.css, printed: true },
  { type: "led", id: "STAT", label: "STAT", ...at(AT.stat), color: LED_COLORS.green.css, mcu: "PC12", pin: "EXT1-10", printed: true },
  { type: "button", id: "BUT", label: "BUT", ...at(AT.but), size: 1.4, mcu: "PA0", pin: "EXT2-4", printed: true },
  { type: "button", id: "RESET", label: "RESET", ...at(AT.reset), size: 1.1, mcu: "NRST", pin: "EXT1-25", printed: true },
  { type: "usb", id: "USB", label: "USB", ...at(AT.usb), side: "left", plug: "usb-b", initial: { on: true } },
  changeover("B1", "B1_H/B1_L: BOOT1 (PB2) through R28 33 kΩ to 3.3 V (on, B1_H) or GND (off, B1_L as shipped)", BOOT_BRIDGES.b1),
  changeover("B0", "B0_H/B0_L: BOOT0 through R15 33 kΩ to 3.3 V (on, B0_H) or GND (off, B0_L as shipped: flash). B0_H boots system memory with B1_L (ST's bootloader is not modelled: the core sleeps there) and SRAM with B1_H; sampled at RESET", BOOT_BRIDGES.b0),
  { type: "switch", id: "USBP_E", label: "USBP_E: PC4 ↔ the VBUS divider (closed as shipped)", ...usbpE, span: Math.round((USBP_E.x1 - USBP_E.x0) * FRAME.cellsPerMm * 100) / 100, initial: { on: true } },
]

const GND = "EXT1-6"
const V33 = "EXT1-5"
const VIN = "EXT2-26"
const V5USB = "EXT2-23"
const NRST = "EXT1-25"
const BOOT0 = "$boot0"

const SCHOTTKY = { vf: 0.18, emission: 1 }
const LM1117 = { vout: 1.25 * (1 + 390 / 240) + 60e-6 * 390, dropout: 1.1 - 0.1 * (0.1 / 0.7), rdrop: 0.1 / 0.7, imax: 1.2, vinMax: 20, thermal: { rja: 61.6, tsd: 150, tsdOff: 135, tau: 2 } }
const BC817_BETA = 250
const BRIDGE_CLOSED_OHMS = 1e-3
const BRIDGE_OPEN_OHMS = 1e12
const bridge = (key: string) => (props: Record<string, string>) => (props[key] === "open" ? BRIDGE_OPEN_OHMS : BRIDGE_CLOSED_OHMS)

const jtagPin = (n: number) => `JTAG-${n}`
const mcuPads = pins.filter((p) => p.mcu && p.mcu !== "NRST").map((p) => p.id)

const model: ModelElement[] = [
  { kind: "SHORT", nodes: [GND, "EXT2-6", "EXT2-25", "EXT2-3", ...[4, 6, 8, 10, 12, 14, 16, 18, 20].map(jtagPin)] },
  { kind: "GND", node: GND },
  { kind: "SHORT", nodes: [V33, "EXT2-5", "EXT2-1", jtagPin(1), jtagPin(2)] },
  { kind: "SHORT", nodes: [NRST, jtagPin(15)] },
  { kind: "R", a: V33, b: "EXT1-23", value: bridge("vbat") },
  { kind: "V", plus: "$usb", minus: GND, value: 5 },
  { kind: "SW", a: "$usb", b: "$usbsw", part: "USB", closed: "on" },
  { kind: "REG", in: "$usbsw", out: V5USB, gnd: GND, value: 5, dropout: 0, imax: 0.5 },
  { kind: "D", anode: V5USB, cathode: VIN, ...SCHOTTKY },
  { kind: "D", anode: jtagPin(19), cathode: VIN, ...SCHOTTKY },
  { kind: "R", a: jtagPin(19), b: GND, value: 47e3 },
  { kind: "REG", in: VIN, out: V33, gnd: GND, value: LM1117.vout, dropout: LM1117.dropout, rdrop: LM1117.rdrop, imax: LM1117.imax, thermal: LM1117.thermal, limits: { voltage: LM1117.vinMax, fail: "open", fatal: false }, label: "VR LM1117-ADJ" },
  { kind: "R", a: V33, b: "$adj", value: 240 },
  { kind: "R", a: "$adj", b: GND, value: 390 },
  { kind: "D", anode: V33, cathode: "$pwrk", vf: LED_COLORS.red.vf, part: "PWR" },
  { kind: "R", a: "$pwrk", b: GND, value: 2e3 },
  { kind: "D", anode: V33, cathode: "$statk", vf: LED_COLORS.green.vf, part: "STAT" },
  { kind: "R", a: "$statk", b: "$lede", value: 2e3 },
  { kind: "R", a: "$lede", b: "EXT1-10", value: bridge("lede") },
  { kind: "R", a: V33, b: "$but", value: 10e3 },
  { kind: "SW", a: "$but", b: GND, part: "BUT", closed: "pressed" },
  { kind: "C", a: "$but", b: GND, value: 100e-9 },
  { kind: "R", a: "$but", b: "EXT2-4", value: 560 },
  { kind: "R", a: NRST, b: V33, value: 10e3 },
  { kind: "C", a: NRST, b: GND, value: 100e-9 },
  { kind: "SW", a: NRST, b: GND, part: "RESET", closed: "pressed" },
  { kind: "R", a: V5USB, b: "$usbp", value: 15e3 },
  { kind: "R", a: "$usbp", b: GND, value: 22e3 },
  { kind: "SW", a: "$usbp", b: "EXT2-12", part: "USBP_E", closed: "on" },
  { kind: "R", a: "EXT1-1", b: "$dm", value: 22 },
  { kind: "R", a: "EXT1-3", b: "$dp", value: 22 },
  { kind: "SW", a: "$dm", b: "$hostdm", part: "USB", closed: "on" },
  { kind: "SW", a: "$dp", b: "$hostdp", part: "USB", closed: "on" },
  { kind: "R", a: "$hostdm", b: GND, value: 15e3 },
  { kind: "R", a: "$hostdp", b: GND, value: 15e3 },
  { kind: "R", a: V33, b: "$q3b", value: 47e3 },
  { kind: "R", a: "EXT1-9", b: "$q3b", value: 1e3 },
  { kind: "Q", polarity: "npn", b: "$q3b", c: "$q4b", e: GND, beta: BC817_BETA },
  { kind: "R", a: V5USB, b: "$q4b", value: 10e3 },
  { kind: "R", a: "$q4b", b: GND, value: 33e3 },
  { kind: "Q", polarity: "npn", b: "$q4b", c: V33, e: "$q4e", beta: BC817_BETA },
  { kind: "R", a: "$q4e", b: "EXT1-3", value: 1.5e3 },
  ...[3, 5, 7, 9, 13].map((n): Element => ({ kind: "R", a: jtagPin(n), b: V33, value: 10e3 })),
  ...JTAG_PULLED_DOWN.map((n): Element => ({ kind: "R", a: jtagPin(n), b: GND, value: 10e3 })),
  { kind: "R", a: jtagPin(15), b: jtagPin(3), value: bridge("rt") },
  { kind: "R", a: BOOT0, b: "$b0", value: 33e3 },
  { kind: "SW", a: "$b0", b: V33, part: "B0", closed: "on" },
  { kind: "SW", a: "$b0", b: GND, part: "B0", closed: "off" },
  { kind: "R", a: "$PB2", b: "$b1", value: 33e3 },
  { kind: "SW", a: "$b1", b: V33, part: "B1", closed: "on" },
  { kind: "SW", a: "$b1", b: GND, part: "B1", closed: "off" },
  ...mcuModel(STM32F405RG, { vdd: V33, gnd: GND, nrst: NRST, boot0: BOOT0, pads: ["$PB2", ...mcuPads] }),
]

const solderBridge = (key: string, label: string) => ({ key, label, type: "select" as const, options: [{ value: "closed", label: "Closed" }, { value: "open", label: "Open (cut)" }] })

export const olimexStm32H405: ComponentDef = {
  id: "olimex-stm32-h405",
  name: "Olimex STM32-H405",
  description: "STM32F405RG",
  category: "Boards",
  icon: BoardIcon,
  prefix: "U",
  width: WIDTH,
  height: HEIGHT,
  defaults: { vbat: "closed", lede: "closed", rt: "open" },
  fields: [
    solderBridge("vbat", "VBAT bridge (bottom): VBAT to 3.3 V"),
    solderBridge("lede", "LED_E bridge (bottom): STAT LED to PC12"),
    solderBridge("rt", "R-T bridge (bottom): JTAG RST to TRST"),
  ],
  body: boardArt({ EXT1: EXT1.map((row) => row[1]), EXT2: EXT2.map((row) => row[1]), JTAG: JTAG_ROWS.map((row) => row[1]) }),
  pins,
  parts,
  model,
  hideIdle: true,
  pinsAreSockets: true,
  chip: STM32F405RG.id,
  mcuPower: V33,
  mcuReset: NRST,
  mcuBoot0: BOOT0,
  mcuVbat: "EXT1-23",
  mcuClocks: { hse: { hz: 8e6, kind: "crystal", startup: 2e-3 }, lse: { hz: 32768, kind: "crystal", startup: 2 } },
  info: {
    MCU: "STM32F405RGT6, Cortex-M4F 168 MHz, 1 MB Flash, 192 KB SRAM (128 KB + 64 KB CCM); the schematic's RET6 label is wrong",
    Board: `Rev. C, ${BOARD_MM.w} × ${BOARD_MM.h} mm, drawn to scale from Olimex's dimension drawing and UM photos. The board prints no pin names; εmul prints them in tables on the inner side of each header, as the Open746I-C does, which stretches the board: everything below EXT2 sits 3 cells lower, EXT1 with the LEDs, bridges and URL 7 cells lower, JTAG 2 cells right and its shroud widened for the names; inside each part, everything where Olimex put it. So the EXT headers stand 1.7 in apart here, not the board's 1 in (UM §6.3)`,
    LEDs: "STAT green on PC12 (lit when low, 2 kΩ, through LED_E), PWR red (2 kΩ)",
    Buttons: "BUT on PA0 (10 kΩ pull-up, 100 nF, 560 Ω, low when pressed), RESET",
    Power: "USB VBUS through D1, or a JTAG debugger's 5 V (pin 19) through D2, or VIN directly, into the LM1117-ADJ (240 Ω / 390 Ω: 3.30 V, 5.2 mA through the divider, over the 5 mA minimum load; dropout 1.1 V at 100 mA to 1.2 V at 800 mA, current limit 1.2 A typical, 0.8 A guaranteed — the UM’s “up to 800 mA” —, destroyed open past 20 V in without taking the board with it; it heats at 61.6 °C/W (TI's SOT-223 figure, not this board's copper) and shuts down at 150 °C, the absolute maximum, back on at 135 °C with a 2 s time constant — TI gives no shutdown point, hysteresis or time constant, so those three are assumptions; TI LM1117 §7.1, §7.4, §7.5); or 3.3 V straight onto the rail",
    USB: "D− PA11, D+ PA12 (22 Ω each); a plugged host's 15 kΩ pull-downs; VBUS sensed on PC4 through 15k/22k and USBP_E, not on PA9; no ID; PC11 low with VBUS present switches 1.5 kΩ onto D+ (Q3, Q4 BC817)",
    JTAG: "20-pin ARM header: TRST PB4, TDI PA15, TMS/SWDIO PA13, TCK/SWCLK PA14, TDO/SWO PB3 (10 kΩ pull-ups each), RST, 3.3 V on 1–2, RTCK (11) and 17 10 kΩ to GND, 5 V in on 19",
    Bridges: "On top, clickable: B0_H/B0_L and B1_H/B1_L (boot from flash, system memory or SRAM), USBP_E. On the bottom, in the inspector: VBAT, LED_E, R-T",
    "Not modelled": "The USB device stack (no OTG FS core), ST's bootloader in system memory (the core idles there), the JTAG/SWD protocol (the debugger reaches the core directly), the decoupling capacitors, the crystals' load network (C12/C13 27 pF and R12 1 MΩ on Q1, C14/C15 10 pF on Q2: the oscillators are ideal 8 MHz and 32 768 Hz after their start-up times), the backup domain's own current from VBAT (DS8626 Table 25, 0.1–1.68 µA: a cell on EXT1 #23 keeps the backup domain through an outage but carries nothing), U2/U3 and C16/C17 (not fitted on the board)",
    Source: "Olimex STM32-H405 user manual rev B, Rev. C schematic and dimension drawing",
  },
}
