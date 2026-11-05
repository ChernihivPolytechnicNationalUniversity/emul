import { describe, expect, it } from "vitest"
import { CHECK_KINDS, checked, NO_CONNECT, type CheckKind, type Finding } from "@/schematic/checker"
import { examples } from "@/schematic/examples"
import { placedFields } from "@/schematic/fields"
import { GRID, objectPins, type Point } from "@/schematic/geometry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { inNormalForm } from "@/schematic/wire-edits"
import type { WireSegment } from "@/schematic/wires/segment"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const part = (id: string, def: string, x: number, y: number, extra: Partial<PlacedObject> = {}): PlacedObject => ({ id, def, x: c(x), y: c(y), props: { ref: id }, ...extra })
const resistor = (id: string, x: number, y: number, extra: Partial<PlacedObject> = {}) => part(id, "resistor", x, y, extra)
const noConnect = (id: string, p: Point): PlacedObject => ({ id, def: NO_CONNECT, x: p.x - GRID, y: p.y - GRID })
let serial = 0
const seg = (a: Point, b: Point): WireSegment => ({ id: `s${++serial}`, a, b })
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const of = (findings: readonly Finding[], kind: CheckKind) => findings.filter((f) => f.kind === kind)
const points = (findings: readonly Finding[]) => findings.map((f) => ({ x: f.at.x / GRID, y: f.at.y / GRID })).sort((a, b) => a.x - b.x || a.y - b.y)

describe("the checker: a light ERC that never blocks (design.md §6.8)", () => {
  it("checks exactly the design's list: dangling ends, unconnected pins, four-way connections, a wire through a body, a field over a wire or a body, two fields overlapping; two ends of different nets on one point cannot happen (N5) and is no check", () => {
    expect(CHECK_KINDS).toEqual(["dangling-end", "unconnected-pin", "four-way", "wire-through-body", "field-on-wire", "field-on-body", "fields-overlap"])
  })

  it("reads the document and changes nothing in it", () => {
    const doc = docOf([resistor("R1", 0, 0)], [seg(at(4, 1), at(8, 1))])
    const copy = JSON.parse(JSON.stringify(doc))
    checked(doc)
    expect(doc).toEqual(copy)
  })
})

describe("dangling wire ends (design.md §6.8, §3.3; Altium Unconnected Wire, KiCad dangling-end ERC, EAGLE)", () => {
  it("a wire end that meets nothing is a finding at that end, naming the wire", () => {
    const wire = seg(at(4, 1), at(8, 1))
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 0, 4)], [wire, seg(at(0, 1), at(0, 5))])
    const found = of(checked(doc), "dangling-end")
    expect.soft(points(found), "the free end at (8, 1)").toEqual([{ x: 8, y: 1 }])
    expect.soft(found[0]?.segments, "the wire").toEqual([wire.id])
  })

  it("a wire end on a board socket is connected (the jumper rule, design.md §4.5)", () => {
    const board = part("U1", "open746i-c", 0, 0)
    const socket = objectPins(board, GRID).reduce((best, p) => (p.point.x < best.point.x ? p : best)).point
    const r1 = resistor("R1", socket.x / GRID - 12, socket.y / GRID - 1)
    const doc = docOf([board, r1], [seg({ x: socket.x - c(8), y: socket.y }, socket)])
    expect(of(checked(doc), "dangling-end")).toEqual([])
  })

  it("a no-connect mark on the end says the opening is meant and silences it (KiCad no-connect flag; Xpedition's no-connect symbol on a dangling end)", () => {
    const doc = docOf([resistor("R1", 0, 0), resistor("R2", 0, 4), noConnect("N1", at(8, 1))], [seg(at(4, 1), at(8, 1)), seg(at(0, 1), at(0, 5))])
    expect(of(checked(doc), "dangling-end")).toEqual([])
  })
})

describe("unconnected pins of parts that have a model (design.md §6.8; KiCad pin-not-connected ERC)", () => {
  it("a resistor on its own: both pins are findings, naming the part and the pin", () => {
    const found = of(checked(docOf([resistor("R1", 0, 0)])), "unconnected-pin")
    expect.soft(points(found), "at both pins").toEqual([
      { x: 0, y: 1 },
      { x: 4, y: 1 },
    ])
    expect.soft(found.every((f) => f.objects.join() === "R1"), "R1's").toBe(true)
    expect.soft(found.map((f) => f.text).every((t) => /R1\.(1|2)/.test(t)), "the text names R1.1 and R1.2").toBe(true)
  })

  it("two pins butted together are connected: no finding at the contact", () => {
    const found = of(checked(docOf([resistor("R1", 0, 0), resistor("R2", 4, 0)])), "unconnected-pin")
    expect(points(found)).toEqual([
      { x: 0, y: 1 },
      { x: 8, y: 1 },
    ])
  })

  it("a no-connect mark on a pin silences it (KiCad no-connect flag)", () => {
    const found = of(checked(docOf([resistor("R1", 0, 0), noConnect("N1", at(0, 1))])), "unconnected-pin")
    expect(points(found)).toEqual([{ x: 4, y: 1 }])
  })

  it("a part with no model is not checked: a crystal is drawn for the board's clock, not simulated", () => {
    expect(of(checked(docOf([part("Y1", "crystal", 0, 0)])), "unconnected-pin")).toEqual([])
  })

  it("a board's unused header sockets are not findings: a socket connects only by a wire's end, and most stay empty (the jumper rule, design.md §4.5)", () => {
    expect(of(checked(docOf([part("U1", "open746i-c", 0, 0)])), "unconnected-pin")).toEqual([])
  })
})

describe("four-way connections (design.md §6.8; junctions.md 13, 14; KiCad four_way_junction ERC, which counts pins; Altium Convert Cross-Junctions)", () => {
  const hub = at(10, 10)
  it("four wire ends at one point are one finding there", () => {
    const doc = docOf([], [seg(hub, at(6, 10)), seg(hub, at(14, 10)), seg(hub, at(10, 6)), seg(hub, at(10, 14))])
    expect(points(of(checked(doc), "four-way"))).toEqual([{ x: 10, y: 10 }])
  })

  it("a T is no finding, nor is a crossing with no dot", () => {
    const t = docOf([], [seg(hub, at(6, 10)), seg(hub, at(14, 10)), seg(hub, at(10, 14))])
    expect.soft(of(checked(t), "four-way"), "a T").toEqual([])
    const cross = docOf([], [seg(at(6, 10), at(14, 10)), seg(at(10, 6), at(10, 14))])
    expect.soft(of(checked(cross), "four-way"), "a crossing").toEqual([])
  })

  it("a pin with three wires on it is four conductors at a point: a finding (junctions.md 14)", () => {
    const doc = docOf([resistor("R1", 0, 0)], [seg(at(4, 1), at(8, 1)), seg(at(4, 1), at(4, 5)), seg(at(4, 1), at(4, -3))])
    expect(points(of(checked(doc), "four-way"))).toEqual([{ x: 4, y: 1 }])
  })
})

describe("a wire through a body (design.md §5.1, §6.8; ГОСТ 2.701-84: lines do not pass through symbols; IEC 61082-1: connecting lines should not interfere with other symbols)", () => {
  it("a wire across a resistor's body that meets none of its pins is a finding naming the part and the wire", () => {
    const wire = seg(at(2, -3), at(2, 5))
    const doc = docOf([resistor("R1", 0, 0)], [wire])
    const found = of(checked(doc), "wire-through-body")
    expect.soft(found.map((f) => f.objects.join()), "R1").toEqual(["R1"])
    expect.soft(found[0]?.segments, "that wire").toEqual([wire.id])
  })

  it("a wire that ends on the part's pin runs along nothing of its body: no finding", () => {
    const doc = docOf([resistor("R1", 0, 0)], [seg(at(4, 1), at(8, 1))])
    expect(of(checked(doc), "wire-through-body")).toEqual([])
  })

  it("a wire passing over a board to reach a socket is the jumper rule, not a finding (design.md §4.5)", () => {
    const doc = docOf([part("U1", "open746i-c", 0, 0)], [seg(at(-4, 20), at(80, 20))])
    expect(of(checked(doc), "wire-through-body")).toEqual([])
  })
})

describe("fields over wires, bodies and each other (design.md §5.2, §6.8: a finding, never a refusal)", () => {
  it("a wire through a part's designator is a finding naming the field's part", () => {
    const r1 = resistor("R1", 0, 0, { props: { ref: "R1", value: "1 kΩ" } })
    const ref = placedFields(r1, GRID).find((f) => f.key === "ref")!
    const y = ref.box.y + ref.box.h / 2
    const doc = docOf([r1], [seg({ x: c(-4), y }, { x: c(8), y })])
    const found = of(checked(doc), "field-on-wire")
    expect(found.map((f) => f.objects.join())).toEqual(["R1"])
  })

  it("another part's body under a field is a finding", () => {
    const doc = docOf([resistor("R1", 0, 0, { props: { ref: "R1", value: "1 kΩ" } }), resistor("R2", 0, -1, { props: { ref: "R2", value: "" } })])
    expect(of(checked(doc), "field-on-body").map((f) => f.objects.join())).toContain("R1")
  })

  it("two parts' fields overlapping are a finding", () => {
    const long = "4.7 kΩ 1% 0.25 W metal film resistor"
    const doc = docOf([resistor("R1", 0, 0, { props: { ref: "R1", value: long } }), resistor("R2", 4, 0, { props: { ref: "R2", value: long } })])
    const overlapping = of(checked(doc), "fields-overlap")
    expect(overlapping.length).toBeGreaterThan(0)
  })
})

describe("every example is clean (plan.md acceptance 5, phase 5)", () => {
  for (const example of examples) {
    it(example.id, () => {
      const found = checked(example.build(GRID))
      expect(found.map((f) => `${f.kind} at (${f.at.x / GRID}, ${f.at.y / GRID}): ${f.text}`)).toEqual([])
    })
  }
})
