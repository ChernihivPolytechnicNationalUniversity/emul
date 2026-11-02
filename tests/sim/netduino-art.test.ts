import { describe, expect, it } from "vitest"
import { BOARD_MM, FRAME, HEADER, HIGH_SHIFT, HOLES, OUTLINE, PITCH, SILK, SOON } from "@/schematic/components/netduino-plus-2-art"
import { soonBadge } from "@/components/field/body-paint"
import { blocksOf, boxesMeet, boxInside, boxMeetsPolygon, homeOf, marksOf, partBox, pointInPolygon, printedBox, printedGrowth, ruleCrossesBox, rulesOf, switchContacts, type Box } from "@/schematic/printed-text"
import { getDef } from "@/schematic/registry"
import type { BodyShape, Point } from "@/schematic/types"

/**
 * The Netduino Plus 2's artwork against the Arduino Uno R3 it copies (outline, header pads,
 * mounting holes) and the board's own silkscreen, measured on a top view of it.
 */

const board = getDef("netduino-plus-2")!
type Text = Extract<BodyShape, { type: "text" }>
type Soon = Extract<BodyShape, { type: "soon" }>

const cell = (mm: Point) => ({ x: (mm.x + FRAME.originX) * FRAME.cellsPerMm, y: (mm.y + FRAME.originY) * FRAME.cellsPerMm })
const printed = board.body.filter((s): s is Text => s.type === "text")
const soons = board.body.filter((s): s is Soon => s.type === "soon")
const soonBoxes: Box[] = soons.flatMap((s) => [{ x: s.x, y: s.y, w: s.w, h: s.h }, soonBadge(s)])
const blocks = blocksOf(board.body)
/** Pin-1 dots and the holes are the board showing through; they belong to what they are in. */
const solids = blocks.filter((b) => b.fill !== "board")
const growth = printedGrowth(board)
const at = (box: Box) => `${box.x.toFixed(2)}, ${box.y.toFixed(2)}`
const sameCentre = (a: Box, b: Box) => Math.abs(a.x + a.w / 2 - b.x - b.w / 2) < 0.01 && Math.abs(a.y + a.h / 2 - b.y - b.h / 2) < 0.01
const polygonsMeet = (a: readonly Point[], b: readonly Point[]) => a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a))
const parts = board.parts.flatMap((p) => {
  const box = partBox(p)
  return box ? [{ id: p.id, box, centre: { x: p.x, y: p.y }, contacts: p.type === "switch" ? switchContacts(p).slice(0, 2) : [] }] : []
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
    for (const r of soonBoxes) if (boxesMeet(box, r)) issues.push(`${where} under a soon badge`)
    for (const p of parts) if (boxesMeet(box, p.box)) issues.push(`${where} on ${p.id}`)
    for (const mark of marksOf(board.body)) if (boxMeetsPolygon(box, mark)) issues.push(`${where} on a mark`)
    for (const q of board.pins) if (boxesMeet(box, { x: q.x - 0.25, y: q.y - 0.25, w: 0.5, h: 0.5 })) issues.push(`${where} on pin ${q.id}`)
    for (const line of rules) if (ruleCrossesBox(line, box)) issues.push(`${where} across a silkscreen line at ${at({ ...line[0], w: 0, h: 0 })}`)
    for (let j = i + 1; j < printed.length; j++) if (boxesMeet(box, boxes[j])) issues.push(`${where} on "${printed[j].text}"`)
  })
  return issues
}

/** Each header's pins left to right, with the x its first pad has on the Uno R3 and the shift it is drawn at. */
const HEADERS = [
  { ids: ["SCL", "SDA", "AREF", "GND1", "D13", "D12", "D11", "D10", "D9", "D8"], first: HEADER.high, y: HEADER.top, shift: HIGH_SHIFT, silk: SILK.high },
  { ids: ["D7", "D6", "D5", "D4", "D3", "D2", "D1", "D0"], first: HEADER.low, y: HEADER.top, shift: 0, silk: SILK.low },
  { ids: ["NC", "IOREF", "RESET", "3V3", "5V", "GND2", "GND3", "VIN"], first: HEADER.power, y: HEADER.bottom, shift: 0, silk: SILK.power },
  { ids: ["A0", "A1", "A2", "A3", "A4", "A5"], first: HEADER.analog, y: HEADER.bottom, shift: 0, silk: SILK.analog },
]

describe("the Netduino Plus 2 is drawn as the board is made", () => {
  it("to scale, on the Uno R3's outline: 68.58 × 53.34 mm with the notch at the top right", () => {
    const plate = board.body.find((s): s is Extract<BodyShape, { type: "art" }> => s.type === "art" && s.fill === "board")!
    const outline = blocks.filter((b) => b.fill === "board").sort((a, b) => b.area - a.area)[0]
    expect(plate).toBeDefined()
    expect(outline.box.w * 2.54).toBeCloseTo(BOARD_MM.w, 1)
    expect(outline.box.h * 2.54).toBeCloseTo(BOARD_MM.h, 1)
    // Inside the notch (x past 66.04 mm above y 12.95 mm) is off the board; below it, on it.
    expect(pointInPolygon(cell({ x: 67.5, y: 6 }), outline.points)).toBe(false)
    expect(pointInPolygon(cell({ x: 67.5, y: 30 }), outline.points)).toBe(true)
    expect(OUTLINE.some((p) => p.x === 66.04 && p.y === 12.954) && OUTLINE.some((p) => p.x === 68.58 && p.y === 15.494)).toBe(true)
  })

  it("the whole board, with the RJ45 and the DC jack over its left edge, inside the part's box", () => {
    for (const b of blocks) {
      expect.soft(b.box.x, `${b.fill} at ${at(b.box)}`).toBeGreaterThanOrEqual(0)
      expect.soft(b.box.x + b.box.w, `${b.fill} at ${at(b.box)}`).toBeLessThanOrEqual(board.width + 0.01)
      expect.soft(b.box.y + b.box.h, `${b.fill} at ${at(b.box)}`).toBeLessThanOrEqual(board.height)
    }
    const jack = solids.filter((b) => b.box.x < cell({ x: 0, y: 0 }).x)
    expect(jack.length, "parts over the left edge").toBeGreaterThanOrEqual(2)
  })

  it("the headers stand on the Uno R3's rows; D8–SCL drawn 0.4 pitch left, where its pins are rounded to", () => {
    for (const h of HEADERS)
      h.ids.forEach((id, i) => {
        const want = cell({ x: h.first + i * PITCH + h.shift, y: h.y })
        expect.soft(pin(id).x, id).toBeCloseTo(want.x, 2)
        expect.soft(pin(id).y, id).toBeCloseTo(want.y, 2)
      })
    // The gap between D8 and D7 is the Uno's 0.16", drawn 0.2".
    expect(pin("D7").x - pin("D8").x).toBe(2)
  })

  it("each header name is printed in its box as on the board: AREF's and NC's empty, A0–A5 as 0–5", () => {
    expect(board.pins.every((p) => p.printed)).toBe(true)
    const names = printed.filter((t) => t.mono)
    for (const h of HEADERS)
      h.ids.forEach((id, i) => {
        const sameSide = (t: Text) => (t.y < board.height / 2) === (pin(id).y < board.height / 2)
        const here = names.filter((t) => Math.abs(t.x - pin(id).x) < 0.01 && sameSide(t))
        expect.soft(here.map((t) => t.text), id).toEqual(h.silk[i] ? [h.silk[i]] : [])
      })
    expect(names.every((t) => t.rotate === -90)).toBe(true)
    expect(board.parts.filter((p) => p.type === "led" || p.type === "button").every((p) => "printed" in p && p.printed)).toBe(true)
  })

  it("carries the board's marks: the netduino plus 2 mark, its URL, REV.A and the captions", () => {
    expect(printed.map((t) => t.text)).toEqual(expect.arrayContaining(["www.netduino.com", "REV.A", "Digital I/O", "Power", "Analog In", "MicroSD", "7.5-9.0V", "ACT", "PWR", "LED", "BTN"]))
    // The traced logo: 17 glyph outlines (n e t d u i i n o p l u s 2 T M), the o's counter.
    expect(marksOf(board.body).length).toBeGreaterThanOrEqual(18)
  })

  it("three plated holes, the Uno's less the bottom-left one the microSD socket takes", () => {
    expect(HOLES).toHaveLength(3)
    const plate = blocks.filter((b) => b.fill === "board")
    for (const h of HOLES) {
      const c = cell(h)
      expect(plate.some((b) => b.area < 2 && pointInPolygon(c, b.points)), `hole at ${h.x}, ${h.y}`).toBe(true)
    }
  })
})

describe("what emul does not model is under a soon badge, and only that", () => {
  it("the RJ45's network side and the microSD card", () => {
    expect(soons.map((s) => s.label).sort()).toEqual(Object.values(SOON).map((s) => s.label).sort())
  })

  it("the working LEDs, button and USB are LED, PWR, ACT, BTN and USB", () => {
    expect(board.parts.map((p) => p.id).sort()).toEqual(["ACT", "BTN", "LED", "PWR", "USB"])
  })

  it("no working part, pin or other badge sits under a badge", () => {
    const issues: string[] = []
    soonBoxes.forEach((r, k) => {
      const i = Math.floor(k / 2)
      for (const p of parts) if (boxesMeet(p.box, r)) issues.push(`${p.id} under ${soons[i].label}`)
      for (const q of board.pins) if (boxesMeet({ x: q.x - 0.25, y: q.y - 0.25, w: 0.5, h: 0.5 }, r)) issues.push(`${q.id} under ${soons[i].label}`)
      for (const b of solids) if (boxesMeet(b.box, r) && !(b.box.x >= r.x && b.box.y >= r.y && b.box.x + b.box.w <= r.x + r.w && b.box.y + b.box.h <= r.y + r.h)) issues.push(`the ${b.fill} at ${at(b.box)} half under ${soons[i].label}`)
      for (let j = (i + 1) * 2; j < soonBoxes.length; j++) if (boxesMeet(r, soonBoxes[j])) issues.push(`${soons[i].label} on ${soons[Math.floor(j / 2)].label}`)
    })
    expect(issues).toEqual([])
  })
})

describe("nothing overlaps", () => {
  it("no connector or chip overlaps another, except a body on its own leads", () => {
    const issues: string[] = []
    for (let i = 0; i < solids.length; i++)
      for (let j = i + 1; j < solids.length; j++)
        if (!sameCentre(solids[i].box, solids[j].box) && boxesMeet(solids[i].box, solids[j].box) && polygonsMeet(solids[i].points, solids[j].points)) issues.push(`${solids[i].fill} at ${at(solids[i].box)} / ${solids[j].fill} at ${at(solids[j].box)}`)
    expect(issues).toEqual([])
  })

  it("no part lands on a block it does not sit in, or on another part", () => {
    const issues: string[] = []
    for (const p of parts) for (const b of solids) if (boxMeetsPolygon(p.box, b.points) && !pointInPolygon(p.centre, b.points)) issues.push(`${p.id} on the ${b.fill} at ${at(b.box)}`)
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (boxesMeet(parts[i].box, parts[j].box)) issues.push(`${parts[i].id} on ${parts[j].id}`)
    expect(issues).toEqual([])
  })

  it("every name and mark is clear of every block, part, pin, line and other text, at the printed size", () => {
    expect(clashes(() => 1)).toEqual([])
  })

  it("and at the largest size the field grows them to", () => {
    expect(clashes((t) => growth.get(t) ?? 1)).toEqual([])
  })
})
