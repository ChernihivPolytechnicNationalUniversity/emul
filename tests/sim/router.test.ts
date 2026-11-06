import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as geometry from "@/schematic/geometry"
import { GRID, objectPins, objectSize, type Point } from "@/schematic/geometry"
import { runsOf } from "@/schematic/circuit"
import { upgraded, type SavedSchematic } from "@/schematic/migrate"
import { wirePins, wiresAsSegments } from "@/schematic/migrate-wires"
import { placementCheck } from "@/schematic/placement"
import { allDefs, getDef } from "@/schematic/registry"
import type { LegacySchematic, PinDef, PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { drawEndAt, drawnTo, isRefusal, pointerAt, previewOf, startDrawing, type Drawing } from "@/schematic/wire-draw"
import { inNormalForm, removed, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { danglingEnds, junctionsOf, pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import { isRerouteRefusal, REROUTE_REFUSED, rerouted, routeBetween, type RouteEnd } from "@/schematic/wires/router"
import type { WireSegment } from "@/schematic/wires/segment"
import { bestShape, cells, shapeOf } from "../lib/route-reference"
import { geometryOf, normalFormViolations, random } from "../lib/wire-reference"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const resistor = (id: string, x: number, y: number, rotation?: Rotation): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
const led = (id: string, x: number, y: number, rotation?: Rotation): PlacedObject => ({ id, def: "led", x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
const board = (def: string, x = 0, y = 0): PlacedObject => ({ id: "U1", def, x: c(x), y: c(y), props: { ref: "U1" } })
const pin = (object: string, id: string): RouteEnd => ({ pin: { object, pin: id } })
let serial = 0
const seg = (a: Point, b: Point): WireSegment => ({ id: `s${++serial}`, a, b })
const path = (...pts: Point[]) => pts.slice(1).map((p, i) => seg(pts[i], p))
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic): Wiring => wiringOf(new WireGraph(), doc)
const viewOf = (doc: Schematic) => wireNets(doc.wires, wirePins(doc.objects))
const partition = (doc: Schematic) => pinPartition(viewOf(doc))
const pointOf = (o: PlacedObject, id: string) => objectPins(o, GRID).find((p) => p.pin.id === id)!.point
let fresh = 0
const newId = () => `r${++fresh}`
const QUARTERS: readonly Rotation[] = [0, 90, 180, 270]

function laid(doc: Schematic, route: readonly Point[] | null): Schematic {
  if (!route) throw new Error("no route to lay")
  return inNormalForm({ ...doc, wires: [...doc.wires, ...path(...route)] })
}

function drawn(doc: Schematic, from: Point, target: Point): Schematic {
  const wiring = wiringFor(doc)
  const started = startDrawing(wiring, drawEndAt(wiring, from))
  if (isRefusal(started)) throw new Error(`the drawing could not start: ${started.refused}`)
  const d: Drawing = pointerAt(started, target)
  const result = drawnTo(doc, wiring, d, drawEndAt(wiring, target), newId)
  if (isRefusal(result)) throw new Error(`refused: ${result.refused} at (${result.at.x / GRID}, ${result.at.y / GRID})`)
  return result
}

const shuffled = <T>(list: readonly T[], seed: number): T[] => {
  const rnd = random(seed)
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = rnd.int(0, i)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function pairAt(ra: Rotation, rb: Rotation, dx: number, dy: number): { doc: Schematic; a: Point; b: Point } | null {
  const r1 = resistor("R1", 0, 0, ra)
  const a = pointOf(r1, "2")
  const probe = resistor("R2", 0, 0, rb)
  const p1 = pointOf(probe, "1")
  const r2 = { ...probe, x: a.x + c(dx) - p1.x, y: a.y + c(dy) - p1.y }
  if (placementCheck({ objects: [r1], routes: [], grid: GRID }, [r2])(0, 0)) return null
  return { doc: docOf([r1, r2]), a, b: pointOf(r2, "1") }
}

function cornersOf(points: readonly Point[]): number {
  let n = 0
  for (let i = 1; i + 1 < points.length; i++) {
    const [p, q, r] = [points[i - 1], points[i], points[i + 1]]
    if ((p.x === q.x) !== (q.x === r.x)) n++
  }
  return n
}

const insideTheBoxOf = (points: readonly Point[], a: Point, b: Point) =>
  points.every((p) => p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y))

describe("the trivial wire: no stub zone (plan.md acceptance 2; design.md §4.1, §7; problems.md §2)", () => {
  it("two pins one cell apart on one level are joined by one segment of one cell (acceptance 2; design.md §4.1: «two pins one cell apart are joined by the one-segment … wire»)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 5, 0)])
    expect.soft(cells(routeBetween(doc, pin("R1", "2"), pin("R2", "1"))), "R1's right pin straight to R2's left pin").toEqual([
      [4, 1],
      [5, 1],
    ])
  })

  it("two pins one cell apart at right angles and offset are joined by one corner, inside the box of the two pins (acceptance 2; design.md §4.1: «… or one-corner wire»)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 4, 2, 90)])
    const route = routeBetween(doc, pin("R1", "2"), pin("R2", "1"))
    expect.soft(route?.length, `one corner: ${JSON.stringify(cells(route))}`).toBe(3)
    expect.soft(route && insideTheBoxOf(route, at(4, 1), at(5, 2)), "nothing past either pin").toBe(true)
    expect.soft(route && shapeOf(doc, route).faults, "clean").toEqual([])
  })

  it("two pins on one point need no wire: the route is that point alone (design.md §10 item 2: «a wire whose two pins coincide routes to a single point and becomes no segment»)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 4, 0)])
    expect.soft(cells(routeBetween(doc, pin("R1", "2"), pin("R2", "1"))), "the shared point").toEqual([[4, 1]])
  })

  it("the pairs of before/close-parts-hooks.png, routed on the bare parts: no hook, no loop, at most one corner, nothing past a pin (problems.md §2; acceptance 2)", () => {
    const doc = closePartsHooks()
    const want: [string, string, number[][] | "one corner"][] = [
      ["R1:2", "R2:1", "one corner"],
      ["R3:2", "LED1:1", [[4, 7], [5, 7]]],
      ["R4:2", "R5:2", [[13, 4], [15, 4]]],
      ["R4:1", "R5:1", [[13, 0], [15, 0]]],
      ["R6:2", "R7:1", [[16, 8], [17, 8], [17, 10]]],
    ]
    const bare = { ...doc, wires: [] }
    for (const [from, to, shape] of want) {
      const [fo, fp] = from.split(":")
      const [tobj, tp] = to.split(":")
      const route = routeBetween(bare, pin(fo, fp), pin(tobj, tp))
      if (shape === "one corner") {
        expect.soft(route?.length, `${from} → ${to}: one corner, ${JSON.stringify(cells(route))}`).toBe(3)
        expect.soft(route && insideTheBoxOf(route, route[0], route[route.length - 1]), `${from} → ${to}: nothing past either pin`).toBe(true)
      } else expect.soft(cells(route), `${from} → ${to}`).toEqual(shape)
    }
  })
})

describe("pins on one level are joined by the straight segment between them, turning at each pin (design.md §7, §13.4; ГОСТ 2.701-84 §2.5.2: the fewest bends)", () => {
  it("facing each other: one segment", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 8, 0)])
    expect.soft(cells(routeBetween(doc, pin("R1", "2"), pin("R2", "1"))), "R1 → R2").toEqual([
      [4, 1],
      [8, 1],
    ])
  })

  it("both facing up, side by side: one segment from pin to pin, not a climb above them (problems.md §2, R4 ∥ R5)", () => {
    const doc = docOf([resistor("R4", 12, 0, 90), resistor("R5", 14, 0, 90)])
    expect.soft(cells(routeBetween(doc, pin("R4", "1"), pin("R5", "1"))), "the tops").toEqual([
      [13, 0],
      [15, 0],
    ])
    expect.soft(cells(routeBetween(doc, pin("R4", "2"), pin("R5", "2"))), "the bottoms").toEqual([
      [13, 4],
      [15, 4],
    ])
  })

  it("one facing across, the other up, on one row: one segment (problems.md §2, R3 → LED1)", () => {
    const doc = docOf([resistor("R3", 0, 6), led("LED1", 4, 7, 90)])
    expect.soft(cells(routeBetween(doc, pin("R3", "2"), pin("LED1", "1"))), "R3 → LED1's anode").toEqual([
      [4, 7],
      [5, 7],
    ])
  })

  it("on one column, facing each other or both facing sideways: one upright segment", () => {
    const stacked = docOf([resistor("R1", 0, 0, 90), resistor("R2", 0, 8, 90)])
    expect.soft(cells(routeBetween(stacked, pin("R1", "2"), pin("R2", "1"))), "R1's bottom to R2's top").toEqual([
      [1, 4],
      [1, 8],
    ])
    const sideways = docOf([resistor("R1", 0, 0), resistor("R2", 0, 4)])
    expect.soft(cells(routeBetween(sideways, pin("R1", "1"), pin("R2", "1"))), "two left pins one above the other: straight down between them, turning at each").toEqual([
      [0, 1],
      [0, 5],
    ])
  })
})

describe("no detour the user did not draw (design.md §7: «tests/sim/router.test.ts holds it on every pair of pin orientations at distances 0–3 cells»; §13.4)", () => {
  it("every pair of pin orientations, the second pin 0–3 cells either way: never into its own part, never past a pin and back, never a lap when fewer bends will do, the fewest bends then the shortest, every vertex on a whole cell", () => {
    const misses: string[] = []
    let scenes = 0
    for (const ra of QUARTERS)
      for (const rb of QUARTERS)
        for (let dx = -3; dx <= 3; dx++)
          for (let dy = -3; dy <= 3; dy++) {
            const scene = pairAt(ra, rb, dx, dy)
            if (!scene) continue
            scenes++
            const name = `R1 at ${ra}°, R2 at ${rb}°, R2's pin ${dx}, ${dy} from R1's`
            const route = routeBetween(scene.doc, pin("R1", "2"), pin("R2", "1"))
            if (!route) {
              misses.push(`${name}: no route`)
              continue
            }
            const want = bestShape(scene.doc, scene.a, scene.b)!
            const got = shapeOf(scene.doc, route)
            const show = JSON.stringify(cells(route))
            if (route[0].x !== scene.a.x || route[0].y !== scene.a.y || route.at(-1)!.x !== scene.b.x || route.at(-1)!.y !== scene.b.y) misses.push(`${name}: does not run from pin to pin: ${show}`)
            if (got.faults.length) misses.push(`${name}: ${got.faults.join("; ")}: ${show}`)
            else if (got.bends !== want.bends) misses.push(`${name}: ${got.bends} bends where ${want.bends} will do: ${show}`)
            else if (got.length !== want.length) misses.push(`${name}: ${got.length} cells where ${want.length} will do with as few bends: ${show}`)
          }
    expect.soft(scenes, "the placements the field allows (placementCheck): 624 of the 784").toBe(624)
    expect.soft(misses, "every route clean and as plain as the lattice allows").toEqual([])
  })
})

describe("the cost order (design.md §7: «crossing a body …, leaving or entering a pin against its outward direction, running along another net's segment (forbidden), crossing another net's segment, each bend, length»)", () => {
  it("no foreign body is crossed when a free path exists: two pins on one level with a part standing across the row go round it (design.md §5.1 row «wire across a body»; ГОСТ 2.701 via research/standards.md: lines do not pass through symbols)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 12, 0), resistor("R9", 7, -1, 90)])
    const route = routeBetween(doc, pin("R1", "2"), pin("R2", "1"))
    expect.soft(route && shapeOf(doc, route).faults, `nothing through R9's body, leads or pins: ${JSON.stringify(cells(route))}`).toEqual([])
    expect.soft(route && shapeOf(doc, route).bends, "two bends, above or below R9").toBe(2)
    expect.soft(route && shapeOf(doc, route).length, "and no longer than it must be").toBe(14)
  })

  it("never along another net (N3: it would connect): the straight row is taken by a dangling wire of its own, so the route steps off it (junctions.md principle 3)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 12, 0)], [seg(at(6, 1), at(10, 1))])
    const route = routeBetween(doc, pin("R1", "2"), pin("R2", "1"))
    expect.soft(route && shapeOf(doc, route).faults, `no point on the other wire: ${JSON.stringify(cells(route))}`).toEqual([])
    expect.soft(route && shapeOf(doc, route).bends, "two bends, one row off").toBe(2)
    expect.soft(route && partition(laid(doc, route)), "laid, it joins only R1 and R2").toEqual([["R1:2", "R2:1"]])
  })

  it("of two routes with as many bends, the one that crosses no other net's wire (design.md §7: crossing weighs more than a bend; research/algorithms.md §4: crossings first)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R3", 9, 5, 90)], [seg(at(7, -1), at(7, 3))])
    expect.soft(cells(routeBetween(doc, pin("R1", "2"), pin("R3", "1"))), "down from R1's pin, then across to R3's top: the L that does not cross the wire at x = 7").toEqual([
      [4, 1],
      [4, 5],
      [10, 5],
    ])
  })

  it("fewer bends before a shorter route: two bends and 18 cells, not three bends and 16 (design.md §7: «each bend, length»; «never takes a lap round a part when a route with fewer bends exists»)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 6, 180), resistor("R3", 3, 3), resistor("R4", 11, 1, 90)])
    const route = routeBetween(doc, pin("R1", "2"), pin("R2", "1"))
    const got = route && shapeOf(doc, route)
    expect.soft(got?.faults, `clean: ${JSON.stringify(cells(route))}`).toEqual([])
    expect.soft(got && [got.bends, got.length], "two bends, 18 cells").toEqual([2, 18])
  })
})

describe("deterministic (design.md §7; plan.md phase 6 tests)", () => {
  it("the same document routes the same way every time, whatever order its objects and wires are listed in", () => {
    const scenes: [string, Schematic, RouteEnd, RouteEnd][] = [
      ["round R3 and R4", docOf([resistor("R1", 0, 0), resistor("R2", 10, 6, 180), resistor("R3", 3, 3), resistor("R4", 11, 1, 90)]), pin("R1", "2"), pin("R2", "1")],
      ["the two Ls of R1 → R2", docOf([resistor("R1", 0, 0), resistor("R2", 5, 1)]), pin("R1", "2"), pin("R2", "1")],
      ["D45 on the slip", nucleoScene(true), pin("U1", "CN8-6"), pin("R4", "2")],
    ]
    for (const [name, doc, from, to] of scenes) {
      const first = cells(routeBetween(doc, from, to))
      expect.soft(cells(routeBetween(doc, from, to)), `${name}: again`).toEqual(first)
      for (const seed of [1, 2, 3]) {
        const reordered = { ...doc, objects: shuffled(doc.objects, seed), wires: shuffled(doc.wires, seed + 10) }
        expect.soft(cells(routeBetween(reordered, from, to)), `${name}: objects and wires shuffled (seed ${seed})`).toEqual(first)
      }
    }
  })
})

const nucleoScene = (resetWired: boolean, d45: WireSegment[] = []): Schematic =>
  docOf([board("nucleo-f429zi"), resistor("R1", -6, 18), resistor("R4", -12, 19)], [...(resetWired ? path(at(5, 19), at(-2, 19)) : []), ...d45])

const STRAIGHT_D45 = () => path(at(6, 19), at(3, 19), at(3, 20), at(-8, 20))
const SLIPPED_D45 = () => path(at(6, 19), at(6, 19.5), at(3, 19.5), at(3, 20), at(-8, 20))

describe("board sockets: the jumper rule and the half-cell slip on the Nucleo's CN8 (design.md §4.5, §13.5, §13.9; junctions.md 33–35; boards/socket-order.json, scripts/socket-order-shots.mts)", () => {
  it("guard: the approved pictures are clean — D45's straight wire passes the free RESET socket and joins nothing; on the slip beside RESET's wire the two nets stay two; laid literally they would join (design.md §13.9)", () => {
    expect.soft(partition(nucleoScene(false, STRAIGHT_D45())), "D45 straight over RESET: one net of two pins").toEqual([["R4:2", "U1:CN8-6"]])
    const slipped = nucleoScene(true, SLIPPED_D45())
    expect.soft(partition(slipped), "the slip: two nets").toEqual([
      ["R1:2", "U1:CN8-5"],
      ["R4:2", "U1:CN8-6"],
    ])
    expect.soft(normalFormViolations(slipped.wires, wirePins(slipped.objects)), "in normal form").toEqual([])
    expect.soft(partition(nucleoScene(true, STRAIGHT_D45())), "both straight: RESET's end lands on D45's wire and joins it — the short §13.9 prevents").toEqual([["R1:2", "R4:2", "U1:CN8-5", "U1:CN8-6"]])
  })

  it("junctions.md 33: an inner-row wire leaves straight out on its row over the free outer socket, which it does not join (design.md §4.5, the jumper rule)", () => {
    const doc = docOf([board("nucleo-f429zi"), resistor("R4", -12, 18)])
    const route = routeBetween(doc, pin("U1", "CN8-6"), pin("R4", "2"))
    expect.soft(cells(route), "D45 straight along row 19 to R4, past RESET's socket").toEqual([
      [6, 19],
      [-8, 19],
    ])
    expect.soft(route && partition(laid(doc, route)), "RESET stays out of it").toEqual([["R4:2", "U1:CN8-6"]])
  })

  it("junctions.md 33, the approved picture (socket-order-shots.mts, order-1-d45-first): with R1 on row 19, D45 runs over RESET's socket and turns onto R4's row right after the pin names", () => {
    expect.soft(cells(routeBetween(nucleoScene(false), pin("U1", "CN8-6"), pin("R4", "2"))), "(6, 19) → (3, 19) → (3, 20) → (−8, 20)").toEqual(cells(pointsOf(STRAIGHT_D45())))
  })

  it("junctions.md 34: RESET wired, D45 takes the half-cell slip — straight out between RESET and +3V3 half a cell off the grid, back on a whole row right after the pin names (design.md §13.5, mockups/row-taken-options.png B, boards/row-taken-half.png)", () => {
    const doc = nucleoScene(true)
    const route = routeBetween(doc, pin("U1", "CN8-6"), pin("R4", "2"))
    expect.soft(cells(route), "(6, 19) → (6, 19.5) → (3, 19.5) → (3, 20) → (−8, 20)").toEqual(cells(pointsOf(SLIPPED_D45())))
    expect.soft(route && partition(laid(doc, route)), "two nets").toEqual([
      ["R1:2", "U1:CN8-5"],
      ["R4:2", "U1:CN8-6"],
    ])
  })

  it("junctions.md 34 while drawing: from D45 to R4 with RESET wired, the completion is the slip and the click lays it (design.md §6.1)", () => {
    const after = drawn(nucleoScene(true), at(6, 19), at(-8, 20))
    expect.soft(geometryOf(after.wires), "RESET's wire and D45's on the slip").toEqual(geometryOf([...path(at(5, 19), at(-2, 19)), ...SLIPPED_D45()]))
  })

  it("junctions.md 35: RESET wired after D45's straight wire — D45's wire moves onto the slip in that same edit; RESET's wire runs straight out along its row; two nets (design.md §13.9, «первый вариант идеальный с автоматизацией»)", () => {
    const before = nucleoScene(false, STRAIGHT_D45())
    const wiring = wiringFor(before)
    const started = startDrawing(wiring, drawEndAt(wiring, at(-2, 19)))
    if (isRefusal(started)) throw new Error(started.refused)
    const target = drawEndAt(wiring, at(5, 19))
    expect.soft(target.kind, "RESET's socket is the target").toBe("pin")
    expect.soft(previewOf(before, wiring, pointerAt(started, at(5, 19)), target).refused, "the preview is not refused any more (wire-edit.test.ts «a wire is not ended on an outer socket …» is superseded)").toBeNull()
    const after = drawnTo(before, wiring, pointerAt(started, at(5, 19)), target, newId)
    if (isRefusal(after)) throw new Error(`refused: ${after.refused}`)
    expect.soft(geometryOf(after.wires), "one document — one edit, one undo step — with both: RESET straight, D45 slipped").toEqual(geometryOf([...path(at(5, 19), at(-2, 19)), ...SLIPPED_D45()]))
    expect.soft(partition(after), "two nets, no short").toEqual([
      ["R1:2", "U1:CN8-5"],
      ["R4:2", "U1:CN8-6"],
    ])
    expect.soft(normalFormViolations(after.wires, wirePins(after.objects)), "normal form").toEqual([])
  })

  it("the picture is the same whichever was drawn first (design.md §4.5, §13.9)", () => {
    const resetFirst = drawn(drawn(nucleoScene(false), at(-2, 19), at(5, 19)), at(6, 19), at(-8, 20))
    const d45First = drawn(drawn(nucleoScene(false), at(6, 19), at(-8, 20)), at(-2, 19), at(5, 19))
    expect.soft(geometryOf(d45First.wires), "D45 then RESET equals RESET then D45").toEqual(geometryOf(resetFirst.wires))
  })
})

const pointsOf = (segments: readonly WireSegment[]) => [segments[0].a, ...segments.map((s) => s.b)]

const OUT: Record<string, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } }

type Inner = { def: string; pin: PinDef; outer: PinDef; d: Point; passed: number; between: boolean }

function innerRowPins(): Inner[] {
  const out: Inner[] = []
  for (const def of allDefs()) {
    if (!def.pinsAreSockets) continue
    const byPoint = new Map(def.pins.map((p) => [`${p.x},${p.y}`, p]))
    const size = objectSize(def)
    for (const p of def.pins) {
      const d = OUT[p.side]
      const outer = d && byPoint.get(`${p.x + d.x},${p.y + d.y}`)
      if (!outer) continue
      let passed = 0
      for (let k = 1; k < 200; k++) {
        const x = p.x + d.x * k
        const y = p.y + d.y * k
        if (x < -3 || y < -3 || x > size.w + 3 || y > size.h + 3) break
        if (byPoint.has(`${x},${y}`)) passed++
      }
      const across = { x: Math.abs(d.y), y: Math.abs(d.x) }
      const between = [1, -1].every((s) => byPoint.has(`${p.x + across.x * s},${p.y + across.y * s}`) && byPoint.has(`${outer.x + across.x * s},${outer.y + across.y * s}`))
      out.push({ def: def.id, pin: p, outer, d, passed, between })
    }
  }
  return out
}

function beyond(def: string, from: PinDef | Point, d: Point, cellsOut: number): Point {
  const size = objectSize(getDef(def)!)
  if (d.x < 0) return { x: -cellsOut, y: from.y }
  if (d.x > 0) return { x: size.w + cellsOut, y: from.y }
  if (d.y < 0) return { x: from.x, y: -cellsOut }
  return { x: from.x, y: size.h + cellsOut }
}

function facing(id: string, q: Point, d: Point): { part: PlacedObject; pin: string } {
  if (d.x < 0) return { part: resistor(id, q.x - 4, q.y - 1), pin: "2" }
  if (d.x > 0) return { part: resistor(id, q.x, q.y - 1), pin: "1" }
  if (d.y < 0) return { part: resistor(id, q.x - 1, q.y - 4, 90), pin: "2" }
  return { part: resistor(id, q.x - 1, q.y, 90), pin: "1" }
}

describe("every inner header row on the five boards (design.md §4.5: «322 pins on 5 definitions»)", () => {
  it("guard: the census — 166 on the Open746I-C, 50 on the Nucleo, 50 on the Discovery, 36 on the H405, 20 on the 7\" LCD", () => {
    const count = new Map<string, number>()
    for (const p of innerRowPins()) count.set(p.def, (count.get(p.def) ?? 0) + 1)
    expect.soft(Object.fromEntries(count), "inner-row pins per board").toEqual({ "open746i-c": 166, "nucleo-f429zi": 50, "stm32f4-discovery": 50, "olimex-stm32-h405": 36, "lcd7-f": 20 })
  })

  it("each leaves straight out over the free sockets in front of it to a part three cells past the board, joining none of them (junctions.md 33; design.md §4.5)", () => {
    const misses: string[] = []
    for (const p of innerRowPins()) {
      const q = beyond(p.def, p.pin, p.d, 3)
      const { part, pin: end } = facing("T", q, p.d)
      const doc = docOf([board(p.def), part])
      const route = routeBetween(doc, pin("U1", p.pin.id), pin("T", end))
      const want = [
        [p.pin.x, p.pin.y],
        [q.x, q.y],
      ]
      if (JSON.stringify(cells(route)) !== JSON.stringify(want)) misses.push(`${p.def} ${p.pin.id}: ${JSON.stringify(cells(route))}, not ${JSON.stringify(want)}`)
      else if (JSON.stringify(partition(laid(doc, route))) !== JSON.stringify([[`T:${end}`, `U1:${p.pin.id}`].sort()])) misses.push(`${p.def} ${p.pin.id}: joins a socket it passes`)
    }
    expect.soft(misses, "322 straight wires").toEqual([])
  })

  it("with the outer socket in front wired, each inner pin between two rows slips half a cell towards its target, passes between the two outer pins and steps back onto the next whole row (design.md §13.5: «the half-cell slip, and only it»)", () => {
    const misses: string[] = []
    let checked = 0
    for (const p of innerRowPins()) {
      if (p.def === "lcd7-f" || p.passed !== 1 || !p.between) continue
      checked++
      const across = { x: Math.abs(p.d.y), y: Math.abs(p.d.x) }
      const qo = beyond(p.def, p.outer, p.d, 3)
      const outerEnd = facing("O", qo, p.d)
      const next = { x: p.pin.x + across.x, y: p.pin.y + across.y }
      const qi = beyond(p.def, next, p.d, 8)
      const innerEnd = facing("T", qi, p.d)
      const doc = docOf([board(p.def), outerEnd.part, innerEnd.part], path(at(p.outer.x, p.outer.y), at(qo.x, qo.y)))
      const route = routeBetween(doc, pin("U1", p.pin.id), pin("T", innerEnd.pin))
      const got = cells(route)
      const name = `${p.def} ${p.pin.id}: ${JSON.stringify(got)}`
      if (!got || got.length !== 5) {
        misses.push(`${name}: not pin, slip, run, step back, target`)
        continue
      }
      const [p0, p1, p2, p3, p4] = got
      const outward = (pt: readonly [number, number]) => (pt[0] - p.pin.x) * p.d.x + (pt[1] - p.pin.y) * p.d.y
      const sideways = (pt: readonly [number, number]) => (pt[0] - p.pin.x) * across.x + (pt[1] - p.pin.y) * across.y
      const ok =
        p0[0] === p.pin.x && p0[1] === p.pin.y && outward(p1) === 0 && sideways(p1) === 0.5 && sideways(p2) === 0.5 && outward(p2) > 1 && outward(p3) === outward(p2) && sideways(p3) === 1 && p4[0] === qi.x && p4[1] === qi.y
      if (!ok) misses.push(`${name}: not the slip`)
      else if (JSON.stringify(partition(laid(doc, route))) !== JSON.stringify([[`O:${outerEnd.pin}`, `U1:${p.outer.id}`].sort(), [`T:${innerEnd.pin}`, `U1:${p.pin.id}`].sort()].sort())) misses.push(`${name}: the two nets do not stay two`)
    }
    expect.soft(checked, "inner pins with an inner and an outer neighbour either side and one socket in front: Open746I-C 86, Nucleo 42, Discovery 46, H405 30").toBe(204)
    expect.soft(misses, "every one on the slip").toEqual([])
  })
})

describe("the board's escape direction is a cost, not a reserved length (design.md §4.1: «a preferred escape direction, priced, not a mandatory run»)", () => {
  it("of two routes with one bend and the same length, D45 takes the one that leaves along its escape direction, not down its header over five sockets", () => {
    const doc = docOf([board("nucleo-f429zi", 10, 0), resistor("T", 7, 25, 90)])
    expect.soft(cells(routeBetween(doc, pin("U1", "CN8-6"), pin("T", "1"))), "out along row 19, down to T's top pin").toEqual([
      [16, 19],
      [8, 19],
      [8, 25],
    ])
  })

  it("no reserved length: D45 to a resistor just past the board's edge, a row lower, turns at the resistor's column — not out to the end of the old six-cell stub and back (problems.md §2; design.md §4.1)", () => {
    const doc = docOf([board("nucleo-f429zi", 10, 0), resistor("T", 5, 19)])
    expect.soft(cells(routeBetween(doc, pin("U1", "CN8-6"), pin("T", "2"))), "one corner at x = 9").toEqual([
      [16, 19],
      [9, 19],
      [9, 20],
    ])
  })
})

describe("the completion while drawing is the router's route (design.md §6.1: «the router (§7) proposes its path as the preview»)", () => {
  it("over a target pin, when the plain L would cross a body, the preview is exactly routeBetween's route", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 4), resistor("R9", 6, -2, 90)])
    const wiring = wiringFor(doc)
    const started = startDrawing(wiring, drawEndAt(wiring, at(4, 1)))
    if (isRefusal(started)) throw new Error(started.refused)
    const preview = previewOf(doc, wiring, pointerAt(started, at(10, 5)), drawEndAt(wiring, at(10, 5)))
    expect.soft(preview.routed, "routed").toBe(true)
    expect.soft(cells(preview.points), "the router's path").toEqual(cells(routeBetween(doc, pin("R1", "2"), pin("R2", "1"))))
  })
})

const SRC = join(import.meta.dirname, "..", "..", "src")

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return /\.(ts|tsx)$/.test(name) ? [full] : []
  })
}

describe("the stubs go (design.md §1.3, §4.1; plan.md phase 6)", () => {
  it("no definition in the catalogue declares a stub (today 1 793 pins on 39 definitions)", () => {
    const declaring = allDefs().flatMap((def) => def.pins.filter((p) => "stub" in p).map((p) => `${def.id}:${p.id}`))
    expect.soft(declaring.length, `pins declaring a stub, the first: ${declaring.slice(0, 5).join(", ")}`).toBe(0)
  })

  it("no source file declares or reads a pin's stub (today 19 files: geometry, placement, pending-wire, PinLayer, types and 14 definition files)", () => {
    const hits = sources(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => (/\.stub\b|\bstub\??\s*:/.test(line) ? [`${file.slice(SRC.length + 1)}:${i + 1}`] : [])),
    )
    expect.soft(hits, "lines").toEqual([])
  })

  it("the old router's helpers are gone: no nudging, no bend reach, no bends kept on a route (plan.md phase 6; design.md §7 «Nudging … goes»)", () => {
    const left = ["nudgeRoutes", "bendReach", "bendsOnRoute"].filter((name) => name in geometry)
    expect.soft(left, "still exported from geometry.ts").toEqual([])
  })
})

function closePartsHooks(): Schematic {
  return docOf(
    [resistor("R1", 0, 0), resistor("R2", 5, 1), resistor("R3", 0, 6), led("LED1", 4, 7, 90), resistor("R4", 12, 0, 90), resistor("R5", 14, 0, 90), resistor("R6", 12, 7), resistor("R7", 13, 9, 180)],
    [
      { id: "w12", a: at(4, 1), b: at(5, 1) },
      { id: "w12~2", a: at(5, 1), b: at(5, 2) },
      { id: "s0", a: at(5, 2), b: at(5, 3) },
      { id: "w12~3", a: at(5, 3), b: at(4, 3) },
      { id: "w12~4", a: at(4, 3), b: at(4, 2) },
      { id: "w12~5", a: at(4, 2), b: at(5, 2) },
      { id: "w3l", a: at(4, 7), b: at(5, 7) },
      { id: "s1", a: at(5, 7), b: at(6, 7) },
      { id: "w3l~2", a: at(6, 7), b: at(6, 6) },
      { id: "w3l~3", a: at(6, 6), b: at(5, 6) },
      { id: "w3l~4", a: at(5, 6), b: at(5, 7) },
      { id: "w45b", a: at(13, 4), b: at(13, 5) },
      { id: "w45b~2", a: at(13, 5), b: at(15, 5) },
      { id: "w45b~3", a: at(15, 5), b: at(15, 4) },
      { id: "w45a", a: at(13, 0), b: at(13, -1) },
      { id: "w45a~2", a: at(13, -1), b: at(15, -1) },
      { id: "w45a~3", a: at(15, -1), b: at(15, 0) },
      { id: "w67", a: at(16, 8), b: at(18, 8) },
      { id: "w67~2", a: at(18, 8), b: at(18, 10) },
      { id: "w67~3", a: at(18, 10), b: at(17, 10) },
    ],
  )
}

function closePartsHooksAsSaved(): SavedSchematic {
  const doc = closePartsHooks()
  const wire = (id: string, a: string, pa: string, b: string, pb: string) => ({ id, from: { object: a, pin: pa }, to: { object: b, pin: pb } })
  return { objects: doc.objects, wires: [wire("w12", "R1", "2", "R2", "1"), wire("w3l", "R3", "2", "LED1", "1"), wire("w45b", "R4", "2", "R5", "2"), wire("w45a", "R4", "1", "R5", "1"), wire("w67", "R6", "2", "R7", "1")], parts: {} }
}

function tidied(start: Schematic): { doc: Schematic; refusals: string[] } {
  let doc = start
  const refusals: string[] = []
  for (let pass = 0; pass < 6; pass++) {
    const before = JSON.stringify(geometryOf(doc.wires))
    for (const run of runsOf(doc.wires, wirePins(doc.objects))) {
      const id = run.segments[0].id
      if (!doc.wires.some((s) => s.id === id)) continue
      const result = rerouted(doc, id, newId)
      if (isRerouteRefusal(result)) refusals.push(`${id}: ${result.refused}`)
      else doc = result
    }
    if (JSON.stringify(geometryOf(doc.wires)) === before) break
  }
  return { doc, refusals }
}

function runsPastAPin(doc: Schematic): string[] {
  const out: string[] = []
  for (const run of runsOf(doc.wires, wirePins(doc.objects))) {
    const a = run.points[0]
    const b = run.points[run.points.length - 1]
    const show = JSON.stringify(cells(run.points))
    if (!insideTheBoxOf(run.points, a, b)) out.push(`${show} runs past an end`)
    if (cornersOf(run.points) > 1) out.push(`${show} has ${cornersOf(run.points)} corners`)
  }
  return out
}

describe("re-route a run (design.md §7: «the “re-route” command on a selected run»; §6.2; §13.18: «“re-route” straightens a run»)", () => {
  it("a stored wire with a frozen stub hook — R6 → R7's detour out to the right — is straightened to one corner, its circuit unchanged", () => {
    const doc = closePartsHooks()
    const result = rerouted(doc, "w67~2", newId)
    if (isRerouteRefusal(result)) throw new Error(result.refused)
    const others = doc.wires.filter((s) => !s.id.startsWith("w67"))
    expect.soft(geometryOf(result.wires.filter((s) => !others.some((o) => o.id === s.id))), "the run now").toEqual(geometryOf(path(at(16, 8), at(17, 8), at(17, 10))))
    const byId = (list: readonly WireSegment[]) => [...list].sort((p, q) => (p.id < q.id ? -1 : 1))
    expect.soft(byId(result.wires.filter((s) => others.some((o) => o.id === s.id))), "every other segment as it was, id and all: one edit touches one run").toEqual(byId(others))
    expect.soft(partition(result), "the circuit").toEqual(partition(doc))
  })

  it("re-route lays the router's route between the run's two ends, in one direction or the other (design.md §7: one router, three uses)", () => {
    const doc = closePartsHooks()
    const without = removed(doc, new Set(), new Set(["w67", "w67~2", "w67~3"]), newId)
    const forth = cells(routeBetween(without, pin("R6", "2"), pin("R7", "1")))
    const back = cells(routeBetween(without, pin("R7", "1"), pin("R6", "2")))?.reverse()
    const result = rerouted(doc, "w67", newId)
    if (isRerouteRefusal(result)) throw new Error(result.refused)
    const run = runsOf(result.wires, wirePins(result.objects)).find((r) => r.points.some((p) => p.x === c(16) && p.y === c(8)))!
    const got = cells(run.points[0].x === c(16) ? run.points : [...run.points].reverse())
    expect.soft([JSON.stringify(forth), JSON.stringify(back)], `the run ${JSON.stringify(got)} is the router's`).toContain(JSON.stringify(got))
  })

  it("re-route again changes nothing: a run already on the router's route is left as it is", () => {
    const once = rerouted(closePartsHooks(), "w67", newId)
    if (isRerouteRefusal(once)) throw new Error(once.refused)
    const segment = once.wires.find((s) => s.a.x === c(16) || s.b.x === c(16))!
    const twice = rerouted(once, segment.id, newId)
    if (isRerouteRefusal(twice)) throw new Error(twice.refused)
    expect.soft(geometryOf(twice.wires), "the same geometry").toEqual(geometryOf(once.wires))
  })

  it("a branch run keeps its branch point and its dot: only the run between them is laid again (design.md §6.2: a run ends at pins, branches and dangling ends; taken by default)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 12, 0), resistor("R3", 7, 4, 90)], [seg(at(4, 1), at(12, 1)), ...path(at(8, 4), at(8, 3), at(10, 3), at(10, 1))])
    const branch = doc.wires.find((s) => [s.a, s.b].some((p) => p.x === c(8) && p.y === c(4)))!
    const result = rerouted(doc, branch.id, newId)
    if (isRerouteRefusal(result)) throw new Error(result.refused)
    expect.soft(junctionsOf(viewOf(result)), "the dot where it was").toEqual([at(10, 1)])
    expect.soft(geometryOf(result.wires), "R3's pin out sideways along its row, one corner, up onto the spine at x = 10").toEqual(geometryOf([seg(at(4, 1), at(10, 1)), seg(at(10, 1), at(12, 1)), ...path(at(8, 4), at(10, 4), at(10, 1))]))
    expect.soft(partition(result), "the circuit").toEqual(partition(doc))
  })

  it("a run whose two ends meet — the loop a frozen stub left through R2's pin — re-routes to nothing (design.md §10 item 2's rule for coinciding ends; taken by default)", () => {
    const doc = closePartsHooks()
    const result = rerouted(doc, "s0", newId)
    if (isRerouteRefusal(result)) throw new Error(result.refused)
    expect.soft(geometryOf(result.wires.filter((s) => [s.a, s.b].some((p) => p.x <= c(5) && p.y >= c(1) && p.y <= c(3)))), "only R1 → R2's first run is left there").toEqual(geometryOf(path(at(4, 1), at(5, 1), at(5, 2))))
    expect.soft(partition(result), "the circuit").toEqual(partition(doc))
  })

  it("close-parts-hooks as phase 5 stored it, every run re-routed: none runs past a pin, none has more than one corner, no dot, no open end, the same circuit (plan.md acceptance 2)", () => {
    const doc = closePartsHooks()
    const { doc: after, refusals } = tidied(doc)
    expect.soft(refusals, "nothing refused").toEqual([])
    expect.soft(runsPastAPin(after), "no segment past a pin").toEqual([])
    expect.soft(junctionsOf(viewOf(after)), "no dot: every net is two pins").toEqual([])
    expect.soft(danglingEnds(viewOf(after)), "no open end").toEqual([])
    expect.soft(partition(after), "the circuit").toEqual(partition(doc))
    expect.soft(normalFormViolations(after.wires, wirePins(after.objects)), "normal form").toEqual([])
  })

  it("close-parts-hooks as before/ has it (scripts/before-shots.mts: a file from before the segments), opened and every run re-routed: the same (plan.md acceptance 2)", () => {
    const { doc } = upgraded(closePartsHooksAsSaved())
    const { doc: after, refusals } = tidied(doc)
    expect.soft(refusals, "nothing refused").toEqual([])
    expect.soft(runsPastAPin(after), "no segment past a pin").toEqual([])
    expect.soft(junctionsOf(viewOf(after)), "no dot").toEqual([])
    expect.soft(partition(after), "the circuit the file had").toEqual(partition(closePartsHooks()))
  })

  it("refused, and named, when no clean path exists: R2's pin is boxed in by three other nets' pins, its run reaches it on half cells, and the router keeps to whole cells (design.md §4.2, §13.5: the slip is the only half-cell route)", () => {
    const doc = docOf(
      [resistor("R2", 8, 0), resistor("R5", 3, 0), resistor("R6", 7, -4, 90), resistor("R7", 7, 2, 90)],
      path(at(8, 1), at(8, 1.5), at(10, 1.5), at(10, 4)),
    )
    expect.soft(partition(doc).length, "guard: the run joins nothing").toBe(0)
    expect.soft(bestShape(doc, at(8, 1), at(10, 4)), "guard: no whole-cell route reaches R2's pin").toBeNull()
    const result = rerouted(doc, doc.wires[0].id, newId)
    expect.soft(isRerouteRefusal(result) && result.refused, "refused").toBe("no-clean-path")
    expect.soft(REROUTE_REFUSED["no-clean-path"].title, "with a name the status line shows").toBe("Not re-routed")
    expect.soft(routeBetween(doc, pin("R2", "1"), { at: at(10, 4) }), "the router itself finds none").toBeNull()
  })
})

describe("the migration's fallback is the router (design.md §7: used in migration; §10 item 4; plan.md phase 6)", () => {
  const two = (): LegacySchematic => ({
    objects: [resistor("A1", 0, 0), resistor("A2", 20, 0), resistor("B1", 0, 6), resistor("B2", 20, 6)],
    wires: [
      { id: "a", from: { object: "A1", pin: "2" }, to: { object: "A2", pin: "1" }, points: [at(8, 3), at(16, 3)] },
      { id: "b", from: { object: "B1", pin: "2" }, to: { object: "B2", pin: "1" }, points: [at(8, 3), at(16, 3)] },
    ],
    parts: {},
  })

  it("two nets drawn along one corridor: the second, laid again, is the router's route between its pins on the document as the first left it", () => {
    const { routes } = wiresAsSegments(two())
    const firstOnly = wiresAsSegments({ ...two(), wires: [two().wires[0]] }).doc
    expect.soft(cells(routes.get("b")), "laid by the router").toEqual(cells(routeBetween(firstOnly, pin("B1", "2"), pin("B2", "1"))))
  })

  it("a file with D45's wire over RESET's wired socket opens with D45's wire on the slip (design.md §13.9 in the upgrade)", () => {
    const u1 = board("nucleo-f429zi")
    const saved: SavedSchematic = {
      objects: [u1, resistor("R1", -7, 18), resistor("R4", -12, 18)],
      wires: [
        { id: "passing", from: { object: "U1", pin: "CN8-6" }, to: { object: "R4", pin: "2" } },
        { id: "ending", from: { object: "U1", pin: "CN8-5" }, to: { object: "R1", pin: "2" } },
      ],
      parts: {},
    }
    const { doc } = upgraded(saved)
    const d45 = runsOf(doc.wires, wirePins(doc.objects)).find((r) => r.points.some((p) => p.x === c(6) && p.y === c(19)))
    const got = d45 && cells(d45.points[0].x === c(6) ? d45.points : [...d45.points].reverse())
    expect.soft(got?.slice(0, 4), `D45 out on the slip, back on a whole row at x = 3: ${JSON.stringify(got)}`).toSatisfy((start: unknown) => {
      const s = start as number[][] | undefined
      return !!s && s.length === 4 && s[0][0] === 6 && s[0][1] === 19 && s[1][0] === 6 && Math.abs(s[1][1] - 19) === 0.5 && s[2][0] === 3 && s[2][1] === s[1][1] && s[3][0] === 3 && Math.abs(s[3][1] - 19) === 1
    })
    expect.soft(partition(doc), "two nets").toEqual([
      ["R1:2", "U1:CN8-5"],
      ["R4:2", "U1:CN8-6"],
    ])
  })
})

describe("the reference this suite measures against (tests/lib/route-reference.ts)", () => {
  it("guard: it agrees with the hand-worked cases — one corner for R1 → R2 and R6 → R7, a straight line for R3 → LED1 and R4 ∥ R5", () => {
    const bare = { ...closePartsHooks(), wires: [] }
    const shape = (a: Point, b: Point) => {
      const s = bestShape(bare, a, b)
      return s && [s.bends, s.length]
    }
    expect.soft(shape(at(4, 1), at(5, 2)), "R1 → R2").toEqual([1, 2])
    expect.soft(shape(at(4, 7), at(5, 7)), "R3 → LED1").toEqual([0, 1])
    expect.soft(shape(at(13, 4), at(15, 4)), "R4 ∥ R5").toEqual([0, 2])
    expect.soft(shape(at(16, 8), at(17, 10)), "R6 → R7").toEqual([1, 3])
  })

  it("guard: the scene of «fewer bends before a shorter route» does tell the two orders apart", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 6, 180), resistor("R3", 3, 3), resistor("R4", 11, 1, 90)])
    const bends = bestShape(doc, at(4, 1), at(14, 7), "bends before length")
    const length = bestShape(doc, at(4, 1), at(14, 7), "length before bends")
    expect.soft(bends && [bends.bends, bends.length], "bends first").toEqual([2, 18])
    expect.soft(length && [length.bends, length.length], "length first").toEqual([3, 16])
  })

  it("guard: it finds phase 5's frozen R6 → R7 hook wanting — two corners where one will do", () => {
    const doc = closePartsHooks()
    const hook = runsOf(doc.wires, wirePins(doc.objects)).find((r) => r.segments.some((s) => s.id === "w67"))!
    expect.soft(shapeOf({ ...doc, wires: doc.wires.filter((s) => !s.id.startsWith("w67")) }, hook.points).bends, "R6 → R7 as frozen: two corners where one will do").toBe(2)
  })
})
