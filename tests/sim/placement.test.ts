import { describe, expect, it } from "vitest"
import { examples } from "@/schematic/examples"
import { GRID, routeAll, Router } from "@/schematic/geometry"
import { bodyBounds, contactCheck, designatorRects, freeOffset, landingOffset, placementCheck, type PlacementScene } from "@/schematic/placement"
import { getDef } from "@/schematic/registry"
import type { PlacedObject, Wire } from "@/schematic/types"

const c = (v: number) => v * GRID
const part = (id: string, def: string, x: number, y: number): PlacedObject => ({ id, def, x: c(x), y: c(y) })

function scene(objects: PlacedObject[], wires: Wire[] = []): PlacementScene {
  return { objects, wires, routes: routeAll(objects, wires, GRID), grid: GRID }
}

describe("a part takes the room it draws, not its whole box", () => {
  it("a resistor is as tall as its body, not its two-cell box", () => {
    const b = bodyBounds(getDef("resistor")!)
    expect(b.w).toBeCloseTo(4)
    expect(b.h).toBeCloseTo(0.8)
  })
})

describe("parts do not pile onto each other", () => {
  it("two resistors two rows apart fit, and one dropped onto the other does not", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 0, 2)
    const check = placementCheck(scene([a, b]), [b])
    expect(check(0, 0)).toBe(false)
    expect(check(c(1), c(-2))).toBe(true)
  })

  it("a designator or value landing on another part counts as piling on", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 0, 1)
    expect(placementCheck(scene([a, b]), [b])(0, 0)).toBe(true)
  })

  it("a pin name landing on another part's value counts too", () => {
    const q = part("q", "crystal", 0, 0)
    const g = part("g", "oscillator", 0, 2)
    expect(placementCheck(scene([q, g]), [g])(0, 0)).toBe(true)
    expect(placementCheck(scene([q, g]), [g])(0, c(2))).toBe(false)
  })

  it("parts touching pin to pin are allowed", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 4, 0)
    expect(placementCheck(scene([a, b]), [b])(0, 0)).toBe(false)
  })

  it("a module docked onto its header by its pins is allowed", () => {
    const example = examples.find((e) => e.id === "open746-lcd")!
    const doc = example.build(GRID)
    const lcd = doc.objects.find((o) => o.def === "lcd7-f")!
    expect(placementCheck(scene(doc.objects, doc.wires), [lcd])(0, 0)).toBe(false)
  })

  it("pins landing on pins are no excuse to stack two parts that are not sockets", () => {
    const a = part("a", "resistor", 0, 0)
    const q = part("q", "crystal", 0, 0)
    expect(placementCheck(scene([a, q]), [q])(0, 0)).toBe(true)
  })

  it("a part cannot land on a wire that is not its own", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 12, 0)
    const wire: Wire = { id: "w", from: { object: "a", pin: "2" }, to: { object: "b", pin: "1" } }
    const crystal = part("q", "crystal", 6, 4)
    const check = placementCheck(scene([a, b, crystal], [wire]), [crystal])
    expect(check(0, 0)).toBe(false)
    expect(check(0, c(-4))).toBe(true)
  })

  it("a part's own wires do not stop it", () => {
    const a = part("a", "resistor", 0, 0)
    const b = part("b", "resistor", 12, 0)
    const wire: Wire = { id: "w", from: { object: "a", pin: "2" }, to: { object: "b", pin: "1" } }
    expect(placementCheck(scene([a, b], [wire]), [b])(c(-2), 0)).toBe(false)
  })

  it("a blocked spot gives way to the nearest free one", () => {
    const a = part("a", "resistor", 0, 0)
    const probe = part("new", "resistor", 0, 0)
    const at = freeOffset([placementCheck(scene([a]), [probe])], GRID)!
    expect(at).not.toBeNull()
    expect(placementCheck(scene([a]), [probe])(at.x, at.y)).toBe(false)
    expect(Math.hypot(at.x, at.y)).toBeLessThanOrEqual(c(2))
  })

  it("a junction is a point on a net, not a part, and goes where its wires meet", () => {
    const a = part("a", "resistor", 0, 0)
    const j = part("j", "junction", 3, 0)
    expect(placementCheck(scene([a, j]), [j])(0, 0)).toBe(false)
  })

  it("a part dropped onto another stops beside it, on the side it came from, without touching its pins", () => {
    const a = part("a", "resistor", 10, 0)
    const b = part("b", "resistor", 0, 0)
    const refuse = (s: PlacementScene, m: PlacedObject) => [placementCheck(s, [m]), contactCheck(s, [m])]
    expect(landingOffset(refuse(scene([a, b]), b), c(10), 0, GRID)).toEqual({ x: c(5), y: 0 })
    const d = part("d", "resistor", 20, 0)
    expect(landingOffset(refuse(scene([a, d]), d), c(-10), 0, GRID)).toEqual({ x: c(-5), y: 0 })
  })

  it("a free drop lands where it was dropped", () => {
    const a = part("a", "resistor", 10, 0)
    const b = part("b", "resistor", 0, 0)
    expect(landingOffset([placementCheck(scene([a, b]), [b])], 0, c(3), GRID)).toEqual({ x: 0, y: c(3) })
  })

  it("no shipped example already breaks the rule", () => {
    const offenders: string[] = []
    for (const example of examples) {
      const doc = example.build(GRID)
      const s = scene(doc.objects, doc.wires)
      for (const o of doc.objects) if (placementCheck(s, [o])(0, 0)) offenders.push(`${example.id}: ${o.props?.ref ?? o.def}`)
    }
    expect(offenders).toEqual([])
  })
})

describe("wires keep off the words", () => {
  it("a part cannot stand where the wire leaving one of its pins would run through someone's label", () => {
    const q = part("q", "crystal", 0, 0)
    const g = part("g", "oscillator", 0, 4)
    const wire: Wire = { id: "w", from: { object: "q", pin: "1" }, to: { object: "g", pin: "VCC" } }
    const check = placementCheck(scene([q, g], [wire]), [g])
    expect(check(0, 0)).toBe(false)
    expect(check(0, c(-1))).toBe(true)
  })

  it("a wire from a crystal to an oscillator below it goes round the crystal's frequency", () => {
    const q = part("q", "crystal", 0, 0)
    const g = part("g", "oscillator", 0, 4)
    const wire: Wire = { id: "w", from: { object: "q", pin: "1" }, to: { object: "g", pin: "VCC" } }
    const [route] = new Router(designatorRects).routeAll([q, g], [wire], GRID)
    const labels = designatorRects(q, GRID)
    const enters = (r: { x: number; y: number; w: number; h: number }) =>
      route.pts.some((p, i) => i > 0 && Math.min(p.y, route.pts[i - 1].y) < r.y + r.h && Math.max(p.y, route.pts[i - 1].y) > r.y && Math.min(p.x, route.pts[i - 1].x) < r.x + r.w && Math.max(p.x, route.pts[i - 1].x) > r.x)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.some(enters)).toBe(false)
  })
})

