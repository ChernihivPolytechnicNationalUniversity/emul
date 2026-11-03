import { existsSync, readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { GRID, objectPins, Router } from "@/schematic/geometry"
import { designatorRects } from "@/schematic/placement"
import { getDef } from "@/schematic/registry"
import type { Point, Schematic } from "@/schematic/types"
import { canonical, duplicateRefs, geometricGroups, partitionDiff, pinPartition, polylineSegments, renamed, type RefPin, type RefSegment } from "../lib/pin-partition"
import { fixturePath, PARTITIONS, partitionDocuments, readFixture } from "../lib/partition-documents"

const documents = await partitionDocuments()

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

describe("the pin partition every later phase must keep: the groups of pins on one net, by designator and pin", () => {
  it("every example and every .emul under tests/data has its partition frozen, and today's model still gives exactly that", () => {
    for (const { name, doc } of documents) {
      const fixture = readFixture(name)
      expect.soft(fixture, `${name}: no fixture at ${fixturePath(name)} — run scripts/pin-partitions.ts`).not.toBeNull()
      if (fixture) expect.soft(pinPartition(doc, GRID), `${name}: partition from today's wires and contacts`).toEqual(fixture.nets)
    }
  })

  it("no fixture outlives its document", () => {
    const names = new Set(documents.map((d) => d.name))
    const stale = readdirSync(PARTITIONS).filter((file) => file.endsWith(".json") && !names.has(file.slice(0, -".json".length)))
    expect(stale, "fixtures with no example or .emul behind them").toEqual([])
  })

  it("keys are designator and pin, never an object id, and no designator is used twice in a document", () => {
    for (const { name, doc } of documents) {
      expect.soft(duplicateRefs(doc.objects), `${name}: designators used twice`).toEqual([])
      const fixture = readFixture(name)
      for (const net of fixture?.nets ?? []) for (const key of net) expect.soft(UUID.test(key), `${name}: ${key} carries an object id`).toBe(false)
    }
  })

  it("a junction part is not a pin of the circuit: the nets it joins are one group without it", () => {
    const fixture = readFixture("metronome")
    expect(existsSync(fixturePath("metronome"))).toBe(true)
    const keys = fixture!.nets.flat()
    expect.soft(keys.some((k) => k.startsWith("junction")), "junction pins in the metronome's partition").toBe(false)
    expect.soft(fixture!.nets.length, "the metronome's nets with two or more pins").toBeGreaterThan(0)
  })
})

const at = (x: number, y: number): Point => ({ x, y })
const seg = (ax: number, ay: number, bx: number, by: number): RefSegment => ({ a: at(ax, ay), b: at(bx, by) })
const pin = (key: string, x: number, y: number, socket = false): RefPin => ({ key, at: at(x, y), socket })
const groups = (pins: RefPin[], segments: RefSegment[]) => canonical(geometricGroups(pins, segments))

describe("the brute-force geometric reference: connected exactly when a conductor end lies on the other conductor", () => {
  it("a wire ending on another wire's interior joins them; two wires crossing do not", () => {
    expect.soft(groups([pin("A", 0, 0), pin("B", 4, 0), pin("C", 2, 3)], [seg(0, 0, 4, 0), seg(2, 3, 2, 0)]), "a T").toEqual([["A", "B", "C"]])
    expect.soft(groups([pin("A", 0, 0), pin("B", 4, 0), pin("C", 2, 3), pin("D", 2, -3)], [seg(0, 0, 4, 0), seg(2, 3, 2, -3)]), "a crossing").toEqual([
      ["A", "B"],
      ["C", "D"],
    ])
  })

  it("collinear wires that overlap or abut are one conductor", () => {
    expect.soft(groups([pin("A", 0, 0), pin("B", 6, 0)], [seg(0, 0, 4, 0), seg(2, 0, 6, 0)]), "overlap").toEqual([["A", "B"]])
    expect.soft(groups([pin("A", 0, 0), pin("B", 6, 0)], [seg(0, 0, 3, 0), seg(3, 0, 6, 0)]), "abut").toEqual([["A", "B"]])
    expect.soft(groups([pin("A", 0, 0), pin("B", 6, 0)], [seg(0, 0, 2, 0), seg(3, 0, 6, 0)]), "a gap of one unit").toEqual([])
  })

  it("a pin on a wire's interior connects, a board's socket only where a wire ends on it", () => {
    expect.soft(groups([pin("A", 0, 0), pin("B", 4, 0), pin("R1.1", 2, 0)], [seg(0, 0, 4, 0)]), "a symbol pin passed").toEqual([["A", "B", "R1.1"]])
    expect.soft(groups([pin("A", 0, 0), pin("B", 4, 0), pin("U1.P1", 2, 0, true)], [seg(0, 0, 4, 0)]), "a socket passed").toEqual([["A", "B"]])
    expect.soft(groups([pin("A", 0, 0), pin("U1.P1", 2, 0, true)], [seg(0, 0, 2, 0)]), "a socket a wire ends on").toEqual([["A", "U1.P1"]])
    expect.soft(groups([pin("A", 0, 0), pin("U1.P1", 2, 0, true)], [seg(0, 0, 2, 0), seg(2, 0, 2, 2)]), "a socket under a bend").toEqual([["A", "U1.P1"]])
  })

  it("two pins on one point connect without a wire", () => {
    expect(groups([pin("R1.2", 4, 1), pin("LED1.1", 4, 1), pin("LED1.2", 8, 1)], [])).toEqual([["LED1.1", "R1.2"]])
  })

  it("a frozen route is its corners: a straight run through a crossing stays a crossing", () => {
    const route = [at(4, -1), at(4, 0), at(4, 1)]
    expect.soft(polylineSegments(route), "the collinear stub end is not a vertex").toEqual([seg(4, -1, 4, 1)])
    expect.soft(groups([pin("A", 4, -1), pin("B", 4, 1), pin("C", 0, 0), pin("D", 8, 0)], [...polylineSegments(route), seg(0, 0, 8, 0)]), "crossing").toEqual([
      ["A", "B"],
      ["C", "D"],
    ])
    expect.soft(polylineSegments([at(0, 0), at(2, 0), at(1, 0)]), "a run that doubles back keeps its turn").toEqual([seg(0, 0, 2, 0), seg(2, 0, 1, 0)])
  })
})

function frozenPartition(doc: Schematic) {
  const routes = new Router(designatorRects).routeAll(doc.objects, doc.wires, GRID)
  const segments = routes.flatMap((r) => polylineSegments(r.pts))
  const pins: RefPin[] = doc.objects.flatMap((o) => objectPins(o, GRID).map((p) => ({ key: p.key, at: p.point, socket: !!getDef(o.def)?.pinsAreSockets })))
  return renamed(doc.objects, geometricGroups(pins, segments))
}

const OVERLAPS_THE_MIGRATION_MUST_REROUTE: Record<string, string[][]> = {
  "nucleo-serial": [["TERM1.RX", "TERM1.TX", "U1.VCP-RX", "U1.VCP-TX"]],
  "open746-touch": [["TERM1.RX", "TERM1.TX", "U1.P3-7", "U1.VCP-RX", "U1.VCP-TX"]],
  "charge-boost-chips": [["LED1.2", "LED2.2", "U1.CHRG", "U1.STDBY"]],
  "system-exam": [["C5.1", "C5.2", "D2.2", "D3.2", "D4.1", "D5.1", "ground#5.GND", "R10.1", "R10.2"]],
  "emul-1.28.0--lab2-rgb-pwm.emul": [["R2.2", "R3.2", "U1.P4-5", "U1.P4-7"]],
}

describe("the reference against today's buildNets, every wire routed by today's router and frozen", () => {
  it("agrees on every document whose frozen routes keep each net to its own corridor", () => {
    for (const { name, doc } of documents) {
      if (name in OVERLAPS_THE_MIGRATION_MUST_REROUTE) continue
      const { missing, extra } = partitionDiff(pinPartition(doc, GRID), frozenPartition(doc))
      expect.soft({ missing, extra }, `${name}: frozen geometry against today's nets`).toEqual({ missing: [], extra: [] })
    }
  })

  it("the documents where two nets' frozen routes share a corridor merge exactly those nets, and nothing else", () => {
    for (const [name, merged] of Object.entries(OVERLAPS_THE_MIGRATION_MUST_REROUTE)) {
      const document = documents.find((d) => d.name === name)
      expect.soft(document, `${name} is still a document`).toBeDefined()
      if (!document) continue
      const { extra } = partitionDiff(pinPartition(document.doc, GRID), frozenPartition(document.doc))
      expect.soft(extra, `${name}: nets the frozen routes merge`).toEqual(merged)
    }
  })
})
