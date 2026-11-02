import { Artwork, type BoardFrame, type Mm, type TextStyle } from "../pcb-art"
import type { BodyShape } from "../types"

/**
 * The WeAct Black Pill V3.1's top side (USB-C on the left), in millimetres, drawn the way the
 * Open746I-C is: the two pin rows with their printed names, the USB-C receptacle, the chips and
 * crystals, the buttons and LEDs and the board's own legends — no 0402 passives or reference
 * designators. Positions from WeAct's V3.1 board-shape drawing (BS31 p1, 52.81 × 20.78 mm) and the
 * official top render (STM32F411-3D-Model-Render/top.jpg, turned a quarter to BS31's orientation),
 * the two agreeing within 0.5 mm (docs/blackpill-f411). The top side carries no logo: "WeAct Studio"
 * and "V3.1" are on the bottom.
 *
 * The SWD header P3 is a working connector: four bare pads (the right-angle header comes loose in the bag), boxed
 * and named the way the Open746I-C draws its headers.
 */

export const FRAME: BoardFrame = { originX: (2 - 1.4 / 2.54) * 2.54, originY: (2 - 2.77 / 2.54) * 2.54, cellsPerMm: 1 / 2.54 }
export const BOARD_MM = { w: 52.81, h: 20.78, corner: 0.43 }
export const PITCH = 2.54

/** P1 (top) and P2 (bottom): pin 1 at x 1.40 mm on the USB end, rows at y 2.77 and 17.97 mm (BS31 p1). */
export const HEADER = { x: 1.4, p1: 2.77, p2: 17.97, pins: 20 }
export const pinX = (i: number) => HEADER.x + i * PITCH

/** P3 pads (BS31 p1): x 45.88 mm, pin 1 (3V3, square) at y 14.14, then 11.60, 9.06, 6.52. */
export const SWD = { padX: 45.88, ys: [14.14, 11.6, 9.06, 6.52] }

const NAME: TextStyle = { size: 0.5, mono: true }
const LEGEND: TextStyle = { size: 0.42 }
const CAPTION: TextStyle = { size: 0.34, muted: true }
const named = (style: TextStyle, extra: Partial<TextStyle>): TextStyle => ({ ...style, ...extra })

/** Pad centre to the centre of its name: BS31 prints them 1.7 mm off the pad, outside the rows. */
const NAME_OFFSET_MM = 1.75


/** A square no-lead package turned 45° as WeAct places U1: body half-diagonal `r`, `n` pads a side at `pitch`. */
function qfnTurned(a: Artwork, c: Mm, side: number, n: number, pitch: number) {
  const r = side / Math.SQRT2
  // Unit vectors along each edge (from corner to corner) and outward, the body being a diamond.
  const corners: Mm[] = [
    { x: c.x, y: c.y - r },
    { x: c.x + r, y: c.y },
    { x: c.x, y: c.y + r },
    { x: c.x - r, y: c.y },
  ]
  const PAD_W = 0.25
  const PAD_L = 0.45
  const GAP = 0.1
  for (let e = 0; e < 4; e++) {
    const p0 = corners[e]
    const p1 = corners[(e + 1) % 4]
    const along = { x: (p1.x - p0.x) / side, y: (p1.y - p0.y) / side }
    const out = { x: along.y, y: -along.x }
    for (let k = 0; k < n; k++) {
      const t = side / 2 + (k - (n - 1) / 2) * pitch
      const base = { x: p0.x + along.x * t + out.x * GAP, y: p0.y + along.y * t + out.y * GAP }
      const w = { x: (along.x * PAD_W) / 2, y: (along.y * PAD_W) / 2 }
      const l = { x: out.x * PAD_L, y: out.y * PAD_L }
      a.polygon("connector", [
        { x: base.x - w.x, y: base.y - w.y },
        { x: base.x + w.x, y: base.y + w.y },
        { x: base.x + w.x + l.x, y: base.y + w.y + l.y },
        { x: base.x - w.x + l.x, y: base.y - w.y + l.y },
      ])
    }
  }
  a.polygon("chip", corners, 0.15)
}

export function boardArt(names: { p1: string[]; p2: string[] }, part: string): BodyShape[] {
  const art = new Artwork(FRAME)

  // --- P1 and P2: the names outside the rows, and the two silkscreen rules inside them (BS31: y 4.06 / 16.8 mm, x 0.4–50.8 mm).
  const top = art.grouped()
  const bottom = art.grouped()
  names.p1.forEach((name, i) => top.text(name, pinX(i), HEADER.p1 - NAME_OFFSET_MM, NAME))
  names.p2.forEach((name, i) => bottom.text(name, pinX(i), HEADER.p2 + NAME_OFFSET_MM, NAME))
  art.line([{ x: 0.4, y: 4.06 }, { x: 50.8, y: 4.06 }])
  art.line([{ x: 0.4, y: 16.8 }, { x: 50.8, y: 16.8 }])

  // --- J1 USB-C (16-pin, mid-mount): the shell sticks 0.7 mm past the edge, its contact row inboard.
  art.rect("connector", -0.7, 5.8, 7.4, 15.0, 0.6)
  for (let i = 0; i < 12; i++) art.rect("connector", 7.6, 6.95 + i * 0.6, 8.3, 7.25 + i * 0.6, 0.05)

  // --- D4 B5819WS (SOD-323, cathode band) and U2 ME6231A33 (SOT-23-3) behind the connector.
  art.rect("chip", 9.1, 5.4, 10.9, 6.7, 0.1)
  art.polygon("mark", [{ x: 10.25, y: 5.55 }, { x: 10.6, y: 5.55 }, { x: 10.6, y: 6.55 }, { x: 10.25, y: 6.55 }])
  art.rect("chip", 9.4, 8.4, 11.9, 9.8, 0.1)

  // --- SW2 NRST and SW3 BOOT0 (3 × 4 mm switches; the parts draw the caps), legends as printed.
  for (const [y0, name, nameY] of [[6.4, "NRST", 5.0], [11.1, "BOOT0", 15.75]] as const) {
    art.rect("connector", 12.9, y0, 17.3, y0 + 3.2, 0.3)
    art.text(name, 15.1, nameY, LEGEND)
  }

  // --- U1 STM32F4x1CxU6, UFQFPN48 7 × 7 mm at 45°, pin 1 on the right-hand corner (BS31 dot, the render's).
  const mcu = { x: 26.3, y: 10.4 }
  qfnTurned(art, mcu, 7, 12, 0.5)
  art.circle("board", mcu.x + 3.2, mcu.y, 0.3)
  art.text(part.slice(0, 9), mcu.x - 0.2, mcu.y - 0.45, { size: 0.3, inverse: true }).text(part.slice(9), mcu.x - 0.2, mcu.y + 0.55, { size: 0.26, inverse: true })

  // --- Y2 25 MHz (3225, metal lid) and Y1 32.768 kHz (3215) between U1 and KEY.
  art.rect("connector", 33.2, 6.0, 36.5, 9.5, 0.2)
  art.text("25M", 34.85, 7.75, named(CAPTION, { size: 0.26, rotate: -90 }))
  art.rect("connector", 34.2, 10.4, 35.9, 13.6, 0.15)

  // --- SW1 KEY with its legend up the left, and the LED legends left of D2 (C13) and D3 (PWR).
  art.rect("connector", 38.6, 10.4, 43.6, 14.2, 0.3)
  art.text("KEY", 37.45, 12.3, named(LEGEND, { rotate: -90 }))
  art.text("C13", 38.3, 5.6, LEGEND)
  art.text("PWR", 38.0, 15.4, LEGEND)

  // --- P3, the SWD pads, drawn as the Open746I-C draws its headers: a rounded box round the pads and their names,
  // each name beside its pad (WeAct prints them on arrows: GND SCK DIO 3V3), the group named down the side.
  art.outline(44.55, 5.25, 51.75, 15.4, 0.6)
  for (const [text, y] of [["GND", SWD.ys[3]], ["SCK", SWD.ys[2]], ["DIO", SWD.ys[1]], ["3V3", SWD.ys[0]]] as const) art.text(text, 47.35, y, named(NAME, { size: 0.42, anchor: "start" }))
  art.text("SWD", 43.75, 7.8, named(CAPTION, { size: 0.4, rotate: -90 }))

  // --- D1 BAT54C (SOT-23) between C13 and KEY, feeding VBAT from 3V3 and VB.
  art.rect("chip", 41.15, 7.05, 42.45, 9.95, 0.1)

  const plate: BodyShape = { type: "rect", x: art.cellX(0), y: art.cellY(0), w: art.cells(BOARD_MM.w), h: art.cells(BOARD_MM.h), rx: art.cells(BOARD_MM.corner), fill: "board" }
  return [plate, ...art.shapes()]
}
