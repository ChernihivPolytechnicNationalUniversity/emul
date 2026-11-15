import { describe, expect, it } from "vitest"
import { CHECK_KINDS, checked, type CheckKind, type Finding } from "@/schematic/checker"
import { examples } from "@/schematic/examples"
import { GRID, objectPins, type Point } from "@/schematic/geometry"
import { placedFields, withFieldAt, withFieldMoved } from "@/schematic/fields"
import { CATALOGUE } from "@/schematic/catalogue.gen"
import { getDef } from "@/schematic/registry"
import { WireGraph } from "@/schematic/wires/graph"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { inNormalForm, wiringOf } from "@/schematic/wire-edits"
import type { WireSegment } from "@/schematic/wires/segment"

const c = (v: number) => v * GRID
const at = (x: number, y: number): Point => ({ x: c(x), y: c(y) })
const part = (id: string, def: string, x: number, y: number, extra: Partial<PlacedObject> = {}): PlacedObject => ({ id, def, x: c(x), y: c(y), props: { ref: id }, ...extra })
const resistor = (id: string, x: number, y: number, extra: Partial<PlacedObject> = {}) => part(id, "resistor", x, y, extra)
let serial = 0
const seg = (a: Point, b: Point): WireSegment => ({ id: `s${++serial}`, a, b })
const docOf = (objects: PlacedObject[], wires: WireSegment[] = []): Schematic => inNormalForm({ objects, wires, parts: {} })
const of = (findings: readonly Finding[], kind: CheckKind) => findings.filter((f) => f.kind === kind)
const points = (findings: readonly Finding[]) => findings.map((f) => ({ x: f.at.x / GRID, y: f.at.y / GRID })).sort((a, b) => a.x - b.x || a.y - b.y)

describe("the checker: a light ERC that never blocks (design.md §6.8)", () => {
  it("checks exactly the design's list: dangling ends, unconnected pins, a wire through a body, a field over a wire or a body, two fields overlapping (§6.8), parallel runs closer than one cell (§5.4); four conductors at a point are no check (the user, 2026-11-06), and two ends of different nets on one point cannot happen (N5)", () => {
    expect(CHECK_KINDS).toEqual(["dangling-end", "unconnected-pin", "wire-through-body", "field-on-wire", "field-on-body", "fields-overlap", "parallel-too-close"])
  })

  it("gives the same findings from the store's kept wiring as from a fresh one", () => {
    for (const example of examples.slice(0, 10)) {
      const doc = example.build(GRID)
      expect.soft(checked(doc, wiringOf(new WireGraph(), doc)), example.id).toEqual(checked(doc))
    }
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

  it("a part with no model is not checked: a crystal is drawn for the board's clock, not simulated", () => {
    expect(of(checked(docOf([part("Y1", "crystal", 0, 0)])), "unconnected-pin")).toEqual([])
  })

  it("unused board sockets are excluded from unconnected-pin findings (project default, findings 5.1: every board has a model and most of its sockets stay empty)", () => {
    expect(of(checked(docOf([part("U1", "open746i-c", 0, 0)])), "unconnected-pin")).toEqual([])
  })

  it("a microcontroller's pins are not checked: its free GPIOs are the firmware's to give (the user, design.md §13.21)", () => {
    expect(of(checked(docOf([part("U1", "stm32f746ig", 0, 0)])), "unconnected-pin")).toEqual([])
  })

  it("a part with more than three pins is not checked: an IC or a module leaves pins free by design (the user, 2026-11-06)", () => {
    for (const def of ["hc595", "opamp-lm358", "ne555", "lcd-1602", "oled-ssd1306-i2c", "ws2812b", "rgb-led", "tp4056"]) {
      expect.soft(of(checked(docOf([part("U1", def, 0, 0)])), "unconnected-pin"), def).toEqual([])
    }
  })

  it("a part with at most three pins is checked: none of them is spare", () => {
    for (const [def, pins] of [["npn", 3], ["nmos", 3], ["potentiometer", 3], ["ncp1117", 3], ["diode", 2], ["led", 2]] as const) {
      expect.soft(of(checked(docOf([part("U1", def, 0, 0)])), "unconnected-pin"), def).toHaveLength(pins)
    }
  })
})

describe("nothing on the field marks a finding, and nothing silences one: the user dropped the rings and the no-connect mark (2026-11-06)", () => {
  it("there is no no-connect part: not in the library, not in the catalogue", () => {
    expect.soft(getDef("no-connect"), "the definition").toBeUndefined()
    expect.soft(CATALOGUE.filter((c) => c.id === "no-connect"), "the catalogue").toEqual([])
  })
})

describe("four conductors at a point are no finding: the user dropped the check (2026-11-06; KiCad's four_way_junction ERC is off by default)", () => {
  const hub = at(10, 10)
  it("four wire ends at one point: nothing", () => {
    const doc = docOf([], [seg(hub, at(6, 10)), seg(hub, at(14, 10)), seg(hub, at(10, 6)), seg(hub, at(10, 14))])
    expect(checked(doc).filter((f) => f.at.x === hub.x && f.at.y === hub.y)).toEqual([])
  })

  it("a pin with three wires on it: nothing at the pin", () => {
    const pin = at(4, 1)
    const doc = docOf([resistor("R1", 0, 0)], [seg(pin, at(8, 1)), seg(pin, at(4, 5)), seg(pin, at(4, -3))])
    expect(checked(doc).filter((f) => f.at.x === pin.x && f.at.y === pin.y)).toEqual([])
  })
})

describe("a wire through a body (design.md §5.1, §6.8; inferred from ГОСТ 2.701-84's clearances, research/standards.md; IEC 61082-1 via a secondary source: connecting lines should not interfere with other symbols)", () => {
  it("circular bodies catch wires and fields in every quadrant and clear their exterior", () => {
    for (const def of ["voltmeter", "ammeter"]) for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
      const meter = part("M1", def, 0, 0, { props: { ref: "", value: "" } })
      const x = 2 + dx * 0.5
      const crossing = docOf([meter], [seg(at(x, 1 + dy * 0.5), at(x, 1 + dy * 2))])
      const clear = docOf([meter], [seg(at(x, 1 + dy * 2), at(x, 1 + dy * 3))])
      expect.soft(of(checked(crossing), "wire-through-body"), `${def}: wire in quadrant ${dx},${dy}`).toHaveLength(1)
      expect.soft(of(checked(clear), "wire-through-body"), `${def}: exterior wire ${dx},${dy}`).toEqual([])
      const label = part("R1", "resistor", 100, 100, { props: { ref: "I", value: "" } })
      for (const radius of [0.5, 2]) {
        const moved = withFieldAt(label, "ref", at(2 + dx * radius, 1 + dy * radius), GRID, getDef("resistor")!)
        expect.soft(of(checked(docOf([meter, moved])), "field-on-body").filter((f) => f.objects.includes("R1")), `${def}: field radius ${radius}, quadrant ${dx},${dy}`).toHaveLength(radius === 0.5 ? 1 : 0)
      }
    }
  })

  it("an interior pin exempts only the exit towards its outward side, at either segment end", () => {
    for (const reverse of [false, true]) for (const x of [0, 8]) {
      const endpoints = [at(5, 3), at(x, 3)]
      if (reverse) endpoints.reverse()
      const doc = docOf([part("U1", "opamp-generic", 0, 0)], [seg(endpoints[0], endpoints[1])])
      expect.soft(of(checked(doc), "wire-through-body"), `OUT towards x=${x}, reversed ${reverse}`).toHaveLength(x === 0 ? 1 : 0)
    }
    const supply = docOf([part("U1", "opamp-generic", 0, 0)], [seg(at(3, 2), at(3, -2)), seg(at(3, 4), at(3, 8))])
    expect.soft(of(checked(supply), "wire-through-body"), "interior supply pins exit outwards").toEqual([])
  })

  it("a wire across a resistor's body that meets none of its pins is a finding naming the part and the wire", () => {
    const wire = seg(at(2, -3), at(2, 5))
    const doc = docOf([resistor("R1", 0, 0)], [wire])
    const found = of(checked(doc), "wire-through-body")
    expect.soft(found.map((f) => f.objects.join()), "R1").toEqual(["R1"])
    expect.soft(found[0]?.segments, "that wire").toEqual([wire.id])
  })

  it("a wire through both of a resistor's pins runs along its leads and body: the piece between the pins is a finding (an uncut wire, as Alt leaves it)", () => {
    const doc = docOf([resistor("R1", 0, 0)], [seg(at(-4, 1), at(8, 1))])
    const central = doc.wires.find((s) => Math.min(s.a.x, s.b.x) === 0 && Math.max(s.a.x, s.b.x) === c(4))!
    const found = of(checked(doc), "wire-through-body")
    expect.soft(central, "set up: the wire split at both pins").toBeDefined()
    expect.soft(found.map((f) => [f.objects.join(), f.segments.join()]), "R1, the piece between its pins").toEqual([["R1", central?.id]])
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
  it("a numeric value collides with a wire inside its independently calculated box and clears one outside", () => {
    const label = withFieldAt(resistor("R1", 100, 100, { props: { ref: "", value: "100000" } }), "value", at(12, 12), GRID, getDef("resistor")!)
    const box = { x: c(11.442), y: c(11.85), w: c(1.116), h: c(0.3) }
    const actual = placedFields(label, GRID).find((f) => f.key === "value")!.box
    for (const key of ["x", "y", "w", "h"] as const) expect.soft(actual[key], `the fixed numeric box's ${key}`).toBeNear(box[key], 1e-9)
    for (const x of [12.5, 13]) {
      const wire = seg(at(x, 11), at(x, 13))
      const intersects = wire.a.x > box.x && wire.a.x < box.x + box.w && wire.a.y < box.y && wire.b.y > box.y + box.h
      expect.soft(intersects, `fixed-box control at x=${x}`).toBe(x === 12.5)
      expect.soft(of(checked(docOf([label], [wire])), "field-on-wire").map((f) => f.fields), `numeric collision at x=${x}`).toEqual(x === 12.5 ? [["R1:value"]] : [])
    }
  })

  it("a field over several bodies names its owners in canonical order", () => {
    const label = withFieldAt(resistor("label", 100, 100, { props: { ref: "I", value: "" } }), "ref", at(1.5, 1), GRID, getDef("resistor")!)
    const doc = docOf([resistor("Z", -1, 0), resistor("A", 0, 0), label])
    const finding = of(checked(doc), "field-on-body").find((f) => f.fields?.includes("label:ref"))!
    expect.soft(finding.text, "body names follow object identity").toBe("I's designator lies on A, Z")
    expect.soft(finding.objects, "membership uses the same order").toEqual(["A", "Z", "label"])
  })

  it("fields over a board's housing or socket are findings while exterior fields and wires over the board remain clear", () => {
    const board = part("B", "open746i-c", 0, 0)
    const label = resistor("R1", 100, 100, { props: { ref: "I", value: "" } })
    const socket = objectPins(board, GRID)[0].point
    for (const target of [at(36.5, 26.5), socket]) {
      const moved = withFieldAt(label, "ref", target, GRID, getDef("resistor")!)
      expect.soft(of(checked(docOf([board, moved])), "field-on-body").map((f) => f.objects), `field at ${target.x},${target.y}`).toEqual([["B", "R1"]])
    }
    const clear = docOf([board, label], [seg(at(-4, 20), at(80, 20))])
    expect.soft(of(checked(clear), "field-on-body"), "exterior label").toEqual([])
    expect.soft(of(checked(clear), "wire-through-body"), "the board jumper exception").toEqual([])
    expect.soft(of(checked(clear), "unconnected-pin").filter((f) => f.objects.includes("B")), "unused sockets").toEqual([])
  })

  it("a wire through a part's designator is a finding naming the field's part; clear of it, none", () => {
    const r1 = resistor("R1", 0, 0, { props: { ref: "R1", value: "" } })
    const ref = placedFields(r1, GRID).find((f) => f.key === "ref")!
    const wire = seg(at(2, -4), at(2, 0.5))
    expect.soft(ref.box.x < c(2) && ref.box.x + ref.box.w > c(2) && ref.box.y < c(0.5) && ref.box.y + ref.box.h > c(-4), "set up: the wire runs through the designator").toBe(true)
    expect.soft(of(checked(docOf([r1], [wire])), "field-on-wire").map((f) => f.objects.join()), "one finding, R1's").toEqual(["R1"])
    expect.soft(of(checked(docOf([r1], [seg(at(6, -4), at(6, 0.5))])), "field-on-wire"), "a wire beside it").toEqual([])
  })

  it("a field over another part's pin is a finding: the pin is part of what that part occupies (design.md §5.1)", () => {
    const r1 = resistor("R1", 0, 0, { props: { ref: "R1", value: "" } })
    const q1 = part("Q1", "npn", 10, 0, { props: { ref: "Q1", value: "" } })
    const base = objectPins(q1, GRID).find((p) => p.pin.id === "B")!.point
    const ref = placedFields(r1, GRID).find((f) => f.key === "ref")!
    const moved = withFieldMoved(r1, "ref", base.x - ref.at.x, base.y - ref.at.y, GRID)
    expect.soft(of(checked(docOf([moved, q1])), "field-on-body").map((f) => f.objects.includes("R1")), "R1's designator over Q1's base pin").toEqual([true])
    expect.soft(of(checked(docOf([r1, q1])), "field-on-body"), "autoplaced, clear").toEqual([])
  })

  it("two fields of one part moved onto each other are a finding (design.md §5.2)", () => {
    const r1 = resistor("R1", 0, 0, { props: { ref: "R1", value: "1 kΩ" } })
    const f = Object.fromEntries(placedFields(r1, GRID).map((x) => [x.key, x]))
    const onto = withFieldMoved(r1, "ref", f.value.at.x - f.ref.at.x, f.value.at.y - f.ref.at.y, GRID)
    expect.soft(of(checked(docOf([onto])), "fields-overlap"), "one finding").toHaveLength(1)
    expect.soft(of(checked(docOf([onto])), "fields-overlap")[0].fields, "both field identities, in canonical order").toEqual(["R1:ref", "R1:value"])
    expect.soft(of(checked(docOf([r1])), "fields-overlap"), "autoplaced: none").toEqual([])
  })

  it("another part's body under a field is a finding; apart, none", () => {
    const doc = docOf([resistor("R1", 0, 0, { props: { ref: "R1", value: "1 kΩ" } }), resistor("R2", 0, -1, { props: { ref: "R2", value: "" } })])
    const onR2 = of(checked(doc), "field-on-body").filter((f) => f.objects.includes("R1"))
    expect.soft(onR2.map((f) => f.text).sort(), "both of R1's fields, hugging its body, lie over R2's body one row up: one finding for each field").toEqual(["R1's designator lies on R2", "R1's value lies on R2"])
    const apart = docOf([resistor("R1", 0, 0, { props: { ref: "R1", value: "1 kΩ" } }), resistor("R2", 0, -4, { props: { ref: "R2", value: "" } })])
    expect.soft(of(checked(apart), "field-on-body"), "four rows apart").toEqual([])
  })

  it("two parts' fields overlapping are a finding", () => {
    const long = "4.7 kΩ 1% 0.25 W metal film resistor"
    const doc = docOf([resistor("R1", 0, 0, { props: { ref: "R1", value: long } }), resistor("R2", 4, 0, { props: { ref: "R2", value: long } })])
    expect.soft(of(checked(doc), "fields-overlap"), "the two values").toHaveLength(1)
    const short = docOf([resistor("R1", 0, 0, { props: { ref: "R1", value: "1 kΩ" } }), resistor("R2", 4, 0, { props: { ref: "R2", value: "1 kΩ" } })])
    expect.soft(of(checked(short), "fields-overlap"), "short values side by side: none").toEqual([])
  })
})

describe("parallel runs closer than one cell (design.md §5.4; ГОСТ 2.701-84 §2.3.4: at least 3 mm between parallel lines)", () => {
  it("two horizontal wires half a cell apart along each other are one finding; one cell apart, none", () => {
    expect.soft(of(checked(docOf([], [seg(at(0, 0), at(8, 0)), seg(at(0, 0.5), at(8, 0.5))])), "parallel-too-close"), "half a cell").toHaveLength(1)
    expect.soft(of(checked(docOf([], [seg(at(0, 0), at(8, 0)), seg(at(0, 1), at(8, 1))])), "parallel-too-close"), "a cell").toEqual([])
  })

  it("the same for vertical wires, and two wires half a cell apart that do not run alongside each other are none", () => {
    expect.soft(of(checked(docOf([], [seg(at(0, 0), at(0, 8)), seg(at(0.5, 0), at(0.5, 8))])), "parallel-too-close"), "vertical, half a cell").toHaveLength(1)
    expect.soft(of(checked(docOf([], [seg(at(0, 0), at(4, 0)), seg(at(6, 0.5), at(10, 0.5))])), "parallel-too-close"), "end to end, not alongside").toEqual([])
  })

  it("the approved half-cell slip is no finding: on the Nucleo's CN8, D45's wire runs half a cell beside RESET's between the two outer sockets because the user chose that picture (design.md §13.5: «takes the half-cell slip, and only it»; §13.9; boards/row-taken-half.png)", () => {
    const run = (...points: Point[]) => points.slice(1).map((p, i) => seg(points[i], p))
    const doc = docOf([part("U1", "nucleo-f429zi", 0, 0), resistor("R1", -6, 18), resistor("R4", -12, 19)], [...run(at(5, 19), at(-2, 19)), ...run(at(6, 19), at(6, 19.5), at(3, 19.5), at(3, 20), at(-8, 20))])
    expect.soft(of(checked(doc), "parallel-too-close"), "RESET's wire and D45's slip").toEqual([])
  })
})

describe("every example is clean: no warning and no note (plan.md acceptance 5; the user, design.md §13.21)", () => {
  for (const example of examples) {
    it(example.id, () => {
      const found = checked(example.build(GRID))
      expect(found.map((f) => `${f.kind} at (${f.at.x / GRID}, ${f.at.y / GRID}): ${f.text}`)).toEqual([])
    })
  }
})
