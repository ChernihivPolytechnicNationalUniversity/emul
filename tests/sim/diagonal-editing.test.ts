import { describe, expect, it } from "vitest"
import { holdsPan } from "@/components/field/use-viewport"
import { labelFor, KEYMAP } from "@/lib/keymap"
import { matchesAny, type KeyPress, type Keys } from "@/lib/keys"
import { checked } from "@/schematic/checker"
import { GRID, objectPins, type Point } from "@/schematic/geometry"
import { junctionAt, NOT_ON_THE_LATTICE } from "@/schematic/junction-tool"
import { wirePins } from "@/schematic/migrate-wires"
import { flippedWithWires, PartDrag, SegmentDrag, TurnRun } from "@/schematic/rubber-band"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { pastedInto } from "@/schematic/use-schematic"
import {
  backAlong,
  DEFAULT_LINE_MODE,
  drawEndAt,
  drawnTo,
  flipPosture,
  isRefusal,
  lineModeTag,
  nextLineMode,
  pointerAt,
  previewOf,
  startDrawing,
  withCorner,
  withLineMode,
  withoutCorner,
  type DrawEnd,
  type Drawing,
  type LineMode,
} from "@/schematic/wire-draw"
import { clipOf, inNormalForm, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { danglingEnds, junctionsOf, pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import { latticePointNear, type WireSegment } from "@/schematic/wires/segment"
import { diagonalNormalFormViolations } from "../lib/diagonal-reference"
import { counter, geometryOf, sortedPoints } from "../lib/wire-reference"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
let serial = 0
const seg = (a: Point, b: Point): WireSegment => ({ id: `s${++serial}`, a, b })
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic): Wiring => wiringOf(new WireGraph(), doc)
const viewOf = (doc: Schematic) => wireNets(doc.wires, wirePins(doc.objects))
const partition = (doc: Schematic) => pinPartition(viewOf(doc))
const normalForm = (doc: Schematic) => diagonalNormalFormViolations(doc.wires, wirePins(doc.objects))
const field = (p: Point): DrawEnd => ({ kind: "field", at: p })
const newId = counter("d")
const pinOf = (doc: Schematic, id: string, pin: string) => objectPins(doc.objects.find((o) => o.id === id)!, GRID).find((p) => p.pin.id === pin)!.point

function drawing(doc: Schematic, from: Point, mode?: LineMode): { wiring: Wiring; d: Drawing } {
  const wiring = wiringFor(doc)
  const started = startDrawing(wiring, drawEndAt(wiring, from))
  if (isRefusal(started)) throw new Error(`the drawing could not start at (${from.x / GRID}, ${from.y / GRID}): ${started.refused}`)
  return { wiring, d: mode ? withLineMode(started, mode) : started }
}

const press = (key: string, code: string, shiftKey = false): KeyPress => ({ key, code, shiftKey, ctrlKey: false, metaKey: false, altKey: false })

describe("the line mode: Shift+Space cycles 90° → 45° → any angle, 90° by default (design.md §6.11 rule 1; KiCad LINE_MODE_FREE/90/45, eeschema_settings.h:42–49, default 90, Shift+Space cycles; Altium 90/45/Any Angle, Shift+Space; ГОСТ 2.701-2008 п. 5.5.2: orthogonal by rule, oblique «в отдельных случаях»)", () => {
  it("cycles 90° → 45° → any angle → 90°, and a session starts at 90°", () => {
    expect.soft(DEFAULT_LINE_MODE, "the default").toBe("90")
    expect.soft(nextLineMode("90"), "from 90°").toBe("45")
    expect.soft(nextLineMode("45"), "from 45°").toBe("any")
    expect.soft(nextLineMode("any"), "from any angle, back to the start").toBe("90")
  })

  it("is the KEYMAP binding lineMode on Shift+Space, printed as Shift+Space; Space alone and Shift alone are not it; the tag beside the pointer reads 90°, 45°, ∠", () => {
    const lineMode = (KEYMAP as unknown as Record<string, Keys | undefined>).lineMode
    expect.soft(lineMode, "a binding in the keymap").toBeDefined()
    if (lineMode) {
      expect.soft(!!matchesAny(press(" ", "Space", true), lineMode), "Shift+Space").toBe(true)
      expect.soft(!!matchesAny(press(" ", "Space"), lineMode), "Space alone").toBe(false)
      expect.soft(!!matchesAny(press("Shift", "ShiftLeft", true), lineMode), "Shift alone").toBe(false)
      expect.soft(labelFor(lineMode, "windows"), "its label").toBe("Shift+Space")
    }
    expect.soft(lineModeTag("90"), "90°").toBe("90°")
    expect.soft(lineModeTag("45"), "45°").toBe("45°")
    expect.soft(lineModeTag("any"), "any angle").toBe("∠")
  })

  it("Space alone still holds the pan; Shift+Space never does (design.md §6.11 rule 1: «Shift+Space never starts a pan»)", () => {
    const key = (shiftKey: boolean) => ({ code: "Space", repeat: false, shiftKey, defaultPrevented: false })
    expect.soft(holdsPan(key(false)), "Space").toBe(true)
    expect.soft(holdsPan(key(true)), "Shift+Space").toBe(false)
  })

  it("a drawing given no mode lays today's L (guard)", () => {
    const doc = docOf([resistor("R1", 0, 0)])
    const { wiring, d } = drawing(doc, at(10, 10))
    expect(previewOf(doc, wiring, pointerAt(d, at(15, 12))).points).toEqual([at(10, 10), at(15, 10), at(15, 12)])
  })
})

describe("what each mode lays between the last vertex and the pointer (design.md §6.11 rule 2; KiCad computeBreakPoint, sch_line_wire_bus_tool.cpp:596–730, posture `/` choosing which end carries the diagonal; Altium 45 and Any Angle; Horizon BendMode::ARB, tool_draw_line_net.cpp:519–525)", () => {
  const doc = () => docOf([resistor("R1", 0, 0)])
  const lay = (mode: LineMode, to: Point, flipped = false) => {
    const scene = doc()
    const { wiring, d } = drawing(scene, at(10, 10), mode)
    const aimed = pointerAt(d, to)
    return previewOf(scene, wiring, flipped ? flipPosture(aimed) : aimed).points
  }

  it("90°: today's L, `/` its other posture", () => {
    expect.soft(lay("90", at(15, 12)), "across, then down").toEqual([at(10, 10), at(15, 10), at(15, 12)])
    expect.soft(lay("90", at(15, 12), true), "`/`: down, then across").toEqual([at(10, 10), at(10, 12), at(15, 12)])
  })

  it("45°: one orthogonal leg along the longer axis, then the 45° leg; `/` puts the 45° leg first", () => {
    expect.soft(lay("45", at(15, 12)), "(5, 2): three across, then 45° down").toEqual([at(10, 10), at(13, 10), at(15, 12)])
    expect.soft(lay("45", at(15, 12), true), "`/`: 45° first, then across").toEqual([at(10, 10), at(12, 12), at(15, 12)])
    expect.soft(lay("45", at(12, 15)), "(2, 5): three down, then 45°").toEqual([at(10, 10), at(10, 13), at(12, 15)])
    expect.soft(lay("45", at(12, 15), true), "`/`: 45° first, then down").toEqual([at(10, 10), at(12, 12), at(12, 15)])
    expect.soft(lay("45", at(5, 8)), "(−5, −2): three back, then 45° up").toEqual([at(10, 10), at(7, 10), at(5, 8)])
    expect.soft(lay("45", at(5, 8), true), "`/`: 45° up first").toEqual([at(10, 10), at(8, 8), at(5, 8)])
  })

  it("45°: a single segment when |dx| = |dy| or when one of them is 0, in either posture", () => {
    for (const to of [at(13, 13), at(7, 13), at(14, 10), at(10, 6)]) {
      const label = `to (${to.x / GRID}, ${to.y / GRID})`
      expect.soft(lay("45", to), label).toEqual([at(10, 10), to])
      expect.soft(lay("45", to, true), `${label}, flipped`).toEqual([at(10, 10), to])
    }
  })

  it("any angle: the one straight segment, whatever the posture", () => {
    expect.soft(lay("any", at(15, 12)), "(5, 2)").toEqual([at(10, 10), at(15, 12)])
    expect.soft(lay("any", at(15, 12), true), "flipped").toEqual([at(10, 10), at(15, 12)])
    expect.soft(lay("any", at(3, 13)), "(−7, 3)").toEqual([at(10, 10), at(3, 13)])
  })

  it("a click commits what is shown, both legs of a 45° at once; Backspace takes the whole click back (KiCad: in 45 mode a click places both, :956–959)", () => {
    const scene = doc()
    const { wiring, d } = drawing(scene, at(10, 10), "45")
    const aimed = pointerAt(d, at(15, 12))
    const clicked = withCorner(scene, wiring, aimed, at(15, 12))
    if (isRefusal(clicked)) throw new Error(`a click on empty field is refused: ${clicked.refused}`)
    expect.soft(clicked.corners, "the corner and the clicked point").toEqual([at(13, 10), at(15, 12)])
    expect.soft(previewOf(scene, wiring, pointerAt(clicked, at(18, 12))).points, "the next leg leaves the clicked point").toEqual([at(10, 10), at(13, 10), at(15, 12), at(18, 12)])
    const back = withoutCorner(pointerAt(clicked, at(15, 12)))
    expect.soft(back.corners, "Backspace: no corner left").toEqual([])
    expect.soft(previewOf(scene, wiring, back).points, "and the preview as before the click").toEqual(previewOf(scene, wiring, aimed).points)
  })

  it("Enter at the last clicked point lays what was clicked and leaves the end open (design.md §6.1)", () => {
    const scene = doc()
    const { wiring, d } = drawing(scene, at(10, 10), "45")
    const clicked = withCorner(scene, wiring, pointerAt(d, at(15, 12)), at(15, 12))
    if (isRefusal(clicked)) throw new Error(`a click on empty field is refused: ${clicked.refused}`)
    const done = drawnTo(scene, wiring, clicked, field(at(15, 12)), newId)
    if (isRefusal(done)) throw new Error(`refused: ${done.refused}`)
    expect.soft(geometryOf(done.wires), "the orthogonal leg and the 45° leg").toEqual(geometryOf([seg(at(10, 10), at(13, 10)), seg(at(13, 10), at(15, 12))]))
    expect.soft(sortedPoints(danglingEnds(viewOf(done))), "both ends open").toEqual(sortedPoints([at(10, 10), at(15, 12)]))
    expect.soft(normalForm(done), "normal form").toEqual([])
  })

  it("the mode may change mid-wire and applies to the legs after the change", () => {
    const scene = doc()
    const { wiring, d } = drawing(scene, at(10, 10), "90")
    const first = withCorner(scene, wiring, pointerAt(d, at(14, 12)), at(14, 12))
    if (isRefusal(first)) throw new Error(`refused: ${first.refused}`)
    const slanted = withLineMode(first, "any")
    expect.soft(previewOf(scene, wiring, pointerAt(slanted, at(17, 16))).points, "the L kept, then one straight leg").toEqual([at(10, 10), at(14, 10), at(14, 12), at(17, 16)])
    const second = withCorner(scene, wiring, pointerAt(slanted, at(17, 16)), at(17, 16))
    if (isRefusal(second)) throw new Error(`refused: ${second.refused}`)
    const square = withLineMode(second, "90")
    expect.soft(previewOf(scene, wiring, pointerAt(square, at(20, 16))).points, "back to 90°: the slanted leg kept, a level leg after it").toEqual([at(10, 10), at(14, 10), at(14, 12), at(17, 16), at(20, 16)])
  })

  it("the router's completion is offered in 90° only: in 45° and any angle the leg aimed at a pin is laid as aimed or refused, never re-routed (design.md §6.11 rule 2, §7)", () => {
    const scene = docOf([resistor("R1", 0, 0), resistor("R2", 12, 4), resistor("R9", 7, 1, 90)])
    expect.soft(pinOf(scene, "R9", "1"), "set up: R9 stands with its top pin at (8, 1)").toEqual(at(8, 1))
    const wiring = wiringFor(scene)
    const target = drawEndAt(wiring, at(12, 5))
    const any = previewOf(scene, wiring, pointerAt(drawing(scene, at(4, 1), "any").d, at(12, 5)), target)
    expect.soft(any.routed, "any angle: not routed").toBe(false)
    expect.soft(any.points, "the straight leg aimed").toEqual([at(4, 1), at(12, 5)])
    expect.soft(any.refused?.refused, "through R9's body: refused").toBe("body")
    const fortyFive = previewOf(scene, wiring, pointerAt(drawing(scene, at(4, 1), "45").d, at(12, 5)), target)
    expect.soft(fortyFive.routed, "45°: not routed").toBe(false)
    expect.soft(fortyFive.points, "across to (8, 1), then 45°").toEqual([at(4, 1), at(8, 1), at(12, 5)])
    expect.soft(fortyFive.refused?.refused, "its corner on R9's pin: refused").toBe("corner")
  })
})

describe("N1 relaxed in the editor: a diagonal laid by hand is exact and in normal form (design.md §6.11 rules 2–3)", () => {
  it("drawn in any angle from R1's pin to R2's pin, it is one segment, one net, no dot", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 4)])
    const { wiring, d } = drawing(doc, at(4, 1), "any")
    const done = drawnTo(doc, wiring, pointerAt(d, at(10, 5)), drawEndAt(wiring, at(10, 5)), newId)
    if (isRefusal(done)) throw new Error(`refused: ${done.refused}`)
    expect.soft(geometryOf(done.wires), "one diagonal").toEqual(geometryOf([seg(at(4, 1), at(10, 5))]))
    expect.soft(partition(done), "one net").toEqual([["R1:2", "R2:1"]])
    expect.soft(junctionsOf(viewOf(done)), "no dot").toEqual([])
    expect.soft(normalForm(done), "normal form").toEqual([])
  })
})

describe("crossings: J and the double click join only at a lattice point of both wires (design.md §6.11 rule 5, §6.4; IEEE 315-1975 3.1.5)", () => {
  const ids = counter("j")
  const fourWay = (doc: Schematic, point: Point) => {
    const joined = junctionAt(doc, wiringFor(doc), point, ids)
    if ("refused" in joined) throw new Error(`refused: ${joined.refused}`)
    return joined
  }

  it("a diagonal across an orthogonal wire at a lattice point: J splits both, four ends, a dot, one net", () => {
    const doc = docOf([], [seg(at(0, 0), at(4, 4)), seg(at(0, 2), at(4, 2))])
    const joined = fourWay(doc, at(2, 2))
    expect.soft(geometryOf(joined.wires), "four pieces").toEqual(geometryOf([seg(at(0, 0), at(2, 2)), seg(at(2, 2), at(4, 4)), seg(at(0, 2), at(2, 2)), seg(at(2, 2), at(4, 2))]))
    expect.soft(junctionsOf(viewOf(joined)), "a dot").toEqual([at(2, 2)])
    expect.soft(new Set(joined.wires.map((s) => viewOf(joined).netOfSegment(s.id))).size, "one net").toBe(1)
  })

  it("two diagonals crossing as an X at a lattice point: J joins them the same way", () => {
    const doc = docOf([], [seg(at(0, 0), at(4, 4)), seg(at(0, 4), at(4, 0))])
    const joined = fourWay(doc, at(2, 2))
    expect.soft(joined.wires.length, "four pieces").toBe(4)
    expect.soft(junctionsOf(viewOf(joined)), "a dot").toEqual([at(2, 2)])
    expect.soft(new Set(joined.wires.map((s) => viewOf(joined).netOfSegment(s.id))).size, "one net").toBe(1)
  })

  it("two diagonals crossing between lattice points: J there is refused, named «Not on the lattice», and nothing changes", () => {
    const doc = docOf([], [seg(at(0, 0), at(2, 1)), seg(at(0, 1), at(1, 0))])
    const crossing = { x: (2 / 3) * GRID, y: (1 / 3) * GRID }
    const refused = junctionAt(doc, wiringFor(doc), crossing, ids)
    expect.soft(refused, "refused where they cross").toEqual({ refused: "off-lattice", at: crossing })
    expect.soft(NOT_ON_THE_LATTICE.title, "its name").toBe("Not on the lattice")
  })

  it("a press resolves to a crossing only where two wires pass a lattice point; inside a diagonal elsewhere it is that wire, at its open end an end (design.md §6.1 double click)", () => {
    const doc = docOf([], [seg(at(0, 0), at(4, 4)), seg(at(0, 2), at(4, 2)), seg(at(10, 0), at(14, 2))])
    const wiring = wiringFor(doc)
    const diagonal = doc.wires.find((s) => s.a.x === c(10) || s.b.x === c(10))!
    expect.soft(drawEndAt(wiring, at(2, 2)).kind, "the crossing").toBe("crossing")
    expect.soft(drawEndAt(wiring, at(12, 1)), "a lattice point inside the lone diagonal").toEqual({ kind: "wire", at: at(12, 1), segment: diagonal.id })
    expect.soft(drawEndAt(wiring, at(14, 2)).kind, "its open end").toBe("end")
  })
})

describe("branching from a diagonal (design.md §6.11 rule 6; KiCad BreakSegments on any end inside a wire, IsPointOnSegment exact)", () => {
  const REACH = GRID / 2

  it("a press on a diagonal resolves to the lattice point inside it nearest the press, within the usual reach; none there, nothing", () => {
    const s = seg(at(0, 0), at(4, 2))
    expect.soft(latticePointNear(s, { x: c(2.1), y: c(0.95) }, REACH), "by (2, 1)").toEqual(at(2, 1))
    expect.soft(latticePointNear(s, { x: c(1), y: c(0.6) }, REACH), "by (1, 0.5), a half cell").toEqual(at(1, 0.5))
    expect.soft(latticePointNear(s, { x: c(0.05), y: c(0.02) }, REACH), "by its end: an end is not inside").toBeNull()
    const sparse = seg(at(0, 0), at(7, 3))
    expect.soft(latticePointNear(sparse, { x: c(1), y: c(3 / 7) }, REACH), "on (0, 0)–(7, 3) far from its one inner lattice point").toBeNull()
    expect.soft(latticePointNear(sparse, { x: c(3.4), y: c(1.45) }, REACH), "by (3.5, 1.5)").toEqual(at(3.5, 1.5))
    expect.soft(latticePointNear(seg(at(0, 0), at(0.5, 1.5)), { x: c(0.25), y: c(0.75) }, REACH), "a diagonal with no lattice point inside").toBeNull()
  })

  const spine = () => docOf([resistor("R1", 0, 0), resistor("R2", 12, 4)], [seg(at(4, 1), at(12, 5))])

  it("a wire started at a lattice point inside the diagonal branches there: the diagonal split, a dot (design.md §6.4)", () => {
    const doc = spine()
    const wiring = wiringFor(doc)
    const from = drawEndAt(wiring, at(8, 3))
    expect.soft(from.kind, "the press is on the wire").toBe("wire")
    const started = startDrawing(wiring, from)
    if (isRefusal(started)) throw new Error(`refused: ${started.refused}`)
    const done = drawnTo(doc, wiring, pointerAt(started, at(8, 7)), field(at(8, 7)), newId)
    if (isRefusal(done)) throw new Error(`refused: ${done.refused}`)
    expect.soft(geometryOf(done.wires), "split at the branch").toEqual(geometryOf([seg(at(4, 1), at(8, 3)), seg(at(8, 3), at(12, 5)), seg(at(8, 3), at(8, 7))]))
    expect.soft(junctionsOf(viewOf(done)), "the dot").toEqual([at(8, 3)])
    expect.soft(normalForm(done), "normal form").toEqual([])
  })

  it("a wire ended on a lattice point inside the diagonal joins it there", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 12, 4), resistor("R3", 7, 8, 90)], [seg(at(4, 1), at(12, 5))])
    expect.soft(pinOf(doc, "R3", "1"), "set up: R3's top pin under (8, 3)").toEqual(at(8, 8))
    const { wiring, d } = drawing(doc, at(8, 8))
    const done = drawnTo(doc, wiring, pointerAt(d, at(8, 3)), drawEndAt(wiring, at(8, 3)), newId)
    if (isRefusal(done)) throw new Error(`refused: ${done.refused}`)
    expect.soft(partition(done), "one net of three").toEqual([["R1:2", "R2:1", "R3:1"]])
    expect.soft(junctionsOf(viewOf(done)), "the dot").toEqual([at(8, 3)])
  })

  it("shortening an open end back along a diagonal cuts only at its lattice points (design.md §6.1 «at the nearest lattice point», §6.11 rule 3)", () => {
    const doc = docOf([resistor("R1", 0, 0)], [seg(at(4, 1), at(7, 2))])
    const wiring = wiringFor(doc)
    const started = startDrawing(wiring, drawEndAt(wiring, at(7, 2)))
    if (isRefusal(started)) throw new Error(`refused: ${started.refused}`)
    const cut = backAlong(started, { x: c(6), y: c(5 / 3) }, GRID / 2, GRID)
    expect.soft(cut, "the inner lattice point (5.5, 1.5), not (6, 5/3)").toEqual(at(5.5, 1.5))
    if (!cut) return
    const done = drawnTo(doc, wiring, pointerAt(started, cut), drawEndAt(wiring, cut), newId)
    if (isRefusal(done)) throw new Error(`refused: ${done.refused}`)
    expect.soft(geometryOf(done.wires), "the wire cut back to it").toEqual(geometryOf([seg(at(4, 1), at(5.5, 1.5))]))
  })
})

describe("§6.7 and §13.27 at any angle: the same refusals with the same names (design.md §6.11 rule 7; junctions.md principle 3)", () => {
  it("along another net's diagonal: refused «along»", () => {
    const doc = docOf([resistor("R1", 0, 0)], [seg(at(4, 1), at(8, 3))])
    const { wiring, d } = drawing(doc, at(10, 4), "any")
    const preview = previewOf(doc, wiring, pointerAt(d, at(6, 2)))
    expect.soft(preview.points, "the straight leg, collinear with R1's wire").toEqual([at(10, 4), at(6, 2)])
    expect.soft(preview.refused?.refused, "along").toBe("along")
    expect.soft(isRefusal(drawnTo(doc, wiring, pointerAt(d, at(6, 2)), field(at(6, 2)), newId)), "the click lays nothing").toBe(true)
  })

  it("a pin at a lattice point inside the drawn diagonal connects and splits it", () => {
    const doc = docOf([resistor("R1", 0, 0)])
    const { wiring, d } = drawing(doc, at(2, 0), "any")
    const preview = previewOf(doc, wiring, pointerAt(d, at(10, 4)))
    expect.soft(preview.refused, "passing R1's pin is allowed").toBeNull()
    const after = drawnTo(doc, wiring, pointerAt(d, at(10, 4)), field(at(10, 4)), newId)
    if (isRefusal(after)) throw new Error(after.refused)
    expect.soft(geometryOf(after.wires), "split at the pin").toEqual(geometryOf([seg(at(2, 0), at(4, 1)), seg(at(4, 1), at(10, 4))]))
    expect.soft(junctionsOf(viewOf(after)), "two ends plus a pin give a dot").toEqual([at(4, 1)])
  })

  it("an open wire end on a drawn diagonal connects with a T and a dot", () => {
    const doc = docOf([resistor("R1", 20, 20)], [seg(at(6, 2), at(6, 6))])
    const { wiring, d } = drawing(doc, at(2, 0), "any")
    const preview = previewOf(doc, wiring, pointerAt(d, at(10, 4)))
    expect.soft(preview.refused, "passing the stub's end is allowed").toBeNull()
    const after = drawnTo(doc, wiring, pointerAt(d, at(10, 4)), field(at(10, 4)), newId)
    if (isRefusal(after)) throw new Error(after.refused)
    expect.soft(junctionsOf(viewOf(after)), "three ends give a dot").toEqual([at(6, 2)])
    expect.soft(viewOf(after).nets.length, "the stub and diagonal are one net").toBe(1)
  })

  it("a corner on another net: the 45° corner on a pin, or a click inside another net's diagonal, refused «corner»", () => {
    const pinned = docOf([resistor("R5", 13, 9)])
    const first = drawing(pinned, at(10, 10), "45")
    const preview = previewOf(pinned, first.wiring, pointerAt(first.d, at(15, 12)))
    expect.soft(preview.points, "set up: the corner lands on R5's pin").toEqual([at(10, 10), at(13, 10), at(15, 12)])
    expect.soft(preview.refused?.refused, "a corner on R5's pin").toBe("corner")
    const wired = docOf([resistor("R1", 40, 40)], [seg(at(20, 0), at(24, 2))])
    const second = drawing(wired, at(20, 4), "any")
    const click = withCorner(wired, second.wiring, pointerAt(second.d, at(22, 1)), at(22, 1))
    expect.soft(isRefusal(click) && click.refused, "a click inside another net's diagonal").toBe("corner")
  })

  it("through a part's body: refused «body»; past its corner, outside it, allowed although the boxes overlap — the test is exact, not a bounding box (design.md §13.27; §6.11 rule 7: separating axes)", () => {
    const doc = docOf([resistor("R2", 8, 0)])
    const across = drawing(doc, at(9, -1), "any")
    expect.soft(previewOf(doc, across.wiring, pointerAt(across.d, at(11, 3))).refused?.refused, "(9, −1)–(11, 3) through R2").toBe("body")
    const past = drawing(doc, at(7.5, 1), "any")
    expect.soft(previewOf(doc, past.wiring, pointerAt(past.d, at(9.5, 0))).refused, "(7.5, 1)–(9.5, 0): clear of R2's body, 0.31 cell from its corner").toBeNull()
  })
})

describe("dragging with diagonals (design.md §6.11 rule 8; KiCad orthoLineDrag bends only IsOrthogonal lines, sch_move_tool.cpp ≈ 453; LibrePCB stretches attached lines; CircuitJS keeps the angle a move makes)", () => {
  const ids = counter("g")
  const pair = () => docOf([resistor("R1", 0, 0), resistor("R2", 10, 4)], [seg(at(4, 1), at(10, 5))])
  const dragR2 = (doc: Schematic, dx: number, dy: number) => new PartDrag(doc, wiringFor(doc), { objects: new Set(["R2"]) }).landed(c(dx), c(dy), ids)

  it("a diagonal whose end is carried stretches and stays one straight segment, its other end where it was", () => {
    const landed = dragR2(pair(), 2, 1)
    expect.soft(landed.at, "dropped where let go").toEqual(at(2, 1))
    expect.soft(geometryOf(landed.doc.wires), "one segment from R1's pin to R2's moved pin").toEqual(geometryOf([seg(at(4, 1), at(12, 6))]))
    expect.soft(partition(landed.doc), "one net").toEqual([["R1:2", "R2:1"]])
    expect.soft(normalForm(landed.doc), "normal form").toEqual([])
  })

  it("a stretch that makes it level leaves it level; one that shrinks it to a point removes it, the pins butted", () => {
    const level = dragR2(pair(), 0, -4)
    expect.soft(geometryOf(level.doc.wires), "horizontal").toEqual(geometryOf([seg(at(4, 1), at(10, 1))]))
    const butted = dragR2(pair(), -6, -4)
    expect.soft(butted.doc.wires, "no wire left").toEqual([])
    expect.soft(partition(butted.doc), "R2's pin on R1's").toEqual([["R1:2", "R2:1"]])
  })

  it("orthogonal runs keep the rubber band beside a stretching diagonal: the straight wire to R3 takes KiCad's dog-leg at R3's pin", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 4), resistor("R3", 20, 4)], [seg(at(4, 1), at(10, 5)), seg(at(14, 5), at(20, 5))])
    const landed = dragR2(doc, 0, 2)
    expect.soft(geometryOf(landed.doc.wires), "the diagonal stretched, the level wire jogged one step out of R3's pin").toEqual(geometryOf([seg(at(4, 1), at(10, 7)), seg(at(14, 7), at(19, 7)), seg(at(19, 7), at(19, 5)), seg(at(19, 5), at(20, 5))]))
    expect.soft(partition(landed.doc), "two nets").toEqual([["R1:2", "R2:1"], ["R2:2", "R3:1"]])
  })

  it("a diagonal dragged by itself moves whole; an attached diagonal stretches, an attached orthogonal run rubber-bands to its fixed pin", () => {
    const a = seg(at(4, 1), at(8, 2))
    const b = seg(at(8, 2), at(12, 5))
    const run = seg(at(12, 5), at(16, 5))
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 16, 4)], [a, b, run])
    const moved = doc.wires.find((s) => geometryOf([s])[0] === geometryOf([b])[0])!
    const landed = new SegmentDrag(doc, wiringFor(doc), moved.id).landed(c(1), c(1), ids)
    expect.soft(landed.at, "moved by the whole offset, both axes").toEqual(at(1, 1))
    expect.soft(geometryOf(landed.doc.wires), "B whole, A stretched, the level run jogged at R2's pin").toEqual(
      geometryOf([seg(at(4, 1), at(9, 3)), seg(at(9, 3), at(13, 6)), seg(at(13, 6), at(15, 6)), seg(at(15, 6), at(15, 5)), seg(at(15, 5), at(16, 5))]),
    )
    expect.soft(partition(landed.doc), "one net").toEqual([["R1:2", "R2:1"]])
  })

  it("the release audit holds: a stretch that would lay the diagonal over another net's pin is blocked, and the drop lands where it touches nothing", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 4), resistor("R5", 6, -2, 90)], [seg(at(4, 1), at(10, 5))])
    expect.soft(pinOf(doc, "R5", "2"), "set up: R5's lower pin at (7, 2), on the line (4, 1)–(10, 3)").toEqual(at(7, 2))
    const drag = new PartDrag(doc, wiringFor(doc), { objects: new Set(["R2"]) })
    expect.soft(drag.blocked(0, c(-2)), "two cells up is blocked").toBe(true)
    const landed = drag.landed(0, c(-2), ids)
    expect.soft(landed.at, "landed elsewhere").not.toEqual(at(0, -2))
    expect.soft(partition(landed.doc).some((g) => g.includes("R5:2")), "R5 joined to nothing").toBe(false)
  })
})

describe("turning, flipping and pasting keep diagonals exact (design.md §6.11 rule 9: quarter turns and mirrors map the lattice onto itself; §6.6)", () => {
  const ids = counter("t")
  const pair = () => docOf([resistor("R1", 0, 0), resistor("R2", 10, 4)], [seg(at(4, 1), at(10, 5))])
  const span = (s: WireSegment) => [Math.abs(s.b.x - s.a.x) / GRID, Math.abs(s.b.y - s.a.y) / GRID]

  it("a selection holding the diagonal turned a quarter: one straight segment between the turned pins, its run and rise swapped", () => {
    const doc = pair()
    const run = new TurnRun(doc, wiringFor(doc), new Set(["R1", "R2"]), undefined, new Set([doc.wires[0].id]))
    const turned = run.turned(1, ids)
    expect.soft(turned.doc.wires.length, "one segment").toBe(1)
    const s = turned.doc.wires[0]
    expect.soft(sortedPoints([s.a, s.b]), "from R1's pin to R2's").toEqual(sortedPoints([pinOf(turned.doc, "R1", "2"), pinOf(turned.doc, "R2", "1")]))
    expect.soft(span(s), "(6, 4) turned is (4, 6)").toEqual([4, 6])
    expect.soft(partition(turned.doc), "one net").toEqual([["R1:2", "R2:1"]])
    expect.soft(normalForm(turned.doc), "on the lattice, in normal form").toEqual([])
  })

  it("a part turned alone stretches its diagonal as one segment even where the segment's box overlaps another part it passes clear of (the avoidance is exact, not by the box; rule 8)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 4), resistor("R9", 9, 1)], [seg(at(4, 1), at(10, 5))])
    const turned = new TurnRun(doc, wiringFor(doc), new Set(["R2"])).turned(1, ids)
    const pin = pinOf(turned.doc, "R2", "1")
    expect.soft(pin, "set up: R2's pin turned to (11, 4), the stretch passing under R9's body inside its box").toEqual(at(11, 4))
    expect.soft(geometryOf(turned.doc.wires), "one straight segment, not rerouted round R9").toEqual(geometryOf([seg(at(4, 1), pin)]))
    expect.soft(normalForm(turned.doc), "normal form").toEqual([])
  })

  it("mirrored: one straight segment between the mirrored pins, the same run and rise", () => {
    const doc = pair()
    const flipped = flippedWithWires(doc, wiringFor(doc), new Set(["R1", "R2"]), "horizontal", ids, undefined, new Set([doc.wires[0].id]))
    expect.soft(flipped.doc.wires.length, "one segment").toBe(1)
    const s = flipped.doc.wires[0]
    expect.soft(sortedPoints([s.a, s.b]), "between the mirrored pins").toEqual(sortedPoints([pinOf(flipped.doc, "R1", "2"), pinOf(flipped.doc, "R2", "1")]))
    expect.soft(span(s), "(6, 4)").toEqual([6, 4])
    expect.soft(normalForm(flipped.doc), "normal form").toEqual([])
  })

  it("copied and pasted, the diagonal lands exactly shifted with its parts", () => {
    const doc = pair()
    const clip = clipOf(doc, new Set(["R1", "R2"]))!
    expect.soft(clip.wires.length, "set up: the diagonal is in the clip").toBe(1)
    const pasted = pastedInto(doc, clip, 0, c(10), (old) => `copy-${old}`, ids)
    expect.soft(geometryOf(pasted.wires), "the original and its copy ten cells lower").toEqual(geometryOf([seg(at(4, 1), at(10, 5)), seg(at(4, 11), at(10, 15))]))
    expect.soft(partition(pasted), "two nets").toEqual([["R1:2", "R2:1"], ["copy-R1:2", "copy-R2:1"]])
    expect.soft(normalForm(pasted), "normal form").toEqual([])
  })
})

describe("the checker at an angle (design.md §6.11 rule 12, §6.8; §13.27)", () => {
  const raw = (objects: PlacedObject[], wires: WireSegment[]): Schematic => ({ objects, wires, parts: {} })
  const findings = (doc: Schematic, kind: string) => checked(doc).filter((f) => f.kind === kind).map((f) => ({ objects: [...f.objects], segments: [...f.segments], fields: f.fields ? [...f.fields] : undefined }))

  it("a wire through a body at an angle, in a document from outside, is found; one past the body's corner is not (guard)", () => {
    const through = seg(at(9, -1), at(11, 3))
    const past = seg(at(7.5, 1), at(9.5, 0))
    const doc = raw([resistor("R2", 8, 0)], [through, past])
    expect(findings(doc, "wire-through-body")).toEqual([{ objects: ["R2"], segments: [through.id], fields: undefined }])
  })

  it("a field over a diagonal is found; a diagonal past the field's box, whose own box overlaps it, is not", () => {
    const over = seg(at(9, 0.5), at(11, -0.5))
    const past = seg(at(9, -1), at(11, 0))
    const doc = raw([resistor("R2", 8, 0)], [over, past])
    expect(findings(doc, "field-on-wire")).toEqual([{ objects: ["R2"], segments: [over.id], fields: ["R2:ref"] }])
  })

  it("the half-cell parallel check stays orthogonal: two parallel diagonals half a cell apart are no finding (taken by default, §6.11 rule 12) (guard)", () => {
    const doc = raw([], [seg(at(0, 0), at(4, 2)), seg(at(0, 0.5), at(4, 2.5))])
    expect(findings(doc, "parallel-too-close")).toEqual([])
  })
})
