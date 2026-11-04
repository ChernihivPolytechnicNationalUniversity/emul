import { describe, expect, it } from "vitest"
import { boxesMeet, printedBox, printedGrowth, ruleCrossesBox, rulesOf } from "@/schematic/printed-text"
import { getDef } from "@/schematic/registry"
import type { BodyShape, PinDef, Point, Side } from "@/schematic/types"

/** The Arduino Nano's artwork: the names printed for its pins, and the room they have. */

const board = getDef("arduino-nano")!
type Text = Extract<BodyShape, { type: "text" }>
const printed = board.body.filter((s): s is Text => s.type === "text")
const growth = printedGrowth(board)

/** How far `p` lies from the pin towards the side its label goes, in cells (negative: the other way). */
const toward = (side: Side, pin: Point, p: Point) => ({ left: pin.x - p.x, right: p.x - pin.x, top: pin.y - p.y, bottom: p.y - pin.y })[side]
/** The name printed for a pin: its label, within 1.2 cells of it, on the side its label goes. */
const nameOf = (pin: PinDef) => printed.find((t) => t.text === pin.label && Math.hypot(t.x - pin.x, t.y - pin.y) < 1.2 && toward(pin.labelAt, pin, t) > 0.5)

function clashes(factor: (t: Text) => number): string[] {
  const boxes = printed.map((t) => printedBox(t, factor(t)))
  const rules = rulesOf(board.body)
  const issues: string[] = []
  printed.forEach((t, i) => {
    const where = `"${t.text}" at ${t.x}, ${t.y}`
    for (const line of rules) if (ruleCrossesBox(line, boxes[i])) issues.push(`${where} across a silkscreen line`)
    for (let j = i + 1; j < printed.length; j++) if (boxesMeet(boxes[i], boxes[j])) issues.push(`${where} on "${printed[j].text}"`)
  })
  return issues
}

describe("the Arduino Nano's artwork", () => {
  it("prints every pin's name beside it, on the side its label goes: both headers', the serial pins' by the USB and ICSP's six", () => {
    expect(board.pins.filter((pin) => !nameOf(pin)).map((pin) => pin.id)).toEqual([])
    // ICSP's, level over the near row and under the far one.
    const icsp = board.pins.filter((pin) => pin.connector === "J4")
    expect(icsp.map((pin) => nameOf(pin)!.text)).toEqual(["MISO", "+5V", "SCK", "MOSI", "RST", "GND"])
    expect(new Set(icsp.map((pin) => nameOf(pin)!.y)).size).toBe(2)
    // The headers' and ICSP's names are one size and grow as one.
    const names = board.pins.filter((pin) => pin.connector).map((pin) => nameOf(pin)!)
    expect(new Set(names.map((t) => `${t.size} × ${growth.get(t) ?? 1}`)).size).toBe(1)
  })

  it("no name on another or across a silkscreen line, at the size it is printed and at the size it grows to", () => {
    expect(clashes(() => 1)).toEqual([])
    expect(clashes((t) => growth.get(t) ?? 1)).toEqual([])
  })
})
