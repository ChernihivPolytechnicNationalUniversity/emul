import { readFileSync } from "node:fs"
import { join } from "node:path"
import { builder } from "@/schematic/builder"
import { pinContacts } from "@/schematic/contacts"
import { examples, lab1Stand } from "@/schematic/examples"
import {
  GRID,
  nudgeRoutes,
  objectPins,
  objectRect,
  resolvePin,
  routeAll,
  routeObstacles,
  Router,
  routeWire,
  toPath,
  type Point,
  type RoutedWire,
} from "@/schematic/geometry"
import { buildNets } from "@/schematic/nets"
import { autoNetColor, semanticNetColor, WIRE_COLORS } from "@/schematic/wire-colors"
import { tapWireAt } from "@/schematic/wiring"
import { partKey, pinKey, type PinKind, type PlacedObject, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { TopologyGate } from "@/sim/topology"

let failed = 0
let total = 0
const expect = (what: string, got: number | string | boolean, want: number | string | boolean, tol = 0) => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  const fmt = (v: number | string | boolean) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(5)) : String(v))
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(52)} ${fmt(got).padStart(14)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}

const route = (doc: Schematic, id: string) => routeAll(doc.objects, doc.wires, GRID).find((r) => r.id === id)!
const horizontal = (a: Point, b: Point) => a.y === b.y
function crosses(pts: Point[], r: { x: number; y: number; w: number; h: number }) {
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
const onLine = (r: RoutedWire, y: number) =>
  r.pts.slice(0, -1).filter((p, i) => horizontal(p, r.pts[i + 1]) && Math.abs(p.y - y) < GRID)

const wall0 = performance.now()

console.log("Stubs and the straight run between two pins")
{
  const { doc, place, wire } = builder(GRID)
  const r1 = place("resistor", 0, 0)
  const r2 = place("resistor", 10, 0)
  const w = wire(r1, "2", r2, "1")
  const r = route(doc, w.id)
  expect("every point on one line", new Set(r.pts.map((p) => p.y)).size, 1)
  expect("starts at R1 pin 2", r.pts[0].x, 4 * GRID)
  expect("ends at R2 pin 1", r.pts[r.pts.length - 1].x, 10 * GRID)
  expect("stub is one cell out of the pin", r.pts[1].x - r.pts[0].x, GRID)
}

console.log("A pin on a diagonal keeps its place and lands its stub on the grid")
{
  const { doc, place, wire } = builder(GRID)
  const r1 = place("resistor", 0, 0, {}, 45)
  const r2 = place("resistor", 12, 6)
  const w = wire(r1, "2", r2, "1")
  const r = route(doc, w.id)
  const stub = r.pts[1]
  expect("stub end snapped to the grid in x", stub.x % GRID, 0)
  expect("stub end snapped to the grid in y", stub.y % GRID, 0)
  expect("pin itself is off the grid", (r.pts[0].x % GRID) + (r.pts[0].y % GRID) > 0, true)
  expect("everything after the stub is orthogonal", r.pts.slice(1).every((p, i, a) => i === 0 || p.x === a[i - 1].x || p.y === a[i - 1].y), true)
}

console.log("A component in the way is routed around, not through")
{
  const { doc, place, wire } = builder(GRID)
  const a = place("resistor", 0, 0)
  const b = place("resistor", 20, 0)
  const between = place("resistor", 10, 0)
  const w = wire(a, "2", b, "1")
  const r = route(doc, w.id)
  expect("clears the component between the two", crosses(r.pts, objectRect(between, GRID)), false)
}

console.log("Rounded corners")
{
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]
  const d = toPath(square, 10)
  expect("a corner becomes a quadratic", d.includes("Q"), true)
  expect("starts where the polyline starts", d.startsWith("M0 0"), true)
  expect("ends where the polyline ends", d.endsWith("L100 100"), true)
  const collinear: Point[] = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 100, y: 0 },
  ]
  expect("a straight-through point is not rounded", toPath(collinear, 10).includes("Q"), false)
  const tiny: Point[] = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 40 },
  ]
  expect("the radius is clamped to the short leg", toPath(tiny, 10).includes("L2 0"), true)
}

console.log("Nets: wires and touching pins are one node")
{
  const { doc, place, wire } = builder(GRID)
  const r1 = place("resistor", 0, 0)
  const r2 = place("resistor", 10, 0)
  const r3 = place("resistor", 14, 0)
  const gnd = place("ground", 20, 4)
  wire(r1, "2", r2, "1")
  wire(r3, "2", gnd, "GND")
  const nets = buildNets(doc.objects, doc.wires, GRID)
  const netOf = (obj: { id: string }, pin: string) => nets.netOfPin(pinKey(obj.id, pin))
  expect("a wire joins its two pins", netOf(r1, "2") === netOf(r2, "1"), true)
  expect("touching pins join without a wire", netOf(r2, "2") === netOf(r3, "1"), true)
  expect("the ground is on R3's far pin", netOf(r3, "2") === netOf(gnd, "GND"), true)
  expect("a component does not join its own pins", netOf(r1, "1") === netOf(r1, "2"), false)
  expect("two nets", nets.nets.length, 2)
}

console.log("Automatic colour follows what is on the net")
{
  const kinds = (...k: PinKind[]) => new Set(k)
  expect("a net with a ground pin is black", autoNetColor(kinds("digital", "gnd")), "black")
  expect("a net with a rail is red", autoNetColor(kinds("digital", "power")), "red")
  expect("a ground wins over a rail — that net is a short", autoNetColor(kinds("power", "gnd")), "black")
  expect("an ordinary signal is the default black", autoNetColor(kinds("digital", "analog")), "black")
  expect("and has no colour of its own to keep", semanticNetColor(kinds("digital", "analog")), undefined as unknown as string)

  const { doc, place, wire } = builder(GRID)
  const r = place("resistor", 0, 0)
  const gnd = place("ground", 8, 4)
  const w = wire(r, "2", gnd, "GND")
  const nets = buildNets(doc.objects, doc.wires, GRID)
  expect("read off a real document", autoNetColor(nets.kindsOf(nets.netOfWire(w.id)!)), "black")
}

console.log("Every wire colour has a flow colour that reads against it")
{
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8")
  const lightness = (block: string, name: string) => {
    const m = block.match(new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)`))
    return m ? Number(m[1]) : NaN
  }
  const blocks = {
    light: css.slice(css.indexOf(":root {"), css.indexOf(".dark {")),
    dark: css.slice(css.indexOf(".dark {")),
  }
  const MIN_DELTA = 0.22
  for (const [theme, block] of Object.entries(blocks)) {
    let worst = { key: "", delta: Infinity }
    for (const key of WIRE_COLORS) {
      const delta = Math.abs(lightness(block, `wire-${key}`) - lightness(block, `wire-${key}-flow`))
      if (delta < worst.delta) worst = { key, delta }
    }
    expect(`${theme}: weakest pair (${worst.key}, ΔL ${worst.delta.toFixed(2)})`, worst.delta >= MIN_DELTA, true)
  }
  const missing = WIRE_COLORS.filter((k) => Number.isNaN(lightness(blocks.light, `wire-${k}-flow`)) || Number.isNaN(lightness(blocks.dark, `wire-${k}-flow`)))
  expect("every colour has both tokens", missing.length, 0)
}

console.log("Nudging separates two nets sharing a corridor")
{
  const { doc, place, wire } = builder(GRID)
  const a1 = place("resistor", 0, 0)
  const a2 = place("resistor", 0, 16)
  const b1 = place("resistor", 24, 2)
  const b2 = place("resistor", 24, 14)
  const wa = wire(a1, "2", a2, "2", [
    [12, 8],
    [20, 8],
  ])
  const wb = wire(b1, "1", b2, "1", [
    [10, 8],
    [18, 8],
  ])
  const raw = routeAll(doc.objects, doc.wires, GRID)
  const lane = 8 * GRID
  expect("both routes use the lane before nudging", onLine(raw.find((r) => r.id === wa.id)!, lane).length > 0 && onLine(raw.find((r) => r.id === wb.id)!, lane).length > 0, true)

  const nets = buildNets(doc.objects, doc.wires, GRID)
  const out = nudgeRoutes(raw, nets.netOfWire, GRID)
  const ya = onLine(out.find((r) => r.id === wa.id)!, lane)[0].y
  const yb = onLine(out.find((r) => r.id === wb.id)!, lane)[0].y
  expect("the two nets end up on different lines", ya !== yb, true)
  expect("they are a third of a cell apart", Math.abs(ya - yb), GRID / 3, 0.01)
  expect("both stay within half a cell of the lane", Math.max(Math.abs(ya - lane), Math.abs(yb - lane)) <= GRID / 2, true)

  const same = (a: RoutedWire, b: RoutedWire) => a.pts[0].x === b.pts[0].x && a.pts[0].y === b.pts[0].y && a.pts.at(-1)!.x === b.pts.at(-1)!.x && a.pts.at(-1)!.y === b.pts.at(-1)!.y
  expect("the pins themselves did not move", out.every((r) => same(r, raw.find((x) => x.id === r.id)!)), true)
  expect("every segment is still orthogonal", out.every((r) => r.pts.every((p, i, all) => i === 0 || p.x === all[i - 1].x || p.y === all[i - 1].y)), true)
}

console.log("One net running alongside itself is left alone")
{
  const { doc, place, wire } = builder(GRID)
  const a = place("resistor", 0, 0)
  const b = place("resistor", 24, 0)
  const c = place("resistor", 24, 8)
  const w1 = wire(a, "2", b, "1", [[12, 4]])
  const w2 = wire(a, "2", c, "1", [[12, 4]])
  const raw = routeAll(doc.objects, doc.wires, GRID)
  const nets = buildNets(doc.objects, doc.wires, GRID)
  const out = nudgeRoutes(raw, nets.netOfWire, GRID)
  expect("one net", nets.nets.length, 1)
  expect("nothing moved", out === raw, true)
  expect("both wires still pass through the shared bend", out.filter((r) => r.id === w1.id || r.id === w2.id).every((r) => r.pts.some((p) => p.x === 12 * GRID && p.y === 4 * GRID)), true)
}


const orthogonal = (r: RoutedWire) => r.pts.every((p, i, all) => i === 0 || p.x === all[i - 1].x || p.y === all[i - 1].y)
const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y
const find = (rs: RoutedWire[], id: string) => rs.find((r) => r.id === id)!

console.log("Nudging next to a stub jogs instead of tilting the stub")
{
  const { doc, place, wire } = builder(GRID)
  const a = place("resistor", 0, 0)
  const b = place("resistor", 10, 0)
  const c = place("resistor", 0, 4)
  const d = place("resistor", 10, 4)
  const straight = wire(a, "2", b, "1")
  const over = wire(c, "2", d, "1", [
    [6, 1],
    [8, 1],
  ])
  const raw = routeAll(doc.objects, doc.wires, GRID)
  const nets = buildNets(doc.objects, doc.wires, GRID)
  const out = nudgeRoutes(raw, nets.netOfWire, GRID)
  const s0 = find(raw, straight.id)
  const s1 = find(out, straight.id)
  expect("the two runs did share the lane", onLine(s0, 1 * GRID).length > 0 && onLine(find(raw, over.id), 1 * GRID).length > 0, true)
  expect("the straight wire moved", s1 !== s0, true)
  expect("every wire stays orthogonal", out.every(orthogonal), true)
  expect("stub end at the first pin did not move", samePoint(s1.pts[1], s0.pts[1]), true)
  expect("stub end at the second pin did not move", samePoint(s1.pts.at(-2)!, s0.pts.at(-2)!), true)
  expect("the middle of the straight wire is off the lane", Math.abs(onLine(s1, 1 * GRID).find((p) => p.x > 6 * GRID && p.x < 8 * GRID)!.y - 1 * GRID), GRID / 6, 0.01)
  expect("owner has one entry per segment", out.every((r) => r.owner.length === r.pts.length - 1), true)
}

console.log("A run that leaves the shared corridor jogs back to its own line")
{
  const { doc, place, wire } = builder(GRID)
  const a = place("resistor", 0, 0)
  const b = place("resistor", 30, 0)
  const c = place("resistor", 0, 6)
  const d = place("resistor", 12, 6)
  const long = wire(a, "2", b, "1", [
    [6, 3],
    [12, 3],
    [18, 3],
    [24, 3],
  ])
  wire(c, "2", d, "1", [
    [8, 3],
    [10, 3],
  ])
  const raw = routeAll(doc.objects, doc.wires, GRID)
  const nets = buildNets(doc.objects, doc.wires, GRID)
  const out = nudgeRoutes(raw, nets.netOfWire, GRID)
  const r = find(out, long.id)
  expect("chained run still orthogonal", orthogonal(r), true)
  const ys = onLine(r, 3 * GRID).map((p) => p.y)
  expect("part of the run is offset", ys.some((y) => y !== 3 * GRID), true)
  expect("and part of it is back on its own line", ys.some((y) => y === 3 * GRID), true)
  expect("owner still matches the segments", r.owner.length, r.pts.length - 1)
}

console.log("The ladder never pushes a wire further than half a cell")
{
  const { doc, place, wire } = builder(GRID)
  const ids: string[] = []
  for (let i = 0; i < 6; i++) {
    const a = place("resistor", 0, 4 * i)
    const b = place("resistor", 40, 4 * i)
    ids.push(
      wire(a, "2", b, "1", [
        [10 + i, 30],
        [30 - i, 30],
      ]).id,
    )
  }
  const raw = routeAll(doc.objects, doc.wires, GRID)
  const nets = buildNets(doc.objects, doc.wires, GRID)
  const out = nudgeRoutes(raw, nets.netOfWire, GRID)
  const offsets = ids.map((id) => Math.abs(onLine(find(out, id), 30 * GRID)[0].y - 30 * GRID))
  expect("six nets on one lane", nets.nets.length, 6)
  expect("largest offset", Math.max(...offsets) <= GRID / 2 + 1e-9, true)
  expect("all six on distinct lines", new Set(ids.map((id) => onLine(find(out, id), 30 * GRID)[0].y)).size, 6)
  expect("all orthogonal", out.every(orthogonal), true)
}

console.log("Tapping a wire drops a junction on it and joins the nets")
{
  const { doc, place, wire } = builder(GRID)
  const r1 = place("resistor", 0, 0)
  const r2 = place("resistor", 16, 0)
  const r3 = place("resistor", 8, 6)
  const w = wire(r1, "2", r2, "1")
  w.color = "blue"
  const route = routeAll(doc.objects, doc.wires, GRID)[0]
  const beside = { x: 9 * GRID + 5, y: 1 * GRID + 7 }
  const tapped = tapWireAt(doc, w.id, beside, { object: r3.id, pin: "1" }, GRID)
  const junction = tapped.objects.find((o) => o.def === "junction")!
  expect("a junction was added", junction ? "yes" : "no", "yes")
  expect("three wires now", tapped.wires.length, 3)
  const jPoint = { x: junction.x + GRID, y: junction.y + GRID }
  expect("junction on the wire's line", jPoint.y, route.pts[1].y)
  expect("junction snapped along the wire", jPoint.x, 9 * GRID)
  expect("both halves keep the colour", tapped.wires.filter((x) => x.color === "blue").length, 2)
  const nets = buildNets(tapped.objects, tapped.wires, GRID)
  const net = nets.netOfPin(pinKey(r1.id, "2"))
  expect("R1, R2, R3 and the junction are one net", [pinKey(r2.id, "1"), pinKey(r3.id, "1"), pinKey(junction.id, "J")].every((k) => nets.netOfPin(k) === net), true)

  expect("tapping from the wire's own end changes nothing", tapWireAt(doc, w.id, beside, { object: r1.id, pin: "2" }, GRID) === doc, true)
  expect("an unknown wire changes nothing", tapWireAt(doc, "nope", beside, { object: r3.id, pin: "1" }, GRID) === doc, true)

  const atPin = tapWireAt(doc, w.id, route.pts[0], { object: r3.id, pin: "1" }, GRID)
  expect("a tap on the end pin wires straight to the pin", atPin.objects.length === doc.objects.length && atPin.wires.length === 2, true)
  expect("…to that pin", atPin.wires[1].to.object === r1.id && atPin.wires[1].to.pin === "2", true)
}

console.log("Two MCU pins tied through a junction to one button (the PG2/PG3 stand)")
{
  const doc = lab1Stand.build(GRID)
  const dd = doc.objects.find((o) => o.def === "stm32f746ig")!
  const byRef = (ref: string) => doc.objects.find((o) => o.props?.ref === ref)!
  const pg3Wire = doc.wires.find((w) => w.from.object === dd.id && w.from.pin === "PG3")!
  const route = routeAll(doc.objects, doc.wires, GRID).find((r) => r.id === pg3Wire.id)!
  const mid = route.pts[Math.floor(route.pts.length / 2)]
  const tapped = tapWireAt(doc, pg3Wire.id, { x: mid.x + 3, y: mid.y - 4 }, { object: dd.id, pin: "PG2" }, GRID)
  const junction = tapped.objects.find((o) => o.def === "junction")!
  expect("a tap from a pin of the same object is allowed", junction ? "yes" : "no", "yes")
  const nets = buildNets(tapped.objects, tapped.wires, GRID)
  expect("PG2 and PG3 are one net", nets.netOfPin(pinKey(dd.id, "PG2")) === nets.netOfPin(pinKey(dd.id, "PG3")), true)
  expect("…with SA3's contact", nets.netOfPin(pinKey(dd.id, "PG2")) === nets.netOfPin(pinKey(byRef("SA3").id, "1")), true)
  expect("SA2's contact is on it too", nets.netOfPin(pinKey(dd.id, "PG2")) === nets.netOfPin(pinKey(byRef("SA2").id, "1")), true)

  const elf = readFileSync(join(import.meta.dirname, "..", "firmware", "examples", "lab1-f746.elf"))
  dd.props = { ...dd.props, firmware: "lab1-f746.elf", firmwareData: elf.toString("base64") }
  const loop = new SimLoop()
  loop.setDoc(tapped)
  loop.setParts(tapped.parts)
  loop.setRunning(true)
  let clock = 0
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 10)
      loop.advance(clock)
    }
    return loop.snapshot()!
  }
  const v = (pin: string) => loop.snapshot()!.pinVoltage[pinKey(dd.id, pin)]
  run(0.1)
  expect("both pins idle high on their pull-ups", Math.min(v("PG2"), v("PG3")), 3.3, 0.05)
  loop.setParts({ [partKey(byRef("SA3").id, "SW")]: { pressed: true } })
  let snap = run(0.05)
  expect("SA3 pressed: PG3 low", v("PG3"), 0, 0.05)
  expect("SA3 pressed: PG2 low through the junction", v("PG2"), 0, 0.05)
  const toJ = tapped.wires.filter((w) => w.to.object === junction.id)
  const fromJ = tapped.wires.find((w) => w.from.object === junction.id)!
  const into = toJ.reduce((sum, w) => sum + Math.abs(snap.wireCurrent[w.id] ?? 0), 0)
  expect("two wires feed the junction", toJ.length, 2)
  expect("current out of the junction is the sum of what comes in (µA)", Math.abs(snap.wireCurrent[fromJ.id] ?? 0) * 1e6, into * 1e6, Math.max(1, into * 1e6 * 0.02))
  expect("each pin contributes (µA)", Math.min(...toJ.map((w) => Math.abs(snap.wireCurrent[w.id] ?? 0))) * 1e6 > 10, true)
  loop.setParts({ [partKey(byRef("SA3").id, "SW")]: { pressed: false }, [partKey(byRef("SA2").id, "SW")]: { pressed: true } })
  snap = run(0.05)
  expect("SA2 pressed instead: PG3 follows PG2", v("PG3"), 0, 0.05)
  loop.setParts({ [partKey(byRef("SA2").id, "SW")]: { pressed: false } })
  run(0.05)
  expect("released: both back high", Math.min(v("PG2"), v("PG3")), 3.3, 0.05)
}

console.log("Nudging by cached lanes draws what the straightforward sweep drew")
{
  type Axis = "h" | "v"
  type Seg = { wire: number; at: number; net: string; axis: Axis; lo: number; hi: number; lean: number }
  const axisOf = (p: Point, q: Point): Axis | null => (p.y === q.y ? "h" : p.x === q.x ? "v" : null)
  const NUDGE_STEP = 1 / 3
  const NUDGE_MAX = 1 / 2

  const applyOffsets = (r: RoutedWire, offsetOf: (segment: number) => number): RoutedWire => {
    const { pts, owner } = r
    const last = pts.length - 1
    let touched = false
    for (let i = 0; i < last; i++) if (offsetOf(i)) touched = true
    if (!touched) return r
    const moved = (segment: number, p: Point): Point => {
      const d = offsetOf(segment)
      if (!d) return p
      const axis = axisOf(pts[segment], pts[segment + 1])
      if (axis === "h") return { x: p.x, y: p.y + d }
      if (axis === "v") return { x: p.x + d, y: p.y }
      return p
    }
    const outPts: Point[] = [pts[0]]
    const outOwner: number[] = []
    for (let i = 1; i < last; i++) {
      const inAxis = axisOf(pts[i - 1], pts[i])
      const outAxis = axisOf(pts[i], pts[i + 1])
      const turns = inAxis !== null && outAxis !== null && inAxis !== outAxis
      if (turns) {
        outPts.push(moved(i, moved(i - 1, pts[i])))
        outOwner.push(owner[i - 1])
        continue
      }
      outPts.push(moved(i - 1, pts[i]))
      outOwner.push(owner[i - 1])
      if (offsetOf(i - 1) !== offsetOf(i)) {
        outPts.push(moved(i, pts[i]))
        outOwner.push(owner[i])
      }
    }
    outPts.push(pts[last])
    outOwner.push(owner[last - 1])
    return { ...r, pts: outPts, owner: outOwner }
  }

  const plainly = (routes: RoutedWire[], netOf: (id: string) => string | undefined, grid: number): RoutedWire[] => {
    const segs: Seg[] = []
    routes.forEach((r, wire) => {
      const net = netOf(r.id) ?? r.id
      for (let at = 1; at < r.pts.length - 2; at++) {
        const p = r.pts[at]
        const q = r.pts[at + 1]
        const axis = axisOf(p, q)
        if (!axis) continue
        const before = r.pts[at - 1]
        const after = r.pts[at + 2]
        const lean = axis === "h" ? (before.y + after.y) / 2 - p.y : (before.x + after.x) / 2 - p.x
        const [lo, hi] = axis === "h" ? [Math.min(p.x, q.x), Math.max(p.x, q.x)] : [Math.min(p.y, q.y), Math.max(p.y, q.y)]
        segs.push({ wire, at, net, axis, lo, hi, lean })
      }
    })
    const lanes = new Map<string, Seg[]>()
    for (const s of segs) {
      const p = routes[s.wire].pts[s.at]
      const key = `${s.axis}${Math.round(s.axis === "h" ? p.y : p.x)}`
      const list = lanes.get(key)
      if (list) list.push(s)
      else lanes.set(key, [s])
    }
    const meanLean = (cluster: Seg[], net: string) => {
      let sum = 0
      let n = 0
      for (const s of cluster) {
        if (s.net !== net) continue
        sum += s.lean
        n++
      }
      return n ? sum / n : 0
    }
    const offset = new Map<string, number>()
    const separate = (cluster: Seg[]) => {
      const nets = [...new Set(cluster.map((s) => s.net))]
      if (nets.length < 2) return
      nets.sort((a, b) => meanLean(cluster, a) - meanLean(cluster, b))
      const step = Math.min(NUDGE_STEP * grid, (2 * NUDGE_MAX * grid) / (nets.length - 1))
      const span = (nets.length - 1) / 2
      const deltaOf = new Map(nets.map((net, i) => [net, (i - span) * step]))
      for (const s of cluster) {
        const delta = deltaOf.get(s.net) ?? 0
        if (delta) offset.set(`${s.wire}:${s.at}`, delta)
      }
    }
    for (const list of lanes.values()) {
      if (list.length < 2) continue
      list.sort((a, b) => a.lo - b.lo)
      let cluster: Seg[] = []
      let end = -Infinity
      for (const s of list) {
        if (cluster.length && s.lo >= end) {
          separate(cluster)
          cluster = []
        }
        cluster.push(s)
        end = Math.max(end, s.hi)
      }
      separate(cluster)
    }
    if (offset.size === 0) return routes
    return routes.map((r, wire) => applyOffsets(r, (at) => offset.get(`${wire}:${at}`) ?? 0))
  }

  const shape = (routes: readonly RoutedWire[]) =>
    routes
      .map((r) => `${r.id} ${r.pts.map((p) => `${p.x},${p.y}`).join(" ")} / ${r.owner.join(",")}`)
      .sort()
      .join("\n")

  let apart = 0
  let nudgedAnything = 0
  const agrees = (doc: Schematic) => {
    const nets = buildNets(doc.objects, doc.wires, GRID)
    const straight = new Router().routeAll(doc.objects, doc.wires, GRID)
    const now = nudgeRoutes(new Router().routeAll(doc.objects, doc.wires, GRID), nets.netOfWire, GRID)
    const before = plainly(new Router().routeAll(doc.objects, doc.wires, GRID), nets.netOfWire, GRID)
    if (shape(now) !== shape(straight)) nudgedAnything++
    if (shape(now) !== shape(before)) apart++
  }

  for (const example of examples) agrees(example.build(GRID))
  let seed = 5150
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const base = lab1Stand.build(GRID)
  for (let i = 0; i < 12; i++) {
    agrees({
      ...base,
      objects: base.objects.map((o) => ({ ...o, x: o.x + Math.round(random() * 6 - 3) * GRID, y: o.y + Math.round(random() * 6 - 3) * GRID })),
    })
  }
  expect("every document nudges to the same routes", apart, 0)
  expect("and the corpus does exercise nudging", nudgedAnything > 0, true)
}

console.log("The contact index answers with the same map until the answer changes")
{
  const { doc, place } = builder(GRID)
  const r1 = place("resistor", 0, 0)
  const r2 = place("resistor", 20, 0)
  const at = (o: { id: string }, x: number): Schematic => ({ ...doc, objects: doc.objects.map((p) => (p.id === o.id ? { ...p, x: x * GRID } : p)) })

  const apart = pinContacts(doc.objects, GRID)
  expect("asking twice about one document", pinContacts(doc.objects, GRID) === apart, true)
  expect("nothing touches to begin with", apart.groups.size, 0)
  const shifted = at(r2, 30)
  expect("a move that touches nothing keeps the same map", pinContacts(shifted.objects, GRID) === apart, true)
  const meeting = at(r2, 4)
  const met = pinContacts(meeting.objects, GRID)
  expect("a move that lands a pin on another does not", met === apart, false)
  expect("…and the two pins are grouped", met.groups.size, 2)
  expect("…and the kinds came with them", met.kinds.size, 2)
  expect("the pins are R1.2 and R2.1", [...met.groups.keys()].sort().join(" "), [pinKey(r1.id, "2"), pinKey(r2.id, "1")].sort().join(" "))
  expect("…and asking again about the same contact keeps the map", pinContacts(at(r2, 4).objects, GRID) === met, true)
  const parted = pinContacts(at(r2, 20).objects, GRID)
  expect("moving apart again drops the contact", parted.groups.size, 0)
  expect("…and settles back on the empty map", pinContacts(at(r2, 25).objects, GRID) === parted, true)
}

console.log("The solver is told about the document only when the circuit changed")
{
  const gate = new TopologyGate()
  const { doc, place, wire } = builder(GRID)
  const r1 = place("resistor", 0, 0)
  const r2 = place("resistor", 20, 0)
  const gnd = place("ground", 30, 4)
  const w = wire(r2, "2", gnd, "GND")
  const shift = (o: { id: string }, x: number): Schematic => ({ ...doc, objects: doc.objects.map((p) => (p.id === o.id ? { ...p, x: x * GRID } : p)) })
  const sent = (d: Schematic) => gate.latest({ objects: d.objects, wires: d.wires }, buildNets(d.objects, d.wires, GRID).contacts)

  const first = sent(doc)
  expect("the same document twice is sent once", sent(doc) === first, true)
  expect("a move that connects nothing is not resent", sent(shift(r2, 24)) === first, true)
  const met = sent(shift(r2, 4))
  expect("a move that lands a pin on another is", met !== first, true)
  expect("…and staying there is not", sent(shift(r2, 4)) === met, true)
  const apart = sent(shift(r2, 20))
  expect("moving apart again is", apart !== met, true)

  const settled = sent(doc)
  const coloured: Schematic = { ...doc, wires: doc.wires.map((x) => ({ ...x, color: "blue" as const })) }
  expect("a wire recoloured is not", sent(coloured) === settled, true)
  const bent: Schematic = { ...coloured, wires: coloured.wires.map((x) => ({ ...x, points: [{ x: 0, y: 0 }] })) }
  expect("a bend point moved is not", sent(bent) === settled, true)
  const rotated: Schematic = { ...bent, objects: bent.objects.map((o) => (o.id === gnd.id ? { ...o, rotation: 90 as const } : o)) }
  expect("a rotation that touches nothing is not", sent(rotated) === settled, true)
  const revalued: Schematic = { ...rotated, objects: rotated.objects.map((o) => (o.id === r1.id ? { ...o, props: { ...o.props, value: "2 kΩ" } } : o)) }
  const valued = sent(revalued)
  expect("a component's value is", valued !== settled, true)
  const unwired: Schematic = { ...revalued, wires: revalued.wires.filter((x) => x.id !== w.id) }
  expect("a wire removed is", sent(unwired) !== valued, true)
}

console.log("Obstacles queried near a wire route what the whole document would")
{
  const trace = (id: string, pts: readonly Point[]) => `${id} ${pts.map((p) => `${p.x},${p.y}`).join(" ")}`
  const globally = (doc: Schematic) =>
    doc.wires
      .flatMap((w) => {
        const a = resolvePin(doc.objects, w.from, GRID)
        const b = resolvePin(doc.objects, w.to, GRID)
        if (!a || !b) return []
        const route = routeWire(
          a.point,
          a.pin.side,
          a.pin.stub ?? 1,
          b.point,
          b.pin.side,
          b.pin.stub ?? 1,
          GRID,
          w.points ?? [],
          routeObstacles(doc.objects, GRID, w.from.object, w.to.object),
        )
        return [trace(w.id, route.pts)]
      })
      .sort()
      .join("\n")
  const locally = (doc: Schematic) =>
    new Router()
      .routeAll(doc.objects, doc.wires, GRID)
      .map((r) => trace(r.id, r.pts))
      .sort()
      .join("\n")
  for (const example of examples) {
    const doc = example.build(GRID)
    expect(`${example.id}`.padEnd(16), locally(doc) === globally(doc), true)
  }
  let seed = 7401
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  let apart = 0
  const base = lab1Stand.build(GRID)
  for (let i = 0; i < 12; i++) {
    const jittered: Schematic = {
      ...base,
      objects: base.objects.map((o) => ({ ...o, x: o.x + Math.round(random() * 6 - 3) * GRID, y: o.y + Math.round(random() * 6 - 3) * GRID })),
    }
    if (locally(jittered) !== globally(jittered)) apart++
  }
  expect("12 jumbled copies of the stand agree too", apart, 0)
}

console.log("A router kept between edits routes exactly what a fresh one does")
{
  const shape = (routes: readonly RoutedWire[]) =>
    routes
      .map((r) => `${r.id} ${r.pts.map((p) => `${p.x},${p.y}`).join(" ")} / ${r.owner.join(",")}`)
      .sort()
      .join("\n")
  const kept = new Router()
  let doc = lab1Stand.build(GRID)
  let previous: readonly RoutedWire[] = []
  let step = 0
  const after = (what: string, next: Schematic) => {
    doc = next
    const got = kept.routeAll(doc.objects, doc.wires, GRID)
    const want = new Router().routeAll(doc.objects, doc.wires, GRID)
    expect(`${String(++step).padStart(2)}. ${what}`, shape(got) === shape(want), true)
    previous = got
    return got
  }

  const byRef = (ref: string) => doc.objects.find((o) => o.props?.ref === ref)!
  const moveBy = (id: string, dx: number, dy: number): Schematic => ({
    ...doc,
    objects: doc.objects.map((o) => (o.id === id ? { ...o, x: o.x + dx * GRID, y: o.y + dy * GRID } : o)),
  })

  after("the document as built", doc)
  const unchanged = kept.routeAll(doc.objects, doc.wires, GRID)
  expect("    routing it again hands back the same routes", unchanged.every((r, i) => r === previous[i]), true)

  const led = byRef("VD1").id
  const settled = new Map(previous.map((r) => [r.id, r]))
  const moved = after("one LED moved a cell", moveBy(led, 1, 0))
  const rerouted = moved.filter((r) => settled.get(r.id) !== r)
  expect("    and only the wires near it are routed again", `${rerouted.length} of ${moved.length}`, `6 of ${moved.length}`)
  after("the LED moved back", moveBy(led, -1, 0))
  after("the LED dropped across the field", moveBy(led, 30, 12))
  after("the LED brought back", moveBy(led, -30, -12))
  after("a resistor rotated", { ...doc, objects: doc.objects.map((o) => (o.id === byRef("R2").id ? { ...o, rotation: 90 as const } : o)) })
  const bent = doc.wires.find((w) => (w.points?.length ?? 0) > 0)!
  after("a bend point moved", {
    ...doc,
    wires: doc.wires.map((w) => (w.id === bent.id ? { ...w, points: w.points!.map((p, i) => (i === 0 ? { x: p.x + GRID, y: p.y } : p)) } : w)),
  })
  after("a wire recoloured", { ...doc, wires: doc.wires.map((w) => (w.id === bent.id ? { ...w, color: "blue" as const } : w)) })
  const ground = doc.objects.find((o) => o.def === "ground")!
  after("a ground deleted with its wires", {
    ...doc,
    objects: doc.objects.filter((o) => o.id !== ground.id),
    wires: doc.wires.filter((w) => w.from.object !== ground.id && w.to.object !== ground.id),
  })
  after("a fresh object dropped in the middle of the wiring", {
    ...doc,
    objects: [...doc.objects, { id: "intruder", def: "resistor", x: -9 * GRID, y: 6 * GRID, rotation: 90 as const }],
  })
  after("the intruder shuffled along", moveBy("intruder", 0, 2))
  after("the intruder removed", { ...doc, objects: doc.objects.filter((o) => o.id !== "intruder") })
  after("the whole schematic moved", { ...doc, objects: doc.objects.map((o) => ({ ...o, x: o.x + 3 * GRID, y: o.y - GRID })) })

  let seed = 424242
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  let drifted = 0
  for (let i = 0; i < 60; i++) {
    const victim = doc.objects[Math.floor(random() * doc.objects.length)]
    const next = {
      ...doc,
      objects: doc.objects.map((o) =>
        o.id === victim.id ? { ...o, x: o.x + Math.round(random() * 8 - 4) * GRID, y: o.y + Math.round(random() * 8 - 4) * GRID } : o,
      ),
    }
    doc = next
    if (shape(kept.routeAll(doc.objects, doc.wires, GRID)) !== shape(new Router().routeAll(doc.objects, doc.wires, GRID))) drifted++
  }
  expect("60 random moves, each routed the same either way", drifted, 0)
}

console.log("Coincident pins, against a brute-force sweep over every pair")
{
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
  const agrees = (what: string, objects: readonly PlacedObject[]) => {
    const got = partition(pinContacts(objects, GRID).groups)
    const want = partition(brute(objects))
    expect(what, got === want, true)
    return got
  }

  for (const example of examples) agrees(`${example.id}`.padEnd(16), example.build(GRID).objects)

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
  const found = agrees("400 objects piled on 25×25 cells", jumbled)
  expect("…and it found contacts to compare", found.length > 0, true)

  const pinOffset = objectPins({ id: "probe", def: "ground", x: 0, y: 0 }, GRID)[0].point
  const groundAt = (id: string, x: number) => ({ id, def: "ground", x: x - pinOffset.x, y: -pinOffset.y })
  const straddling = [groundAt("a", 0.5 - 1e-7), groundAt("b", 0.5 + 1e-7)]
  expect("two pins 2e-7 apart across a cell edge join", pinContacts(straddling, GRID).groups.size, 2)
  expect("…and the brute-force sweep agrees", partition(pinContacts(straddling, GRID).groups) === partition(brute(straddling)), true)
  const apart = [groundAt("a", 0.5 - 0.2), groundAt("b", 0.5 + 0.2)]
  expect("two pins 0.4 px apart stay separate", pinContacts(apart, GRID).groups.size, 0)
}

console.log("Every example routes cleanly: no run doubles back, no wire through a body or over a foreign pin")
{
  const segmentCrosses = (p: Point, q: Point, r: { x: number; y: number; w: number; h: number }) => {
    const [x0, x1, y0, y1] = [r.x + 0.5, r.x + r.w - 0.5, r.y + 0.5, r.y + r.h - 0.5]
    return p.y === q.y
      ? p.y > y0 && p.y < y1 && Math.max(p.x, q.x) > x0 && Math.min(p.x, q.x) < x1
      : p.x === q.x && p.x > x0 && p.x < x1 && Math.max(p.y, q.y) > y0 && Math.min(p.y, q.y) < y1
  }
  const runsOver = (p: Point, q: Point, t: Point) =>
    (p.y === q.y && Math.abs(t.y - p.y) < 0.5 && t.x > Math.min(p.x, q.x) + 0.5 && t.x < Math.max(p.x, q.x) - 0.5) ||
    (p.x === q.x && Math.abs(t.x - p.x) < 0.5 && t.y > Math.min(p.y, q.y) + 0.5 && t.y < Math.max(p.y, q.y) - 0.5)
  const turnsBack = (a: Point, b: Point, c: Point) => {
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    return dot < 0 && Math.abs(cross) < 1e-6
  }
  const axisAligned = (o: PlacedObject) => (o.rotation ?? 0) % 90 === 0
  for (const example of examples) {
    const doc = example.build(GRID)
    const nets = buildNets(doc.objects, doc.wires, GRID)
    const routes = nudgeRoutes(new Router().routeAll(doc.objects, doc.wires, GRID), nets.netOfWire, GRID)
    const wireById = new Map(doc.wires.map((w) => [w.id, w]))
    const refOf = (id: string) => doc.objects.find((o) => o.id === id)?.props?.ref ?? id
    const name = (id: string) => {
      const w = wireById.get(id)!
      return `${refOf(w.from.object)}.${w.from.pin}→${refOf(w.to.object)}.${w.to.pin}`
    }
    const issues = new Set<string>()
    for (const r of routes) {
      const w = wireById.get(r.id)!
      for (let i = 1; i + 1 < r.pts.length; i++) if (turnsBack(r.pts[i - 1], r.pts[i], r.pts[i + 1])) issues.add(`${name(r.id)} doubles back`)
      for (const o of doc.objects) {
        if (o.id === w.from.object || o.id === w.to.object || !axisAligned(o)) continue
        const rect = objectRect(o, GRID)
        if (r.pts.some((p, i) => i > 0 && segmentCrosses(r.pts[i - 1], p, rect))) issues.add(`${name(r.id)} crosses ${refOf(o.id)}`)
        for (const pin of objectPins(o, GRID)) {
          if (pin.pin.kind === "nc") continue
          if (r.pts.some((p, i) => i > 0 && runsOver(r.pts[i - 1], p, pin.point))) issues.add(`${name(r.id)} runs over ${refOf(o.id)}.${pin.pin.id}`)
        }
      }
    }
    expect(example.id, [...issues].join("; ") || "clean", "clean")
  }
}

console.log(`\n${total - failed}/${total} checks passed in ${Math.round(performance.now() - wall0)} ms`)
process.exit(failed ? 1 : 0)
