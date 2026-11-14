import { describe, expect, it } from "vitest"
import { examples } from "@/schematic/examples"
import { GRID, type Point } from "@/schematic/geometry"
import { wirePins } from "@/schematic/migrate-wires"
import { placementCheck } from "@/schematic/placement"
import type { PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { inNormalForm, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import * as now from "@/schematic/wires/router"
import type { RouteAround, RouteEnd } from "@/schematic/wires/router"
import type { WireSegment } from "@/schematic/wires/segment"
import * as before from "../lib/router-before-edge-bound"
import { counter, random } from "../lib/wire-reference"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const ROTATIONS: readonly (Rotation | undefined)[] = [undefined, 90, 180, 270]
const PARTS = ["resistor", "resistor", "resistor", "led", "capacitor", "diode", "npn", "pushbutton"]
const refOf = (key: string): RouteEnd => ({ pin: { object: key.slice(0, key.indexOf(":")), pin: key.slice(key.indexOf(":") + 1) } })
const shown = (points: readonly Point[] | null) => (points ? points.map((p) => `(${p.x / GRID}, ${p.y / GRID})`).join(" ") : "none")
const wiringFor = (doc: Schematic): Wiring => wiringOf(new WireGraph(), doc)

type Tally = { calls: number; routed: number; earlier: number; misses: string[] }

const tally = (): Tally => ({ calls: 0, routed: 0, earlier: 0, misses: [] })

function linesRead(wiring: Wiring, run: () => void): number {
  const sheet = wiring.sheet
  const along = sheet.along
  let lines = 0
  sheet.along = (...args: Parameters<typeof along>) => (lines++, along.apply(sheet, args))
  try {
    run()
  } finally {
    sheet.along = along
  }
  return lines
}

function compare(t: Tally, label: string, wiring: Wiring, from: RouteEnd, to: RouteEnd, around: RouteAround) {
  let want: Point[] | null = null
  let got: Point[] | null = null
  const old = linesRead(wiring, () => (want = before.routeAround(wiring, from, to, around)))
  const fresh = linesRead(wiring, () => (got = now.routeAround(wiring, from, to, around)))
  t.calls++
  if (want) t.routed++
  if (fresh < old) t.earlier++
  if (shown(got) !== shown(want)) t.misses.push(`${label}: ${shown(got)} where the current router lays ${shown(want)}`)
}

function sceneOf(seed: number): Schematic | null {
  const rnd = random(seed * 6151)
  const objects: PlacedObject[] = []
  for (let k = rnd.int(2, 5); k > 0; k--) {
    const rotation = rnd.pick(ROTATIONS)
    const object: PlacedObject = { id: `P${k}`, def: rnd.pick(PARTS), x: c(rnd.int(-14, 14)), y: c(rnd.int(-12, 12)), props: { ref: `P${k}` }, ...(rotation && { rotation }) }
    if (!placementCheck({ objects, routes: [], grid: GRID }, [object])(0, 0)) objects.push(object)
  }
  if (objects.length < 2) return null
  const wires: WireSegment[] = []
  for (let k = rnd.int(0, 4); k > 0; k--) {
    const vertical = rnd.chance(0.5)
    const fixed = rnd.int(-14, 14)
    const from = rnd.int(-30, 0)
    const to = rnd.int(1, 30)
    wires.push(vertical ? { id: `w${k}`, a: at(fixed, from), b: at(fixed, to) } : { id: `w${k}`, a: at(from, fixed), b: at(to, fixed) })
  }
  return inNormalForm({ objects, wires, parts: {} })
}

describe("the window's edge bound changes no route: the router equals the one before it, call for call", () => {
  it("random scenes of parts and long rails of other nets: every pin to every pin, plain, as the freeze asks, with stops and with a wire ignored", () => {
    const t = tally()
    for (let seed = 1; seed <= 60; seed++) {
      const doc = sceneOf(seed)
      if (!doc) continue
      const rnd = random(seed)
      const wiring = wiringFor(doc)
      const pins = wirePins(doc.objects)
      for (const a of pins)
        for (const b of pins) {
          if (a.key === b.key) continue
          const label = `seed ${seed} ${a.key} → ${b.key}`
          const stops = [at(rnd.int(-10, 10), rnd.int(-10, 10))]
          const ignore = new Set(doc.wires.length ? [rnd.pick(doc.wires).id] : [])
          compare(t, label, wiring, refOf(a.key), refOf(b.key), {})
          compare(t, `${label} settled`, wiring, refOf(a.key), refOf(b.key), { settle: true, stops })
          compare(t, `${label} ignoring`, wiring, refOf(a.key), refOf(b.key), { ignore })
        }
    }
    expect.soft(t.calls, "guard: calls compared").toBeGreaterThan(2000)
    expect.soft(t.routed, "guard: routes laid").toBeGreaterThan(1000)
    expect.soft(t.earlier, "guard: calls the bound decided on a smaller window").toBeGreaterThan(100)
    expect.soft(t.misses, "the same route every time").toEqual([])
  })

  it("random scenes through saved bends, as the freeze lays an old file: the same route", () => {
    const t = tally()
    for (let seed = 1; seed <= 60; seed++) {
      const doc = sceneOf(seed + 1000)
      if (!doc) continue
      const rnd = random(seed + 1000)
      const wiring = wiringFor(doc)
      const pins = wirePins(doc.objects)
      for (let k = 0; k < 20; k++) {
        const a = rnd.pick(pins)
        const b = rnd.pick(pins)
        if (a.key === b.key) continue
        const bends = [at(rnd.int(-16, 16), rnd.int(-16, 16))]
        const want = before.routeThroughBends(wiring, refOf(a.key), refOf(b.key), bends, { settle: true })
        const got = now.routeThroughBends(wiring, refOf(a.key), refOf(b.key), bends, { settle: true })
        t.calls++
        if (want) t.routed++
        if (shown(got) !== shown(want)) t.misses.push(`seed ${seed} ${a.key} → ${b.key} through ${shown(bends)}: ${shown(got)} where the current router lays ${shown(want)}`)
      }
    }
    expect.soft(t.calls, "guard: calls compared").toBeGreaterThan(800)
    expect.soft(t.routed, "guard: routes laid").toBeGreaterThan(200)
    expect.soft(t.misses, "the same route every time").toEqual([])
  })

  for (const example of examples)
    it(`${example.id}: the completion from every part's first pin to the pins of the biggest part and to random pins, and T on every run: the same answer`, () => {
      const doc = example.build(GRID)
      const wiring = wiringFor(doc)
      const rnd = random(example.id.length * 7919 + example.id.charCodeAt(0))
      const pins = wirePins(doc.objects)
      const big = [...doc.objects].sort((a, b) => wirePins([b]).length - wirePins([a]).length)[0]
      const targets = wirePins([big])
      const firsts = doc.objects.filter((o) => o !== big).map((o) => wirePins([o])[0]).filter((p) => !!p)
      const t = tally()
      for (const from of firsts.filter(() => rnd.chance(0.3)).slice(0, 2)) for (const to of targets.filter(() => rnd.chance(0.25))) compare(t, `${from.key} → ${to.key}`, wiring, refOf(from.key), refOf(to.key), {})
      for (let k = 0; k < 30 && pins.length > 1; k++) {
        const a = rnd.pick(pins)
        const b = rnd.pick(pins)
        if (a.key !== b.key) compare(t, `${a.key} → ${b.key}`, wiring, refOf(a.key), refOf(b.key), {})
      }
      for (const run of new Set(wiring.runBySegment.values())) {
        const segment = run.segments[0].id
        const want = before.rerouted(doc, segment, counter("laid"), wiring)
        const got = now.rerouted(doc, segment, counter("laid"), wiring)
        t.calls++
        if (JSON.stringify(got) !== JSON.stringify(want)) t.misses.push(`T on ${segment}: the documents differ`)
      }
      expect.soft(t.calls, "guard: calls compared").toBeGreaterThan(5)
      expect.soft(t.misses, "the same answer every time").toEqual([])
    })
})
