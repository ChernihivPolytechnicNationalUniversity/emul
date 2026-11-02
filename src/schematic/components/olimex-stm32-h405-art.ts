import { Artwork, type BoardFrame, type Mm, type MmBox, type TextStyle } from "../pcb-art"
import { PRINTED_ADVANCE_EM } from "../printed-text"
import type { BodyShape } from "../types"

export const PITCH = 2.54
export const MIL_MM = 0.0254
export const BOARD_MM = { w: 60.96, h: 34.29 }

export const FRAME: BoardFrame = { originX: 3.25 * PITCH, originY: 0.75 * PITCH, cellsPerMm: 1 / PITCH }

export type Region = "top" | "middle" | "bottom" | "jtag"

export const SHIFT: Record<Region, Mm> = {
  top: { x: 0, y: 0 },
  middle: { x: 0, y: 3 * PITCH },
  bottom: { x: 0, y: 7 * PITCH },
  jtag: { x: 2 * PITCH, y: 3 * PITCH },
}

export const placed = (region: Region, p: Mm): Mm => ({ x: p.x + SHIFT[region].x, y: p.y + SHIFT[region].y })

const URL_CLEAR_OF_THE_BOX = 0.55
const URL: TextStyle = { size: 0.6, muted: true }
const NAME: TextStyle = { size: 0.5, mono: true }
const JTAG_NAME_GAP = 1.4
const JTAG_NAME_ROOM = 4 * PRINTED_ADVANCE_EM * NAME.size * PITCH + 0.4

const TABLE: TextStyle = { size: 0.4, mono: true }
const BOX_MARGIN = 1.4
const BOX_CORNER = 0.5
const BAND_PAD = 0.2
const LONGEST_HEADER_NAME = 4
const OPEN746_TABLE_GROWTH = 1.7
const BAND = LONGEST_HEADER_NAME * PRINTED_ADVANCE_EM * TABLE.size * PITCH * OPEN746_TABLE_GROWTH + 2 * BAND_PAD

export type Connector = "EXT1" | "EXT2"

const EXT_ROWS: Record<Connector, { odd: number; even: number }> = {
  EXT2: { odd: 225 * MIL_MM, even: 125 * MIL_MM },
  EXT1: { odd: 1125 * MIL_MM + SHIFT.bottom.y, even: 1225 * MIL_MM + SHIFT.bottom.y },
}

export function extPad(connector: Connector, pin: number): Mm {
  const odd = pin % 2 === 1
  const column = Math.floor((pin - 1) / 2)
  const mil = connector === "EXT2" ? 1875 - 100 * column : 675 + 100 * column
  return { x: mil * MIL_MM, y: odd ? EXT_ROWS[connector].odd : EXT_ROWS[connector].even }
}

export const REAL_JTAG_SHROUD = { x0: 52.15, x1: BOARD_MM.w }
const JTAG_PIN1 = { x: 2175 * MIL_MM, y: 225 * MIL_MM }
const JTAG_WALL = 1.15
const JTAG_SIDE = JTAG_NAME_GAP + JTAG_NAME_ROOM + JTAG_WALL
const JTAG_MIDDLE = JTAG_PIN1.x + PITCH / 2
const LATCH_HALF = 1.75

export const JTAG = {
  x0: JTAG_PIN1.x - JTAG_SIDE,
  y0: 0.5,
  x1: JTAG_PIN1.x + PITCH + JTAG_SIDE,
  y1: 33.75,
  wall: JTAG_WALL,
  pin1: JTAG_PIN1,
  key: { y0: 15.1, y1: 19.3 },
  latch: { x0: JTAG_MIDDLE - LATCH_HALF, x1: JTAG_MIDDLE + LATCH_HALF },
}

export const jtagPad = (pin: number): Mm => placed("jtag", { x: JTAG.pin1.x + (pin % 2 === 1 ? 0 : PITCH), y: JTAG.pin1.y + Math.floor((pin - 1) / 2) * PITCH })

const EXT_COLUMNS = { x0: 675 * MIL_MM, x1: 1875 * MIL_MM }

export function pinBoxOf(connector: Connector): MmBox {
  const { odd, even } = EXT_ROWS[connector]
  return { x0: EXT_COLUMNS.x0 - BOX_MARGIN, y0: Math.min(odd, even) - BOX_MARGIN, x1: EXT_COLUMNS.x1 + BOX_MARGIN, y1: Math.max(odd, even) + BOX_MARGIN }
}

export type NameTable = MmBox & { rule: number }

const extTable = (connector: Connector): NameTable => {
  const box = pinBoxOf(connector)
  return connector === "EXT2" ? { ...box, y0: box.y1, y1: box.y1 + 2 * BAND, rule: box.y1 + BAND } : { ...box, y0: box.y0 - 2 * BAND, y1: box.y0, rule: box.y0 - BAND }
}

export const NAME_TABLES = { EXT2: extTable("EXT2"), EXT1: extTable("EXT1") }

export const JTAG_SHROUD: MmBox = { x0: placed("jtag", { x: JTAG.x0, y: 0 }).x, y0: placed("jtag", { x: 0, y: JTAG.y0 }).y, x1: placed("jtag", { x: JTAG.x1, y: 0 }).x, y1: placed("jtag", { x: 0, y: JTAG.y1 }).y }

export const jtagNameAnchor = (pin: number): Mm => {
  const pad = jtagPad(pin)
  return { x: pad.x + (pin % 2 === 1 ? -JTAG_NAME_GAP : JTAG_NAME_GAP), y: pad.y }
}

export const PLATE: MmBox = { x0: 0, y0: 0, x1: JTAG_SHROUD.x1, y1: BOARD_MM.h + SHIFT.bottom.y + 0.4 }

export function nameCellOf(connector: Connector, pin: number): MmBox {
  const odd = pin % 2 === 1
  const t = NAME_TABLES[connector]
  const x = extPad(connector, pin).x
  const upperRow = connector === "EXT2" ? !odd : odd
  return { x0: x - PITCH / 2, x1: x + PITCH / 2, y0: upperRow ? t.y0 : t.rule, y1: upperRow ? t.rule : t.y1 }
}

const ON_THE_BOARD = {
  usb: { x: -6.9, y: 17.15 },
  reset: { x: 15.3, y: 12.46 },
  but: { x: 15.24, y: 21.21 },
  pwr: { x: 3.55, y: 28.2 },
  stat: { x: 3.55, y: 31.75 },
}

export const AT: Record<keyof typeof ON_THE_BOARD, Mm> = {
  usb: placed("middle", ON_THE_BOARD.usb),
  reset: placed("middle", ON_THE_BOARD.reset),
  but: placed("middle", ON_THE_BOARD.but),
  pwr: placed("bottom", ON_THE_BOARD.pwr),
  stat: placed("bottom", ON_THE_BOARD.stat),
}

export const USB_SHELL = { x0: -6.9, y0: 11.1, x1: 9.7, y1: 23.2 }
const USB_SPRINGS: Mm[][] = [
  [{ x: 1.8, y: 12.13 }, { x: -4.34, y: 13.08 }, { x: -4.34, y: 14.14 }, { x: 1.69, y: 15.2 }],
  [{ x: 1.8, y: 19.11 }, { x: -4.34, y: 20.17 }, { x: -4.34, y: 21.23 }, { x: 1.69, y: 22.18 }],
]
const USB_LUGS = { x: 3.34, top: 11.13, bottom: 23.18, r: 1.97 }
const SPRING_STROKE = 0.2

export const SWITCH_BODIES = { reset: { x: 15.3, y: 12.46 }, but: { x: 15.3, y: 21.22 } }
const BUT_POSTS = { offset: 2.35, r: 0.45 }
const RESET_WINDOWS = { offset: 2.45, w: 0.83, h: 2.33 }
export const U1 = { x: 1200 * MIL_MM, y: 675 * MIL_MM, body: 5, leadTips: 6, leadSpan: 7.8 }

export const BRIDGE_PITCH = 1.27
const BRIDGES_ON_THE_BOARD = { b1: { x: 8.66, y: 27.5 }, b0: { x: 8.66, y: 29.2 } }
export const BOOT_BRIDGES = { b1: placed("bottom", BRIDGES_ON_THE_BOARD.b1), b0: placed("bottom", BRIDGES_ON_THE_BOARD.b0) }
export const USBP_E_NUDGE = 0.6
export const USBP_E = { x0: 49.85 + USBP_E_NUDGE, x1: 50.95 + USBP_E_NUDGE, y: 5.55 }

export const LEAD_FREE = { x: 20.83, y: 25.98, r: 1.9, ring: 0.24 }

export const Q1 = {
  centre: { x: 45.7, y: 18.415 },
  base: { halfWidth: 2.455, y0: 12.67, y1: 24.16, corner: 0.3 },
  flange: { halfWidth: 2.1, halfLength: 5.465 },
  top: { halfWidth: 1.34, halfLength: 4.725 },
  tab: { halfWidth: 0.475, length: 0.84 },
}

const TITLE: TextStyle = { size: 0.64, muted: true }
const LEGEND: TextStyle = { size: 0.55, muted: true }
const SMALL: TextStyle = { size: 0.38, muted: true }
const named = (style: TextStyle, extra: Partial<TextStyle>): TextStyle => ({ ...style, ...extra })
const upward = (style: TextStyle): TextStyle => named(style, { rotate: -90 })

const signedArea = (p: readonly Mm[]) => p.reduce((sum, q, i) => sum + q.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * q.y, 0) / 2
const solid = (p: Mm[]) => (signedArea(p) >= 0 ? p : [...p].reverse())
const cutOut = (p: Mm[]) => (signedArea(p) < 0 ? p : [...p].reverse())

const arc = (c: Mm, r: number, from: number, to: number, steps: number): Mm[] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / steps
    return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }
  })

const CAP_STEPS = 12

function capsule(a: Mm, b: Mm, width: number): Mm[] {
  const r = width / 2
  const heading = Math.atan2(b.y - a.y, b.x - a.x)
  return solid([...arc(b, r, heading - Math.PI / 2, heading + Math.PI / 2, CAP_STEPS), ...arc(a, r, heading + Math.PI / 2, heading + (3 * Math.PI) / 2, CAP_STEPS)])
}

function penStroke(art: Artwork, points: readonly Mm[], width: number) {
  for (let i = 1; i < points.length; i++) art.polygon("mark", capsule(points[i - 1], points[i], width))
}

function ring(art: Artwork, c: Mm, outer: number, width: number) {
  const steps = Math.max(48, Math.round(outer * 64))
  const circle = (r: number) => arc(c, r, 0, 2 * Math.PI, steps).slice(0, -1)
  art.polygon("mark", solid(circle(outer))).polygon("mark", cutOut(circle(outer - width)))
}

function leadFreeRoundel(art: Artwork) {
  const { r, ring: band } = LEAD_FREE
  const at = (x: number, y: number): Mm => ({ x: LEAD_FREE.x + x, y: LEAD_FREE.y + y })
  const bowl = (stem: number, top: number, bottom: number, reach: number) => {
    const radius = (bottom - top) / 2
    const turn = stem + reach - radius
    return [at(stem, top), at(turn, top), ...arc(at(turn, top + radius), radius, -Math.PI / 2, Math.PI / 2, 16), at(stem, bottom)]
  }
  ring(art, LEAD_FREE, r, band)
  const letter = 0.28
  penStroke(art, [at(-0.93, -0.36), at(-0.93, 0.61)], letter)
  penStroke(art, bowl(-0.93, -0.36, 0.16, 0.67), letter)
  penStroke(art, [at(0.21, -0.51), at(0.21, 0.61)], letter)
  penStroke(art, bowl(0.21, -0.01, 0.61, 0.68), letter)
  const reach = r - band / 2
  penStroke(art, [at(reach * Math.SQRT1_2, -reach * Math.SQRT1_2), at(-reach * Math.SQRT1_2, reach * Math.SQRT1_2)], band)
}

function leadBand(a: Artwork, x: number, y: number, tip: number, span: number) {
  const h = span / 2
  a.polygon("zone", [
    { x: x - h, y: y - tip }, { x: x + h, y: y - tip }, { x: x + h, y: y - h }, { x: x + tip, y: y - h },
    { x: x + tip, y: y + h }, { x: x + h, y: y + h }, { x: x + h, y: y + tip }, { x: x - h, y: y + tip },
    { x: x - h, y: y + h }, { x: x - tip, y: y + h }, { x: x - tip, y: y - h }, { x: x - h, y: y - h },
  ])
}

const BRIDGE_BOX = { x0: 6.76, x1: 10.56 }
const THROW_GAP = 0.3

function threePadBridge(a: Artwork, centre: Mm) {
  a.outline(BRIDGE_BOX.x0, centre.y - 0.8, BRIDGE_BOX.x1, centre.y + 0.8, 0.3)
  a.rect("zone", centre.x - BRIDGE_PITCH - 0.45, centre.y - 0.45, centre.x + BRIDGE_PITCH + 0.45, centre.y + 0.45, 0.1)
}

function jtagHeader(a: Artwork) {
  const { x0, y0, x1, y1, wall, key, latch } = JTAG
  a.polygon("connector", [
    { x: x0, y: y0 }, { x: latch.x0, y: y0 }, { x: latch.x0, y: y0 + wall }, { x: latch.x1, y: y0 + wall }, { x: latch.x1, y: y0 },
    { x: x1, y: y0 }, { x: x1, y: y1 },
    { x: latch.x1, y: y1 }, { x: latch.x1, y: y1 - wall }, { x: latch.x0, y: y1 - wall }, { x: latch.x0, y: y1 },
    { x: x0, y: y1 }, { x: x0, y: key.y1 }, { x: x0 + wall, y: key.y1 }, { x: x0 + wall, y: key.y0 }, { x: x0, y: key.y0 },
  ], 0.2)
  a.rect("zone", x0 + wall, y0 + wall, x1 - wall, y1 - wall, 0.2)
}

export type PinNames = Record<Connector | "JTAG", readonly string[]>

function cellName(art: Artwork, name: string, cell: MmBox) {
  art.text(name, (cell.x0 + cell.x1) / 2, (cell.y0 + cell.y1) / 2, named(TABLE, { rotate: -90 }))
}

function nameTables(art: Artwork, names: PinNames) {
  for (const connector of ["EXT2", "EXT1"] as const) {
    const box = pinBoxOf(connector)
    const table = NAME_TABLES[connector]
    art.outline(box.x0, box.y0, box.x1, box.y1, BOX_CORNER)
    art.outline(table.x0, table.y0, table.x1, table.y1, BOX_CORNER)
    art.line([{ x: table.x0, y: table.rule }, { x: table.x1, y: table.rule }])
  }
  for (const connector of ["EXT1", "EXT2"] as const) names[connector].forEach((name, i) => cellName(art, name, nameCellOf(connector, i + 1)))
  const beside = art.grouped()
  names.JTAG.forEach((name, i) => {
    const at = jtagNameAnchor(i + 1)
    beside.text(name, at.x, at.y, named(NAME, { anchor: i % 2 === 0 ? "end" : "start" }))
  })
}

function usbB(art: Artwork) {
  const { x, top, bottom, r } = USB_LUGS
  const clip = (edge: number, centre: number) => Math.asin(Math.min(1, Math.abs(edge - centre) / r))
  const above = clip(USB_SHELL.y0, top)
  const below = clip(USB_SHELL.y1, bottom)
  art.polygon("zone", arc({ x, y: top }, r, Math.PI + above, 2 * Math.PI - above, 32))
  art.polygon("zone", arc({ x, y: bottom }, r, below, Math.PI - below, 32))
  art.rect("connector", USB_SHELL.x0, USB_SHELL.y0, USB_SHELL.x1, USB_SHELL.y1, 0.4)
  for (const spring of USB_SPRINGS) penStroke(art, spring, SPRING_STROKE)
  art.text("USB", 10.95, 15.8, upward(named(TITLE, { size: 0.72 })))
}

function regulator(art: Artwork) {
  art.rect("zone", 1.3, 3.25, 3.35, 6.25, 0.1)
  for (const y of [2.45, 4.75, 7.05]) art.rect("zone", 6.85, y - 0.35, 8.65, y + 0.35, 0.1)
  art.rect("chip", 3.35, 1.5, 6.85, 8.0, 0.15)
  art.text("VR", 6.5, 9.45, named(TITLE, { size: 0.9 }))
}

function resetAndUserSwitches(art: Artwork) {
  art.rect("connector", 12.3, 10.36, 18.3, 14.56, 0.3)
  art.rect("connector", 12.3, 18.24, 18.3, 24.2, 0.3)
  const { reset, but } = SWITCH_BODIES
  for (const side of [-1, 1]) {
    const cx = reset.x + side * RESET_WINDOWS.offset
    art.rect("mark", cx - RESET_WINDOWS.w / 2, reset.y - RESET_WINDOWS.h / 2, cx + RESET_WINDOWS.w / 2, reset.y + RESET_WINDOWS.h / 2, RESET_WINDOWS.w / 2)
  }
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) art.circle("mark", but.x + dx * BUT_POSTS.offset, but.y + dy * BUT_POSTS.offset, BUT_POSTS.r)
  art.text("RESET", 15.75, 15.6, LEGEND).text("BUT", 15.45, 17.35, LEGEND)
}

function ledsAndBootBridges(art: Artwork) {
  art.outline(1.8, 27.3, 5.5, 29.1, 0.3).outline(1.8, 30.9, 5.5, 32.6, 0.3)
  art.text("PWR", 0.8, ON_THE_BOARD.pwr.y, upward(named(SMALL, { size: 0.45 }))).text("STAT", 0.8, ON_THE_BOARD.stat.y, upward(named(SMALL, { size: 0.45 })))
  for (const bridge of [BRIDGES_ON_THE_BOARD.b1, BRIDGES_ON_THE_BOARD.b0]) {
    threePadBridge(art, bridge)
    art.text("H", BRIDGE_BOX.x0 - THROW_GAP, bridge.y, named(SMALL, { anchor: "end" })).text("L", BRIDGE_BOX.x1 + THROW_GAP, bridge.y, named(SMALL, { anchor: "start" }))
  }
  art.text("B1_H/B1_L", 10.15, 26.0, SMALL).text("B0_H/B0_L", 10.05, 30.85, SMALL)
}

function pinOneMarkers(top: Artwork, bottom: Artwork) {
  bottom.text("1", 14.95, 28.75, named(SMALL, { size: 0.45 })).text("2", 14.95, 31.1, named(SMALL, { size: 0.45 }))
  top.text("1", 49.55, 7.6, named(SMALL, { size: 0.5 }))
}

function mcu(art: Artwork) {
  leadBand(art, U1.x, U1.y, U1.leadTips, U1.leadSpan)
  const b = U1.body
  art.polygon("chip", [
    { x: U1.x - b, y: U1.y - b }, { x: U1.x + b, y: U1.y - b }, { x: U1.x + b, y: U1.y + b - 1 }, { x: U1.x + b - 1, y: U1.y + b }, { x: U1.x - b, y: U1.y + b },
  ], 0.2)
  art.circle("board", U1.x + b - 0.95, U1.y + b - 0.95, 0.35)
  art.text("STM32F405RGT6", U1.x, U1.y - 0.5, { size: 0.42, inverse: true }).text("ARM · 168 MHz", U1.x, U1.y + 1.0, { size: 0.3, inverse: true })
  ring(art, { x: 35.75, y: 22.35 }, 0.32, 0.2)
  art.text("U1", 37.7, 22.05, named(TITLE, { size: 0.7 }))
}

function stadium(art: Artwork, paint: "connector", c: Mm, halfWidth: number, halfLength: number) {
  art.rect(paint, c.x - halfWidth, c.y - halfLength, c.x + halfWidth, c.y + halfLength, halfWidth)
}

function crystal(art: Artwork) {
  const { centre, base, flange, top, tab } = Q1
  art.rect("zone", centre.x - tab.halfWidth, base.y0 - tab.length, centre.x + tab.halfWidth, base.y0, 0.1)
  art.rect("zone", centre.x - tab.halfWidth, base.y1, centre.x + tab.halfWidth, base.y1 + tab.length, 0.1)
  art.rect("zone", centre.x - base.halfWidth, base.y0, centre.x + base.halfWidth, base.y1, base.corner)
  stadium(art, "connector", centre, flange.halfWidth, flange.halfLength)
  stadium(art, "connector", centre, top.halfWidth, top.halfLength)
  art.text("8.000", centre.x, centre.y, upward({ size: 0.4, muted: true }))
  art.text("Q1", 41.95, 22.2, upward(named(TITLE, { size: 0.7 })))
}

function usbSenseBridge(art: Artwork) {
  art.outline(48.75 + USBP_E_NUDGE, 4.5, 52.0 + USBP_E_NUDGE, 6.6, 0.3)
  art.rect("zone", USBP_E.x0 - 0.45, USBP_E.y - 0.5, USBP_E.x1 + 0.45, USBP_E.y + 0.5, 0.1)
  art.text("USBP_E", 51.0 + USBP_E_NUDGE, 10.5, upward(named(LEGEND, { size: 0.62 })))
}

function boardPrinting(middle: Artwork, bottom: Artwork) {
  middle.text("JTAG", 51.0, 19.7, upward(named(LEGEND, { size: 0.62 })))
  middle.rect("mark", 24.7, 24.1, 25.9, 25.2).rect("mark", 24.7, 26.4, 25.9, 27.5)
  middle.text("STM32-H103", 33.15, 24.6, TITLE).text("STM32-H405", 33.1, 26.85, TITLE)
  middle.text("Rev. C", 43.25, 25.9, LEGEND)
  const url = 33.1 + URL_CLEAR_OF_THE_BOX
  bottom.text("WWW.OLIMEX.COM", 24.85, url, URL).text("(C) 2013", 41.8, url, URL)
}

export function boardArt(names: PinNames): BodyShape[] {
  const art = new Artwork(FRAME)
  const middle = art.shifted(SHIFT.middle)
  const bottom = art.shifted(SHIFT.bottom)
  regulator(art)
  usbSenseBridge(art)
  usbB(middle)
  resetAndUserSwitches(middle)
  mcu(middle)
  crystal(middle)
  leadFreeRoundel(middle)
  jtagHeader(art.shifted(SHIFT.jtag))
  ledsAndBootBridges(bottom)
  pinOneMarkers(art, bottom)
  boardPrinting(middle, bottom)
  nameTables(art, names)

  const plate: BodyShape = { type: "rect", x: art.cellX(PLATE.x0), y: art.cellY(PLATE.y0), w: art.cells(PLATE.x1 - PLATE.x0), h: art.cells(PLATE.y1 - PLATE.y0), rx: art.cells(0.4), fill: "board" }
  return [plate, ...art.shapes()]
}
