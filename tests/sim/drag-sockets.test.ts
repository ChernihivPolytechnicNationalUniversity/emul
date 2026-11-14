import { describe, expect, it } from "vitest"
import { bodiesOf, crossedBody } from "@/schematic/body-crossing"
import { GRID } from "@/schematic/geometry"
import { wirePins } from "@/schematic/migrate-wires"
import { placementCheck } from "@/schematic/placement"
import { PartDrag, SegmentDrag } from "@/schematic/rubber-band"
import type { PlacedObject, Point, Schematic } from "@/schematic/types"
import { laysClear } from "@/schematic/wire-draw"
import { inNormalForm, wiringOf } from "@/schematic/wire-edits"
import { pinPartition, WireGraph, wireNets } from "@/schematic/wires/graph"
import { routeBetween } from "@/schematic/wires/router"
import type { WireSegment } from "@/schematic/wires/segment"
import { counter, random } from "../lib/wire-reference"

const at = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const by = (x: number, y: number) => [x * GRID, y * GRID] as const
let serial = 0
const wire = (a: Point, b: Point): WireSegment => ({ id: `s${++serial}`, a, b })
const nucleo: PlacedObject = { id: "U1", def: "nucleo-f429zi", x: 0, y: 0, props: { ref: "U1" } }
const resistor = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
const docOf = (objects: PlacedObject[], wires: WireSegment[]): Schematic => inNormalForm({ objects, wires, parts: {} })
const wiringFor = (doc: Schematic) => wiringOf(new WireGraph(), doc)
const nets = (doc: Schematic) => pinPartition(wireNets(doc.wires, wirePins(doc.objects)))

function acrossRows(doc: Schematic): string[] {
  const sockets = wirePins(doc.objects).filter((p) => p.socket)
  const out: string[] = []
  for (const s of doc.wires)
    for (const p of sockets) {
      const cross = (s.b.x - s.a.x) * (p.at.y - s.a.y) - (s.b.y - s.a.y) * (p.at.x - s.a.x)
      const inside = cross === 0 && p.at.x >= Math.min(s.a.x, s.b.x) && p.at.x <= Math.max(s.a.x, s.b.x) && p.at.y >= Math.min(s.a.y, s.b.y) && p.at.y <= Math.max(s.a.y, s.b.y)
      const end = (p.at.x === s.a.x && p.at.y === s.a.y) || (p.at.x === s.b.x && p.at.y === s.b.y)
      if (!inside || end) continue
      const alongRow = !!p.out && !p.shunt && ((s.a.y === s.b.y && p.out.y === 0) || (s.a.x === s.b.x && p.out.x === 0))
      if (!alongRow) out.push(`${s.a.x / GRID},${s.a.y / GRID}-${s.b.x / GRID},${s.b.y / GRID} across ${p.key}`)
    }
  return out.sort()
}

describe("a dragged wire passes a board's socket only along the socket's row (design.md §4.5, §6.7; the jumper rule)", () => {
  it("a loose upright dragged one cell right onto CN8's left column is not laid across its four rows: the drop moves to the nearest clean offset", () => {
    const loose = wire(at(4, 16.5), at(4, 20.5))
    const doc = docOf([nucleo], [loose])
    expect.soft(acrossRows(doc), "the scene starts clean").toEqual([])
    const drag = new SegmentDrag(doc, wiringFor(doc), loose.id)
    expect.soft(drag.frame(...by(1, 0)).blocked, "on CN8's column: blocked, as along a symbol's pins").toBe(true)
    const landed = drag.landed(...by(1, 0), counter("a"))
    expect.soft(acrossRows(landed.doc), "no wire across a socket's row").toEqual([])
    expect.soft(landed.at, "not where it was let go").not.toEqual(at(1, 0))
    expect.soft(nets(landed.doc), "no pin joined").toEqual([])
  })

  it("the same upright dragged across the column to the right of it lands, crossing nothing it should not", () => {
    const loose = wire(at(4, 16.5), at(4, 20.5))
    const doc = docOf([nucleo], [loose])
    const landed = new SegmentDrag(doc, wiringFor(doc), loose.id).landed(...by(3, 0), counter("b"))
    expect.soft(landed.at, "dropped where it was let go").toEqual(at(3, 0))
    expect.soft(acrossRows(landed.doc), "clear of the header").toEqual([])
  })

  it("a loose wire dragged onto a socket row, along it, still passes the sockets of that row (§4.5)", () => {
    const loose = wire(at(2, 16), at(9, 16))
    const doc = docOf([nucleo], [loose])
    const drag = new SegmentDrag(doc, wiringFor(doc), loose.id)
    expect.soft(drag.frame(...by(0, 1)).blocked, "along CN8's first row: free").toBe(false)
    const landed = drag.landed(...by(0, 1), counter("c"))
    expect.soft(landed.at, "dropped where it was let go").toEqual(at(0, 1))
    expect.soft(acrossRows(landed.doc), "passing along the row is no crossing").toEqual([])
  })

  it("a part dragged so that the wire it pulls would run up CN8's column is not laid across the rows", () => {
    const r = resistor("R1", 1, 15, 90)
    const doc = docOf([nucleo, r], [wire(at(2, 19), at(2, 21))])
    const pins = wirePins(doc.objects).filter((p) => p.key.startsWith("R1:"))
    expect.soft(pins.map((p) => p.at), "R1 upright, its pins on column 2").toEqual([at(2, 15), at(2, 19)])
    const drag = new PartDrag(doc, wiringFor(doc), { objects: new Set(["R1"]) })
    const landed = drag.landed(...by(3, 0), counter("d"))
    expect.soft(acrossRows(landed.doc), "no wire across a socket's row").toEqual([])
  })

  it("a board dragged so that its header column lands on a loose upright is not dropped there: its sockets would sit across the wire (seed 12 of the fuzz below, reduced)", () => {
    const loose = wire(at(7, 15), at(7, 21))
    const doc = docOf([nucleo, resistor("R1", -12, 26)], [loose])
    const drag = new PartDrag(doc, wiringFor(doc), { objects: new Set(["U1"]) })
    expect.soft(drag.blocked(...by(1, 0)), "CN8's right column on the upright: blocked").toBe(true)
    const landed = drag.landed(...by(1, 0), counter("e"))
    expect.soft(landed.at, "not where it was let go").not.toEqual(at(1, 0))
    expect.soft(acrossRows(landed.doc), "no socket across the wire").toEqual([])
    expect.soft(nets(landed.doc), "no pin joined").toEqual([])
  })

  it("a paste is clear only where its wires pass sockets along their rows", () => {
    const doc = docOf([nucleo], [])
    const wiring = wiringFor(doc)
    expect.soft(laysClear(wiring, [{ a: at(5, 16.5), b: at(5, 20.5) }], doc), "up CN8's column: not clear").toBe(false)
    expect.soft(laysClear(wiring, [{ a: at(3, 17), b: at(9, 17) }], doc), "along CN8's first row: clear").toBe(true)
  })
})

type Area = { x0: number; y0: number; x1: number; y1: number }
const BOARDS: { def: string; area: Area }[] = [
  { def: "nucleo-f429zi", area: { x0: -16, y0: 14, x1: 4, y1: 40 } },
  { def: "weact-blackpill-f411", area: { x0: 16, y0: -2, x1: 32, y1: 12 } },
  { def: "open746i-c", area: { x0: -12, y0: -14, x1: 60, y1: 30 } },
]
const PARTS = ["resistor", "resistor", "led", "capacitor", "diode", "npn", "capacitor-polarized", "pushbutton", "opamp-generic", "ne555"]
const ROTATIONS = [0, 90, 180, 270] as const
const SEEDS = Number(process.env.SOCKET_FUZZ_SEEDS ?? 40)
const cell = (v: number) => v * GRID

function boardScene(seed: number): { doc: Schematic; area: Area } {
  const rnd = random(seed * 7919 + 13)
  const board = BOARDS[seed % BOARDS.length]
  const objects: PlacedObject[] = [{ id: "U1", def: board.def, x: 0, y: 0, props: { ref: "U1" } }]
  const area = board.area
  for (let tries = 0, n = 0; n < rnd.int(3, 8) && tries < 300; tries++) {
    const id = `P${n + 2}`
    const o: PlacedObject = { id, def: rnd.pick(PARTS), x: cell(rnd.int(area.x0, area.x1)), y: cell(rnd.int(area.y0, area.y1)), props: { ref: id }, ...(rnd.chance(0.6) && { rotation: rnd.pick(ROTATIONS) }) }
    if (placementCheck({ objects, routes: [], grid: GRID }, [o])(0, 0)) continue
    objects.push(o)
    n++
  }
  let doc = inNormalForm({ objects, wires: [], parts: {} })
  const near = wirePins(doc.objects).filter((p) => p.at.x >= cell(area.x0 - 4) && p.at.x <= cell(area.x1 + 8) && p.at.y >= cell(area.y0 - 4) && p.at.y <= cell(area.y1 + 8))
  for (let k = rnd.int(2, 6); k > 0; k--) {
    const a = rnd.pick(near)
    const b = rnd.pick(near)
    if (a.key === b.key) continue
    const ref = (key: string) => ({ pin: { object: key.slice(0, key.indexOf(":")), pin: key.slice(key.indexOf(":") + 1) } })
    const route = routeBetween(doc, ref(a.key), ref(b.key))
    if (route && route.length > 1) doc = inNormalForm({ ...doc, wires: [...doc.wires, ...route.slice(1).map((q, i) => ({ id: `r${k}.${i}`, a: route[i], b: q }))] })
  }
  for (let k = rnd.int(1, 4); k > 0; k--) {
    const a = { x: cell(rnd.int(area.x0, area.x1)), y: cell(rnd.int(area.y0, area.y1)) }
    const len = cell(rnd.int(1, 6)) * (rnd.chance(0.5) ? 1 : -1)
    const b = rnd.chance(0.5) ? { x: a.x + len, y: a.y } : { x: a.x, y: a.y + len }
    const next = inNormalForm({ ...doc, wires: [...doc.wires, { id: `d${k}`, a, b }] })
    if (crossedBody({ a, b }, bodiesOf(doc.objects))) continue
    if (JSON.stringify(nets(next)) !== JSON.stringify(nets(doc)) || acrossRows(next).length > acrossRows(doc).length) continue
    doc = next
  }
  return { doc, area }
}

describe("random part, board and segment drags beside the boards' headers never lay a wire across a socket's row (the phase 6 verification's fuzz, V5)", () => {
  it(`${SEEDS} seeded documents on a Nucleo, a Black Pill or an Open746I-C, twelve chained drags each`, () => {
    const found: string[] = []
    const tally = { parts: 0, segments: 0, moved: 0 }
    for (let seed = 1; seed <= SEEDS; seed++) {
      let { doc } = boardScene(seed)
      const rnd = random(seed * 104729 + 7)
      const ids = counter(`f${seed}.`)
      for (let op = 0; op < 12; op++) {
        const wiring = wiringFor(doc)
        let landed
        let what
        if (rnd.chance(0.4)) {
          const parts = rnd.chance(0.25) ? doc.objects.filter((o) => o.id === "U1") : doc.objects.filter((o) => o.id !== "U1")
          if (!parts.length) continue
          const part = rnd.pick(parts)
          const [dx, dy] = by(rnd.int(-4, 4), rnd.int(-4, 4))
          what = `part ${part.id} ${part.def} by (${dx / GRID},${dy / GRID})`
          landed = new PartDrag(doc, wiring, { objects: new Set([part.id]) }).landed(dx, dy, ids)
          tally.parts++
        } else {
          if (!doc.wires.length) continue
          const s = rnd.pick(doc.wires)
          const [dx, dy] = by(rnd.int(-3, 3), rnd.int(-3, 3))
          what = `segment ${s.a.x / GRID},${s.a.y / GRID}-${s.b.x / GRID},${s.b.y / GRID} by (${dx / GRID},${dy / GRID})`
          landed = new SegmentDrag(doc, wiring, s.id).landed(dx, dy, ids)
          tally.segments++
        }
        if (landed.refused || landed.doc === doc) continue
        tally.moved++
        const was = new Set(acrossRows(doc))
        const fresh = acrossRows(landed.doc).filter((x) => !was.has(x))
        if (fresh.length) found.push(`seed ${seed} op ${op}: ${what}: ${fresh.slice(0, 2).join("; ")}`)
        doc = landed.doc
      }
    }
    expect.soft(tally.moved, `most drags land: ${JSON.stringify(tally)}`).toBeGreaterThan(SEEDS * 6)
    expect.soft(found, "no wire laid across a socket's row").toEqual([])
  }, 600_000)
})
