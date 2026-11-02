import { Artwork, type BoardFrame, type Mm, type TextStyle } from "../pcb-art"
import type { BodyShape } from "../types"

/**
 * The MB997's top side (USB CN1 up), in millimetres, drawn the way the Open746I-C is: the
 * headers with their printed names, the connectors, the chips that matter, the crystals,
 * buttons and LEDs, the board's own titles and marks — no passives, small transistors or
 * reference designators. Positions from the rev-E top silkscreen (SCH-E p8, docs/stm32f4-discovery);
 * where the user's MB997A differs (UM1472 Fig. 1, the user's photo): the ESD sign above the ST
 * logo, MB997A instead of MB997E, no STM32F407G-DISC1 title, and a 3 × 5 mm LIS302DL as U5.
 *
 * What emul does not model (the ST-LINK/V2 with its SWD header, CN3 and LD1; USB OTG on CN5 with
 * LD7) is drawn under a "soon" badge, in boxes that keep clear of every working part.
 */

export const FRAME: BoardFrame = { originX: 0.508 * 2.54, originY: 0.685 * 2.54, cellsPerMm: 1 / 2.54 }
export const BOARD_MM = { w: 66, h: 97 }
export const PITCH = 2.54

/** P1/P2: pin 1 at (6.33, 33.82) and (57.13, 33.82), 25 rows (UM1472 Fig. 5). */
export const HEADER = { p1: 6.33, p2: 57.13, top: 33.82, rows: 25 }
export const rowY = (row: number) => HEADER.top + row * PITCH

export const SOON = {
  stlink: { from: { x: 1.0, y: 3.7 }, to: { x: 39.2, y: 26.2 }, label: "ST-LINK/V2 · SWD" },
  cn3: { from: { x: 42.0, y: 14.3 }, to: { x: 52.6, y: 26.2 }, label: "CN3 ST-LINK/DISCOVERY" },
  otg: { from: { x: 24.0, y: 88.6 }, to: { x: 41.3, y: 97.8 }, label: "CN5 USB OTG FS" },
} as const

/** ST's logo, from the rev-E top silkscreen (SCH-E p8), in mm with its origin at the logo's centre. */
const ST_LOGO_CENTRE: Mm = { x: 59.32, y: 21.52 }
const ST_LOGO: Mm[][] = [
  [[64.08, 19.0], [63.82, 19.69], [57.42, 19.69], [57.07, 19.79], [56.84, 19.94], [56.63, 20.17], [56.48, 20.5], [56.41, 20.88], [56.48, 21.31], [56.68, 21.62], [57.9, 22.76], [57.96, 22.94], [57.88, 23.09], [57.75, 23.14], [54.58, 23.14], [54.53, 23.04], [55.9, 19.71], [56.08, 19.43], [56.35, 19.18], [56.68, 19.03], [57.04, 18.95], [64.05, 18.95]],
  [[63.39, 20.7], [62.35, 23.27], [62.17, 23.57], [61.87, 23.85], [61.54, 24.0], [61.16, 24.08], [60.7, 24.08], [60.65, 23.98], [61.97, 20.78], [62.1, 20.65], [63.37, 20.65]],
  [[61.0, 20.73], [59.68, 23.95], [59.5, 24.08], [58.21, 24.08], [58.39, 23.93], [58.64, 23.7], [58.82, 23.37], [58.92, 22.91], [58.89, 22.63], [58.77, 22.35], [58.56, 22.1], [57.42, 21.03], [57.37, 20.85], [57.45, 20.68], [60.95, 20.65]],
].map((outline) => outline.map(([x, y]) => ({ x: x - ST_LOGO_CENTRE.x, y: y - ST_LOGO_CENTRE.y })))

/**
 * The ESD-susceptibility sign (ANSI/ESD S8.1) the MB997A prints above the logo, from Wikimedia
 * Commons "File:ESD (Susceptible).svg" (public domain): the black triangle with its hand, cut in
 * two along the struck-through bar, and the gaps between the fingers as cut-outs (wound the other
 * way). Unit triangle, 1 wide, apex up; [x, y, x, y, …].
 */
const ESD_PIECES: number[][] = [
  [0.765, 0.46, 0.953, 0.785, 0.273, 0.393, 0.5, 0, 0.675, 0.303, 0.61, 0.336, 0.543, 0.354, 0.479, 0.364, 0.421, 0.372, 0.374, 0.386, 0.341, 0.412, 0.332, 0.426, 0.632, 0.6, 0.633, 0.599, 0.66, 0.573, 0.687, 0.543, 0.721, 0.506, 0.765, 0.46],
  [0.912, 0.866, 0, 0.866, 0.228, 0.471, 0.283, 0.503, 0.268, 0.526, 0.253, 0.551, 0.237, 0.576, 0.234, 0.581, 0.231, 0.587, 0.228, 0.593, 0.228, 0.602, 0.229, 0.614, 0.232, 0.63, 0.239, 0.656, 0.244, 0.679, 0.248, 0.7, 0.253, 0.716, 0.259, 0.73, 0.267, 0.739, 0.272, 0.741, 0.278, 0.74, 0.284, 0.739, 0.291, 0.74, 0.297, 0.745, 0.303, 0.756, 0.307, 0.769, 0.31, 0.782, 0.314, 0.795, 0.317, 0.805, 0.322, 0.81, 0.326, 0.809, 0.332, 0.802, 0.337, 0.793, 0.342, 0.781, 0.346, 0.769, 0.347, 0.755, 0.346, 0.741, 0.342, 0.725, 0.336, 0.714, 0.33, 0.707, 0.325, 0.703, 0.322, 0.698, 0.321, 0.691, 0.322, 0.668, 0.322, 0.647, 0.322, 0.629, 0.321, 0.615, 0.321, 0.604, 0.322, 0.598, 0.327, 0.589, 0.334, 0.577, 0.344, 0.564, 0.354, 0.551, 0.358, 0.547, 0.463, 0.607, 0.46, 0.613, 0.445, 0.631, 0.425, 0.651, 0.405, 0.673, 0.389, 0.696, 0.382, 0.718, 0.381, 0.738, 0.38, 0.754, 0.379, 0.765, 0.378, 0.772, 0.379, 0.777, 0.381, 0.779, 0.385, 0.775, 0.39, 0.765, 0.398, 0.752, 0.408, 0.74, 0.42, 0.73, 0.435, 0.727, 0.447, 0.73, 0.455, 0.734, 0.46, 0.739, 0.462, 0.745, 0.464, 0.748, 0.468, 0.75, 0.474, 0.745, 0.484, 0.733, 0.499, 0.715, 0.519, 0.694, 0.542, 0.672, 0.556, 0.66],
]
const ESD_CUTS: number[][] = [
  [0.349, 0.712, 0.356, 0.71, 0.363, 0.704, 0.37, 0.695, 0.375, 0.684, 0.376, 0.67, 0.371, 0.654, 0.364, 0.64, 0.36, 0.629, 0.358, 0.621, 0.358, 0.613, 0.361, 0.604, 0.366, 0.593, 0.372, 0.582, 0.377, 0.574, 0.381, 0.569, 0.383, 0.566, 0.383, 0.562, 0.374, 0.558, 0.369, 0.562, 0.364, 0.568, 0.358, 0.575, 0.352, 0.583, 0.347, 0.589, 0.342, 0.595, 0.339, 0.6, 0.337, 0.606, 0.337, 0.615, 0.339, 0.627, 0.341, 0.64, 0.341, 0.651, 0.34, 0.659, 0.338, 0.667, 0.337, 0.673, 0.336, 0.679, 0.336, 0.686, 0.338, 0.693, 0.34, 0.7, 0.343, 0.706, 0.346, 0.71, 0.349, 0.712],
  [0.405, 0.576, 0.399, 0.573, 0.392, 0.577, 0.385, 0.585, 0.379, 0.596, 0.374, 0.609, 0.373, 0.622, 0.374, 0.634, 0.376, 0.644, 0.38, 0.653, 0.383, 0.659, 0.387, 0.663, 0.391, 0.665, 0.394, 0.663, 0.396, 0.659, 0.398, 0.653, 0.399, 0.644, 0.398, 0.634, 0.396, 0.622, 0.393, 0.612, 0.392, 0.605, 0.392, 0.601, 0.394, 0.598, 0.396, 0.596, 0.399, 0.594, 0.402, 0.591, 0.405, 0.588, 0.406, 0.585, 0.407, 0.582, 0.407, 0.579, 0.405, 0.576],
  [0.406, 0.612, 0.407, 0.621, 0.408, 0.627, 0.41, 0.632, 0.412, 0.636, 0.414, 0.638, 0.416, 0.639, 0.418, 0.638, 0.421, 0.637, 0.423, 0.636, 0.426, 0.633, 0.427, 0.629, 0.428, 0.625, 0.427, 0.621, 0.426, 0.619, 0.425, 0.617, 0.423, 0.615, 0.422, 0.612, 0.422, 0.608, 0.422, 0.603, 0.424, 0.6, 0.426, 0.598, 0.428, 0.597, 0.429, 0.595, 0.43, 0.593, 0.429, 0.59, 0.429, 0.588, 0.418, 0.584, 0.415, 0.586, 0.412, 0.59, 0.409, 0.595, 0.407, 0.603, 0.406, 0.612],
  [0.279, 0.784, 0.286, 0.795, 0.292, 0.802, 0.296, 0.807, 0.299, 0.809, 0.301, 0.809, 0.304, 0.809, 0.307, 0.807, 0.308, 0.803, 0.307, 0.796, 0.305, 0.788, 0.302, 0.777, 0.298, 0.764, 0.294, 0.756, 0.288, 0.751, 0.282, 0.748, 0.276, 0.748, 0.272, 0.749, 0.269, 0.75, 0.268, 0.752, 0.268, 0.755, 0.268, 0.76, 0.27, 0.766, 0.273, 0.774, 0.279, 0.784],
  [0.403, 0.762, 0.395, 0.774, 0.392, 0.785, 0.392, 0.794, 0.394, 0.802, 0.397, 0.808, 0.401, 0.812, 0.404, 0.814, 0.409, 0.815, 0.414, 0.813, 0.422, 0.809, 0.43, 0.802, 0.441, 0.791, 0.45, 0.779, 0.454, 0.769, 0.455, 0.759, 0.453, 0.752, 0.45, 0.746, 0.447, 0.743, 0.439, 0.738, 0.432, 0.736, 0.426, 0.738, 0.419, 0.742, 0.412, 0.75, 0.403, 0.762],
]

const pairs = (flat: number[]): Mm[] => Array.from({ length: flat.length / 2 }, (_, i) => ({ x: flat[i * 2], y: flat[i * 2 + 1] }))

const NAME: TextStyle = { size: 0.55, mono: true }
const REF: TextStyle = { size: 0.32, muted: true }
const CAPTION: TextStyle = { size: 0.42, muted: true }
const named = (style: TextStyle, extra: Partial<TextStyle>): TextStyle => ({ ...style, ...extra })

/** Pad centre to the near edge of its name, on both sides of both headers (SCH-E p8: 1.6–2.3 mm). */
const NAME_GAP_MM = 1.9

export type HeaderNames = { p1: [string, string][]; p2: [string, string][] }

function soon(region: { from: Mm; to: Mm; label: string }, draw: (a: Artwork) => void): BodyShape {
  const a = new Artwork(FRAME)
  draw(a)
  const x = a.cellX(region.from.x)
  const y = a.cellY(region.from.y)
  return { type: "soon", x, y, w: a.cellX(region.to.x) - x, h: a.cellY(region.to.y) - y, label: region.label, body: a.shapes() }
}

/**
 * A quad flat pack's leads as one band round the body (as the Open746I-C draws its LQFP176):
 * `span` mm of leads along each side, out to `tip` from the centre, clear of the corners.
 */
function leads(a: Artwork, x: number, y: number, tip: number, span: number) {
  const h = span / 2
  a.polygon("zone", [
    { x: x - h, y: y - tip }, { x: x + h, y: y - tip }, { x: x + h, y: y - h }, { x: x + tip, y: y - h },
    { x: x + tip, y: y + h }, { x: x + h, y: y + h }, { x: x + h, y: y + tip }, { x: x - h, y: y + tip },
    { x: x - h, y: y + h }, { x: x - tip, y: y + h }, { x: x - tip, y: y - h }, { x: x - h, y: y - h },
  ])
}

export function boardArt(names: HeaderNames): BodyShape[] {
  const art = new Artwork(FRAME)

  // --- P1 and P2: the silkscreen box with pin 1's square, and the names either side.
  const p1 = art.grouped()
  const p2 = art.grouped()
  for (const [x, pins, side] of [[HEADER.p1, names.p1, p1], [HEADER.p2, names.p2, p2]] as const) {
    const top = rowY(0) - 1.27
    const bottom = rowY(HEADER.rows - 1) + 1.27
    art.outline(x - 1.23, top, x + PITCH + 1.27, bottom)
    art.line([{ x: x - 1.23, y: top + PITCH }, { x: x + 1.27, y: top + PITCH }, { x: x + 1.27, y: top }])
    pins.forEach(([odd, even], row) => {
      side.text(odd, x - NAME_GAP_MM, rowY(row), named(NAME, { anchor: "end" }))
      side.text(even, x + PITCH + NAME_GAP_MM, rowY(row), named(NAME, { anchor: "start" }))
    })
  }
  art.text("P1", HEADER.p1 + 1.27, 31.0, CAPTION).text("P2", HEADER.p2 + 1.27, 31.0, CAPTION)

  // --- CN1 mini-B shell (the USB part draws the receptacle) and LD2's PWR.
  art.rect("connector", 29.5, -1.7, 37.3, 3.5, 0.3)
  art.text("PWR", 43.2, 13.0, named(REF, { rotate: -90 }))

  // --- MB997A, the ESD sign and ST's logo, stacked down the right as on the MB997A.
  art.text("MB997A", 58.4, 12.5, named(CAPTION, { size: 0.62 }))
  const esd = { x: 56.0, y: 15.0, side: 6.0 }
  const unit = (p: Mm): Mm => ({ x: esd.x + p.x * esd.side, y: esd.y + p.y * esd.side })
  for (const outline of [...ESD_PIECES, ...ESD_CUTS]) art.polygon("mark", pairs(outline).map(unit))
  const logo = { x: 59.4, y: 23.9 }
  for (const outline of ST_LOGO) art.polygon("mark", outline.map((p) => ({ x: logo.x + p.x, y: logo.y + p.y })))
  art.text("®", 64.9, 24.9, named(REF, { size: 0.36 }))

  // --- The URL and X2, the 8 MHz HSE crystal.
  art.text("www.st.com/stm32f4-discovery", 33.05, 27.7, { size: 0.7, muted: true })
  art.rect("connector", 25.05, 31.0, 36.15, 35.8, 2.4)
  art.text("8.000", 30.6, 33.4, CAPTION)

  // --- JP1 (Idd): the part draws the jumper; its box and name below, as printed.
  art.outline(16.2, 39.9, 19.0, 45.3, 0.2)
  art.text("Idd", 17.6, 46.6, CAPTION)

  // --- U4, STM32F407VGT6 (LQFP100, 14 mm body, 16 mm across the leads, pin 1 top right).
  const mcu = { x: 32.66, y: 48.52 }
  leads(art, mcu.x, mcu.y, 8, 12.4)
  art.polygon("chip", [
    { x: mcu.x - 7, y: mcu.y - 7 }, { x: mcu.x + 6, y: mcu.y - 7 }, { x: mcu.x + 7, y: mcu.y - 6 }, { x: mcu.x + 7, y: mcu.y + 7 }, { x: mcu.x - 7, y: mcu.y + 7 },
  ], 0.2)
  art.circle("board", mcu.x + 5.6, mcu.y - 5.6, 0.45)
  art.text("STM32F407VGT6", mcu.x, mcu.y - 0.6, { size: 0.5, inverse: true }).text("ARM · 168 MHz", mcu.x, mcu.y + 1.4, { size: 0.36, inverse: true })

  // --- B1 USER and B2 RESET (6 × 6 mm SMD switches; the parts draw the caps).
  for (const [x, name, nameX] of [[20.96, "User", 20.4], [45.04, "Reset", 46.3]] as const) {
    art.rect("connector", x - 3.1, 62.13, x + 3.1, 68.33, 0.3)
    art.text(name, nameX, 69.75, CAPTION)
  }

  // --- U5, the LIS302DL (3 × 5 mm on the MB997A), between the four user LEDs and their names.
  art.rect("chip", 32.01, 63.39, 35.01, 68.39, 0.15)
  art.text("LD3", 35.6, 60.55, named(REF, { anchor: "start" }))
  art.text("LD4", 27.4, 64.6, named(REF, { anchor: "end" }))
  art.text("LD5", 36.3, 64.35, REF)
  art.text("LD6", 31.3, 69.0, named(REF, { anchor: "end" }))

  // --- U7 CS43L22 (QFN-40, 6 × 6 mm) and U9, the MP45DT02 microphone (3 × 4 mm).
  const codec = { x: 27.0, y: 76.71 }
  art.rect("chip", codec.x - 3, codec.y - 3, codec.x + 3, codec.y + 3, 0.2)
  art.text("CIRRUS", codec.x, codec.y - 0.55, { size: 0.3, inverse: true }).text("43L22", codec.x, codec.y + 0.6, { size: 0.3, inverse: true })
  art.rect("connector", 46.17, 86.03, 49.17, 90.03, 0.2)

  // --- CN4 audio jack, hanging over the bottom edge as on the board; LD8.
  art.rect("chip", 15.26, 82.3, 23.74, 96.6, 0.3)
  art.rect("chip", 16.15, 96.6, 21.24, 99.8, 0.3)
  art.text("LD8", 43.4, 92.6, REF)

  // --- The things emul does not model, each under its soon badge.
  const stlink = soon(SOON.stlink, (a) => {
    // CN2 SWD (6 × 2.54 mm), LD1 COM, X1, U2 (STM32F103, LQFP48).
    a.rect("chip", 5.06, 10.03, 7.6, 25.27, 0.2)
    a.text("SWD", 3.3, 16.4, named(CAPTION, { size: 0.6, rotate: -90 }))
    a.rect("connector", 15.4, 6.45, 17.4, 8.25, 0.2)
    a.text("COM", 18.6, 7.4, named(REF, { anchor: "start" }))
    a.rect("connector", 17.8, 12.25, 22.5, 23.4, 2.3)
    leads(a, 31.25, 19.95, 4.5, 5.9)
    a.rect("chip", 27.75, 16.45, 34.75, 23.45, 0.15)
    a.text("STM32F103", 31.25, 19.95, { size: 0.32, inverse: true })
  })
  const cn3 = soon(SOON.cn3, (a) => {
    a.rect("connector", 45.9, 15.65, 48.7, 20.65, 0.4).rect("connector", 45.9, 21.15, 48.7, 26.1, 0.4)
    a.text("ST-LINK", 43.6, 20.7, named(CAPTION, { size: 0.5, rotate: -90 })).text("DISCOVERY", 51.4, 20.7, named(CAPTION, { size: 0.5, rotate: -90 }))
  })
  const otg = soon(SOON.otg, (a) => {
    a.rect("connector", 32.9, 92.4, 40.7, 97.6, 0.4)
    a.rect("connector", 28.79, 93.9, 29.59, 95.5, 0.1)
    a.text("CN5", 36.8, 90.2, CAPTION)
  })

  const plate: BodyShape = { type: "rect", x: art.cellX(0), y: art.cellY(0), w: art.cells(BOARD_MM.w), h: art.cells(BOARD_MM.h), rx: art.cells(0.6), fill: "board" }
  return [plate, ...art.shapes(), stlink, cn3, otg]
}
