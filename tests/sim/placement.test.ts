import { describe, expect, it } from "vitest"
import { examples } from "@/schematic/examples"
import { GRID, intersects, objectPins, objectRect, Router, snap } from "@/schematic/geometry"
import { bodyBounds, contactCheck, contourOf, designatorRects, footprints, freeOffset, freeSpot, landingOffset, nearestFreeWithin, placementCheck, ringsToClear, type PlacementScene } from "@/schematic/placement"
import { allDefs, getDef } from "@/schematic/registry"
import type { LegacyWire as Wire, PlacedObject } from "@/schematic/types"
import type { WireSegment } from "@/schematic/wires/segment"
import { routesOf } from "../lib/routes"
import { PartDrag } from "@/schematic/rubber-band"
import { inNormalForm, wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import { boardDocuments } from "../../scripts/lib/stress"

const c = (v: number) => v * GRID
const part = (id: string, def: string, x: number, y: number): PlacedObject => ({ id, def, x: c(x), y: c(y) })

function scene(objects: PlacedObject[], wires: readonly (Wire | WireSegment)[] = []): PlacementScene {
  return { objects, routes: routesOf(objects, wires), grid: GRID }
}

describe("a part takes the room it draws, not its whole box", () => {
  it("a resistor is as tall as its body, not its two-cell box", () => {
    const b = bodyBounds(getDef("resistor")!)
    expect(b.w).toBeCloseTo(4)
    expect(b.h).toBeCloseTo(0.8)
  })
})

const turned = (id: string, def: string, x: number, y: number, rotation: 90 | 180 | 270): PlacedObject => ({ ...part(id, def, x, y), rotation })

const TWO_TERMINAL = ["resistor", "capacitor", "inductor", "diode", "led", "zener"] as const

const cellsOf = (p: { x: number; y: number }) => ({ x: p.x / GRID, y: p.y / GRID })

describe("a part occupies its drawn body and its leads, nothing else (design.md §5.1)", () => {
  it("a resistor's footprint is its body and two leads as lines: the body box stops where the leads begin, inset by the 0.1-cell clearance", () => {
    const f = footprints(part("r", "resistor", 0, 0), GRID)!
    const box = f.body.box
    expect.soft([box.x, box.y, box.x + box.w, box.y + box.h].map((v) => Math.round((v / GRID) * 100) / 100), "1.1–2.9 × 0.7–1.3 cells").toEqual([1.1, 0.7, 2.9, 1.3])
    expect.soft(f.leads.map(([p, q]) => [cellsOf(p), cellsOf(q)]), "the two leads, pin to body").toEqual([
      [{ x: 0, y: 1 }, { x: 1, y: 1 }],
      [{ x: 4, y: 1 }, { x: 3, y: 1 }],
    ])
  })

  it("a diode's body holds its triangle and bar and no lead; the leads run from the pins to the body (design.md §5.1)", () => {
    const f = footprints(part("d", "diode", 0, 0), GRID)!
    const box = f.body.box
    expect.soft([box.x, box.x + box.w].map((v) => Math.round((v / GRID) * 100) / 100), "1.7–2.3 cells across").toEqual([1.7, 2.3])
    expect.soft(f.leads.map(([p, q]) => [cellsOf(p), cellsOf(q)]), "pin to body").toEqual([
      [{ x: 0, y: 1 }, { x: 1.6, y: 1 }],
      [{ x: 4, y: 1 }, { x: 2.4, y: 1 }],
    ])
  })

  it("no text is part of any footprint: no definition's footprint holds a text box, and its body, contour and leads do not change with a long designator and value (design.md §5.1)", () => {
    const named = (o: PlacedObject): PlacedObject => ({ ...o, props: { ...o.props, ref: "R123456789", value: "1234567890 kΩ" } })
    const offenders: string[] = []
    for (const def of allDefs()) {
      const o = part("x", def.id, 0, 0)
      const plain = footprints(o, GRID)
      const labelled = footprints(named(o), GRID)
      if (labelled && labelled.labels.length) offenders.push(`${def.id}: ${labelled.labels.length} text boxes`)
      if (JSON.stringify(plain && { body: plain.body, contour: plain.contour, leads: plain.leads }) !== JSON.stringify(labelled && { body: labelled.body, contour: labelled.contour, leads: labelled.leads })) offenders.push(`${def.id}: moves with its text`)
    }
    expect(offenders.slice(0, 30)).toEqual([])
  })

  it("any two of resistor, capacitor, inductor, diode, LED and Zener, one upright and one lying, butted pin to pin at a right angle, may be placed in all four corners: the leads are lines that meet at the pin (design.md §5.1; findings 2.D12, 4.U12; KiCad, OrCAD)", () => {
    for (const upright of TWO_TERMINAL) {
      for (const lying of TWO_TERMINAL) {
        const corners = [
          { name: "upright below, lying to the right", u: part("u", upright, 0, 0), l: part("l", lying, 1, -1) },
          { name: "upright below, lying to the left", u: part("u", upright, 0, 0), l: part("l", lying, -3, -1) },
          { name: "upright above, lying to the right", u: part("u", upright, 0, -4), l: part("l", lying, 1, -1) },
          { name: "upright above, lying to the left", u: part("u", upright, 0, -4), l: part("l", lying, -3, -1) },
        ]
        for (const { name, u, l } of corners) {
          const up = { ...u, rotation: 90 as const }
          const s = scene([up, l])
          expect.soft(contactCheck(s, [l])(0, 0), `${upright} upright, ${lying} lying, ${name}: the two pins meet`).toBe(true)
          expect.soft(placementCheck(s, [l])(0, 0), `${upright} upright, ${lying} lying, ${name}: the lying part may stand there`).toBe(false)
          expect.soft(placementCheck(s, [up])(0, 0), `${upright} upright, ${lying} lying, ${name}: and so may the upright one`).toBe(false)
        }
      }
    }
  })

  it("a transistor's base lead butted at a right angle onto an upright diode's pin may be placed: a three-pin part's lead is a line too (design.md §5.1; plan.md phase 5)", () => {
    const q = part("q", "npn", 1, -2)
    const d = turned("d", "diode", 0, -4, 90)
    const s = scene([q, d])
    expect.soft(contactCheck(s, [d])(0, 0), "the diode's lower pin on the base").toBe(true)
    expect.soft(placementCheck(s, [d])(0, 0), "allowed").toBe(false)
  })

  it("a pin landing on another part's lead, not on its pin, is refused (design.md §5.1's rule; ГОСТ 2.721-74 item 6 note 3: a symbol's own graphical elements are not branch points)", () => {
    const d = part("d", "diode", 0, 0)
    const r = turned("r", "resistor", 0, 1, 90)
    const s = scene([d, r])
    expect.soft(contactCheck(s, [r])(0, 0), "no pin under the resistor's top pin").toBe(false)
    expect.soft(placementCheck(s, [r])(0, 0), "its pin on the diode's lead at x = 1: refused").toBe(true)
  })

  it("a pin landing on another part's body is refused (design.md §5.1)", () => {
    const a = part("a", "resistor", 0, 0)
    const b = turned("b", "resistor", 1, 1, 90)
    expect(placementCheck(scene([a, b]), [b])(0, 0)).toBe(true)
  })

  it("two leads crossing away from any pin are refused: a footprint overlap that would read as a crossing of wires (design.md §5.1)", () => {
    const a = part("a", "diode", 0, 0)
    const b = turned("b", "diode", 0, -2, 90)
    const s = scene([a, b])
    expect.soft(contactCheck(s, [b])(0, 0), "no pin on a pin").toBe(false)
    expect.soft(placementCheck(s, [b])(0, 0), "refused").toBe(true)
  })

  it("no stub zone: a pin one cell from another part's pin at a right angle, not touching it, is allowed (design.md §4.1, §5.1; acceptance 2)", () => {
    const a = part("a", "resistor", 0, 0)
    const b = turned("b", "resistor", 4, 1, 90)
    const s = scene([a, b])
    expect.soft(contactCheck(s, [b])(0, 0), "the pins do not touch").toBe(false)
    expect.soft(placementCheck(s, [b])(0, 0), "allowed").toBe(false)
  })
})

describe("parts do not pile onto each other", () => {
  it("two resistors two rows apart fit, and one dropped onto the other does not", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 0, 2)
    const check = placementCheck(scene([a, b]), [b])
    expect(check(0, 0)).toBe(false)
    expect(check(c(1), c(-2))).toBe(true)
  })

  it("a designator or value landing on another part does not block it: text never blocks anything, it is moved, not the part (design.md §5.1; KiCad fields, Altium parameters)", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 0, 1)
    expect(placementCheck(scene([a, b]), [b])(0, 0)).toBe(false)
  })

  it("a pin name landing on another part's value does not block it either (design.md §5.1: no text in the footprint)", () => {
    const q = part("q", "crystal", 0, 0)
    const g = part("g", "oscillator", 0, 2)
    expect.soft(placementCheck(scene([q, g]), [g])(0, 0), "the oscillator's pin names over the crystal's frequency").toBe(false)
    expect.soft(placementCheck(scene([q, g]), [g])(0, c(2)), "and further down").toBe(false)
  })

  it("parts touching pin to pin are allowed", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 4, 0)
    expect(placementCheck(scene([a, b]), [b])(0, 0)).toBe(false)
  })

  it("a module docked onto its header by its pins is allowed", () => {
    const example = examples.find((e) => e.id === "open746-lcd")!
    const doc = example.build(GRID)
    const lcd = doc.objects.find((o) => o.def === "lcd7-f")!
    expect(placementCheck(scene(doc.objects, doc.wires), [lcd])(0, 0)).toBe(false)
  })

  it("a crystal cannot be plugged into a board's header pins, however well its leads line up", () => {
    const doc = examples.find((e) => e.id === "lab1-running-light")!.build(GRID)
    const placed = doc.objects.find((o) => o.def === "open746i-c")!
    const board = objectRect(placed, GRID)
    const pins = objectPins(placed, GRID)
    const pair = pins.flatMap((a) => pins.filter((b) => b.point.y === a.point.y && b.point.x - a.point.x === c(4)).map((b) => [a, b] as const)).filter(([a]) => a.point.y - board.y >= 4 * GRID && board.y + board.h - a.point.y >= 4 * GRID && a.point.x - board.x >= 4 * GRID && board.x + board.w - a.point.x >= 8 * GRID)[0]
    expect(pair, "two header pins four cells apart on a row, well inside the board").toBeDefined()
    const [left] = pair!
    const q = part("q", "crystal", (left.point.x - 0) / GRID, (left.point.y - c(1)) / GRID)
    const s = scene([...doc.objects, q], doc.wires)
    expect.soft(contactCheck(s, [q])(0, 0), "both of its leads sit on header pins").toBe(true)
    expect.soft(placementCheck(s, [q])(0, 0), "…and it is still refused").toBe(true)
  })

  it("a module docks only with every pin over the board in a socket: the 7-inch LCD a row off P15 is refused", () => {
    const doc = examples.find((e) => e.id === "open746-lcd")!.build(GRID)
    const lcd = doc.objects.find((o) => o.def === "lcd7-f")!
    const check = placementCheck(scene(doc.objects, doc.wires), [lcd])
    expect.soft(check(0, 0), "docked").toBe(false)
    expect.soft(check(0, c(1)), "one row down, half its pins on the wrong ones").toBe(true)
    expect.soft(check(c(1), 0), "one pin to the right").toBe(true)
    const board = doc.objects.find((o) => o.def === "open746i-c")!
    expect.soft(placementCheck(scene(doc.objects, doc.wires), [board])(0, 0), "the board can be the one that docks").toBe(false)
  })

  it("a socket part docks only by whole connectors: a Nucleo with two stray pins on the board's pins is refused", () => {
    const board = part("board", "open746i-c", 0, 0)
    const nucleo = part("nucleo", "nucleo-f429zi", 49, -38)
    const s = scene([board, nucleo])
    const over = objectPins(nucleo, GRID).filter(({ point }) => point.y > c(1) && point.y < c(55) && point.x > c(1) && point.x < c(72))
    const boardPins = new Set(objectPins(board, GRID).map(({ point }) => `${point.x},${point.y}`))
    expect.soft(over.length, "two Nucleo pins over the board").toBe(2)
    expect.soft(over.every(({ point }) => boardPins.has(`${point.x},${point.y}`)), "…both on board pins").toBe(true)
    expect.soft(placementCheck(s, [nucleo])(0, 0), "…and the rest of its connector is not, so it is refused").toBe(true)
  })

  it("pins landing on pins are no excuse to stack two parts that are not sockets", () => {
    const a = part("a", "resistor", 0, 0)
    const q = part("q", "crystal", 0, 0)
    expect(placementCheck(scene([a, q]), [q])(0, 0)).toBe(true)
  })

  it("a part may be dropped across a wire that is not its own: a wire is no part's footprint; the checker flags the wire through its body (design.md §5.1, §6.8; KiCad allows it)", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 12, 0)
    const wire: Wire = { id: "w", from: { object: "a", pin: "2" }, to: { object: "b", pin: "1" } }
    const crystal = part("q", "crystal", 6, 4)
    const check = placementCheck(scene([a, b, crystal], [wire]), [crystal])
    expect.soft(check(0, 0), "clear of the wire").toBe(false)
    expect.soft(check(0, c(-4)), "across the wire").toBe(false)
  })

  it("a part's own wires do not stop it", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 12, 0)
    const wire: Wire = { id: "w", from: { object: "a", pin: "2" }, to: { object: "b", pin: "1" } }
    expect(placementCheck(scene([a, b], [wire]), [b])(c(-2), 0)).toBe(false)
  })

  it("a blocked spot gives way to the nearest free one", () => {
    const a = part("a", "resistor", 0, 0)
    const probe = part("new", "resistor", 0, 0)
    const at = freeOffset([placementCheck(scene([a]), [probe])], GRID)!
    expect(at).not.toBeNull()
    expect(placementCheck(scene([a]), [probe])(at.x, at.y)).toBe(false)
    expect(Math.hypot(at.x, at.y)).toBeLessThanOrEqual(c(2))
  })

  it("a part added in the middle of a board too big to search around lands beside the board, not on it", () => {
    const doc = examples.find((e) => e.id === "lab1-running-light")!.build(GRID)
    const s = scene(doc.objects, doc.wires)
    const board = objectRect(doc.objects.find((o) => o.def === "open746i-c")!, GRID)
    const def = getDef("crystal")!
    const centre = { x: board.x + board.w / 2, y: board.y + board.h / 2 }
    const probe = part("new", "crystal", snap(centre.x - (def.width * GRID) / 2, GRID) / GRID, snap(centre.y - (def.height * GRID) / 2, GRID) / GRID)
    const refuse = [placementCheck(s, [probe]), contactCheck(s, [probe])]
    expect.soft(freeOffset(refuse, GRID), "a search of 24 rings finds no room inside the board").toBeNull()
    const at = freeSpot(s, [probe])
    const body = bodyBounds(def)
    const landed = { x: probe.x + at.x + c(body.x), y: probe.y + at.y + c(body.y), w: c(body.w), h: c(body.h) }
    const contour = contourOf(getDef("open746i-c")!).map((r) => ({ x: board.x + c(r.x), y: board.y + c(r.y), w: c(r.w), h: c(r.h) }))
    expect.soft(refuse.some((r) => r(at.x, at.y)), "the spot found is free").toBe(false)
    expect.soft(contour.some((r) => intersects(landed, r)), "…and off the board and its P15 tab").toBe(false)
    expect.soft(Math.hypot(at.x, at.y) / GRID, "…the nearest way out, past the board's near edge").toBeLessThan(board.h / 2 / GRID + def.height + 2)
  })

  it("a paste always finds room, however far it has to go", () => {
    const doc = examples.find((e) => e.id === "open746-lcd")!.build(GRID)
    const s = scene(doc.objects, doc.wires)
    const board = objectRect(doc.objects.find((o) => o.def === "open746i-c")!, GRID)
    const clip = [part("p1", "resistor", 30, 25), part("p2", "led", 30, 28)]
    const at = freeSpot(s, clip)
    expect.soft(placementCheck(s, clip)(at.x, at.y) || contactCheck(s, clip)(at.x, at.y), "the spot is free").toBe(false)
    expect.soft(clip.some((o) => intersects(objectRect({ ...o, x: o.x + at.x, y: o.y + at.y }, GRID), board)), "…and none of the clip is left on the board").toBe(false)
  })

  it("the search is bounded by the document: past its edge every spot is free", () => {
    const a = part("a", "resistor", 0, 0)
    const probe = part("new", "resistor", 0, 0)
    const rings = ringsToClear(scene([a]), [probe])
    expect.soft(rings, "a resistor clears another in a few cells").toBeLessThanOrEqual(4)
    expect.soft(placementCheck(scene([a]), [probe])(0, c(rings)), "…and that many cells down it is clear").toBe(false)
    expect.soft(ringsToClear(scene([]), [probe]), "an empty field needs no search").toBe(0)
  })

  it("the search returns the truly nearest spot, even when it lies past the ring the first find was on", () => {
    const free = new Set([`${c(18)},${c(18)}`, `${c(25)},0`])
    const refuse = [(dx: number, dy: number) => !free.has(`${dx},${dy}`)]
    expect.soft(freeOffset(refuse, GRID), "(25, 0) is nearer than the corner of ring 18").toEqual({ x: c(25), y: 0 })
  })

  it("past ring 24 the sweep's find is refined to the truly nearest spot off its eight directions", () => {
    const free = new Set([`${c(30)},${c(7)}`, `0,${c(40)}`])
    const refuse = [(dx: number, dy: number) => !free.has(`${dx},${dy}`)]
    expect.soft(nearestFreeWithin(refuse, GRID, { x: 0, y: 0 }, () => 50), "(30, 7) at 30.8 cells beats (0, 40) on an axis").toEqual({ x: c(30), y: c(7) })
  })

  it("a drop far from home into a packed sheet sweeps instead of visiting every ring", () => {
    const free = new Set([`${c(150 + 130)},${c(150 + 20)}`])
    const refuse = [(dx: number, dy: number) => !free.has(`${dx},${dy}`)]
    let checks = 0
    const counted = [(dx: number, dy: number) => (checks++, refuse[0](dx, dy))]
    expect.soft(landingOffset(counted, c(150), c(150), GRID), "the one free spot nearer than home is off the eight directions and past the exhaustive rings: home").toEqual({ x: 0, y: 0 })
    expect.soft(checks, "…after a bounded number of checks, not the 85 000 of every ring out to home").toBeLessThan(45_000)
  })

  it("of two equally near landings the one nearer to where the drag started wins", () => {
    const free = new Set([`${c(10)},${c(-2)}`, `${c(10)},${c(2)}`, `${c(8)},0`, `${c(12)},0`])
    const refuse = [(dx: number, dy: number) => !free.has(`${dx},${dy}`)]
    expect.soft(landingOffset(refuse, c(10), 0, GRID), "two cells back towards home beats two cells on").toEqual({ x: c(8), y: 0 })
  })

  it("duplicating a 5 × 5 block of boards lands the copy beside it at once", () => {
    const [doc] = boardDocuments([25])
    const s = scene(doc.objects, doc.wires)
    const copy = doc.objects.map((o) => ({ ...o, id: `paste:${o.id}` }))
    const t0 = performance.now()
    const at = freeSpot(s, copy, { x: GRID, y: GRID })
    const ms = performance.now() - t0
    expect.soft(placementCheck(s, copy)(at.x, at.y) || contactCheck(s, copy)(at.x, at.y), "the copy lands free").toBe(false)
    expect.soft(ms, "…in well under a second (it took 10 s before the far search was bounded)").toBeLessThan(2000)
  })

  it("bounding the search over a 1 700-board selection does not overflow the call stack", () => {
    const [doc] = boardDocuments([1700])
    const anchor = part("anchor", "resistor", -1000, 0)
    expect(() => ringsToClear({ objects: [...doc.objects, anchor], routes: [], grid: GRID }, doc.objects)).not.toThrow()
  })

  it("a junction is a point on a net, not a part, and goes where its wires meet", () => {
    const a = part("a", "resistor", 0, 0)
    const j = part("j", "junction", 3, 0)
    expect(placementCheck(scene([a, j]), [j])(0, 0)).toBe(false)
  })

  const refusals = (s: PlacementScene, moving: PlacedObject[]) => [placementCheck(s, moving), contactCheck(s, moving)]

  it("a part dropped onto another lands on the free spot nearest to where it was let go, touching none of its pins", () => {
    const a = part("a", "resistor", 10, 0)
    const b = part("b", "resistor", 0, 0)
    const refuse = refusals(scene([a, b]), [b])
    const at = landingOffset(refuse, c(10), 0, GRID)
    expect.soft(refuse.some((r) => r(at.x, at.y)), "the spot is free").toBe(false)
    expect.soft(Math.hypot(at.x - c(10), at.y) / GRID, "…two rows off the drop, not five cells back the way it came").toBe(2)
  })

  it("a freed slot in a crowded block takes a part dropped half on its neighbour, instead of sending it home", () => {
    const pitch = { x: 5, y: 4 }
    const block: PlacedObject[] = []
    const crystal = (id: string, x: number, y: number, ref: string) => ({ ...part(id, "crystal", x, y), props: { ref } })
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) if (row !== 1 || col !== 1) block.push(crystal(`q${row}${col}`, col * pitch.x, row * pitch.y, `ZQ${block.length + 1}`))
    const carried = crystal("carried", 40, 20, "ZQ9")
    const s = scene([...block, carried])
    const refuse = refusals(s, [carried])
    const slot = { x: c(pitch.x - 40), y: c(pitch.y - 20) }
    expect.soft(refuse.some((r) => r(slot.x, slot.y)), "the freed slot fits a crystal").toBe(false)
    const dropped = { x: slot.x + c(2), y: slot.y + c(1) }
    expect.soft(refuse.some((r) => r(dropped.x, dropped.y)), "dropped two cells right and one down, it sits on a neighbour").toBe(true)
    const at = landingOffset(refuse, dropped.x, dropped.y, GRID)
    expect.soft(refuse.some((r) => r(at.x, at.y)), "it lands free").toBe(false)
    expect.soft(Math.max(Math.abs(at.x - slot.x), Math.abs(at.y - slot.y)) / GRID, "…in the slot, not 40 cells away at home").toBeLessThanOrEqual(2)
  })

  it("with no free spot nearer than where it started, a part goes home", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 0, 2)
    expect.soft(landingOffset(refusals(scene([a, b]), [b]), 0, c(-1), GRID), "a cell up, onto its neighbour's words").toEqual({ x: 0, y: 0 })
    const doc = examples.find((e) => e.id === "lab1-running-light")!.build(GRID)
    const board = objectRect(doc.objects.find((o) => o.def === "open746i-c")!, GRID)
    const below = part("q", "crystal", 42, (board.y + board.h) / GRID - 4)
    const s = scene([...doc.objects, below], doc.wires)
    const clear = Array.from({ length: 10 }, (_, k) => k).find((k) => !placementCheck(s, [below])(0, c(k)))!
    expect.soft(clear, "a crystal fits just under the board's P15 tab").toBeDefined()
    const q = { ...below, y: below.y + c(clear) }
    const t = scene([...doc.objects, q], doc.wires)
    expect.soft(landingOffset(refusals(t, [q]), 0, c(-5), GRID), "as close under the tab as it fits, dragged five cells up onto it, it comes back").toEqual({ x: 0, y: 0 })
  })

  it("a board takes the room of its outline and the P15 tab, not their bounding box: the pockets either side of the tab are free", () => {
    const board = part("U1", "open746i-c", 0, 0)
    const def = getDef("open746i-c")!
    const [outline, tab] = contourOf(def)
    expect(contourOf(def)).toHaveLength(2)
    expect(tab.y + tab.h, "the tab hangs below the outline").toBeGreaterThan(outline.y + outline.h + 3)
    const pocketY = Math.ceil(outline.y + outline.h + 1)
    const check = (x: number, y: number) => {
      const r = part("r", "resistor", x, y)
      return placementCheck(scene([board, r]), [r])(0, 0)
    }
    expect.soft(check(Math.floor(tab.x) - 7, pocketY), "left of the tab, under 8BIT FMC and ULPI").toBe(false)
    expect.soft(check(Math.ceil(tab.x + tab.w) + 2, pocketY), "right of the tab, under WAKEUP").toBe(false)
    expect.soft(check(Math.round(tab.x + tab.w / 2) - 2, pocketY + 1), "on the tab").toBe(true)
    expect.soft(check(Math.floor(tab.x) - 7, Math.floor(outline.y + outline.h) - 3), "on the board, above the pocket").toBe(true)
    const nucleo = getDef("nucleo-f429zi")!
    expect.soft(contourOf(nucleo), "a board with nothing hanging off it takes its outline").toEqual([bodyBounds(nucleo)])
    expect.soft(contourOf(getDef("stm32f746ig")!), "a chip whose leads stick out of its housing still takes its whole drawing").toEqual([bodyBounds(getDef("stm32f746ig")!)])
  })

  it("a free drop lands where it was dropped", () => {
    const a = part("a", "resistor", 10, 0)
    const b = part("b", "resistor", 0, 0)
    expect(landingOffset([placementCheck(scene([a, b]), [b])], 0, c(3), GRID)).toEqual({ x: 0, y: c(3) })
  })

  it("a landing is always home or a free spot nearer to the drop than home, on every example", () => {
    let seed = 20261001
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const wrong: string[] = []
    let moved = 0
    for (const example of examples) {
      const doc = example.build(GRID)
      const s = scene(doc.objects, doc.wires)
      for (const o of doc.objects.slice(0, 6)) {
        const refuse = refusals(s, [o])
        for (let i = 0; i < 4; i++) {
          const dx = c(Math.round((random() - 0.5) * 60))
          const dy = c(Math.round((random() - 0.5) * 60))
          const at = landingOffset(refuse, dx, dy, GRID)
          const home = at.x === 0 && at.y === 0
          if (!home) moved++
          const nearer = Math.hypot(at.x - dx, at.y - dy) < Math.hypot(dx, dy) || (at.x === dx && at.y === dy)
          if (!home && (refuse.some((r) => r(at.x, at.y)) || !nearer)) wrong.push(`${example.id}: ${o.props?.ref ?? o.def} by (${dx / GRID}, ${dy / GRID}) → (${at.x / GRID}, ${at.y / GRID})`)
        }
      }
    }
    expect.soft(wrong).toEqual([])
    expect.soft(moved, "…and most drops did move something").toBeGreaterThan(50)
  })

  it("no shipped example already breaks the rule", () => {
    const offenders: string[] = []
    for (const example of examples) {
      const doc = example.build(GRID)
      const s = scene(doc.objects, doc.wires)
      for (const o of doc.objects) if (placementCheck(s, [o])(0, 0)) offenders.push(`${example.id}: ${o.props?.ref ?? o.def}`)
    }
    expect(offenders).toEqual([])
  })
})

describe("wires keep off the words", () => {
  it("the wire the rubber band lays from a pin runs clear of another part's label and body when a clear place exists (phase 4, design.md §6.3, §5.1: text never blocks a part, so the wire goes round it)", () => {
    const named = (id: string, x: number, y: number): PlacedObject => ({ ...part(id, "resistor", x, y), props: { ref: id, value: "1 kΩ" } })
    const r9 = named("R9", 3, 2)
    const doc = inNormalForm({ objects: [named("R1", 0, 0), named("R2", 10, 0), r9], wires: [{ id: "w", a: { x: c(4), y: c(1) }, b: { x: c(10), y: c(1) } }], parts: {} })
    const landed = new PartDrag(doc, wiringOf(new WireGraph(), doc), { objects: new Set(["R2"]) }).landed(0, c(3))
    const obstacles = [objectRect(r9, GRID), ...designatorRects(r9, GRID)]
    const crossing = landed.doc.wires.filter((s) => obstacles.some((r) => Math.max(s.a.x, s.b.x) > r.x && Math.min(s.a.x, s.b.x) < r.x + r.w && Math.max(s.a.y, s.b.y) > r.y && Math.min(s.a.y, s.b.y) < r.y + r.h))
    expect.soft(landed.at, "R2 dropped where it was let go").toEqual({ x: 0, y: c(3) })
    expect.soft(crossing.map((s) => [s.a.x / GRID, s.a.y / GRID, s.b.x / GRID, s.b.y / GRID]), "no piece of the wire through R9 or its label").toEqual([])
    expect.soft(landed.doc.wires.every((s) => s.a.x === s.b.x || s.a.y === s.b.y), "and every piece orthogonal").toBe(true)
  })

  it("a wire from a crystal to an oscillator below it goes round the crystal's frequency", () => {
    const q = part("q", "crystal", 0, 0)
    const g = part("g", "oscillator", 0, 4)
    const wire: Wire = { id: "w", from: { object: "q", pin: "1" }, to: { object: "g", pin: "VCC" } }
    const [route] = new Router(designatorRects).routeAll([q, g], [wire], GRID)
    const labels = designatorRects(q, GRID)
    const enters = (r: { x: number; y: number; w: number; h: number }) =>
      route.pts.some((p, i) => i > 0 && Math.min(p.y, route.pts[i - 1].y) < r.y + r.h && Math.max(p.y, route.pts[i - 1].y) > r.y && Math.min(p.x, route.pts[i - 1].x) < r.x + r.w && Math.max(p.x, route.pts[i - 1].x) > r.x)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.some(enters)).toBe(false)
  })
})

