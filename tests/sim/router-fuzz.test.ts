import { appendFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { bodiesOf, crossedBody } from "@/schematic/body-crossing"
import { GRID, type Point } from "@/schematic/geometry"
import { wirePins } from "@/schematic/migrate-wires"
import { placementCheck } from "@/schematic/placement"
import type { PlacedObject, Rotation, Schematic } from "@/schematic/types"
import { drawEndAt, drawnTo, isRefusal, pointerAt, previewOf, startDrawing, type DrawEnd } from "@/schematic/wire-draw"
import { inNormalForm, wiringOf } from "@/schematic/wire-edits"
import { junctionsOf, WireGraph, wireNets } from "@/schematic/wires/graph"
import { isRerouteRefusal, rerouted, routeBetween, type RouteEnd } from "@/schematic/wires/router"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"
import { geometricGroups } from "../lib/pin-partition"
import { bestShape, cells, shapeOf } from "../lib/route-reference"
import { normalFormViolations, random } from "../lib/wire-reference"

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 80)
const FIRST_SEED = Number(process.env.FUZZ_FIRST ?? 1)
const OPS = Number(process.env.FUZZ_OPS ?? 14)
const LOG = process.env.PROBE_OUT
const log = (...a: unknown[]) => LOG && appendFileSync(LOG, a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n")

const c = (v: number) => v * GRID
const HALF = GRID / 2
const show = (p: Point) => `(${p.x / GRID}, ${p.y / GRID})`
const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y
const key = (p: Point) => `${p.x},${p.y}`

type Area = { x0: number; y0: number; x1: number; y1: number }

const BOARDS: { def: string; area: Area }[] = [
  { def: "nucleo-f429zi", area: { x0: -16, y0: 14, x1: 4, y1: 40 } },
  { def: "weact-blackpill-f411", area: { x0: 16, y0: -2, x1: 32, y1: 12 } },
]
const PARTS = ["resistor", "resistor", "resistor", "led", "capacitor", "diode", "npn", "capacitor-polarized", "pushbutton", "opamp-generic"]
const PLAIN_PARTS = ["resistor", "resistor", "led", "capacitor", "diode"]
const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270]

function sceneOf(seed: number): { doc: Schematic; label: string; boardless: boolean } {
  const rnd = random(seed)
  const objects: PlacedObject[] = []
  let area: Area = { x0: -4, y0: -4, x1: 16, y1: 14 }
  let label = ""
  const plain = seed % 3 === 0
  if (!plain && rnd.chance(0.55)) {
    const b = rnd.pick(BOARDS)
    objects.push({ id: "U1", def: b.def, x: 0, y: 0, props: { ref: "U1" } })
    area = b.area
    label = b.def
  }
  const count = rnd.int(3, 8)
  let n = 0
  for (let tries = 0; n < count && tries < 200; tries++) {
    const def = rnd.pick(plain ? PLAIN_PARTS : PARTS)
    const id = `${def === "resistor" ? "R" : def === "led" ? "D" : def === "opamp-generic" ? "A" : def === "npn" ? "Q" : "C"}${n + 2}`
    const o: PlacedObject = { id, def, x: c(rnd.int(area.x0, area.x1)), y: c(rnd.int(area.y0, area.y1)), props: { ref: id }, ...(rnd.chance(0.6) && { rotation: rnd.pick(ROTATIONS) }) }
    if (objects.length && placementCheck({ objects, routes: [], grid: GRID }, [o])(0, 0)) continue
    objects.push(o)
    n++
  }
  let doc = inNormalForm({ objects, wires: [], parts: {} })
  const pins = wirePins(doc.objects)
  const near = pins.filter((p) => p.at.x >= c(area.x0 - 4) && p.at.x <= c(area.x1 + 8) && p.at.y >= c(area.y0 - 4) && p.at.y <= c(area.y1 + 8))
  const wires = rnd.int(1, 5)
  for (let k = 0; k < wires && near.length > 1; k++) {
    const a = rnd.pick(near)
    const b = rnd.pick(near)
    if (a.key === b.key) continue
    const route = routeBetween(doc, endOfKey(a.key), endOfKey(b.key))
    if (route && route.length > 1) doc = inNormalForm({ ...doc, wires: [...doc.wires, ...pathOf(route, `w${k}`)] })
  }
  const dangling = rnd.int(0, 4)
  for (let k = 0; k < dangling; k++) {
    const half = rnd.chance(0.3)
    const a = { x: c(rnd.int(area.x0, area.x1)) + (half ? HALF : 0), y: c(rnd.int(area.y0, area.y1)) }
    const len = c(rnd.int(1, 6)) * (rnd.chance(0.5) ? 1 : -1)
    const b = rnd.chance(0.5) ? { x: a.x + len, y: a.y } : { x: a.x, y: a.y + len }
    const s = { id: `d${k}`, a, b }
    if (crossedBody(s, bodiesOf(doc.objects))) continue
    doc = inNormalForm({ ...doc, wires: [...doc.wires, s] })
  }
  return { doc, label: `seed ${seed}${label ? ` ${label}` : ""}`, boardless: plain }
}

const endOfKey = (k: string): RouteEnd => ({ pin: { object: k.slice(0, k.indexOf(":")), pin: k.slice(k.indexOf(":") + 1) } })

let serial = 0
const pathOf = (pts: readonly Point[], prefix = "n"): WireSegment[] => pts.slice(1).map((b, i) => ({ id: `${prefix}${++serial}`, a: pts[i], b }))

function revisits(points: readonly Point[]): Point | null {
  const seen = new Set<string>()
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const n = Math.round((Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) / HALF)
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const p = { x: a.x + (Math.sign(b.x - a.x) * HALF * k), y: a.y + (Math.sign(b.y - a.y) * HALF * k) }
      if (seen.has(key(p))) return p
      seen.add(key(p))
    }
  }
  return null
}

function groupsOf(doc: Schematic): Map<string, string> {
  const pins = wirePins(doc.objects)
  const view = wireNets(doc.wires, pins)
  const out = new Map<string, string>()
  for (const p of pins) out.set(p.key, view.netOfPin(p.key) ?? `pin:${p.key}`)
  return out
}

function canonical(netOf: Map<string, string>): string[] {
  const by = new Map<string, string[]>()
  for (const [k, n] of netOf) by.set(n, [...(by.get(n) ?? []), k])
  return [...by.values()].map((g) => g.sort().join(" ")).sort()
}

function joined(netOf: Map<string, string>, a: string | undefined, b: string | undefined): string[] {
  if (a === undefined || b === undefined) return canonical(netOf)
  const na = netOf.get(a)
  const nb = netOf.get(b)
  const out = new Map(netOf)
  for (const [k, n] of out) if (n === nb) out.set(k, na!)
  return canonical(out)
}

function diff(want: string[], got: string[]): string {
  const w = new Set(want)
  const g = new Set(got)
  return `lost [${want.filter((x) => !g.has(x)).join(" | ")}] gained [${got.filter((x) => !w.has(x)).join(" | ")}]`
}

function steps(s: { a: Point; b: Point }): string[] {
  const out: string[] = []
  const n = Math.round((Math.abs(s.b.x - s.a.x) + Math.abs(s.b.y - s.a.y)) / HALF)
  const dx = Math.sign(s.b.x - s.a.x) * HALF
  const dy = Math.sign(s.b.y - s.a.y) * HALF
  for (let i = 0; i < n; i++) {
    const p = { x: s.a.x + dx * i, y: s.a.y + dy * i }
    const q = { x: p.x + dx, y: p.y + dy }
    out.push([key(p), key(q)].sort().join("|"))
  }
  return out
}

function stepSet(wires: readonly { a: Point; b: Point }[]): Set<string> {
  const out = new Set<string>()
  for (const s of wires) for (const t of steps(s)) out.add(t)
  return out
}

const interiorOf = (s: { a: Point; b: Point }, p: Point) =>
  s.a.y === s.b.y ? p.y === s.a.y && p.x > Math.min(s.a.x, s.b.x) && p.x < Math.max(s.a.x, s.b.x) : p.x === s.a.x && p.y > Math.min(s.a.y, s.b.y) && p.y < Math.max(s.a.y, s.b.y)

function socketsAcross(after: Schematic, newSteps: ReadonlySet<string>): string[] {
  const out: string[] = []
  const pins = wirePins(after.objects).filter((p) => p.socket)
  for (const s of after.wires) {
    if (!steps(s).some((t) => newSteps.has(t))) continue
    const horizontal = s.a.y === s.b.y
    for (const p of pins) {
      if (!interiorOf(s, p.at)) continue
      const along = !!p.out && (horizontal ? p.out.y === 0 : p.out.x === 0)
      if (!along) out.push(`passes the socket ${p.key} ${show(p.at)} across its row`)
    }
  }
  return out
}

function throughBodies(after: Schematic, newSteps: ReadonlySet<string>): string[] {
  const bodies = bodiesOf(after.objects)
  const out: string[] = []
  for (const s of after.wires) {
    if (!steps(s).some((t) => newSteps.has(t))) continue
    const crossed = crossedBody(s, bodies)
    if (crossed) out.push(`${show(s.a)}→${show(s.b)} runs through ${crossed.object.props?.ref ?? crossed.object.id}`)
  }
  return out
}

function whatIsAt(doc: Schematic, k: string): string {
  const [x, y] = k.split(",").map(Number)
  const p = { x, y }
  const pins = wirePins(doc.objects)
  const view = wireNets(doc.wires, pins)
  const here = doc.wires.filter((s) => same(s.a, p) || same(s.b, p) || interiorOf(s, p)).map((s) => `${s.id}[${same(s.a, p) || same(s.b, p) ? "end" : "through"} ${view.netOfSegment(s.id)}]`)
  const ps = pins.filter((q) => same(q.at, p)).map((q) => `${q.key}[${view.netOfPin(q.key)}]`)
  return `${show(p)} before: ${[...here, ...ps].join(" ") || "nothing"}`
}

function dotsOf(doc: Schematic): Set<string> {
  return new Set(junctionsOf(wireNets(doc.wires, wirePins(doc.objects))).map((p: Point) => key(p)))
}

function ownOnly(doc: Schematic, k: string, own: ReadonlySet<string | undefined>): boolean {
  const [x, y] = k.split(",").map(Number)
  const p = { x, y }
  const pins = wirePins(doc.objects)
  const view = wireNets(doc.wires, pins)
  const nets = [...doc.wires.filter((s) => same(s.a, p) || same(s.b, p) || interiorOf(s, p)).map((s) => view.netOfSegment(s.id)), ...pins.filter((q) => same(q.at, p)).map((q) => view.netOfPin(q.key) ?? `pin:${q.key}`)]
  return nets.length > 0 && nets.every((n) => own.has(n))
}

type CheckOptions = { readonly own?: ReadonlySet<string | undefined>; readonly sockets?: "any-direction" }

function checks(kind: string, before: Schematic, after: Schematic, want: string[], allowedDots: readonly Point[] | "none-new" | "subset", options: CheckOptions = {}): string[] {
  const out: string[] = []
  const got = canonical(groupsOf(after))
  if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${kind}: partition ${diff(want, got)}`)
  const nf = normalFormViolations(after.wires, wirePins(after.objects))
  if (nf.length) out.push(`${kind}: normal form ${nf.slice(0, 2).join("; ")}`)
  const oldSteps = stepSet(before.wires)
  const newSteps = new Set([...stepSet(after.wires)].filter((t) => !oldSteps.has(t)))
  if (options.sockets !== "any-direction") out.push(...socketsAcross(after, newSteps).map((m) => `${kind}: ${m}`))
  out.push(...throughBodies(after, newSteps).map((m) => `${kind}: ${m}`))
  const dotsBefore = dotsOf(before)
  const dotsAfter = dotsOf(after)
  if (allowedDots === "subset") {
    for (const d of dotsAfter) if (!dotsBefore.has(d)) out.push(`${kind}: a new dot at ${whatIsAt(before, d)}`)
  } else {
    const allowed = new Set(allowedDots === "none-new" ? [] : allowedDots.map(key))
    for (const d of dotsAfter) if (!dotsBefore.has(d) && !allowed.has(d) && !ownOnly(before, d, options.own ?? new Set())) out.push(`${kind}: a new dot at ${whatIsAt(before, d)}`)
  }
  return out
}

function targetsIn(doc: Schematic, rnd: ReturnType<typeof random>): WirePin[] {
  const pins = wirePins(doc.objects)
  const wired = new Set<string>()
  for (const s of doc.wires) for (const p of [s.a, s.b]) wired.add(key(p))
  const nearWires = pins.filter((p) => doc.wires.some((s) => Math.abs(s.a.x - p.at.x) + Math.abs(s.a.y - p.at.y) < c(20)))
  return nearWires.length > 4 && rnd.chance(0.7) ? nearWires : pins
}

describe("random wire edits preserve their connection rules (fuzz)", () => {
  it("drawing joins every passed contact; routeBetween and rerouted keep other nets separate; every edit stays off bodies and keeps normal form", () => {
    const found: string[] = []
    const tally = { scenes: 0, routes: 0, nulls: 0, draws: 0, drawRefused: 0, routedDraws: 0, moved: 0, reroutes: 0, rerouteRefused: 0, reference: 0 }
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
      const { doc: start, label, boardless } = sceneOf(seed)
      tally.scenes++
      const rnd = random(seed * 7919 + 1)
      let doc = start
      for (let op = 0; op < OPS; op++) {
        const pins = targetsIn(doc, rnd)
        if (pins.length < 2) break
        const kind = rnd.int(0, 2)
        const before = doc
        const netOf = groupsOf(before)
        if (kind === 0) {
          const a = rnd.pick(pins)
          const b = rnd.pick(pins)
          if (a.key === b.key) continue
          const route = routeBetween(before, endOfKey(a.key), endOfKey(b.key))
          tally.routes++
          if (!route) {
            tally.nulls++
            continue
          }
          if (!same(route[0], a.at) || !same(route[route.length - 1], b.at)) found.push(`${label} route ${a.key}→${b.key}: does not run from pin to pin ${JSON.stringify(cells(route))}`)
          for (const p of route) if (!Number.isInteger((2 * p.x) / GRID) || !Number.isInteger((2 * p.y) / GRID)) found.push(`${label} route ${a.key}→${b.key}: ${show(p)} off the half-cell lattice`)
          for (let i = 1; i < route.length; i++) if (route[i].x !== route[i - 1].x && route[i].y !== route[i - 1].y) found.push(`${label} route ${a.key}→${b.key}: diagonal piece`)
          const back = revisits(route)
          if (back) found.push(`${label} route ${a.key}→${b.key}: comes back to ${show(back)} ${JSON.stringify(cells(route))}`)
          const after = inNormalForm({ ...before, wires: [...before.wires, ...pathOf(route)] })
          const corners = route.slice(1, -1)
          found.push(...checks(`${label} route ${a.key}→${b.key} ${JSON.stringify(cells(route))}`, before, after, joined(netOf, a.key, b.key), [a.at, b.at]).map((m) => m))
          for (const p of corners) {
            if (before.wires.some((s) => interiorOf(s, p) || same(s.a, p) || same(s.b, p))) found.push(`${label} route ${a.key}→${b.key}: a corner ${show(p)} on a wire`)
            if (wirePins(before.objects).some((q) => same(q.at, p))) found.push(`${label} route ${a.key}→${b.key}: a corner ${show(p)} on a pin`)
          }
          for (let i = 1; i < route.length; i++) {
            const s = { a: route[i - 1], b: route[i] }
            for (const w of before.wires) {
              const collinear = (s.a.y === s.b.y && w.a.y === w.b.y && s.a.y === w.a.y) || (s.a.x === s.b.x && w.a.x === w.b.x && s.a.x === w.a.x)
              if (!collinear) continue
              const along = (p: Point) => (s.a.y === s.b.y ? p.x : p.y)
              const overlap = Math.min(Math.max(along(s.a), along(s.b)), Math.max(along(w.a), along(w.b))) - Math.max(Math.min(along(s.a), along(s.b)), Math.min(along(w.a), along(w.b)))
              if (overlap > 0) found.push(`${label} route ${a.key}→${b.key}: runs along ${w.id} ${show(w.a)}→${show(w.b)} (net ${netOf.get(a.key) === wireNets(before.wires, wirePins(before.objects)).netOfSegment(w.id) ? "own" : "other"})`)
            }
            for (const w of before.wires) for (const e of [w.a, w.b]) if (interiorOf(s, e)) found.push(`${label} route ${a.key}→${b.key}: ${w.id}'s end ${show(e)} on the route`)
          }
          const wholeEnds = Number.isInteger(a.at.x / GRID) && Number.isInteger(a.at.y / GRID) && Number.isInteger(b.at.x / GRID) && Number.isInteger(b.at.y / GRID)
          const viewBefore = wireNets(before.wires, wirePins(before.objects))
          const freshNets = !before.wires.some((s) => {
            const n = viewBefore.netOfSegment(s.id)
            return n === netOf.get(a.key) || n === netOf.get(b.key)
          })
          const contacts = wirePins(before.objects).filter((q) => q.key !== a.key && q.key !== b.key && (same(q.at, a.at) || same(q.at, b.at)))
          if (boardless && wholeEnds && freshNets && !contacts.length) {
            tally.reference++
            const want = bestShape(before, a.at, b.at)
            const got = shapeOf(before, route)
            const cost = (s: { crossings: number; bends: number }) => s.crossings * 1.5 + s.bends
            if (got.faults.length) found.push(`${label} route ${a.key}→${b.key}: reference faults ${got.faults.join("; ")} ${JSON.stringify(cells(route))}`)
            else if (want && (cost(want) < cost(got) || (cost(want) === cost(got) && want.length < got.length))) found.push(`${label} route ${a.key}→${b.key}: ${got.crossings}/${got.bends}/${got.length} where the reference finds ${want.crossings}/${want.bends}/${want.length} ${JSON.stringify(cells(route))}`)
          }
          doc = after
        } else if (kind === 1) {
          const a = rnd.pick(pins)
          const targetKind = rnd.int(0, 3)
          let target: DrawEnd
          const wiring = wiringOf(new WireGraph(), before)
          if (targetKind === 0 && before.wires.length) {
            const s = rnd.pick(before.wires)
            const pts = [s.a, s.b]
            const p = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
            const snapped = { x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID }
            target = drawEndAt(wiring, snapped)
          } else target = drawEndAt(wiring, rnd.pick(pins).at)
          const started = startDrawing(wiring, drawEndAt(wiring, a.at))
          if (isRefusal(started)) continue
          const d = pointerAt(started, target.at)
          tally.draws++
          const preview = previewOf(before, wiring, d, target)
          const result = drawnTo(before, wiring, d, target, () => `x${++serial}`)
          if (isRefusal(result)) {
            tally.drawRefused++
            if (!preview.refused && preview.points.length > 1) found.push(`${label} draw ${a.key}→${target.kind} ${show(target.at)}: refused ${result.refused} but the preview was not`)
            continue
          }
          if (preview.refused) found.push(`${label} draw ${a.key}→${target.kind} ${show(target.at)}: laid though the preview was refused ${preview.refused.refused}`)
          if (preview.routed) tally.routedDraws++
          const backAt = revisits(preview.points)
          if (backAt) found.push(`${label} draw ${a.key}→${target.kind} ${show(target.at)} routed=${preview.routed}: comes back to ${show(backAt)} ${JSON.stringify(cells(preview.points))}`)
          const movedIds = new Set(preview.moved.flatMap((m) => wiring.runById.get(m.run)!.segments.map((s) => s.id)))
          const drawn = pathOf(preview.points)
          const expectedWires = [...before.wires.filter((s) => !movedIds.has(s.id)), ...drawn, ...preview.moved.flatMap((m) => pathOf(m.points))]
          const contacts = wirePins(before.objects)
          const want = geometricGroups(contacts, expectedWires).map((g) => g.sort().join(" ")).sort()
          const allowedDots = [a.at, target.at, ...before.wires.flatMap((s) => [s.a, s.b]), ...contacts.filter((p) => !p.socket).map((p) => p.at)]
            .filter((p) => drawn.some((s) => same(s.a, p) || same(s.b, p) || interiorOf(s, p)))
          const oldSteps = stepSet(before.wires)
          const afterSteps = stepSet(result.wires)
          const missing: string[] = []
          for (let i = 1; i < preview.points.length; i++) for (const t of steps({ a: preview.points[i - 1], b: preview.points[i] })) if (!afterSteps.has(t)) missing.push(t)
          if (missing.length) found.push(`${label} draw ${a.key}→${target.kind} ${show(target.at)}: the click did not lay the preview (${missing.length} steps missing)`)
          const removedOld = [...oldSteps].filter((t) => !afterSteps.has(t))
          if (removedOld.length) tally.moved++
          const targetNet = target.kind === "pin" ? netOf.get(target.key) : (() => { const s = wiring.sheet.through(target.at)[0]; return s && (wiring.view.netOfSegment(s.id) ?? `wire:${s.id}`) })()
          found.push(...checks(`${label} draw ${a.key}[${netOf.get(a.key)}]→${target.kind} ${show(target.at)} routed=${preview.routed} ${JSON.stringify(cells(preview.points))}`, before, result, want, allowedDots, { own: preview.routed ? new Set() : new Set([netOf.get(a.key), targetNet]), sockets: "any-direction" }))
          doc = result
        } else {
          if (!before.wires.length) continue
          const s = rnd.pick(before.wires)
          tally.reroutes++
          const result = rerouted(before, s.id, () => `t${++serial}`)
          if (isRerouteRefusal(result)) {
            tally.rerouteRefused++
            continue
          }
          const rerouteFound = checks(`${label} reroute ${s.id} ${show(s.a)}→${show(s.b)}`, before, result, canonical(netOf), "subset")
          found.push(...rerouteFound)
          const newIds = result.wires.filter((w) => !before.wires.some((v) => v.id === w.id))
          if (newIds.length) {
            const again = rerouted(result, newIds[0].id, () => `t${++serial}`)
            if (!isRerouteRefusal(again) && again !== result) {
              const g1 = [...stepSet(result.wires)].sort()
              const g2 = [...stepSet(again.wires)].sort()
              if (JSON.stringify(g1) !== JSON.stringify(g2)) found.push(`${label} reroute ${s.id}: re-routing the re-routed run again moves it`)
            }
          }
          doc = result
        }
      }
    }
    log("tally", tally)
    for (const f of found) log(f)
    expect.soft(tally.scenes, "scenes").toBe(SEEDS)
    expect.soft(found, "every edit clean").toEqual([])
  })
})
