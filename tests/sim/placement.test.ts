import { describe, expect, it } from "vitest"
import { examples } from "@/schematic/examples"
import { GRID, intersects, objectPins, objectRect, routeAll, Router, snap } from "@/schematic/geometry"
import { bodyBounds, contactCheck, designatorRects, freeOffset, freeSpot, landingOffset, nearestFreeWithin, placementCheck, ringsToClear, type PlacementScene } from "@/schematic/placement"
import { getDef } from "@/schematic/registry"
import type { PlacedObject, Wire } from "@/schematic/types"
import { boardDocuments } from "../../scripts/lib/stress"

const c = (v: number) => v * GRID
const part = (id: string, def: string, x: number, y: number): PlacedObject => ({ id, def, x: c(x), y: c(y) })

function scene(objects: PlacedObject[], wires: Wire[] = []): PlacementScene {
  return { objects, wires, routes: routeAll(objects, wires, GRID), grid: GRID }
}

describe("a part takes the room it draws, not its whole box", () => {
  it("a resistor is as tall as its body, not its two-cell box", () => {
    const b = bodyBounds(getDef("resistor")!)
    expect(b.w).toBeCloseTo(4)
    expect(b.h).toBeCloseTo(0.8)
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

  it("a designator or value landing on another part counts as piling on", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 0, 1)
    expect(placementCheck(scene([a, b]), [b])(0, 0)).toBe(true)
  })

  it("a pin name landing on another part's value counts too", () => {
    const q = part("q", "crystal", 0, 0)
    const g = part("g", "oscillator", 0, 2)
    expect(placementCheck(scene([q, g]), [g])(0, 0)).toBe(true)
    expect(placementCheck(scene([q, g]), [g])(0, c(2))).toBe(false)
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
    const nucleo = part("nucleo", "nucleo-f429zi", 4, 43)
    const s = scene([board, nucleo])
    const over = objectPins(nucleo, GRID).filter(({ point }) => point.y > c(1) && point.y < c(55) && point.x > c(1) && point.x < c(75))
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

  it("a part cannot land on a wire that is not its own", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 12, 0)
    const wire: Wire = { id: "w", from: { object: "a", pin: "2" }, to: { object: "b", pin: "1" } }
    const crystal = part("q", "crystal", 6, 4)
    const check = placementCheck(scene([a, b, crystal], [wire]), [crystal])
    expect(check(0, 0)).toBe(false)
    expect(check(0, c(-4))).toBe(true)
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
    const landed = objectRect({ ...probe, x: probe.x + at.x, y: probe.y + at.y }, GRID)
    expect.soft(refuse.some((r) => r(at.x, at.y)), "the spot found is free").toBe(false)
    expect.soft(intersects(landed, board), "…and off the board").toBe(false)
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

  it("bounding the search over a 1 700-board selection does not overflow the call stack", () => {
    const [doc] = boardDocuments([1700])
    const anchor = part("anchor", "resistor", -1000, 0)
    expect(() => ringsToClear({ objects: [...doc.objects, anchor], wires: [], routes: [], grid: GRID }, doc.objects)).not.toThrow()
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
    const below = part("q", "crystal", 30, (board.y + board.h) / GRID)
    const s = scene([...doc.objects, below], doc.wires)
    const clear = Array.from({ length: 6 }, (_, k) => k).find((k) => !placementCheck(s, [below])(0, c(k)))!
    expect.soft(clear, "a crystal fits just under the board").toBeDefined()
    const q = { ...below, y: below.y + c(clear) }
    const t = scene([...doc.objects, q], doc.wires)
    expect.soft(landingOffset(refusals(t, [q]), 0, c(-5), GRID), "as close under the board as it fits, dragged five cells up onto it, it comes back").toEqual({ x: 0, y: 0 })
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
  it("a part cannot stand where the wire leaving one of its pins would run through someone's label", () => {
    const q = part("q", "crystal", 0, 0)
    const g = part("g", "oscillator", 0, 4)
    const wire: Wire = { id: "w", from: { object: "q", pin: "1" }, to: { object: "g", pin: "VCC" } }
    const check = placementCheck(scene([q, g], [wire]), [g])
    expect(check(0, 0)).toBe(false)
    expect(check(0, c(-1))).toBe(true)
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

