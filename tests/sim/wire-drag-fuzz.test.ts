import { describe, expect, it } from "vitest"
import { examples } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { flipLine, selectionStep, turnedAbout, turnPivot } from "@/schematic/orient"
import { flippedWithWires, PartDrag, SegmentDrag, TurnRun, type Landed } from "@/schematic/rubber-band"
import type { Point, Schematic } from "@/schematic/types"
import { inNormalForm, pinsOf, travellingWires, wiringOf, type Wiring } from "@/schematic/wire-edits"
import { WireGraph, wireNets } from "@/schematic/wires/graph"
import type { WireSegment } from "@/schematic/wires/segment"
import { normalFormViolations, random, referencePartition } from "../lib/wire-reference"

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 2)
const ONLY = process.env.FUZZ_ONLY

const contains = (s: WireSegment, p: Point) =>
  s.a.y === s.b.y ? p.y === s.a.y && p.x >= Math.min(s.a.x, s.b.x) && p.x <= Math.max(s.a.x, s.b.x) : p.x === s.a.x && p.y >= Math.min(s.a.y, s.b.y) && p.y <= Math.max(s.a.y, s.b.y)
const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y

type Explain = { at: Point; net: string }

function unexplained(before: Schematic, after: Schematic, explains: readonly Explain[], carried: ReadonlySet<string>): string[] {
  const view = wireNets(before.wires, pinsOf(before.objects))
  const netOfPin = (key: string) => view.netOfPin(key) ?? `pin:${key}`
  const parent = new Map<string, string>()
  const find = (n: string): string => {
    const up = parent.get(n)
    if (!up || up === n) return n
    const root = find(up)
    parent.set(n, root)
    return root
  }
  const union = (a: string, b: string) => parent.set(find(a), find(b))
  const beforePins = pinsOf(before.objects)
  const nameOf = (key: string) => { const o = before.objects.find((x) => x.id === key.slice(0, key.indexOf(":"))); return `${o?.props?.ref ?? o?.def}.${key.slice(key.indexOf(":") + 1)}` }
  for (const e of explains) {
    for (const s of before.wires) if (contains(s, e.at)) union(e.net, view.netOfSegment(s.id) ?? `wire:${s.id}`)
    for (const p of beforePins) if (!carried.has(p.key.slice(0, p.key.indexOf(":"))) && same(p.at, e.at)) union(e.net, netOfPin(p.key))
  }
  const out: string[] = []
  for (const group of referencePartition(after.wires, pinsOf(after.objects))) {
    const roots = new Map<string, string[]>()
    for (const key of group) {
      const r = find(netOfPin(key))
      roots.set(r, [...(roots.get(r) ?? []), key])
    }
    if (roots.size > 1) out.push([...roots.values()].map((keys) => keys.slice(0, 3).map(nameOf).join(",")).join(" + "))
  }
  return out
}

function hanging(wiring: Wiring, keys: readonly string[]): Set<string> {
  const sheet = wiring.sheet
  const out = new Set<string>()
  for (const key of keys) {
    const pin = sheet.pin(key)
    if (!pin) continue
    for (const first of sheet.endsAt(pin.at)) {
      const chain = [first]
      let at = same(first.a, pin.at) ? first.b : first.a
      let through = first
      for (;;) {
        if (sheet.pinsAt(at).length) break
        const ends = sheet.endsAt(at)
        if (ends.length === 1) {
          for (const s of chain) out.add(s.id)
          break
        }
        if (ends.length !== 2) break
        through = ends[0] === through ? ends[1] : ends[0]
        if (chain.includes(through)) break
        chain.push(through)
        at = same(through.a, at) ? through.b : through.a
      }
    }
  }
  return out
}

function freeEnds(doc: Schematic, ids: ReadonlySet<string>, view: ReturnType<typeof wireNets>, transform: (p: Point) => Point): Explain[] {
  const pins = pinsOf(doc.objects)
  const out: Explain[] = []
  const byId = new Map(doc.wires.map((s) => [s.id, s]))
  for (const id of ids) {
    const s = byId.get(id)
    if (!s) continue
    for (const end of [s.a, s.b]) {
      const meeting = doc.wires.filter((t) => same(t.a, end) || same(t.b, end)).length
      if (meeting === 1 && !pins.some((p) => same(p.at, end))) out.push({ at: transform(end), net: view.netOfSegment(s.id) ?? `wire:${s.id}` })
    }
  }
  return out
}

function carriedPinExplains(before: Schematic, after: Schematic, ids: ReadonlySet<string>): Explain[] {
  const view = wireNets(before.wires, pinsOf(before.objects))
  return pinsOf(after.objects.filter((o) => ids.has(o.id))).map((p) => ({ at: p.at, net: view.netOfPin(p.key) ?? `pin:${p.key}` }))
}

const docs = examples.filter((e) => !ONLY || e.id === ONLY).map((e) => ({ id: e.id, doc: inNormalForm(e.build(GRID)) }))

const unlaidSeen: string[] = []
function report(kind: string, where: string, before: Schematic, landed: Landed, explains: Explain[], ids: ReadonlySet<string>, found: string[]) {
  for (const u of landed.unlaid) unlaidSeen.push(`${kind} ${where} kept=${u.kept} pin=${u.pin}`)
  if (landed.refused) { unlaidSeen.push(`${kind} ${where} REFUSED`); return }
  const pins = pinsOf(landed.doc.objects)
  const nf = normalFormViolations(landed.doc.wires, pins)
  if (nf.length) found.push(`${kind} ${where}: normal form ${nf.slice(0, 2).join("; ")}`)
  const bad = unexplained(before, landed.doc, explains, ids)
  if (bad.length) found.push(`${kind} ${where}: unexplained join ${bad.slice(0, 2).join(" | ")}${landed.unlaid.length ? ` (unlaid ${landed.unlaid.length})` : ""}`)
}

describe("random edits on every example against an oracle of explained joins (review of phase 4, Claude 1)", () => {
  it("part drags, segment drags, Alt segment drags, turns and mirrors on the examples join no net but where a carried pin or carried free end lands", () => {
    const found: string[] = []
    const tally = { drags: 0, refused: 0, segments: 0, detached: 0, turns: 0, flips: 0, unlaid: 0 }
    for (const { id, doc } of docs) {
      const wiring = wiringOf(new WireGraph(), doc)
      const view = wiring.view
      const parts = doc.objects.map((o) => o.id)
      if (!parts.length) continue
      for (let seed = 1; seed <= SEEDS; seed++) {
        const rng = random(seed * 104729 + id.length * 31 + id.charCodeAt(0))
        const pick = () => parts[rng.int(0, parts.length - 1)]
        const ids = new Set([pick(), ...(rng.chance(0.3) ? [pick()] : [])])
        const far = rng.chance(0.3)
        const dx = rng.int(far ? -14 : -4, far ? 14 : 4) * GRID
        const dy = rng.int(far ? -14 : -4, far ? 14 : 4) * GRID
        const detach = rng.chance(0.1)
        const refOf = (oid: string) => { const i = doc.objects.findIndex((o) => o.id === oid); return `#${i}:${doc.objects[i].props?.ref ?? doc.objects[i].def}` }
        const where = `${id} seed ${seed} [${[...ids].map(refOf).join(",")}] by (${dx / GRID},${dy / GRID})${detach ? " alt" : ""}`
        try {
          const drag = new PartDrag(doc, wiring, { objects: ids }, { detach })
          const landed = drag.landed(dx, dy)
          tally.drags++
          if (landed.refused) tally.refused++
          if (landed.unlaid.length) tally.unlaid++
          const at = landed.at
          const keys = pinsOf(doc.objects.filter((o) => ids.has(o.id))).map((p) => p.key)
          const rigid = new Set([...travellingWires(doc, ids, wiring), ...(detach ? [] : hanging(wiring, keys))])
          const explains = [...carriedPinExplains(doc, landed.doc, ids), ...freeEnds(doc, rigid, view, (p) => ({ x: p.x + at.x, y: p.y + at.y }))]
          report("drag", where, doc, landed, explains, ids, found)
        } catch (e) {
          found.push(`drag ${where}: threw ${(e as Error).message}`)
        }
        if (doc.wires.length) {
          const s = doc.wires[rng.int(0, doc.wires.length - 1)]
          const off = rng.int(-4, 4) * GRID
          const sw = `${id} seed ${seed} segment ${s.id} by ${off / GRID}`
          try {
            const sd = new SegmentDrag(doc, wiring, s.id)
            const landed = sd.landed(off, off)
            tally.segments++
            const at = landed.at
            const neighbours = new Set(doc.wires.filter((t) => [t.a, t.b].some((p) => same(p, s.a) || same(p, s.b))).map((t) => t.id))
            const net = view.netOfSegment(s.id) ?? `wire:${s.id}`
            const explains = [{ at: { x: s.a.x + at.x, y: s.a.y + at.y }, net }, { at: { x: s.b.x + at.x, y: s.b.y + at.y }, net }, ...freeEnds(doc, neighbours, view, (p) => ({ x: p.x + at.x, y: p.y + at.y }))]
            report("segment", sw, doc, landed, explains, new Set(), found)
          } catch (e) {
            found.push(`segment ${sw}: threw ${(e as Error).message}`)
          }
          const altRng = random(seed * 7919 + id.length * 17 + id.charCodeAt(0))
          const ax = altRng.int(-6, 6) * GRID
          const ay = altRng.int(-6, 6) * GRID
          const aw = `${id} seed ${seed} segment ${s.id} alt by (${ax / GRID},${ay / GRID})`
          try {
            const landed = new SegmentDrag(doc, wiring, s.id, undefined, { detach: true }).landed(ax, ay)
            tally.detached++
            const at = landed.at
            const net = view.netOfSegment(s.id) ?? `wire:${s.id}`
            const run = wiring.runBySegment.get(s.id)!.segments
            const explains = run.flatMap((r) => [r.a, r.b]).map((p) => ({ at: { x: p.x + at.x, y: p.y + at.y }, net }))
            report("alt-segment", aw, doc, landed, explains, new Set(), found)
          } catch (e) {
            found.push(`alt-segment ${aw}: threw ${(e as Error).message}`)
          }
        }
        const presses = [1, -1, 2, -2, 3][rng.int(0, 4)]
        const tw = `${id} seed ${seed} [${[...ids].map(refOf).join(",")}] turned ${presses}`
        try {
          const run = new TurnRun(doc, wiring, ids)
          let landed: Landed = { doc, unlaid: [], at: { x: 0, y: 0 } }
          for (let k = 0; k < Math.abs(presses); k++) landed = run.turned(presses > 0 ? 1 : -1)
          tally.turns++
          const pivot = turnPivot(doc, ids, GRID)
          if (pivot) {
            const degrees = run.doc === doc ? 0 : presses * selectionStep(doc, ids)
            const keys = pinsOf(doc.objects.filter((o) => ids.has(o.id))).map((p) => p.key)
            const rigid = new Set([...travellingWires(doc, ids, wiring), ...hanging(wiring, keys)])
            const explains = [...carriedPinExplains(doc, landed.doc, ids), ...freeEnds(doc, rigid, view, (p) => turnedAbout(p, pivot, degrees))]
            report("turn", tw, doc, landed, explains, ids, found)
          }
        } catch (e) {
          found.push(`turn ${tw}: threw ${(e as Error).message}`)
        }
        const axis = rng.chance(0.5) ? "horizontal" : "vertical"
        const fw = `${id} seed ${seed} [${[...ids].map(refOf).join(",")}] mirrored ${axis}`
        try {
          const landed = flippedWithWires(doc, wiring, ids, axis)
          tally.flips++
          const line = flipLine(doc, ids, axis, GRID)
          if (line !== null) {
            const keys = pinsOf(doc.objects.filter((o) => ids.has(o.id))).map((p) => p.key)
            const rigid = new Set([...travellingWires(doc, ids, wiring), ...hanging(wiring, keys)])
            const mirror = (p: Point) => (axis === "horizontal" ? { x: line - p.x, y: p.y } : { x: p.x, y: line - p.y })
            const explains = [...carriedPinExplains(doc, landed.doc, ids), ...freeEnds(doc, rigid, view, mirror)]
            report("flip", fw, doc, landed, explains, ids, found)
          }
        } catch (e) {
          found.push(`flip ${fw}: threw ${(e as Error).message}`)
        }
      }
    }
    expect.soft(found, "no unexplained join").toEqual([])
  }, 600_000)
})
