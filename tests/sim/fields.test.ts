import { describe, expect, it } from "vitest"
import { join, split } from "@/collab/elements"
import { examples } from "@/schematic/examples"
import { autoplaceSide, bodyWithoutFields, fieldTemplates, placedFields, withFieldMoved, type FieldSide, type PlacedField } from "@/schematic/fields"
import { allowedRotations, GRID, intersects, objectPins, type Point, type Rect } from "@/schematic/geometry"
import { stamped, upgraded } from "@/schematic/migrate"
import { flipSelection, turnedAbout, turnedSelection, turnPivot } from "@/schematic/orient"
import { footprints, placementCheck } from "@/schematic/placement"
import { allDefs, getDef } from "@/schematic/registry"
import type { ComponentDef, PinDef, PlacedObject, Schematic } from "@/schematic/types"
import { clipOf, inNormalForm, wiringOf } from "@/schematic/wire-edits"
import { pastedInto } from "@/schematic/use-schematic"
import { pinPartition, WireGraph } from "@/schematic/wires/graph"
import { routesOf } from "../lib/routes"

const c = (v: number) => v * GRID
const part = (id: string, def: string, x: number, y: number, extra: Partial<PlacedObject> = {}): PlacedObject => ({ id, def, x: c(x), y: c(y), props: { ref: id }, ...extra })
const FIELD_TEXT = /\{(ref|value)\}/

const strictlyOverlap = (a: Rect, b: Rect) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6

function overlapsQuad(r: Rect, corners: readonly Point[]) {
  const box = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ]
  const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }, ...corners.map((p, i) => {
    const q = corners[(i + 1) % corners.length]
    return { x: -(q.y - p.y), y: q.x - p.x }
  })]
  return axes.every((axis) => {
    const along = (list: readonly Point[]) => list.map((p) => p.x * axis.x + p.y * axis.y)
    const a = along(box)
    const b = along(corners)
    return Math.max(...a) > Math.min(...b) + 1e-6 && Math.max(...b) > Math.min(...a) + 1e-6
  })
}

const holdsPoint = (r: Rect, p: { x: number; y: number }) => p.x > r.x + 1e-6 && p.x < r.x + r.w - 1e-6 && p.y > r.y + 1e-6 && p.y < r.y + r.h - 1e-6

function crossesSegment(r: Rect, [p, q]: readonly [{ x: number; y: number }, { x: number; y: number }]) {
  const steps = 32
  for (let i = 0; i <= steps; i++) if (holdsPoint(r, { x: p.x + ((q.x - p.x) * i) / steps, y: p.y + ((q.y - p.y) * i) / steps })) return true
  return false
}

const byKey = (fields: readonly PlacedField[]) => Object.fromEntries(fields.map((f) => [f.key, f]))

const middleOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

const inCells = (p: Point) => ({ x: Math.round((p.x / GRID) * 1000) / 1000, y: Math.round((p.y / GRID) * 1000) / 1000 })

const named = (id: string, def: string, x: number, y: number, extra: Partial<PlacedObject> = {}) => part(id, def, x, y, { ...extra, props: { ref: id, value: "1 kΩ" } })

const fieldTexts = (def: ComponentDef) => def.body.filter((s) => s.type === "text" && FIELD_TEXT.test(s.text))

const synthetic = (base: string, id: string, pins: PinDef[], more: Partial<ComponentDef> = {}): ComponentDef => ({ ...getDef(base)!, id, pins, ...more })

describe("designator and value are fields of the placed part, not body text (design.md §5.2; plan.md phase 5)", () => {
  it("all 117 definitions that drew {ref} or {value} as body text give them up as fields, one per key, in one generic pass that keeps every other shape", () => {
    const converted: string[] = []
    const offenders: string[] = []
    for (const def of allDefs()) {
      const drew = fieldTexts(def)
      if (!drew.length) continue
      converted.push(def.id)
      const keys = fieldTemplates(def).map((t) => t.key)
      const wanted = [...new Set(drew.flatMap((s) => (s.type === "text" ? [...s.text.matchAll(/\{(ref|value)\}/g)].map((m) => m[1]) : [])))].sort()
      if ([...keys].sort().join() !== wanted.join() || new Set(keys).size !== keys.length) offenders.push(`${def.id}: fields ${keys.join("+")}, wanted ${wanted.join("+")}`)
      const kept = def.body.filter((s) => !(s.type === "text" && FIELD_TEXT.test(s.text)))
      if (JSON.stringify(bodyWithoutFields(def)) !== JSON.stringify(kept)) offenders.push(`${def.id}: the rest of the body changed`)
    }
    expect.soft(converted.length, "the catalogue on main: 117 of 134").toBe(117)
    expect.soft(offenders, "every one converted, nothing else touched").toEqual([])
  })

  it("a field keeps the look of the body text it replaces: its template, size and muted ink (0.4 when the text had no size, as the renderer draws it)", () => {
    const offenders: string[] = []
    for (const def of allDefs()) {
      for (const template of fieldTemplates(def)) {
        const shape = fieldTexts(def).find((s) => s.type === "text" && s.text.includes(`{${template.key}}`))
        if (!shape || shape.type !== "text") continue
        const want = { text: shape.text, size: shape.size ?? 0.4, muted: !!shape.muted }
        if (JSON.stringify({ text: template.text, size: template.size, muted: template.muted }) !== JSON.stringify(want)) offenders.push(`${def.id}.${template.key}`)
      }
    }
    expect.soft(offenders, "every template as drawn before").toEqual([])
    const resistor = Object.fromEntries(fieldTemplates(getDef("resistor")!).map((t) => [t.key, t]))
    expect.soft(resistor.ref, "the resistor's designator, full ink").toMatchObject({ text: "{ref}", size: 0.35, muted: false })
    expect.soft(resistor.value, "its value, muted").toMatchObject({ text: "{value}", size: 0.3, muted: true })
  })

  it("a field reads the part's props, falling back to the definition's defaults; an empty value draws no field", () => {
    expect.soft(placedFields(part("R1", "resistor", 0, 0, { props: { ref: "R1", value: "4.7 kΩ" } }), GRID).map((f) => [f.key, f.text]), "R1 and its value").toEqual([
      ["ref", "R1"],
      ["value", "4.7 kΩ"],
    ])
    expect.soft(placedFields(part("R1", "resistor", 0, 0), GRID).map((f) => [f.key, f.text]), "no value set: the default").toEqual([
      ["ref", "R1"],
      ["value", getDef("resistor")!.defaults!.value],
    ])
    expect.soft(placedFields(part("R1", "resistor", 0, 0, { props: { ref: "R1", value: "" } }), GRID).map((f) => f.key), "an empty value: no field").toEqual(["ref"])
    expect.soft(placedFields(part("T1", "transformer", 0, 0, { props: { ref: "T1", value: "230 V", sec: "12 V" } }), GRID).map((f) => [f.key, f.text]), "a composite text keeps its other props").toEqual([
      ["ref", "T1"],
      ["value", "230 V : 12 V"],
    ])
  })
})

describe("fields are autoplaced as KiCad's autoplacer does on place and turn (design.md §5.2, §13.3; KiCad eeschema/autoplace_fields.cpp at 07ed5d7, AUTOPLACE_AUTO, allow_rejustify and align_to_grid on; ГОСТ 2.702-2011 §5.3.11: right of or above the symbol)", () => {
  const sides: [string, ComponentDef, PlacedObject["rotation"], boolean, FieldSide][] = [
    ["a resistor lying", getDef("resistor")!, 0, false, "top"],
    ["a resistor turned a quarter", getDef("resistor")!, 90, false, "right"],
    ["a resistor turned a half", getDef("resistor")!, 180, false, "top"],
    ["a resistor turned three quarters", getDef("resistor")!, 270, false, "right"],
    ["an NPN transistor (pins left, top, bottom)", getDef("npn")!, 0, false, "right"],
    ["an NPN mirrored (its base now on the right)", getDef("npn")!, 0, true, "left"],
    ["a 74HC595 (nine pins right, five left, one on top, one at the bottom: the fewest, top before bottom)", getDef("hc595")!, 0, false, "top"],
    ["a supply rail, a power symbol with its pin at the bottom (getPreferredSides' power order at 0°: top, bottom, left, right)", getDef("supply")!, 0, false, "top"],
  ]
  for (const [name, def, rotation, mirror, side] of sides) {
    it(`${name}: ${side}`, () => {
      expect(autoplaceSide(def, { rotation: rotation ?? 0, mirror })).toBe(side)
    })
  }

  it("a horizontally mirrored part prefers left over right when both are free (getPreferredSides swaps them for h_mirrored)", () => {
    const npn = getDef("npn")!
    const topAndBottom = synthetic("npn", "test-top-bottom", npn.pins.filter((p) => p.id !== "B"))
    expect.soft(autoplaceSide(topAndBottom, { rotation: 0, mirror: false }), "unmirrored: right").toBe("right")
    expect.soft(autoplaceSide(topAndBottom, { rotation: 0, mirror: true }), "mirrored: left").toBe("left")
  })

  it("a body more than three times as wide as it is tall prefers top, then bottom, left, right (getPreferredSides: w/h > 3)", () => {
    const wide = synthetic("resistor", "test-wide", [
      { id: "1", label: "", x: 0, y: 1, side: "left", labelAt: "top", kind: "digital" },
      { id: "2", label: "", x: 4, y: 2, side: "bottom", labelAt: "right", kind: "digital" },
    ], { width: 8, height: 2, body: [{ type: "rect", x: 0.5, y: 0.75, w: 7, h: 0.5 }, { type: "text", x: 4, y: 0.3, text: "{ref}", size: 0.35 }] })
    expect(autoplaceSide(wide, { rotation: 0, mirror: false })).toBe("top")
  })

  it("a lying resistor's fields: R1 centred over the body at y = −0.5 cell, its value under it at y = 0, both read left to right (DoAutoplace with align_to_grid; computed from fieldBoxPlacement and fieldVPlacement)", () => {
    const f = byKey(placedFields(named("R1", "resistor", 0, 0), GRID))
    expect.soft([f.ref.side, f.value.side], "both above").toEqual(["top", "top"])
    expect.soft([inCells(f.ref.at), f.ref.anchor, f.ref.angle], "the designator").toEqual([{ x: 2, y: -0.5 }, "middle", 0])
    expect.soft([inCells(f.value.at), f.value.anchor, f.value.angle], "the value").toEqual([{ x: 2, y: 0 }, "middle", 0])
  })

  it("a resistor turned a quarter: both fields to its right, left-justified at x = 2 cells, R1 at y = 1.75, the value at y = 2.25 (justifyField: the side's opposite; x rounded away from the body)", () => {
    const f = byKey(placedFields(named("R1", "resistor", 0, 0, { rotation: 90 }), GRID))
    expect.soft([inCells(f.ref.at), f.ref.anchor, f.ref.angle], "the designator").toEqual([{ x: 2, y: 1.75 }, "start", 0])
    expect.soft([inCells(f.value.at), f.value.anchor, f.value.angle], "the value").toEqual([{ x: 2, y: 2.25 }, "start", 0])
  })

  it("on the left side the fields are right-justified, their ends aligned", () => {
    const left = byKey(placedFields(part("Q1", "npn", 0, 0, { mirror: true, props: { ref: "Q1", value: "BC547" } }), GRID))
    expect.soft([left.ref.anchor, left.value.anchor], "right-justified").toEqual(["end", "end"])
    expect.soft(Math.abs(left.ref.box.x + left.ref.box.w - (left.value.box.x + left.value.box.w)) < 1e-6, "both end at one x").toBe(true)
  })

  it("on a top side that has a pin the stack is left-justified beside the pin, two paddings to its right (fieldBoxPlacement with pins > 0; justifyField as SIDE_RIGHT)", () => {
    const ref = byKey(placedFields(part("U1", "hc595", 0, 0), GRID)).ref
    expect.soft(ref.side, "top").toBe("top")
    expect.soft(ref.anchor, "left-justified").toBe("start")
    expect.soft(ref.box.x >= c(4.5) - 1e-6, "right of VCC's pin at x = 4 by 2 × HPADDING").toBe(true)
  })

  it("on a right side that has a pin the stack is centred above that side's pins by two paddings (fieldBoxPlacement; justifyField as SIDE_TOP)", () => {
    const pin = (id: string, x: number, y: number, side: PinDef["side"]): PinDef => ({ id, label: "", x, y, side, labelAt: "top", kind: "digital" })
    const busy = synthetic("hc595", "test-busy", [pin("L1", 1, 4, "left"), pin("L2", 1, 6, "left"), pin("L3", 1, 8, "left"), pin("T1", 3, 1, "top"), pin("T2", 5, 1, "top"), pin("B1", 3, 13, "bottom"), pin("B2", 5, 13, "bottom"), pin("R1", 7, 9, "right")])
    expect.soft(autoplaceSide(busy, { rotation: 0, mirror: false }), "the fewest pins: right").toBe("right")
    const fields = placedFields({ id: "U9", def: busy.id, x: 0, y: 0, props: { ref: "U9" } }, GRID, busy)
    expect.soft(fields.map((f) => f.key), "set up: its designator").toEqual(["ref"])
    expect.soft(fields.map((f) => f.anchor), "centred").toEqual(["middle"])
    expect.soft(fields.every((f) => f.box.y + f.box.h <= c(9 - 0.3) + 1e-6), "above the right side's pin at y = 9 by 2 × VPADDING").toBe(true)
  })

  it("in every orientation of every definition, the autoplaced fields are all there, read left to right, and lie beside the body, never over it, over a pin or a lead, or over each other", () => {
    const offenders: string[] = []
    for (const def of allDefs()) {
      const keys = fieldTemplates(def).map((t) => t.key).sort()
      if (!keys.length) continue
      for (const rotation of allowedRotations(def)) {
        for (const mirror of [false, true]) {
          const o = part("X1", def.id, 0, 0, { rotation, mirror, props: { ...def.defaults, ref: "X1", value: "100 kΩ" } })
          const f = footprints(o, GRID)
          const fields = placedFields(o, GRID)
          const where = `${def.id} ${rotation}°${mirror ? " mirrored" : ""}`
          if (!f) offenders.push(`${where}: no footprint`)
          if (fields.map((field) => field.key).sort().join() !== keys.join()) offenders.push(`${where}: fields ${fields.map((field) => field.key).join("+")}`)
          for (const field of fields) {
            if (!(field.box.w > 0 && field.box.h > 0 && Number.isFinite(field.box.x) && Number.isFinite(field.box.y))) offenders.push(`${where}: ${field.key} has no box`)
            if (field.angle !== 0) offenders.push(`${where}: ${field.key} not horizontal`)
            if (f && f.contour.some((q) => overlapsQuad(field.box, q.corners))) offenders.push(`${where}: ${field.key} over the body`)
            if (objectPins(o, GRID).some((p) => holdsPoint(field.box, p.point))) offenders.push(`${where}: ${field.key} over a pin`)
            if (f && f.leads.some((lead) => crossesSegment(field.box, lead))) offenders.push(`${where}: ${field.key} over a lead`)
          }
          if (fields.length === 2 && strictlyOverlap(fields[0].box, fields[1].box)) offenders.push(`${where}: the two fields overlap`)
        }
      }
    }
    expect(offenders.slice(0, 40)).toEqual([])
  })

  it("autoplacing is a function of the part alone: the same part placed anywhere gets the same two fields relative to it", () => {
    const fine = (v: number) => Math.round((v / GRID) * 1e6) / 1e6
    const at = (x: number, y: number) => placedFields(named("R1", "resistor", x, y), GRID).map((f) => ({ ...f, box: { x: fine(f.box.x - c(x)), y: fine(f.box.y - c(y)), w: fine(f.box.w), h: fine(f.box.h) }, at: { x: fine(f.at.x - c(x)), y: fine(f.at.y - c(y)) } }))
    expect.soft(at(0, 0).map((f) => f.key), "both fields").toEqual(["ref", "value"])
    expect.soft(at(37, -12), "the same relative to the part").toEqual(at(0, 0))
  })
})

describe("fields move by hand, and keep where they were put (design.md §5.2; KiCad: a moved field is no longer autoplaced and turns with its symbol)", () => {
  const r1 = named("R1", "resistor", 0, 0)
  const docWith = (o: PlacedObject): Schematic => ({ objects: [o], wires: [], parts: {} })

  it("a field moved by hand is where it was dropped and says so; the other field stays autoplaced", () => {
    for (const key of ["ref", "value"] as const) {
      const before = byKey(placedFields(r1, GRID))
      const moved = withFieldMoved(r1, key, c(3), c(-1), GRID)
      const after = byKey(placedFields(moved, GRID))
      const other = key === "ref" ? "value" : "ref"
      expect.soft(after[key].at, `${key}: three cells right, one up`).toEqual({ x: before[key].at.x + c(3), y: before[key].at.y - c(1) })
      expect.soft(after[key].moved, `${key}: marked as moved`).toBe(true)
      expect.soft([after[other].at, after[other].moved], `${other}: still autoplaced`).toEqual([before[other].at, false])
    }
  })

  it("the moved field is saved with the part, the offset itself and not just where it lands: through a file and a live room", () => {
    const doc = docWith(withFieldMoved(r1, "ref", c(3), c(-1), GRID))
    const reopened = upgraded(JSON.parse(JSON.stringify(stamped(doc)))).doc
    const roomed = join(split(doc))
    expect.soft(reopened.objects[0].fieldAt, "saved and opened").toEqual(doc.objects[0].fieldAt)
    expect.soft(roomed.objects[0].fieldAt, "through a room").toEqual(doc.objects[0].fieldAt)
    expect.soft(byKey(placedFields(reopened.objects[0], GRID)).ref.moved, "still a moved field").toBe(true)
    expect.soft(byKey(placedFields(roomed.objects[0], GRID)).ref.at, "where it was").toEqual(byKey(placedFields(doc.objects[0], GRID)).ref.at)
  })

  it("the moved field is copied with the part (design.md §6.6)", () => {
    const doc = docWith(withFieldMoved(r1, "ref", c(3), c(-1), GRID))
    const pasted = pastedInto(doc, clipOf(doc, new Set(["R1"]))!, c(10), 0, () => "R1c", () => "w1")
    const copy = pasted.objects.find((o) => o.id === "R1c")!
    const original = byKey(placedFields(doc.objects[0], GRID)).ref.at
    expect.soft(copy.fieldAt, "the offset copied").toEqual(doc.objects[0].fieldAt)
    expect.soft(byKey(placedFields(copy, GRID)).ref.at, "ten cells right of the original's").toEqual({ x: original.x + c(10), y: original.y })
  })

  it("a turn or a mirror places an autoplaced field again and writes nothing into the part (KiCad SCH_SYMBOL::Rotate, then AutoplaceFields while AUTOPLACE_AUTO)", () => {
    const turned = turnedSelection(docWith(r1), new Set(["R1"]), 2, GRID).objects[0]
    expect.soft(turned.rotation, "set up: a quarter turn").toBe(90)
    expect.soft(turned.fieldAt, "nothing written by the turn").toBeUndefined()
    expect.soft(byKey(placedFields(turned, GRID)).ref.side, "turned a quarter: right").toBe("right")
    const flipped = flipSelection(docWith(part("Q1", "npn", 0, 0, { props: { ref: "Q1", value: "BC547" } })), new Set(["Q1"]), "horizontal", GRID).objects[0]
    expect.soft(flipped.fieldAt, "nothing written by the mirror").toBeUndefined()
    expect.soft(byKey(placedFields(flipped, GRID)).ref.side, "a transistor mirrored: left").toBe("left")
  })

  it("a field moved by hand turns with its part about the same pivot, exactly, and its offset is never rewritten (KiCad: a manually placed field rotates with the symbol)", () => {
    for (const key of ["ref", "value"] as const) {
      const doc = docWith(withFieldMoved(r1, key, 0, c(-2), GRID))
      const ids = new Set(["R1"])
      const pivot = turnPivot(doc, ids, GRID)!
      const turned = turnedSelection(doc, ids, 2, GRID)
      const pinsBefore = objectPins(doc.objects[0], GRID).map((p) => turnedAbout(p.point, pivot, 90))
      expect.soft(objectPins(turned.objects[0], GRID).map((p) => p.point), "set up: the part's pins turned about the pivot by a quarter").toEqual(pinsBefore)
      const centre = middleOf(byKey(placedFields(doc.objects[0], GRID))[key].box)
      const want = turnedAbout(centre, pivot, 90)
      const after = byKey(placedFields(turned.objects[0], GRID))[key]
      expect.soft(inCells(middleOf(after.box)), `${key}: turned with the part`).toEqual(inCells(want))
      expect.soft([after.moved, turned.objects[0].fieldAt], `${key}: still moved, the offset untouched`).toEqual([true, doc.objects[0].fieldAt])
      const round = turnedSelection(turnedSelection(turned, ids, 2, GRID), ids, 4, GRID)
      expect.soft(inCells(middleOf(byKey(placedFields(round.objects[0], GRID))[key].box)), `${key}: a full turn brings it back`).toEqual(inCells(centre))
      const twice = flipSelection(flipSelection(doc, ids, "horizontal", GRID), ids, "horizontal", GRID)
      expect.soft(inCells(middleOf(byKey(placedFields(twice.objects[0], GRID))[key].box)), `${key}: two mirrors bring it back`).toEqual(inCells(centre))
    }
  })

  it("moving a field changes no circuit and no wire", () => {
    const doc = inNormalForm({ objects: [r1, named("R2", "resistor", 4, 0)], wires: [], parts: {} })
    const moved = { ...doc, objects: [withFieldMoved(doc.objects[0], "ref", c(2), c(-3), GRID), doc.objects[1]] }
    expect.soft(moved.wires, "the wires").toEqual(doc.wires)
    expect.soft(pinPartition(wiringOf(new WireGraph(), moved).view), "the nets").toEqual(pinPartition(wiringOf(new WireGraph(), doc).view))
    expect.soft([moved.objects[0].x, moved.objects[0].y, moved.objects[0].rotation], "the part itself").toEqual([doc.objects[0].x, doc.objects[0].y, doc.objects[0].rotation])
  })

  it("every example opens unchanged: autoplaced fields are derived, never written into it, and its circuit is the same", () => {
    for (const example of examples) {
      const built = example.build(GRID)
      const input = JSON.parse(JSON.stringify(stamped(built)))
      const reopened = upgraded(input).doc
      for (const o of reopened.objects) placedFields(o, GRID)
      expect.soft(reopened.objects.filter((o) => o.fieldAt).map((o) => o.id), `${example.id}: no offset stored`).toEqual([])
      expect.soft(JSON.stringify(reopened.objects), `${example.id}: the parts as saved`).toBe(JSON.stringify(built.objects))
      expect.soft(pinPartition(wiringOf(new WireGraph(), reopened).view), `${example.id}: the circuit`).toEqual(pinPartition(wiringOf(new WireGraph(), built).view))
    }
  })
})

describe("fields never block (design.md §5.1, §5.2)", () => {
  it("a part may stand where another part's field is: the field is moved, not the part (the overlap is the checker's, checker.test.ts)", () => {
    const a = named("R1", "resistor", 0, 0)
    const b = part("R2", "resistor", 0, -1)
    const s = { objects: [a, b], routes: routesOf([a, b], []), grid: GRID }
    expect.soft(placedFields(a, GRID).some((f) => strictlyOverlap(f.box, footprints(b, GRID)!.body.box)), "set up: R2's body over R1's fields").toBe(true)
    expect.soft(intersects(footprints(b, GRID)!.body.box, footprints(a, GRID)!.body.box), "set up: the bodies apart").toBe(false)
    expect(placementCheck(s, [b])(0, 0)).toBe(false)
  })

  it("a field moved by hand over another part blocks nothing either", () => {
    const a = withFieldMoved(named("R1", "resistor", 0, 0), "ref", c(9), c(1.5), GRID)
    const b = part("R2", "resistor", 9, 0)
    const s = { objects: [a, b], routes: routesOf([a, b], []), grid: GRID }
    expect.soft(strictlyOverlap(byKey(placedFields(a, GRID)).ref.box, footprints(b, GRID)!.body.box), "set up: R1's designator over R2's body").toBe(true)
    expect.soft(placementCheck(s, [b])(0, 0), "R2 stays").toBe(false)
    expect.soft(placementCheck(s, [a])(0, 0), "and so does R1").toBe(false)
  })
})
