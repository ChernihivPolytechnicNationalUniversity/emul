import { Artwork, type BoardFrame, type Mm, type MmBox, type TextStyle } from "../pcb-art"
import { CLEARANCE_CELLS, PRINTED_ADVANCE_EM, PRINTED_HALF_HEIGHT_EM } from "../printed-text"
import type { BodyShape } from "../types"

export const FRAME: BoardFrame = { originX: 0.05, originY: 0, cellsPerMm: 1 / 2.54 }
export const BOARD_MM = { w: 185, h: 135, corner: 11.5 }
const BOARD_BOX: MmBox = { x0: 0, y0: 0, x1: BOARD_MM.w, y1: BOARD_MM.h }
export const MODULE_AT: Mm = { x: 33.4, y: 15.15 }
const MODULE_MM = { w: 57.5, h: 83.0 }
export const PITCH = 2.54

export type Edge = "left" | "right" | "top" | "bottom"

export type Seat = { x: number; y: number; shift: Mm; edge?: Edge }

export const EDGE_CELLS: Record<Edge, number> = { left: 0, top: 0, right: 73, bottom: 53 }
export const EDGE_MARGIN_CELLS = 1

const exactCell = (mm: Mm) => ({ x: (mm.x + FRAME.originX) * FRAME.cellsPerMm, y: (mm.y + FRAME.originY) * FRAME.cellsPerMm })

export function cellAt(mm: Mm) {
  const cell = exactCell(mm)
  return { x: Math.round(cell.x * 100) / 100, y: Math.round(cell.y * 100) / 100 }
}

export const onModule = (mm: Mm): Mm => ({ x: MODULE_AT.x + mm.x, y: MODULE_AT.y + mm.y })

function seat(first: Mm, round: (v: number) => number = Math.round): Seat {
  const exact = exactCell(first)
  const x = round(exact.x)
  const y = Math.round(exact.y)
  return { x, y, shift: { x: (x - exact.x) * PITCH, y: (y - exact.y) * PITCH } }
}

function onEdge(edge: Edge, first: Mm, rowsIn = 0, round: (v: number) => number = Math.round): Seat {
  const exact = exactCell(first)
  const depth = EDGE_MARGIN_CELLS + rowsIn
  const across = edge === "left" || edge === "top" ? EDGE_CELLS[edge] + depth : EDGE_CELLS[edge] - depth
  const x = edge === "left" || edge === "right" ? across : round(exact.x)
  const y = edge === "top" || edge === "bottom" ? across : Math.round(exact.y)
  return { x, y, edge, shift: { x: (x - exact.x) * PITCH, y: (y - exact.y) * PITCH } }
}

export const SEATS = {
  usart3: onEdge("left", { x: 10.0, y: 16.01 }),
  can2: onEdge("left", { x: 10.0, y: 39.73 }),
  can1: onEdge("left", { x: 10.0, y: 55.03 }),
  i2c: onEdge("left", { x: 10.0, y: 71.45 }),
  dcmi: onEdge("left", { x: 3.25, y: 90.45 }),
  leftStrip: seat({ x: 25.35, y: 12.3 }),
  rightStrip: seat({ x: 96.8, y: 12.0 }),
  sdmmc: onEdge("top", { x: 39.35, y: 10.1 }, 0, Math.floor),
  qspi: onEdge("top", { x: 68.7, y: 10.1 }),
  rails: onEdge("top", { x: 94.0, y: 2.65 }),
  i2s: onEdge("top", { x: 136.2, y: 10.35 }),
  usart1Jmp: seat({ x: 112.1, y: 17.9 }),
  eth: onEdge("right", { x: 172.45, y: 36.2 }, 1),
  spi: onEdge("right", { x: 172.45, y: 68.0 }, 1),
  sai: onEdge("right", { x: 172.45, y: 93.5 }, 1),
  fmc: onEdge("bottom", { x: 30.0, y: 122.4 }, 1),
  ulpi: onEdge("bottom", { x: 63.9, y: 122.4 }, 1),
  cn2: seat({ x: 112.1, y: 47.65 }),
  cn3: seat({ x: 112.1, y: 70.6 }),
  cn1: seat({ x: 160.3, y: 38.5 }),
  cn4: seat({ x: 160.3, y: 65.6 }),
  icsp: seat({ x: 135.45, y: 83.3 }),
  dcJack: onEdge("top", { x: 33.9, y: 2.5 }),
} as const

export const FFC_PINS = { x: 35, rowA: 55, rowB: 56 }
const SAI_FIRST_PIN_MM = 93.5
const SAI_HEADER_TOP_MM = SAI_FIRST_PIN_MM - 1.3
const FFC_CORNER_MM = 0.3 * PITCH
const DC_JACK_DEPTH_MM = 10.2

const NAME: TextStyle = { size: 0.5, mono: true }
const TABLE: TextStyle = { size: 0.4, mono: true }
const PAD_NAME: TextStyle = { size: 0.34, mono: true, muted: true }
const CAPTION: TextStyle = { size: 0.45, muted: true }
const TITLE: TextStyle = { size: 0.8, muted: true }
const BOARD_NAME: TextStyle = { size: 2.6, muted: true }
const MARK_LETTER: TextStyle = { size: 0.75, muted: true }

const named = (style: TextStyle, extra: Partial<TextStyle>): TextStyle => ({ ...style, ...extra })

const mmOfCells = (cells: number) => cells / FRAME.cellsPerMm
const CLEAR_MM = mmOfCells(CLEARANCE_CELLS) * 1.05
const textMm = (text: string, style: TextStyle) => mmOfCells(text.length * PRINTED_ADVANCE_EM * style.size)
const halfHeightMm = (style: TextStyle) => mmOfCells(PRINTED_HALF_HEIGHT_EM * style.size)

function centreOfGrowth([low, high]: [number, number], [from, to]: [number, number]) {
  const factor = (high - low) / (to - from)
  return factor > 1 ? (low - from * factor) / (1 - factor) : (from + to) / 2
}

function nameColumn(a: Artwork, names: readonly string[], x: number, ys: readonly number[], style: TextStyle, towards: "left" | "right", room: [number, number]) {
  const longest = Math.max(...names.map((name) => textMm(name, style)))
  const span: [number, number] = towards === "right" ? [x, x + longest] : [x - longest, x]
  const growsFromX = centreOfGrowth(room, span)
  names.forEach((name, i) => a.text(name, x, ys[i], named(style, { anchor: towards === "right" ? "start" : "end", growsFrom: { x: growsFromX, y: ys[i] } })))
}

const PAD_DOT = 0.32
const JOY_ARROW_MM = 5.6
const JOY_LETTER_MM = 8.3

const rows = (from: number, count: number, step = PITCH) => Array.from({ length: count }, (_, i) => from + i * step)

const grid2 = (xs: readonly number[], ys: readonly number[]): Mm[] => ys.flatMap((y) => xs.map((x) => ({ x, y })))

function dots(a: Artwork, points: readonly Mm[]) {
  for (const p of points) a.circle("mark", p.x, p.y, PAD_DOT)
}

export const SMD_MM = { long: 1.6, short: 0.9 }

function smd(a: Artwork, x: number, y: number, vertical = false) {
  const [hw, hh] = vertical ? [SMD_MM.short / 2, SMD_MM.long / 2] : [SMD_MM.long / 2, SMD_MM.short / 2]
  a.rect("connector", x - hw, y - hh, x + hw, y + hh, 0.1)
}

export const PC13_LINK: Mm = { x: 62.75, y: 10.1 }
const R9_PADS_X = [106.95, 108.45]
const R9_PAD_MM = 0.7

function pinBox(a: Artwork, x0: number, y0: number, x1: number, y1: number, divider: { x?: number; y?: number }) {
  a.outline(x0, y0, x1, y1, 0.6)
  if (divider.y !== undefined) a.line([{ x: x0, y: divider.y }, { x: x1, y: divider.y }])
  if (divider.x !== undefined) a.line([{ x: divider.x, y: y0 }, { x: divider.x, y: y1 }])
}

function leftSocket(a: Artwork, caption: Artwork, names: readonly string[], y0: number, title: [string, number]) {
  const ys = rows(y0, names.length)
  const last = ys[ys.length - 1]
  pinBox(a, 8.75, ys[0] - 1.3, 11.25, last + 1.3, { y: last - 1.27 })
  names.forEach((name, i) => a.text(name, 11.8, ys[i], named(NAME, { anchor: "start" })))
  caption.text(title[0], 5.0, title[1], TITLE)
}

function rightSocket(a: Artwork, y0: number, count: number) {
  const ys = rows(y0, count)
  pinBox(a, 171.2, ys[0] - 1.3, 176.2, ys[ys.length - 1] + 1.3, { y: ys[0] + 1.27 })
  return ys
}

function topSocket(a: Artwork, x0: number, count: number, names: readonly string[]) {
  const xs = rows(x0, count)
  pinBox(a, xs[0] - 1.4, 8.9, xs[xs.length - 1] + 1.4, 11.45, { x: xs[0] + 1.27 })
  names.forEach((name, i) => a.text(name, xs[i], 11.95, named(NAME, { anchor: "end", rotate: -90 })))
}

function bottomSocket(a: Artwork, x0: number, table: { top: number; rowOne: readonly string[]; rowTwo: readonly string[]; split: number }) {
  const xs = rows(x0, 10)
  const left = xs[0] - 1.4
  const right = xs[9] + 1.4
  pinBox(a, left, 121.15, right, 126.25, { x: xs[9] - 1.27 })
  a.outline(left, table.top, right, 121.15, 0.6)
  a.line([{ x: table.split, y: table.top }, { x: table.split, y: 121.15 }]).line([{ x: left, y: 117.3 }, { x: table.split, y: 117.3 }])
  const column = named(TABLE, { rotate: -90 })
  table.rowOne.forEach((name, i) => a.text(name, xs[i], (table.top + 117.3) / 2, column))
  table.rowTwo.forEach((name, i) => {
    const lines = name.split(" ")
    const growsFrom = { x: xs[i], y: 119.25 }
    lines.forEach((line, k) => a.text(line, xs[i] + (k - (lines.length - 1) / 2) * 1.15, 119.25, lines.length > 1 ? named(column, { size: 0.34, growsFrom }) : column))
  })
  a.text("GND", xs[8], (table.top + 121.15) / 2, column).text("3.3V", xs[9], (table.top + 121.15) / 2, column)
}

function maleBlock(a: Artwork, xs: readonly number[], ys: readonly number[]) {
  a.rect("connector", xs[0] - 1.25, ys[0] - 1.25, xs[xs.length - 1] + 1.25, ys[ys.length - 1] + 1.25, 0.3)
}

function femaleColumn(a: Artwork, x: number, ys: readonly number[]) {
  a.rect("connector", x - 1.2, ys[0] - 1.25, x + 1.2, ys[ys.length - 1] + 1.25, 0.3)
}

function jumperBlock(a: Artwork, xs: [number, number], ys: readonly number[], left: readonly string[], right: readonly string[], title: string | null) {
  maleBlock(a, xs, ys)
  left.forEach((name, i) => a.text(name, xs[0] - 1.85, ys[i], named(NAME, { anchor: "end" })))
  right.forEach((name, i) => a.text(name, xs[1] + 1.85, ys[i], named(NAME, { anchor: "start" })))
  if (title) a.text(title, (xs[0] + xs[1]) / 2, ys[0] - 2.9, CAPTION)
}

const W_MARK: readonly Mm[] = [
  [130.45, 31.71], [130.64, 32.55], [131.99, 36.35], [132.61, 36.41], [132.94, 36.27], [133.61, 34.5], [133.78, 34.33], [134.7, 36.38], [135.24, 36.42], [135.45, 36.31],
  [136.19, 34.88], [136.47, 35.25], [136.56, 35.77], [136.84, 36.36], [137.8, 36.41], [137.97, 36.3], [138.74, 34.61], [139.04, 34.19], [139.51, 35.08], [139.05, 36.29],
  [138.57, 36.49], [138.6, 38.62], [138.82, 38.62], [140.25, 37.35], [140.16, 36.9], [141.06, 34.9], [139.51, 31.71], [139.25, 31.56], [138.69, 31.56], [138.47, 31.69],
  [137.38, 34.01], [137.18, 33.86], [136.86, 33.19], [137.28, 32.1], [137.4, 31.99], [137.6, 32.0], [137.68, 31.85], [137.71, 30.39], [137.57, 29.48], [136.93, 29.96],
  [135.85, 31.06], [135.78, 31.25], [135.96, 31.41], [135.94, 31.62], [135.38, 32.98], [135.12, 33.26], [134.94, 33.05], [134.44, 31.73], [134.21, 31.55], [133.62, 31.53],
  [133.38, 31.62], [132.7, 33.12], [132.53, 32.95], [131.99, 31.6], [130.66, 31.55],
].map(([x, y]) => ({ x, y }))

const W_MARK_CENTRE: Mm = { x: 135.75, y: 34.05 }

function wMark(a: Artwork, centre: Mm, scale: number, quarterTurns: number) {
  const turn = (p: Mm): Mm => {
    let x = (p.x - W_MARK_CENTRE.x) * scale
    let y = (p.y - W_MARK_CENTRE.y) * scale
    for (let i = 0; i < quarterTurns; i++) [x, y] = [-y, x]
    return { x: centre.x + x, y: centre.y + y }
  }
  a.polygon("mark", W_MARK.map(turn))
}

export type StripNames = { outer: readonly string[]; inner: readonly string[] }

const STRIP_NAME_GAP_MM = 1.75

function strip(a: Artwork, outerX: number, innerX: number, y0: number, names: StripNames, boxes: readonly number[], moduleEdge: number) {
  const ys = rows(y0, 36)
  const [xa, xb] = [Math.min(outerX, innerX), Math.max(outerX, innerX)]
  const x0 = xa - 1.25
  const x1 = xb + 1.25
  a.rect("connector", x0, ys[0] - 1.25, x1, ys[35] + 1.25, 0.3)
  for (const row of boxes) for (const edge of [-1.27, 1.27]) a.line([{ x: x0, y: ys[row] + edge }, { x: x1, y: ys[row] + edge }])
  const outerLeft = outerX < innerX
  names.outer.forEach((name, i) => a.text(name, outerX + (outerLeft ? -STRIP_NAME_GAP_MM : STRIP_NAME_GAP_MM), ys[i], named(NAME, { anchor: outerLeft ? "end" : "start" })))
  const inward = outerLeft ? "right" : "left"
  const room: [number, number] = outerLeft ? [x1 + CLEAR_MM, moduleEdge - CLEAR_MM] : [moduleEdge + CLEAR_MM, x0 - CLEAR_MM]
  nameColumn(a, names.inner, innerX + (outerLeft ? STRIP_NAME_GAP_MM : -STRIP_NAME_GAP_MM), ys, NAME, inward, room)
}

function soonRegion(a: Artwork, from: Mm, to: Mm, label: string): BodyShape {
  const x = a.cellX(from.x)
  const y = a.cellY(from.y)
  return { type: "soon", x, y, w: a.cellX(to.x) - x, h: a.cellY(to.y) - y, label, body: a.shapes() }
}

export type FfcNames = { rowA: readonly string[]; rowB: readonly string[] }

const FFC_NAME: TextStyle = { size: 0.3, mono: true }
const FFC_NAME_GAP_MM = 1.3

const FFC_DROP_MM = PITCH

function ffc(art: Artwork, names: FfcNames) {
  const pinX = (cell: number) => cell * PITCH - FRAME.originX
  const pinY = (cell: number) => cell * PITCH - FRAME.originY
  const zif = { left: 96.9, right: 126.6, top: 127.6 + FFC_DROP_MM, bottom: 133.6 + FFC_DROP_MM }
  const tail = { left: pinX(FFC_PINS.x) - 1.27, right: pinX(FFC_PINS.x + 19) + 1.27, bottom: pinY(FFC_PINS.rowB) + 2.3 }
  art.polygon("connector", [
    { x: zif.left, y: zif.top },
    { x: zif.right, y: zif.top },
    { x: zif.right, y: zif.bottom },
    { x: tail.right, y: zif.bottom },
    { x: tail.right, y: tail.bottom },
    { x: tail.left, y: tail.bottom },
    { x: tail.left, y: zif.bottom },
    { x: zif.left, y: zif.bottom },
  ], FFC_CORNER_MM)
  const marks = art.grouped()
  marks.text("1", 100.4, 130.6 + FFC_DROP_MM, TABLE).text("40", 123.0, 130.6 + FFC_DROP_MM, TABLE)
  const lines = art.grouped()
  const halfHeight = halfHeightMm(FFC_NAME)
  const above = pinY(FFC_PINS.rowA) - FFC_NAME_GAP_MM
  const below = pinY(FFC_PINS.rowB) + FFC_NAME_GAP_MM
  names.rowA.forEach((name, i) => lines.text(name, pinX(FFC_PINS.x + i), above, named(FFC_NAME, { growsFrom: { x: pinX(FFC_PINS.x + i), y: above + halfHeight } })))
  names.rowB.forEach((name, i) => lines.text(name, pinX(FFC_PINS.x + i), below, named(FFC_NAME, { growsFrom: { x: pinX(FFC_PINS.x + i), y: below - halfHeight } })))
}

function arrowhead(a: Artwork, centre: Mm, reach: number, quarterTurns: number) {
  const tip = [{ x: 0, y: -reach - 1.4 }, { x: 1.4, y: -reach }, { x: -1.4, y: -reach }]
  const turn = (p: Mm): Mm => {
    let { x, y } = p
    for (let i = 0; i < quarterTurns; i++) [x, y] = [-y, x]
    return { x: centre.x + x, y: centre.y + y }
  }
  a.polygon("mark", tip.map(turn))
}

export function boardArt(strips: { left: StripNames; right: StripNames }, ffcNames: FfcNames): BodyShape[] {
  const art = new Artwork(FRAME)
  const at = (s: Seat) => art.moved(s.shift)
  const onBoard = (s: Seat) => at(s).within(BOARD_BOX)
  const alongEdge = (s: Seat) => art.moved(s.edge === "left" || s.edge === "right" ? { x: 0, y: s.shift.y } : { x: s.shift.x, y: 0 }).within(BOARD_BOX)

  leftSocket(onBoard(SEATS.usart3), alongEdge(SEATS.usart3), ["CK", "RTS", "CTS", "TX", "RX", "GND", "3.3V"], 16.01, ["USART3", 34.4])
  leftSocket(onBoard(SEATS.can2), alongEdge(SEATS.can2), ["CANTX", "CANRX", "GND", "3.3V"], 39.73, ["CAN2", 50.6])
  leftSocket(onBoard(SEATS.can1), alongEdge(SEATS.can1), ["CANTX", "CANRX", "GND", "3.3V"], 55.03, ["CAN1", 65.9])

  {
    const a = onBoard(SEATS.i2c)
    const ys = rows(71.45, 5)
    pinBox(a, 8.75, ys[0] - 1.3, 13.8, ys[4] + 1.3, { y: ys[4] - 1.27 })
    ;["SMBA", "SCL", "SDA", "GND", "3.3V"].forEach((name, i) => a.text(name, 14.4, ys[i], named(NAME, { anchor: "start" })))
    a.text("I2C1", 10.0, 85.3, named(TABLE, { rotate: -90 })).text("I2C4", 12.55, 85.3, named(TABLE, { rotate: -90 }))
    alongEdge(SEATS.i2c).text("I2C", 8.0, 85.4, TITLE)
  }

  {
    const a = onBoard(SEATS.dcmi)
    const ys = rows(90.45, 12)
    a.outline(1.95, ys[0] - 1.3, 7.09, ys[11] + 1.3, 0.6)
    a.polygon("mark", [{ x: 5.0, y: 121.6 }, { x: 6.6, y: 121.6 }, { x: 5.8, y: 120.9 }])
    pinBox(a, 7.8, 89.0, 18.7, 119.6, { x: 12.75 })
    const even = ["D12", "D10", "D8", "PWDN", "D0", "D2", "D4", "D6", "XCLK", "HSYNC", "SIOD", "GND"]
    const odd = ["D13", "D11", "D9", "RESET", "D1", "D3", "D5", "D7", "PIXCLK", "VSYNC", "SIOC", "3.3V"]
    ys.forEach((y, i) => a.text(even[i], 10.25, y, TABLE).text(odd[i], 15.7, y, TABLE))
    alongEdge(SEATS.dcmi).text("DCMI", 4.0, 123.1, TITLE)
  }

  strip(at(SEATS.leftStrip), 25.35, 27.9, 12.3, strips.left, [0, 18], MODULE_AT.x - SEATS.leftStrip.shift.x)
  strip(at(SEATS.rightStrip), 99.35, 96.8, 12.0, strips.right, [17, 35], MODULE_AT.x + MODULE_MM.w - SEATS.rightStrip.shift.x)

  topSocket(onBoard(SEATS.sdmmc), 39.35, 9, ["3.3V", "GND", "D0", "CMD", "CLK", "D3", "D2", "D1", "CD"])
  art.text("SDMMC", 63.6, 4.4, named(TITLE, { rotate: -90 }))
  art.outline(60.9, 9.25, 64.6, 10.95, 0.3).grouped().text("PC13", PC13_LINK.x, 12.6, NAME)
  smd(art, PC13_LINK.x, PC13_LINK.y)
  topSocket(onBoard(SEATS.qspi), 68.7, 8, ["3.3V", "GND", "D0", "D1", "CLK", "CD", "D2", "D3"])
  alongEdge(SEATS.qspi).text("QUADSPI", 91.0, 6.3, named(TITLE, { rotate: 90 }))
  {
    const a = onBoard(SEATS.rails)
    const xs = rows(94.0, 4)
    const ys = rows(2.65, 3)
    maleBlock(a, xs, ys)
    for (const y of [3.92, 6.46]) a.line([{ x: 92.75, y }, { x: 102.87, y }])
    ;["5V", "GND", "3.3V"].forEach((name, i) => a.text(name, 104.3, ys[i], named(NAME, { anchor: "start" })))
  }

  art.within(BOARD_BOX).rect("connector", 21.0, -0.3, 24.8, 8.9, 0.3)
  const s2 = art.grouped()
  ;[["5VDC", 1.9], ["5Vin", 4.35], ["U5V", 6.8]].forEach(([name, y]) => s2.text(name as string, 20.3, y as number, named(NAME, { anchor: "end" })))
  art.text("5V DC", 27.2, 4.8, named(TITLE, { rotate: 90 }))
  onBoard(SEATS.dcJack).rect("connector", 30.0, -0.2, 36.0, DC_JACK_DEPTH_MM, 0.4)

  art.text("USART1", 123.7, 8.65, TITLE)
  smd(art, 122.8, 12.8, true)
  smd(art, 125.0, 12.8, true)
  art.rect("chip", 121.5, 17.9, 126.5, 22.9, 0.3).text("CP2102", 124.0, 20.4, { size: 0.32, inverse: true })
  for (let i = 0; i < 7; i++) {
    const down = 18.6 + i * 0.6
    const across = 122.2 + i * 0.6
    art.rect("mark", 121.1, down - 0.12, 121.5, down + 0.12).rect("mark", 126.5, down - 0.12, 126.9, down + 0.12)
    art.rect("mark", across - 0.12, 17.5, across + 0.12, 17.9).rect("mark", across - 0.12, 22.9, across + 0.12, 23.3)
  }
  for (const y of [17.7, 19.7, 21.7]) smd(art, 130.8, y)
  art.text("I2S", 131.0, 9.2, named(TITLE, { rotate: -90 }))

  {
    const a = onBoard(SEATS.i2s)
    a.text("I2S2", 131.2, 10.35, TABLE).text("I2S3", 131.2, 12.89, TABLE)
    pinBox(a, 134.9, 8.85, 155.35, 14.0, { x: 137.5 })
    a.outline(134.9, 14.0, 155.35, 21.65, 0.6)
    a.line([{ x: 140.05, y: 14.0 }, { x: 140.05, y: 21.65 }]).line([{ x: 145.15, y: 14.0 }, { x: 145.15, y: 21.65 }]).line([{ x: 140.05, y: 17.9 }, { x: 145.15, y: 17.9 }])
    const column = named(TABLE, { rotate: -90 })
    a.text("3.3V", 136.2, 17.8, column).text("GND", 138.75, 17.8, column)
    a.text("SDA", 141.3, 16.0, column).text("NC", 141.3, 19.8, column).text("SCL", 143.85, 16.0, column).text("NC", 143.85, 19.8, column)
    ;["I2S_CLK", "I2S_WS", "I2S_SD", "I2S_MCK"].forEach((name, i) => a.text(name, 146.4 + i * PITCH, 17.8, column))
  }

  jumperBlock(at(SEATS.usart1Jmp), [112.1, 114.7], rows(17.9, 4), ["PA9", "PA10", "PA11", "PA12"], ["TXD", "RXD", "CTS", "RTS"], "USART1 JMP")
  jumperBlock(art.grouped(), [161.45, 164.0], rows(17.9, 4), ["PB6", "PB7", "PH4", "PI8"], ["LED1", "LED2", "LED3", "LED4"], "LED JMP")
  const ledNames = art.grouped()
  rows(14.1, 7, 2.82).forEach((y, i) => {
    art.outline(174.55, y - 1.0, 178.65, y + 1.0, 0.3)
    smd(art, 172.0, y)
    ledNames.text(["PWR", "RXD", "TXD", "LED1", "LED2", "LED3", "LED4"][i], 180.0, y, named(NAME, { anchor: "start" }))
  })
  smd(art, 163.6, 32.95)

  wMark(art, W_MARK_CENTRE, 1, 0)
  art.text("®", 141.3, 30.45, CAPTION).text("Waveshare", 135.95, 40.45, { size: 0.75, muted: true })

  {
    const a = at(SEATS.cn2)
    const ys = rows(47.65, 8)
    femaleColumn(a, 112.1, ys)
    ;["NC", "IOREF", "NRST", "3.3V", "5V", "GND", "GND", "VIN"].forEach((name, i) => a.text(name, 114.0, ys[i], named(NAME, { anchor: "start" })))
    const [top, bottom] = [(ys[2] + ys[3]) / 2, ys[7] + 1.27]
    a.line([{ x: 113.7, y: top }, { x: 118.4, y: top }, { x: 118.4, y: 57.3 }]).line([{ x: 118.4, y: 63.5 }, { x: 118.4, y: bottom }, { x: 113.7, y: bottom }])
    a.text("POWER", 118.4, 60.4, named(CAPTION, { rotate: 90 }))
  }
  art.text("VIN JMP", 107.1, 63.6, CAPTION).outline(106.2, 64.8, 109.2, 66.2, 0.3)
  for (const x of R9_PADS_X) art.rect("connector", x - R9_PAD_MM / 2, 65.5 - R9_PAD_MM / 2, x + R9_PAD_MM / 2, 65.5 + R9_PAD_MM / 2, 0.1)
  {
    const a = at(SEATS.cn3)
    const ys = rows(70.6, 6)
    femaleColumn(a, 112.1, ys)
    ;["A0", "A1", "A2", "A3", "A4", "A5"].forEach((name, i) => a.text(name, 114.0, ys[i], named(NAME, { anchor: "start" })))
    a.line([{ x: 113.7, y: 68.3 }, { x: 118.4, y: 68.3 }, { x: 118.4, y: 74.6 }]).line([{ x: 118.4, y: 79.0 }, { x: 118.4, y: 85.3 }, { x: 113.7, y: 85.3 }])
    a.text("AIN", 118.4, 76.8, named(CAPTION, { rotate: 90 }))
  }
  jumperBlock(art.grouped(), [112.1, 114.7], rows(87.35, 3), ["PF6", "A4", "PB8"], ["PF7", "A5", "PB9"], null)

  const arduinoNames = art.grouped()
  rows(49.95, 7, 2.42).forEach((y, i) => {
    arduinoNames.text(["D13", "D10", "D8", "D6", "D4", "D2", "A1"][i], 133.9, y, named(NAME, { anchor: "end" }))
    smd(art, 136.6, y)
  })

  {
    const a = at(SEATS.cn1)
    const ys = rows(38.5, 10)
    femaleColumn(a, 160.3, ys)
    a.line([{ x: 159.1, y: ys[9] - 1.27 }, { x: 161.5, y: ys[9] - 1.27 }])
    ;["SCL/D15", "SDA/D14", "AVDD", "GND", "SCK/D13", "MISO/D12", "PWM/MOSI/D11", "PWM/CS/D10", "PWM/D9", "D8"].forEach((name, i) => a.text(name, 158.3, ys[i], named(NAME, { anchor: "end" })))
  }
  {
    const a = at(SEATS.cn4)
    const ys = rows(65.6, 8)
    femaleColumn(a, 160.3, ys)
    a.line([{ x: 159.1, y: ys[7] - 1.27 }, { x: 161.5, y: ys[7] - 1.27 }])
    ;["D7", "PWM/D6", "PWM/D5", "D4", "PWM/D3", "D2", "TX/D1", "RX/D0"].forEach((name, i) => a.text(name, 158.3, ys[i], named(NAME, { anchor: "end" })))
  }
  {
    const a = at(SEATS.icsp)
    const xs = rows(135.45, 3)
    maleBlock(a, xs, [83.3, 85.84])
    a.line([{ x: 136.73, y: 82.05 }, { x: 136.73, y: 84.57 }, { x: 134.2, y: 84.57 }])
    ;["NRST", "CLK", "MISO"].forEach((name, i) => a.text(name, xs[i], 81.3, named(TABLE, { anchor: "start", rotate: -90 })))
    ;["GND", "MOSI", "VCC"].forEach((name, i) => a.text(name, xs[i], 87.9, named(TABLE, { anchor: "end", rotate: -90 })))
    a.text("ICSP", 143.1, 86.0, named(CAPTION, { rotate: 90 }))
  }

  {
    const a = onBoard(SEATS.eth)
    const ys = rightSocket(a, 36.2, 7)
    const pinNumbers = (x: number) => named(TABLE, { growsFrom: { x, y: 34.0 + halfHeightMm(TABLE) } })
    a.text("1", 172.45, 34.0, pinNumbers(172.45)).text("2", 174.95, 34.0, pinNumbers(174.95))
    a.outline(162.8, 34.6, 170.8, 52.6, 0.6).line([{ x: 162.8, y: 40.0 }, { x: 170.8, y: 40.0 }]).line([{ x: 166.8, y: 40.0 }, { x: 166.8, y: 52.6 }])
    a.text("3.3V", 166.8, ys[0], TABLE).text("GND", 166.8, ys[1], TABLE)
    const refClk = named(TABLE, { size: 0.34, growsFrom: { x: 164.8, y: ys[3] } })
    a.text("MDIO", 164.8, ys[2], TABLE).text("REF", 164.8, ys[3] - 0.55, refClk).text("CLK", 164.8, ys[3] + 0.6, refClk)
    ;["RXD0", "TXEN", "TXD1"].forEach((name, i) => a.text(name, 164.8, ys[i + 4], TABLE))
    ;["MDC", "CRS", "RXD1", "TXD0", "NC"].forEach((name, i) => a.text(name, 168.8, ys[i + 2], TABLE))
    alongEdge(SEATS.eth).text("ETH", 179.5, 55.4, TITLE)
  }
  {
    const a = onBoard(SEATS.spi)
    const ys = rightSocket(a, 68.0, 6)
    ;["3.3V", "GND", "MISO", "MOSI", "SCK", "NSS"].forEach((name, i) => a.text(name, 170.6, ys[i], named(NAME, { anchor: "end" })))
    const caption = named(TABLE, { anchor: "end", rotate: -90 })
    const headerBottom = ys[5] + 1.3
    const saiHeaderTop = SAI_HEADER_TOP_MM + SEATS.sai.shift.y - SEATS.spi.shift.y
    const spi1 = centreOfGrowth([headerBottom + CLEAR_MM, saiHeaderTop - CLEAR_MM], [83.6, 86.7 + textMm("ADC+DAC", TABLE)])
    const underSpi1 = named(caption, { growsFrom: { x: 174.95, y: spi1 } })
    a.text("SPI2", 172.45, 83.6, caption).text("SPI1", 174.95, 83.6, underSpi1).text("ADC+DAC", 174.95, 86.7, underSpi1)
    alongEdge(SEATS.spi).text("SPI", 177.0, 84.4, TITLE)
  }
  {
    const a = onBoard(SEATS.sai)
    const ys = rightSocket(a, SAI_FIRST_PIN_MM, 8)
    a.outline(162.6, 92.0, 170.85, 113.0, 0.6)
    a.line([{ x: 162.6, y: 97.4 }, { x: 170.85, y: 97.4 }]).line([{ x: 162.6, y: 102.5 }, { x: 170.85, y: 102.5 }]).line([{ x: 166.6, y: 97.4 }, { x: 166.6, y: 102.5 }])
    a.text("3.3V", 166.7, ys[0], TABLE).text("GND", 166.7, ys[1], TABLE)
    a.text("NC", 164.6, ys[2], TABLE).text("NC", 164.6, ys[3], TABLE).text("SDA", 168.7, ys[2], TABLE).text("SCL", 168.7, ys[3], TABLE)
    ;["SAI1_SCK", "SAI1_FS", "SAI1_SD", "SAI1_MCLK"].forEach((name, i) => a.text(name, 166.7, ys[i + 4], TABLE))
    a.text("SAI1_A", 172.45, 113.7, named(TABLE, { anchor: "end", rotate: -90 })).text("SAI1_B", 174.95, 113.7, named(TABLE, { anchor: "end", rotate: -90 }))
    alongEdge(SEATS.sai).text("SAI1", 176.6, 116.6, TITLE)
  }

  bottomSocket(onBoard(SEATS.fmc), 30.0, { top: 113.4, split: 49.05, rowOne: ["D7", "D6", "D5", "D4", "D3", "D2", "D1", "D0"], rowTwo: ["NC", "NC", "A16", "A17", "R/B", "WE", "RE", "CE"] })
  art.text("8BIT FMC", 56.6, 125.8, named(TITLE, { rotate: -90 }))
  smd(art, 60.6, 124.1, true)
  bottomSocket(onBoard(SEATS.ulpi), 63.9, { top: 111.55, split: 82.95, rowOne: ["DATA0", "DATA1", "DATA2", "DATA3", "DATA4", "DATA5", "DATA6", "DATA7"], rowTwo: ["5V", "5V", "NC", "NC", "CLK OUT", "DIR", "NXT", "STP"] })
  art.text("ULPI", 89.8, 127.4, named(TITLE, { rotate: -90 }))

  ffc(art, ffcNames)

  art.text("Open7XXI-C", 87.5, 107.4, BOARD_NAME).text("Cortex-M7", 110.05, 122.2, named(BOARD_NAME, { size: 1.8 }))

  art.text("RESET", 21.9, 125.6, TITLE).text("WAKEUP", 133.55, 125.0, TITLE)
  smd(art, 22.6, 121.7)

  const joy = { x: 147.2, y: 125.35 }
  art.polygon("zone", [{ x: joy.x, y: joy.y - 5.2 }, { x: joy.x + 5.2, y: joy.y }, { x: joy.x, y: joy.y + 5.2 }, { x: joy.x - 5.2, y: joy.y }])
  const joyLetters = art.grouped()
  ;(["A", "B", "D", "C"] as const).forEach((letter, quarter) => {
    arrowhead(art, joy, JOY_ARROW_MM, quarter)
    const [dx, dy] = [[0, -1], [1, 0], [0, 1], [-1, 0]][quarter]
    joyLetters.text(letter, joy.x + dx * JOY_LETTER_MM, joy.y + dy * JOY_LETTER_MM, MARK_LETTER)
  })

  jumperBlock(art.grouped(), [161.2, 163.7], rows(119.8, 6), ["A", "B", "C", "D", "CTR", "WAKEUP"], ["PG2", "PG3", "PD4", "PD5", "PI11", "PA0"], "KEY JMP")
  for (const y of [129.2, 131.4, 133.5]) smd(art, 171.9, y)

  const lcd43 = new Artwork(FRAME)
  {
    const xs = rows(111.0, 20)
    lcd43.rect("connector", 109.6, 106.05, 160.5, 111.3, 0.3)
    dots(lcd43, grid2(xs, [107.4, 109.94]))
    "5V MISO SSEL GND NC R1 R3 R5 R7 G1 G3 G5 G7 B1 B3 B5 B7 NC VSYNC GND".split(" ").forEach((name, i) => lcd43.text(name, xs[i], 105.4, named(TABLE, { anchor: "start", rotate: -90 })))
    "IRQ MOSI SCK PWM BUSY R0 R2 R4 R6 G0 G2 G4 G6 B0 B2 B4 B6 DCLK HSYNC DE".split(" ").forEach((name, i) => lcd43.text(name, xs[i], 112.0, named(TABLE, { anchor: "end", rotate: -90 })))
  }
  const soonLcd = soonRegion(lcd43, { x: 108.8, y: 101.0 }, { x: 160.9, y: 115.7 }, "P14 4.3inch LCD")

  const plate: BodyShape = { type: "rect", x: art.cellX(0), y: art.cellY(0), w: art.cells(BOARD_MM.w), h: art.cells(BOARD_MM.h), rx: art.cells(BOARD_MM.corner), fill: "board" }
  return [plate, ...art.shapes(), soonLcd]
}

export const MODULE_COLUMNS = {
  leftOuter: "3.3V PH12 PB13 PB15 PD9 PD11 PD13 PD15 PG3 PG5 PG7 PC6 PC8 PA8 PA10 PA12 PH14 PI0 3.3V 3.3V PI2 PI3 PA15 PC11 PD0 PD2 PD4 PD6 PG9 PG11 PG13 PG15 PB4 PB6 BOOT0 PB9 PE1 PI4 PI6 GND",
  leftInner: "GND PB12 PB14 PD8 PD10 PD12 PD14 PG2 PG4 PG6 PG8 PC7 PC9 PA9 PA11 PA13 PH13 PH15 PI1 GND GND PA14 PC10 PC12 PD1 PD3 PD5 PD7 PG10 PG12 PG14 PB3 PB5 PB7 PB8 PE0 PDR PI5 PI7 5VOUT",
  rightInner: "PH11 PH9 PH7 PB11 PE15 PE13 PE11 PE9 PE7 PG0 PF14 PF12 PB2 PB0 PC4 PA6 PA4 PH5 GND GND PH3 PA2 PA0 VREF+ PC2 PC0 PH1 PF10 PF8 PF6 PF4 PF2 PF0 PI10 PC15 PC13 VBAT PE5 PE3 5Vin",
  rightOuter: "3.3V PH10 PH8 PH6 PB10 PE14 PE12 PE10 PE8 PG1 PF15 PF13 PF11 PB1 PC5 PA7 PA5 PA3 PH4 3.3V 3.3V PH2 PA1 PC3 PC1 RST PH0 PF9 PF7 PF5 PF3 PF1 PI11 PI9 PC14 PI8 PE6 PE4 PE2 GND",
}

const PAD_ROWS = rows(2.5, 40, 2.0)
const PAD_OUTLINE_MM = 0.85
const PAD_X = { leftOuter: 4.7, leftInner: 6.7, rightInner: 50.7, rightOuter: 52.7 }

const padAt = (column: keyof typeof MODULE_COLUMNS, name: string): Mm => ({ x: PAD_X[column], y: PAD_ROWS[MODULE_COLUMNS[column].split(" ").indexOf(name)] })

export const MODULE_PAD = { boot0: padAt("leftOuter", "BOOT0") }

const LQFP176_MM = { body: 24 / Math.SQRT2, leadTips: 26 / Math.SQRT2 }

const POWER_JMP_SILKSCREEN_CENTRE: Mm = { x: 14.3, y: 15.15 }

const powerJumper = (column: -1 | 1) => {
  const x = POWER_JMP_SILKSCREEN_CENTRE.x + (column * PITCH) / 2
  return { rail: { x, y: POWER_JMP_SILKSCREEN_CENTRE.y - PITCH / 2 }, pin: { x, y: POWER_JMP_SILKSCREEN_CENTRE.y + PITCH / 2 } }
}

export const POWER_JMP = { vbat: powerJumper(-1), vref: powerJumper(1) }

const PAD_NAME_GAP_MM = 1.05

function padColumn(a: Artwork, outer: number, inner: number, outerNames: string, innerNames: string, outerLeft: boolean, moduleEdge: number) {
  const padRows = PAD_ROWS
  const [x0, x1] = [Math.min(outer, inner) - PAD_OUTLINE_MM, Math.max(outer, inner) + PAD_OUTLINE_MM]
  a.outline(x0, 1.35, x1, 81.65, 0.4)
  for (const k of [0, 19, 20, 39]) a.line([{ x: x0, y: padRows[k] + (k % 20 === 0 ? 1.0 : -1.0) }, { x: x1, y: padRows[k] + (k % 20 === 0 ? 1.0 : -1.0) }])
  dots(a, grid2([outer, inner], padRows))
  const outward = outerLeft ? "left" : "right"
  const room: [number, number] = outerLeft ? [moduleEdge, x0 - CLEAR_MM] : [x1 + CLEAR_MM, moduleEdge]
  nameColumn(a, outerNames.split(" "), outer + (outerLeft ? -PAD_NAME_GAP_MM : PAD_NAME_GAP_MM), padRows, PAD_NAME, outward, room)
  innerNames.split(" ").forEach((name, i) => a.text(name, inner + (outerLeft ? PAD_NAME_GAP_MM : -PAD_NAME_GAP_MM), padRows[i], named(PAD_NAME, { anchor: outerLeft ? "start" : "end" })))
}

export function moduleArt(): BodyShape[] {
  const frame: BoardFrame = { ...FRAME, originX: FRAME.originX + MODULE_AT.x, originY: FRAME.originY + MODULE_AT.y }
  const art = new Artwork(frame)
  const plate: BodyShape = { type: "rect", x: art.cellX(0), y: art.cellY(0), w: art.cells(MODULE_MM.w), h: art.cells(MODULE_MM.h), rx: art.cells(0.6), fill: "zone" }

  padColumn(art.grouped(), PAD_X.leftOuter, PAD_X.leftInner, MODULE_COLUMNS.leftOuter, MODULE_COLUMNS.leftInner, true, 0)
  padColumn(art.grouped(), PAD_X.rightOuter, PAD_X.rightInner, MODULE_COLUMNS.rightOuter, MODULE_COLUMNS.rightInner, false, MODULE_MM.w)

  const jtag = new Artwork(frame)
  jtag.rect("connector", 11.8, -0.4, 45.0, 8.6, 0.4)
  dots(jtag, grid2(rows(16.55, 10), [2.85, 5.39]))
  const soonJtag = soonRegion(jtag, { x: 11.2, y: -0.6 }, { x: 45.6, y: 8.85 }, "JTAG/SWD")
  art.text("JTAG/SWD", 29.0, 10.8, { size: 0.7, muted: true })

  const { vbat, vref } = POWER_JMP
  maleBlock(art, [vbat.pin.x, vref.pin.x], [vbat.rail.y, vbat.pin.y])
  art.grouped()
    .text("3.3V", POWER_JMP_SILKSCREEN_CENTRE.x, vbat.rail.y - 1.8, named(TABLE, { anchor: "end", rotate: 90 }))
    .text("VBAT", vbat.pin.x, vbat.pin.y + 1.8, named(TABLE, { anchor: "start", rotate: 90 }))
    .text("VREF+", vref.pin.x, vref.pin.y + 1.8, named(TABLE, { anchor: "start", rotate: 90 }))
  art.text("POWER JMP", 18.2, POWER_JMP_SILKSCREEN_CENTRE.y, named(CAPTION, { rotate: 90 }))

  wMark(art, { x: 41.4, y: 16.6 }, 0.58, 1)
  art.text("Waveshare", 37.6, 16.5, { size: 0.42, rotate: 90, muted: true }).text("®", 44.4, 20.4, { size: 0.36, muted: true })

  const chip = { x: 29.3, y: 33.8 }
  const diamond = (half: number) => [{ x: chip.x, y: chip.y - half }, { x: chip.x + half, y: chip.y }, { x: chip.x, y: chip.y + half }, { x: chip.x - half, y: chip.y }]
  const leadsLeaveTheCorners = (lead: number, body: number) => {
    const cut = lead - body
    return [[0, -1], [1, 0], [0, 1], [-1, 0]].flatMap(([dx, dy]) => [
      { x: chip.x + dx * body + dy * cut, y: chip.y + dy * body - dx * cut },
      { x: chip.x + dx * body - dy * cut, y: chip.y + dy * body + dx * cut },
    ])
  }
  art.polygon("zone", leadsLeaveTheCorners(LQFP176_MM.leadTips, LQFP176_MM.body)).polygon("chip", diamond(LQFP176_MM.body))
  art.text("STM32F746IGT6", chip.x, chip.y - 0.8, { size: 0.62, inverse: true }).text("LQFP176 · 216 MHz", chip.x, chip.y + 1.6, { size: 0.4, inverse: true })

  art.text("Core7XXI", 14.3, 51.9, named(BOARD_NAME, { size: 1.9, rotate: -90 }))

  art.rect("connector", 19.2, 63.4, 27.3, 66.4, 0.25)
  art.text("FLASH", 18.25, 64.5, named(TABLE, { rotate: 90 })).text("SYSTEM", 28.4, 64.0, named(TABLE, { rotate: 90 })).text("BOOT CONFIG", 30.6, 63.2, named(CAPTION, { rotate: 90 }))
  smd(art, 21.9, 58.9, true)

  maleBlock(art, [33.0, 35.5, 38.0], [63.6, 66.14])
  const otg = art.grouped()
  ;["PA9", "PE2", "PE3"].forEach((name, i) => otg.text(name, 33.0 + i * 2.5, 61.5, named(TABLE, { anchor: "end", rotate: 90 })))
  const underTheCaps = named(TABLE, { anchor: "start", rotate: 90, growsFrom: { x: 35.5, y: 68.3 } })
  otg.text("VBUS", 33.0, 68.3, underTheCaps).text("PWR", 36.15, 68.3, underTheCaps).text("OUT", 34.85, 68.3, underTheCaps).text("FLG", 38.0, 68.3, underTheCaps)
  art.text("OTG JMP", 40.8, 64.0, named(CAPTION, { rotate: 90 }))

  art.outline(11.4, 67.0, 20.6, 81.35, 0.4).text("USB", 14.3, 66.0, CAPTION).text("5Vin", 14.3, 82.28, CAPTION)
  art.rect("connector", 11.6, 67.6, 16.8, 81.2, 0.3)

  art.outline(21.6, 73.8, 23.6, 76.2, 0.3).text("PWR LED", 24.6, 74.7, named(CAPTION, { size: 0.36, rotate: 90 }))
  smd(art, 22.6, 79.8, true)
  art.outline(35.0, 73.0, 37.1, 77.6, 0.3).text("VBUS LED", 34.0, 75.3, named(CAPTION, { size: 0.36, rotate: 90 }))
  smd(art, 36.1, 79.75, true)
  art.text("RESET", 38.9, 75.25, named(CAPTION, { rotate: 90 }))
  smd(art, 45.65, 77.4, true)

  return [plate, ...art.shapes(), soonJtag]
}
