import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SOON_BLUR_CELLS, textBoost } from "@/components/field/body-paint"
import { fieldDetail } from "@/components/field/detail"
import { pinLabels } from "@/components/field/pin-label"
import { PinLayer } from "@/components/field/PinLayer"
import { crossedBy, printedNameBox, printedNameLayout, printedNames, printedNameSize } from "@/components/field/printed-names"
import { sheetTexts } from "@/components/field/symbol-raster"
import { cellAt, EDGE_MARGIN_CELLS, FRAME, MODULE_AT, MODULE_COLUMNS, MODULE_PAD, onModule, SMD_MM, type Edge } from "@/schematic/components/open746i-c-art"
import { bodyBounds } from "@/schematic/body"
import { examples } from "@/schematic/examples"
import { objectPins, routeAll, UPRIGHT, type Point } from "@/schematic/geometry"
import { pinContacts } from "@/schematic/contacts"
import { blocksOf, boxesMeet, boxInside, boxMeetsPolygon, homeOf, isPrintedName, marksOf, MAX_PRINTED_GROWTH, partBox, pointInPolygon, printedBox, printedGrowth, ruleCrossesBox, rulesOf, switchContacts, type Box } from "@/schematic/printed-text"
import { getDef, registry } from "@/schematic/registry"
import type { BodyShape, Element, Fill, PartDef, PlacedObject } from "@/schematic/types"

const board = getDef("open746i-c")!
const MM_PER_CELL = 2.54
const HEADER_ROUNDING_MM = 1.35
const GRID = 24
const USB_BOOT_CELLS = 1.4
const USB_CABLE_CELLS = 6
const USB_CABLE_WIDTH_CELLS = 0.3

const toMm = (cell: number, origin: number) => cell * MM_PER_CELL - origin
const pin = (id: string) => board.pins.find((p) => p.id === id)!
const part = (id: string) => board.parts.find((p) => p.id === id)!

const AS_PHOTOGRAPHED: Record<string, [number, number]> = {
  "P20-1": [25.35, 12.3],
  "P20-2": [27.9, 12.3],
  "P19-35": [99.35, 12.0],
  "P19-36": [96.8, 12.0],
  "P18-1": [99.35, 100.9],
  "VCP-TX": [114.7, 17.9],
  "VCP-RX": [114.7, 20.44],
  "CN2-1": [112.1, 47.65],
  "CN3-1": [112.1, 70.6],
  "CN1-10": [160.3, 38.5],
  "CN1-1": [160.3, 61.36],
  "CN4-8": [160.3, 65.6],
  "CN4-1": [160.3, 83.38],
  "CN5-5": [135.45, 83.3],
  "CN5-2": [140.53, 85.84],
}

const ON_THE_EDGE: Record<string, { edge: Edge; at: [number, number] }> = {
  P2: { edge: "left", at: [10.0, 16.01] },
  P8: { edge: "left", at: [10.0, 39.73] },
  P7: { edge: "left", at: [10.0, 55.03] },
  P4: { edge: "left", at: [10.0, 71.45] },
  P13: { edge: "left", at: [3.25, 90.45] },
  P6: { edge: "top", at: [39.35, 10.1] },
  P3: { edge: "top", at: [68.7, 10.1] },
  P22: { edge: "top", at: [94.0, 2.65] },
  P5: { edge: "top", at: [136.2, 10.35] },
  P11: { edge: "right", at: [174.95, 36.2] },
  P1: { edge: "right", at: [174.95, 68.0] },
  P9: { edge: "right", at: [174.95, 93.5] },
  P12: { edge: "bottom", at: [30.0, 124.94] },
  P10: { edge: "bottom", at: [63.9, 124.94] },
}

type Text = Extract<BodyShape, { type: "text" }>

const soons = board.body.filter((s): s is Extract<BodyShape, { type: "soon" }> => s.type === "soon")
const flat = (shapes: readonly BodyShape[]): BodyShape[] => shapes.flatMap((s) => (s.type === "soon" ? flat(s.body) : [s]))
const texts = flat(board.body).filter((s): s is Text => s.type === "text")
const printed = board.body.filter((s): s is Text => s.type === "text")
const growth = printedGrowth(board)
const grow = (t: Text) => growth.get(t) ?? 1
const fillsOf = (shapes: readonly BodyShape[]) => new Set(flat(shapes).flatMap((s): Fill[] => (s.type !== "text" && s.type !== "soon" && s.fill ? [s.fill] : [])))
const subpathsOf = (shape: BodyShape) => (shape.type === "art" ? shape.d.split(/(?=M)/) : [])
const CIRCLE = /^M[-\d.]+ [-\d.]+A([\d.]+) \1 0 1 0 /
const circleRadii = board.body.flatMap(subpathsOf).flatMap((sub) => CIRCLE.exec(sub)?.[1] ?? []).map(Number)
const boxOf = (d: string) => bodyBounds({ ...board, body: [{ type: "art", d, fill: "connector" }], pins: [] })
const outline = board.body.find((s): s is Extract<BodyShape, { type: "rect" }> => s.type === "rect" && s.fill === "board")!
const blocks = blocksOf(board.body)
const plates = blocks.filter((b) => b.fill === "board" || (b.fill === "zone" && b.box.w > 20))
const solids = blocks.filter((b) => !plates.includes(b))
const at = (box: Box) => `${box.x.toFixed(1)}, ${box.y.toFixed(1)}`

const sameCentre = (a: Box, b: Box) => Math.abs(a.x + a.w / 2 - b.x - b.w / 2) < 0.01 && Math.abs(a.y + a.h / 2 - b.y - b.h / 2) < 0.01
const polygonsMeet = (a: readonly Point[], b: readonly Point[]) => a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a))
const partFootprints = board.parts.flatMap((p) => {
  const box = partBox(p)
  return box ? [{ id: p.id, box, centre: { x: p.x, y: p.y }, contacts: p.type === "switch" ? switchContacts(p).slice(0, 2) : [] }] : []
})
const shareAContact = (a: (typeof partFootprints)[number], b: (typeof partFootprints)[number]) => a.contacts.some((p) => b.contacts.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.01))
const soonBoxes = soons.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h }))
const silkscreenLines = rulesOf(board.body)

function clashes(factor: (t: Text) => number): string[] {
  const issues: string[] = []
  const boxes = printed.map((t) => printedBox(t, factor(t)))
  printed.forEach((t, i) => {
    const box = boxes[i]
    const where = `"${t.text}" at ${t.x}, ${t.y}`
    const home = homeOf(blocks, t)
    if (home && !boxInside(box, home.points)) issues.push(`${where} leaves its ${home.fill}`)
    for (const b of solids) if (b !== home && !pointInPolygon(t, b.points) && boxMeetsPolygon(box, b.points)) issues.push(`${where} on the ${b.fill} at ${at(b.box)}`)
    for (const r of soonBoxes) if (boxesMeet(box, r)) issues.push(`${where} under a soon badge`)
    for (const p of partFootprints) if (boxesMeet(box, p.box)) issues.push(`${where} on ${p.id}`)
    for (const mark of marksOf(board.body)) if (boxMeetsPolygon(box, mark)) issues.push(`${where} on a mark`)
    for (const q of board.pins) if (boxesMeet(box, { x: q.x - 0.25, y: q.y - 0.25, w: 0.5, h: 0.5 })) issues.push(`${where} on pin ${q.id}`)
    for (const line of silkscreenLines) if (ruleCrossesBox(line, box)) issues.push(`${where} across the silkscreen line ${at({ x: line[0].x, y: line[0].y, w: 0, h: 0 })}–${at({ x: line[1].x, y: line[1].y, w: 0, h: 0 })}`)
    for (let j = i + 1; j < printed.length; j++) if (boxesMeet(box, boxes[j])) issues.push(`${where} on "${printed[j].text}" at ${printed[j].x}, ${printed[j].y}`)
  })
  return issues
}

describe("the Open746I-C is drawn as photographed", () => {
  it("to scale: the 185 × 135 mm board is 185 × 135 mm on the field, with 11.5 mm corners", () => {
    expect(outline.w * MM_PER_CELL).toBeCloseTo(185, 1)
    expect(outline.h * MM_PER_CELL).toBeCloseTo(135, 1)
    expect((outline.rx ?? 0) * MM_PER_CELL).toBeCloseTo(11.5, 1)
    expect(board.width).toBeGreaterThanOrEqual(outline.x + outline.w)
    expect(board.height).toBeGreaterThanOrEqual(bodyBounds(board).y + bodyBounds(board).h)
  })

  it.each(Object.entries(AS_PHOTOGRAPHED))("%s, inside the board, sits where the photo has it, the header moved onto the grid as a whole", (id, [x, y]) => {
    const p = pin(id)
    expect(Number.isInteger(p.x) && Number.isInteger(p.y), `${id} on the grid`).toBe(true)
    expect(Math.abs(toMm(p.x, FRAME.originX) - x), `${id} x`).toBeLessThanOrEqual(HEADER_ROUNDING_MM)
    expect(Math.abs(toMm(p.y, FRAME.originY) - y), `${id} y`).toBeLessThanOrEqual(HEADER_ROUNDING_MM)
  })

  it("pin 1 is where the board marks it: USART3, CAN and I2C count up from the bottom, DCMI from the bottom right, the Arduino D rows from the bottom", () => {
    expect(pin("P2-1").y).toBeGreaterThan(pin("P2-7").y)
    expect(pin("P8-1").y).toBeGreaterThan(pin("P8-4").y)
    expect(pin("P4-1").y).toBeGreaterThan(pin("P4-9").y)
    expect(pin("P4-1").x).toBeGreaterThan(pin("P4-2").x)
    expect(pin("P13-1").y).toBeGreaterThan(pin("P13-23").y)
    expect(pin("P13-1").x).toBeGreaterThan(pin("P13-2").x)
    expect(pin("CN1-1").y).toBeGreaterThan(pin("CN1-10").y)
    expect(pin("CN4-1").y).toBeGreaterThan(pin("CN4-8").y)
    expect(pin("P12-1").x).toBeGreaterThan(pin("P12-19").x)
    expect(pin("P5-1").y).toBeGreaterThan(pin("P5-2").y)
  })

  it("every name is printed by the board, none drawn again by the field: BOOT0 is the module pad's own silkscreen", () => {
    expect(pinLabels(board, UPRIGHT)).toEqual([])
    expect(board.pins.filter((p) => !p.printed).map((p) => p.id)).toEqual([])
  })

  it("the silkscreen carries every header's names, the titles and the Waveshare mark", () => {
    const words = new Set(texts.map((t) => t.text))
    for (const text of ["Open7XXI-C", "Cortex-M7", "Core7XXI", "Waveshare", "USART3", "CAN1", "CAN2", "I2C", "DCMI", "SDMMC", "QUADSPI", "USART1", "I2S", "ETH", "SPI", "SAI1", "8BIT FMC", "ULPI", "RESET", "WAKEUP", "KEY JMP", "LED JMP", "USART1 JMP", "BOOT CONFIG", "OTG JMP", "POWER JMP", "JTAG/SWD", "PWM/MOSI/D11", "SAI1_MCLK", "PIXCLK", "VIN JMP", "ADC+DAC"]) expect(words.has(text), text).toBe(true)
    expect(board.body.some((s) => s.type === "art" && !s.fill && s.muted), "the W mark, in muted ink").toBe(true)
  })

  it("each header name is the one the board prints under its pin: QUADSPI pin 6 reads CD, as photographed, not the CS its signal would suggest", () => {
    const under = (id: string) => texts.find((t) => t.mono && Math.abs(t.x - pin(id).x) < 0.3 && t.y > pin(id).y && t.y - pin(id).y < 1.2)?.text
    expect(["P3-1", "P3-2", "P3-3", "P3-4", "P3-5", "P3-6", "P3-7", "P3-8"].map(under)).toEqual(["3.3V", "GND", "D0", "D1", "CLK", "CD", "D2", "D3"])
    expect(["P6-1", "P6-4", "P6-9"].map(under)).toEqual(["3.3V", "CMD", "CD"])
  })

  it("the silkscreen is ordinary text at the board's own scale: pin names in the pin names' face, never turned past a quarter", () => {
    expect(texts.length).toBeGreaterThan(500)
    for (const t of texts) {
      expect(t.printed, t.text).toBe(true)
      expect([undefined, 90, -90], t.text).toContain(t.rotate)
    }
    for (const name of ["PH12", "CANTX", "SCL/D15", "PIXCLK", "BOOT0"]) expect(texts.find((t) => t.text === name)?.mono, name).toBe(true)
    for (const title of ["USART3", "Open7XXI-C", "KEY JMP"]) expect(texts.find((t) => t.text === title)?.mono, title).toBeFalsy()
  })

  it("only what emul does not model is blurred under a soon badge: JTAG/SWD and the 4.3inch LCD header, never a working pin", () => {
    expect(soons.map((s) => s.label).sort()).toEqual(["JTAG/SWD", "P14 4.3inch LCD"])
    expect(SOON_BLUR_CELLS).toBeGreaterThan(0)
    expect(sheetTexts(board).filter((t) => t.text === "soon")).toHaveLength(soons.length)
    for (const soon of soons) {
      expect(soon.body.length, soon.label).toBeGreaterThan(0)
      const inside = board.pins.filter((p) => p.x > soon.x && p.x < soon.x + soon.w && p.y > soon.y && p.y < soon.y + soon.h)
      expect(inside.map((p) => p.id), `${soon.label} hides no working pin`).toEqual([])
    }
    expect(soons.find((s) => s.label.startsWith("P14"))!.body.flatMap((s) => (s.type === "text" ? [s.text] : []))).toEqual(expect.arrayContaining(["VSYNC", "DCLK", "IRQ"]))
  })

  it("the module's two 2 × 40 pad rows (P16, P17) are drawn plainly: they are the nets the strips P18–P21 bring out", () => {
    const io = (names: string) => names.split(" ").filter((name) => /^P[A-I]\d+$/.test(name))
    const pads = new Set(Object.values(MODULE_COLUMNS).flatMap(io))
    const strips = new Set(board.pins.filter((p) => /^P(18|19|20|21)-/.test(p.id) && p.mcu).map((p) => p.mcu!))
    expect(pads.size).toBe(140)
    expect([...pads].sort()).toEqual([...strips].sort())
    const rows = [[3.55, 7.85], [49.55, 53.85]].map(([x0, x1]) => ({ from: cellAt(onModule({ x: x0, y: 1.35 })), to: cellAt(onModule({ x: x1, y: 81.65 })) }))
    for (const soon of soons)
      for (const row of rows) {
        const apart = soon.x >= row.to.x || soon.x + soon.w <= row.from.x || soon.y >= row.to.y || soon.y + soon.h <= row.from.y
        expect(apart, `${soon.label} covers no pad row`).toBe(true)
      }
  })
})

describe("headers stand one cell in from the board's edge, facing it (the user's review, 2026-10-13)", () => {
  const edgeOf = (edge: Edge, p: { x: number; y: number }) =>
    edge === "left" ? p.x - outline.x : edge === "right" ? outline.x + outline.w - p.x : edge === "top" ? p.y - outline.y : outline.y + outline.h - p.y

  it.each(Object.entries(ON_THE_EDGE))("%s: its outer row one cell inside the outline, its pins leaving through that edge", (connector, { edge }) => {
    const pins = board.pins.filter((p) => p.connector === connector)
    expect(pins.length, connector).toBeGreaterThan(0)
    const nearest = Math.min(...pins.map((p) => edgeOf(edge, p)))
    expect(nearest, `${connector} margin`).toBeGreaterThanOrEqual(EDGE_MARGIN_CELLS - 0.16)
    expect(nearest, `${connector} margin`).toBeLessThanOrEqual(EDGE_MARGIN_CELLS + 0.16)
    for (const p of pins) expect(p.side, p.id).toBe(edge)
  })

  it("every header on one edge stands the same distance in, and the four edges differ only by the board not being a whole number of cells", () => {
    const margins = new Map<Edge, Set<number>>()
    for (const [connector, { edge }] of Object.entries(ON_THE_EDGE)) {
      const nearest = Math.min(...board.pins.filter((p) => p.connector === connector).map((p) => edgeOf(edge, p)))
      margins.set(edge, (margins.get(edge) ?? new Set()).add(Math.round(nearest * 100) / 100))
    }
    for (const [edge, set] of margins) expect(set.size, edge).toBe(1)
    expect(Math.abs(outline.w - Math.round(outline.w)) + Math.abs(outline.h - Math.round(outline.h))).toBeGreaterThan(0.1)
  })

  it.each(Object.entries(ON_THE_EDGE))("%s keeps the photo's place along its edge: moved across it only, so the tolerance above holds along the edge alone", (connector, { edge, at: [x, y] }) => {
    const pins = board.pins.filter((p) => p.connector === connector)
    const along = edge === "left" || edge === "right" ? (p: { y: number }) => toMm(p.y, FRAME.originY) - y : (p: { x: number }) => toMm(p.x, FRAME.originX) - x
    expect(Math.min(...pins.map((p) => Math.abs(along(p)))), connector).toBeLessThanOrEqual(HEADER_ROUNDING_MM)
  })

  it("nothing of a header crosses the outline: the silkscreen boxes and names stay on the board", () => {
    const headerTexts = printed.filter((t) => t.mono && homeOf(blocks, t)?.fill === "board")
    for (const t of headerTexts) expect(boxInside(printedBox(t), plates.find((p) => p.fill === "board")!.points), t.text).toBe(true)
  })
})

describe("no two blocks overlap, and no block runs into a name (the 5V DC jack, 2026-10-13)", () => {
  it("no connector, chip or zone overlaps another, except a chip on its own zone", () => {
    const issues: string[] = []
    for (let i = 0; i < solids.length; i++)
      for (let j = i + 1; j < solids.length; j++)
        if (!sameCentre(solids[i].box, solids[j].box) && boxesMeet(solids[i].box, solids[j].box) && polygonsMeet(solids[i].points, solids[j].points)) issues.push(`${solids[i].fill} at ${at(solids[i].box)} / ${solids[j].fill} at ${at(solids[j].box)}`)
    expect(issues).toEqual([])
  })

  it("no part lands on a block it does not sit in, on another part or under a soon badge", () => {
    const issues: string[] = []
    for (const p of partFootprints) {
      for (const b of solids) if (boxMeetsPolygon(p.box, b.points) && !pointInPolygon(p.centre, b.points)) issues.push(`${p.id} on the ${b.fill} at ${at(b.box)}`)
      for (const r of soonBoxes) if (boxesMeet(p.box, r)) issues.push(`${p.id} under a soon badge`)
    }
    for (let i = 0; i < partFootprints.length; i++)
      for (let j = i + 1; j < partFootprints.length; j++)
        if (!shareAContact(partFootprints[i], partFootprints[j]) && boxesMeet(partFootprints[i].box, partFootprints[j].box)) issues.push(`${partFootprints[i].id} on ${partFootprints[j].id}`)
    expect(issues).toEqual([])
  })

  it("every name and title is clear of every block, part, mark, pin and other text, at the size the board prints it", () => {
    expect(clashes(() => 1)).toEqual([])
  })

  it("a USB part's footprint is all it draws, its cable included, so the board's title is clear of the module's OTG cable (review, 2026-10-13)", () => {
    const cableReach = USB_BOOT_CELLS + USB_CABLE_CELLS + USB_CABLE_WIDTH_CELLS / 2
    for (const id of ["USB", "MUSB"]) {
      const usb = part(id) as Extract<PartDef, { type: "usb" }>
      const box = partBox(usb)!
      const reach = usb.side === "bottom" ? box.y + box.h - usb.y : usb.y - box.y
      expect(reach, `${id} reaches the end of its cable`).toBeCloseTo(cableReach, 6)
    }
    const cable = partBox(part("MUSB"))!
    const title = printed.find((t) => t.text === "Open7XXI-C")!
    for (const factor of [1, grow(title)]) expect(boxesMeet(printedBox(title, factor), cable), `title at ${factor}×`).toBe(false)
  })

  it("the DC jack stops short of the left strip's names and of SDMMC's", () => {
    const jack = solids.filter((b) => b.fill === "connector" && pointInPolygon(pin("5VDC"), b.points))
    expect(jack).toHaveLength(1)
    for (const name of ["PB12", "PH12", "3.3V"]) {
      const near = printed.filter((t) => t.text === name && Math.hypot(t.x - pin("5VDC").x, t.y - pin("5VDC").y) < 8)
      for (const t of near) expect(boxMeetsPolygon(printedBox(t), jack[0].points), `${name} at ${t.x}, ${t.y}`).toBe(false)
    }
  })
})

describe("P15, the 7inch LCD's FFC, hangs clear below the board (2026-10-13)", () => {
  const ffc = solids.find((b) => b.fill === "connector" && board.pins.filter((p) => p.connector === "P15").every((p) => pointInPolygon(p, b.points)))!

  it("one rounded connector holds all forty lines, in the two rows the module's tail lands on, a row further out than before", () => {
    const lines = board.pins.filter((p) => p.connector === "P15")
    expect(lines).toHaveLength(40)
    expect(ffc).toBeDefined()
    expect(new Set(lines.filter((p) => (p.connectorPin ?? 0) <= 20).map((p) => p.y))).toEqual(new Set([55]))
    expect(new Set(lines.filter((p) => (p.connectorPin ?? 0) > 20).map((p) => p.y))).toEqual(new Set([56]))
    expect(Math.min(...lines.map((p) => p.y)) - (outline.y + outline.h)).toBeGreaterThan(1.5)
    const d = board.body.filter((s) => s.type === "art" && s.fill === "connector").flatMap(subpathsOf).find((sub) => boxOf(sub).w > 15)!
    const radii = [...d.matchAll(/A([\d.]+) /g)].map((m) => Number(m[1]))
    expect(radii.length, "every corner of the tab is rounded").toBe(8)
    for (const r of radii) expect(r).toBeCloseTo(0.3, 1)
  })

  it("its tail starts below the board's edge and clears WAKEUP, the joystick and ULPI", () => {
    const tail = ffc.points.filter((p) => p.y > outline.y + outline.h)
    expect(tail.length).toBeGreaterThan(0)
    for (const id of ["WAKEUP", "JOY_C", "JOY_D"]) expect(boxMeetsPolygon(partBox(part(id))!, ffc.points), id).toBe(false)
    const ulpi = board.pins.filter((p) => p.connector === "P10")
    for (const p of ulpi) expect(pointInPolygon({ x: p.x, y: p.y + 3 }, ffc.points), `${p.id}'s wire leaves past the tab`).toBe(false)
  })

  it("the board prints each FFC line's name level, above the first row and below the second, narrower than the pitch so no two meet", () => {
    for (const line of board.pins.filter((p) => p.connector === "P15")) {
      const name = texts.find((t) => t.text === line.label && Math.abs(t.x - line.x) < 0.01 && Math.abs(t.y - line.y) < 1)
      expect(name, line.id).toBeDefined()
      expect(name!.rotate, line.id).toBeUndefined()
      expect(Math.sign(name!.y - line.y), line.id).toBe(line.y === 55 ? -1 : 1)
      expect(line.label.length * 0.6 * (name!.size ?? 0.4), line.id).toBeLessThan(1)
    }
  })

  it("the LCD docks on it: in every example that carries the panel, all forty of its lines touch P15's", () => {
    for (const example of examples.filter((e) => e.build(GRID).objects.some((o) => o.def === "lcd7-f"))) {
      const doc = example.build(GRID)
      const lcd = doc.objects.find((o) => o.def === "lcd7-f")!
      const touching = [...pinContacts(doc.objects, GRID).groups.keys()].filter((key) => key.startsWith(`${lcd.id}:`))
      expect(touching.length, example.id).toBe(40)
    }
  })
})

describe("the board's printed names lie over the wires, on a knockout of their ground, as every part's do (9f3fab1)", () => {
  const placed: PlacedObject = { id: "U1", def: "open746i-c", x: 0, y: 0 }
  const render = (routes: { id: string; pts: Point[]; owner: number[] }[], textScale = 1) =>
    renderToStaticMarkup(
      React.createElement(PinLayer, {
        objects: [placed],
        grid: GRID,
        detail: fieldDetail(GRID, 1, 1, textScale),
        connected: () => false,
        contacts: new Map<string, string>(),
        selected: new Set<string>(),
        routes,
        onPinPointerDown: () => {},
        onPinPointerMove: () => {},
        onPinPointerUp: () => {},
      }),
    )
  const nameAt = (text: string, near: string) => {
    const p = pin(near)
    return printedNameLayout(board, UPRIGHT).find((n) => n.shape.text === text && Math.hypot(n.x - p.x, n.y - p.y) < 2)!
  }

  it("every monospaced name the board prints is a name, drawn by the pin layer above the wires, never by the body below them", () => {
    const mono = printed.filter((t) => t.mono)
    expect(mono.length).toBeGreaterThan(500)
    expect(mono.every(isPrintedName)).toBe(true)
    expect(printed.filter((t) => !t.mono).some(isPrintedName)).toBe(false)
    expect(printedNames(board)).toHaveLength(mono.length)
    const html = render([])
    expect(html).toContain("data-printed-names")
    expect((html.match(/<text/g) ?? []).length).toBe(mono.length)
  })

  it("each is knocked out in the colour it is printed on: the board, the module's zone, the FFC's connector", () => {
    const ground = (text: string, near: string) => printedNames(board).find((n) => n.shape === nameAt(text, near).shape)!.ground
    expect(ground("PG15", "P21-23")).toBe("board")
    expect(ground("BOOT0", "BOOT0")).toBe("zone")
    expect(ground("R0", "P15-5")).toBe("connector")
  })

  it("a wire run under PG15 fades out beneath it, and only the names it crosses get a knockout", () => {
    const pg15 = nameAt("PG15", "P21-23")
    const box = printedNameBox(pg15, printedNameSize(pg15, 1), 0.6)
    const y = (box.y + box.h / 2) * GRID
    const across = { id: "w", pts: [{ x: -GRID, y }, { x: (box.x + box.w + 0.4) * GRID, y }], owner: [0] }
    const onField = (b: Box) => ({ x: b.x * GRID, y: b.y * GRID, w: b.w * GRID, h: b.h * GRID })
    expect(crossedBy(onField(box), [across.pts])).toBe(true)
    const crossed = printedNameLayout(board, UPRIGHT).filter((n) => crossedBy(onField(printedNameBox(n, printedNameSize(n, 1), 0.6)), [across.pts]))
    expect(crossed.map((n) => n.shape.text)).toContain("PG15")
    const fades = (html: string) => (html.match(/url\(#pin-knockout-[a-z]+-[xy]-rise\)/g) ?? []).length
    expect(fades(render([across]))).toBe(crossed.length)
    expect(fades(render([]))).toBe(0)
  })

  it("a real route from I2C1 to the strip is knocked out under every name it passes and nowhere else", () => {
    const doc = { objects: [placed], wires: [{ id: "w1", from: { object: "U1", pin: "P4-8" }, to: { object: "U1", pin: "P21-28" } }] }
    const routes = routeAll(doc.objects, doc.wires, GRID)
    const crossed = printedNameLayout(board, UPRIGHT).filter((n) => {
      const b = printedNameBox(n, printedNameSize(n, 1), 0.6)
      return crossedBy({ x: b.x * GRID, y: b.y * GRID, w: b.w * GRID, h: b.h * GRID }, routes.map((r) => r.pts))
    })
    expect(crossed.length).toBeGreaterThan(0)
    const html = render(routes)
    const fades = (html.match(/url\(#pin-knockout-[a-z]+-[xy]-rise\)/g) ?? []).length
    expect(fades).toBe(crossed.length)
  })
})

describe("the schematic text size reaches the board's names and titles, as far as each has room (f46f0fb)", () => {
  it("every printed text grows with the text size, and the board's names grow as other parts' pin names do", () => {
    const name = printed.find((t) => t.text === "CANTX")!
    expect(grow(name)).toBeGreaterThan(1)
    expect(textBoost(name, 0.75, grow(name))).toBe(0.75)
    expect(textBoost(name, 1, grow(name))).toBe(1)
    expect(textBoost(name, 2, grow(name))).toBe(grow(name))
    expect(growth.size).toBe(printed.length)
    expect(Math.max(...printed.map(grow))).toBeLessThanOrEqual(MAX_PRINTED_GROWTH)
    expect(printed.filter((t) => grow(t) > 1).length / printed.length).toBeGreaterThan(0.75)
  })

  it("a header's names grow as one: every name of a group shares one size", () => {
    const groups = new Map<number, Set<number>>()
    for (const t of printed) if (t.group !== undefined) groups.set(t.group, (groups.get(t.group) ?? new Set()).add(grow(t)))
    expect(groups.size).toBeGreaterThan(20)
    for (const [group, grows] of groups) expect(grows.size, `group ${group}`).toBe(1)
  })

  it("the joystick's four letters grow as one, so B beside the free space is no bigger than A, C and D", () => {
    const letters = printed.filter((t) => ["A", "B", "C", "D"].includes(t.text))
    const markSize = Math.max(...letters.map((t) => t.size ?? 0))
    const marks = letters.filter((t) => t.size === markSize)
    expect(marks.map((t) => t.text).sort()).toEqual(["A", "B", "C", "D"])
    expect(new Set(marks.map(grow)).size, marks.map((t) => `${t.text} ${grow(t)}`).join(", ")).toBe(1)
  })

  it("at the largest size nothing collides: no name or title meets another, a block, a part, a mark or a pin, nor leaves the plate it is printed on", () => {
    expect(clashes(grow)).toEqual([])
  })

  it("the pin layer draws them at the chosen size", () => {
    const size = (textScale: number) => {
      const html = renderToStaticMarkup(
        React.createElement(PinLayer, {
          objects: [{ id: "U1", def: "open746i-c", x: 0, y: 0 }],
          grid: GRID,
          detail: fieldDetail(GRID, 1, 1, textScale),
          connected: () => false,
          contacts: new Map<string, string>(),
          selected: new Set<string>(),
          onPinPointerDown: () => {},
          onPinPointerMove: () => {},
          onPinPointerUp: () => {},
        }),
      )
      return Number(/font-size="([\d.]+)"[^>]*>CANTX</.exec(html)![1])
    }
    const cantx = printed.find((t) => t.text === "CANTX")!
    expect(size(2) / size(1)).toBeCloseTo(grow(cantx), 5)
    expect(size(0.75) / size(1)).toBeCloseTo(0.75, 5)
  })
})

describe("S2, SW1 and BOOT are changeovers: a lever pivoting on the common, pointing at the selected end (Open746I-C schematic page 1; Core746I S1)", () => {
  const switchOf = (id: string) => part(id) as Extract<PartDef, { type: "switch" }>
  const nameAt = (text: string) => printed.find((t) => t.text === text && Math.hypot(t.x - switchOf("S2").x, t.y - switchOf("S2").y) < 3)!

  it("S2 pivots on 5Vin and throws to 5VDC (on) or U5V (off), each contact level with its name", () => {
    const s2 = switchOf("S2")
    expect(s2.throws).toBeDefined()
    expect(s2.y).toBeCloseTo(nameAt("5Vin").y, 1)
    expect(s2.throws!.on.y).toBeCloseTo(nameAt("5VDC").y, 1)
    expect(s2.throws!.off.y).toBeCloseTo(nameAt("U5V").y, 1)
    expect(Math.hypot(s2.throws!.on.x - s2.x, s2.throws!.on.y - s2.y)).toBeCloseTo(Math.hypot(s2.throws!.off.x - s2.x, s2.throws!.off.y - s2.y), 1)
  })

  it("the model agrees: both of S2's positions switch onto 5Vin, from the jack or from the USART1 USB", () => {
    const s2 = (board.model as Element[]).filter((e): e is Extract<Element, { kind: "SW" }> => e.kind === "SW" && e.part === "S2")
    expect(s2).toHaveLength(2)
    expect(s2.every((e) => e.b === "$5vin")).toBe(true)
    expect(s2.map((e) => [e.a, e.closed]).sort()).toEqual([["$u5vlim", "off"], ["5VDC", "on"]].sort())
  })

  it("SW1 and BOOT are drawn the same way, and nothing else on the board is a changeover", () => {
    expect(board.parts.filter((p) => p.type === "switch" && p.throws).map((p) => p.id).sort()).toEqual(["BOOT", "S2", "SW1"])
  })
})

describe("BOOT0 is wired where the module brings it out: its P17-69 pad (Core746I schematic, P2 pin 69)", () => {
  it("the pin sits on the pad the module prints BOOT0 on, not on the boot switch's leg", () => {
    const boot0 = pin("BOOT0")
    const pad = cellAt(onModule(MODULE_PAD.boot0))
    expect(boot0.x).toBeCloseTo(pad.x, 2)
    expect(boot0.y).toBeCloseTo(pad.y, 2)
    expect(boot0.connector).toBe("P17")
    expect(boot0.connectorPin).toBe(69)
    const label = printed.find((t) => t.text === "BOOT0")!
    expect(Math.abs(label.y - boot0.y)).toBeLessThan(0.05)
    expect(label.x).toBeLessThan(boot0.x)
    const boot = part("BOOT")
    expect(Math.hypot(boot0.x - boot.x, boot0.y - boot.y)).toBeGreaterThan(5)
  })
})

describe("every mark on the board is something real, and the same thing is drawn the same way", () => {
  it("no mounting holes or screws: the only circles are the module's 160 pads, all of one size", () => {
    expect(circleRadii).toHaveLength(160)
    expect(new Set(circleRadii).size).toBe(1)
    expect(circleRadii[0]).toBeLessThan(0.2)
  })

  it("no empty connector blocks: every connector body larger than a passive holds a pin or a part", () => {
    const connectors = board.body.filter((s) => s.type === "art" && s.fill === "connector").flatMap(subpathsOf)
    const points = [...board.pins, ...board.parts].map((p) => ({ x: p.x, y: p.y }))
    const bodies = connectors.map(boxOf).filter((box) => box.w * box.h > 1)
    expect(bodies.length).toBeGreaterThan(15)
    for (const box of bodies) {
      const holds = points.some((p) => p.x >= box.x - 0.05 && p.x <= box.x + box.w + 0.05 && p.y >= box.y - 0.05 && p.y <= box.y + box.h + 0.05)
      expect(holds, `connector at ${box.x.toFixed(1)}, ${box.y.toFixed(1)} (${box.w.toFixed(1)} × ${box.h.toFixed(1)} cells)`).toBe(true)
    }
  })

  it("repeated keys are one size: the joystick's five, and RESET with WAKEUP", () => {
    const size = (id: string) => board.parts.find((p) => p.id === id && p.type === "button")
    const joystick = ["JOY_A", "JOY_B", "JOY_C", "JOY_D", "JOY_CTR"].map((id) => (size(id) as { size?: number }).size)
    expect(new Set(joystick).size).toBe(1)
    expect((size("RESET") as { size?: number }).size).toBe((size("WAKEUP") as { size?: number }).size)
  })
})

describe("the board speaks the field's visual language", () => {
  it("it paints with the roles the other parts paint with, and no colour of its own", () => {
    const others = new Set(registry.filter((def) => def.id !== board.id).flatMap((def) => [...fillsOf(def.body)]))
    expect([...fillsOf(board.body)].filter((fill) => !others.has(fill))).toEqual([])
    expect(flat(board.body).filter((s) => s.type === "art" && !s.fill && !s.muted)).toEqual([])
  })

  it("its jumpers and its slide switches are switches, drawn as the field draws every switch", () => {
    const switches = board.parts.filter((p) => p.type === "switch")
    expect(switches.map((p) => p.id)).toEqual(expect.arrayContaining(["S2", "SW1", "BOOT", "VBATJ", "VREFJ", "JMP2_1", "JMP3_1", "JMP4_5", "JMP5_A4", "OTG_FLG"]))
  })
})

describe("placement takes the board's real contour: the outline and the P15 tab, not their bounding box", () => {
  it("each pin of the board lies on its outline or on the tab", () => {
    const ffcPins = board.pins.filter((p) => p.connector === "P15")
    for (const p of board.pins) {
      const onBoard = p.x >= outline.x && p.x <= outline.x + outline.w && p.y >= outline.y && p.y <= outline.y + outline.h
      expect(onBoard || ffcPins.includes(p), p.id).toBe(true)
    }
    expect(objectPins({ id: "U1", def: "open746i-c", x: 0, y: 0 }, GRID)).toHaveLength(board.pins.length)
  })
})

const switchOf = (id: string) => part(id) as Extract<PartDef, { type: "switch" }>
const renderPins = () =>
  renderToStaticMarkup(
    React.createElement(PinLayer, {
      objects: [{ id: "U1", def: "open746i-c", x: 0, y: 0 }],
      grid: GRID,
      detail: fieldDetail(GRID, 1, 1, 1),
      connected: () => false,
      contacts: new Map<string, string>(),
      selected: new Set<string>(),
      onPinPointerDown: () => {},
      onPinPointerMove: () => {},
      onPinPointerUp: () => {},
    }),
  )
const switchContactDots = () => [...renderPins().matchAll(/data-switch-contact="" cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => ({ x: Number(m[1]) / GRID, y: Number(m[2]) / GRID }))
const toModuleMm = (p: { x: number; y: number }) => ({ x: p.x * MM_PER_CELL - FRAME.originX - MODULE_AT.x, y: p.y * MM_PER_CELL - FRAME.originY - MODULE_AT.y })

describe("JMP1 is a 0 Ω resistor soldered on the board, printed PC13, not a jumper (the lab's board, 2026-10-13; the schematic draws Header 2)", () => {
  const link = part("JMP1")

  it("is a fixed link, not a switch, drawn as the SMD footprint every other passive on the board is, inside its PC13 box", () => {
    expect(link.type).toBe("link")
    expect(board.parts.filter((p) => p.type === "switch").map((p) => p.id)).not.toContain("JMP1")
    const footprint = solids.find((b) => b.fill === "connector" && pointInPolygon(link, b.points))!
    expect(footprint.box.w * MM_PER_CELL).toBeCloseTo(SMD_MM.long, 1)
    expect(footprint.box.h * MM_PER_CELL).toBeCloseTo(SMD_MM.short, 1)
    const sameSize = solids.filter((b) => b.fill === "connector" && Math.abs(b.box.w - footprint.box.w) + Math.abs(b.box.h - footprint.box.h) < 0.02)
    expect(sameSize.length, "the LED resistors and the Arduino 0 Ω links share its footprint").toBeGreaterThan(10)
    const name = printed.find((t) => t.text === "PC13" && Math.abs(t.x - link.x) < 0.05)!
    expect(name.y).toBeGreaterThan(link.y)
  })

  it("says what it is when hovered: a 0 Ω link, and why the schematic's Header 2 is not what the board carries", () => {
    expect(link.label).toMatch(/0 Ω/)
    expect(link.label).toMatch(/Header 2/)
    expect(link.label).toMatch(/not a jumper/)
  })

  it("SDMMC's CD pin is PC13 itself, as Arduino A1 is through H6, with no switch between them in the model", () => {
    expect(pin("P6-9")).toMatchObject({ mcu: "PC13", kind: "digital" })
    const shorts = (board.model as Element[]).filter((e): e is Extract<Element, { kind: "SHORT" }> => e.kind === "SHORT")
    expect(shorts.some((e) => e.nodes.includes("P6-9") && e.nodes.includes("P18-6") && e.nodes.includes("CN3-2"))).toBe(true)
    expect((board.model as Element[]).some((e) => e.kind === "SW" && e.part === "JMP1")).toBe(false)
  })
})

describe("the USART1 JMP: a 2 × 4 header with all four caps fitted, the bridge side of each a header pin (the lab's board, 2026-10-13)", () => {
  const BRIDGE: [cap: string, pin: string, silkscreen: string][] = [
    ["JMP2_1", "VCP-TX", "TXD"],
    ["JMP2_2", "VCP-RX", "RXD"],
    ["JMP2_3", "VCP-CTS", "CTS"],
    ["JMP2_4", "VCP-RTS", "RTS"],
  ]

  it("draws the four caps alike: fitted, level, one pitch long, one row each from PA9 down", () => {
    const caps = BRIDGE.map(([cap]) => switchOf(cap))
    for (const cap of caps) expect([cap.vertical ?? false, cap.span, cap.initial], cap.id).toEqual([false, 1, { on: true }])
    expect(new Set(caps.map((cap) => cap.x)).size).toBe(1)
    caps.forEach((cap, i) => expect(cap.y - caps[0].y, cap.id).toBeCloseTo(i, 5))
  })

  it.each(BRIDGE)("%s: the bridge's end of the cap is %s, a pin in the field's own style, printed %s beside it", (cap, id, silkscreen) => {
    const c = switchOf(cap)
    const p = pin(id)
    expect([p.x, p.y]).toEqual([c.x + c.span, c.y])
    expect(p).toMatchObject({ label: silkscreen, kind: "digital", connector: "JMP2", printed: true })
    const name = printed.find((t) => t.text === silkscreen && Math.abs(t.y - p.y) < 0.05)!
    expect(name.x).toBeGreaterThan(p.x)
  })

  it("draws the cap's contact inside each of those pins, so a fitted cap reads fitted on all four rows, as on the board", () => {
    const dots = switchContactDots()
    for (const [, id] of BRIDGE) expect(dots.some((d) => Math.hypot(d.x - pin(id).x, d.y - pin(id).y) < 1e-3), id).toBe(true)
    for (const [cap] of BRIDGE) expect(dots.some((d) => Math.hypot(d.x - switchOf(cap).x, d.y - switchOf(cap).y) < 1e-3), `${cap}'s MCU side is no pin`).toBe(false)
  })
})

describe("the POWER JMP: the module's 2 × 2 header with both caps fitted, as its silkscreen prints it (Core746I VBAT1 and VREF+1; the lab's board, 2026-10-13)", () => {
  const vbat = switchOf("VBATJ")
  const vref = switchOf("VREFJ")

  it("two caps side by side, one pitch apart, each from a 3.3 V pin to its own: VBAT on the left, VREF+ on the right", () => {
    for (const cap of [vbat, vref]) expect([cap.vertical, cap.span, cap.initial], cap.id).toEqual([true, 1, { on: true }])
    expect(vref.x - vbat.x).toBeCloseTo(1, 2)
    expect(vref.y).toBeCloseTo(vbat.y, 5)
    expect([pin("VBAT").x, pin("VBAT").y]).toEqual([vbat.x, vbat.y + vbat.span])
    expect([pin("VREF+").x, pin("VREF+").y]).toEqual([vref.x, vref.y + vref.span])
    const dots = switchContactDots()
    for (const id of ["VBAT", "VREF+"]) expect(dots.some((d) => Math.hypot(d.x - pin(id).x, d.y - pin(id).y) < 1e-3), id).toBe(true)
  })

  it("prints 3.3V above between the caps, VBAT under the left and VREF+ under the right, all reading down the module as its silkscreen does, POWER JMP beside them", () => {
    const near = (text: string) => printed.find((t) => t.text === text && Math.hypot(t.x - vbat.x, t.y - vbat.y) < 4)!
    expect(near("3.3V").x).toBeCloseTo((vbat.x + vref.x) / 2, 1)
    expect(near("3.3V").y).toBeLessThan(vbat.y)
    expect(near("VBAT").x).toBeCloseTo(vbat.x, 2)
    expect(near("VREF+").x).toBeCloseTo(vref.x, 2)
    for (const text of ["VBAT", "VREF+"]) expect(near(text).y, text).toBeGreaterThan(vbat.y + vbat.span)
    for (const text of ["3.3V", "VBAT", "VREF+", "POWER JMP"]) expect(near(text).rotate, text).toBe(90)
    expect(near("POWER JMP").x).toBeGreaterThan(vref.x)
  })

  it("stands where the module's photo prints it: the label columns at 13.0 and 15.6 mm, the header's right and bottom edges at 16.85 and 17.7 mm (module20.png, 20 px/mm)", () => {
    const PHOTO = { vbatX: 13.0, vrefX: 15.6, right: 16.85, bottom: 17.7 }
    const TOLERANCE_MM = 0.35
    expect(Math.abs(toModuleMm(vbat).x - PHOTO.vbatX)).toBeLessThanOrEqual(TOLERANCE_MM)
    expect(Math.abs(toModuleMm(vref).x - PHOTO.vrefX)).toBeLessThanOrEqual(TOLERANCE_MM)
    const header = solids.find((b) => b.fill === "connector" && pointInPolygon(pin("VREF+"), b.points))!
    expect(Math.abs(toModuleMm({ x: header.box.x + header.box.w, y: 0 }).x - PHOTO.right)).toBeLessThanOrEqual(TOLERANCE_MM)
    expect(Math.abs(toModuleMm({ x: 0, y: header.box.y + header.box.h }).y - PHOTO.bottom)).toBeLessThanOrEqual(TOLERANCE_MM)
  })
})

describe("at 150 % and 200 % every name the board prints is drawn larger, and nothing collides (the user's review, 2026-10-13)", () => {
  const MIN_GROWTH = 1.25
  const names = printed.filter(isPrintedName)
  const drawnAt = (scale: number) => (t: Text) => textBoost(t, scale, grow(t))
  const groupOf = (text: string, near: string) => {
    const p = pin(near)
    const found = names.find((t) => t.text === text && Math.hypot(t.x - p.x, t.y - p.y) < 6)!
    return names.filter((t) => t.group === found.group)
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]

  it.each([1.5, 2])("at %s×, every name is drawn at least 1.25 × the size the board prints it", (scale) => {
    const small = names.filter((t) => drawnAt(scale)(t) < MIN_GROWTH).map((t) => `${t.text} at ${t.x}, ${t.y}: ${drawnAt(scale)(t)}`)
    expect(small).toEqual([])
  })

  it("at 200 %, most names reach 1.4 × or more, and the ULPI and ETH tables, which did not grow at all, reach 1.3 ×", () => {
    expect(median(names.map(drawnAt(2)))).toBeGreaterThanOrEqual(1.4)
    for (const [text, near] of [["DATA0", "P10-19"], ["CLK", "P10-12"], ["MDIO", "P11-5"], ["REF", "P11-7"]] as const)
      for (const t of groupOf(text, near)) expect(drawnAt(2)(t), `${t.text} of ${near}'s table`).toBeGreaterThanOrEqual(1.3)
  })

  it.each([1.5, 2])("at %s×, no name or title meets another, a block, a part, a mark, a pin or a silkscreen line, nor leaves the plate it is printed on", (scale) => {
    expect(clashes(drawnAt(scale))).toEqual([])
  })

  it("a name grows away from its pin: each FFC line's name keeps the edge that faces its pin", () => {
    for (const line of board.pins.filter((p) => p.connector === "P15")) {
      const name = names.find((t) => t.text === line.label && Math.abs(t.x - line.x) < 0.01 && Math.abs(t.y - line.y) < 1)!
      const [small, large] = [printedBox(name, 1), printedBox(name, grow(name))]
      expect(grow(name), line.id).toBeGreaterThanOrEqual(1.3)
      if (line.y === 55) expect(large.y + large.h, line.id).toBeCloseTo(small.y + small.h, 2)
      else expect(large.y, line.id).toBeCloseTo(small.y, 2)
    }
  })

  it("a name printed on two lines grows as one: CLK OUT's and REF CLK's lines move apart rather than into each other", () => {
    for (const [first, second, near] of [["CLK", "OUT", "P10-12"], ["REF", "CLK", "P11-7"]] as const) {
      const lines = groupOf(first, near).filter((t) => (t.text === first || t.text === second) && Math.hypot(t.x - pin(near).x, t.y - pin(near).y) < 6)
      const [a, b] = lines
      expect(lines, `${first} ${second}`).toHaveLength(2)
      expect(a.growsFrom).toEqual(b.growsFrom)
      const gap = (f: number) => {
        const [p, q] = [printedBox(a, f), printedBox(b, f)]
        return Math.max(q.x - (p.x + p.w), p.x - (q.x + q.w), q.y - (p.y + p.h), p.y - (q.y + q.h))
      }
      expect(gap(grow(a)), `${first} ${second}`).toBeGreaterThan(gap(1))
    }
  })

  it("the pin layer draws them at the grown size and place: DATA0 and MDIO 1.3 × larger at 200 %, CLK OUT's lines further apart", () => {
    const textsAt = (textScale: number) => {
      const html = renderToStaticMarkup(
        React.createElement(PinLayer, {
          objects: [{ id: "U1", def: "open746i-c", x: 0, y: 0 }],
          grid: GRID,
          detail: fieldDetail(GRID, 1, 1, textScale),
          connected: () => false,
          contacts: new Map<string, string>(),
          selected: new Set<string>(),
          onPinPointerDown: () => {},
          onPinPointerMove: () => {},
          onPinPointerUp: () => {},
        }),
      )
      return [...html.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)" font-size="([\d.]+)"[^>]*>([^<]+)</g)].map((m) => ({ x: Number(m[1]) / GRID, y: Number(m[2]) / GRID, size: Number(m[3]), text: m[4] }))
    }
    const near = (texts: ReturnType<typeof textsAt>, text: string, id: string) => texts.filter((t) => t.text === text && Math.hypot(t.x - pin(id).x, t.y - pin(id).y) < 6)
    const [one, two] = [textsAt(1), textsAt(2)]
    for (const [text, id] of [["DATA0", "P10-19"], ["MDIO", "P11-5"]] as const) expect(near(two, text, id)[0].size / near(one, text, id)[0].size, text).toBeGreaterThan(1.3 - 1e-9)
    const spread = (texts: ReturnType<typeof textsAt>) => Math.abs(near(texts, "CLK", "P10-12")[0].x - near(texts, "OUT", "P10-12")[0].x)
    expect(spread(two)).toBeGreaterThan(spread(one) * 1.25)
  })
})

describe("a 7\" LCD docked on P15 covers the names the board prints under it, as FIELD.md has it (review, 2026-10-13)", () => {
  const doc = examples.find((e) => e.id === "open746-lcd")!.build(GRID)
  const boardObject = doc.objects.find((o) => o.def === "open746i-c")!
  const lcdObject = doc.objects.find((o) => o.def === "lcd7-f")!
  const lcdBody = bodyBounds(getDef("lcd7-f")!)
  const underLcd = (p: Point) => p.x > lcdObject.x / GRID + lcdBody.x && p.x < lcdObject.x / GRID + lcdBody.x + lcdBody.w && p.y > lcdObject.y / GRID + lcdBody.y && p.y < lcdObject.y / GRID + lcdBody.y + lcdBody.h
  const ffcNames = board.pins.filter((p) => p.connector === "P15").length
  const namesDrawn = (objects: readonly PlacedObject[]) => {
    const html = renderToStaticMarkup(
      React.createElement(PinLayer, {
        objects,
        grid: GRID,
        detail: fieldDetail(GRID, 1, 1, 1),
        connected: () => false,
        contacts: pinContacts(objects, GRID).groups,
        selected: new Set<string>(),
        onPinPointerDown: () => {},
        onPinPointerMove: () => {},
        onPinPointerUp: () => {},
      }),
    )
    const own = html.split(`data-pins="${boardObject.id}"`)[1].split("data-pins=")[0]
    const group = /<g data-printed-names=""[^>]*>(.*?)<\/g>/.exec(own)?.[1] ?? ""
    return [...group.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)"[^>]*>([^<]+)</g)].map((m) => ({ x: Number(m[1]) / GRID, y: Number(m[2]) / GRID, text: m[3] }))
  }

  it("the board alone prints every name, P15's included", () => {
    const names = namesDrawn([boardObject])
    expect(names).toHaveLength(printedNames(board).length)
    expect(names.filter(underLcd)).toHaveLength(ffcNames)
  })

  it("docked, none of the forty is drawn over the LCD's tail, and every other name still is", () => {
    const names = namesDrawn([boardObject, lcdObject])
    expect(names.filter(underLcd).map((n) => n.text)).toEqual([])
    expect(names).toHaveLength(printedNames(board).length - ffcNames)
  })

  it("a board placed over the LCD keeps them: they are printed on the topmost body", () => {
    expect(namesDrawn([lcdObject, boardObject])).toHaveLength(printedNames(board).length)
  })
})
