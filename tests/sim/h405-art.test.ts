import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Part } from "@/components/field/ComponentView"
import { BOARD_MM, extPad, FRAME, JTAG, JTAG_SHROUD, jtagNameAnchor, REAL_JTAG_SHROUD, jtagPad, LEAD_FREE, MIL_MM, NAME_TABLES, nameCellOf, pinBoxOf, placed, PLATE, Q1, SHIFT, SWITCH_BODIES, U1, USB_SHELL } from "@/schematic/components/olimex-stm32-h405-art"
import { blocksOf, boxesMeet, boxInside, boxMeetsPolygon, homeOf, marksOf, partBox, pointInPolygon, printedBox, printedGrowth, ruleCrossesBox, rulesOf, switchContacts, type Box } from "@/schematic/printed-text"
import { getDef } from "@/schematic/registry"
import type { BodyShape, Point } from "@/schematic/types"

const board = getDef("olimex-stm32-h405")!
type Text = Extract<BodyShape, { type: "text" }>

const cell = (mm: Point) => ({ x: (mm.x + FRAME.originX) * FRAME.cellsPerMm, y: (mm.y + FRAME.originY) * FRAME.cellsPerMm })
const mil = (x: number, y: number) => cell({ x: x * MIL_MM, y: y * MIL_MM })
const printed = board.body.filter((s): s is Text => s.type === "text")
const texts = printed.map((t) => t.text)
const blocks = blocksOf(board.body)
const solids = blocks.filter((b) => b.fill !== "board")
const growth = printedGrowth(board)
const at = (box: Box) => `${box.x.toFixed(2)}, ${box.y.toFixed(2)}`
const centreOf = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })
const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01
const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
const segmentsCross = (a: Point, b: Point, c: Point, d: Point) => side(c, d, a) * side(c, d, b) < -1e-12 && side(a, b, c) * side(a, b, d) < -1e-12
const edges = (p: readonly Point[]) => p.map((q, i) => [q, p[(i + 1) % p.length]] as const)
const polygonsMeet = (a: readonly Point[], b: readonly Point[]) =>
  a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a)) || edges(a).some(([p, q]) => edges(b).some(([r, t]) => segmentsCross(p, q, r, t)))
const PACKAGE_LAYERS: readonly Point[] = [cell(placed("middle", { x: U1.x, y: U1.y })), cell(placed("middle", Q1.centre)), cell({ x: (JTAG_SHROUD.x0 + JTAG_SHROUD.x1) / 2, y: (JTAG_SHROUD.y0 + JTAG_SHROUD.y1) / 2 })]
const layersOfOnePackage = (a: Box, b: Box) => near(centreOf(a), centreOf(b)) && PACKAGE_LAYERS.some((c) => near(c, centreOf(a)))
const parts = board.parts.flatMap((p) => {
  const box = partBox(p)
  return box ? [{ id: p.id, box, centre: { x: p.x, y: p.y }, contacts: p.type === "switch" ? switchContacts(p) : [] }] : []
})
const pin = (id: string) => board.pins.find((p) => p.id === id)!

function clashes(factor: (t: Text) => number): string[] {
  const issues: string[] = []
  const boxes = printed.map((t) => printedBox(t, factor(t)))
  const rules = rulesOf(board.body)
  printed.forEach((t, i) => {
    const box = boxes[i]
    const where = `"${t.text}" at ${t.x}, ${t.y}`
    const home = homeOf(blocks, t)
    if (home && !boxInside(box, home.points)) issues.push(`${where} leaves its ${home.fill}`)
    for (const b of solids) if (b !== home && !pointInPolygon(t, b.points) && boxMeetsPolygon(box, b.points)) issues.push(`${where} on the ${b.fill} at ${at(b.box)}`)
    for (const p of parts) if (boxesMeet(box, p.box)) issues.push(`${where} on ${p.id}`)
    for (const mark of marksOf(board.body)) if (boxMeetsPolygon(box, mark)) issues.push(`${where} on a mark`)
    for (const q of board.pins) if (boxesMeet(box, { x: q.x - 0.25, y: q.y - 0.25, w: 0.5, h: 0.5 })) issues.push(`${where} on pin ${q.id}`)
    for (const line of rules) if (ruleCrossesBox(line, box)) issues.push(`${where} across a silkscreen line at ${at({ ...line[0], w: 0, h: 0 })}`)
    for (let j = i + 1; j < printed.length; j++) if (boxesMeet(box, boxes[j])) issues.push(`${where} on "${printed[j].text}"`)
  })
  return issues
}

describe("the STM32-H405 is drawn as the Rev. C board is", () => {
  it("to scale, 1 cell = 2.54 mm: the 60.96 × 34.29 mm board stretched by whole cells only, to fit the name tables", () => {
    const outline = board.body.find((s): s is Extract<BodyShape, { type: "rect" }> => s.type === "rect" && s.fill === "board")!
    expect.soft(SHIFT.middle, "below EXT2: three cells down, for EXT2's table").toEqual({ x: 0, y: 3 * 2.54 })
    expect.soft(SHIFT.bottom, "EXT1 and its corner: seven cells down, for both tables").toEqual({ x: 0, y: 7 * 2.54 })
    expect.soft(SHIFT.jtag, "JTAG: two cells right, for its widened shroud, and down with the middle").toEqual({ x: 2 * 2.54, y: 3 * 2.54 })
    expect.soft(outline.w * 2.54, "plate width").toBeCloseTo(PLATE.x1 - PLATE.x0, 1)
    expect.soft(outline.h * 2.54, "plate height: 0.4 mm more, for the URL under EXT1's pin box").toBeCloseTo(BOARD_MM.h + SHIFT.bottom.y + 0.4, 1)
    expect.soft(PLATE.x1, "the shroud flush with the right edge, as on the board").toBeCloseTo(JTAG_SHROUD.x1, 6)
    expect.soft(outline.x, "left edge").toBeCloseTo(cell({ x: 0, y: 0 }).x, 2)
    expect.soft(outline.y, "top edge").toBeCloseTo(cell({ x: 0, y: 0 }).y, 2)
    expect.soft(outline.y + outline.h, "the bottom edge on the field").toBeLessThan(board.height)
    expect.soft(outline.x + outline.w, "the right edge on the field").toBeLessThan(board.width)
  })

  it("keeps every header pad at the drawing's distance from its edge, each on a whole cell", () => {
    const expected: [string, number, number, number, number][] = [
      ["EXT2-1", 1875, 225, 0, 0], ["EXT2-2", 1875, 125, 0, 0], ["EXT2-25", 675, 225, 0, 0], ["EXT2-26", 675, 125, 0, 0],
      ["EXT1-1", 675, 1125, 0, 7], ["EXT1-2", 675, 1225, 0, 7], ["EXT1-25", 1875, 1125, 0, 7], ["EXT1-26", 1875, 1225, 0, 7],
      ["JTAG-1", 2175, 225, 2, 3], ["JTAG-2", 2275, 225, 2, 3], ["JTAG-19", 2175, 1125, 2, 3], ["JTAG-20", 2275, 1125, 2, 3],
    ]
    for (const [id, x, y, right, down] of expected) {
      expect.soft(pin(id).x, `${id} x`).toBeCloseTo(mil(x, y).x + right, 6)
      expect.soft(pin(id).y, `${id} y`).toBeCloseTo(mil(x, y).y + down, 6)
    }
    const fromBottom = (id: string) => cell({ x: 0, y: PLATE.y1 }).y - pin(id).y
    expect.soft(fromBottom("EXT1-2"), "EXT1's outer row 0.4 mm further from the bottom edge than on the board, for the URL").toBeCloseTo(((1350 - 1225) * MIL_MM + 0.4) / 2.54, 6)
    for (const p of board.pins) {
      expect.soft(Number.isInteger(p.x), `${p.id} x on a cell`).toBe(true)
      expect.soft(Number.isInteger(p.y), `${p.id} y on a cell`).toBe(true)
    }
  })

  it("draws the USB-B shell, U1, Q1 and the JTAG shroud where and as large as the dimension drawing has them (blocks measured, not constants)", () => {
    const mmBox = (b: Box) => ({ x0: b.x * 2.54 - FRAME.originX, y0: b.y * 2.54 - FRAME.originY, w: b.w * 2.54, h: b.h * 2.54 })
    const middle = SHIFT.middle.y
    const find = (fill: string, cx: number, cy: number, w: number, h: number) =>
      blocks
        .filter((b) => b.fill === fill && Math.abs(mmBox(b.box).x0 + mmBox(b.box).w / 2 - cx) < 0.3 && Math.abs(mmBox(b.box).y0 + mmBox(b.box).h / 2 - cy) < 0.3)
        .sort((a, b) => Math.abs(mmBox(a.box).w - w) + Math.abs(mmBox(a.box).h - h) - (Math.abs(mmBox(b.box).w - w) + Math.abs(mmBox(b.box).h - h)))[0]
    const expectBox = (what: string, fill: string, drawing: { x0: number; y0: number; w: number; h: number }, dy = middle, dx = 0) => {
      const b = find(fill, drawing.x0 + dx + drawing.w / 2, drawing.y0 + dy + drawing.h / 2, drawing.w, drawing.h)
      expect.soft(b, `${what} drawn`).toBeDefined()
      if (!b) return
      const got = mmBox(b.box)
      expect.soft(got.x0, `${what} left`).toBeCloseTo(drawing.x0 + dx, 1)
      expect.soft(got.y0, `${what} top`).toBeCloseTo(drawing.y0 + dy, 1)
      expect.soft(got.w, `${what} width`).toBeCloseTo(drawing.w, 1)
      expect.soft(got.h, `${what} height`).toBeCloseTo(drawing.h, 1)
    }
    expectBox("USB-B shell, 6.9 mm past the left edge, 16.6 × 12.1", "connector", { x0: -6.9, y0: 11.1, w: 16.6, h: 12.1 })
    expectBox("U1 body, 10 × 10 on 1200/675 mil", "chip", { x0: 1200 * MIL_MM - 5, y0: 675 * MIL_MM - 5, w: 10, h: 10 })
    expectBox("Q1 base", "zone", { x0: 43.25, y0: 12.67, w: 4.91, h: 11.49 })
    expectBox("Q1 can's flange", "connector", { x0: 43.6, y0: 12.95, w: 4.2, h: 10.93 })
    expectBox("Q1 can's raised top", "connector", { x0: 44.36, y0: 13.69, w: 2.68, h: 9.45 })
    const shroud = mmBox(blocks.find((b) => b.fill === "connector" && Math.abs(mmBox(b.box).w - 14.54) < 0.05)?.box ?? { x: 0, y: 0, w: 0, h: 0 })
    expect.soft(shroud.w, "JTAG shroud widened from the drawing's 8.81 mm to 14.54 mm for the names").toBeCloseTo(14.54, 1)
    expect.soft(shroud.h, "and as tall as the drawing's, 33.25 mm").toBeCloseTo(33.75 - 0.5, 1)
    expect.soft(shroud.x0 + shroud.w / 2, "centred on its two pin columns").toBeCloseTo((2175 + 50) * MIL_MM + SHIFT.jtag.x, 1)
    expect.soft(shroud.x0 + shroud.w, "flush with the plate's right edge").toBeCloseTo(PLATE.x1, 1)
    expect.soft(REAL_JTAG_SHROUD.x1, "the real shroud is flush with the real board").toBeCloseTo(BOARD_MM.w, 1)
  })

  it("prints what the board prints on top, and nothing it does not", () => {
    for (const t of ["VR", "USB", "RESET", "BUT", "PWR", "STAT", "B1_H/B1_L", "B0_H/B0_L", "1", "2", "U1", "Q1", "USBP_E", "JTAG", "STM32-H103", "STM32-H405", "Rev. C", "WWW.OLIMEX.COM", "(C) 2013", "8.000"])
      expect.soft(texts, t).toContain(t)
    for (const t of ["EXT1", "EXT2", "STM32-H405 Rev. C", "WWW.OLIMEX.COM (C) 2013"]) expect.soft(texts, t).not.toContain(t)
    const url = printed.find((t) => t.text === "WWW.OLIMEX.COM")!
    expect.soft(url.rotate ?? 0, "the URL runs along the bottom edge").toBe(0)
    expect.soft(url.y, "below EXT1").toBeGreaterThan(pin("EXT1-2").y)
  })

  it("carries the lead-free roundel as round-ended strokes that stay inside its ring, and no WEEE bin or ESD sign", () => {
    const centre = cell(placed("middle", LEAD_FREE))
    const radius = LEAD_FREE.r / 2.54
    const marks = marksOf(board.body)
    const roundel = marks.filter((points) => points.every((p) => Math.hypot(p.x - centre.x, p.y - centre.y) <= radius + 1e-2))
    expect.soft(roundel.length, "ring, P, b and the bar").toBeGreaterThan(10)
    const shell = { a: cell(placed("middle", { x: USB_SHELL.x0, y: USB_SHELL.y0 })), b: cell(placed("middle", { x: USB_SHELL.x1, y: USB_SHELL.y1 })) }
    const onTheShell = (points: Point[]) => points.every((p) => p.x > shell.a.x && p.x < shell.b.x && p.y > shell.a.y && p.y < shell.b.y)
    const springs = marks.filter((points) => !roundel.includes(points) && onTheShell(points))
    expect.soft(springs.length, "the USB-B shell's two V springs, three strokes each").toBe(6)
    const elsewhere = marks.filter((points) => !roundel.includes(points) && !springs.includes(points))
    expect.soft(elsewhere.length, "the two model squares, U1's pin-1 ring, RESET's two windows, BUT's four posts").toBe(10)
    for (const points of elsewhere) {
      const xs = points.map((p) => p.x)
      const ys = points.map((p) => p.y)
      expect.soft(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 2.54, "no other mark larger than 2.4 mm").toBeLessThan(2.4)
    }
  })

  it("draws the switches' own details clear of their caps: BUT's four corner posts, RESET's two windows beside the actuator", () => {
    const marks = marksOf(board.body)
    const centreOf = (points: Point[]) => ({ x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length })
    for (const [id, body, count] of [["BUT", SWITCH_BODIES.but, 4], ["RESET", SWITCH_BODIES.reset, 2]] as const) {
      const at = cell(placed("middle", body))
      const part = parts.find((p) => p.id === id)!
      const own = marks.filter((points) => {
        const c = centreOf(points)
        return Math.abs(c.x - at.x) < 3 / 2.54 && Math.abs(c.y - at.y) < 3 / 2.54
      })
      expect.soft(own.length, `${id}'s details`).toBe(count)
      for (const points of own) expect.soft(boxMeetsPolygon(part.box, points), `${id}'s detail clear of its cap`).toBe(false)
    }
  })

  it("draws the USB-B as the drawing does: its solder lugs out of the shell's long sides, and a Type-B plug, no generic receptacle", () => {
    const usb = board.parts.find((p) => p.type === "usb")!
    expect.soft(usb.type === "usb" && usb.plug, "a Type-B plug").toBe("usb-b")
    const top = cell(placed("middle", { x: 0, y: USB_SHELL.y0 })).y
    const bottom = cell(placed("middle", { x: 0, y: USB_SHELL.y1 })).y
    const lugs = blocks.filter((b) => b.fill === "zone" && b.box.x < cell({ x: USB_SHELL.x1, y: 0 }).x && b.box.x + b.box.w > cell({ x: USB_SHELL.x0, y: 0 }).x && (Math.abs(b.box.y + b.box.h - top) < 0.02 || Math.abs(b.box.y - bottom) < 0.02))
    expect.soft(lugs.length, "one lug above the shell, one below").toBe(2)
  })

  it("prints every EXT pin's name in a table on the inner side of its header, as the Open746I-C does: pins at the edge, one band per row, in the rows' order", () => {
    expect.soft(board.pins.every((p) => p.printed), "every pin printed").toBe(true)
    const names = printed.filter((t) => t.mono)
    const inCell = (t: Text, c: { x0: number; y0: number; x1: number; y1: number }) => {
      const a = cell({ x: c.x0, y: c.y0 })
      const b = cell({ x: c.x1, y: c.y1 })
      return t.x > a.x && t.x < b.x && t.y > a.y && t.y < b.y
    }
    for (const p of board.pins.filter((q) => q.connector !== "JTAG")) {
      const connector = p.connector as "EXT1" | "EXT2"
      const own = names.filter((t) => inCell(t, nameCellOf(connector, p.connectorPin!))).sort((m, n) => m.x - n.x || m.y - n.y)
      expect.soft(own.map((t) => t.text), `${p.id}'s cell`).toEqual([p.label])
    }
    expect.soft(NAME_TABLES.EXT2.y0, "EXT2's table under its pin box, towards the board's middle").toBeCloseTo(pinBoxOf("EXT2").y1, 6)
    expect.soft(NAME_TABLES.EXT1.y1, "EXT1's table over its pin box, towards the board's middle").toBeCloseTo(pinBoxOf("EXT1").y0, 6)
    for (const connector of ["EXT1", "EXT2"] as const) {
      const box = pinBoxOf(connector)
      const pads = board.pins.filter((p) => p.connector === connector)
      const inside = (q: Point) => q.x > cell({ x: box.x0, y: 0 }).x && q.x < cell({ x: box.x1, y: 0 }).x && q.y > cell({ x: 0, y: box.y0 }).y && q.y < cell({ x: 0, y: box.y1 }).y
      expect.soft(pads.every(inside), `${connector}'s pads in its box`).toBe(true)
      const upperRowOdd = extPad(connector, 1).y < extPad(connector, 2).y
      expect.soft(nameCellOf(connector, 1).y0 < nameCellOf(connector, 2).y0, `${connector}: the band of the row above comes first`).toBe(upperRowOdd)
    }
  })

  it("lets the EXT names grow as far as the Open746I-C's table names do (1.6–1.75×): every 3- and 4-letter name reaches 1.6× at the largest text size, +5V_USB stays on one line", () => {
    const shroud = cell({ x: JTAG_SHROUD.x0, y: 0 }).x
    const names = printed.filter((t) => t.mono && t.x < shroud)
    for (const t of names) {
      const g = growth.get(t) ?? 1
      if (t.text.length <= 4) expect.soft(g, `${t.text} at ${t.x}, ${t.y} grows`).toBeGreaterThanOrEqual(1.6)
      else expect.soft(g, `${t.text} fits its band at the printed size`).toBeGreaterThanOrEqual(1)
    }
  })

  it("prints JTAG's names inside the shroud beside its pins: odd pins left of the columns, even ones right, each level with its pin; the shroud widened for them, on the pins' centre", () => {
    const names = printed.filter((t) => t.mono)
    const left = cell({ x: JTAG_SHROUD.x0 + JTAG.wall, y: 0 }).x
    const right = cell({ x: JTAG_SHROUD.x1 - JTAG.wall, y: 0 }).x
    expect.soft(JTAG.x1 - JTAG.x0, "wider than the real 8.81 mm shroud").toBeGreaterThan(REAL_JTAG_SHROUD.x1 - REAL_JTAG_SHROUD.x0)
    expect.soft((JTAG.x0 + JTAG.x1) / 2, "centred on the two pin columns").toBeCloseTo(JTAG.pin1.x + 1.27, 6)
    expect.soft((JTAG.latch.x0 + JTAG.latch.x1) / 2, "latch windows centred too").toBeCloseTo(JTAG.pin1.x + 1.27, 6)
    for (const p of board.pins.filter((q) => q.connector === "JTAG")) {
      const odd = p.connectorPin! % 2 === 1
      const at = cell(jtagNameAnchor(p.connectorPin!))
      const own = names.filter((t) => t.text === p.label && Math.abs(t.x - at.x) < 0.006 && Math.abs(t.y - at.y) < 0.006)
      expect.soft(own.length, `${p.id} named`).toBe(1)
      expect.soft(Math.abs(at.y - p.y), `${p.id}'s name level with it`).toBeLessThan(1e-6)
      if (odd) expect.soft(own[0]?.anchor, `${p.id} ends by its pin`).toBe("end")
      else expect.soft(own[0]?.anchor ?? "middle", `${p.id} starts by its pin`).toBe("start")
      const box = own[0] ? printedBox(own[0]) : undefined
      if (box) expect.soft(box.x > left && box.x + box.w < right, `${p.id} inside the shroud's walls`).toBe(true)
    }
    expect.soft(jtagPad(1).x < jtagPad(2).x, "the left column is the odd one").toBe(true)
  })

  it("marks each boot bridge's throws H and L, on the side of the throw each one names (B0_H/B1_H to 3.3 V on the left)", () => {
    for (const id of ["B0", "B1"]) {
      const bridge = board.parts.find((p) => p.id === id)
      if (bridge?.type !== "switch" || !bridge.throws) {
        expect.soft(bridge?.type, `${id} is a changeover`).toBe("switch")
        continue
      }
      const level = printed.filter((t) => Math.abs(t.y - bridge.y) < 0.01)
      const h = level.find((t) => t.text === "H")
      const l = level.find((t) => t.text === "L")
      expect.soft(h && h.x < bridge.throws.on.x, `${id}: H beside the 'on' throw`).toBe(true)
      expect.soft(l && l.x > bridge.throws.off.x, `${id}: L beside the 'off' throw`).toBe(true)
      expect.soft(bridge.throws.on.x < bridge.throws.off.x, `${id}: H is the left pad`).toBe(true)
    }
  })

  it("draws Q1 as the HC-49/US-SMD it is: the base, the can's flange, its raised top, a tab at each end, all on one centre", () => {
    const at = cell(placed("middle", Q1.centre))
    const around = blocks.filter((b) => (b.fill === "zone" || b.fill === "connector") && Math.abs(b.box.x + b.box.w / 2 - at.x) < 0.01 && Math.abs(b.box.y + b.box.h / 2 - at.y) < 0.01)
    expect.soft(around.map((b) => b.fill).sort(), "base, flange, top").toEqual(["connector", "connector", "zone"])
    const tabs = blocks.filter((b) => b.fill === "zone" && Math.abs(b.box.x + b.box.w / 2 - at.x) < 0.01 && !around.includes(b))
    expect.soft(tabs.length, "a tab at each end").toBe(2)
  })

  it("leaves nothing under a soon badge: everything on the board works", () => {
    expect(board.body.filter((s) => s.type === "soon")).toEqual([])
  })

  it("prints the switch, LED and button names itself", () => {
    expect(board.parts.filter((p) => p.type === "led" || p.type === "button").every((p) => "printed" in p && p.printed)).toBe(true)
  })
})

describe("nothing overlaps", () => {
  it("the overlap check sees two crossing bars with no corner inside each other (the control)", () => {
    const bar = [{ x: -2, y: -0.2 }, { x: 2, y: -0.2 }, { x: 2, y: 0.2 }, { x: -2, y: 0.2 }]
    const post = [{ x: 0.7, y: -2 }, { x: 1.1, y: -2 }, { x: 1.1, y: 1 }, { x: 0.7, y: 1 }]
    expect(polygonsMeet(bar, post)).toBe(true)
  })

  it("no connector or chip overlaps another, except the layers of one package (U1, Q1, the JTAG shroud)", () => {
    const issues: string[] = []
    for (let i = 0; i < solids.length; i++)
      for (let j = i + 1; j < solids.length; j++)
        if (!layersOfOnePackage(solids[i].box, solids[j].box) && boxesMeet(solids[i].box, solids[j].box) && polygonsMeet(solids[i].points, solids[j].points)) issues.push(`${solids[i].fill} at ${at(solids[i].box)} / ${solids[j].fill} at ${at(solids[j].box)}`)
    expect(issues).toEqual([])
  })

  it("no part lands on a block it does not sit in, or on another part", () => {
    const issues: string[] = []
    for (const p of parts) for (const b of solids) if (boxMeetsPolygon(p.box, b.points) && !pointInPolygon(p.centre, b.points)) issues.push(`${p.id} on the ${b.fill} at ${at(b.box)}`)
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (boxesMeet(parts[i].box, parts[j].box)) issues.push(`${parts[i].id} on ${parts[j].id}`)
    expect(issues).toEqual([])
  })

  it("every printed text and mark is clear of every block, part, pin, line and other text, at the printed size", () => {
    expect(clashes(() => 1)).toEqual([])
  })

  it("and at the largest size the field grows them to", () => {
    expect(clashes((t) => growth.get(t) ?? 1)).toEqual([])
  })
})

describe("the H405's USB cable as the field draws it: a USB 2.0 Type-B plug (Fig. 6-14) at scale, clickable all along", () => {
  const PX_PER_CELL = 24
  const g = (cells: number) => cells * PX_PER_CELL
  const mm = (px: number) => (px / PX_PER_CELL) * 2.54
  const usb = board.parts.find((p): p is Extract<typeof p, { type: "usb" }> => p.type === "usb")!
  const draw = (part: typeof usb, on: boolean) =>
    renderToStaticMarkup(React.createElement(Part, { part, g, state: { on }, mirror: false, textScale: 1, partText: () => undefined, onChange: () => {} }))
  const attr = (tag: string, name: string) => Number(new RegExp(`${name}="([-\\d.]+)"`).exec(tag)?.[1])
  const tags = (html: string, test: RegExp) => [...html.matchAll(/<(rect|line)\b[^>]*>/g)].map((m) => m[0]).filter((t) => test.test(t))

  it("shows 2.87 mm of the 8.00 mm plug shell, an 11.5 × 16 mm overmold and a 4.57 mm cable", () => {
    const html = draw(usb, true)
    const [shell] = tags(html, /fill-secondary stroke-border/)
    expect.soft(mm(attr(shell, "height")), "shell width").toBeCloseTo(8.0, 2)
    expect.soft(mm(attr(shell, "width")), "shell showing: 11.75 mating − 8.88 receptacle depth").toBeCloseTo(2.87, 2)
    const [overmold] = tags(html, /<rect[^>]*fill-foreground stroke-none/)
    expect.soft(mm(attr(overmold, "height")), "overmold width, the spec's 11.5 mm limit").toBeCloseTo(11.5, 2)
    expect.soft(mm(attr(overmold, "width")), "overmold length").toBeCloseTo(16, 2)
    const [cable] = tags(html, /<line[^>]*stroke-foreground/)
    expect.soft(mm(attr(cable, "stroke-width")), "cable, 28/24 AWG nominal (Table 6-5)").toBeCloseTo(4.57, 2)
    expect.soft(html.includes('pointer-events="none"'), "no part of the plug drawn click-through").toBe(false)
    expect.soft(/fill-neutral|stroke-neutral/.test(tags(html, /./).join("")), "tokens, not Tailwind colours").toBe(false)
  })

  it("turns the plug with the side the cable leaves from", () => {
    for (const [side, turn] of [["left", undefined], ["right", 180], ["top", 90], ["bottom", -90]] as const) {
      const html = draw({ ...usb, side }, true)
      const rotation = /transform="rotate\((-?\d+)/.exec(html)?.[1]
      expect.soft(rotation === undefined ? undefined : Number(rotation), side).toBe(turn)
    }
  })

  it("prints no label while plugged in, and says so when unplugged; the generic plug keeps its label", () => {
    expect.soft(draw(usb, true).includes(">USB<"), "plugged: no label").toBe(false)
    expect.soft(draw(usb, false).includes("USB (unplugged)"), "unplugged: labelled").toBe(true)
    const generic = { ...usb, plug: undefined }
    expect.soft(draw(generic, true).includes(">USB<"), "the generic plug still labelled").toBe(true)
  })
})
