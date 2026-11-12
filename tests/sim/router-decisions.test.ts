import { describe, expect, it } from "vitest"
import { GRID, type Point } from "@/schematic/geometry"
import type { LegacySchematic, LegacyWire, PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { examples } from "@/schematic/examples"
import { wirePins, wiresAsSegments } from "@/schematic/migrate-wires"
import { drawEndAt, drawnTo, isRefusal, pointerAt, previewOf, startDrawing, withCorner, type Drawing } from "@/schematic/wire-draw"
import { inNormalForm, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
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
    expect.soft(found, "wires   it("drawn by hand along the CTS row, through the socket, the wire is refused as passing over the pin; over R2's pin the router's route is offered instead, clear of the socket and its shunt", () => {
    const doc = docOf([board("open746i-c"), resistor("R2", 49, 8)])
    const wiring = wiringOf(new WireGraph(), doc)
    const started = startDrawing(wiring, drawEndAt(wiring, at(41, 9)))
    if (isRefusal(started)) throw new Error(started.refused)
    const byHand = previewOf(doc, wiring, pointerAt(started, at(47, 9)), drawEndAt(wiring, at(47, 9)))
    expect.soft(byHand.refused?.refused, "over the CTS socket").toBe("over")
    expect.soft(byHand.refused && cellsOf([byHand.refused.at]), "at the socket").toEqual([[45, 9]])
    const overR2 = previewOf(doc, wiring, pointerAt(started, at(49, 9)), drawEndAt(wiring, at(49, 9)))
    const cts = shunted(doc).find((p) => p.key === "U1:VCP-CTS")!
    const pad = { x: cts.at.x + cts.shunt!.x, y: cts.at.y + cts.shunt!.y }
    expect.soft([overR2.refused?.refused ?? null, overR2.routed], "over R2's pin: the router's route, not the refusal (design.md §13.22 question 7 A)").toEqual([null, true])
    expect.soft(legsOf(overR2.points).some((s) => contains(s, cts.at) || segmentsMeet(s, { a: cts.at, b: pad })), `clear of CTS and its shunt: ${JSON.stringify(cellsOf(overR2.points))}`).toBe(false)
  })
e socket").toEqual([[45, 9]])
  })
})

describe("the freeze passes its own net's pins as it passes its own net's wires, and counts a crossing of its own net as a crossing (the main session's decisions on review B's questions 3 and 4; design.md §13.22)", () => {
  const frozen = (objects: PlacedObject[], wires: LegacyWire[]) => {
    let i = 0
    return wiresAsSegments({ objects, wires, parts: {} } satisfies LegacySchematic, () => `z${i++}`)
  }
  const wire = (id: string, from: [string, string], to: [string, string]): LegacyWire => ({ id, from: { object: from[0], pin: from[1] }, to: { object: to[0], pin: to[1] } })

  it("R1 → R3 along row 1 over R2's bottom pin, which R1's other wire already reaches: straight over it, not round it (review B finding 3, system-exam's current mirror)", () => {
    const { routes, notes } = frozen([resistor("R1", 0, 0), resistor("R2", 8, -3, 90), resistor("R3", 10, 0)], [wire("a", ["R1", "2"], ["R2", "2"]), wire("b", ["R1", "2"], ["R3", "1"])])
    expect.soft(cellsOf(routes.get("b") ?? []), "the straight row, over R2:2 of its own net").toEqual([
      [4, 1],
      [10, 1],
    ])
    expect.soft(notes, "nothing laid again").toEqual([])
  })

  it("of two one-corner routes from R1 to R3's top pin, the one that crosses no wire of its own net: down beside R1 and along the net's wire into R3, not along R1's axis across the net's riser (review B finding 8)", () => {
    const { routes, doc } = frozen([resistor("R1", 0, 0), resistor("R2", 6, -5, 90), resistor("R3", 9, 5, 90)], [wire("riser", ["R2", "2"], ["R3", "1"]), wire("w", ["R1", "2"], ["R3", "1"])])
    expect.soft(cellsOf(routes.get("riser") ?? []), "guard: the net's riser runs down x = 7 and along row 5 into R3").toEqual([
      [7, -1],
      [7, 5],
      [10, 5],
    ])
    expect.soft(cellsOf(routes.get("w") ?? []), "down first, onto the riser's row, no crossing").toEqual([
      [4, 1],
      [4, 5],
      [10, 5],
    ])
    expect.soft(pinPartition(wireNets(doc.wires, wirePins(doc.objects))), "one net").toEqual([["R1:2", "R2:2", "R3:1"]])
  })
})

const halfSteps = (wires: readonly { readonly a: Point; readonly b: Point }[]) => {
  const out = new Set<string>()
  for (const { a, b } of wires) {
    const n = (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) / (GRID / 2)
    const step = { x: (Math.sign(b.x - a.x) * GRID) / 2, y: (Math.sign(b.y - a.y) * GRID) / 2 }
    for (let k = 0; k < n; k++) {
      const p = [a.x + step.x * k, a.y + step.y * k]
      const q = [a.x + step.x * (k + 1), a.y + step.y * (k + 1)]
      out.add(p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]) ? `${p} ${q}` : `${q} ${p}`)
    }
  }
  return [...out].sort()
}
const legsOf = (points: readonly Point[]) => points.slice(1).map((b, i) => ({ a: points[i], b }))
let drawn = 0
const drawnId = () => `d${++drawn}`

describe("the completion is offered from any start and after corners, the corners kept on the route (the main session's decision on review B's question 6; design.md §6.1, §13.22 question 7)", () => {
  const overR3 = () => [resistor("R1", 0, 0), resistor("R2", 10, 0), resistor("R3", 6, -3, 90)]
  const offered = (doc: Schematic, d: Drawing, to: Point, startsWith: Point[]) => {
    const wiring = wiringOf(new WireGraph(), doc)
    const target = drawEndAt(wiring, to)
    const preview = previewOf(doc, wiring, pointerAt(d, to), target)
    expect.soft(preview.refused?.refused ?? null, "the router's route is offered, not a refusal").toBeNull()
    expect.soft(preview.routed, "routed").toBe(true)
    expect.soft(cellsOf(preview.points.slice(0, startsWith.length)), "it starts where the drawing does, through every corner placed").toEqual(cellsOf(startsWith))
    expect.soft(cellsOf(preview.points.slice(-1)), "and ends on the target pin").toEqual(cellsOf([to]))
    const after = drawnTo(doc, wiring, pointerAt(d, to), target, drawnId)
    expect.soft(isRefusal(after) ? after.refused : halfSteps(after.wires), "the click lays exactly the preview").toEqual(halfSteps([...doc.wires, ...legsOf(preview.points)]))
    return isRefusal(after) ? null : after
  }

  it("from a dangling end of R1's wire, past R3's bottom pin on the row: the router's route, not the refused straight row", () => {
    const doc = docOf(overR3(), [{ id: "w", a: at(4, 1), b: at(5, 1) }])
    const wiring = wiringOf(new WireGraph(), doc)
    const started = startDrawing(wiring, drawEndAt(wiring, at(5, 1)))
    if (isRefusal(started)) throw new Error(started.refused)
    expect.soft(started.from.kind, "guard: the drawing starts on the wire's open end").toBe("end")
    const after = offered(doc, started, at(10, 1), [at(5, 1)])
    expect.soft(after && pinPartition(wireNets(after.wires, wirePins(after.objects))), "R1 and R2 joined, R3 on nothing").toEqual([["R1:2", "R2:1"]])
  })

  it("from a branch point on a wire, where both plain Ls pass another net's pin: the router's route", () => {
    const doc = docOf([...overR3(), resistor("R5", 9, 2, 90)], [{ id: "w", a: at(4, 1), b: at(4, 4) }])
    const wiring = wiringOf(new WireGraph(), doc)
    const started = startDrawing(wiring, drawEndAt(wiring, at(4, 3)))
    if (isRefusal(started)) throw new Error(started.refused)
    expect.soft(started.from.kind, "guard: the drawing starts on the wire, a branch").toBe("wire")
    const after = offered(doc, started, at(10, 1), [at(4, 3)])
    expect.soft(after && pinPartition(wireNets(after.wires, wirePins(after.objects))), "R1 and R2 joined, R3 and R5 on nothing").toEqual([["R1:2", "R2:1"]])
  })

  it("from R1's pin after a corner placed below it: the route continues from the corner, the leg drawn kept, never back up it", () => {
    const doc = docOf([...overR3(), resistor("R5", 9, 2, 90)])
    const wiring = wiringOf(new WireGraph(), doc)
    const started = startDrawing(wiring, drawEndAt(wiring, at(4, 1)))
    if (isRefusal(started)) throw new Error(started.refused)
    const cornered = withCorner(doc, wiring, pointerAt(started, at(4, 4)), at(4, 4))
    if (isRefusal(cornered)) throw new Error(cornered.refused)
    expect.soft(cellsOf(cornered.corners), "guard: one corner, at (4, 4)").toEqual([[4, 4]])
    const after = offered(doc, cornered, at(10, 1), [at(4, 1), at(4, 4)])
    expect.soft(after && pinPartition(wireNets(after.wires, wirePins(after.objects))), "R1 and R2 joined").toEqual([["R1:2", "R2:1"]])
  })
})

describe("the row taken after the fact is shown while the end is held over the socket, and the click lays what is shown (the main session's decision on review B's question 5; design.md §13.9)", () => {
  it("R1 → RESET while D45's wire passes RESET's socket: the preview carries D45's wire on its half-cell slip, and the release lays exactly the drawn wire and that slip", () => {
    const doc = docOf([board("nucleo-f429zi"), resistor("R4", -12, 18), resistor("R1", -6, 15)], [{ id: "d45", a: at(6, 19), b: at(-8, 19) }])
    const wiring = wiringOf(new WireGraph(), doc)
    const started = startDrawing(wiring, drawEndAt(wiring, at(-2, 16)))
    if (isRefusal(started)) throw new Error(started.refused)
    const d = pointerAt(started, at(5, 19))
    const target = drawEndAt(wiring, at(5, 19))
    const preview = previewOf(doc, wiring, d, target)
    expect.soft(preview.refused, "offered").toBeNull()
    expect.soft(preview.moved.map((m) => m.run), "D45's run moves").toEqual([wiring.runBySegment.get("d45")?.id])
    const slip = preview.moved[0]?.points ?? []
    expect.soft(slip.some((p) => p.y === at(0, 19.5).y || p.y === at(0, 18.5).y), `on a half row out of RESET's: ${JSON.stringify(cellsOf(slip))}`).toBe(true)
    const after = drawnTo(doc, wiring, d, target, drawnId)
    expect.soft(isRefusal(after) ? after.refused : halfSteps(after.wires), "the release lays the preview: the drawn wire and D45's on the slip shown").toEqual(halfSteps([...legsOf(preview.points), ...legsOf(slip)]))
  })
})

