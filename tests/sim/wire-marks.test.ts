import { describe, expect, it } from "vitest"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { GRID, objectPins, type Point } from "@/schematic/geometry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { paintMarks } from "@/components/field/field-paint"
import { WireLayer } from "@/components/field/WireLayer"
import { WireFlow } from "@/components/field/wire-flow"
import { wireMarks } from "@/components/field/wire-marks"
import { casingTrim, WIRE_PX } from "@/components/field/wire-style"
import { bandCasings, bandMarks, type BandPiece } from "@/components/field/rubber-band-layer"
import { WireSheet } from "@/schematic/wires/sheet"
import { PIN_MARK_CELLS } from "@/components/field/symbol-raster"

const c = (v: number) => v * GRID
const resistor = (id: string, x: number, y: number, rotation?: 90 | 45 | 135): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id }, ...(rotation && { rotation }) })
const pinAt = (o: PlacedObject, pin: string) => objectPins(o, GRID).find((p) => p.pin.id === pin)!.point
const seg = (id: string, a: Point, b: Point): WireSegment => ({ id, a, b })

function threeButted(): Schematic {
  const a = resistor("A", 0, 0)
  const b = resistor("B", 4, 0)
  const meet = pinAt(a, "2")
  const probe = resistor("C", 0, 0, 90)
  const top = [pinAt(probe, "1"), pinAt(probe, "2")].sort((p, q) => q.y - p.y)[0]
  const cpart: PlacedObject = { ...probe, x: probe.x + meet.x - top.x, y: probe.y + meet.y - top.y }
  return { objects: [a, b, cpart], wires: [], parts: {} }
}

function turnAtPin(): { doc: Schematic; pin: Point } {
  const upright = resistor("R3", 0, 0, 90)
  const pin = [pinAt(upright, "1"), pinAt(upright, "2")].sort((p, q) => q.y - p.y)[0]
  const lying = resistor("R4", 0, 0)
  const r4: PlacedObject = { ...lying, x: lying.x + pin.x + c(4) - pinAt(lying, "1").x, y: lying.y + pin.y - pinAt(lying, "1").y }
  return { doc: { objects: [upright, r4], wires: [seg("turn", pin, pinAt(r4, "1"))], parts: {} }, pin }
}

function cornerOfPins(): { doc: Schematic; at: Point } {
  const a = resistor("A", 0, 0)
  const at = pinAt(a, "2")
  const probe = resistor("C", 0, 0, 90)
  const top = [pinAt(probe, "1"), pinAt(probe, "2")].sort((p, q) => p.y - q.y)[0]
  return { doc: { objects: [a, { ...probe, x: probe.x + at.x - top.x, y: probe.y + at.y - top.y }], wires: [], parts: {} }, at }
}

function tee(): Schematic {
  const r1 = resistor("R1", 0, 0)
  const r2 = resistor("R2", 12, 0)
  const a = pinAt(r1, "2")
  const b = pinAt(r2, "1")
  const mid = { x: (a.x + b.x) / 2, y: a.y }
  return { objects: [r1, r2], wires: [seg("left", a, mid), seg("right", mid, b), seg("stub", mid, { x: mid.x, y: mid.y + c(3) })], parts: {} }
}

const colorOf = () => "black" as const

function layer(doc: Schematic, scale = 1) {
  const w = wiringOf(new WireGraph(), doc)
  const html = renderToStaticMarkup(
    React.createElement(WireLayer, {
      routes: w.routes,
      grid: GRID,
      scale,
      selected: new Set<string>(),
      hoveredNet: null,
      colorOf,
      netOfWire: (id: string) => w.nets.netOfWire(id),
      dots: w.dots,
      dangling: w.dangling,
      corners: w.corners,
      flow: new WireFlow(),
      onWirePointerDown: () => {},
      onWirePointerEnter: () => {},
      onWirePointerLeave: () => {},
    }),
  )
  return { w, html }
}

describe("junction dots, open ends and turns at pins are drawn wherever the graph has them (design.md §3.2, §3.3, §8)", () => {
  it("three pins butted at one point, with no wire there, get their dot in the symbols' ink", () => {
    const { w, html } = layer(threeButted())
    expect.soft(w.dots.length, "the graph's dot").toBe(1)
    expect.soft((html.match(/data-junction=/g) ?? []).length, "drawn").toBe(1)
    expect.soft(html.includes("fill-foreground"), "in ink").toBe(true)
    const marks = wireMarks(w.routes, w.dots, w.dangling, w.corners, colorOf, true)
    expect.soft(marks.dots.map((d) => d.color), "a dot with no wire has no wire colour").toEqual([null])
    expect.soft(wireMarks(w.routes, w.dots, w.dangling, w.corners, colorOf, false).dots, "the lifted layer draws only its own wires' marks").toEqual([])
  })

  it("a T gets its dot in the wire's colour and a dangling end its open mark", () => {
    const { w, html } = layer(tee())
    expect.soft((html.match(/data-junction=/g) ?? []).length, "the T").toBe(1)
    expect.soft((html.match(/data-dangling=/g) ?? []).length, "the stub's end").toBe(1)
    expect.soft(w.dangling.length, "one open end").toBe(1)
  })

  it("the canvas band and the PNG export paint the same marks: dots, open ends, corners and the turned leads", () => {
    const calls: string[] = []
    const context = new Proxy(
      {},
      {
        get: (_, name: string) => (name === "setTransform" || name === "save" || name === "restore" ? () => {} : (...args: unknown[]) => calls.push(`${name}:${args.length}`)),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D
    const realPath = (globalThis as { Path2D?: unknown }).Path2D
    ;(globalThis as { Path2D?: unknown }).Path2D = class {
      d: string
      constructor(d: string) {
        this.d = d
      }
    }
    try {
      const doc = tee()
      const w = wiringOf(new WireGraph(), doc)
      const butted = wiringOf(new WireGraph(), threeButted())
      const marks = wireMarks(w.routes, [...w.dots, ...butted.dots], w.dangling, [{ at: { x: 0, y: 0 }, a: { x: -7, y: 0 }, b: { x: 0, y: 7 } }], colorOf, true)
      paintMarks(context, w.routes, marks, { radius: 6, screenPx: (px) => px, pixels: 1, device: 1, grid: GRID, casing: "#fff", ink: "#000", colorFor: () => "#111", colorOf })
    } finally {
      ;(globalThis as { Path2D?: unknown }).Path2D = realPath
    }
    const count = (name: string) => calls.filter((call) => call.startsWith(`${name}:`)).length
    expect.soft(count("arc"), "two dots and one open end, no white ring round a dot (the user, 2026-11-11)").toBe(3)
    expect.soft(count("quadraticCurveTo"), "the corner").toBe(1)
    expect.soft(count("fill"), "every dot and the open end").toBe(3)
  })

  it("on the field a lead turned at its pin is hidden a stroke past the pin, so its round cap does not show beside the turn", () => {
    const { doc, pin } = turnAtPin()
    for (const scale of [1, 0.5]) {
      const { w, html } = layer(doc, scale)
      const lead = w.routes[0].leads?.start ?? w.routes[0].leads?.end
      expect.soft(lead, "the wire turns at the pin").toBeDefined()
      const masks = [...html.matchAll(/<path d="M([-\d.]+) ([-\d.]+) L([-\d.]+) ([-\d.]+)" fill="none" stroke="var\(--background\)"/g)].map((m) => m.slice(1, 5).map(Number))
      expect.soft(masks.length, `one mask at scale ${scale}`).toBe(1)
      const [, , x, y] = masks[0] ?? []
      const past = Math.hypot(x - pin.x, y - pin.y)
      expect.soft(past, `past the pin by the stroke at scale ${scale}`).toBeCloseTo(WIRE_PX / scale, 9)
      expect.soft(Math.hypot(x - lead!.x, y - lead!.y), `on the lead's line, beyond the pin, at scale ${scale}`).toBeCloseTo(Math.hypot(pin.x - lead!.x, pin.y - lead!.y) + past, 9)
    }
  })

  it("on the canvas and in the export a lead turned at its pin is hidden up to the pin and the pin's square with it, as the field shows a pin a wire meets", () => {
    const strokes: { style: string; points: Point[] }[] = []
    const squares: { style: string; x: number; y: number; w: number; h: number }[] = []
    let points: Point[] = []
    const context = {
      strokeStyle: "",
      fillStyle: "",
      lineCap: "",
      lineWidth: 0,
      beginPath: () => {
        points = []
      },
      moveTo: (x: number, y: number) => points.push({ x, y }),
      lineTo: (x: number, y: number) => points.push({ x, y }),
      stroke: (path?: unknown) => strokes.push({ style: context.strokeStyle, points: path ? [] : points }),
      fillRect: (x: number, y: number, w: number, h: number) => squares.push({ style: context.fillStyle, x, y, w, h }),
      quadraticCurveTo: () => {},
      arc: () => {},
      fill: () => {},
    }
    const realPath = (globalThis as { Path2D?: unknown }).Path2D
    ;(globalThis as { Path2D?: unknown }).Path2D = class {
      d: string
      constructor(d: string) {
        this.d = d
      }
    }
    const turn = turnAtPin()
    const corner = cornerOfPins()
    try {
      for (const doc of [turn.doc, corner.doc]) {
        const w = wiringOf(new WireGraph(), doc)
        paintMarks(context as unknown as CanvasRenderingContext2D, w.routes, wireMarks(w.routes, w.dots, w.dangling, w.corners, colorOf, true), { radius: 6, screenPx: (px) => px, pixels: 1, device: 1, grid: GRID, casing: "casing", ink: "ink", colorFor: () => "wire", colorOf })
      }
    } finally {
      ;(globalThis as { Path2D?: unknown }).Path2D = realPath
    }
    const same = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9
    const masks = strokes.filter((s) => s.style === "casing" && s.points.length === 2)
    expect.soft(masks.length, "the turned lead, and both leads of the corner").toBe(3)
    expect.soft(masks.filter((m) => same(m.points[1], turn.pin)).length, "the turned lead hidden up to its pin").toBe(1)
    expect.soft(masks.filter((m) => same(m.points[1], corner.at)).length, "both leads of the corner hidden up to the pin").toBe(2)
    const mark = GRID * PIN_MARK_CELLS
    const covers = (at: Point) => squares.some((q) => q.style === "casing" && q.x <= at.x - mark && q.y <= at.y - mark && q.x + q.w >= at.x + mark && q.y + q.h >= at.y + mark)
    expect.soft(covers(turn.pin), "the turned pin's square is covered").toBe(true)
    expect.soft(covers(corner.at), "the corner's square is covered").toBe(true)
  })
})

describe("the rubber band's own marks: a dragged wire carries its open ends and dots (the user's picture 13)", () => {
  const p = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
  const piece = (a: Point, b: Point): BandPiece => ({ a, b, color: "red" })
  const keys = (marks: readonly { at: Point }[]) => marks.map(({ at }) => `${at.x / GRID},${at.y / GRID}`).sort()

  it("a free L moved whole: a ring on each of its new ends, nothing at its corner, nothing where it was", () => {
    const sheet = WireSheet.of([seg("h", p(2, 4), p(9, 4)), seg("v", p(9, 4), p(9, 1))], [])
    const marks = bandMarks([piece(p(5, 7), p(12, 7)), piece(p(12, 7), p(12, 4))], sheet, new Set(["h", "v"]), new Map())
    expect.soft(keys(marks.open), "the two new ends").toEqual(["12,4", "5,7"])
    expect.soft(marks.dots, "no dot").toEqual([])
  })

  it("an end dropped on another wire's middle, on a pin, or on a carried pin is not open; on the middle it is a T with a dot", () => {
    const sheet = WireSheet.of([seg("bus", p(0, 10), p(20, 10)), seg("w", p(5, 0), p(5, 4))], [{ key: "R1:1", at: p(8, 0) }, { key: "R2:2", at: p(3, 3) }])
    const hidden = new Set(["w"])
    const onBus = bandMarks([piece(p(5, 0), p(5, 10))], sheet, hidden, new Map())
    expect.soft(keys(onBus.dots), "a T on the bus").toEqual(["5,10"])
    expect.soft(keys(onBus.open), "the far end, still open").toEqual(["5,0"])
    const onPin = bandMarks([piece(p(8, 0), p(8, 4))], sheet, hidden, new Map())
    expect.soft(keys(onPin.open), "the end on R1's pin is not open").toEqual(["8,4"])
    const onCarried = bandMarks([piece(p(5, 0), p(5, 6))], sheet, hidden, new Map([["R2:2", p(5, 6)]]))
    expect.soft(keys(onCarried.open), "the end on the carried pin where it lands is not open").toEqual(["5,0"])
    const leftByCarried = bandMarks([piece(p(3, 0), p(3, 3))], sheet, hidden, new Map([["R2:2", p(9, 9)]]))
    expect.soft(keys(leftByCarried.open), "a pin carried away leaves the end open").toEqual(["3,0", "3,3"])
  })

  it("three dragged ends meeting get a dot; the wire hidden by the band does not count", () => {
    const sheet = WireSheet.of([seg("a", p(0, 0), p(4, 0)), seg("b", p(4, 0), p(8, 0)), seg("c", p(4, 0), p(4, 4))], [])
    const marks = bandMarks([piece(p(0, 2), p(4, 2)), piece(p(4, 2), p(8, 2)), piece(p(4, 2), p(4, 6))], sheet, new Set(["a", "b", "c"]), new Map())
    expect.soft(keys(marks.dots), "the moved T").toEqual(["4,2"])
    expect.soft(keys(marks.open), "its three open ends").toEqual(["0,2", "4,6", "8,2"])
  })

  it("a dragged branch ending on the middle of a dragged bus is a T; one ending where a dragged-away wire passed is open", () => {
    const sheet = WireSheet.of([seg("bus", p(0, 0), p(8, 0)), seg("w", p(5, 0), p(5, 10))], [])
    const tee = bandMarks([piece(p(0, 2), p(8, 2)), piece(p(4, 2), p(4, 6))], sheet, new Set(["bus"]), new Map())
    expect.soft(keys(tee.dots), "the T on the band's own bus").toEqual(["4,2"])
    const left = bandMarks([piece(p(1, 5), p(5, 5))], sheet, new Set(["w"]), new Map())
    expect.soft(keys(left.open), "the wire it touched is the one being dragged").toEqual(["1,5", "5,5"])
  })
})

describe("the rubber band's casings stop short of its ends, as a laid wire's do: nothing white is painted over the wire, pin or dot an end lands on (the user, 2026-11-12: a white patch on the wire the end met)", () => {
  const p = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
  const piece = (a: Point, b: Point): BandPiece => ({ a, b, color: "red" })
  const trim = casingTrim(GRID)
  const shown = (casings: readonly { a: Point; b: Point }[]) => casings.map(({ a, b }) => `${a.x},${a.y} ${b.x},${b.y}`)

  it("a lone piece ending on another wire: its casing is trimmed at both ends, by the laid wire's trim", () => {
    expect(shown(bandCasings([piece(p(10, 5), p(10, 3))], trim))).toEqual([`${c(10)},${c(5) - trim} ${c(10)},${c(3) + trim}`])
  })

  it("an L: trimmed at its two ends, unbroken round its corner", () => {
    expect(shown(bandCasings([piece(p(4, 1), p(10, 1)), piece(p(10, 1), p(10, 3))], trim))).toEqual([`${c(4) + trim},${c(1)} ${c(10)},${c(1)}`, `${c(10)},${c(1)} ${c(10)},${c(3) - trim}`])
  })

  it("a branch ending on the middle of a piece: the branch's end is trimmed, the piece it meets runs on whole there", () => {
    const casings = shown(bandCasings([piece(p(0, 2), p(8, 2)), piece(p(4, 2), p(4, 6))], trim))
    expect(casings).toEqual([`${c(0) + trim},${c(2)} ${c(8) - trim},${c(2)}`, `${c(4)},${c(2) + trim} ${c(4)},${c(6) - trim}`])
  })

  it("a piece shorter than two trims keeps its middle, as trimRouteEnds does", () => {
    const short = shown(bandCasings([piece(p(2, 2), { x: c(2) + trim, y: c(2) })], trim))
    expect(short).toEqual([`${c(2) + trim / 2},${c(2)} ${c(2) + trim / 2},${c(2)}`])
  })
})
