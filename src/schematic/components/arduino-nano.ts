import { ATMEGA328P } from "@/mcu/avr/chip"
import { BoardIcon } from "../icons"
import { Artwork, type BoardFrame, type TextStyle } from "../pcb-art"
import type { BodyShape, ComponentDef, Element, ModelElement, PartDef, PinDef, PinKind } from "../types"
import { avrFields, avrMcuModel, AVR_ALT } from "./avr-chip"
import { LED_COLORS } from "./basic"
import { crystalStartup } from "./clock"
import { PITCH } from "./open746i-c-art"

/**
 * Arduino Nano 3.x (A000005), from the Arduino schematic "NanoV3.3" (23/01/19), the A000005
 * datasheet and Arduino's pinout sheet (A000005-full-pinout, 30/06/2021). Top view, USB up.
 *
 * What the schematic puts between the ATmega328P-MUR and the pins, all modelled:
 * - USB 5 V through the MF-MSMF050 polyfuse (F1) and the SS1P3L Schottky (D1, "+5V auto
 *   selector") onto +5V, so a USB-powered board runs at about 4.7 V, not 5;
 * - VIN through the LM1117IMPX-5.0 (IC2) onto +5V; D1 keeps it out of the USB port;
 * - the FT232RL (IC1) on +5V: its TXD reaches D0/RX and D1/TX reaches its RXD through 1 kΩ
 *   (RP1A, RP1B), so a module on D0 fights the bridge's idle-high output through that 1 kΩ;
 *   its 3V3OUT is the 3V3 pin (50 mA at most); RX/TX LEDs on its CBUS0/CBUS1;
 * - RESET pulled up by 1 kΩ (RP1D), the RESET button (SW1) to ground, DTR# through 100 nF (C4);
 * - the L LED on D13 through 1 kΩ (RP2A), the PWR LED on +5V through 1 kΩ (RP1C);
 * - 100 nF on AREF (C1), AVCC on +5V with no filter;
 * - the 16 MHz resonator (Y1) on XTAL1/XTAL2.
 */

/** [header pin, silkscreen label, MCU pin, note] — J1 and J2 of the schematic, pin 1 at the far end from the USB. */
type Row = [number, string, string?, string?]

const J1: Row[] = [
  [1, "TX1", "PD1", "TXD; 1 kΩ (RP1B) to the FT232RL's RXD"],
  [2, "RX0", "PD0", "RXD; 1 kΩ (RP1A) from the FT232RL's TXD, which idles high"],
  [3, "RST", "PC6"],
  [4, "GND"],
  [5, "D2", "PD2"],
  [6, "D3", "PD3"],
  [7, "D4", "PD4"],
  [8, "D5", "PD5"],
  [9, "D6", "PD6"],
  [10, "D7", "PD7"],
  [11, "D8", "PB0"],
  [12, "D9", "PB1"],
  [13, "D10", "PB2"],
  [14, "D11", "PB3"],
  [15, "D12", "PB4"],
]
const J2: Row[] = [
  [1, "VIN", undefined, "7–12 V into the LM1117-5.0 (15 V at most)"],
  [2, "GND"],
  [3, "RST", "PC6"],
  [4, "5V", undefined, "+5V rail: out from USB or VIN, or 5 V in"],
  [5, "A7", "ADC7", "analog input only"],
  [6, "A6", "ADC6", "analog input only"],
  [7, "A5", "PC5"],
  [8, "A4", "PC4"],
  [9, "A3", "PC3"],
  [10, "A2", "PC2"],
  [11, "A1", "PC1"],
  [12, "A0", "PC0"],
  [13, "REF", undefined, "ADC reference; 100 nF (C1) to ground"],
  [14, "3V3", undefined, "the FT232RL's 3V3OUT: 50 mA at most, only while the bridge is powered"],
  [15, "D13", "PB5", "the L LED through 1 kΩ (RP2A)"],
]

/**
 * Geometry in millimetres on the PCB (18.54 × 43.18 mm, USB end up), drawn with the same
 * artwork kit as the Open746I-C. The frame puts every header pad on a grid node: the rows are
 * 0.6" apart and 0.065" in from the edges, pin 15 (D13, D12) is 3.81 mm from the USB end.
 */
const FRAME: BoardFrame = { originX: PITCH - 1.65, originY: PITCH / 2, cellsPerMm: 1 / PITCH }
const BOARD_MM = { w: 18.54, h: 43.18 }
const ROW_X = { j2: 1.65, j1: 16.89 }
/** Header pin n (1–15) along its row, pin 1 at the far end. */
const rowY = (pin: number) => 3.81 + (15 - pin) * PITCH
const MID_X = BOARD_MM.w / 2
const cell = (mm: { x: number; y: number }) => ({ x: Math.round((mm.x + FRAME.originX) * FRAME.cellsPerMm * 100) / 100, y: Math.round((mm.y + FRAME.originY) * FRAME.cellsPerMm * 100) / 100 })

/** ICSP (J4): three columns of two at the far end, pin 1 the square pad on the VIN side. */
const ICSP_X = [MID_X - PITCH, MID_X, MID_X + PITCH]
const ICSP_Y = { odd: rowY(1), even: rowY(2) }
const ICSP: [number, string, string?][] = [
  [1, "MISO", "PB4"],
  [2, "+5V"],
  [3, "SCK", "PB5"],
  [4, "MOSI", "PB3"],
  [5, "RST", "PC6"],
  [6, "GND"],
]

function kindOf(label: string, mcu?: string): PinKind {
  if (label === "GND") return "gnd"
  if (/^(VIN|5V|\+5V|3V3)$/.test(label)) return "power"
  if (label === "REF" || /^ADC/.test(mcu ?? "")) return "analog"
  return "digital"
}

const header = (connector: "J1" | "J2", rows: Row[]): PinDef[] => {
  const left = connector === "J2"
  return rows.map(([pin, label, mcu, note]) => ({
    id: `${connector}-${pin}`,
    label,
    ...cell({ x: left ? ROW_X.j2 : ROW_X.j1, y: rowY(pin) }),
    side: left ? "left" : "right",
    labelAt: left ? "right" : "left",
    kind: kindOf(label, mcu),
    stub: 1,
    mcu,
    fn: mcu ? AVR_ALT[mcu] : undefined,
    connector,
    connectorPin: pin,
    note,
    printed: true,
  }))
}

const icsp: PinDef[] = ICSP.map(([pin, label, mcu]) => {
  const odd = pin % 2 === 1
  return {
    id: `J4-${pin}`,
    label,
    ...cell({ x: ICSP_X[Math.floor((pin - 1) / 2)], y: odd ? ICSP_Y.odd : ICSP_Y.even }),
    side: odd ? "bottom" : "top",
    labelAt: odd ? "bottom" : "top",
    kind: kindOf(label, mcu),
    // The odd row's stubs clear the board's far edge; the even row's go up between the rows.
    stub: odd ? 2 : 1,
    mcu,
    fn: mcu ? AVR_ALT[mcu] : undefined,
    connector: "J4",
    connectorPin: pin,
    note: `ICSP ${pin}: the same net as ${mcu ? J1.concat(J2).find((r) => r[2] === mcu)![1] : label === "+5V" ? "5V" : "GND"}`,
    printed: true,
  }
})

/** The two FT232RL-side pins sit just past the USB end, either side of the connector. */
const VCP_Y = -1.27
const VCP_X = { tx: 4.19, rx: 14.35 }

const pins: PinDef[] = [
  // The FT232RL's side of RP1A/RP1B: where the PC's end of the USB serial port is. On the real
  // board only the USB cable reaches it; here a terminal wired to these two pins stands in for
  // the PC.
  { id: "VCP-TX", label: "TX", ...cell({ x: VCP_X.tx, y: VCP_Y }), side: "top", labelAt: "bottom", kind: "digital", stub: 1, signal: "FT232RL RXD", note: "D1/TX through 1 kΩ: what the board sends to the PC. Connect a terminal's RX here", printed: true },
  { id: "VCP-RX", label: "RX", ...cell({ x: VCP_X.rx, y: VCP_Y }), side: "top", labelAt: "bottom", kind: "digital", stub: 1, signal: "FT232RL TXD", note: "The bridge's TXD, to D0/RX through 1 kΩ: what the PC sends. A terminal's TX here stands in for the PC", printed: true },
  ...header("J2", J2),
  ...header("J1", J1),
  ...icsp,
]

const TABLE: TextStyle = { size: 0.4, mono: true }
const CAPTION: TextStyle = { size: 0.45, muted: true }
const named = (style: TextStyle, extra: Partial<TextStyle>): TextStyle => ({ ...style, ...extra })

/**
 * The layout of the board's top side (USB up), as the A000005 and its copies print it: the pin
 * names stand on end beside their pads, reading away from the USB, which leaves the middle to
 * the chip, the resonator, the RESET switch, the four LEDs and ICSP.
 */
/** Pad centre to the middle of its name. */
const NAME_FROM_PAD_MM = 1.95
/** ATmega328P-MUR (the schematic's part): 32 VQFN, a 5 mm body at 45°, pads under its edges. */
const CHIP = { x: MID_X, y: 15.0, side: 5, pads: 8, pitch: 0.5 }
/** Y1, the 16 MHz resonator (3.2 × 1.3 mm), lengthways beside the chip. */
const Y1 = { x: 13.6, y: 19.9, w: 1.3, h: 3.2 }
/** The RESET switch (SW1), a 6 × 3.5 mm SMD tact switch across the board under the chip. */
const RESET_AT = { x: MID_X, y: 24.0 }
const RESET_MM = { w: 6.0, h: 3.5 }
/** The four 0805 LEDs, upright, left to right L, PWR, RX, TX (Arduino's pinout sheet). */
const LED_Y = 30.2
const LED_X = [7.2, 9.0, 10.8, 12.6]
const LED_MM = { w: 0.9, h: 1.6 }

/** A rectangle w × h centred on (x, y), turned by `angle` radians: its corners. */
function turned(x: number, y: number, w: number, h: number, angle: number) {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([dx, dy]) => ({ x: x + dx * c - dy * s, y: y + dx * s + dy * c }))
}

function boardArt(): BodyShape[] {
  const art = new Artwork(FRAME)
  // Pin names, on end beside the pads; SDA/SCL beside A4/A5 as the copies print them.
  const names = art.grouped()
  const upright = named(TABLE, { rotate: 90 })
  J2.forEach(([pin, label]) => names.text(label, ROW_X.j2 + NAME_FROM_PAD_MM, rowY(pin), upright))
  J1.forEach(([pin, label]) => names.text(label, ROW_X.j1 - NAME_FROM_PAD_MM, rowY(pin), upright))
  const extra = art.grouped()
  extra.text("SDA", ROW_X.j2 + NAME_FROM_PAD_MM + 1.25, rowY(8), named(TABLE, { rotate: 90, size: 0.32 })).text("SCL", ROW_X.j2 + NAME_FROM_PAD_MM + 1.25, rowY(7), named(TABLE, { rotate: 90, size: 0.32 }))
  // Pin 1 of each header: a square pad.
  for (const [px, py] of [[ROW_X.j2, rowY(1)], [ROW_X.j1, rowY(1)], [ICSP_X[0], ICSP_Y.odd]]) art.outline(px - 0.95, py - 0.95, px + 0.95, py + 0.95, 0)
  // Mounting holes, 1.78 mm, in line with the rows a pitch past each end.
  for (const x of [ROW_X.j2, ROW_X.j1]) for (const y of [rowY(15) - PITCH, rowY(1) + PITCH]) art.circle("none", x, y, 0.89)
  // Mini-B receptacle, overhanging the USB end: the shell and its mouth.
  art.rect("connector", MID_X - 3.85, -1.3, MID_X + 3.85, 7.0, 0.4)
  art.outline(MID_X - 2.6, -1.3, MID_X + 2.6, 1.2, 0.3)
  art.text("TX", VCP_X.tx, 0.9, TABLE).text("RX", VCP_X.rx, 0.9, TABLE)
  // ATmega328P-MUR: the body at 45°, eight pads along each edge, the pin-1 dot.
  const turn = Math.PI / 4
  art.polygon("chip", turned(CHIP.x, CHIP.y, CHIP.side, CHIP.side, turn), 0.15)
  const half = CHIP.side / 2
  for (let edge = 0; edge < 4; edge++) {
    const a = turn + (edge * Math.PI) / 2
    for (let k = 0; k < CHIP.pads; k++) {
      const along = (k - (CHIP.pads - 1) / 2) * CHIP.pitch
      // In the edge's own frame: `along` it, `half` out from the centre.
      const px = CHIP.x + along * Math.cos(a) - half * Math.sin(a)
      const py = CHIP.y + along * Math.sin(a) + half * Math.cos(a)
      art.polygon("mark", turned(px, py, 0.25, 0.45, a))
    }
  }
  art.circle("board", CHIP.x, CHIP.y - half * Math.SQRT2 + 1.0, 0.28)
  art.text("MEGA328P", CHIP.x, CHIP.y - 0.15, { size: 0.26, inverse: true }).text("MUR", CHIP.x, CHIP.y + 0.75, { size: 0.2, inverse: true })
  // Y1.
  art.rect("connector", Y1.x - Y1.w / 2, Y1.y - Y1.h / 2, Y1.x + Y1.w / 2, Y1.y + Y1.h / 2, 0.2)
  // RESET switch body (the cap is the part) and its name under it.
  art.rect("connector", RESET_AT.x - RESET_MM.w / 2, RESET_AT.y - RESET_MM.h / 2, RESET_AT.x + RESET_MM.w / 2, RESET_AT.y + RESET_MM.h / 2, 0.3)
  art.text("RESET", RESET_AT.x, RESET_AT.y + RESET_MM.h / 2 + 1.0, TABLE)
  // The LEDs' pads, and their names on end under them.
  const ledNames = art.grouped()
  LED_X.forEach((lx, i) => {
    art.rect("connector", lx - LED_MM.w / 2, LED_Y - LED_MM.h / 2, lx + LED_MM.w / 2, LED_Y + LED_MM.h / 2, 0.1)
    ledNames.text(["L", "PWR", "RX", "TX"][i], lx, LED_Y + 2.6, named(TABLE, { rotate: 90 }))
  })
  // ICSP: a box round the six pads and the 1 by pin 1.
  art.outline(ICSP_X[0] - 1.3, ICSP_Y.even - 1.3, ICSP_X[2] + 1.3, ICSP_Y.odd + 1.3, 0.2)
  art.text("1", ICSP_X[0] - 1.9, ICSP_Y.odd, TABLE)
  // Board name, on end by the +5V and A7 names.
  art.text("Nano", ROW_X.j2 + NAME_FROM_PAD_MM + 1.55, 30.0, named(CAPTION, { size: 0.5, rotate: 90 }))
  const plate: BodyShape = { type: "rect", x: art.cellX(0), y: art.cellY(0), w: art.cells(BOARD_MM.w), h: art.cells(BOARD_MM.h), rx: art.cells(0.8), fill: "board" }
  return [plate, ...art.shapes()]
}

const body = boardArt()
const WIDTH = Math.ceil(cell({ x: BOARD_MM.w, y: 0 }).x)
const HEIGHT = Math.ceil(cell({ x: 0, y: BOARD_MM.h }).y)

const parts: PartDef[] = [
  { type: "usb", id: "USB", label: "Mini-USB", ...cell({ x: MID_X, y: -0.9 }), side: "top", initial: { on: true } },
  { type: "button", id: "RESET", label: "RESET", ...cell(RESET_AT), size: 1.1, printed: true },
  ...(["L", "PWR", "RXLED", "TXLED"] as const).map((id, i): PartDef => {
    const color = { L: LED_COLORS.yellow, PWR: LED_COLORS.green, RXLED: LED_COLORS.red, TXLED: LED_COLORS.green }[id].css
    return { type: "led", id, label: ["L", "PWR", "RX", "TX"][i], ...cell({ x: LED_X[i], y: LED_Y }), color, printed: true, ...(id === "L" ? { pin: "J2-15", mcu: "PB5" } : {}) }
  }),
]

// --- electrical model ---------------------------------------------------------

const GND = "J1-4"
const V5 = "J2-4"
const VIN = "J2-1"
const V3V3 = "J2-14"
const AREF = "J2-13"
const RESET = "J2-3"
const D13 = "J2-15"
const FT_VCC = "$ftvcc"

/** Resistor arrays RP1/RP2: 1 kΩ each. */
const RP = 1e3
/** USB VBUS: the host port's 5 V. */
const VBUS = 5
/**
 * MF-MSMF050 polyfuse: 0.15–1.0 Ω, holds 0.5 A, trips at 1.0 A (Bourns data sheet). A trip
 * cools back in seconds, so it is drawn as the current limit of the path, not a failure.
 */
const F1_OHMS = 0.5
const F1_TRIP = 1.0
/** SS1P3L Schottky (Vishay): VF 0.37 V at 1 A typical, ≈ 0.3 V at the board's tens of mA. */
const D1_VF = 0.3
/** LM1117-5.0 (TI SNOS412): 1.2 V dropout at 800 mA, 800 mA rated, 15 V recommended (20 V absolute maximum), 5 mA quiescent. */
const LM1117 = { dropout: 1.2, imax: 0.8, vinMax: 20, quiescent: 5e-3 }
/**
 * FT232RL (FTDI DS_FT232R v2.16): 15 mA operating supply current; on VCCIO = 5 V a UART output
 * holds 4.1 V at 2 mA (≈ 450 Ω up), the inputs have 200 kΩ pull-ups; 3V3OUT gives 50 mA at
 * most. The CBUS0/CBUS1 LED drivers sink while data moves.
 */
const FT232 = { supply: 15e-3, outOhms: (5 - 4.1) / 2e-3, pullUp: 200e3, v3: 3.3, v3Max: 50e-3, v3Dropout: 0.4 }

/** A LED from +5V through 1 kΩ to an FT232 CBUS pin, which sinks while its line is low. */
const activityLed = (line: string, part: string, name: string, resistor: string, color: keyof typeof LED_COLORS): ModelElement[] => [
  { kind: "M", polarity: "pmos", g: line, s: FT_VCC, d: `$${part}a`, vth: 2, k: 0.05, label: `FT232RL ${part === "TXLED" ? "CBUS1" : "CBUS0"}` },
  { kind: "R", a: `$${part}a`, b: `$${part}k`, value: RP, label: resistor },
  { kind: "D", anode: `$${part}k`, cathode: GND, vf: LED_COLORS[color].vf, part, label: name },
]

/** Header pins per MCU pin (RESET is on J1-3 and J2-3). */
const byMcu = new Map<string, string[]>()
for (const p of pins) if (p.mcu) byMcu.set(p.mcu, [...(byMcu.get(p.mcu) ?? []), p.id])

const model: ModelElement[] = [
  { kind: "SHORT", nodes: pins.filter((p) => p.kind === "gnd").map((p) => p.id) },
  { kind: "GND", node: GND },
  ...[...byMcu.values()].filter((ids) => ids.length > 1).map((ids): Element => ({ kind: "SHORT", nodes: ids })),
  { kind: "SHORT", nodes: [V5, "J4-2"] },
  // USB: VBUS → F1 → D1 → +5V.
  { kind: "V", plus: "$vbus", minus: GND, value: VBUS, label: "USB VBUS (the host port)" },
  { kind: "SW", a: "$vbus", b: "$vbusp", part: "USB", closed: "on", label: "USB cable" },
  { kind: "REG", in: "$vbusp", out: "$vusbf", gnd: GND, value: VBUS, dropout: 0, imax: F1_TRIP, label: "F1 MF-MSMF050 trip" },
  { kind: "R", a: "$vusbf", b: "$vusb", value: F1_OHMS, label: "F1 MF-MSMF050" },
  { kind: "D", anode: "$vusb", cathode: V5, vf: D1_VF, label: "D1 SS1P3L" },
  // VIN → LM1117-5.0 → +5V.
  { kind: "REG", in: VIN, out: V5, gnd: GND, value: 5, dropout: LM1117.dropout, imax: LM1117.imax, limits: { voltage: LM1117.vinMax, fail: "open" }, label: "IC2 LM1117-5.0" },
  { kind: "R", a: VIN, b: GND, value: 5 / LM1117.quiescent, hidden: true },
  // The FT232RL runs from +5V; its supply node is +5V itself (VCC and VCCIO, pins 20 and 4).
  { kind: "SHORT", nodes: [V5, FT_VCC] },
  { kind: "R", a: FT_VCC, b: GND, value: 5 / FT232.supply, label: "FT232RL supply" },
  { kind: "REG", in: FT_VCC, out: V3V3, gnd: GND, value: FT232.v3, dropout: FT232.v3Dropout, imax: FT232.v3Max, label: "FT232RL 3V3OUT" },
  // TXD drives the RX net high when idle; RXD is an input with a pull-up. RP1A/RP1B to the MCU.
  { kind: "R", a: FT_VCC, b: "VCP-RX", value: FT232.outOhms, label: "FT232RL TXD" },
  { kind: "R", a: FT_VCC, b: "VCP-TX", value: FT232.pullUp, label: "FT232RL RXD pull-up" },
  { kind: "R", a: "VCP-RX", b: "J1-2", value: RP, label: "RP1A" },
  { kind: "R", a: "J1-1", b: "VCP-TX", value: RP, label: "RP1B" },
  ...activityLed("VCP-TX", "TXLED", "TX LED", "RP2D", "green"),
  ...activityLed("VCP-RX", "RXLED", "RX LED", "RP2B", "red"),
  // DTR# idles high (no port open) and couples into RESET through C4.
  { kind: "R", a: FT_VCC, b: "$dtr", value: FT232.outOhms, hidden: true },
  { kind: "C", a: "$dtr", b: RESET, value: 100e-9, label: "C4" },
  // RESET: RP1D to +5V, SW1 to ground.
  { kind: "R", a: V5, b: RESET, value: RP, label: "RP1D" },
  { kind: "SW", a: RESET, b: GND, part: "RESET", closed: "pressed", label: "SW1 RESET" },
  // LEDs: PWR on +5V, L on D13.
  { kind: "R", a: V5, b: "$PWRk", value: RP, label: "RP1C" },
  { kind: "D", anode: "$PWRk", cathode: GND, vf: LED_COLORS.green.vf, part: "PWR", label: "PWR LED" },
  { kind: "R", a: D13, b: "$Lk", value: RP, label: "RP2A" },
  { kind: "D", anode: "$Lk", cathode: GND, vf: LED_COLORS.yellow.vf, part: "L", label: "L LED" },
  { kind: "C", a: AREF, b: GND, value: 100e-9, label: "C1" },
  // The MCU: VCC and AVCC both on +5V.
  ...avrMcuModel(ATMEGA328P, {
    vcc: V5,
    avcc: V5,
    gnd: GND,
    pads: [...byMcu.values()].map((ids) => {
      const mcu = pins.find((p) => p.id === ids[0])!.mcu!
      return { node: ids[0], avcc: /^(PC|ADC)/.test(mcu), reset: mcu === "PC6" }
    }),
  }),
]

/** What Arduino burns into a Nano (boards.txt, nano.menu.cpu.atmega328): 16 MHz crystal, 1024-word boot section with BOOTRST, BOD 2.7 V, boot section locked. */
const NANO_FUSES = { low: 0xff, high: 0xda, extended: 0xfd, lock: 0x0f }
const hex = (v: number) => `0x${v.toString(16).toUpperCase().padStart(2, "0")}`

export const arduinoNano: ComponentDef = {
  id: "arduino-nano",
  name: "Arduino Nano",
  description: "ATmega328P, 16 MHz, USB serial",
  keywords: ["Arduino", "Nano", "ATmega328P", "AVR", "A000005", "FT232RL", "CH340"],
  category: "Boards",
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
  mcuClocks: { hse: { hz: 16e6, kind: "crystal", startup: crystalStartup(16e6) }, lse: null },
  defaults: { fuseLow: hex(NANO_FUSES.low), fuseHigh: hex(NANO_FUSES.high), fuseExtended: hex(NANO_FUSES.extended), lock: hex(NANO_FUSES.lock), revision: ATMEGA328P.revisions[ATMEGA328P.revisions.length - 1] },
  fields: avrFields(ATMEGA328P, NANO_FUSES, "Arduino"),
  info: {
    MCU: "ATmega328P (32 VQFN, numbered as the TQFP-32), 16 MHz resonator, 32 KB Flash (2 KB of it the boot section), 2 KB SRAM, 1 KB EEPROM",
    Power: "USB: 5 V through the 500 mA polyfuse and a Schottky, so +5V sits near 4.7 V. VIN: 7–12 V through the LM1117-5.0 (800 mA). 5V pin: in or out. 3V3: the FT232RL's 3V3OUT, 50 mA",
    "USB serial": "FT232RL: its TXD → 1 kΩ → D0/RX, D1/TX → 1 kΩ → its RXD; the TX and RX LEDs light while the lines are low. Wire a terminal to the TX/RX pins by the USB connector",
    ICSP: "J4: 1 MISO (D12), 2 +5V, 3 SCK (D13), 4 MOSI (D11), 5 RESET, 6 GND — the same nets as those header pins",
    Fuses: "as Arduino programs them: low 0xFF, high 0xDA (BOOTRST, 1024-word boot section), extended 0xFD (BOD 2.7 V), lock 0x0F. A sketch uploaded through the boot loader cannot change them, so an image's .fuse section is ignored here",
    "Not modelled": "the boot loader: the boot section is empty, so a reset runs through its erased words straight into the sketch (no upload delay, no LED flicker on D13); the USB side of the FT232RL (DTR auto-reset when a port opens, the drivers); the CBUS LEDs' pulse stretch",
    Source: "Arduino Nano V3.3 schematic (A000005-schematics.pdf), A000005 datasheet",
  },
}
