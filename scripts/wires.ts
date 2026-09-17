import { readFileSync } from "node:fs"
import { join } from "node:path"
import { builder } from "@/schematic/builder"
import { lab1Stand } from "@/schematic/examples"
import { GRID, nudgeRoutes, objectRect, routeAll, toPath, type Point, type RoutedWire } from "@/schematic/geometry"
import { buildNets } from "@/schematic/nets"
import { autoNetColor, semanticNetColor, WIRE_COLORS } from "@/schematic/wire-colors"
import { tapWireAt } from "@/schematic/wiring"
import { partKey, pinKey, type PinKind, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"

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

console.log(`\n${total - failed}/${total} checks passed in ${Math.round(performance.now() - wall0)} ms`)
process.exit(failed ? 1 : 0)
