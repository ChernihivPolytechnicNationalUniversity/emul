import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { builder, legacyOf } from "@/schematic/builder"
import { circuitOf } from "@/schematic/circuit"
import { ContactIndex, contactsAfterMove, pinContacts } from "@/schematic/contacts"
import { SpatialIndex } from "@/schematic/spatial"
import { examples, lab1Stand } from "@/schematic/examples"
import { GRID, objectPins, objectRect, toPath, type Point } from "@/schematic/geometry"
import { autoNetColor, semanticNetColor, WIRE_COLORS } from "@/schematic/wire-colors"
import { nearestOn, pinsOf, tapWireAt, wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey, type ComponentDef, type PinKind, type PlacedObject, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { TopologyGate } from "@/sim/topology"
import { exampleBase64 } from "../lib/firmware"

const route = (doc: Schematic, id: string) => ({ pts: wiringOf(new WireGraph(), doc).runs.find((r) => r.segments.some((s) => s.id === id))!.points })
const wiring = (doc: Schematic) => wiringOf(new WireGraph(), doc)
const horizontal = (a: Point, b: Point) => a.y === b.y
function crosses(pts: readonly Point[], r: { x: number; y: number; w: number; h: number }) {
  const [x0, x1, y0, y1] = [r.x + 0.5, r.x + r.w - 0.5, r.y + 0.5, r.y + r.h - 0.5]
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]
    const q = pts[i]
    const hit = horizontal(p, q)
      ? p.y > y0 && p.y < y1 && Math.max(p.x, q.x) > x0 && Math.min(p.x, q.x) < x1
      : p.x > x0 && p.x < x1 && Math.max(p.y, q.y) > y0 && Math.min(p.y, q.y) < y1
    if (hit) return true
  }
  return false
}

describe("routing", () => {
  it("runs a straight line between two pins on one level, with no stub vertex between them (design.md §4.1)", () => {
    const { doc, place, wire } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 10, 0)
    const w = wire(r1, "2", r2, "1")
    const r = route(doc, w.id)
    expect.soft(new Set(r.pts.map((p) => p.y)).size, "every point on one line").toBe(1)
    expect.soft(r.pts.map((p) => p.x).sort((a, b) => a - b), "from R1 pin 2 to R2 pin 1, the one segment").toEqual([4 * GRID, 10 * GRID])
  })

  it("a pin on a diagonal is a corner of its part's square, on the grid, and the wire from it is orthogonal on the grid from the pin on (design.md §4.1: no stub, at 45° or otherwise)", () => {
    const { doc, place, wire } = builder(GRID)
    const r1 = place("resistor", 0, 0, {}, 45)
    const r2 = place("resistor", 12, 6)
    const w = wire(r1, "2", r2, "1")
    const r = route(doc, w.id)
    expect.soft(r.pts.every((p) => p.x % GRID === 0 && p.y % GRID === 0), "every vertex, the pin included, on the grid").toBe(true)
    expect.soft(r.pts.every((p, i, a) => i === 0 || p.x === a[i - 1].x || p.y === a[i - 1].y), "every piece orthogonal").toBe(true)
  })

  it("routes around a component in the way, not through it", () => {
    const { doc, place, wire } = builder(GRID)
    const a = place("resistor", 0, 0)
    const b = place("resistor", 20, 0)
    const between = place("resistor", 10, 0)
    const w = wire(a, "2", b, "1")
    expect(crosses(route(doc, w.id).pts, objectRect(between, GRID))).toBe(false)
  })

  it("rounds corners", () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]
    const d = toPath(square, 10)
    expect.soft(d.includes("Q"), "a corner becomes a quadratic").toBe(true)
    expect.soft(d.startsWith("M0 0"), "starts where the polyline starts").toBe(true)
    expect.soft(d.endsWith("L100 100"), "ends where the polyline ends").toBe(true)
    const collinear: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ]
    expect.soft(toPath(collinear, 10).includes("Q"), "a straight-through point is not rounded").toBe(false)
    const tiny: Point[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 40 },
    ]
    expect.soft(toPath(tiny, 10).includes("L2 0"), "the radius is clamped to the short leg").toBe(true)
  })
})

describe("nets and colours", () => {
  it("makes wires and touching pins one node", () => {
    const { doc, place, wire } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 10, 0)
    const r3 = place("resistor", 14, 0)
    const gnd = place("ground", 20, 4)
    wire(r1, "2", r2, "1")
    wire(r3, "2", gnd, "GND")
    const { nets } = wiring(doc)
    const netOf = (obj: { id: string }, pin: string) => nets.netOfPin(pinKey(obj.id, pin))
    expect.soft(netOf(r1, "2") === netOf(r2, "1"), "a wire joins its two pins").toBe(true)
    expect.soft(netOf(r2, "2") === netOf(r3, "1"), "touching pins join without a wire").toBe(true)
    expect.soft(netOf(r3, "2") === netOf(gnd, "GND"), "the ground is on R3's far pin").toBe(true)
    expect.soft(netOf(r1, "1") === netOf(r1, "2"), "a component does not join its own pins").toBe(false)
    expect.soft(nets.nets.length, "two nets").toBe(2)
  })

  it("colours a net automatically by what is on it", () => {
    const kinds = (...k: PinKind[]) => new Set(k)
    expect.soft(autoNetColor(kinds("digital", "gnd")), "a net with a ground pin is black").toBe("black")
    expect.soft(autoNetColor(kinds("digital", "power")), "a net with a rail is red").toBe("red")
    expect.soft(autoNetColor(kinds("power", "gnd")), "a ground wins over a rail — that net is a short").toBe("black")
    expect.soft(autoNetColor(kinds("digital", "analog")), "an ordinary signal is the default black").toBe("black")
    expect.soft(semanticNetColor(kinds("digital", "analog")), "and has no colour of its own to keep").toBeUndefined()

    const { doc, place, wire } = builder(GRID)
    const r = place("resistor", 0, 0)
    const gnd = place("ground", 8, 4)
    wire(r, "2", gnd, "GND")
    const { nets, runs } = wiring(doc)
    expect.soft(autoNetColor(nets.kindsOf(nets.netOfWire(runs[0].id)!)), "read off a real document").toBe("black")
  })

  describe("every wire colour has a flow colour that reads against it", () => {
    const css = readFileSync(new URL("../../src/index.css", import.meta.url), "utf8")
    const lightness = (block: string, name: string) => {
      const m = block.match(new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)`))
      return m ? Number(m[1]) : NaN
    }
    const blocks = {
      light: css.slice(css.indexOf(":root {"), css.indexOf(".dark {")),
      dark: css.slice(css.indexOf(".dark {")),
    }
    const MIN_DELTA = 0.22

    it.each(Object.keys(blocks) as (keyof typeof blocks)[])("in the %s theme", (theme) => {
      for (const key of WIRE_COLORS) {
        const delta = Math.abs(lightness(blocks[theme], `wire-${key}`) - lightness(blocks[theme], `wire-${key}-flow`))
        expect.soft(delta, key).toBeGreaterThanOrEqual(MIN_DELTA)
      }
    })

    it.each(Object.keys(blocks) as (keyof typeof blocks)[])("a black wire is the symbols' ink in the %s theme (the user, 2026-11-16: wires looked grey beside the parts)", (theme) => {
      const ink = (name: string) => blocks[theme].match(new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`))?.[1]
      expect.soft(ink("wire-black"), "--wire-black equals --foreground").toBe(ink("foreground"))
    })

    it("has both tokens for every colour", () => {
      const missing = WIRE_COLORS.filter((k) => Number.isNaN(lightness(blocks.light, `wire-${k}-flow`)) || Number.isNaN(lightness(blocks.dark, `wire-${k}-flow`)))
      expect(missing).toEqual([])
    })
  })
})

describe("tapping a wire", () => {
  const ends = (doc: Schematic, p: Point) => doc.wires.filter((w) => (w.a.x === p.x && w.a.y === p.y) || (w.b.x === p.x && w.b.y === p.y)).length
  const shapeOf = (wires: readonly WireSegment[]) => wires.map((w) => [w.a, w.b].map((q) => `${q.x},${q.y}`).sort().join(" ")).sort().join("|")

  it("ends the new wire on it: the wire splits there, a dot marks the branch, no junction part, and the nets join", () => {
    const { doc: built, place, wire } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 16, 0)
    const r3 = place("resistor", 8, 6)
    const w = wire(r1, "2", r2, "1")
    w.color = "blue"
    const doc: Schematic = { ...built }
    const beside = { x: 9 * GRID + 5, y: 1 * GRID + 7 }
    const tapped = tapWireAt(doc, w.id, beside, { object: r3.id, pin: "1" })
    const tap = { x: 9 * GRID, y: GRID }
    expect.soft(tapped.objects.length, "no part added").toBe(doc.objects.length)
    expect.soft(ends(tapped, tap), "three wire ends where the tap projects, snapped along the wire").toBe(3)
    expect.soft(wiring(tapped).dots, "the branch is a dot").toContainEqual(tap)
    expect.soft(tapped.wires.filter((x) => x.a.y === GRID && x.b.y === GRID && x.color === "blue").length, "both halves keep the colour").toBe(2)
    const { nets } = wiring(tapped)
    const net = nets.netOfPin(pinKey(r1.id, "2"))
    expect.soft([pinKey(r2.id, "1"), pinKey(r3.id, "1")].every((k) => nets.netOfPin(k) === net), "R1, R2 and R3 are one net").toBe(true)

    expect.soft(shapeOf(tapWireAt(doc, w.id, beside, { object: r1.id, pin: "2" }).wires), "a tap from the wire's own end lies along it and merges into it").toBe(shapeOf(doc.wires))
    expect.soft(tapWireAt(doc, "nope", beside, { object: r3.id, pin: "1" }) === doc, "an unknown wire changes nothing").toBe(true)
  })

  it("leaves both halves of a tapped wire on its row and meets it along the tap's own axis", () => {
    const { doc: built, place, wire } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 16, 0)
    const r3 = place("resistor", 8, 6)
    const w = wire(r1, "2", r2, "1")
    const doc: Schematic = { ...built }
    const tapped = tapWireAt(doc, w.id, { x: 9 * GRID + 5, y: 1 * GRID + 7 }, { object: r3.id, pin: "1" })
    const onRow = tapped.wires.filter((x) => x.a.y === GRID && x.b.y === GRID)
    expect.soft(onRow.length, "the two halves on the wire's row").toBe(2)
    const into = tapped.wires.filter((x) => !onRow.includes(x) && ((x.a.x === 9 * GRID && x.a.y === GRID) || (x.b.x === 9 * GRID && x.b.y === GRID)))
    expect.soft(into.length === 1 && into[0].a.x === into[0].b.x, `the tap comes up into the wire rather than along it: ${JSON.stringify(into)}`).toBe(true)
  })

  it("lays a wire between two branch points on one row straight, either way round", () => {
    const { doc, wire, node } = builder(GRID)
    const left = node(1, 1)
    const right = node(11, 1)
    wire(left, "J", right, "J")
    wire(right, "J", left, "J")
    for (const s of doc.wires) expect.soft(s.a.y === GRID && s.b.y === GRID, JSON.stringify(s)).toBe(true)
  })

  it("ties two MCU pins to one button by ending the second wire on the first (the PG2/PG3 stand)", () => {
    const built = lab1Stand.build(GRID)
    const dd = built.objects.find((o) => o.def === "stm32f746ig")!
    const byRef = (ref: string) => built.objects.find((o) => o.props?.ref === ref)!
    const pg3 = legacyOf(built).wires.find((w) => w.from.object === dd.id && w.from.pin === "PG3")!
    const doc: Schematic = { ...built }
    const run = wiring(doc).runs.find((r) => r.segments.some((x) => x.id === pg3.id))!
    const middle = run.segments[Math.floor(run.segments.length / 2)]
    const mid = { x: (middle.a.x + middle.b.x) / 2, y: (middle.a.y + middle.b.y) / 2 }
    const tapped = tapWireAt(doc, middle.id, { x: mid.x + 3, y: mid.y - 4 }, { object: dd.id, pin: "PG2" })
    const { nets, runs, dots } = wiring(tapped)
    expect.soft(nets.netOfPin(pinKey(dd.id, "PG2")) === nets.netOfPin(pinKey(dd.id, "PG3")), "PG2 and PG3 are one net").toBe(true)
    expect.soft(nets.netOfPin(pinKey(dd.id, "PG2")) === nets.netOfPin(pinKey(byRef("SA3").id, "1")), "…with SA3's contact").toBe(true)
    expect.soft(nets.netOfPin(pinKey(dd.id, "PG2")) === nets.netOfPin(pinKey(byRef("SA2").id, "1")), "SA2's contact is on it too").toBe(true)
    const endsAt = (r: (typeof runs)[number], p: Point) => [r.points[0], r.points[r.points.length - 1]].some((q) => q.x === p.x && q.y === p.y)
    const branch = nearestOn(middle, { x: mid.x + 3, y: mid.y - 4 })
    expect.soft(dots, "the branch is a dot").toContainEqual(branch)
    const atBranch = runs.filter((r) => endsAt(r, branch))
    expect.soft(atBranch.length, "three runs meet at the branch").toBe(3)

    dd.props = { ...dd.props, firmware: "lab1-f746.elf", firmwareData: exampleBase64("lab1-f746.elf") }
    const loop = new SimLoop()
    loop.setDoc(tapped)
    loop.setParts(tapped.parts)
    loop.setRunning(true)
    let clock = 0
    const runFor = (seconds: number) => {
      const end = clock + seconds * 1000
      while (clock < end) {
        clock = Math.min(end, clock + 10)
        loop.advance(clock)
      }
      return loop.snapshot()!
    }
    const v = (pin: string) => loop.snapshot()!.pinVoltage[pinKey(dd.id, pin)]!
    runFor(0.1)
    expect.soft(Math.min(v("PG2"), v("PG3")), "both pins idle high on their pull-ups").toBeNear(3.3, 0.05)
    loop.setParts({ [partKey(byRef("SA3").id, "SW")]: { pressed: true } })
    const snap = runFor(0.05)
    expect.soft(v("PG3"), "SA3 pressed: PG3 low").toBeNear(0, 0.05)
    expect.soft(v("PG2"), "SA3 pressed: PG2 low through the branch").toBeNear(0, 0.05)
    const inward = atBranch.map((r) => {
      const amps = snap.wireCurrent[r.id] ?? 0
      const last = r.points[r.points.length - 1]
      return last.x === branch.x && last.y === branch.y ? amps : -amps
    })
    expect.soft(Math.abs(inward.reduce((a, b) => a + b, 0)) * 1e6, "what comes into the branch goes out of it (µA)").toBeNear(0, 1)
    expect.soft(Math.min(...inward.map(Math.abs)) * 1e6, "each pin contributes (µA)").toBeGreaterThan(10)
    loop.setParts({ [partKey(byRef("SA3").id, "SW")]: { pressed: false }, [partKey(byRef("SA2").id, "SW")]: { pressed: true } })
    runFor(0.05)
    expect.soft(v("PG3"), "SA2 pressed instead: PG3 follows PG2").toBeNear(0, 0.05)
    loop.setParts({ [partKey(byRef("SA2").id, "SW")]: { pressed: false } })
    runFor(0.05)
    expect.soft(Math.min(v("PG2"), v("PG3")), "released: both back high").toBeNear(3.3, 0.05)
  })
})

describe("contacts follow a drag before it lands", () => {
  const movedBy = (objects: readonly PlacedObject[], moving: ReadonlySet<string>, dx: number, dy: number) =>
    objects.map((o) => (moving.has(o.id) ? { ...o, x: o.x + dx, y: o.y + dy } : o))
  const touching = (objects: readonly PlacedObject[]) => new Set(new ContactIndex().of(objects, GRID).groups.keys())
  const committedChanges = (objects: readonly PlacedObject[], moving: ReadonlySet<string>, dx: number, dy: number) => {
    const before = touching(objects)
    const after = touching(movedBy(objects, moving, dx, dy))
    return [...new Set([...before, ...after])].filter((key) => before.has(key) !== after.has(key)).map((key) => `${key}=${after.has(key)}`).sort()
  }
  const previewed = (changes: ReadonlyMap<string, { contact: boolean }>) => [...changes].map(([key, c]) => `${key}=${c.contact}`).sort()

  it("the 7-inch LCD lifted off P15 parts every pin it had docked, and lands back on them", () => {
    const doc = examples.find((e) => e.id === "open746-lcd")!.build(GRID)
    const lcd = doc.objects.find((o) => o.def === "lcd7-f")!
    const moving = new Set([lcd.id])
    const docked = [...pinContacts(doc.objects, GRID).groups.keys()]
    const changes = contactsAfterMove(doc.objects, moving, GRID)
    const lifted = changes(0, 3 * GRID)
    expect.soft(docked.length, "the panel starts docked on its pins").toBeGreaterThanOrEqual(80)
    expect.soft([...lifted.keys()].sort(), "three cells down, every docked pin on both sides parts").toEqual(docked.sort())
    expect.soft(changes(0, GRID).size, "one cell down, the top row sits on P15's bottom row: only half part").toBe(docked.length / 2)
    expect.soft([...lifted.values()].every((c) => !c.contact), "…and none of them is in contact").toBe(true)
    expect.soft(changes(0, 0).size, "back where it was, nothing differs").toBe(0)
    expect.soft(changes(GRID * 40, GRID * 40).size, "far away, the same pins as three cells off").toBe(docked.length)
  })

  it("a resistor slid onto another's lead meets it, and slides off again", () => {
    const { doc, place } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 6, 0)
    const changes = contactsAfterMove(doc.objects, new Set([r2.id]), GRID)
    expect.soft(previewed(changes(-2 * GRID, 0)), "R2.1 lands on R1.2").toEqual([`${pinKey(r1.id, "2")}=true`, `${pinKey(r2.id, "1")}=true`].sort())
    expect.soft(changes(-GRID, 0).size, "a cell short of it, no contact").toBe(0)
  })

  it("a pin that sticks out past its part's box is still seen through the spatial index, across a bucket edge", () => {
    const lcd: PlacedObject = { id: "lcd", def: "lcd7-f", x: 0, y: 33 * GRID }
    const pin1 = objectPins(lcd, GRID).find(({ pin }) => pin.id === "1")!.point
    const probe = objectPins({ id: "probe", def: "resistor", x: 0, y: 0 }, GRID).find(({ pin }) => pin.id === "2")!.point
    const r: PlacedObject = { id: "r", def: "resistor", x: pin1.x - probe.x, y: pin1.y - probe.y }
    const objects = [lcd, r]
    expect.soft(Math.floor(objectRect(r, GRID).y / (32 * GRID)), "the resistor sits a spatial bucket above the LCD's box").toBeLessThan(Math.floor(objectRect(lcd, GRID).y / (32 * GRID)))
    expect.soft(pinContacts(objects, GRID).groups.has(pinKey("r", "2")), "the resistor touches LCD pin 1").toBe(true)
    const index = new SpatialIndex(objects, GRID)
    const changes = contactsAfterMove(objects, new Set(["lcd"]), GRID, (area) => index.query(area))(0, GRID)
    expect.soft(previewed(changes), "a cell down, both part").toEqual(committedChanges(objects, new Set(["lcd"]), 0, GRID))
    expect.soft(changes.size, "…and there is something to part").toBe(2)
    const fromTheResistor = contactsAfterMove(objects, new Set(["r"]), GRID, (area) => index.query(area))(0, -GRID)
    expect.soft(previewed(fromTheResistor), "the resistor carried a cell up off the still LCD parts too").toEqual(committedChanges(objects, new Set(["r"]), 0, -GRID))
    expect.soft(fromTheResistor.size, "…both pins").toBe(2)
  })

  it("pins either side of a pixel's edge, 0.006 px apart, meet for the preview as for the commit", () => {
    const objects: PlacedObject[] = [
      { id: "a", def: "resistor", x: 0.497, y: 0 },
      { id: "b", def: "resistor", x: 96.503, y: 0 },
    ]
    const [aEnd] = objectPins(objects[0], GRID).filter(({ pin }) => pin.id === "2").map(({ point }) => point.x)
    const [bEnd] = objectPins(objects[1], GRID).filter(({ pin }) => pin.id === "1").map(({ point }) => point.x)
    expect.soft(Math.round(aEnd) !== Math.round(bEnd), "the two pins round to different pixels").toBe(true)
    expect.soft(pinContacts(objects, GRID).groups.size, "the commit joins them").toBe(2)
    expect.soft(previewed(contactsAfterMove(objects, new Set(["b"]), GRID)(0, GRID)), "a cell down they part").toEqual(committedChanges(objects, new Set(["b"]), 0, GRID))
  })

  it("a contact the drag makes knows the pins it meets, so the dot can take their net's colour", () => {
    const { doc, place } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 6, 0)
    const meeting = contactsAfterMove(doc.objects, new Set([r2.id]), GRID)(-2 * GRID, 0)
    expect.soft(meeting.get(pinKey(r2.id, "1"))?.touching, "R2.1 meets R1.2").toEqual([pinKey(r1.id, "2")])
    expect.soft(meeting.get(pinKey(r1.id, "2"))?.touching, "…and R1.2 meets R2.1").toEqual([pinKey(r2.id, "1")])
  })

  it("pins a few thousandths of a pixel apart are in contact for the preview exactly as for the commit", () => {
    const objects: PlacedObject[] = [
      { id: "a", def: "resistor", x: 0, y: 0 },
      { id: "b", def: "resistor", x: 96.005, y: 0 },
    ]
    expect.soft(pinContacts(objects, GRID).groups.size, "the commit joins them").toBe(2)
    expect.soft(previewed(contactsAfterMove(objects, new Set(["b"]), GRID)(0, GRID)), "a cell down they part").toEqual(committedChanges(objects, new Set(["b"]), 0, GRID))
  })

  it("two parts carried from opposite corners of a big sheet look only around themselves", () => {
    const tiles: PlacedObject[] = []
    for (let row = 0; row < 20; row++) for (let col = 0; col < 20; col++) tiles.push({ id: `t${row}-${col}`, def: "resistor", x: col * 10 * GRID, y: row * 10 * GRID })
    const index = new SpatialIndex(tiles, GRID)
    const seen = new Set<string>()
    const near = (area: { x: number; y: number; w: number; h: number }) => {
      const found = index.query(area)
      for (const o of found) seen.add(o.id)
      return found
    }
    contactsAfterMove(tiles, new Set(["t0-0", "t19-19"]), GRID, near)(GRID, 0)
    expect(seen.size, "a handful of neighbours, not the 400 parts between them").toBeLessThan(40)
  })

  it("only pins touching across the move change: two parts carried together keep their own contact", () => {
    const { doc, place } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 4, 0)
    const r3 = place("resistor", 8, 0)
    const changes = contactsAfterMove(doc.objects, new Set([r1.id, r2.id]), GRID)
    expect.soft(previewed(changes(0, GRID)), "R2–R3 parts, R1–R2 stays").toEqual([`${pinKey(r2.id, "2")}=false`, `${pinKey(r3.id, "1")}=false`].sort())
  })

  const offsets = [
    [1, 0],
    [0, -1],
    [-2, 0],
    [3, 2],
    [0, 4],
  ] as const
  it.each(examples.map((e) => [e.id, e] as const))("matches what the commit would find on %s", (_, example) => {
    const { objects } = example.build(GRID)
    const mismatches: string[] = []
    for (const o of objects) {
      const moving = new Set([o.id])
      const changes = contactsAfterMove(objects, moving, GRID)
      for (const [cx, cy] of offsets) {
        const got = previewed(changes(cx * GRID, cy * GRID)).join(" ")
        const want = committedChanges(objects, moving, cx * GRID, cy * GRID).join(" ")
        if (got !== want) mismatches.push(`${o.props?.ref ?? o.def} by (${cx}, ${cy}): ${got} ≠ ${want}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it("matches the commit on 400 objects piled on 25×25 cells, a block of them at a time", () => {
    let seed = 20261001
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const jumbled: PlacedObject[] = []
    for (let i = 0; i < 400; i++) {
      jumbled.push({
        id: `j${i}`,
        def: ["resistor", "led", "ground", "pushbutton"][Math.floor(random() * 4)],
        x: Math.round(random() * 24) * GRID,
        y: Math.round(random() * 24) * GRID,
        rotation: ([0, 45, 90, 135, 180, 225, 270, 315] as const)[Math.floor(random() * 8)],
      })
    }
    let seen = 0
    for (let start = 0; start < 400; start += 40) {
      const moving = new Set(jumbled.slice(start, start + 7).map((o) => o.id))
      const changes = contactsAfterMove(jumbled, moving, GRID)
      for (const [cx, cy] of offsets) {
        const got = previewed(changes(cx * GRID, cy * GRID))
        seen += got.length
        expect.soft(got, `block at ${start} by (${cx}, ${cy})`).toEqual(committedChanges(jumbled, moving, cx * GRID, cy * GRID))
      }
    }
    expect.soft(seen, "…and the moves did make and break contacts").toBeGreaterThan(0)
  })
})

describe("caching", () => {
  it("answers with the same contact map until the answer changes", () => {
    const { doc, place } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 20, 0)
    const at = (o: { id: string }, x: number): Schematic => ({ ...doc, objects: doc.objects.map((p) => (p.id === o.id ? { ...p, x: x * GRID } : p)) })

    const apart = pinContacts(doc.objects, GRID)
    expect.soft(pinContacts(doc.objects, GRID) === apart, "asking twice about one document").toBe(true)
    expect.soft(apart.groups.size, "nothing touches to begin with").toBe(0)
    const shifted = at(r2, 30)
    expect.soft(pinContacts(shifted.objects, GRID) === apart, "a move that touches nothing keeps the same map").toBe(true)
    const meeting = at(r2, 4)
    const met = pinContacts(meeting.objects, GRID)
    expect.soft(met === apart, "a move that lands a pin on another does not").toBe(false)
    expect.soft(met.groups.size, "…and the two pins are grouped").toBe(2)
    expect.soft(met.kinds.size, "…and the kinds came with them").toBe(2)
    expect.soft([...met.groups.keys()].sort(), "the pins are R1.2 and R2.1").toEqual([pinKey(r1.id, "2"), pinKey(r2.id, "1")].sort())
    expect.soft(pinContacts(at(r2, 4).objects, GRID) === met, "…and asking again about the same contact keeps the map").toBe(true)
    const parted = pinContacts(at(r2, 20).objects, GRID)
    expect.soft(parted.groups.size, "moving apart again drops the contact").toBe(0)
    expect.soft(pinContacts(at(r2, 25).objects, GRID) === parted, "…and settles back on the empty map").toBe(true)
  })

  it("tells the solver about the document only when the circuit changed: the pin partition, not the geometry", () => {
    const gate = new TopologyGate()
    const { doc: built, place, wire } = builder(GRID)
    const r1 = place("resistor", 0, 0)
    const r2 = place("resistor", 20, 0)
    const gnd = place("ground", 30, 4)
    wire(r2, "2", gnd, "GND")
    const doc: Schematic = { ...built }
    const shift = (o: { id: string }, x: number): Schematic => ({ ...doc, objects: doc.objects.map((p) => (p.id === o.id ? { ...p, x: x * GRID } : p)) })
    const sent = (d: Schematic) => gate.latest(circuitOf(d))

    const first = sent(doc)
    expect.soft(sent(doc) === first, "the same document twice is sent once").toBe(true)
    expect.soft(sent(shift(r1, -10)) === first, "a move that connects nothing is not resent").toBe(true)
    const met = sent(shift(r1, 16))
    expect.soft(met !== first, "a move that lands a pin on another is").toBe(true)
    expect.soft(sent(shift(r1, 16)) === met, "…and staying there is not").toBe(true)
    const apart = sent(shift(r1, 0))
    expect.soft(apart !== met, "moving apart again is").toBe(true)

    const settled = sent(doc)
    const coloured: Schematic = { ...doc, wires: doc.wires.map((x) => ({ ...x, color: "blue" as const })) }
    expect.soft(sent(coloured) === settled, "a wire recoloured is not").toBe(true)
    const stub: Schematic = { ...coloured, wires: [...coloured.wires, { id: "stub", a: { x: 50 * GRID, y: 0 }, b: { x: 54 * GRID, y: 0 } }] }
    expect.soft(sent(stub) === settled, "a wire drawn into empty space is not").toBe(true)
    const rotated: Schematic = { ...stub, objects: stub.objects.map((o) => (o.id === gnd.id ? { ...o, rotation: 90 as const } : o)) }
    expect.soft(sent(rotated) !== settled, "a rotation that takes a pin off its wire is").toBe(true)
    const revalued: Schematic = { ...stub, objects: stub.objects.map((o) => (o.id === r1.id ? { ...o, props: { ...o.props, value: "2 kΩ" } } : o)) }
    const valued = sent(revalued)
    expect.soft(valued !== settled, "a component's value is").toBe(true)
    const unwired: Schematic = { ...revalued, wires: revalued.wires.filter((x) => x.id === "stub") }
    expect.soft(sent(unwired) !== valued, "a wire removed is").toBe(true)
  })
})

describe("coincident pins, against a brute-force sweep over every pair", () => {
  const EPS = 0.01
  const brute = (objects: readonly PlacedObject[]) => {
    const placed = objects.flatMap((o) => objectPins(o, GRID).filter((p) => p.pin.kind !== "nc"))
    const parent = new Map<string, string>()
    const find = (k: string): string => {
      const p = parent.get(k)
      if (p === undefined || p === k) return k
      const root = find(p)
      parent.set(k, root)
      return root
    }
    const joined = new Set<string>()
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]
        const b = placed[j]
        if (a.key === b.key || Math.abs(a.point.x - b.point.x) >= EPS || Math.abs(a.point.y - b.point.y) >= EPS) continue
        joined.add(a.key)
        joined.add(b.key)
        const ra = find(a.key)
        const rb = find(b.key)
        if (ra !== rb) parent.set(ra, rb)
      }
    }
    const out = new Map<string, string>()
    for (const key of joined) out.set(key, find(key))
    return out
  }
  const partition = (m: ReadonlyMap<string, string>) => {
    const groups = new Map<string, string[]>()
    for (const [key, root] of m) {
      const list = groups.get(root)
      if (list) list.push(key)
      else groups.set(root, [key])
    }
    return [...groups.values()].map((list) => [...list].sort().join(" ")).sort().join(" | ")
  }

  it.each(examples.map((e) => [e.id, e] as const))("on %s", (_, example) => {
    const objects = example.build(GRID).objects
    expect(partition(pinContacts(objects, GRID).groups)).toBe(partition(brute(objects)))
  })

  it("on 400 objects piled on 25×25 cells", () => {
    let seed = 20260917
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const jumbled: PlacedObject[] = []
    for (let i = 0; i < 400; i++) {
      const def = ["resistor", "led", "ground", "pushbutton"][Math.floor(random() * 4)]
      jumbled.push({
        id: `j${i}`,
        def,
        x: Math.round(random() * 24) * GRID,
        y: Math.round(random() * 24) * GRID,
        rotation: ([0, 45, 90, 135, 180, 225, 270, 315] as const)[Math.floor(random() * 8)],
      })
    }
    const found = partition(pinContacts(jumbled, GRID).groups)
    expect.soft(found).toBe(partition(brute(jumbled)))
    expect.soft(found.length, "…and it found contacts to compare").toBeGreaterThan(0)
  })

  it("at a cell edge", () => {
    const pinOffset = objectPins({ id: "probe", def: "ground", x: 0, y: 0 }, GRID)[0].point
    const groundAt = (id: string, x: number) => ({ id, def: "ground", x: x - pinOffset.x, y: -pinOffset.y })
    const straddling = [groundAt("a", 0.5 - 1e-7), groundAt("b", 0.5 + 1e-7)]
    expect.soft(pinContacts(straddling, GRID).groups.size, "two pins 2e-7 apart across a cell edge join").toBe(2)
    expect.soft(partition(pinContacts(straddling, GRID).groups), "…and the brute-force sweep agrees").toBe(partition(brute(straddling)))
    const apart = [groundAt("a", 0.5 - 0.2), groundAt("b", 0.5 + 0.2)]
    expect.soft(pinContacts(apart, GRID).groups.size, "two pins 0.4 px apart stay separate").toBe(0)
  })

  it("at a pixel edge in a diagonal part's own frame", () => {
    const nucleo: PlacedObject = { id: "n", def: "nucleo-f429zi", x: 0, y: 0, rotation: 45 }
    const offEdge = (v: number) => Math.abs(v - Math.floor(v) - 0.5)
    const pin = objectPins(nucleo, GRID).reduce((best, p) => (p.pin.kind !== "nc" && offEdge(p.point.y) < offEdge(best.point.y) ? p : best))
    expect.soft(offEdge(pin.point.y), "a pin sits within a thousandth or so of a pixel edge").toBeLessThan(1.5e-3)
    const across = Math.floor(pin.point.y) + 0.5 + (pin.point.y % 1 < 0.5 ? 0.0015 : -0.0015)
    const pinOffset = objectPins({ id: "probe", def: "ground", x: 0, y: 0 }, GRID)[0].point
    const objects = [nucleo, { id: "g", def: "ground", x: pin.point.x - pinOffset.x, y: across - pinOffset.y }]
    const found = new ContactIndex().of(objects, GRID).groups
    expect.soft(found.has(pinKey("g", "GND")) && found.has(pin.key), "a ground 0.002 px across that edge joins the pin").toBe(true)
    expect.soft(partition(found), "…and the brute-force sweep agrees").toBe(partition(brute(objects)))
  })

  it("between two pins of one part", () => {
    const resistor = getDef("resistor")!
    const [first, second] = resistor.pins
    const twin: ComponentDef = { ...resistor, id: "twin", pins: [first, { ...second, x: first.x, y: first.y }] }
    const defOf = (id: string) => (id === twin.id ? twin : getDef(id))
    const keys = [pinKey("t", first.id), pinKey("t", second.id)]
    const root = keys[0] < keys[1] ? keys[0] : keys[1]
    for (const rotation of [0, 45, 90, 135] as const) {
      const found = new ContactIndex(defOf).of([{ id: "t", def: twin.id, x: 0, y: 0, rotation }], GRID)
      expect.soft(Object.fromEntries(found.groups), `two pins drawn on one spot join, turned ${rotation}°`).toEqual({ [keys[0]]: root, [keys[1]]: root })
    }
    const index = new ContactIndex(defOf)
    const others = [0, 1, 2].map((i): PlacedObject => ({ id: `r${i}`, def: "resistor", x: 0, y: (i + 1) * 4 * GRID }))
    expect.soft(index.of([{ id: "t", def: twin.id, x: 0, y: 0 }, ...others], GRID).groups.size, "beside three resistors").toBe(2)
    expect.soft(index.of(others, GRID).groups.size, "…and gone with the part").toBe(0)
  })

  it("on one index kept across 120 edits around a board with parts docked on its headers", () => {
    let seed = 20261012
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]
    const rotations = [0, 45, 90, 135, 180, 225, 270, 315] as const
    const parts = ["resistor", "led", "ground", "pushbutton"]
    let board: PlacedObject = { id: "board", def: "open746i-c", x: 0, y: 0 }
    const headerPins = () => objectPins(board, GRID).filter((p) => p.pin.kind !== "nc")
    let made = 0
    const part = (): PlacedObject => {
      const id = `p${made++}`
      const def = pick(parts)
      const rotation = pick(rotations)
      const mirror = random() < 0.25
      if (random() < 0.3) return { id, def, rotation, mirror, x: Math.round(random() * 80) * GRID, y: Math.round(random() * 60) * GRID }
      const pins = objectPins({ id, def, x: 0, y: 0, rotation, mirror }, GRID)
      const own = pick(pins).point
      const onto = pick(headerPins()).point
      return { id, def, rotation, mirror, x: onto.x - own.x, y: onto.y - own.y }
    }
    let objects: PlacedObject[] = [board, ...Array.from({ length: 40 }, part)]
    const index = new ContactIndex()
    const kindOf = new Map(objects.flatMap((o) => objectPins(o, GRID)).map((p) => [p.key, p.pin.kind]))
    let mismatches = 0
    let contacts = 0
    for (let step = 0; step < 120; step++) {
      const roll = random()
      if (roll < 0.05) objects = [board, ...Array.from({ length: 40 }, part)]
      else if (roll < 0.15) {
        board = { ...board, x: board.x + pick([-2, -1, 1, 2]) * GRID, rotation: random() < 0.3 ? pick([0, 90, 180, 270] as const) : board.rotation }
        objects = objects.map((o) => (o.id === board.id ? board : o))
      } else if (roll < 0.3) objects = objects.filter((o) => o.id === board.id || random() > 0.1)
      else if (roll < 0.45) objects = [...objects, part(), part()]
      else {
        const moving = new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(objects).id))
        moving.delete(board.id)
        objects = objects.map((o) => (moving.has(o.id) ? { ...part(), id: o.id } : o))
      }
      for (const o of objects) for (const p of objectPins(o, GRID)) kindOf.set(p.key, p.pin.kind)
      const found = index.of(objects, GRID)
      const want = brute(objects)
      contacts += found.groups.size
      if (partition(found.groups) !== partition(want)) mismatches++
      if ([...found.groups].some(([key, root]) => root > key || found.groups.get(root) !== root)) mismatches++
      if ([...found.kinds].some(([key, kind]) => kindOf.get(key) !== kind) || found.kinds.size !== want.size) mismatches++
    }
    expect.soft(mismatches, "every step agrees with the sweep: groups, smallest key as root, kinds").toBe(0)
    expect.soft(contacts, "…and the steps did join pins").toBeGreaterThan(200)
  })
})

describe("every example's stored wires are clean: in normal form, through no body they do not belong to, over no pin of another net", () => {
  const segmentCrosses = (p: Point, q: Point, r: { x: number; y: number; w: number; h: number }) => {
    const [x0, x1, y0, y1] = [r.x + 0.5, r.x + r.w - 0.5, r.y + 0.5, r.y + r.h - 0.5]
    return p.y === q.y
      ? p.y > y0 && p.y < y1 && Math.max(p.x, q.x) > x0 && Math.min(p.x, q.x) < x1
      : p.x === q.x && p.x > x0 && p.x < x1 && Math.max(p.y, q.y) > y0 && Math.min(p.y, q.y) < y1
  }
  const runsOver = (p: Point, q: Point, t: Point) =>
    (p.y === q.y && t.y === p.y && t.x > Math.min(p.x, q.x) && t.x < Math.max(p.x, q.x)) || (p.x === q.x && t.x === p.x && t.y > Math.min(p.y, q.y) && t.y < Math.max(p.y, q.y))
  const axisAligned = (o: PlacedObject) => (o.rotation ?? 0) % 90 === 0

  it.each(examples.map((e) => [e.id, e] as const))("%s", (_, example) => {
    const doc: Schematic = { ...example.build(GRID) }
    const { runs, nets } = wiringOf(new WireGraph(), doc)
    const pins = pinsOf(doc.objects)
    const ownersAt = (p: Point) => pins.filter((q) => q.at.x === p.x && q.at.y === p.y).map((q) => q.key.slice(0, q.key.indexOf(":")))
    const refOf = (id: string) => doc.objects.find((o) => o.id === id)?.props?.ref ?? id
    const issues = new Set<string>()
    for (const run of runs) {
      const net = nets.netOfWire(run.id)
      const own = new Set([...ownersAt(run.points[0]), ...ownersAt(run.points[run.points.length - 1]), ...(net === undefined ? [] : nets.pinsOf(net).map((key) => key.slice(0, key.indexOf(":"))))])
      const name = `${run.points[0].x / GRID},${run.points[0].y / GRID}→${run.points[run.points.length - 1].x / GRID},${run.points[run.points.length - 1].y / GRID}`
      for (const o of doc.objects) {
        if (own.has(o.id) || !axisAligned(o)) continue
        const rect = objectRect(o, GRID)
        if (run.points.some((p, i) => i > 0 && segmentCrosses(run.points[i - 1], p, rect))) issues.add(`${name} crosses ${refOf(o.id)}`)
        for (const pin of objectPins(o, GRID)) {
          if (getDef(o.def)?.pinsAreSockets || nets.netOfPin(pin.key) === net) continue
          if (run.points.some((p, i) => i > 0 && runsOver(run.points[i - 1], p, pin.point))) issues.add(`${name} runs over ${refOf(o.id)}.${pin.pin.id}`)
        }
      }
    }
    expect([...issues]).toEqual([])
  })
})
