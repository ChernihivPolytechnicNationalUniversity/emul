import { describe, expect, it } from "vitest"
import { checked } from "@/schematic/checker"
import { dragConflictMarks } from "@/schematic/conflict-marks"
import { diagonalSquare, GRID, objectPins, type Point } from "@/schematic/geometry"
import { wirePins } from "@/schematic/migrate-wires"
import { freeSpot, placementClashes, wireCheck, type PlacementScene } from "@/schematic/placement"
import { allDefs } from "@/schematic/registry"
import { PartDrag } from "@/schematic/rubber-band"
import type { PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { inNormalForm, placedObject, wiringOf } from "@/schematic/wire-edits"
import { junctionsOf, pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { diagonalNormalFormViolations } from "../lib/diagonal-reference"
import { counter, geometryOf, sortedPoints } from "../lib/wire-reference"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const plus = (p: Point, q: Point): Point => ({ x: p.x + q.x, y: p.y + q.y })
const times = (p: Point, k: number): Point => ({ x: p.x * k, y: p.y * k })
const shown = (p: Point) => `(${p.x / GRID}, ${p.y / GRID})`
const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
let serial = 0
const seg = (a: Point, b: Point): WireSegment => ({ id: `s${++serial}`, a, b })
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const viewOf = (doc: Schematic) => wireNets(doc.wires, wirePins(doc.objects))
const nets = (doc: Schematic) => pinPartition(viewOf(doc)).map((g) => [...g].sort()).sort((p, q) => p[0].localeCompare(q[0]))
const sortedNets = (groups: string[][]) => groups.map((g) => [...g].sort()).sort((p, q) => p[0].localeCompare(q[0]))
const normalForm = (doc: Schematic) => diagonalNormalFormViolations(doc.wires, wirePins(doc.objects))
const throughBodies = (doc: Schematic) => checked(doc).filter((f) => f.kind === "wire-through-body")
const newId = counter("d")

type Orientation = { readonly rotation: Rotation; readonly mirror: boolean }
const DIAGONAL_ORIENTATIONS: readonly Orientation[] = ([45, 135, 225, 315] as const).flatMap((rotation) => [false, true].map((mirror) => ({ rotation, mirror })))
const named = (o: Orientation) => `${o.rotation}°${o.mirror ? " mirrored" : ""}`

const diagonalParts = allDefs().filter((def) => diagonalSquare(def) !== null)

type Side = { readonly name: string; readonly from: Point; readonly to: Point; readonly fromPin: string; readonly toPin: string }

const DIAMOND_WIRES: readonly Side[] = [
  { name: "south-east, R1 → R2", from: at(14, 1), to: at(22, 9), fromPin: "R1:2", toPin: "R2:1" },
  { name: "south-west, R2 → R4", from: at(22, 13), to: at(14, 21), fromPin: "R2:2", toPin: "R4:2" },
  { name: "north-west, R4 → R5", from: at(10, 21), to: at(2, 13), fromPin: "R4:1", toPin: "R5:2" },
  { name: "north-east, R5 → R1", from: at(2, 9), to: at(10, 1), fromPin: "R5:1", toPin: "R1:1" },
]

const diamondParts = () => [resistor("R1", 10, 0), resistor("R2", 21, 9, 90), resistor("R4", 10, 20), resistor("R5", 1, 9, 90)]

const diamondNets = () => DIAMOND_WIRES.map((w) => [w.fromPin, w.toPin])

const stepOf = (w: Side): Point => ({ x: Math.sign(w.to.x - w.from.x) * GRID, y: Math.sign(w.to.y - w.from.y) * GRID })

const FAR = at(40, 40)

function partAt(id: string, def: string, o: Orientation, pinsAt: readonly [Point, Point], away = FAR): PlacedObject {
  const corner = { x: Math.min(pinsAt[0].x, pinsAt[1].x), y: Math.min(pinsAt[0].y, pinsAt[1].y) }
  return { id, def, x: corner.x + away.x, y: corner.y + away.y, rotation: o.rotation, mirror: o.mirror, props: { ref: id } }
}

function pinsOf(object: PlacedObject) {
  return objectPins(object, GRID).map((p) => ({ key: `${object.id}:${p.pin.id}`, at: p.point }))
}

const parallel = (o: Orientation, def: string, w: Side) => {
  const [p, q] = pinsOf({ id: "X", def, x: 0, y: 0, rotation: o.rotation, mirror: o.mirror })
  const d = { x: q.at.x - p.at.x, y: q.at.y - p.at.y }
  return d.x * (w.to.y - w.from.y) - d.y * (w.to.x - w.from.x) === 0
}

const alongOf = (def: string, w: Side) => DIAGONAL_ORIENTATIONS.filter((o) => parallel(o, def, w))
const acrossOf = (def: string, w: Side) => DIAGONAL_ORIENTATIONS.filter((o) => !parallel(o, def, w))

function sceneOf(doc: Schematic): PlacementScene {
  return { objects: doc.objects, routes: doc.wires.map((s) => ({ id: s.id, pts: [s.a, s.b], owner: [] })), grid: GRID }
}

type Drop = { doc: Schematic; dragged: PlacedObject; dx: number; dy: number }

function dropOnto(doc: Schematic, part: PlacedObject, away = FAR): Drop {
  return { doc: docOf([...doc.objects, part], doc.wires), dragged: part, dx: -away.x, dy: -away.y }
}

function judge({ doc, dragged, dx, dy }: Drop) {
  const drag = new PartDrag(doc, wiringOf(new WireGraph(), doc), { objects: new Set([dragged.id]) })
  const clashes = placementClashes(sceneOf(doc), [dragged])(dx, dy)
  const frame = drag.frame(dx, dy)
  return {
    glows: clashes.size > 0 || drag.blocked(dx, dy),
    marked: [...dragConflictMarks(frame, clashes, GRID).parts],
    landed: drag.landed(dx, dy, newId),
  }
}

function expectCutIn(name: string, drop: Drop, w: Side, cutFrom: Point, cutTo: Point, otherWires: readonly WireSegment[], otherNets: string[][]) {
  const { glows, marked, landed } = judge(drop)
  const pins = pinsOf({ ...drop.dragged, x: drop.dragged.x + drop.dx, y: drop.dragged.y + drop.dy })
  const pinAt = (p: Point) => pins.find((q) => q.at.x === p.x && q.at.y === p.y)?.key ?? `no pin at ${shown(p)}`
  expect.soft(glows, `${name}: no conflict glow while held over the wire`).toBe(false)
  expect.soft(marked, `${name}: nothing marked`).toEqual([])
  expect.soft(landed.at, `${name}: lands where it was let go`).toEqual({ x: drop.dx, y: drop.dy })
  expect.soft(geometryOf(landed.doc.wires), `${name}: the wire cut between ${shown(cutFrom)} and ${shown(cutTo)}, the rest untouched`).toEqual(geometryOf([seg(w.from, cutFrom), seg(cutTo, w.to), ...otherWires]))
  expect.soft(nets(landed.doc), `${name}: in series between ${w.fromPin} and ${w.toPin}`).toEqual(sortedNets([[w.fromPin, pinAt(cutFrom)], [w.toPin, pinAt(cutTo)], ...otherNets]))
  expect.soft(sortedPoints(junctionsOf(viewOf(landed.doc))), `${name}: a pin and one end at each cut, no dot`).toEqual([])
  expect.soft(normalForm(landed.doc), `${name}: normal form`).toEqual([])
  expect.soft(throughBodies(landed.doc), `${name}: no wire left through a body`).toEqual([])
}

function expectRefused(name: string, drop: Drop, wiresBefore: readonly WireSegment[] | null) {
  const { glows, landed } = judge(drop)
  expect.soft(glows, `${name}: the conflict glow lights`).toBe(true)
  expect.soft(landed.at.x === drop.dx && landed.at.y === drop.dy, `${name}: not left where it was let go`).toBe(false)
  if (wiresBefore) expect.soft(geometryOf(landed.doc.wires), `${name}: the wires as they were`).toEqual(geometryOf(wiresBefore))
  expect.soft(throughBodies(landed.doc), `${name}: no wire through a body where it landed`).toEqual([])
}

const anchor = () => resistor("R9", -30, -30)

const diamond = () => docOf(diamondParts(), DIAMOND_WIRES.map((w) => seg(w.from, w.to)))

describe("a part on its diagonal dropped onto a diagonal wire is cut into it (the user, 2026-11-13: «если я соединю резисторы диагональными проводами и захочу потом вот так резистор подкинуть, нихуя не получиться»; design.md §5.3 and §6.11: the splice at any angle the wires take)", () => {
  it("the user's diamond: R3 at 45° dropped onto the R1–R2 diagonal with its pins on two of the wire's lattice points goes in series, the stretch between its pins gone", () => {
    const w = DIAMOND_WIRES[0]
    const u = stepOf(w)
    const cutFrom = plus(w.from, times(u, 2))
    const cutTo = plus(w.from, times(u, 5))
    const r3 = partAt("R3", "resistor", { rotation: 45, mirror: false }, [cutFrom, cutTo])
    expectCutIn("R3 on R1–R2", dropOnto(diamond(), r3), w, cutFrom, cutTo, DIAMOND_WIRES.slice(1).map((s) => seg(s.from, s.to)), diamondNets().slice(1))
  })

  it("on all four sides of the diamond, in every orientation that lays the resistor along the side, at every spot where its pins fit on the side", () => {
    for (const [i, w] of DIAMOND_WIRES.entries()) {
      const u = stepOf(w)
      const others = DIAMOND_WIRES.filter((_, k) => k !== i)
      for (const o of alongOf("resistor", w))
        for (const start of [0, 1, 2, 3, 4, 5]) {
          const cutFrom = plus(w.from, times(u, start))
          const cutTo = plus(w.from, times(u, start + 3))
          const name = `${w.name}, ${named(o)}, pins at ${shown(cutFrom)}–${shown(cutTo)}`
          const r3 = partAt("R3", "resistor", o, [cutFrom, cutTo])
          const wires = others.map((s) => seg(s.from, s.to))
          if (start === 0 || start === 5) {
            const { glows, landed } = judge(dropOnto(diamond(), r3))
            expect.soft(glows, `${name}: no glow`).toBe(false)
            expect.soft(nets(landed.doc), `${name}: in series, butted to the end resistor`).toEqual(sortedNets([[w.fromPin, pinsOf({ ...r3, x: r3.x - FAR.x, y: r3.y - FAR.y }).find((p) => p.at.x === cutFrom.x && p.at.y === cutFrom.y)!.key], [w.toPin, pinsOf({ ...r3, x: r3.x - FAR.x, y: r3.y - FAR.y }).find((p) => p.at.x === cutTo.x && p.at.y === cutTo.y)!.key], ...others.map((s) => [s.fromPin, s.toPin])]))
            expect.soft(geometryOf(landed.doc.wires), `${name}: one stretch left`).toEqual(geometryOf([...(start === 0 ? [] : [seg(w.from, cutFrom)]), ...(start === 5 ? [] : [seg(cutTo, w.to)]), ...wires]))
            expect.soft(normalForm(landed.doc), `${name}: normal form`).toEqual([])
            continue
          }
          expectCutIn(name, dropOnto(diamond(), r3), w, cutFrom, cutTo, wires, others.map((s) => [s.fromPin, s.toPin]))
        }
    }
  })

  it(`every one of the ${diagonalParts.length} two-terminal parts that stands on a diagonal is cut into each of the four sides, in each orientation along it`, () => {
    expect.soft(diagonalParts.length, "the parts of the pin-lattice row").toBe(17)
    for (const def of diagonalParts)
      for (const [i, w] of DIAMOND_WIRES.entries()) {
        const u = stepOf(w)
        const others = DIAMOND_WIRES.filter((_, k) => k !== i)
        const cutFrom = plus(w.from, times(u, 2))
        const cutTo = plus(w.from, times(u, 5))
        const along = alongOf(def.id, w)
        expect.soft(along.length, `${def.id}: four orientations lie along ${w.name}`).toBe(4)
        for (const o of along) expectCutIn(`${def.id} ${named(o)} on ${w.name}`, dropOnto(diamond(), partAt("X3", def.id, o, [cutFrom, cutTo])), w, cutFrom, cutTo, others.map((s) => seg(s.from, s.to)), others.map((s) => [s.fromPin, s.toPin]))
      }
  })

  it("added straight onto the diagonal (the palette's and the menu's path, placedObject), the part is cut in the same way and the placement check lets it stay", () => {
    for (const [i, w] of DIAMOND_WIRES.entries()) {
      const u = stepOf(w)
      const cutFrom = plus(w.from, times(u, 2))
      const cutTo = plus(w.from, times(u, 5))
      const others = DIAMOND_WIRES.filter((_, k) => k !== i)
      for (const o of alongOf("resistor", w)) {
        const name = `${w.name}, ${named(o)}`
        const r3 = partAt("R3", "resistor", o, [cutFrom, cutTo], { x: 0, y: 0 })
        const doc = diamond()
        expect.soft(wireCheck(sceneOf(doc), [r3])(0, 0), `${name}: the add does not look for another spot`).toBe(false)
        const added = placedObject(doc, r3, newId)
        const pins = pinsOf(r3)
        const pinAt = (p: Point) => pins.find((q) => q.at.x === p.x && q.at.y === p.y)!.key
        expect.soft(geometryOf(added.wires), `${name}: cut under R3`).toEqual(geometryOf([seg(w.from, cutFrom), seg(cutTo, w.to), ...others.map((s) => seg(s.from, s.to))]))
        expect.soft(nets(added), `${name}: in series`).toEqual(sortedNets([[w.fromPin, pinAt(cutFrom)], [w.toPin, pinAt(cutTo)], ...others.map((s) => [s.fromPin, s.toPin])]))
        expect.soft(normalForm(added), `${name}: normal form`).toEqual([])
      }
    }
  })

  it("added onto a diagonal stretch that a branch or another part's pin meets between its pins, the part is not cut in and not left lying on the wire: the add looks elsewhere and the stretch stays as drawn (the body rule, the user 2026-11-11)", () => {
    const w = DIAMOND_WIRES[0]
    const r3 = partAt("R3", "resistor", { rotation: 45, mirror: false }, [at(16, 3), at(19, 6)], { x: 0, y: 0 })
    const sides = DIAMOND_WIRES.slice(1).map((s) => seg(s.from, s.to))
    for (const [name, extra, wires] of [
      ["a branch from (17, 4)", [], [seg(w.from, w.to), seg(at(17, 4), at(17, 10))]],
      ["R6's pin on (17, 4)", [resistor("R6", 16, 4, 90)], [seg(w.from, w.to)]],
      ["a gap from (17, 4) to (18, 5)", [], [seg(w.from, at(17, 4)), seg(at(18, 5), w.to)]],
    ] as const) {
      const doc = docOf([...diamondParts(), ...extra], [...sides, ...wires])
      const spot = freeSpot(sceneOf(doc), [r3])
      expect.soft(spot.x !== 0 || spot.y !== 0, `${name}: the add looks for another spot`).toBe(true)
      const added = placedObject(doc, r3, newId)
      expect.soft(added.objects.some((o) => o.id === "R3"), `${name}: R3 is not put down across the wire`).toBe(false)
      expect.soft(geometryOf(added.wires), `${name}: the wires as they were drawn`).toEqual(geometryOf(doc.wires))
      expect.soft(checked(added).filter((f) => f.kind === "wire-through-body"), `${name}: no wire under a body`).toEqual([])
      expect.soft(normalForm(added), `${name}: normal form`).toEqual([])
    }
  })

  it("Alt splices on a diagonal as on a straight wire: the part's own wires stay behind and it is cut into the diagonal it lands on (the user, 2026-11-17)", () => {
    const w = DIAMOND_WIRES[0]
    const u = stepOf(w)
    const r3 = partAt("R3", "resistor", { rotation: 45, mirror: false }, [plus(w.from, times(u, 2)), plus(w.from, times(u, 5))])
    const drop = dropOnto(diamond(), r3)
    const landed = new PartDrag(drop.doc, wiringOf(new WireGraph(), drop.doc), { objects: new Set(["R3"]) }, { detach: true }).landed(drop.dx, drop.dy, newId)
    expect.soft(landed.refused, "nothing refused").toBeUndefined()
    expect.soft(nets(landed.doc).find((g) => g.includes("R1:2")), "R3 now in series on the R1–R2 diagonal").toEqual(["R1:2", "R3:1"])
  })
})

describe("a drop onto a diagonal wire that does not fit keeps the refusal and the glow", () => {
  it("across the wire: on the other diagonal, centred on it, its pins off the wire", () => {
    const w = DIAMOND_WIRES[0]
    const u = stepOf(w)
    for (const o of acrossOf("resistor", w)) {
      const r3 = partAt("R3", "resistor", o, [plus(w.from, times(u, 2)), plus(w.from, times(u, 5))])
      const mid = { x: r3.x - FAR.x + c(1.5), y: r3.y - FAR.y + c(1.5) }
      expect.soft((mid.x - w.from.x) * (w.to.y - w.from.y) - (mid.y - w.from.y) * (w.to.x - w.from.x), `${named(o)}: its middle on the wire`).toBe(0)
      expectRefused(`across, ${named(o)}`, dropOnto(diamond(), r3), diamond().wires)
    }
  })

  it("every diagonal part lying across a side of the diamond is refused", () => {
    for (const def of diagonalParts)
      for (const w of DIAMOND_WIRES) {
        const u = stepOf(w)
        for (const o of acrossOf(def.id, w)) expectRefused(`${def.id} ${named(o)} across ${w.name}`, dropOnto(diamond(), partAt("X3", def.id, o, [plus(w.from, times(u, 2)), plus(w.from, times(u, 5))])), diamond().wires)
      }
  })

  it("one pin on the wire, the other past its open end: the end would be left inside the body", () => {
    const wires = [seg(at(14, 1), at(18, 5))]
    const doc = docOf([resistor("R1", 10, 0)], wires)
    for (const o of alongOf("resistor", DIAMOND_WIRES[0])) expectRefused(`past the end, ${named(o)}`, dropOnto(doc, partAt("R3", "resistor", o, [at(16, 3), at(19, 6)])), wires)
  })

  it("a branch leaves the diagonal between the two pins: not cut, as on a straight wire", () => {
    const branch = seg(at(17, 4), at(17, 10))
    const doc = docOf([...diamondParts(), resistor("R6", 16, 10, 90)], [...DIAMOND_WIRES.map((w) => seg(w.from, w.to)), branch])
    for (const o of alongOf("resistor", DIAMOND_WIRES[0])) expectRefused(`branch inside, ${named(o)}`, dropOnto(doc, partAt("R3", "resistor", o, [at(16, 3), at(19, 6)])), doc.wires)
  })

  it("a branch meets the wire beside a lead, between a pin and the body, and runs away clear of the body: still not cut, on a diagonal as on a straight wire", () => {
    const half = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
    for (const branch of [seg(half(16.5, 3.5), half(16.5, -3)), seg(half(18.5, 5.5), half(27, 5.5))]) {
      const doc = docOf(diamondParts(), [...DIAMOND_WIRES.map((w) => seg(w.from, w.to)), branch])
      for (const o of alongOf("resistor", DIAMOND_WIRES[0])) expectRefused(`branch from ${shown(branch.a)}, ${named(o)}`, dropOnto(doc, partAt("R3", "resistor", o, [at(16, 3), at(19, 6)])), doc.wires)
    }
    const straight = docOf([resistor("R1", 0, 0), resistor("R2", 16, 0)], [seg(at(4, 1), at(16, 1)), seg(half(6.5, 1), half(6.5, -4))])
    expectRefused("straight wire, branch beside the lead", dropOnto(straight, resistor("R3", 6 + 40, 40)), straight.wires)
  })

  it("the pins beside the wire, off its lattice: a diagonal on the half cell runs through the body", () => {
    const wires = [seg({ x: c(14.5), y: c(1) }, { x: c(22.5), y: c(9) })]
    const doc = docOf([anchor()], wires)
    for (const o of alongOf("resistor", DIAMOND_WIRES[0])) expectRefused(`half a cell off, ${named(o)}`, dropOnto(doc, partAt("R3", "resistor", o, [at(16, 3), at(19, 6)])), wires)
  })

  it("an orthogonal part with one pin on a diagonal and its body across it is refused", () => {
    const wires = [seg(at(10, 10), at(20, 0))]
    const doc = docOf([anchor()], wires)
    expectRefused("upright over the diagonal", dropOnto(doc, { ...resistor("R3", 14, 4, 90), x: c(14) + FAR.x, y: c(4) + FAR.y }), null)
  })
})

describe("multi-pin parts on diagonal wires: what a straight wire accepts, a diagonal one does", () => {
  const npnWithBaseAt = (p: Point): PlacedObject => ({ id: "Q1", def: "npn", x: p.x + FAR.x, y: p.y - c(2) + FAR.y, props: { ref: "Q1" } })

  it("a transistor's base dropped on a lattice point inside a wire that passes clear of its body taps it: split at the pin, a dot, the wire kept", () => {
    const base = at(15, 5)
    for (const [name, from, to] of [
      ["vertical", at(15, 0), at(15, 10)],
      ["horizontal", at(10, 5), at(20, 5)],
      ["diagonal /", at(20, 0), at(10, 10)],
      ["diagonal \\", at(10, 0), at(20, 10)],
    ] as const) {
      const wires = [seg(from, to)]
      const drop = dropOnto(docOf([anchor()], wires), npnWithBaseAt(base))
      if (name === "horizontal") {
        expectRefused("horizontal, through the body", drop, null)
        continue
      }
      const { glows, landed } = judge(drop)
      expect.soft(glows, `${name}: no glow`).toBe(false)
      expect.soft(landed.at, `${name}: lands where it was let go`).toEqual({ x: drop.dx, y: drop.dy })
      expect.soft(geometryOf(landed.doc.wires), `${name}: split at the base`).toEqual(geometryOf([seg(from, base), seg(base, to)]))
      expect.soft(sortedPoints(junctionsOf(viewOf(landed.doc))), `${name}: a dot at the base`).toEqual([base])
      expect.soft(viewOf(landed.doc).netOfPin("Q1:B"), `${name}: the base on the wire's net`).toBeDefined()
      expect.soft(normalForm(landed.doc), `${name}: normal form`).toEqual([])
    }
  })

  it("a transistor's base dropped on a diagonal wire's open end joins it, no dot", () => {
    const base = at(15, 5)
    for (const from of [at(10, 0), at(20, 0), at(10, 10), at(20, 10)]) {
      const wires = [seg(from, base)]
      const { glows, landed } = judge(dropOnto(docOf([anchor()], wires), npnWithBaseAt(base)))
      expect.soft(glows, `from ${shown(from)}: no glow`).toBe(false)
      expect.soft(geometryOf(landed.doc.wires), `from ${shown(from)}: the wire as it was`).toEqual(geometryOf(wires))
      expect.soft(sortedPoints(junctionsOf(viewOf(landed.doc))), `from ${shown(from)}: no dot`).toEqual([])
      expect.soft(throughBodies(landed.doc), `from ${shown(from)}: nothing through the body`).toEqual([])
    }
  })
})
