import { arduinoMark, arduinoWordmark, unoBlock } from "../arduino-logo"
import { Artwork, type BoardFrame, type Mm, type TextStyle } from "../pcb-art"
import type { BodyShape } from "../types"

/**
 * The Arduino UNO Rev3 (A000066) top side, USB-B and the jack on the left, in millimetres, drawn
 * the way the Open746I-C is: grey connectors and headers, names on end in mono beside the pins,
 * the chips black, the small parts as pads, the board's own print. Positions are the Rev3e Eagle
 * board's (UNO-TH_Rev3e.brd), y running down: the outline with its notched right edge, the four
 * 3.2 mm holes, every part. The print follows a current production board (Arduino's photo): the
 * ∞ and ARDUINO wordmark (arduino-logo.ts, arduino.cc's own vectors), UNO knocked out of its
 * block beside R3, DIGITAL - PWM~, POWER, ANALOG IN, ARDUINO.CC.
 *
 * What emul does not model is under a "soon" badge: the ATmega16U2's own side (its firmware,
 * ICSP1, JP2), which the board's USB serial stands in for.
 */

export const PITCH = 2.54
/** Three cells left of the board for the USB-B over its edge; the headers land on whole cells. */
export const FRAME: BoardFrame = { originX: 3 * PITCH, originY: 0, cellsPerMm: 1 / PITCH }
export const BOARD_MM = { w: 68.58, h: 53.34 }

/** The outline (the .brd's dimension layer), y down: the right edge's 45° notch round the ICSP side. */
const OUTLINE: Mm[] = [
  { x: 0, y: 0 },
  { x: 64.516, y: 0 },
  { x: 66.04, y: 1.524 },
  { x: 66.04, y: 12.954 },
  { x: 68.58, y: 15.494 },
  { x: 68.58, y: 48.26 },
  { x: 66.04, y: 50.8 },
  { x: 66.04, y: 53.34 },
  { x: 0, y: 53.34 },
]
export const HOLES: Mm[] = [
  { x: 66.04, y: 17.78 },
  { x: 66.04, y: 45.72 },
  { x: 15.24, y: 2.54 },
  { x: 13.97, y: 50.8 },
]
const HOLE_R = 1.6

/** Header rows: pin 1's centre and the direction the pins run. IOH sits 160 mil from IOL, off the 0.1" grid. */
export const ROWS = {
  iol: { x: 63.5, y: 2.54, step: -PITCH, count: 8 },
  ioh: { x: 41.656, y: 2.54, step: -PITCH, count: 10 },
  power: { x: 27.94, y: 50.8, step: PITCH, count: 8 },
  ad: { x: 50.8, y: 50.8, step: PITCH, count: 6 },
} as const
/** IOH is drawn 0.4 pitch left of where it is, so its pins land on the grid like the others' (the Nucleo's CN7). */
export const IOH_SHIFT = -0.4 * PITCH
/** ICSP (the 328P's): 1, 3, 5 down the inner column, 2, 4, 6 the outer; drawn 0.05 pitch left onto the grid. */
export const ICSP = { x: [63.627, 66.167], y: [22.86, 25.4, 27.94] }
export const ICSP_SHIFT = -0.05 * PITCH
/** The 2.1 mm jack: its mouth on the grid, where its pin is, and its centre line (0.6 mm under the .brd's). */
export const JACK = { mouth: -PITCH, y: 18 * PITCH, depth: 14.2, h: 9.0 }

export const PARTS = {
  usb: { x: -3.2, y: 14.73 },
  reset: { x: 6.5, y: 2.75 },
  leds: { L: { x: 27.94, y: 11.176 }, TX: { x: 27.94, y: 16.764 }, RX: { x: 27.94, y: 19.05 }, ON: { x: 58.42, y: 16.764 } },
  resetEn: { x: 27.94, y: 26.035 },
} as const

/**
 * The 16U2's corner in two boxes, each holding its parts whole (they move with IOH, as the header
 * does): ICSP1 left of AREF's name, the chip and JP2 under it, clear of the LEDs' names.
 */
const SOON_ICSP1 = { from: { x: 12.4, y: 4.3 }, to: { x: 21.2, y: 10.0 }, label: "ICSP1" }
const SOON_16U2 = { from: { x: 12.4, y: 10.0 }, to: { x: 23.0, y: 22.7 }, label: "ATmega16U2 · JP2" }

const NAME: TextStyle = { size: 0.5, mono: true }
const SMALL: TextStyle = { size: 0.36, mono: true }
const TITLE: TextStyle = { size: 0.62, mono: true, muted: true }
const named = (style: TextStyle, extra: Partial<TextStyle>): TextStyle => ({ ...style, ...extra })

const rowXs = (row: { x: number; step: number; count: number }) => Array.from({ length: row.count }, (_, i) => row.x + i * row.step)

/** 0603 passives, 0805 LEDs, the resistor arrays, the MiniMELF diode: their pads as one grey block. */
const SMD = { c0603: [1.6, 0.8], array: [3.2, 1.6], melf: [3.5, 1.6] } as const
function smd(a: Artwork, x: number, y: number, size: readonly [number, number], vertical = false) {
  const [w, h] = vertical ? [size[1], size[0]] : size
  a.rect("connector", x - w / 2, y - h / 2, x + w / 2, y + h / 2, 0.1)
}

/** A female header row: the grey strip; the pins are its sockets. */
function socketRow(a: Artwork, xs: number[], y: number, trimLeft = 1.25) {
  a.rect("connector", Math.min(...xs) - trimLeft, y - 1.25, Math.max(...xs) + 1.25, y + 1.25, 0.3)
}

/** A male block of pins. */
function maleBlock(a: Artwork, xs: readonly number[], ys: readonly number[]) {
  a.rect("connector", Math.min(...xs) - 1.25, Math.min(...ys) - 1.25, Math.max(...xs) + 1.25, Math.max(...ys) + 1.25, 0.3)
}

function soon(region: { from: Mm; to: Mm; label: string }, draw: (a: Artwork) => void): BodyShape {
  const a = new Artwork(FRAME)
  draw(a)
  const x = a.cellX(region.from.x)
  const y = a.cellY(region.from.y)
  return { type: "soon", x, y, w: a.cellX(region.to.x) - x, h: a.cellY(region.to.y) - y, label: region.label, body: a.shapes() }
}

/** Names printed by each header, in pin order; "" prints nothing (NC, SDA/SCL, the GND pair has one name). */
export type UnoNames = { ioh: string[]; iol: string[]; power: string[]; ad: string[] }

export function boardArt(names: UnoNames): BodyShape[] {
  const art = new Artwork(FRAME)

  // --- Holes.
  for (const h of HOLES) art.circle("zone", h.x, h.y, HOLE_R)

  // --- Headers, their names on end beside them, reading up as the board prints them.
  const ioh = art.moved({ x: IOH_SHIFT, y: 0 })
  // Shifted, IOH's strip stops short of the hole by SCL, as the real one clears it.
  socketRow(ioh, rowXs(ROWS.ioh), ROWS.ioh.y, 0.85)
  socketRow(art, rowXs(ROWS.iol), ROWS.iol.y)
  socketRow(art, rowXs(ROWS.power), ROWS.power.y)
  socketRow(art, rowXs(ROWS.ad), ROWS.ad.y)
  const down = named(NAME, { rotate: -90, anchor: "end" })
  const up = named(NAME, { rotate: -90, anchor: "start" })
  const iohNames = ioh.grouped()
  names.ioh.forEach((n, i) => n && iohNames.text(n, ROWS.ioh.x + i * ROWS.ioh.step, 4.2, down))
  const iolNames = art.grouped()
  names.iol.forEach((n, i) => n && iolNames.text(n, ROWS.iol.x + i * ROWS.iol.step, 4.2, down))
  const powerNames = art.grouped()
  names.power.forEach((n, i) => n && powerNames.text(n, ROWS.power.x + i * ROWS.power.step, 49.2, up))
  // One GND over the two ground pins, between them.
  powerNames.text("GND", ROWS.power.x + 5.5 * ROWS.power.step, 49.2, up)
  const adNames = art.grouped()
  names.ad.forEach((n, i) => n && adNames.text(n, ROWS.ad.x + i * ROWS.ad.step, 49.2, up))
  art.text("DIGITAL - PWM~", 29.0, 9.3, named(TITLE, { anchor: "start" }))
  art.line([{ x: 44.3, y: 9.3 }, { x: 65.2, y: 9.3 }])
  art.text("POWER", 42.3, 44.4, TITLE).text("ANALOG IN", 57.15, 44.4, TITLE)

  // --- ICSP for the ATmega328P, its name over it.
  const icsp = art.moved({ x: ICSP_SHIFT, y: 0 })
  maleBlock(icsp, ICSP.x, ICSP.y)
  icsp.text("ICSP", (ICSP.x[0] + ICSP.x[1]) / 2, 20.35, SMALL)

  // --- USB-B over the left edge, the jack under it, its mouth where its pin is.
  art.rect("connector", -6.35, 8.5, 9.53, 20.96, 0.4)
  art.outline(-6.35, 10.6, -4.4, 18.9, 0.3)
  art.rect("connector", JACK.mouth, JACK.y - JACK.h / 2, JACK.mouth + JACK.depth, JACK.y + JACK.h / 2, 0.6)
  art.outline(JACK.mouth, JACK.y - 3.2, JACK.mouth + 1.6, JACK.y + 3.2, 0.3)

  // --- RESET: the tact switch by the USB, its name on the board's edge.
  art.rect("connector", PARTS.reset.x - 2.6, PARTS.reset.y - 2.1, PARTS.reset.x + 2.6, PARTS.reset.y + 2.1, 0.3)
  art.text("RESET", 0.75, 3.0, named(SMALL, { rotate: -90 }))

  // --- Power: F1, T1, U1 (NCP1117, SOT-223), the 47 µF cans, D1 (M7), U2 (LP2985), U5 (LMV358).
  art.rect("connector", 2.5, 24.2, 5.2, 29.4, 0.2)
  art.rect("chip", 7.4, 26.0, 8.9, 27.7, 0.1)
  art.rect("connector", 3.6, 34.3, 6.0, 37.6, 0.1)
  art.rect("chip", 6.0, 32.7, 9.5, 39.2, 0.15)
  for (const y of [33.63, 35.94, 38.25]) art.rect("connector", 9.5, y - 0.35, 11.2, y + 0.35)
  for (const x of [17.8, 25.3]) {
    art.circle("connector", x, 44.6, 3.1)
    art.circle("zone", x, 44.6, 2.55)
    art.text("47", x, 44.1, SMALL).text("25V", x, 45.2, named(SMALL, { size: 0.3 }))
  }
  art.rect("chip", 18.6, 49.4, 24.0, 52.0, 0.1)
  art.text("M7", 21.3, 50.7, { size: 0.42, inverse: true, mono: true })
  art.rect("chip", 21.3, 36.6, 22.7, 39.6, 0.1)
  art.rect("chip", 17.6, 31.7, 20.5, 34.3, 0.1)

  // --- The small parts outside the 16U2's corner, at their .brd places.
  smd(art, 27.94, 8.89, SMD.c0603)
  smd(art, 27.94, 13.97, SMD.array, true)
  smd(art, 27.94, 21.84, SMD.c0603)
  smd(art, 27.94, 23.5, SMD.c0603)
  smd(art, 27.94, 29.46, SMD.array, true)
  smd(art, 12.07, 23.5, SMD.c0603)
  smd(art, 18.42, 37.97, SMD.c0603, true)
  smd(art, 25.53, 37.97, SMD.c0603, true)
  smd(art, 41.28, 30.61, SMD.c0603)
  smd(art, 45.72, 30.48, SMD.c0603)
  smd(art, 44.32, 42.8, SMD.c0603)
  smd(art, 58.42, 19.56, SMD.array)
  smd(art, 59.44, 25.4, SMD.melf, true)

  // --- Y1 (the 16U2's crystal), Y2 (the 328P's resonator), RESET-EN's name.
  art.rect("connector", 13.6, 25.5, 24.2, 29.0, 1.75)
  art.text("16.000", 18.9, 27.25, SMALL)
  art.rect("chip", 39.7, 27.8, 42.9, 29.1, 0.2)
  // Clear of the jumper part's left contact, at 26.67 mm.
  art.text("RST EN", 25.3, 26.04, named(SMALL, { size: 0.32, anchor: "end" }))

  // --- ATmega328P-PU in its socket, pin 1 by the notch on the right as Arduino fits it.
  const dip = { x0: 28.6, x1: 64.1, y0: 34.0, y1: 39.9 }
  art.rect("connector", dip.x0 - 0.5, dip.y0 - 1.5, dip.x1 + 0.5, dip.y1 + 1.5, 0.2)
  for (let k = 0; k < 14; k++) {
    const x = 29.845 + k * PITCH
    art.rect("mark", x - 0.45, dip.y0 - 0.9, x + 0.45, dip.y0)
    art.rect("mark", x - 0.45, dip.y1, x + 0.45, dip.y1 + 0.9)
  }
  art.rect("chip", dip.x0, dip.y0, dip.x1, dip.y1, 0.3)
  art.circle("zone", dip.x1, (dip.y0 + dip.y1) / 2, 0.9)
  art.text("ATMEGA328P-PU", 45.2, 36.95, { size: 0.62, inverse: true, rotate: 180 })

  // --- The board's print.
  arduinoMark(art, { x: 39.1, y: 15.0 }, 13.3)
  arduinoWordmark(art, { x: 38.9, y: 19.8 }, 12.4)
  unoBlock(art, { x: 32.0, y: 23.1 }, 6.9, 3.1)
  art.outline(38.9, 23.1, 45.3, 26.2, 0.15)
  art.text("R3", 42.1, 24.65, { size: 1.0, mono: true })
  art.text("ARDUINO.CC", 53.1, 29.3, named(SMALL, { size: 0.42 }))
  art.text("L", 26.1, PARTS.leds.L.y, named(SMALL, { anchor: "end" }))
  art.text("TX", 26.1, PARTS.leds.TX.y, named(SMALL, { anchor: "end" })).text("RX", 26.1, PARTS.leds.RX.y, named(SMALL, { anchor: "end" }))
  art.text("ON", 60.0, PARTS.leds.ON.y, named(SMALL, { anchor: "start" }))

  // --- The 16U2's corner, under its soon badge, moved with IOH as the header is.
  const icsp1 = soon(SOON_ICSP1, (s) => maleBlock(s.moved({ x: IOH_SHIFT, y: 0 }), [15.748, 18.288, 20.828], [5.842, 8.382]))
  const u2 = soon(SOON_16U2, (s) => {
    const a = s.moved({ x: IOH_SHIFT, y: 0 })
    const c = { x: 19.939, y: 18.669 }
    a.rect("chip", c.x - 2.5, c.y - 2.5, c.x + 2.5, c.y + 2.5, 0.2)
    a.text("16U2", c.x, c.y, { size: 0.36, inverse: true })
    for (const x of [18.288, 20.828]) for (const y of [10.922, 13.462]) a.circle("zone", x, y, 0.66)
    a.text("JP2", 15.6, 12.2, SMALL)
    for (const y of [13.97, 19.69]) smd(a, 13.7, y, SMD.c0603)
    smd(a, 13.83, 16.51, SMD.array, true)
  })

  const plate: BodyShape = { type: "art", d: boardPath(art), fill: "board" }
  return [plate, ...art.shapes(), icsp1, u2]
}

/** The plate itself: the outline, in cells. */
function boardPath(a: Artwork) {
  const round = (v: number) => Math.round(v * 100) / 100
  return OUTLINE.map((p, i) => `${i ? "L" : "M"}${round(a.cellX(p.x))} ${round(a.cellY(p.y))}`).join("") + "Z"
}
