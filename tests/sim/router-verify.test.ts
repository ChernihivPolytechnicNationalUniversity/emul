import { describe, expect, it } from "vitest"
import { bodiesOf } from "@/schematic/body-crossing"
import { checked } from "@/schematic/checker"
import { GRID, type Point } from "@/schematic/geometry"
import { wirePins, wiresAsSegments } from "@/schematic/migrate-wires"
import { placementCheck } from "@/schematic/placement"
import { SegmentDrag } from "@/schematic/rubber-band"
import type { LegacySchematic, LegacyWire, PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { DRAW_REFUSED, drawEndAt, drawnTo, isRefusal, pointerAt, previewOf, startDrawing, withCorner, withLineMode, type Drawing, type LineMode } from "@/schematic/wire-draw"
import { carriedSelection } from "@/schematic/wire-select"
import { inNormalForm, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { junctionsOf, pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import { isRerouteRefusal, rerouted, reroutedRuns, routeBetween, type RouteEnd } from "@/schematic/wires/router"
import type { WireSegment } from "@/schematic/wires/segment"
import { bestShape, shapeOf } from "../lib/route-reference"
import { random } from "../lib/wire-reference"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const resistor = (id: string, x: number, y: number, rotation?: Rotation): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
const part = (id: string, def: string, x: number, y: number, rotation?: Rotation): PlacedObject => ({ id, def, x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
const board = (def: string, x = 0, y = 0): PlacedObject => ({ id: "U1", def, x: c(x), y: c(y), props: { ref: "U1" } })
const pin = (object: string, id: string): RouteEnd => ({ pin: { object, pin: id } })
const refOf = (key: string): RouteEnd => pin(key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1))
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic): Wiring => wiringOf(new WireGraph(), doc)
const partition = (doc: Schematic) => pinPartition(wireNets(doc.wires, wirePins(doc.objects)))
const cellsOf = (points: readonly Point[] | null | undefined) => (points ?? []).map((p) => [p.x / GRID, p.y / GRID])
const legsOf = (points: readonly Point[]) => points.slice(1).map((b, i) => ({ a: points[i], b }))
const segKey = (s: { a: Point; b: Point }) => {
  const [p, q] = [s.a, s.b].sort((u, v) => u.x - v.x || u.y - v.y)
  return `${p.x / GRID},${p.y / GRID}-${q.x / GRID},${q.y / GRID}`
}
const picture = (doc: Schematic) => doc.wires.map(segKey).sort()
let serial = 0
const newId = () => `s${++serial}`

function comesBack(points: readonly Point[]): Point | null {
  const seen = new Set<string>()
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const n = (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) / (GRID / 2)
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const p = { x: a.x + (Math.sign(b.x - a.x) * k * GRID) / 2, y: a.y + (Math.sign(b.y - a.y) * k * GRID) / 2 }
      if (seen.has(`${p.x},${p.y}`)) return p
      seen.add(`${p.x},${p.y}`)
    }
  }
  return null
}

function cycles(wires: readonly { a: Point; b: Point }[]): number {
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

function draw(doc: Schematic, from: Point, to: Point, mode: LineMode = "90", corners: Point[] = []) {
  const wiring = wiringFor(doc)
  const started = startDrawing(wiring, drawEndAt(wiring, from))
  if (isRefusal(started)) throw new Error(`could not start: ${started.refused}`)
  let d: Drawing = withLineMode(started, mode)
  for (const k of corners) {
    const next = withCorner(doc, wiring, pointerAt(d, k), k)
    if (isRefusal(next)) throw new Error(`corner refused: ${next.refused}`)
    d = next
  }
  const target = drawEndAt(wiring, to)
  const held = pointerAt(d, target.at)
  return { wiring, target, preview: previewOf(doc, wiring, held, target), laid: drawnTo(doc, wiring, held, target, newId) }
}

const laidOrThrow = (r: ReturnType<typeof draw>) => {
  if (isRefusal(r.laid)) throw new Error(`refused ${r.laid.refused} at ${cellsOf([r.laid.at])}`)
  return r.laid
}

const throughBodies = (doc: Schematic) => checked(doc).filter((f) => f.kind === "wire-through-body").length

describe("A1, new scene: CN8-7/CN8-8 with the names column and the next column both carrying other nets", () => {
  const rails = () => [
    { id: "x3", a: at(3, 15), b: at(3, 27) },
    { id: "x2", a: at(2, 15), b: at(2, 27) },
  ]
  const scene = () => docOf([board("nucleo-f429zi"), resistor("Ra", -6, 19), resistor("Rb", -12, 20)], rails())
  const nets = [
    ["Ra:2", "U1:CN8-7"],
    ["Rb:2", "U1:CN8-8"],
  ]
  it("guard: CN8-7 is the outer socket at (5, 20), CN8-8 the inner at (6, 20)", () => {
    const pins = new Map(wirePins(scene().objects).map((p) => [p.key, cellsOf([p.at])[0]]))
    expect.soft([pins.get("U1:CN8-7"), pins.get("U1:CN8-8")]).toEqual([
      [5, 20],
      [6, 20],
    ])
  })
  it("inner first then outer, and outer first then inner: both laid, two nets, one picture, the slip two columns past the names", () => {
    const innerFirst = laidOrThrow(draw(laidOrThrow(draw(scene(), at(6, 20), at(-8, 21))), at(-2, 20), at(5, 20)))
    const outerFirst = laidOrThrow(draw(laidOrThrow(draw(scene(), at(-2, 20), at(5, 20))), at(6, 20), at(-8, 21)))
    expect.soft(partition(innerFirst), "inner first: two nets").toEqual(nets)
    expect.soft(partition(outerFirst), "outer first: two nets").toEqual(nets)
    expect.soft(picture(innerFirst), "one picture whichever was drawn first").toEqual(picture(outerFirst))
    const halfRow = outerFirst.wires.filter((s) => s.a.y === s.b.y && Math.abs(s.a.y / GRID - 20) === 0.5)
    expect.soft(halfRow.map(segKey), "the half-row leg runs from the inner socket out past x = 2").toEqual(expect.arrayContaining([expect.stringMatching(/^1,20\.5-6,20\.5$|^1,19\.5-6,19\.5$/)]))
  })
})

describe("A2, new scene: every inner/outer socket pair of every double-row header on three boards", () => {
  it.each(["nucleo-f429zi", "open746i-c", "stm32f4-discovery"])("%s: no route between the two sockets of one row comes back through a point it passed, in either direction, and T on a one-cell jumper never makes a loop", (def) => {
    const doc = docOf([board(def)])
    const pins = wirePins(doc.objects).filter((p) => p.socket && p.out && !p.shunt)
    const byAt = new Map(pins.map((p) => [`${p.at.x},${p.at.y}`, p]))
    const pairs = pins.flatMap((p) => {
      const behind = byAt.get(`${p.at.x - p.out!.x * GRID},${p.at.y - p.out!.y * GRID}`)
      return behind && behind.out && behind.out.x === p.out!.x && behind.out.y === p.out!.y ? [[p, behind] as const] : []
    })
    const bad: string[] = []
    for (const [outer, inner] of pairs) {
      for (const [a, b] of [
        [outer, inner],
        [inner, outer],
      ]) {
        const route = routeBetween(doc, refOf(a.key), refOf(b.key))
        const back = route && comesBack(route)
        if (back) bad.push(`${a.key} → ${b.key}: ${JSON.stringify(cellsOf(route))}`)
      }
      const jumper = docOf([board(def)], [{ id: "j", a: outer.at, b: inner.at }])
      const t = rerouted(jumper, "j", newId)
      if (!isRerouteRefusal(t) && (cycles(t.wires) || junctionsOf(wireNets(t.wires, wirePins(t.objects))).length)) bad.push(`T on ${outer.key}–${inner.key}: ${picture(t).join(" ")}`)
    }
    expect.soft(pairs.length, "guard: pairs found").toBeGreaterThan(4)
    expect.soft(bad, "no route comes back").toEqual([])
  })
})

describe("A3, new scenes: random old files with saved bends never open with a loop on a net that had none", () => {
  it("120 random files, resistors and 1–3 bends per wire, every net two pins and one wire: no cycle, the circuit kept", () => {
    const bad: string[] = []
    for (let seed = 1; seed <= 120; seed++) {
      const rnd = random(seed * 31337)
      const objects: PlacedObject[] = []
      for (let tries = 0; objects.length < 5 && tries < 200; tries++) {
        const o = resistor(`R${objects.length + 1}`, rnd.int(-10, 14), rnd.int(-8, 12), rnd.chance(0.5) ? 90 : undefined)
        if (objects.length && placementCheck({ objects, routes: [], grid: GRID }, [o])(0, 0)) continue
        objects.push(o)
      }
      const pins = wirePins(objects)
      const parent = new Map(pins.map((p) => [p.key, p.key]))
      const find = (k: string): string => (parent.get(k) === k ? k : find(parent.get(k)!))
      const wires: LegacyWire[] = []
      const used = new Set<string>()
      for (let k = 0; k < 4; k++) {
        const a = rnd.pick(pins)
        const b = rnd.pick(pins)
        if (find(a.key) === find(b.key) || used.has(a.key) || used.has(b.key)) continue
        used.add(a.key)
        used.add(b.key)
        parent.set(find(a.key), find(b.key))
        const bends = Array.from({ length: rnd.int(1, 3) }, () => at(rnd.int(-12, 18), rnd.int(-10, 14)))
        const ref = (key: string) => ({ object: key.slice(0, key.indexOf(":")), pin: key.slice(key.indexOf(":") + 1) })
        wires.push({ id: `w${k}`, from: ref(a.key), to: ref(b.key), points: bends })
      }
      let i = 0
      const { doc } = wiresAsSegments({ objects, wires, parts: {} } satisfies LegacySchematic, () => `z${i++}`)
      for (const g of partition(docOf(objects))) for (const k of g.slice(1)) parent.set(find(k), find(g[0]))
      const want = new Map<string, string[]>()
      for (const p of pins) want.set(find(p.key), [...(want.get(find(p.key)) ?? []), p.key])
      const expected = [...want.values()].filter((g) => g.length > 1).map((g) => g.sort())
      const got = partition(doc)
      if (JSON.stringify(got.map((g) => [...g].sort()).sort()) !== JSON.stringify(expected.sort())) bad.push(`seed ${seed}: circuit ${JSON.stringify(got)} where ${JSON.stringify(expected)}`)
      if (cycles(doc.wires)) bad.push(`seed ${seed}: ${cycles(doc.wires)} loop(s): ${picture(doc).join(" ")}`)
    }
    expect.soft(bad, "no loop, no circuit changed").toEqual([])
  })
})

describe("A4, new scene: a vertical wire through a three-way junction of another net", () => {
  const hub: PlacedObject = { id: "J1", def: "junction", x: c(0), y: c(5) }
  const wire = (id: string, from: [string, string], to: [string, string], points?: Point[]): LegacyWire => ({ id, from: { object: from[0], pin: from[1] }, to: { object: to[0], pin: to[1] }, ...(points && { points }) })
  const objects = [resistor("R1", 0, -4, 90), resistor("R2", 0, 12, 90), resistor("R3", -8, 5), resistor("R4", 6, 5), resistor("R5", -8, 8)]
  const m = wire("m", ["R1", "2"], ["R2", "1"], [at(1, 2), at(1, 10)])
  const n1 = wire("n1", ["R3", "2"], ["J1", "J"])
  const n2 = wire("n2", ["R4", "1"], ["J1", "J"])
  const n3 = wire("n3", ["R5", "2"], ["J1", "J"])
  const frozen = (wires: LegacyWire[]) => {
    let i = 0
    return wiresAsSegments({ objects: [...objects, hub], wires, parts: {} } satisfies LegacySchematic, () => `z${i++}`)
  }
  it("whichever wire the file lists first: no note, both bends kept, two nets", () => {
    for (const order of [
      [m, n1, n2, n3],
      [n1, n2, n3, m],
      [n2, m, n3, n1],
    ]) {
      const f = frozen(order)
      const names = order.map((w) => w.id).join(" ")
      expect.soft(f.notes, `${names}: no note`).toEqual([])
      const mWires = f.doc.wires.filter((s) => wireNets(f.doc.wires, wirePins(f.doc.objects)).netOfSegment(s.id) === wireNets(f.doc.wires, wirePins(f.doc.objects)).netOfPin("R1:2"))
      expect.soft(mWires.some((s) => (s.a.x === s.b.x ? s.a.x === c(1) && Math.min(s.a.y, s.b.y) <= c(6) && Math.max(s.a.y, s.b.y) >= c(6) : s.a.y === c(6) && Math.min(s.a.x, s.b.x) <= c(1) && Math.max(s.a.x, s.b.x) >= c(1))), `${names}: M passes no hub`).toBe(false)
      expect.soft(f.doc.wires.every((s) => Number.isInteger(s.a.x / GRID) && Number.isInteger(s.a.y / GRID) && Number.isInteger(s.b.x / GRID) && Number.isInteger(s.b.y / GRID)), `${names}: on whole cells (not the half-cell fallback)`).toBe(true)
      expect.soft(partition(f.doc), `${names}: two nets`).toEqual([
        ["R1:2", "R2:1"],
        ["R3:2", "R4:1", "R5:2"],
      ])
    }
  })
})

describe("A5, new scenes: the router equals the reference at any distance on random plain scenes with long rails", () => {
  it("80 scenes: two resistors at random, one to three long rails of other nets; crossings, bends and length equal the reference's", () => {
    const misses: string[] = []
    let compared = 0
    for (let seed = 1; seed <= 80; seed++) {
      const rnd = random(seed * 7907)
      const r1 = resistor("R1", 0, 0, rnd.chance(0.5) ? 90 : undefined)
      const r2 = resistor("R2", rnd.int(6, 14), rnd.int(-8, 8), rnd.chance(0.5) ? 90 : undefined)
      if (placementCheck({ objects: [r1], routes: [], grid: GRID }, [r2])(0, 0)) continue
      const rails: WireSegment[] = []
      for (let k = rnd.int(1, 3); k > 0; k--) {
        const vertical = rnd.chance(0.5)
        const fixed = vertical ? rnd.int(-3, 16) : rnd.int(-10, 10)
        const from = rnd.int(-24, 0)
        const to = rnd.int(2, 24)
        rails.push(vertical ? { id: `r${k}`, a: at(fixed, from), b: at(fixed, to) } : { id: `r${k}`, a: at(from, fixed), b: at(to, fixed) })
      }
      const doc = docOf([r1, r2], rails)
      if (throughBodies(doc) || doc.wires.length !== rails.length || partition(doc).length) continue
      const pa = wirePins([r1]).find((p) => p.key === "R1:2")!
      const pb = wirePins([r2]).find((p) => p.key === "R2:1")!
      const touched = doc.wires.some((s) => [pa.at, pb.at].some((p) => (s.a.x === s.b.x ? s.a.x === p.x && p.y >= Math.min(s.a.y, s.b.y) && p.y <= Math.max(s.a.y, s.b.y) : s.a.y === p.y && p.x >= Math.min(s.a.x, s.b.x) && p.x <= Math.max(s.a.x, s.b.x))))
      if (touched) continue
      const route = routeBetween(doc, refOf(pa.key), refOf(pb.key))
      const want = bestShape(doc, pa.at, pb.at)
      if (!route || !want) {
        if (!!route !== !!want) misses.push(`seed ${seed}: router ${route ? "found" : "none"}, reference ${want ? "found" : "none"}`)
        continue
      }
      compared++
      const got = shapeOf(doc, route)
      if (got.faults.length || got.crossings !== want.crossings || got.bends !== want.bends || got.length !== want.length)
        misses.push(`seed ${seed}: ${got.crossings}/${got.bends}/${got.length} ${got.faults.join(",")} where the reference ${want.crossings}/${want.bends}/${want.length}: ${JSON.stringify(cellsOf(route))} rails ${rails.map(segKey).join(" ")}`)
    }
    expect.soft(compared, "guard: scenes compared").toBeGreaterThan(40)
    expect.soft(misses, "the cost order holds at any distance").toEqual([])
  })
})

describe("B4, new scenes: a target nothing can enter is refused at once, and every pin of a big chip is answered without a stall", () => {
  it("R2's left pin with a dangling end of another net on each of its three open sides: no route, decided on about the window a free pin needs", () => {
    const doc = docOf(
      [resistor("R1", 0, 0), resistor("R2", 20, 0), resistor("R3", 30, 0)],
      [
        { id: "left", a: at(19, 1), b: at(16, 1) },
        { id: "up", a: at(20, 0), b: at(20, -3) },
        { id: "down", a: at(20, 2), b: at(20, 5) },
      ],
    )
    expect.soft(partition(doc), "guard: the stubs touch nothing").toEqual([])
    const wiring = wiringFor(doc)
    let lines = 0
    const along = wiring.sheet.along.bind(wiring.sheet)
    Object.assign(wiring.sheet, { along: (...args: Parameters<typeof along>) => (lines++, along(...args)) })
    const read = (target: RouteEnd) => {
      lines = 0
      const route = routeBetween(doc, pin("R1", "2"), target, wiring)
      return { route: !!route, lines }
    }
    const free = read(pin("R3", "1"))
    const sealed = read(pin("R2", "1"))
    expect.soft(free.route, "guard: R3 reached").toBe(true)
    expect.soft(sealed.route, "R2:1 cannot be entered").toBe(false)
    expect.soft(sealed.lines <= 2 * free.lines, `decided at once (${sealed.lines} lines against ${free.lines})`).toBe(true)
  })
})

describe("B1, new scenes: no route between pins of leadless chips runs along their outline", () => {
  const along = (doc: Schematic, points: readonly Point[]) => {
    const found: string[] = []
    for (const body of bodiesOf(doc.objects))
      for (const corners of body.contour)
        corners.forEach((p, i) => {
          const q = corners[(i + 1) % corners.length]
          for (const s of legsOf(points)) {
            const horizontal = s.a.y === s.b.y
            if (horizontal ? Math.abs(p.y - q.y) > 1e-6 : Math.abs(p.x - q.x) > 1e-6) continue
            if (Math.abs((horizontal ? p.y - s.a.y : p.x - s.a.x)) >= GRID / 4 - 1e-6) continue
            const lo = Math.max(Math.min(horizontal ? s.a.x : s.a.y, horizontal ? s.b.x : s.b.y), Math.min(horizontal ? p.x : p.y, horizontal ? q.x : q.y))
            const hi = Math.min(Math.max(horizontal ? s.a.x : s.a.y, horizontal ? s.b.x : s.b.y), Math.max(horizontal ? p.x : p.y, horizontal ? q.x : q.y))
            if (hi - lo > 1e-6) found.push(`${body.object.id} ${segKey(s)}`)
          }
        })
    return found
  }
  it.each(["ne555", "opamp-generic", "opamp-lm358", "tp4056", "mt3608"])("%s turned every quarter: every pair of its pins and every pin to a resistor beside it", (def) => {
    const bad: string[] = []
    let routes = 0
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const chip = part("U", def, 0, 0, rotation)
      const r = resistor("R9", 14, 14)
      const doc = docOf([chip, r])
      const pins = wirePins([chip])
      if (!pins.length) return
      for (const a of pins) {
        for (const b of [...pins.filter((p) => p.key > a.key), ...wirePins([r])]) {
          const route = routeBetween(doc, refOf(a.key), refOf(b.key))
          if (!route) continue
          routes++
          for (const f of along(doc, route)) bad.push(`${rotation}° ${a.key} → ${b.key}: ${f}`)
        }
      }
    }
    expect.soft(routes, "guard: routes found").toBeGreaterThan(10)
    expect.soft(bad.slice(0, 10), `along an outline (${routes} routes)`).toEqual([])
  })
})

describe("B5, new scene: CN8-7 with both slip landings taken", () => {
  it("drawing to the outer socket while another net passes it and cannot step aside: refused as «socket», in its own words", () => {
    const doc = docOf(
      [board("nucleo-f429zi"), resistor("Rb", -12, 19), resistor("Ra", -6, 16)],
      [
        { id: "pass", a: at(6, 20), b: at(-8, 20) },
        { id: "up", a: at(1, 19.5), b: at(4, 19.5) },
        { id: "down", a: at(1, 20.5), b: at(4, 20.5) },
      ],
    )
    const r = draw(doc, at(-2, 17), at(5, 20))
    expect.soft(r.preview.refused?.refused, "preview").toBe("socket")
    expect.soft(isRefusal(r.laid) && r.laid.refused, "click").toBe("socket")
    expect.soft(DRAW_REFUSED.socket.why, "the words").not.toMatch(/End the wire on the pin/)
  })
})

describe("the jumper's shunt, new scene: the POWER JMP's VBAT/VREF+ shunts", () => {
  it("no route to or past VBAT and VREF+ runs onto a shunt or through a shunted socket", () => {
    const doc = docOf([board("open746i-c"), resistor("Ra", 10, 16), resistor("Rb", 24, 16), resistor("Rc", 14, 6, 90)])
    const shunted = wirePins(doc.objects).filter((p) => p.shunt)
    const bad: string[] = []
    const targets = ["Ra:1", "Ra:2", "Rb:1", "Rb:2", "Rc:1", "Rc:2", "U1:VBAT", "U1:VREF+"]
    for (const a of targets)
      for (const b of targets) {
        if (a >= b || a.slice(0, 2) === b.slice(0, 2)) continue
        const route = routeBetween(doc, refOf(a), refOf(b))
        if (!route) continue
        for (const p of shunted) {
          const far = { x: p.at.x + p.shunt!.x, y: p.at.y + p.shunt!.y }
          for (const s of legsOf(route)) {
            const meets = (q: Point) => (s.a.x === s.b.x ? q.x === s.a.x && q.y >= Math.min(s.a.y, s.b.y) && q.y <= Math.max(s.a.y, s.b.y) : q.y === s.a.y && q.x >= Math.min(s.a.x, s.b.x) && q.x <= Math.max(s.a.x, s.b.x))
            const endsAt = (q: Point) => (s.a.x === q.x && s.a.y === q.y) || (s.b.x === q.x && s.b.y === q.y)
            if ((meets(p.at) && !endsAt(p.at)) || meets(far) || (meets({ x: (p.at.x + far.x) / 2, y: (p.at.y + far.y) / 2 }) && !endsAt(p.at))) bad.push(`${a} → ${b}: ${segKey(s)} on ${p.key}'s shunt`)
          }
        }
      }
    expect.soft(bad, "clear of the shunts").toEqual([])
  })
})

describe("own net in the freeze, new scenes", () => {
  const wire = (id: string, from: [string, string], to: [string, string], points?: Point[]): LegacyWire => ({ id, from: { object: from[0], pin: from[1] }, to: { object: to[0], pin: to[1] }, ...(points && { points }) })
  const frozen = (objects: PlacedObject[], wires: LegacyWire[]) => {
    let i = 0
    return wiresAsSegments({ objects, wires, parts: {} } satisfies LegacySchematic, () => `z${i++}`)
  }
  it("vertical: R1 → R3 down a column over R2's pin of the same net: straight, one net, no note, no loop", () => {
    const f = frozen([resistor("R1", 0, 0, 90), resistor("R2", -3, 8), resistor("R3", 0, 14, 90)], [wire("a", ["R1", "2"], ["R2", "2"]), wire("b", ["R1", "2"], ["R3", "1"])])
    expect.soft(cellsOf(f.routes.get("b")), "straight down x = 1").toEqual([
      [1, 4],
      [1, 14],
    ])
    expect.soft(f.notes).toEqual([])
    expect.soft(cycles(f.doc.wires), "no loop").toBe(0)
    expect.soft(partition(f.doc)).toEqual([["R1:2", "R2:2", "R3:1"]])
  })
  it("a crossing of its own net costs as another's: of a straight run across its own riser and a one-bend route along it, the one-bend one", () => {
    const f = frozen([resistor("R1", 0, 0), resistor("R2", 6, -6, 90), resistor("R3", 12, 0), resistor("R4", 6, 6, 90)], [wire("riser", ["R2", "2"], ["R4", "1"]), wire("w", ["R1", "2"], ["R4", "1"])])
    const w = f.routes.get("w") ?? []
    const riser = f.routes.get("riser") ?? []
    const crossesOwn = legsOf(w).some((s) => legsOf(riser).some((r) => (s.a.y === s.b.y) !== (r.a.y === r.b.y) && Math.min(s.a.x, s.b.x) < Math.max(r.a.x, r.b.x) && Math.max(s.a.x, s.b.x) > Math.min(r.a.x, r.b.x) && Math.min(s.a.y, s.b.y) < Math.max(r.a.y, r.b.y) && Math.max(s.a.y, s.b.y) > Math.min(r.a.y, r.b.y)))
    expect.soft(crossesOwn, `w ${JSON.stringify(cellsOf(w))} over riser ${JSON.stringify(cellsOf(riser))}`).toBe(false)
    expect.soft(partition(f.doc)).toEqual([["R1:2", "R2:2", "R4:1"]])
  })
})

describe("diagonals and the router, new scenes", () => {
  it("a vertical route crossing a 1:3 diagonal of another net between lattice points: across it, two nets", () => {
    const doc = docOf([resistor("R1", 0, 0, 90), resistor("R2", 0, 12, 90)], [{ id: "slash", a: at(-3, 7), b: at(3, 9) }])
    const route = routeBetween(doc, pin("R1", "2"), pin("R2", "1"))
    expect.soft(cellsOf(route), "straight down, crossing the diagonal").toEqual([
      [1, 4],
      [1, 12],
    ])
    const after = inNormalForm({ ...doc, wires: [...doc.wires, ...legsOf(route ?? []).map((s, i) => ({ id: `n${i}`, ...s }))] })
    expect.soft(partition(after), "one net, the diagonal joins nothing").toEqual([["R1:2", "R2:1"]])
  })
  it("a diagonal ending at a half-cell point on the straight column: never over the end, two nets", () => {
    const doc = docOf([resistor("R1", 0, 0, 90), resistor("R2", 0, 12, 90)], [{ id: "slash", a: at(1, 8.5), b: at(4, 10) }])
    const route = routeBetween(doc, pin("R1", "2"), pin("R2", "1"))
    expect.soft(route, "a route").not.toBeNull()
    const after = inNormalForm({ ...doc, wires: [...doc.wires, ...legsOf(route ?? []).map((s, i) => ({ id: `n${i}`, ...s }))] })
    expect.soft(partition(after), "the diagonal on nothing").toEqual([["R1:2", "R2:1"]])
    expect.soft(route?.every((p, i) => i === 0 || p.x === route[i - 1].x || p.y === route[i - 1].y), "orthogonal").toBe(true)
  })
  it("R1 → R3 boxed in so the only one-bend route turns on a lattice point inside another net's diagonal: three bends instead, the diagonal's net not joined", () => {
    const doc = docOf(
      [resistor("R1", 0, 0), resistor("R3", 9, 5, 90), resistor("R5", 14, 4)],
      [
        { id: "slash", a: at(7, -2), b: at(14, 5) },
        { id: "s1", a: at(4, 0), b: at(4, -3) },
        { id: "s2", a: at(4, 2), b: at(4, 5) },
        { id: "s3", a: at(9, 5), b: at(6, 5) },
        { id: "s4", a: at(11, 5), b: at(12, 5) },
      ],
    )
    expect.soft(partition(doc), "guard: nothing joined").toEqual([])
    const route = routeBetween(doc, pin("R1", "2"), pin("R3", "1"))
    expect.soft(route, "a route").not.toBeNull()
    const corners = (route ?? []).slice(1, -1).map((p) => `${p.x / GRID},${p.y / GRID}`)
    expect.soft(corners.includes("10,1"), `no corner at (10, 1) on the diagonal: ${JSON.stringify(cellsOf(route))}`).toBe(false)
    const after = inNormalForm({ ...doc, wires: [...doc.wires, ...legsOf(route ?? []).map((s, i) => ({ id: `n${i}`, ...s }))] })
    expect.soft(partition(after), "R5's diagonal not joined").toEqual([["R1:2", "R3:1"]])
  })
  it("T on a run drawn in the any-angle mode at 1:2: laid orthogonal, the circuit unchanged, T again changes nothing", () => {
    const base = docOf([resistor("R1", 0, 0), resistor("R2", 12, 6)])
    const laid = laidOrThrow(draw(base, at(4, 1), at(12, 7), "any"))
    expect.soft(laid.wires.some((s) => s.a.x !== s.b.x && s.a.y !== s.b.y), "guard: a diagonal laid").toBe(true)
    const t = reroutedRuns(laid, laid.wires.map((s) => s.id), newId)
    expect.soft(t.refused, "not refused").toBeNull()
    expect.soft(t.doc.wires.every((s) => s.a.x === s.b.x || s.a.y === s.b.y), `orthogonal: ${picture(t.doc).join(" ")}`).toBe(true)
    expect.soft(partition(t.doc), "the circuit").toEqual(partition(laid))
    expect.soft(picture(reroutedRuns(t.doc, t.doc.wires.map((s) => s.id), newId).doc), "T again").toEqual(picture(t.doc))
  })
  it("the completion over a pin stays off in 45° and any angle even when the aimed segment is refused", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 0), resistor("R3", 6, -3, 90)])
    for (const mode of ["45", "any"] as const) {
      const r = draw(doc, at(4, 1), at(10, 1), mode)
      expect.soft([r.preview.routed, r.preview.refused?.refused], `${mode}: the aimed segment over R3's pin, refused, not routed`).toEqual([false, "over"])
    }
  })
})

describe("B12, new scenes: the completion after two corners and from a diagonal's open end", () => {
  const doc0 = () => docOf([resistor("R1", 0, 0), resistor("R2", 10, 0), resistor("R3", 6, -3, 90), resistor("R5", 9, 2, 90)])
  it("from R1 after corners (4, 4) and (7, 4): the drawn legs kept as drawn, the route never crosses or runs back on them, R1 and R2 joined", () => {
    const r = draw(doc0(), at(4, 1), at(10, 1), "90", [at(4, 4), at(7, 4)])
    expect.soft([r.preview.refused?.refused ?? null, r.preview.routed], "routed").toEqual([null, true])
    expect.soft(cellsOf(r.preview.points.slice(0, 3)), "through both corners").toEqual([
      [4, 1],
      [4, 4],
      [7, 4],
    ])
    expect.soft(comesBack(r.preview.points), "never back over itself").toBeNull()
    const laid = laidOrThrow(r)
    expect.soft(partition(laid)).toEqual([["R1:2", "R2:1"]])
    expect.soft(cycles(laid.wires)).toBe(0)
  })
  it("from the open end of a diagonal wire: a route, joined", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 10, 0), resistor("R3", 6, -3, 90)], [{ id: "slant", a: at(4, 1), b: at(6, 3) }])
    const r = draw(doc, at(6, 3), at(10, 1))
    expect.soft(r.preview.refused?.refused ?? null, "offered").toBeNull()
    const laid = laidOrThrow(r)
    expect.soft(partition(laid)).toEqual([["R1:2", "R2:1"]])
    expect.soft(throughBodies(laid)).toBe(0)
  })
})

describe("B11 and the body rule, new scenes: the slip shown on the Open746I-C and the Discovery, and never through a body", () => {
  for (const def of ["open746i-c", "stm32f4-discovery", "nucleo-f429zi"]) {
    it(`${def}: every third outer socket with an inner one behind it, the inner socket wired straight out to a resistor, a wire drawn from a dangling end onto the outer socket — preview and click agree, the click lays the preview, no body crossed, the circuit kept but for the join`, () => {
      const plain = docOf([board(def)])
      const pins = wirePins(plain.objects).filter((p) => p.socket && p.out && !p.shunt)
      const index = new Map(pins.map((p) => [`${p.at.x},${p.at.y}`, p]))
      const pairs = pins.flatMap((p) => {
        const inner = index.get(`${p.at.x - p.out!.x * GRID},${p.at.y - p.out!.y * GRID}`)
        return inner && inner.out!.x === p.out!.x && inner.out!.y === p.out!.y ? [[p, inner] as const] : []
      })
      const bad: string[] = []
      let moved = 0
      let tried = 0
      for (const [outer, inner] of pairs.filter((_, i) => i % 3 === 0)) {
        const out = outer.out!
        const far = { x: inner.at.x + out.x * c(14), y: inner.at.y + out.y * c(14) }
        const r = out.x === -1 ? part("Rx", "resistor", far.x / GRID - 4, far.y / GRID - 1) : out.x === 1 ? part("Rx", "resistor", far.x / GRID, far.y / GRID - 1) : out.y === -1 ? part("Rx", "resistor", far.x / GRID - 1, far.y / GRID - 4, 90) : part("Rx", "resistor", far.x / GRID - 1, far.y / GRID, 90)
        const across = { x: Math.abs(out.y), y: Math.abs(out.x) }
        const src = { x: outer.at.x + out.x * c(8) + across.x * c(4), y: outer.at.y + out.y * c(8) + across.y * c(4) }
        const doc = docOf([board(def), r], [{ id: "pass", a: inner.at, b: far }, { id: "src", a: src, b: { x: src.x + across.x * c(2), y: src.y + across.y * c(2) } }])
        const before = partition(doc)
        if (before.length !== 1 || before[0].length !== 2 || throughBodies(doc)) continue
        tried++
        const wiring = wiringFor(doc)
        if (drawEndAt(wiring, src).kind !== "end" || wirePins(doc.objects).some((q) => [src, { x: src.x + across.x * c(2), y: src.y + across.y * c(2) }].some((e) => e.x === q.at.x && e.y === q.at.y))) continue
        const started = startDrawing(wiring, drawEndAt(wiring, src))
        if (isRefusal(started)) continue
        const target = drawEndAt(wiring, outer.at)
        const held = pointerAt(started, target.at)
        const preview = previewOf(doc, wiring, held, target)
        const laid = drawnTo(doc, wiring, held, target, newId)
        if (isRefusal(laid) !== !!preview.refused) {
          bad.push(`${outer.key}: preview ${preview.refused?.refused ?? "clean"}, click ${isRefusal(laid) ? laid.refused : "laid"}`)
          continue
        }
        if (isRefusal(laid)) continue
        if (preview.moved.length) moved++
        const removed = new Set(preview.moved.flatMap((m) => wiring.runs.find((x) => x.id === m.run)?.segments.map((q) => q.id) ?? []))
        const shown = inNormalForm({ ...doc, wires: [...doc.wires.filter((q) => !removed.has(q.id)), ...legsOf(preview.points).map((q, i) => ({ id: `p${i}`, ...q })), ...preview.moved.flatMap((m, k) => legsOf(m.points).map((q, i) => ({ id: `m${k}.${i}`, ...q })))] })
        if (picture(shown).join("|") !== picture(laid).join("|")) bad.push(`${outer.key}: laid ≠ shown`)
        if (throughBodies(laid)) bad.push(`${outer.key}: through a body`)
        if (JSON.stringify(partition(laid)) !== JSON.stringify(before)) bad.push(`${outer.key}: partition ${JSON.stringify(partition(laid))} where ${JSON.stringify(before)}`)
      }
      expect.soft(moved, "guard: slips happened").toBeGreaterThan(0)
      expect.soft(bad.slice(0, 10), "preview = laid, no body crossed").toEqual([])
    })
  }
})

describe("the selection carried through T and diagonals (merge 2), new scenes", () => {
  it("a run with a 1:2 diagonal selected whole, re-routed by T (the new ids selected, as useSchematic does) and then its segment dragged: whole after both", () => {
    const base = docOf([resistor("R1", 0, 0), resistor("R2", 12, 6)])
    const laid = laidOrThrow(draw(base, at(4, 1), at(12, 7), "any"))
    const w0 = wiringFor(laid)
    const before = new Set(laid.wires.map((s) => s.id))
    const t = reroutedRuns(laid, before, newId, w0)
    const w1 = wiringFor(t.doc)
    const fresh = new Set(t.doc.wires.filter((s) => !before.has(s.id)).map((s) => s.id))
    const carried = carriedSelection(fresh, w0, w1)
    const runOf = (w: Wiring, ids: ReadonlySet<string>) => w.runs.filter((r) => r.segments.some((s) => ids.has(s.id)))
    expect.soft(runOf(w1, carried).every((r) => r.segments.every((s) => carried.has(s.id))), "after T: every touched run whole").toBe(true)
    const seg = [...carried].find((id) => {
      const s = w1.segmentsById.get(id)!
      return s.a.y === s.b.y && s.a.y !== at(0, 1).y && s.a.y !== at(0, 7).y
    }) ?? [...carried][0]
    const dragged = new SegmentDrag(t.doc, w1, seg).landed(0, c(1), newId)
    if (!dragged.refused) {
      const w2 = wiringFor(dragged.doc)
      const again = carriedSelection(carried, w1, w2)
      expect.soft(runOf(w2, again).length, "one run").toBe(1)
      expect.soft(runOf(w2, again).every((r) => r.segments.every((s) => again.has(s.id))), "after the drag: whole").toBe(true)
    }
  })
  it("a run of two diagonals selected whole, its second end's segment dragged twice back and forth: whole every time", () => {
    const base = docOf([resistor("R1", 0, 0), resistor("R2", 14, 8)])
    const laid = laidOrThrow(draw(base, at(4, 1), at(14, 9), "45"))
    let doc = laid
    let wiring = wiringFor(doc)
    let selected: ReadonlySet<string> = new Set(doc.wires.map((s) => s.id))
    for (const dy of [2, -2, 3, -3]) {
      const target = doc.wires.find((s) => s.a.x !== s.b.x && s.a.y === s.b.y) ?? doc.wires[0]
      const r = new SegmentDrag(doc, wiring, target.id).landed(0, c(dy), newId)
      if (r.refused) continue
      const next = wiringFor(r.doc)
      selected = carriedSelection(selected, wiring, next)
      doc = r.doc
      wiring = next
      const runs = wiring.runs.filter((x) => x.segments.some((s) => selected.has(s.id)))
      expect.soft(runs.every((x) => x.segments.every((s) => selected.has(s.id))), `dy ${dy}: whole`).toBe(true)
    }
  })
})
