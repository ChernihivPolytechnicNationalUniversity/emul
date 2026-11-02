import { Artwork, type BoardFrame, type Mm, type TextStyle } from "../pcb-art"
import type { BodyShape } from "../types"

/**
 * The Netduino Plus 2 (Rev A) top side, headers along the top and bottom as on an Uno, in
 * millimetres from the board's top-left corner, drawn the way the Open746I-C is: the socket
 * headers with the names printed in their boxes, the connectors, the chips that matter, the
 * crystal, the button and the LEDs, the board's own marks — no passives or small transistors.
 *
 * Sources: the outline, the header pads and the mounting holes are the Arduino Uno R3's (the board
 * file the headers already came from); everything else is measured on Adafruit's top view of the
 * board (product 1104, photo 1104-05), mapped to board millimetres through the three mounting
 * holes and checked on all 32 header sockets (0.4 px RMS, about 0.03 mm, at 13.2 px/mm). The tops
 * of tall parts stand out of the board's plane in that photo, 0.18 % further from its centre per
 * millimetre of height, and are brought back to it. The netduino plus 2 mark is traced from the
 * same photo's silkscreen.
 *
 * Off the board on purpose: the Uno's D8–SCL header stands 0.4 pitch off the 0.1" grid of the
 * other three, so it is drawn 0.4 pitch to the left, where its pins are rounded to, and the hole
 * beside SC moves with it.
 *
 * What emul does not model is under a "soon" badge, in boxes clear of every working pin and part:
 * the network side of the RJ45 (the ENC28J60 runs; nothing is on the wire) and the microSD card.
 * The MiniJTAG header is not modelled either but goes without one: it is narrower than a badge,
 * and the badge would sit against BTN's name, as if the button were the part not modelled.
 */

/** Two cells to the left of the board for the RJ45's overhang; the header pads on whole cells. */
export const FRAME: BoardFrame = { originX: 2 * 2.54, originY: 0, cellsPerMm: 1 / 2.54 }
export const BOARD_MM = { w: 68.58, h: 53.34 }
export const PITCH = 2.54

/** The Uno R3 outline (y down): the chamfered top-right corner, the 45° step out below it and back in at the bottom right. */
export const OUTLINE: readonly Mm[] = [
  { x: 0, y: 0 }, { x: 64.516, y: 0 }, { x: 66.04, y: 1.524 }, { x: 66.04, y: 12.954 }, { x: 68.58, y: 15.494 },
  { x: 68.58, y: 48.26 }, { x: 66.04, y: 50.8 }, { x: 66.04, y: 53.34 }, { x: 0, y: 53.34 },
]

/** Header pad rows (y down) and each header's first pad (x), from the Uno R3 board file. */
export const HEADER = { top: 2.54, bottom: 50.8, high: 18.796, low: 45.72, power: 27.94, analog: 50.8 }
/** The D8–SCL header, and the hole beside SC, drawn 0.4 pitch left: onto the cells its pins are on. */
export const HIGH_SHIFT = -0.4 * PITCH

/** What the silkscreen prints in each header's boxes, left to right ("" for the empty AREF and NC boxes). */
export const SILK = {
  high: ["SC", "SD", "", "GND", "13", "12", "11", "10", "9", "8"],
  low: ["7", "6", "5", "4", "3", "2", "1", "0"],
  power: ["", "IOREF", "/RESET", "3V3", "5V", "GND", "GND", "VIN"],
  analog: ["0", "1", "2", "3", "4", "5"],
} as const

/** Mounting holes (3.2 mm, plated): the Uno's, less the bottom-left one the microSD socket takes. */
export const HOLES: readonly Mm[] = [{ x: 15.24 + HIGH_SHIFT, y: 2.54 }, { x: 66.04, y: 17.78 }, { x: 66.04, y: 45.72 }]
const HOLE_R = 1.6
const RING_R = 1.75

export const SOON = {
  rj45: { from: { x: -2.6, y: 6.1 }, to: { x: 15.2, y: 21.2 }, label: "RJ45 · network side" },
  sd: { from: { x: 11.3, y: 34.9 }, to: { x: 25.7, y: 51.2 }, label: "MicroSD card" },
} as const

/** The netduino plus 2 mark, traced from the top silkscreen in board millimetres; [x, y, x, y, …]. Holes wound the other way. */
const NETDUINO_LOGO: number[][] = [
  [55.64, 12.75, 55.7, 12.85, 55.72, 15.08, 55.65, 15.53, 55.49, 15.85, 55.34, 16.02, 55.13, 16.19, 54.76, 16.33, 54.23, 16.33, 54.06, 16.3, 53.83, 16.19, 53.64, 16.05, 53.47, 15.87, 53.35, 15.67, 53.21, 15.14, 53.3, 14.75, 53.5, 14.39, 53.72, 14.18, 53.95, 14.03, 54.16, 13.96, 54.48, 13.91, 54.92, 13.98, 55.04, 14.08, 55.07, 14.15, 55.08, 14.43, 55.06, 14.49, 54.97, 14.51, 54.69, 14.38, 54.54, 14.36, 54.31, 14.38, 54.14, 14.45, 53.89, 14.65, 53.79, 14.81, 53.75, 14.92, 53.73, 15.18, 53.76, 15.4, 53.91, 15.64, 54.1, 15.78, 54.32, 15.88, 54.7, 15.88, 55.05, 15.68, 55.19, 15.41, 55.26, 15.09, 55.29, 12.87, 55.32, 12.78, 55.39, 12.74],
  [58.66, 13.03, 58.77, 13.08, 58.88, 13.2, 58.91, 13.3, 58.9, 13.43, 58.81, 13.56, 58.62, 13.65, 58.37, 13.58, 58.27, 13.35, 58.32, 13.18, 58.54, 13.03],
  [52.18, 13.31, 52.27, 13.37, 52.33, 13.56, 52.3, 13.84, 52.35, 13.9, 53.01, 13.93, 53.08, 13.97, 53.12, 14.03, 53.13, 14.24, 53.06, 14.33, 52.38, 14.36, 52.32, 14.38, 52.3, 14.48, 52.32, 15.78, 52.38, 15.85, 52.47, 15.88, 52.96, 15.88, 53.08, 15.92, 53.13, 16.01, 53.13, 16.24, 53.1, 16.31, 53.04, 16.36, 52.49, 16.37, 52.19, 16.29, 52.02, 16.16, 51.89, 15.95, 51.85, 15.74, 51.84, 13.93, 51.85, 13.4, 51.88, 13.35, 51.95, 13.3],
  [56.33, 13.91, 56.41, 14.01, 56.45, 15.53, 56.68, 15.8, 56.95, 15.89, 57.14, 15.88, 57.29, 15.82, 57.44, 15.68, 57.52, 15.52, 57.57, 13.97, 57.63, 13.92, 57.88, 13.91, 57.96, 13.92, 58, 13.97, 58.02, 15.5, 57.95, 15.73, 57.8, 15.99, 57.36, 16.35, 56.93, 16.36, 56.64, 16.31, 56.42, 16.2, 56.27, 16.08, 56.16, 15.97, 56.03, 15.74, 55.94, 15.3, 55.94, 14.34, 55.98, 14.02, 56.03, 13.94, 56.1, 13.91],
  [58.69, 13.92, 58.8, 13.98, 58.83, 15.09, 58.84, 15.15, 58.91, 15.17, 58.94, 15.22, 58.93, 15.29, 58.85, 15.35, 58.82, 15.43, 58.83, 16.28, 58.78, 16.35, 58.68, 16.4, 58.4, 16.35, 58.33, 16.28, 58.34, 14.18, 58.37, 13.99, 58.45, 13.92],
  [60.41, 13.94, 60.64, 14.03, 60.92, 14.21, 61.05, 14.36, 61.15, 14.55, 61.23, 14.93, 61.23, 15.34, 61.23, 16.23, 61.21, 16.31, 61.16, 16.36, 60.87, 16.37, 60.76, 16.3, 60.72, 14.78, 60.56, 14.53, 60.43, 14.43, 60.22, 14.35, 59.9, 14.45, 59.79, 14.55, 59.65, 14.73, 59.62, 16.3, 59.55, 16.35, 59.42, 16.37, 59.23, 16.36, 59.15, 16.3, 59.14, 15, 59.23, 14.54, 59.39, 14.3, 59.54, 14.15, 59.73, 14.02, 60.01, 13.92],
  [62.98, 13.95, 63.24, 14.04, 63.47, 14.18, 63.62, 14.33, 63.76, 14.51, 63.85, 14.75, 63.92, 15.19, 63.87, 15.49, 63.79, 15.69, 63.62, 15.96, 63.48, 16.09, 63.27, 16.23, 63.1, 16.3, 62.63, 16.39, 62.29, 16.31, 62.03, 16.18, 61.82, 16.01, 61.59, 15.73, 61.48, 15.4, 61.45, 15.19, 61.47, 14.89, 61.69, 14.42, 61.83, 14.26, 62.03, 14.1, 62.37, 13.95],
  [48.1, 13.9, 48.38, 14.01, 48.72, 14.26, 48.87, 14.5, 48.97, 14.99, 48.97, 16.22, 48.94, 16.29, 48.88, 16.33, 48.62, 16.34, 48.51, 16.27, 48.48, 15.8, 48.49, 14.99, 48.45, 14.73, 48.38, 14.59, 48.19, 14.41, 47.94, 14.37, 47.74, 14.39, 47.55, 14.5, 47.38, 14.74, 47.35, 16.25, 47.28, 16.32, 47.16, 16.34, 46.99, 16.32, 46.92, 16.26, 46.9, 15, 46.98, 14.55, 47.09, 14.34, 47.34, 14.1, 47.49, 14, 47.78, 13.91],
  [50.68, 13.92, 51.02, 14.04, 51.47, 14.4, 51.57, 14.65, 51.54, 14.8, 51.4, 14.9, 50.89, 15.14, 50.51, 15.37, 50.21, 15.48, 50.11, 15.46, 50.01, 15.34, 49.94, 15.2, 49.95, 15.11, 50.85, 14.62, 50.89, 14.59, 50.88, 14.53, 50.74, 14.43, 50.49, 14.35, 50.38, 14.35, 50, 14.49, 49.76, 14.74, 49.68, 14.96, 49.69, 15.28, 49.72, 15.41, 49.87, 15.64, 50.21, 15.85, 50.45, 15.9, 50.75, 15.83, 50.91, 15.74, 51.21, 15.41, 51.45, 15.45, 51.54, 15.51, 51.53, 15.68, 51.29, 16.02, 50.92, 16.27, 50.6, 16.36, 50.22, 16.35, 49.94, 16.27, 49.72, 16.15, 49.41, 15.81, 49.3, 15.63, 49.2, 15.32, 49.21, 14.92, 49.28, 14.67, 49.43, 14.41, 49.8, 14.09, 49.95, 14, 50.21, 13.92],
  [62.36, 14.46, 62.15, 14.59, 61.97, 14.9, 61.92, 15.1, 61.93, 15.25, 62.04, 15.54, 62.2, 15.73, 62.48, 15.87, 62.82, 15.89, 63.1, 15.79, 63.33, 15.56, 63.43, 15.3, 63.44, 14.98, 63.31, 14.71, 63.1, 14.5, 62.83, 14.39, 62.57, 14.39],
  [62.23, 16.88, 62.31, 16.91, 62.34, 16.99, 62.32, 17.08, 62.17, 17.2, 62.16, 17.78, 62.12, 17.87, 62.04, 17.91, 61.96, 17.89, 61.91, 17.78, 61.91, 17.2, 61.69, 17.04, 61.72, 16.95, 61.89, 16.87],
  [62.65, 16.95, 62.8, 17.24, 62.84, 17.22, 63.03, 16.93, 63.1, 16.91, 63.15, 16.95, 63.17, 17.73, 63.15, 17.84, 63.1, 17.89, 63, 17.88, 62.89, 17.75, 62.68, 17.77, 62.57, 17.89, 62.47, 17.85, 62.45, 17.74, 62.45, 17.07, 62.47, 16.95, 62.53, 16.91],
  [60.42, 16.92, 60.65, 16.97, 60.91, 17.1, 61.13, 17.29, 61.33, 17.55, 61.43, 17.78, 61.46, 18.06, 61.45, 18.38, 61.42, 18.53, 61.33, 18.72, 61.07, 19.06, 60.62, 19.4, 60.5, 19.53, 60.02, 19.86, 59.82, 20.03, 59.8, 20.09, 59.88, 20.11, 61.37, 20.14, 61.45, 20.19, 61.48, 20.27, 61.49, 20.49, 61.43, 20.55, 60.56, 20.56, 60.35, 20.59, 60.14, 20.56, 59.31, 20.55, 59.08, 20.49, 59.02, 20.43, 59.05, 20.12, 59.1, 20.03, 60.75, 18.72, 60.88, 18.55, 60.99, 18.34, 61, 18.02, 60.89, 17.73, 60.62, 17.47, 60.3, 17.37, 60.06, 17.4, 59.78, 17.53, 59.7, 17.69, 59.59, 17.77, 59.47, 18.07, 59.41, 18.13, 59.19, 18.18, 59.04, 18.09, 59.02, 17.94, 59.08, 17.69, 59.15, 17.54, 59.34, 17.3, 59.76, 17.02, 59.98, 16.94, 60.15, 16.92],
  [52.49, 16.94, 52.57, 17.04, 52.58, 18.19, 52.57, 20.44, 52.51, 20.53, 52.32, 20.56, 52.16, 20.49, 52.12, 20.34, 52.11, 19.15, 52.08, 18.97, 52.12, 18.38, 52.13, 17.04, 52.17, 16.98, 52.3, 16.93],
  [53.2, 18.11, 53.27, 18.2, 53.29, 19.52, 53.36, 19.78, 53.57, 20.02, 53.89, 20.08, 54.06, 20.05, 54.18, 19.99, 54.28, 19.88, 54.39, 19.67, 54.42, 18.18, 54.47, 18.13, 54.56, 18.11, 54.75, 18.12, 54.82, 18.17, 54.89, 18.52, 54.85, 19.73, 54.82, 19.9, 54.52, 20.33, 54.53, 20.39, 54.64, 20.43, 54.61, 20.48, 54.36, 20.49, 53.74, 20.61, 53.53, 20.5, 53.34, 20.45, 52.99, 20.14, 52.88, 19.93, 52.79, 19.52, 52.8, 18.25, 52.83, 18.14, 52.9, 18.1],
  [50.78, 18.11, 51.08, 18.18, 51.52, 18.44, 51.73, 18.76, 51.84, 19.02, 51.87, 19.4, 51.84, 19.61, 51.74, 19.89, 51.61, 20.08, 51.4, 20.29, 51.21, 20.41, 50.87, 20.54, 50.57, 20.54, 50.23, 20.5, 50.09, 20.42, 50.04, 20.35, 50.04, 20.09, 50.1, 19.97, 50.19, 19.95, 50.51, 20.09, 50.66, 20.11, 50.85, 20.09, 51, 20.03, 51.19, 19.89, 51.31, 19.72, 51.42, 19.3, 51.28, 18.92, 51.12, 18.74, 50.91, 18.61, 50.63, 18.57, 50.42, 18.58, 50.12, 18.75, 49.92, 19.05, 49.89, 19.3, 49.87, 21.67, 49.83, 21.73, 49.75, 21.76, 49.5, 21.76, 49.41, 21.67, 49.39, 21.39, 49.39, 19.26, 49.45, 18.92, 49.55, 18.71, 49.72, 18.48, 49.88, 18.34, 50.18, 18.21, 50.57, 18.11],
  [56.92, 18.13, 57.07, 18.15, 57.13, 18.19, 57.16, 18.27, 57.15, 18.46, 57.07, 18.55, 55.73, 18.56, 55.62, 18.63, 55.57, 18.77, 55.61, 18.89, 55.73, 18.99, 56.71, 19.23, 56.97, 19.36, 57.11, 19.55, 57.16, 19.66, 57.15, 20.1, 57.02, 20.36, 57.04, 20.4, 57.18, 20.42, 57.18, 20.46, 56.31, 20.58, 55.23, 20.57, 55.16, 20.54, 55.08, 20.47, 55.07, 20.41, 55.13, 20.18, 55.2, 20.1, 56.54, 20.08, 56.65, 20.04, 56.71, 19.95, 56.69, 19.81, 56.59, 19.7, 55.5, 19.42, 55.31, 19.3, 55.17, 19.13, 55.11, 18.85, 55.16, 18.49, 55.33, 18.27, 55.6, 18.13],
]

const pairs = (flat: number[]): Mm[] => Array.from({ length: flat.length / 2 }, (_, i) => ({ x: flat[i * 2], y: flat[i * 2 + 1] }))
const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i * PITCH)

const NAME: TextStyle = { size: 0.55, mono: true }
const named = (style: TextStyle, extra: Partial<TextStyle>): TextStyle => ({ ...style, ...extra })
const caption = (size: number, extra: Partial<TextStyle> = {}): TextStyle => ({ size, muted: true, ...extra })

/** Names under the top sockets end 1.69 mm below the row; over the bottom ones they start 1.75 mm above it. */
const NAME_TOP = HEADER.top + 1.69
const NAME_BOTTOM = HEADER.bottom - 1.75

function soon(region: { from: Mm; to: Mm; label: string }, draw: (a: Artwork) => void): BodyShape {
  const a = new Artwork(FRAME)
  draw(a)
  const x = a.cellX(region.from.x)
  const y = a.cellY(region.from.y)
  return { type: "soon", x, y, w: a.cellX(region.to.x) - x, h: a.cellY(region.to.y) - y, label: region.label, body: a.shapes() }
}

/** A quad flat pack's leads as one band round the body, clear of the corners. */
function leads(a: Artwork, x: number, y: number, tip: number, span: number) {
  const h = span / 2
  a.polygon("zone", [
    { x: x - h, y: y - tip }, { x: x + h, y: y - tip }, { x: x + h, y: y - h }, { x: x + tip, y: y - h },
    { x: x + tip, y: y + h }, { x: x + h, y: y + h }, { x: x + h, y: y + tip }, { x: x - h, y: y + tip },
    { x: x - h, y: y + h }, { x: x - tip, y: y + h }, { x: x - tip, y: y - h }, { x: x - h, y: y - h },
  ])
}

/** Points round a circle, clockwise on the field (y down) from `from` to `to` degrees. */
function arc(c: Mm, r: number, from = 0, to = 360, steps = 32): Mm[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = ((from + ((to - from) * i) / steps) * Math.PI) / 180
    return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }
  })
}

/** A socket header: its housing over the row, the printed boxes on the board side, the names in them. */
function socketRow(art: Artwork, names: readonly string[], firstX: number, rowY: number, side: "top" | "bottom", boxEdge: (i: number) => number) {
  const xs = rows(firstX, names.length)
  const half = PITCH / 2
  art.rect("connector", xs[0] - half, rowY - half, xs[xs.length - 1] + half, rowY + half, 0.15)
  const base = side === "top" ? rowY + half : rowY - half
  const deeper = (a: number, b: number) => (side === "top" ? Math.max(a, b) : Math.min(a, b))
  // Each box: its left side from the housing out (as deep as the deeper of it and the box before),
  // its far edge, and the last box's right side.
  xs.forEach((x, i) => {
    const far = boxEdge(i)
    art.line([{ x: x - half, y: base }, { x: x - half, y: i === 0 ? far : deeper(far, boxEdge(i - 1)) }])
    art.line([{ x: x - half, y: far }, { x: x + half, y: far }])
    if (i === xs.length - 1) art.line([{ x: x + half, y: base }, { x: x + half, y: far }])
  })
  const at = side === "top" ? NAME_TOP : NAME_BOTTOM
  const anchor = side === "top" ? "end" : "start"
  const group = art.grouped()
  names.forEach((name, i) => {
    if (name) group.text(name, xs[i], at, named(NAME, { anchor, rotate: -90 }))
  })
}

/** The DC jack's polarity mark: − ring, the C with its centre dot, + ring. */
function polarity(a: Artwork, y: number) {
  const r = 0.55
  const minus = { x: 1.98, y }
  const centre = { x: 3.96, y }
  const plus = { x: 5.94, y }
  a.line(arc(minus, r)).line([{ x: minus.x - 0.3, y }, { x: minus.x + 0.3, y }])
  a.line([{ x: minus.x + r, y }, { x: centre.x - r, y }])
  a.line(arc(centre, r, 45, 315)).circle("mark", centre.x, centre.y, 0.17)
  a.line([{ x: centre.x, y }, { x: plus.x - r, y }])
  a.line(arc(plus, r)).line([{ x: plus.x - 0.3, y }, { x: plus.x + 0.3, y }]).line([{ x: plus.x, y: y - 0.3 }, { x: plus.x, y: y + 0.3 }])
}

export function boardArt(): BodyShape[] {
  const art = new Artwork(FRAME)

  // --- The four socket headers (blue on the board), their boxes and names as printed.
  const TOP_BOX = HEADER.top + 3.75
  const GND_BOX = HEADER.top + 4.95
  socketRow(art.moved({ x: HIGH_SHIFT, y: 0 }), SILK.high, HEADER.high, HEADER.top, "top", (i) => (SILK.high[i] === "GND" ? GND_BOX : TOP_BOX))
  socketRow(art, SILK.low, HEADER.low, HEADER.top, "top", () => TOP_BOX)
  socketRow(art, SILK.power, HEADER.power, HEADER.bottom, "bottom", (i) => (i < 3 ? 42.6 : 45.75))
  socketRow(art, SILK.analog, HEADER.analog, HEADER.bottom, "bottom", () => 47.0)
  art.text("Digital I/O", 44.1, 7.5, caption(0.65))
  art.text("Power", 38.9, 44.75, caption(0.5))
  art.text("Analog In", 57.15, 45.75, caption(0.66))

  // --- The mounting holes' plated rings (the plate has the holes).
  for (const h of HOLES) art.circle("connector", h.x, h.y, RING_R).polygon("connector", arc(h, HOLE_R))

  // --- ACT (the ENC28J60's LEDB) and the Pulse HX1198NL magnetics, 16 leads at 1.27 mm.
  art.text("ACT", 2.65, 1.5, caption(0.4))
  art.rect("zone", 18.7, 11.2, 27.2, 21.1)
  art.rect("chip", 19.6, 10.0, 26.3, 22.3, 0.3)
  art.text("HX1198NL", 22.4, 16.15, { size: 0.4, inverse: true, rotate: 90 }).text("Pulse", 24.4, 16.15, { size: 0.4, inverse: true, rotate: 90 })

  // --- U5 ENC28J60 (SSOP-28, 10.2 × 5.3 mm, turned 180°: pin 1 at the top right).
  const enc = { x: 37.85, y: 13.5 }
  art.rect("zone", enc.x - 4.4, enc.y - 3.9, enc.x + 4.4, enc.y + 3.9)
  art.rect("chip", enc.x - 5.1, enc.y - 2.65, enc.x + 5.1, enc.y + 2.65, 0.2)
  art.circle("board", enc.x + 4.35, enc.y - 1.9, 0.3)
  art.text("ENC28J60", enc.x - 0.4, enc.y + 0.1, { size: 0.42, inverse: true })
  art.text("LED", 59.9, 7.7, caption(0.5))

  // --- The netduino plus 2 mark.
  for (const outline of NETDUINO_LOGO) art.polygon("mark", pairs(outline))

  // --- U1 STM32F405RGT6 (LQFP64, 10 mm body, 12 mm over the leads, pin 1 at the bottom left).
  const mcu = { x: 41.875, y: 31.25 }
  leads(art, mcu.x, mcu.y, 6, 8.1)
  art.rect("chip", mcu.x - 5, mcu.y - 5, mcu.x + 5, mcu.y + 5, 0.2)
  art.circle("board", mcu.x - 3.85, mcu.y + 3.85, 0.4)
  art.text("STM32F405RGT6", mcu.x, mcu.y - 0.5, { size: 0.4, inverse: true }).text("ARM · 168 MHz", mcu.x, mcu.y + 1.1, { size: 0.3, inverse: true })

  // --- Y1, the 25 MHz crystal the ENC28J60 also runs from (MCO1).
  art.rect("connector", 36.3, 39.45, 41.3, 42.65, 0.35)
  art.text("25.000", 38.8, 41.05, { size: 0.32 })

  // --- U2 MC33269DT-5.0 (DPAK): leads to the left, the tab to the right.
  art.rect("connector", 14.6, 26.95, 17.3, 27.85, 0.1).rect("connector", 14.6, 31.35, 17.3, 32.25, 0.1)
  art.rect("connector", 23.8, 27.2, 25.6, 32.3, 0.2)
  art.rect("chip", 17.3, 26.6, 23.8, 32.9, 0.25)
  art.text("MC33269", 20.55, 29.75, { size: 0.3, inverse: true })

  // --- The micro-B USB shell (the USB part draws the receptacle) and PWR.
  art.rect("connector", -1.45, 26.75, 4.45, 34.65, 0.4)
  art.text("PWR", 9.45, 30.6, caption(0.48))

  // --- The DC jack, 1.8 mm over the left edge, with its polarity and rating.
  art.rect("chip", -1.8, 41.65, 10.2, 48.55, 0.4)
  polarity(art, 49.7)
  art.text("7.5-9.0V", 4.1, 51.75, caption(0.5))
  art.text("MicroSD", 18.6, 52.1, caption(0.5))

  // --- BTN, a 6 × 6 mm switch (the part draws the cap): BOOT0, PB11 and PC14.
  art.rect("connector", 52.4, 23.2, 58.55, 29.4, 0.3)
  art.text("BTN", 60.25, 26.4, caption(0.53))

  // --- The MiniJTAG header (2 × 5 at 1.27 mm) in its printed box.
  art.outline(63.25, 22.6, 66.9, 29.5, 0.1)
  for (const x of [64.5, 65.9]) for (let i = 0; i < 5; i++) art.circle("connector", x, 23.55 + i * 1.27, 0.42)

  // --- The board's own marks.
  art.text("www.netduino.com", 54.4, 40.85, caption(0.9))
  art.text("REV.A", 66.0, 43.05, caption(0.45))

  // --- What emul does not model, each under its soon badge.
  const rj45 = soon(SOON.rj45, (a) => {
    a.rect("chip", -2.3, 6.4, 14.9, 20.9, 0.4)
    a.rect("zone", -2.3, 9.9, 0.6, 17.4, 0.2)
  })
  const sd = soon(SOON.sd, (a) => {
    a.rect("connector", 11.5, 35.1, 25.5, 51.1, 0.4)
    a.rect("zone", 13.2, 49.4, 23.8, 51.1, 0.2)
  })

  // The plate: the Uno outline with its holes cut through (wound the other way).
  const plate = new Artwork(FRAME)
  plate.polygon("board", OUTLINE, 0.25)
  for (const h of HOLES) plate.polygon("board", arc(h, HOLE_R).reverse())
  return [...plate.shapes(), ...art.shapes(), rj45, sd]
}
