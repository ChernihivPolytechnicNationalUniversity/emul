import { ATMEGA328P } from "@/mcu/avr/chip"
import { BoardIcon } from "../icons"
import type { ComponentDef, Element, ModelElement, PartDef, PinDef, PinKind } from "../types"
import { boardArt, FRAME, ICSP, ICSP_SHIFT, IOH_SHIFT, JACK, PARTS, PITCH, ROWS } from "./arduino-uno-art"
import { avrFields, avrMcuModel, AVR_ALT } from "./avr-chip"
import { LED_COLORS } from "./basic"
import { RESONATOR_STARTUP } from "./clock"
import { MF_MSMF } from "./polyfuse"
import { LP2985_33_GQ, lp2985Element, ncp1117Element } from "./power-ics"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"

/**
 * Arduino UNO Rev3 (A000066), from the Rev3e schematic and Eagle files (UNO-TH_Rev3e, 06/03/19),
 * the A000066 datasheet and Arduino's pinout sheet. Top view, USB and jack on the left.
 *
 * What the schematic puts between the ATmega328P-PU and the pins, all modelled:
 * - USB 5 V through F1 (MF-MSMF050-2, the resettable fuse) to USBVCC, and through T1 (FDN340P)
 *   onto +5V; T1's body diode feeds +5V before its gate is low;
 * - the jack through D1 (M7) to VIN, VIN through U1 (NCP1117ST50T3G) onto +5V;
 * - U5A (LMV358) comparing VIN / 2 (RN1A/RN1B, 10 kΩ each) with +3V3: above about 6.6 V on VIN it
 *   drives T1's gate high and USB stops feeding +5V;
 * - U2 (LP2985-33) from +5V onto +3V3 (150 mA);
 * - the ATmega16U2's UART through 1 kΩ (RN4A/RN4B) to D0/D1, its TX/RX LEDs through 1 kΩ (RN2), DTR
 *   through C5 (100 nF) and the RESET-EN jumper to RESET;
 * - RESET pulled up by 10 kΩ (RN1D) with D2 to +5V, the RESET button to ground;
 * - the L LED on D13 through U5B (LMV358, a follower) and 1 kΩ, so D13 itself carries almost nothing;
 * - the ON LED from +5V through two 1 kΩ in parallel (RN4C||RN4D);
 * - AVCC with C10 (L2, 10 µH, is a joint here: its filter works far above the engine's step); 100 nF on AREF (C4);
 * - the 16 MHz resonator (Y2, CSTCE16M0V53) with R2 (1 MΩ) on XTAL1/XTAL2.
 */

/** [header pin, printed name, MCU pin, note]. */
type Row = [number, string, string?, string?]

const IOL: Row[] = [
  [1, "RX←0", "PD0", "RXD; 1 kΩ (RN4) from the 16U2's TX, which idles high"],
  [2, "TX→1", "PD1", "TXD; 1 kΩ (RN4) to the 16U2's RX"],
  [3, "2", "PD2"],
  [4, "~3", "PD3"],
  [5, "4", "PD4"],
  [6, "~5", "PD5"],
  [7, "~6", "PD6"],
  [8, "7", "PD7"],
]
const IOH: Row[] = [
  [1, "8", "PB0"],
  [2, "~9", "PB1"],
  [3, "~10", "PB2"],
  [4, "~11", "PB3"],
  [5, "12", "PB4"],
  [6, "13", "PB5", "the L LED through U5B, a follower: the pin sees only the op amp's input"],
  [7, "GND"],
  [8, "AREF", undefined, "ADC reference; 100 nF (C4) to ground"],
  [9, "SDA", "PC4", "the same net as A4"],
  [10, "SCL", "PC5", "the same net as A5"],
]
const POWER: Row[] = [
  [1, "NC", undefined, "not connected"],
  [2, "IOREF", undefined, "+5V: tells a shield the board's logic level"],
  [3, "RESET", "PC6"],
  [4, "3.3V", undefined, "the LP2985-33's output, 150 mA"],
  [5, "5V", undefined, "+5V rail: out from USB or VIN, or 5 V in"],
  [6, "GND"],
  [7, "GND"],
  [8, "VIN", undefined, "the jack after D1, or 7–12 V in; 6–20 V is the datasheet's range"],
]
const AD: Row[] = [
  [1, "A0", "PC0"],
  [2, "A1", "PC1"],
  [3, "A2", "PC2"],
  [4, "A3", "PC3"],
  [5, "A4", "PC4", "also SDA"],
  [6, "A5", "PC5", "also SCL"],
]
const ICSP_ROWS: [number, string, string?][] = [
  [1, "MISO", "PB4"],
  [2, "+5V"],
  [3, "SCK", "PB5"],
  [4, "MOSI", "PB3"],
  [5, "RESET", "PC6"],
  [6, "GND"],
]

const cell = (mm: { x: number; y: number }) => ({ x: Math.round((mm.x + FRAME.originX) * FRAME.cellsPerMm * 100) / 100, y: Math.round((mm.y + FRAME.originY) * FRAME.cellsPerMm * 100) / 100 })

function kindOf(label: string, mcu?: string): PinKind {
  if (label === "GND") return "gnd"
  if (/^(VIN|5V|\+5V|3\.3V|IOREF)$/.test(label)) return "power"
  if (label === "AREF") return "analog"
  return mcu ? "digital" : "analog"
}

type Strip = "IOH" | "IOL" | "POWER" | "AD"
const STRIPS: Record<Strip, { rows: Row[]; at: { x: number; y: number; step: number }; shift: number; top: boolean }> = {
  IOH: { rows: IOH, at: ROWS.ioh, shift: IOH_SHIFT, top: true },
  IOL: { rows: IOL, at: ROWS.iol, shift: 0, top: true },
  POWER: { rows: POWER, at: ROWS.power, shift: 0, top: false },
  AD: { rows: AD, at: ROWS.ad, shift: 0, top: false },
}

const strip = (name: Strip): PinDef[] => {
  const s = STRIPS[name]
  return s.rows.map(([pin, label, mcu, note]) => ({
    id: `${name}-${pin}`,
    label,
    ...cell({ x: s.at.x + (pin - 1) * s.at.step + s.shift, y: s.at.y }),
    side: s.top ? "top" : "bottom",
    labelAt: s.top ? "bottom" : "top",
    kind: kindOf(label, mcu),
    stub: 1,
    mcu,
    fn: mcu ? AVR_ALT[mcu] : undefined,
    connector: name,
    connectorPin: pin,
    note,
    printed: true,
  }))
}

const icsp: PinDef[] = ICSP_ROWS.map(([pin, label, mcu]) => {
  const outer = pin % 2 === 0
  return {
    id: `ICSP-${pin}`,
    label,
    ...cell({ x: ICSP.x[outer ? 1 : 0] + ICSP_SHIFT, y: ICSP.y[Math.floor((pin - 1) / 2)] }),
    side: outer ? "right" : "left",
    labelAt: outer ? "left" : "right",
    kind: kindOf(label === "+5V" ? "5V" : label, mcu),
    stub: 1,
    mcu,
    fn: mcu ? AVR_ALT[mcu] : undefined,
    connector: "ICSP",
    connectorPin: pin,
    note: `ICSP ${pin}: the same net as ${mcu ? [...IOH, ...POWER].find((r) => r[2] === mcu)![1] : label === "+5V" ? "5V" : "GND"}`,
    printed: true,
  }
})

/** The 16U2's end of the USB serial port on the USB-B, above and below the plug, on the board's edge, well inside the receptacle. */
const USB_FACE_X = 0
const pins: PinDef[] = [
  { id: "VCP-TX", label: "TX", ...cell({ x: USB_FACE_X, y: 4 * PITCH }), side: "left", labelAt: "right", kind: "digital", stub: 1, signal: "ATmega16U2 RXD1", note: "D1/TX through 1 kΩ: what the board sends to the PC. A terminal's RX here is the PC listening over USB", printed: true, hostSerial: "in" },
  { id: "VCP-RX", label: "RX", ...cell({ x: USB_FACE_X, y: 8 * PITCH }), side: "left", labelAt: "right", kind: "digital", stub: 1, signal: "ATmega16U2 TXD1", note: "The 16U2's TXD, to D0/RX through 1 kΩ: what the PC sends. A terminal's TX here is the PC typing over USB", printed: true, hostSerial: "out" },
  // The jack, as the Open746I-C's 5VDC: its centre pin at the mouth; the supply's minus goes to any GND.
  { id: "JACK", label: "DC", ...cell({ x: JACK.mouth, y: JACK.y }), side: "left", labelAt: "right", kind: "power", stub: 2, signal: "PWRIN", connector: "X1", connectorPin: 2, note: "The 2.1 mm jack's centre pin, plus: 7–12 V recommended, through D1 (M7) to VIN. Its sleeve is the board's ground: the supply's minus to any GND", printed: true },
  ...strip("IOH"),
  ...strip("IOL"),
  ...strip("POWER"),
  ...strip("AD"),
  ...icsp,
]

/** What the board prints by each header: no NC, no SDA/SCL on top, one GND for the pair (the art draws it), Vin. */
const printed = (rows: Row[]) => rows.map(([, label]) => (/^(NC|SDA|SCL|GND)$/.test(label) && rows !== IOH ? "" : /^(SDA|SCL)$/.test(label) ? "" : label === "VIN" ? "Vin" : label))
const body = boardArt({ ioh: printed(IOH), iol: printed(IOL), power: printed(POWER), ad: printed(AD) })
const WIDTH = Math.ceil(cell({ x: 68.58, y: 0 }).x)
const HEIGHT = Math.ceil(cell({ x: 0, y: 53.34 }).y)

const parts: PartDef[] = [
  { type: "usb", id: "USB", label: "USB-B", ...cell(PARTS.usb), side: "left", initial: { on: true } },
  { type: "button", id: "RESET", label: "RESET", ...cell(PARTS.reset), size: 1.1, printed: true },
  { type: "switch", id: "RESET-EN", label: "RESET EN", ...cell({ x: PARTS.resetEn.x - PITCH / 2, y: PARTS.resetEn.y }), span: 1, initial: { on: true } },
  ...(["L", "TXLED", "RXLED", "ON"] as const).map((id): PartDef => {
    const at = PARTS.leds[id === "TXLED" ? "TX" : id === "RXLED" ? "RX" : id]
    const color = id === "ON" ? LED_COLORS.green.css : LED_COLORS.yellow.css
    return { type: "led", id, label: id === "TXLED" ? "TX" : id === "RXLED" ? "RX" : id, ...cell(at), color, printed: true, ...(id === "L" ? { pin: "IOH-6", mcu: "PB5" } : {}) }
  }),
]

// --- electrical model ---------------------------------------------------------

const GND = "POWER-6"
const V5 = "POWER-5"
const VIN = "POWER-8"
const V3V3 = "POWER-4"
const RESET = "POWER-3"
const AREF = "IOH-8"
const D13 = "IOH-6"

/** Resistor arrays RN1 (10 kΩ) and RN2/RN4 (1 kΩ). */
const RN1 = 10e3
const RN = 1e3
const VBUS = 5
const F1 = MF_MSMF["MF-MSMF050"]
/** FDN340P (onsemi FDN340P/D): VGS(th) −0.8 V typ, RDS(on) 70 mΩ max at −4.5 V; the body diode's VSD 0.7 V typ. */
const T1 = { vth: 0.8, rdson: 0.07, vsd: 0.7 }
/** As the palette's MOSFETs size k from Rds(on) and the threshold (basic.ts `mosK`). */
const T1_K = 1 / (2 * T1.rdson * Math.max(1, 10 - T1.vth))
/** M7 (1N4007-class, 1 A): about 0.85 V at the board's tens of mA (1.0 V at 1 A on 1N4007 sheets). */
const D1_VF = 0.85
/**
 * ATmega16U2 (Atmel 7799D, §26.2): 13.5 mA active at 16 MHz and 5 V; an output holds 4.2 V at
 * −10 mA (≈ 80 Ω up); I/O pull-ups 20–50 kΩ (35 kΩ taken).
 */
const U2 = { supply: 13.5e-3, outOhms: (5 - 4.2) / 10e-3, pullUp: 35e3 }

/** A LED from +5V through 1 kΩ that lights while the 16U2's line is low (its firmware's TX/RX LED). */
const activityLed = (line: string, part: string, name: string): ModelElement[] => [
  { kind: "M", polarity: "pmos", g: line, s: V5, d: `$${part}a`, vth: 2, k: 0.05, label: `ATmega16U2 ${part === "TXLED" ? "PD5" : "PD4"}` },
  { kind: "R", a: `$${part}a`, b: `$${part}k`, value: RN, label: "RN2" },
  { kind: "D", anode: `$${part}k`, cathode: GND, vf: LED_COLORS.yellow.vf, part, label: name },
]

/** Header pins per MCU pin (RESET, D11–D13, A4/A5 are on more than one). */
const byMcu = new Map<string, string[]>()
for (const p of pins) if (p.mcu) byMcu.set(p.mcu, [...(byMcu.get(p.mcu) ?? []), p.id])

const model: ModelElement[] = [
  { kind: "SHORT", nodes: pins.filter((p) => p.kind === "gnd").map((p) => p.id) },
  { kind: "GND", node: GND },
  ...[...byMcu.values()].filter((ids) => ids.length > 1).map((ids): Element => ({ kind: "SHORT", nodes: ids })),
  { kind: "SHORT", nodes: [V5, "ICSP-2", "POWER-2"] },
  // USB: VBUS → F1 → USBVCC → T1 → +5V.
  { kind: "V", plus: "$vbus", minus: GND, value: VBUS, label: "USB VBUS (the host port)" },
  { kind: "SW", a: "$vbus", b: "$xusb", part: "USB", closed: "on", label: "USB cable" },
  {
    kind: "R",
    a: "$xusb",
    b: "$usbvcc",
    value: F1.rmin,
    ptc: { hold: F1.hold, trip: F1.trip, at: F1.at, within: F1.within, pd: F1.pd },
    limits: { voltage: F1.vmax, current: F1.imax, fail: "open" },
    label: "F1 MF-MSMF050-2",
  },
  { kind: "M", polarity: "pmos", g: "$gate", s: V5, d: "$usbvcc", vth: T1.vth, k: T1_K, label: "T1 FDN340P" },
  { kind: "D", anode: "$usbvcc", cathode: V5, vf: T1.vsd, label: "T1 body diode" },
  // U5A: VIN / 2 against +3V3; above, the gate goes high and T1 lets go.
  { kind: "R", a: VIN, b: "$cmp", value: RN1, label: "RN1A" },
  { kind: "R", a: "$cmp", b: GND, value: RN1, label: "RN1B" },
  { kind: "OPAMP", inp: "$cmp", inn: V3V3, out: "$gate", vcc: V5, vee: GND, part: "lmv358", label: "U5A LMV358" },
  // Jack → D1 → VIN → U1 → +5V.
  { kind: "D", anode: "JACK", cathode: VIN, vf: D1_VF, label: "D1 M7" },
  { kind: "C", a: VIN, b: GND, value: 47e-6, label: "PC1 47 µF" },
  ncp1117Element({ in: VIN, out: V5, gnd: GND }, 5, "U1 NCP1117ST50T3G"),
  { kind: "C", a: V5, b: GND, value: 47e-6, label: "PC2 47 µF" },
  { kind: "C", a: V5, b: GND, value: 100e-9, label: "C2" },
  // +5V → U2 → +3V3.
  lp2985Element({ in: V5, out: V3V3, gnd: GND, en: V5 }, 3.3, LP2985_33_GQ, "U2 LP2985-33"),
  { kind: "C", a: V3V3, b: GND, value: 1e-6, label: "C3" },
  // ON: +5V through RN4C || RN4D.
  { kind: "R", a: V5, b: "$ONk", value: RN / 2, label: "RN4C || RN4D" },
  { kind: "D", anode: "$ONk", cathode: GND, vf: LED_COLORS.green.vf, part: "ON", label: "ON LED" },
  // L: U5B follows D13 and drives the LED through RN2.
  { kind: "OPAMP", inp: D13, inn: "$l13", out: "$l13", vcc: V5, vee: GND, part: "lmv358", label: "U5B LMV358" },
  { kind: "R", a: "$l13", b: "$Lk", value: RN, label: "RN2" },
  { kind: "D", anode: "$Lk", cathode: GND, vf: LED_COLORS.yellow.vf, part: "L", label: "L LED" },
  // The ATmega16U2 on +5V: TXD1 drives the RX net, RXD1 is an input with its pull-up; RN4 to the 328P.
  { kind: "R", a: V5, b: GND, value: 5 / U2.supply, label: "ATmega16U2 supply" },
  { kind: "GPIO", node: "VCP-RX", vddNode: V5, drive: { ohms: U2.outOhms }, label: "ATmega16U2 TXD1" },
  { kind: "R", a: V5, b: "VCP-TX", value: U2.pullUp, label: "ATmega16U2 RXD1 pull-up" },
  { kind: "R", a: "VCP-RX", b: "IOL-1", value: RN, label: "RN4A" },
  { kind: "R", a: "IOL-2", b: "VCP-TX", value: RN, label: "RN4B" },
  ...activityLed("VCP-TX", "TXLED", "TX LED"),
  ...activityLed("VCP-RX", "RXLED", "RX LED"),
  // DTR (PD7) idles high and couples into RESET through C5 while RESET-EN is joined.
  { kind: "R", a: V5, b: "$dtr", value: U2.outOhms, hidden: true },
  { kind: "SW", a: "$dtr", b: "$dtrc", part: "RESET-EN", closed: "on", label: "RESET-EN" },
  { kind: "C", a: "$dtrc", b: RESET, value: 100e-9, label: "C5" },
  // RESET: RN1D to +5V with D2 across it, the button to ground.
  { kind: "R", a: V5, b: RESET, value: RN1, label: "RN1D" },
  { kind: "D", anode: RESET, cathode: V5, vf: 0.7, label: "D2 CD1206-S01575" },
  { kind: "SW", a: RESET, b: GND, part: "RESET", closed: "pressed", label: "RESET" },
  { kind: "C", a: AREF, b: GND, value: 100e-9, label: "C4" },
  // AVCC through L2 with C10; C6 on VCC. L2 (10 µH) and C10 (100 nF) resonate at 159 kHz, far above
  // the engine's step: the filter is a straight joint here, as it is at DC.
  { kind: "SHORT", nodes: [V5, "$avcc"] },
  { kind: "C", a: "$avcc", b: GND, value: 100e-9, label: "C10" },
  { kind: "C", a: V5, b: GND, value: 100e-9, label: "C6" },
  ...avrMcuModel(ATMEGA328P, {
    vcc: V5,
    avcc: "$avcc",
    gnd: GND,
    pads: [...byMcu.values()].map((ids) => {
      const mcu = pins.find((p) => p.id === ids[0])!.mcu!
      return { node: ids[0], avcc: /^PC/.test(mcu), reset: mcu === "PC6" }
    }),
  }),
]

/** What Arduino burns into an Uno (boards.txt, uno.bootloader.*): 16 MHz, 256-word boot section with BOOTRST, BOD 2.7 V, boot section locked. */
export const UNO_FUSES = { low: 0xff, high: 0xde, extended: 0xfd, lock: 0x0f }
const hex = (v: number) => `0x${v.toString(16).toUpperCase().padStart(2, "0")}`

export const arduinoUno: ComponentDef = {
  id: "arduino-uno",
  name: "Arduino Uno R3",
  board: { vendor: "Arduino", mcu: "ATmega328P", mhz: 16, volts: 5, tags: [], photo: "arduino-uno.webp", core: "AVR", memory: "32 KB / 2 KB", onBoard: ["L LED", "USB serial", "ICSP"], alias: "UNO R3" },
  description: "Arduino Uno board, ATmega328P",
  keywords: ["Arduino", "Uno", "UNO R3", "Rev3", "ATmega328P", "AVR", "A000066", "ATmega16U2"],
  category: "boards",
  icon: BoardIcon,
  prefix: "U",
  width: WIDTH,
  height: HEIGHT,
  body,
  pins,
  parts,
  model,
  hideIdle: true,
  pinsAreSockets: true,
  chip: ATMEGA328P.id,
  mcuPower: V5,
  mcuReset: RESET,
  mcuVref: AREF,
  mcuClocks: { hse: { hz: 16e6, kind: "crystal", startup: RESONATOR_STARTUP }, lse: null },
  defaults: { fuseLow: hex(UNO_FUSES.low), fuseHigh: hex(UNO_FUSES.high), fuseExtended: hex(UNO_FUSES.extended), lock: hex(UNO_FUSES.lock), revision: ATMEGA328P.revisions[ATMEGA328P.revisions.length - 1] },
  fields: avrFields(ATMEGA328P, UNO_FUSES, "Arduino"),
  info: {
    // MCU: ATmega328P-PU (28 PDIP, in a socket), 16 MHz resonator (CSTCE16M0V53, ±0.5 %), 32 KB Flash (512 bytes of it
    //   Optiboot's boot section), 2 KB SRAM, 1 KB EEPROM
    // Power: USB: 5 V through the MF-MSMF050 resettable fuse (trips past 0.5–1 A) and T1 (FDN340P), so +5V sits within
    //   millivolts of the port. Jack/VIN: through D1 (M7) and the NCP1117 (1 A, thermal shutdown); once VIN passes about 6.6
    //   V the LMV358 comparator turns T1 off and the board runs from VIN alone. 3.3V: the LP2985 from +5V, 150 mA. 5V pin:
    //   in or out
    Power: "USB or jack/VIN, auto-switched",
    // USB serial: ATmega16U2: its TXD → 1 kΩ → D0/RX, D1/TX → 1 kΩ → its RXD; the TX and RX LEDs light while the lines are
    //   low. Wire a terminal to the TX/RX pins by the USB-B
    "USB serial": "ATmega16U2 on D0/D1",
    // L LED: on D13 through U5B, an LMV358 follower: D13 carries only the op amp's input current, unlike a Nano's
    "L LED": "D13 via op-amp buffer",
    // ICSP: 1 MISO (D12), 2 +5V, 3 SCK (D13), 4 MOSI (D11), 5 RESET, 6 GND — the same nets as those header pins
    ICSP: "Same nets as D11–D13",
    // Fuses: as Arduino programs them: low 0xFF, high 0xDE (BOOTRST, 256-word boot section), extended 0xFD (BOD 2.7 V),
    //   lock 0x0F
    Fuses: "As Arduino programs them",
    // Not modelled: the boot loader (Optiboot): the boot section is empty, so a reset runs straight into the sketch; the
    //   ATmega16U2's own firmware and USB (DTR auto-reset when a port opens, the TX/RX LEDs' pulse stretch, ICSP1, JP2); the
    //   USB ESD varistors and the ferrite; L2, AVCC's 10 µH filter (159 kHz with C10, beyond the solver's step)
    // Source: Arduino UNO Rev3e schematic and Eagle files (A000066), A000066 datasheet, Arduino AVR boards.txt
  },
}

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = [arduinoUno]

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "arduino-uno": {
    maker: "Arduino",
    docs: [DOCS["arduino-a000066-ds"], DOCS["arduino-uno-rev3e-sch"], DOCS["mchp-ds40002061b"], DOCS["onsemi-fdn340p"], DOCS["onsemi-ncp1117"], DOCS["ti-slvs522s"], DOCS["ti-slos263y"], DOCS["bourns-mf-msmf"], DOCS["murata-cstce16m0v53"]],
    specs: [],
    characteristics: [
      { kind: "clock", value: { max: 16e6 }, cite: { page: 2, at: "Features" } },
      { kind: "flash", value: { typ: 32768 }, cite: { page: 2, at: "Features" } },
      { kind: "ram", value: { typ: 2048 }, cite: { page: 2, at: "Features" } },
      { kind: "ioLevel", value: { typ: 5 }, limit: { max: 6 }, cite: { doc: "arduino-uno-rev3e-sch", page: 1 }, limitCite: { doc: "mchp-ds40002061b", page: 308, at: "§29.1 Absolute Maximum Ratings" } },
      { kind: "input", value: { min: 6 }, limit: { max: 20 }, cite: { page: 5, at: "§2.2 VINMax" } },
      { kind: "ioPins", value: { typ: 20 }, cite: { page: 4, at: "§1.1" } },
      { kind: "temperature", value: { min: -40, max: 85 }, cite: { page: 5, at: "§2.1" } },
    ],
    modelled: [
      { what: "Sketch runs at 16 MHz", test: "tests/sim/uno-bench.test.ts" },
      { what: "USB through F1 and T1", cite: { doc: "arduino-uno-rev3e-sch", page: 1 }, test: "tests/sim/uno-bench.test.ts" },
      { what: "Jack through D1 and NCP1117", cite: { doc: "arduino-uno-rev3e-sch", page: 1 }, test: "tests/sim/uno-bench.test.ts" },
      { what: "VIN turns T1 off", cite: { doc: "arduino-uno-rev3e-sch", page: 1 }, test: "tests/sim/uno-bench.test.ts" },
      { what: "F1 trips on overload", test: "tests/sim/uno-bench.test.ts" },
      { what: "3.3V from the LP2985", test: "tests/sim/uno-bench.test.ts" },
      { what: "USB serial through the 16U2", test: "tests/sim/uno-bench.test.ts" },
      { what: "L LED buffered by U5B", test: "tests/sim/uno-bench.test.ts" },
      { what: "RESET button holds the sketch", test: "tests/sim/uno-bench.test.ts" },
      { what: "Sketches compile for the Uno", test: "tests/firmware/arduino-sketch.test.ts" },
    ],
    notModelled: [{ what: "No Optiboot boot loader" }, { what: "No ATmega16U2 firmware or USB" }, { what: "No DTR auto-reset" }, { what: "No USB varistors or ferrite" }, { what: "No L2 AVCC filter" }, { what: "No ICSP programming" }],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
