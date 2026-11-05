import { Artwork, type BoardFrame, type Mm, type TextStyle } from "../pcb-art"
import type { BodyShape } from "../types"

/**
 * The Netduino Plus 2 (Rev A) top side, headers along the top and bottom as on an Uno, in
 * millimetres from the board's top-left corner, drawn the way the Open746I-C is: the socket
 * headers with the names printed in their boxes, the connectors, the chips, the crystal, the button
 * and the LEDs, the board's own marks and, quieter, every small SMD part — and, as there, no
 * mounting holes. The sockets and the boxes round their names have its rounded corners, one box
 * to a header with no rules between the names.
 *
 * Sources: the outline and the header pads are the Arduino Uno R3's (the board file the headers
 * already came from); everything else is measured on Adafruit's top view of the board (product
 * 1104, photo 1104-05), mapped to board millimetres through the board's three mounting holes and
 * checked on all 32 header sockets (0.4 px RMS, about 0.03 mm, at 13.2 px/mm). The tops of tall
 * parts stand out of the board's plane in that photo, 0.18 % further from its centre per
 * millimetre of height, and are brought back to it. The netduino plus 2 mark is set in type where
 * the photo has it.
 *
 * Off the board on purpose: the Uno's D8–SCL header stands 0.4 pitch off the 0.1" grid of the
 * other three, so it is drawn 0.4 pitch to the left, where its pins are rounded to.
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
/** The D8–SCL header drawn 0.4 pitch left: onto the cells its pins are on. */
export const HIGH_SHIFT = -0.4 * PITCH

/** What the silkscreen prints in each header's boxes, left to right ("" for the empty AREF and NC boxes). */
export const SILK = {
  high: ["SC", "SD", "", "GND", "13", "12", "11", "10", "9", "8"],
  low: ["7", "6", "5", "4", "3", "2", "1", "0"],
  power: ["", "IOREF", "/RESET", "3V3", "5V", "GND", "GND", "VIN"],
  analog: ["0", "1", "2", "3", "4", "5"],
} as const

export const SOON = {
  rj45: { from: { x: -2.6, y: 6.1 }, to: { x: 15.2, y: 21.2 }, label: "RJ45 · network side" },
  sd: { from: { x: 11.3, y: 34.9 }, to: { x: 25.7, y: 51.2 }, label: "MicroSD card" },
} as const

/** Corner radii as the Open746I-C draws them: its socket housings', and its pin boxes' and name tables'. */
export const SOCKET_CORNER = 0.3
export const BOX_CORNER = 0.6

/**
 * The netduino plus 2 mark, set in the field's sans (Geist) so it stays smooth at any zoom: sized so
 * "netduino" is as wide as the board's (46.9–63.9 mm, 3.9 em of Geist), each line on the board's
 * baseline for it and starting where its first letter does. The field sets type on its middle,
 * 0.273 em over the baseline, and Geist's n and p stand 0.07 em in from where a line starts. The ™
 * is the type's own. The two lines are one label: they grow together, from the middle of the mark.
 */
const MARK_SIZE = 1.72
const markLine = (text: string, left: number, baseline: number) => ({ text, x: left - 0.07 * MARK_SIZE * PITCH, y: baseline - 0.273 * MARK_SIZE * PITCH })
export const MARK = { lines: [markLine("netduino", 46.9, 16.35), markLine("plus 2™", 49.39, 20.55)], centre: { x: 55.9, y: 17.25 } }

/** Package bodies (mm): length between the terminals, width; the terminals' share of the length. */
const TWO_TERMINAL = { "0402": { l: 1.0, w: 0.5 }, "0603": { l: 1.6, w: 0.8 }, "0805": { l: 2.0, w: 1.25 }, "1206": { l: 3.2, w: 1.6 } } as const
const TERMINAL_SHARE = 0.22
/** SOT-23, SOT-23-5 and SC-70-6 (SOT-363): body along the lead rows and across them, lead tip to lead tip, pitch, lead width. */
const SOT = {
  sot23: { along: 2.9, across: 1.3, reach: 2.4, pitch: 0.95, lead: 0.4 },
  "sot23-5": { along: 2.9, across: 1.6, reach: 2.8, pitch: 0.95, lead: 0.4 },
  sot363: { along: 2.0, across: 1.25, reach: 2.1, pitch: 0.65, lead: 0.3 },
} as const

/**
 * Every small SMD part on the top side, measured on the original of Adafruit's top view (4049 ×
 * 3114 px, 44.7 px/mm; the copy above is it scaled to 1200 px wide and cropped 11 px at the top):
 * each part's terminals or leads found in the photo, its centre between them. Drawn in the quiet
 * zone fill, a step below the connectors, so the parts that work stand out.
 *
 * Two-terminal parts: [package, centre x, centre y, "h" (terminals left and right) or "v"].
 */
export const PASSIVES: readonly [keyof typeof TWO_TERMINAL, number, number, "h" | "v"][] = [
  // By ACT: the ENC28J60's LED and magnetics resistors.
  ["0603", 5.25, 2.58, "h"], ["0603", 7.51, 2.58, "h"], ["0603", 9.74, 2.58, "h"], ["0603", 5.25, 4.07, "h"], ["0603", 7.51, 4.07, "h"], ["0603", 9.74, 4.07, "h"],
  // Round the Pulse magnetics and the ENC28J60 (the 1206 over the magnetics 0.25 mm lower, clear of the names' boxes).
  ["1206", 21.4, 8.3, "h"], ["0603", 29.75, 11.13, "h"], ["0603", 29.75, 12.38, "h"], ["0603", 29.75, 13.61, "h"], ["0603", 29.75, 14.95, "h"],
  ["0603", 30.0, 18.14, "h"], ["0603", 30.0, 19.53, "h"], ["0603", 30.0, 20.72, "h"], ["0603", 31.88, 16.49, "v"], ["0402", 34.64, 8.11, "h"],
  ["1206", 44.26, 11.07, "v"], ["1206", 44.26, 15.83, "v"], ["0603", 35.3, 18.73, "h"], ["0603", 37.35, 18.73, "h"], ["0603", 40.25, 18.73, "h"], ["0603", 42.43, 18.73, "h"],
  ["1206", 45.6, 20.6, "h"], ["1206", 45.6, 22.94, "h"], ["0805", 36.3, 22.6, "h"], ["0402", 39.79, 22.62, "h"], ["0402", 39.79, 24.03, "h"], ["0603", 41.45, 22.03, "v"],
  ["0603", 57.73, 10.8, "v"],
  // USB and power in: the fuse (F), the ferrites, PWR's resistor, the regulators' capacitors.
  ["1206", 3.29, 22.93, "h"], ["0603", 6.54, 26.06, "v"], ["0603", 6.54, 29.22, "v"], ["0603", 6.54, 31.0, "v"], ["0603", 7.05, 32.54, "h"], ["0603", 7.05, 33.51, "h"], ["0603", 7.05, 34.5, "h"],
  ["0603", 10.98, 32.62, "v"], ["1206", 12.66, 29.46, "v"], ["0603", 13.48, 33.74, "h"], ["0603", 4.19, 36.0, "v"], ["0603", 5.45, 36.0, "v"], ["0603", 6.75, 36.0, "v"],
  ["1206", 15.49, 24.92, "h"], ["1206", 19.64, 24.86, "h"], ["0603", 16.92, 33.81, "h"],
  // Left of and under the STM32F405.
  ["0603", 35.03, 25.28, "v"], ["1206", 28.7, 25.73, "h"], ["1206", 28.7, 28.17, "h"], ["0603", 27.22, 33.78, "h"], ["0603", 29.24, 33.78, "h"], ["1206", 28.9, 35.87, "h"], ["1206", 28.9, 38.27, "h"],
  ["0603", 34.38, 34.72, "v"], ["0603", 34.41, 37.46, "h"], ["0402", 30.76, 41.48, "h"], ["0402", 33.48, 41.48, "h"],
  ["0603", 40.23, 38.29, "h"], ["0603", 44.95, 38.3, "h"], ["0603", 44.64, 39.27, "h"], ["0603", 37.05, 43.3, "h"], ["0603", 40.52, 43.3, "h"], ["0603", 54.0, 43.79, "h"],
  // Right of it.
  ["0603", 48.92, 26.32, "v"], ["0805", 50.63, 30.91, "h"], ["0603", 49.07, 34.03, "v"], ["1206", 51.25, 37.57, "h"], ["1206", 62.92, 38.12, "h"],
]

/**
 * Transistors and small regulators: [package, centre x, centre y, "v" (leads left and right) or
 * "h" (leads above and below), leads on the first side, leads on the second, in pitches from the
 * middle].
 */
export const LEADED: readonly (readonly [keyof typeof SOT, number, number, "h" | "v", readonly number[], readonly number[]])[] = [
  ["sot23", 11.0, 25.95, "v", [0], [-1, 1]],
  ["sot23", 32.75, 38.9, "v", [-1, 1], [0]],
  ["sot23-5", 9.4, 37.5, "h", [-1, 1], [-1, 0, 1]],
  ["sot23-5", 28.42, 31.24, "v", [-1, 1], [-1, 0, 1]],
  ...([[32.7, 24.63], [33.1, 28.03], [27.5, 40.7], [53.47, 33.62], [56.74, 33.79], [56.75, 37.54], [45.34, 43.62], [50.27, 43.8]] as const).map(
    ([x, y]) => ["sot363", x, y, "v", [-1, 0, 1], [-1, 0, 1]] as const,
  ),
]

/** The SS15 Schottky (SMA) by the DC jack, its cathode band to the right; the shielded inductor left of the STM32F405; the "100R10" part right of it. */
export const LARGER = {
  ss15: { x: 4.05, y: 38.63 },
  inductor: { x: 32.6, y: 31.6, size: 3.3 },
  r100: { x: 63.3, y: 34.45, l: 7.2, w: 3.4 },
} as const

function smdParts(a: Artwork) {
  for (const [pkg, x, y, axis] of PASSIVES) {
    const { l, w } = TWO_TERMINAL[pkg]
    const [hx, hy] = axis === "h" ? [l / 2, w / 2] : [w / 2, l / 2]
    a.rect("zone", x - hx, y - hy, x + hx, y + hy, 0.08)
    const cap = l / 2 - l * TERMINAL_SHARE
    for (const s of [-1, 1]) a.line(axis === "h" ? [{ x: x + s * cap, y: y - hy }, { x: x + s * cap, y: y + hy }] : [{ x: x - hx, y: y + s * cap }, { x: x + hx, y: y + s * cap }])
  }
  // Leads stop a hair short of their body: shapes that only touch stay apart once rounded to the field's grid.
  const gap = 0.05
  for (const [pkg, x, y, axis, first, second] of LEADED) {
    const { along, across, reach, pitch, lead } = SOT[pkg]
    const [bx, by] = axis === "v" ? [across / 2, along / 2] : [along / 2, across / 2]
    a.rect("zone", x - bx, y - by, x + bx, y + by, 0.1)
    for (const [side, offsets] of [[-1, first], [1, second]] as const)
      for (const k of offsets) {
        const at = k * pitch
        if (axis === "v") a.rect("zone", side < 0 ? x - reach / 2 : x + bx + gap, y + at - lead / 2, side < 0 ? x - bx - gap : x + reach / 2, y + at + lead / 2)
        else a.rect("zone", x + at - lead / 2, side < 0 ? y - reach / 2 : y + by + gap, x + at + lead / 2, side < 0 ? y - by - gap : y + reach / 2)
      }
  }
  // SS15: the body, a lead out of each end, the cathode band.
  const d = LARGER.ss15
  a.rect("zone", d.x - 2.15, d.y - 1.3, d.x + 2.15, d.y + 1.3, 0.15)
  a.rect("zone", d.x - 2.6, d.y - 0.75, d.x - 2.15 - gap, d.y + 0.75).rect("zone", d.x + 2.15 + gap, d.y - 0.75, d.x + 2.6, d.y + 0.75)
  a.line([{ x: d.x + 1.45, y: d.y - 1.3 }, { x: d.x + 1.45, y: d.y + 1.3 }])
  const ind = LARGER.inductor
  a.rect("zone", ind.x - ind.size / 2, ind.y - ind.size / 2, ind.x + ind.size / 2, ind.y + ind.size / 2, 0.35)
  const r = LARGER.r100
  a.rect("zone", r.x - r.l / 2, r.y - r.w / 2, r.x + r.l / 2, r.y + r.w / 2, 0.2)
  for (const s of [-1, 1]) a.line([{ x: r.x + s * (r.l / 2 - 0.6), y: r.y - r.w / 2 }, { x: r.x + s * (r.l / 2 - 0.6), y: r.y + r.w / 2 }])
}

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

/**
 * A socket header: its housing over the row; on the board side one rounded outline round all its
 * names, stepping out where a name needs more room, and no rules between the names; the names in it.
 */
function socketRow(art: Artwork, names: readonly string[], firstX: number, rowY: number, side: "top" | "bottom", boxEdge: (i: number) => number) {
  const xs = rows(firstX, names.length)
  const half = PITCH / 2
  const last = xs.length - 1
  art.rect("connector", xs[0] - half, rowY - half, xs[last] + half, rowY + half, SOCKET_CORNER)
  const base = side === "top" ? rowY + half : rowY - half
  const far = xs.map((_, i) => boxEdge(i))
  const outline: Mm[] = [{ x: xs[0] - half, y: base }, { x: xs[last] + half, y: base }, { x: xs[last] + half, y: far[last] }]
  for (let i = last; i > 0; i--) if (far[i] !== far[i - 1]) outline.push({ x: xs[i] - half, y: far[i] }, { x: xs[i] - half, y: far[i - 1] })
  outline.push({ x: xs[0] - half, y: far[0] })
  art.polygon("none", outline, BOX_CORNER)
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

  // --- The four socket headers (blue on the board), the box round their names and the names as
  // printed. The boxes along the top are one depth, room for GND's name (on the board GND's alone
  // runs deeper).
  const TOP_BOX = HEADER.top + 4.71
  socketRow(art.moved({ x: HIGH_SHIFT, y: 0 }), SILK.high, HEADER.high, HEADER.top, "top", () => TOP_BOX)
  socketRow(art, SILK.low, HEADER.low, HEADER.top, "top", () => TOP_BOX)
  socketRow(art, SILK.power, HEADER.power, HEADER.bottom, "bottom", (i) => (i < 3 ? 42.6 : 45.75))
  socketRow(art, SILK.analog, HEADER.analog, HEADER.bottom, "bottom", () => 47.0)
  art.text("Digital I/O", 44.1, 8.35, caption(0.6))
  art.text("Power", 38.9, 44.75, caption(0.5))
  art.text("Analog In", 57.15, 45.75, caption(0.66))

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
  art.text("LED", 59.9, 8.25, caption(0.5))

  // --- The netduino plus 2 mark.
  const mark = art.grouped()
  for (const line of MARK.lines) mark.text(line.text, line.x, line.y, caption(MARK_SIZE, { anchor: "start", growsFrom: MARK.centre }))

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
  art.outline(63.25, 22.6, 66.9, 29.5, BOX_CORNER)
  for (const x of [64.5, 65.9]) for (let i = 0; i < 5; i++) art.circle("connector", x, 23.55 + i * 1.27, 0.42)

  // --- The small SMD parts, quiet.
  smdParts(art)

  // --- The board's own marks (the URL and REV.A a little lower than printed, clear of the 0603 above the URL).
  art.text("www.netduino.com", 54.4, 41.1, caption(0.9))
  art.text("REV.A", 66.0, 43.35, caption(0.45))

  // --- What emul does not model, each under its soon badge.
  const rj45 = soon(SOON.rj45, (a) => {
    a.rect("chip", -2.3, 6.4, 14.9, 20.9, 0.4)
    a.rect("zone", -2.3, 9.9, 0.6, 17.4, 0.2)
  })
  const sd = soon(SOON.sd, (a) => {
    a.rect("connector", 11.5, 35.1, 25.5, 51.1, 0.4)
    a.rect("zone", 13.2, 49.4, 23.8, 51.1, 0.2)
  })

  // The plate: the Uno outline.
  const plate = new Artwork(FRAME)
  plate.polygon("board", OUTLINE, 0.25)
  return [...plate.shapes(), ...art.shapes(), rj45, sd]
}
