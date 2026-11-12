import { describe, expect, it } from "vitest"
import { GRID, type Point } from "@/schematic/geometry"
import type { PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { examples } from "@/schematic/examples"
import { wirePins } from "@/schematic/migrate-wires"
import { drawEndAt, isRefusal, pointerAt, previewOf, startDrawing } from "@/schematic/wire-draw"
import { inNormalForm, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import { isRerouteRefusal, REROUTE_REFUSED, rerouted, routeBetween, type RouteEnd } from "@/schematic/wires/router"
import { contains, passesInside, samePoint, segmentsMeet, type WireSegment } from "@/schematic/wires/segment"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const resistor = (id: string, x: number, y: number, rotation?: Rotation): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
const board = (def: string, x = 0, y = 0): PlacedObject => ({ id: "U1", def, x: c(x), y: c(y), props: { ref: "U1" } })
const pin = (object: string, id: string): RouteEnd => ({ pin: { object, pin: id } })
const cellsOf = (points: readonly Point[]) => points.map((p) => [p.x / GRID, p.y / GRID])
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })

function linesRead(doc: Schematic, from: RouteEnd, to: RouteEnd): { route: readonly Point[] | null; lines: number } {
  const wiring: Wiring = wiringOf(new WireGraph(), doc)
  let lines = 0
  const along = wiring.sheet.along.bind(wiring.sheet)
  Object.assign(wiring.sheet, { along: (...args: Parameters<typeof along>) => (lines++, along(...args)) })
  const route = routeBetween(doc, from, to, wiring)
  return { route, lines }
}

describe("a route that does not exist is known at once, a route that does is the cheapest at any distance (the main session's decision on review A's question 1; design.md §7, §11)", () => {
  it("RESET → D45 on the bare Nucleo, the inner socket behind RESET: no route, decided on about the window a route to a resistor beside the board needs, not by growing it to 128 cells", () => {
    const doc = docOf([board("nucleo-f429zi"), resistor("R1", -6, 18)])
    const reached = linesRead(doc, pin("U1", "CN8-5"), pin("R1", "2"))
    const jumper = linesRead(doc, pin("U1", "CN8-5"), pin("U1", "CN8-6"))
    expect.soft(reached.route, "guard: RESET reaches R1").not.toBeNull()
    expect.soft(jumper.route, "RESET → D45: every way leaves RESET backwards or comes back through it").toBeNull()
    expect.soft(jumper.lines <= 2 * reached.lines, `decided on about the first window (${reached.lines} rows and columns for R1), not the 128-cell one (${jumper.lines})`).toBe(true)
  })
})

describe("T on a run with no route is refused with the reason that is true (the main session's decision on review A's question 2; design.md §7, §13.22)", () => {
  it("the one-cell jumper RESET → D45: no route but back through RESET's socket, and no other net in the way — refused as the ends themselves, not as another net's wire", () => {
    const doc = docOf([board("nucleo-f429zi")], [{ id: "j", a: at(5, 19), b: at(6, 19) }])
    const result = rerouted(doc, "j", () => "n")
    expect.soft(isRerouteRefusal(result) && result.refused, "refused, as the ends").toBe("no-way")
    expect.soft(REROUTE_REFUSED["no-way"].title, "with the toast's title").toBe("Not re-routed")
    expect.soft(REROUTE_REFUSED["no-way"].why.includes("another net"), "and words that do not blame another net").toBe(false)
  })

  it("a run boxed in by other nets' pins stays refused as another net's (router.test.ts «refused, and named, when no clean path exists»)", () => {
    const doc = docOf([resistor("R2", 8, 0), resistor("R5", 3, 0), resistor("R6", 7, -4, 90), resistor("R7", 7, 2, 90)], [
      { id: "a", a: at(8, 1), b: at(8, 1.5) },
      { id: "b", a: at(8, 1.5), b: at(10, 1.5) },
      { id: "c", a: at(10, 1.5), b: at(10, 4) },
    ])
    const result = rerouted(doc, "a", () => "n")
    expect.soft(isRerouteRefusal(result) && result.refused, "refused as another net's").toBe("no-clean-path")
  })
})

describe("a socket pair joined by a drawn shunt is impassable along its row, as a header column (the main session's decision on review B's question 2; design.md §4.5, §13.22 question 6)", () => {
  const shunted = (doc: Schematic) => wirePins(doc.objects).filter((p) => p.shunt)

  it("guard: on the Open746I-C the POWER JMP's VBAT and VREF+ pins carry their shunt up to the 3.3 V rail and the four USART1 jumper sockets theirs, one cell to the PA pads on their left; no other socket of the board does", () => {
    const pins = shunted(docOf([board("open746i-c")]))
    expect.soft(pins.map((p) => [p.key, p.at.x / GRID, p.at.y / GRID, p.shunt!.x / GRID, p.shunt!.y / GRID]).sort(), "VBAT, VCP-CTS, -RTS, -RX, -TX, VREF+").toEqual([
      ["U1:VBAT", 18.5, 12.5, 0, -1],
      ["U1:VCP-CTS", 45, 9, -1, 0],
      ["U1:VCP-RTS", 45, 10, -1, 0],
      ["U1:VCP-RX", 45, 8, -1, 0],
      ["U1:VCP-TX", 45, 7, -1, 0],
      ["U1:VREF+", 19.5, 12.5, 0, -1],
    ])
  })

  it("no example's wire passes a jumper's socket or runs onto its shunt (review B finding 2: open746-touch's TX → RXD ran along PA11's shunt and through CTS)", () => {
    const found: string[] = []
    for (const example of examples) {
      const doc = example.build(GRID)
      for (const p of shunted(doc)) {
        const far = { x: p.at.x + p.shunt!.x, y: p.at.y + p.shunt!.y }
        for (const s of doc.wires) {
          const through = passesInside(s, p.at)
          const onShunt = contains(s, far) || segmentsMeet(s, { a: p.at, b: far }) && !(samePoint(s.a, p.at) || samePoint(s.b, p.at))
          if (through || onShunt) found.push(`${example.id}: ${p.key} (${s.a.x / GRID}, ${s.a.y / GRID})–(${s.b.x / GRID}, ${s.b.y / GRID})`)
        }
      }
    }
    expect.soft(found, "wires across a shunt").toEqual([])
  })

  it("drawn by hand along the CTS row, through the socket, the wire is refused as passing over the pin", () => {
    const doc = docOf([board("open746i-c"), resistor("R2", 49, 8)])
    const wiring = wiringOf(new WireGraph(), doc)
    const started = startDrawing(wiring, drawEndAt(wiring, at(41, 9)))
    if (isRefusal(started)) throw new Error(started.refused)
    const preview = previewOf(doc, wiring, pointerAt(started, at(49, 9)), drawEndAt(wiring, at(49, 9)))
    expect.soft(preview.refused?.refused, "over the CTS socket").toBe("over")
    expect.soft(preview.refused && cellsOf([preview.refused.at]), "at the socket").toEqual([[45, 9]])
  })
})
