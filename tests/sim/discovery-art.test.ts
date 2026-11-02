import { describe, expect, it } from "vitest"
import { BOARD_MM, FRAME, HEADER, PITCH, rowY, SOON } from "@/schematic/components/stm32f4-discovery-art"
import { blocksOf, boxesMeet, boxInside, boxMeetsPolygon, homeOf, marksOf, partBox, pointInPolygon, printedBox, printedGrowth, ruleCrossesBox, rulesOf, switchContacts, type Box } from "@/schematic/printed-text"
import { getDef } from "@/schematic/registry"
import type { BodyShape, Point } from "@/schematic/types"

/**
 * The STM32F4-Discovery's artwork against ST's drawings: UM1472 Fig. 5 (66 × 97 mm, P1/P2 pin 1
 * at 6.33 / 57.13 mm across and 33.82 mm down) and the rev-E top silkscreen (SCH-E p8).
 */

const board = getDef("stm32f4-discovery")!
type Text = Extract<BodyShape, { type: "text" }>
type Soon = Extract<BodyShape, { type: "soon" }>

const cell = (mm: Point) => ({ x: (mm.x + FRAME.originX) * FRAME.cellsPerMm, y: (mm.y + FRAME.originY) * FRAME.cellsPerMm })
const printed = board.body.filter((s): s is Text => s.type === "text")
const soons = board.body.filter((s): s is Soon => s.type === "soon")
const soonBoxes: Box[] = soons.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h }))
const blocks = blocksOf(board.body)
/** Pin-1 dots are the board showing through a chip; they belong to it. */
const solids = blocks.filter((b) => b.fill !== "board")
const growth = printedGrowth(board)
const at = (box: Box) => `${box.x.toFixed(2)}, ${box.y.toFixed(2)}`
const sameCentre = (a: Box, b: Box) => Math.abs(a.x + a.w / 2 - b.x - b.w / 2) < 0.01 && Math.abs(a.y + a.h / 2 - b.y - b.h / 2) < 0.01
const polygonsMeet = (a: readonly Point[], b: readonly Point[]) => a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a))
const parts = board.parts.flatMap((p) => {
  const box = partBox(p)
  return box ? [{ id: p.id, box, centre: { x: p.x, y: p.y }, contacts: p.type === "switch" ? switchContacts(p).slice(0, 2) : [] }] : []
})

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

describe("the STM32F4-Discovery is drawn as ST draws the MB997", () => {
  it("to scale: the 66 × 97 mm board is 66 × 97 mm on the field", () => {
    const outline = board.body.find((s): s is Extract<BodyShape, { type: "rect" }> => s.type === "rect" && s.fill === "board")!
    expect(outline.w * 2.54).toBeCloseTo(BOARD_MM.w, 1)
    expect(outline.h * 2.54).toBeCloseTo(BOARD_MM.h, 1)
  })

  it("P1 and P2 stand where UM1472 Fig. 5 puts them: pin 1 at 6.33 and 57.13 mm across, 33.82 mm down, odd pins in the left column", () => {
    const pin = (id: string) => board.pins.find((p) => p.id === id)!
    for (const [id, x, y] of [["P1-1", HEADER.p1, rowY(0)], ["P1-2", HEADER.p1 + PITCH, rowY(0)], ["P2-1", HEADER.p2, rowY(0)], ["P2-50", HEADER.p2 + PITCH, rowY(24)]] as const) {
      expect(pin(id).x, id).toBeCloseTo(cell({ x, y }).x, 2)
      expect(pin(id).y, id).toBeCloseTo(cell({ x, y }).y, 2)
    }
  })

  it("every header name is printed by the board beside its pin, none drawn again by the field", () => {
    expect(board.pins.every((p) => p.printed)).toBe(true)
    const names = printed.filter((t) => t.mono).map((t) => t.text)
    for (const p of board.pins) expect(names, p.id).toContain(p.label)
    expect(board.parts.filter((p) => p.type === "led" || p.type === "button").every((p) => "printed" in p && p.printed)).toBe(true)
  })

  it("carries ST's marks: the logo, the ESD sign, the URL and MB997A", () => {
    expect(printed.map((t) => t.text)).toEqual(expect.arrayContaining(["www.st.com/stm32f4-discovery", "MB997A", "®"]))
    expect(marksOf(board.body).length).toBeGreaterThan(5)
  })
})

describe("what emul does not model is under a soon badge, and only that", () => {
  it("the ST-LINK with SWD, CN3 and USB OTG on CN5", () => {
    expect(soons.map((s) => s.label).sort()).toEqual(Object.values(SOON).map((s) => s.label).sort())
  })

  it("LD1 (COM) and LD7 (OTG VBUS) are drawn there, not as working LEDs", () => {
    expect(board.parts.map((p) => p.id)).not.toContain("LD1")
    expect(board.parts.map((p) => p.id)).not.toContain("LD7")
  })

  it("no working part, pin or other badge sits under a badge", () => {
    const issues: string[] = []
    soonBoxes.forEach((r, i) => {
      for (const p of parts) if (boxesMeet(p.box, r)) issues.push(`${p.id} under ${soons[i].label}`)
      for (const q of board.pins) if (boxesMeet({ x: q.x - 0.25, y: q.y - 0.25, w: 0.5, h: 0.5 }, r)) issues.push(`${q.id} under ${soons[i].label}`)
      for (const b of solids) if (boxesMeet(b.box, r) && !(b.box.x >= r.x && b.box.y >= r.y && b.box.x + b.box.w <= r.x + r.w && b.box.y + b.box.h <= r.y + r.h)) issues.push(`the ${b.fill} at ${at(b.box)} half under ${soons[i].label}`)
      for (let j = i + 1; j < soonBoxes.length; j++) if (boxesMeet(r, soonBoxes[j])) issues.push(`${soons[i].label} on ${soons[j].label}`)
    })
    expect(issues).toEqual([])
  })
})

describe("nothing overlaps", () => {
  it("no connector or chip overlaps another, except a body on its own pads", () => {
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
