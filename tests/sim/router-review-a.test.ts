import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readProjectFile } from "@/project/project-store"
import { examples } from "@/schematic/examples"
import { GRID, type Point } from "@/schematic/geometry"
import { wirePins, wiresAsSegments } from "@/schematic/migrate-wires"
import type { LegacySchematic, LegacyWire, PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { drawEndAt, drawnTo, isRefusal, pointerAt, previewOf, startDrawing } from "@/schematic/wire-draw"
import { inNormalForm, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { junctionsOf, pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import { isRerouteRefusal, rerouted, reroutedRuns, routeBetween, type RouteEnd } from "@/schematic/wires/router"
import { lineCodeOf, WireSheet, type SheetMark } from "@/schematic/wires/sheet"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"
import { bestShape, cells, shapeOf } from "../lib/route-reference"
import { random } from "../lib/wire-reference"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const resistor = (id: string, x: number, y: number, rotation?: Rotation): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
const board = (def: string, x = 0, y = 0): PlacedObject => ({ id: "U1", def, x: c(x), y: c(y), props: { ref: "U1" } })
const pin = (object: string, id: string): RouteEnd => ({ pin: { object, pin: id } })
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic): Wiring => wiringOf(new WireGraph(), doc)
const viewOf = (doc: Schematic) => wireNets(doc.wires, wirePins(doc.objects))
const partition = (doc: Schematic) => pinPartition(viewOf(doc))
const segmentsInCells = (wires: readonly WireSegment[]) => wires.map((s) => JSON.stringify(cells([s.a, s.b].sort((p, q) => p.x - q.x || p.y - q.y)))).sort()
const dots = (doc: Schematic) => junctionsOf(viewOf(doc)).map((p: Point) => [p.x / GRID, p.y / GRID])
const refOf = (key: string) => ({ object: key.slice(0, key.indexOf(":")), pin: key.slice(key.indexOf(":") + 1) })
let fresh = 0
const newId = () => `a${++fresh}`

function comesBack(points: readonly Point[]): Point | null {
  const seen = new Set([`${points[0].x},${points[0].y}`])
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const n = (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) / (GRID / 2)
    for (let k = 1; k <= n; k++) {
      const p = { x: a.x + (Math.sign(b.x - a.x) * k * GRID) / 2, y: a.y + (Math.sign(b.y - a.y) * k * GRID) / 2 }
      if (seen.has(`${p.x},${p.y}`)) return p
      seen.add(`${p.x},${p.y}`)
    }
  }
  return null
}

function drawing(doc: Schematic, from: Point, to: Point) {
  const wiring = wiringFor(doc)
  const started = startDrawing(wiring, drawEndAt(wiring, from))
  if (isRefusal(started)) throw new Error(`the drawing could not start: ${started.refused}`)
  const d = pointerAt(started, to)
  const target = drawEndAt(wiring, to)
  return { preview: previewOf(doc, wiring, d, target), laid: drawnTo(doc, wiring, d, target, newId) }
}

describe("review A, A2: a route never comes back through a point it passed (design.md §7: «never runs past a pin and back»; tests/lib/route-reference.ts: «comes back to a point it passed»)", () => {
  it("RESET → D45, the two sockets of one CN8 row: no lap round a cell and back through RESET's own socket", () => {
    const doc = docOf([board("nucleo-f429zi")])
    const route = routeBetween(doc, pin("U1", "CN8-5"), pin("U1", "CN8-6"))
    expect.soft(route && comesBack(route), `no point twice: ${JSON.stringify(cells(route))}`).toBeNull()
  })

  it("drawing RESET → D45 lays the one-cell wire between the two sockets, with no loop and no dot on the two-pin net", () => {
    const { preview, laid } = drawing(docOf([board("nucleo-f429zi")]), at(5, 19), at(6, 19))
    expect.soft(cells(preview.points), "the preview: the plain one-cell wire").toEqual([
      [5, 19],
      [6, 19],
    ])
    if (isRefusal(laid)) throw new Error(`refused: ${laid.refused}`)
    expect.soft(segmentsInCells(laid.wires), "the click lays that one segment").toEqual(["[[5,19],[6,19]]"])
    expect.soft(dots(laid), "no dot on a two-pin net").toEqual([])
    expect.soft(partition(laid), "RESET and D45 joined, nothing else").toEqual([["U1:CN8-5", "U1:CN8-6"]])
  })

  it("T on that one-cell jumper never turns it into a loop", () => {
    const doc = docOf([board("nucleo-f429zi")], [{ id: "j", a: at(5, 19), b: at(6, 19) }])
    const result = rerouted(doc, "j", newId)
    const after = isRerouteRefusal(result) ? doc : result
    expect.soft(dots(after), "no dot").toEqual([])
    expect.soft(segmentsInCells(after.wires), "the jumper as it was").toEqual(["[[5,19],[6,19]]"])
  })

})

describe("review A, A5: the router keeps §7's cost order however far the cheaper route lies (design.md §7: «never takes a lap … when a route with fewer bends exists»; §13.22: «a crossing weighs more than one bend and less than two»)", () => {
  it("R1 → R3's top pin past a rail of another net: the router's crossings, bends and length equal the reference's whatever the rail's length", () => {
    const misses: string[] = []
    for (let top = -3; top >= -8; top--) {
      const doc = docOf([resistor("R1", 0, 0), resistor("R3", 9, 5, 90)], [{ id: "rail", a: at(7, top), b: at(7, 6) }])
      const route = routeBetween(doc, pin("R1", "2"), pin("R3", "1"))
      const want = bestShape(doc, at(4, 1), at(10, 5))!
      const got = route && shapeOf(doc, route)
      if (!got || got.faults.length || got.crossings !== want.crossings || got.bends !== want.bends || got.length !== want.length)
        misses.push(`rail from y = ${top}: ${got ? `${got.crossings}/${got.bends}/${got.length}` : "no route"} where the reference finds ${want.crossings}/${want.bends}/${want.length}: ${JSON.stringify(cells(route))}`)
    }
    expect.soft(misses, "the cost order holds at every rail length").toEqual([])
  })
})

describe("review A, A4: the freeze routes round another net's junction instead of falling to the half-cell search (design.md §13.22, question 2 A: «the router first, … today's half-cell search only as the last resort»)", () => {
  const hub: PlacedObject = { id: "J1", def: "junction", x: c(7), y: c(0) }
  const wire = (id: string, from: [string, string], to: [string, string]): LegacyWire => ({ id, from: { object: from[0], pin: from[1] }, to: { object: to[0], pin: to[1] } })
  const objects = [resistor("R1", 0, 0), resistor("R2", 12, 0), resistor("R3", 7, -6, 90), resistor("R4", 7, 4, 90), hub]
  const m = wire("m", ["R1", "2"], ["R2", "1"])
  const n1 = wire("n1", ["R3", "2"], ["J1", "J"])
  const n2 = wire("n2", ["R4", "1"], ["J1", "J"])
  const frozen = (wires: LegacyWire[]) => {
    let i = 0
    return wiresAsSegments({ objects, wires, parts: {} } satisfies LegacySchematic, () => `z${i++}`)
  }

  it("R1 → R2 across a junction of another net: laid by the router round the junction, with no note, whichever wire the file lists first", () => {
    const mFirst = frozen([m, n1, n2])
    const nFirst = frozen([n1, n2, m])
    expect.soft(mFirst.notes, "M first: nothing was laid again").toEqual([])
    expect.soft(nFirst.notes, "N first: nothing was laid again").toEqual([])
    expect.soft(cells(mFirst.routes.get("m")), "M first: round the junction on the next row").toEqual([
      [4, 1],
      [4, 0],
      [12, 0],
      [12, 1],
    ])
    expect.soft(cells(nFirst.routes.get("m")), "N first: N's wires end on the junction, so M may not pass it; of the clean ways the cheapest by design.md §7 at any distance, two bends round R3, before two bends and a crossing of N on the next row").toEqual([
      [4, 1],
      [4, -7],
      [12, -7],
      [12, 1],
    ])
    for (const [order, frozenDoc] of [["M first", mFirst], ["N first", nFirst]] as const)
      expect.soft(partition(frozenDoc.doc), `${order}: two nets`).toEqual([
        ["R1:2", "R2:1"],
        ["R3:2", "R4:1"],
      ])
  })
})

function cycles(wires: readonly WireSegment[]): number {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    while (parent.get(k) !== k) k = parent.get(k)!
    return k
  }
  let n = 0
  for (const s of wires) {
    const ends = [`${s.a.x},${s.a.y}`, `${s.b.x},${s.b.y}`]
    for (const k of ends) if (!parent.has(k)) parent.set(k, k)
    const [ra, rb] = ends.map(find)
    if (ra === rb) n++
    else parent.set(ra, rb)
  }
  return n
}

function twoPinDots(doc: Schematic): number[][] {
  const view = viewOf(doc)
  return junctionsOf(view)
    .filter((p: Point) => {
      const s = doc.wires.find((w) => (w.a.x === p.x && w.a.y === p.y) || (w.b.x === p.x && w.b.y === p.y))
      const net = s && view.netOfSegment(s.id)
      return !!net && view.pinsOf(net).length === 2
    })
    .map((p: Point) => [p.x / GRID, p.y / GRID])
}

describe("review A, A3: a wire frozen through its bends never runs an earlier leg over a later bend (design.md §13.22: «through each wire's saved bends»; §7: no detour the user did not draw)", () => {
  it("R1 → R2 saved with the bends (9, 1) then (9, 7), frozen from R1: through both bends with no loop and no dot on the two-pin net", () => {
    const legacy: LegacySchematic = {
      objects: [resistor("R1", 0, 0), resistor("R2", 12, 5, 90)],
      wires: [{ id: "w", from: { object: "R2", pin: "1" }, to: { object: "R1", pin: "2" }, points: [at(9, 1), at(9, 7)] }],
      parts: {},
    }
    let i = 0
    const { doc, notes } = wiresAsSegments(legacy, () => `z${i++}`)
    expect.soft(twoPinDots(doc), "no dot on the two-pin net").toEqual([])
    expect.soft(cycles(doc.wires), "no loop").toBe(0)
    expect.soft(notes, "the bends kept, nothing to say").toEqual([])
    const corners = new Set(doc.wires.flatMap((s) => [s.a, s.b]).map((p) => `${p.x / GRID},${p.y / GRID}`))
    expect.soft([corners.has("9,1"), corners.has("9,7")], "through both saved bends").toEqual([true, true])
  })

  it("the brigade's lab 2 file (tests/data/emul-1.28.0/lab2-rgb-pwm.emul): R3's wire to P4-5 opens with no loop and no dot", async () => {
    const read = await readProjectFile(new Blob([readFileSync(join(import.meta.dirname, "../data/emul-1.28.0/lab2-rgb-pwm.emul"))]))
    if (!read) throw new Error("the file does not read")
    expect.soft(twoPinDots(read.doc), "no dot on a two-pin net").toEqual([])
    expect.soft(cycles(read.doc.wires), "no loop anywhere").toBe(0)
  })
})

function drawnOn(doc: Schematic, from: Point, to: Point): Schematic {
  const wiring = wiringFor(doc)
  const started = startDrawing(wiring, drawEndAt(wiring, from))
  if (isRefusal(started)) throw new Error(`the drawing could not start: ${started.refused}`)
  const result = drawnTo(doc, wiring, pointerAt(started, to), drawEndAt(wiring, to), newId)
  if (isRefusal(result)) throw new Error(`refused: ${result.refused} at (${result.at.x / GRID}, ${result.at.y / GRID})`)
  return result
}

describe("review A, A1: the half-cell slip is not lost when the names column carries another wire (design.md §4.5, §13.5, §13.9; junctions.md 34–35)", () => {
  const fan = () => [
    { id: "f1", a: at(5, 17), b: at(3, 17) },
    { id: "f2", a: at(3, 17), b: at(3, 26) },
    { id: "f3", a: at(3, 26), b: at(-2, 26) },
  ]
  const scene = (wires: WireSegment[] = []) => docOf([board("nucleo-f429zi"), resistor("R1", -6, 18), resistor("R4", -12, 19), resistor("R9", -6, 25)], [...fan(), ...wires])
  const nets = [
    ["R1:2", "U1:CN8-5"],
    ["R4:2", "U1:CN8-6"],
    ["R9:2", "U1:CN8-1"],
  ]

  it("CN8-1's wire turns on the names column and runs down it past RESET and D45; with RESET wired, D45 still reaches R4 on a slip", () => {
    const doc = scene([{ id: "reset", a: at(5, 19), b: at(-2, 19) }])
    const route = routeBetween(doc, pin("U1", "CN8-6"), pin("R4", "2"))
    expect.soft(route, "D45 has a way out").not.toBeNull()
    if (!route) return
    const after = inNormalForm({ ...doc, wires: [...doc.wires, ...route.slice(1).map((b, i) => ({ id: `d${i}`, a: route[i], b }))] })
    expect.soft(partition(after), "three nets, D45's crossing CN8-1's wire joins nothing").toEqual(nets)
  })

  it("the row taken after the fact: RESET wired while D45's wire passes it is not refused, and gives the picture of RESET first", () => {
    const tried = (doc: Schematic | string, from: Point, to: Point): Schematic | string => {
      if (typeof doc === "string") return doc
      try {
        return drawnOn(doc, from, to)
      } catch (e) {
        return String(e)
      }
    }
    const resetAfter = tried(tried(scene(), at(6, 19), at(-8, 20)), at(-2, 19), at(5, 19))
    const resetFirst = tried(tried(scene(), at(-2, 19), at(5, 19)), at(6, 19), at(-8, 20))
    expect.soft(typeof resetAfter === "string" ? resetAfter : partition(resetAfter), "D45 then RESET: laid, three nets").toEqual(nets)
    expect.soft(typeof resetFirst === "string" ? resetFirst : partition(resetFirst), "RESET then D45: laid, three nets").toEqual(nets)
    if (typeof resetAfter !== "string" && typeof resetFirst !== "string") expect.soft(segmentsInCells(resetAfter.wires), "one picture whichever was drawn first").toEqual(segmentsInCells(resetFirst.wires))
  })
})

const points = (list: readonly Point[]) => list.map((p) => `${p.x},${p.y}`).sort()

function shape(w: Wiring) {
  const groupsOf = (entries: Iterable<readonly [string, string]>) => {
    const groups = new Map<string, string[]>()
    for (const [key, root] of entries) groups.set(root, [...(groups.get(root) ?? []), key])
    return [...groups.values()].map((g) => g.sort().join(" ")).sort()
  }
  return {
    runs: w.runs.map((r) => `${r.id}: ${r.points.map((p) => `${p.x},${p.y}`).join(" ")} [${r.segments.map((s) => s.id).join(" ")}]`),
    bySegment: [...w.runBySegment].map(([id, run]) => `${id}>${run.id}`).sort(),
    nets: w.nets.nets.map((net) => [...w.nets.wiresOf(net)].sort().join(" ")).sort(),
    contacts: groupsOf(w.nets.contacts),
    dots: points(w.dots),
    dangling: points(w.dangling),
  }
}

function sheetShape(sheet: WireSheet, wires: readonly WireSegment[], pins: readonly WirePin[]) {
  const ids = (list: readonly WireSegment[]) => list.map((s) => s.id).sort().join(" ")
  const marks = (list: readonly SheetMark[]) => list.map((m) => `${m.at.x},${m.at.y}:${m.segment?.id ?? m.pin!.key}`).sort().join(" ")
  const out: string[] = []
  for (const s of wires) {
    const line = lineCodeOf(s)
    out.push(`${s.id} a[${ids(sheet.endsAt(s.a))}] b[${ids(sheet.endsAt(s.b))}] along[${ids(sheet.along(line, -1e9, 1e9))}] marks[${marks(sheet.marks(line, -1e9, 1e9))}]`)
  }
  for (const p of pins) out.push(`${p.key} at[${sheet.pinsAt(p.at).map((q) => q.key).sort().join(" ")}] through[${ids(sheet.through(p.at))}]`)
  return out.sort()
}

describe("review A, item 5: the kept field after phase 6's own edits equals a fresh one (design.md §11; plan.md phase 5's kept-against-fresh rule)", () => {
  it.each(["nucleo-serial", "power-supply", "lab1-f746"])("%s: random completions, rows taken after the fact and re-routes keep the wiring, the sheet and the next routes equal to fresh ones", (id) => {
    const rng = random(id.length * 7121)
    let doc: Schematic = { ...examples.find((e) => e.id === id)!.build(GRID) }
    const graph = new WireGraph()
    let known = wiringOf(graph, doc)
    let n = 0
    const next = () => `k${n++}`
    let edits = 0
    for (let step = 0; step < 24; step++) {
      const pins = wirePins(doc.objects)
      if (rng.chance(0.5) || !doc.wires.length) {
        const a = rng.pick(pins)
        const b = rng.pick(pins)
        if (a.key === b.key) continue
        const started = startDrawing(known, drawEndAt(known, a.at))
        if (isRefusal(started)) continue
        const result = drawnTo(doc, known, pointerAt(started, b.at), drawEndAt(known, b.at), next)
        if (isRefusal(result)) continue
        doc = result
      } else {
        const result = reroutedRuns(doc, [rng.pick(doc.wires).id, rng.pick(doc.wires).id], next, known)
        if (result.doc === doc) continue
        doc = result.doc
      }
      edits++
      known = wiringOf(graph, doc)
      const freshWiring = wiringOf(new WireGraph(), doc)
      expect.soft(shape(known), `${id} step ${step}: the wiring`).toEqual(shape(freshWiring))
      expect.soft(sheetShape(known.sheet, doc.wires, known.pins), `${id} step ${step}: the sheet`).toEqual(sheetShape(WireSheet.of(doc.wires, known.pins), doc.wires, known.pins))
      for (let k = 0; k < 3; k++) {
        const a = rng.pick(pins)
        const b = rng.pick(pins)
        expect.soft(cells(routeBetween(doc, { pin: refOf(a.key) }, { pin: refOf(b.key) }, known)), `${id} step ${step}: ${a.key} → ${b.key}`).toEqual(cells(routeBetween(doc, { pin: refOf(a.key) }, { pin: refOf(b.key) })))
      }
    }
    expect.soft(edits, `${id}: some edits were laid`).toBeGreaterThan(4)
  })
})
