import { existsSync, readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { GRID, objectPins, Router } from "@/schematic/geometry"
import { designatorRects, fieldRouter } from "@/schematic/placement"
import { getDef } from "@/schematic/registry"
import type { PlacedObject, Point, Schematic, Wire } from "@/schematic/types"
import { canonical, duplicateRefs, geometricGroups, inventory, partitionDiff, pinPartition, polylineSegments, renamed, stableNames, type Partition, type RefPin, type RefSegment } from "../lib/pin-partition"
import { fixturePath, PARTITIONS, partitionDocuments, readFixture } from "../lib/partition-documents"
import { SCHEMATIC_CASES } from "../lib/schematic-cases"

const documents = await partitionDocuments()

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

describe("the pin partition every later phase must keep: the groups of pins on one net, by designator and pin", () => {
  it("every example and every .emul under tests/data has its partition frozen, and today's model still gives exactly that", () => {
    for (const { name, doc } of documents) {
      const fixture = readFixture(name)
      expect.soft(fixture, `${name}: no fixture at ${fixturePath(name)} — run pnpm pin-partitions`).not.toBeNull()
      if (!fixture) continue
      expect.soft(inventory(doc.objects), `${name}: every part, so that a part gone missing cannot pass for one left unwired`).toEqual(fixture.objects)
      expect.soft(pinPartition(doc, GRID), `${name}: partition from today's wires and contacts`).toEqual(fixture.nets)
    }
  })

  it("names do not depend on where an object stands in the document: reversed, every document keeps its parts and its partition", () => {
    for (const { name, doc } of documents) {
      const reversed = { ...doc, objects: [...doc.objects].reverse() }
      expect.soft(inventory(reversed.objects), `${name}: parts`).toEqual(inventory(doc.objects))
      expect.soft(pinPartition(reversed, GRID), `${name}: partition`).toEqual(pinPartition(doc, GRID))
    }
  })

  it("every part has a name of its own: a part without a designator is named by its definition and where it stands", () => {
    for (const { name, doc } of documents) {
      const names = [...stableNames(doc.objects).values()]
      expect.soft(names.length - new Set(names).size, `${name}: names used twice`).toBe(0)
    }
    const unnamed = (id: string, x: number, y: number): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { value: "1 kΩ" } })
    const objects: PlacedObject[] = [
      unnamed("a", 0, 0),
      unnamed("b", 0, 4),
      { id: "r1", def: "resistor", x: 8 * GRID, y: 0, props: { ref: "R1" } },
      { id: "r2", def: "resistor", x: 8 * GRID, y: 4 * GRID, props: { ref: "R2" } },
      { id: "g", def: "ground", x: -6 * GRID, y: 8 * GRID },
      { id: "v", def: "supply", x: -6 * GRID, y: -6 * GRID },
    ]
    const wire = (id: string, from: [string, string], to: [string, string]): Wire => ({ id, from: { object: from[0], pin: from[1] }, to: { object: to[0], pin: to[1] } })
    const common = [wire("1", ["a", "2"], ["r1", "1"]), wire("2", ["b", "2"], ["r2", "1"])]
    const before: Schematic = { objects, wires: [...common, wire("3", ["a", "1"], ["g", "GND"]), wire("4", ["b", "1"], ["v", "V"])], parts: {} }
    const swapped: Schematic = { objects, wires: [...common, wire("3", ["a", "1"], ["v", "V"]), wire("4", ["b", "1"], ["g", "GND"])], parts: {} }
    expect.soft(pinPartition(swapped, GRID), "ground and supply swapped between two unnamed resistors").not.toEqual(pinPartition(before, GRID))
  })

  it("a partition is compared group for group, so a repeated group lost or gained is a difference", () => {
    const twoPairs: Partition = [["ground@0,0.GND", "ground@0,4.GND"], ["ground@0,0.GND", "ground@0,4.GND"]]
    expect.soft(partitionDiff(twoPairs, [twoPairs[0]]), "one of two equal groups gone").toEqual({ missing: [twoPairs[0]], extra: [] })
    expect.soft(partitionDiff([twoPairs[0]], twoPairs), "one more").toEqual({ missing: [], extra: [twoPairs[0]] })
  })

  it("the order of keys and groups is total: two designators that compare equal numerically still sort one way", () => {
    expect.soft(canonical([["R1.1", "R01.1"]]), "member order").toEqual(canonical([["R01.1", "R1.1"]]))
    expect.soft(canonical([["R1.1", "X.1"], ["R01.1", "Y.1"]]), "group order").toEqual(canonical([["R01.1", "Y.1"], ["R1.1", "X.1"]]))
  })

  it("no fixture outlives its document", () => {
    const names = new Set(documents.map((d) => d.name))
    const stale = readdirSync(PARTITIONS).filter((file) => file.endsWith(".json") && !names.has(file.slice(0, -".json".length)))
    expect.soft(stale, "fixtures with no example, case or .emul behind them").toEqual([])
  })

  it("keys are designator and pin, never an object id, and no designator is used twice in a document", () => {
    for (const { name, doc } of documents) {
      expect.soft(duplicateRefs(doc.objects), `${name}: designators used twice`).toEqual([])
      const fixture = readFixture(name)
      for (const net of fixture?.nets ?? []) for (const key of net) expect.soft(UUID.test(key), `${name}: ${key} carries an object id`).toBe(false)
    }
  })

  it("a junction part is not a pin of the circuit: the nets it joins are one group without it", () => {
    const tap = SCHEMATIC_CASES.find((c) => c.name === "junction-tap")!.build()
    expect.soft(pinPartition(tap, GRID), "R1, R2 and R3 on one junction").toEqual([["R1.2", "R2.1", "R3.1"]])
    const fixture = readFixture("metronome")
    expect.soft(existsSync(fixturePath("metronome")), "the metronome is frozen").toBe(true)
    expect.soft(fixture?.nets.flat().some((k) => k.startsWith("junction")), "junction pins in the metronome's partition").toBe(false)
    expect.soft(fixture?.objects.some((o) => o.endsWith("(junction)")), "junction parts in its inventory").toBe(false)
  })
})

const at = (x: number, y: number): Point => ({ x, y })
const seg = (ax: number, ay: number, bx: number, by: number): RefSegment => ({ a: at(ax, ay), b: at(bx, by) })
const pin = (key: string, x: number, y: number, socket = false, nc = false): RefPin => ({ key, at: at(x, y), socket, nc })
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
    expect.soft(groups([pin("R1.2", 4, 1), pin("LED1.1", 4, 1), pin("LED1.2", 8, 1)], []), "butted").toEqual([["LED1.1", "R1.2"]])
  })

  it("a pin the board leaves unconnected joins no pin butted onto it, but does join a wire ended on it, as today's contacts do", () => {
    expect.soft(groups([pin("R1.1", 5, 17), pin("U1.CN8-1", 5, 17, true, true)], []), "butted on an NC pad").toEqual([])
    expect.soft(groups([pin("R1.1", 0, 17), pin("U1.CN8-1", 5, 17, true, true)], [seg(0, 17, 5, 17)]), "wired to it").toEqual([["R1.1", "U1.CN8-1"]])
  })

  it("a run of no length is no conductor: on a crossing it joins nothing", () => {
    expect.soft(groups([pin("A", 0, 0), pin("B", 4, 0), pin("C", 2, -2), pin("D", 2, 2)], [seg(0, 0, 4, 0), seg(2, -2, 2, 2), seg(2, 0, 2, 0)]), "a point on a crossing").toEqual([
      ["A", "B"],
      ["C", "D"],
    ])
  })

  it("today's 45° stub touches only at its two ends, never along its length", () => {
    const stub = seg(0, 0, 12, 12)
    expect.soft(groups([pin("D1.1", 0, 0), pin("X.1", 12, 12)], [stub]), "its ends").toEqual([["D1.1", "X.1"]])
    expect.soft(groups([pin("D1.1", 0, 0), pin("X.1", 12, 12), pin("Y.1", 6, 6)], [stub]), "a pin halfway along").toEqual([["D1.1", "X.1"]])
    expect.soft(groups([pin("D1.1", 0, 0), pin("X.1", 12, 12), pin("Z.1", 6, 0)], [stub]), "a pin inside its box").toEqual([["D1.1", "X.1"]])
    expect.soft(groups([pin("D1.1", 0, 0), pin("X.1", 12, 12), pin("Y.1", 6, -6), pin("Z.1", 6, 18)], [stub, seg(6, -6, 6, 18)]), "a wire across it").toEqual([
      ["D1.1", "X.1"],
      ["Y.1", "Z.1"],
    ])
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

const refPins = (doc: Schematic): RefPin[] =>
  doc.objects.flatMap((o) => objectPins(o, GRID).map((p) => ({ key: p.key, at: p.point, socket: !!getDef(o.def)?.pinsAreSockets, nc: p.pin.kind === "nc" })))

function frozenPartition(doc: Schematic, corners = polylineSegments) {
  const routes = fieldRouter().routeAll(doc.objects, doc.wires, GRID)
  const byId = new Map(doc.wires.map((w) => [w.id, w]))
  const pinned = (w: Wire) => [`${w.from.object}:${w.from.pin}`, `${w.to.object}:${w.to.pin}`] as const
  const collapsed = routes.filter((r) => corners(r.pts).length === 0).map((r) => pinned(byId.get(r.id)!))
  return renamed(doc.objects, geometricGroups(refPins(doc), routes.flatMap((r) => corners(r.pts)), collapsed))
}

const everyVertex = (pts: readonly Point[]): RefSegment[] => pts.slice(1).flatMap((p, i) => (p.x === pts[i].x && p.y === pts[i].y ? [] : [{ a: pts[i], b: p }]))

const OVERLAPS_THE_MIGRATION_MUST_REROUTE: Record<string, string[][]> = {
  "nucleo-serial": [["TERM1.RX", "TERM1.TX", "U1.VCP-RX", "U1.VCP-TX"]],
  "open746-touch": [["TERM1.RX", "TERM1.TX", "U1.P3-7", "U1.VCP-RX", "U1.VCP-TX"]],
  "charge-boost-chips": [["LED1.2", "LED2.2", "U1.CHRG", "U1.STDBY"]],
  "system-exam": [["C5.1", "C5.2", "D2.2", "D3.2", "D4.1", "D5.1", "R10.1", "R10.2"]],
  "emul-1.28.0--lab2-rgb-pwm.emul": [["R2.2", "R3.2", "U1.P4-5", "U1.P4-7"]],
}

describe("the reference against today's buildNets, every wire routed by today's router and frozen", () => {
  it("agrees on every document whose frozen routes keep off other nets' wiring and pins", () => {
    let agreeing = 0
    for (const { name, doc } of documents) {
      if (name in OVERLAPS_THE_MIGRATION_MUST_REROUTE) continue
      const { missing, extra } = partitionDiff(pinPartition(doc, GRID), frozenPartition(doc))
      expect.soft({ missing, extra }, `${name}: frozen geometry against today's nets`).toEqual({ missing: [], extra: [] })
      agreeing++
    }
    expect.soft(agreeing, "documents checked exactly").toBe(documents.length - Object.keys(OVERLAPS_THE_MIGRATION_MUST_REROUTE).length)
  })

  it("the documents where a frozen route touches another net's wiring or pins merge exactly the recorded nets, and nothing else", () => {
    for (const [name, merged] of Object.entries(OVERLAPS_THE_MIGRATION_MUST_REROUTE)) {
      const document = documents.find((d) => d.name === name)
      expect.soft(document, `${name} is still a document`).toBeDefined()
      if (!document) continue
      expect.soft(frozenPartition(document.doc), `${name}: the whole frozen partition, the recorded merges applied and nothing else`).toEqual(withMerges(pinPartition(document.doc, GRID), merged))
    }
  })

  it("a wire whose two pins coincide keeps its connection when frozen, even to a pad the board leaves unconnected", () => {
    const board: PlacedObject = { id: "u1", def: "nucleo-f429zi", x: 0, y: 0, props: { ref: "U1" } }
    const pad = objectPins(board, GRID).find((p) => p.pin.id === "CN8-1")!.point
    const resistor: PlacedObject = { id: "r1", def: "resistor", x: pad.x, y: pad.y - GRID, props: { ref: "R1" } }
    const butted: Schematic = { objects: [board, resistor], wires: [], parts: {} }
    const wired: Schematic = { ...butted, wires: [{ id: "w", from: { object: "r1", pin: "1" }, to: { object: "u1", pin: "CN8-1" } }] }
    expect.soft(pinPartition(butted, GRID), "butted on the NC pad, today: nothing").toEqual([])
    expect.soft(frozenPartition(butted), "frozen: nothing").toEqual([])
    expect.soft(pinPartition(wired, GRID), "wired to it, today: joined").toEqual([["R1.1", "U1.CN8-1"]])
    expect.soft(frozenPartition(wired), "frozen: still joined").toEqual([["R1.1", "U1.CN8-1"]])
  })

  it("the freeze routes as the field does, designators and values in the way included", () => {
    const doc = documents.find((d) => d.name === "charge-boost-chips")!.doc
    const shape = (router: Router) => router.routeAll(doc.objects, doc.wires, GRID).map((r) => r.pts)
    expect.soft(shape(fieldRouter()), "the field's router").toEqual(shape(new Router(designatorRects)))
    expect.soft(shape(new Router()), "a router blind to text routes this document differently, so the check above can fail").not.toEqual(shape(new Router(designatorRects)))
  })

  it("a frozen route has to be written as its corners: kept, the stub ends lying on another net's wire at a crossing join the two nets", () => {
    const joined = (name: string) => {
      const doc = documents.find((d) => d.name === name)!.doc
      return partitionDiff(pinPartition(doc, GRID), frozenPartition(doc, everyVertex)).extra
    }
    expect.soft(joined("metronome"), "the supply rail shorted to two grounds through R17 and D7's stub ends").toContainEqual(expect.arrayContaining(["R17.2", "D7.1", "U1.VCC"]))
    expect.soft(joined("logic").length, "logic: three pairs of gate nets joined").toBe(3)
  })

  it("the merge register is exact: dropping a net or merging one more fails it", () => {
    const today: Partition = [["A.1", "B.1"], ["C.1", "D.1"], ["E.1", "F.1"]]
    const register = [["A.1", "B.1", "C.1", "D.1"]]
    expect.soft(withMerges(today, register), "the recorded merge").toEqual([["A.1", "B.1", "C.1", "D.1"], ["E.1", "F.1"]])
    expect.soft(withMerges(today, register), "a lost net").not.toEqual([["A.1", "B.1", "C.1", "D.1"]])
    expect.soft(withMerges(today, register), "one merge too many").not.toEqual([["A.1", "B.1", "C.1", "D.1", "E.1", "F.1"]])
    expect.soft(withMerges(today, [["A.1", "C.1", "S.1"]]), "a socket that joins by the merge alone").toEqual([["A.1", "B.1", "C.1", "D.1", "S.1"], ["E.1", "F.1"]])
  })
})

function withMerges(partition: Partition, merges: readonly string[][]): Partition {
  let groups = partition.map((g) => [...g])
  for (const merge of merges) {
    const members = new Set(merge)
    const touched = groups.filter((g) => g.some((k) => members.has(k)))
    const joined = touched.flat()
    groups = [...groups.filter((g) => !touched.includes(g)), [...joined, ...merge.filter((k) => !joined.includes(k))]]
  }
  return canonical(groups)
}
