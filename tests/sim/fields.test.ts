import { describe, expect, it } from "vitest"
import { join, split } from "@/collab/elements"
import { autoplaceSide, bodyWithoutFields, fieldTemplates, placedFields, withFieldMoved, type FieldSide, type PlacedField } from "@/schematic/fields"
import { allowedRotations, GRID, intersects, objectPins, type Rect } from "@/schematic/geometry"
import { stamped, upgraded } from "@/schematic/migrate"
import { flipSelection, turnedSelection } from "@/schematic/orient"
import { footprints, placementCheck } from "@/schematic/placement"
import { allDefs, getDef } from "@/schematic/registry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { clipOf } from "@/schematic/wire-edits"
import { pastedInto } from "@/schematic/use-schematic"
import { examples } from "@/schematic/examples"
import { routesOf } from "../lib/routes"

const c = (v: number) => v * GRID
const part = (id: string, def: string, x: number, y: number, extra: Partial<PlacedObject> = {}): PlacedObject => ({ id, def, x: c(x), y: c(y), props: { ref: id }, ...extra })
const FIELD_TEXT = /\{(ref|value)\}/

const strictlyOverlap = (a: Rect, b: Rect) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6

const holdsPoint = (r: Rect, p: { x: number; y: number }) => p.x > r.x + 1e-6 && p.x < r.x + r.w - 1e-6 && p.y > r.y + 1e-6 && p.y < r.y + r.h - 1e-6

function crossesSegment(r: Rect, [p, q]: readonly [{ x: number; y: number }, { x: number; y: number }]) {
  const steps = 32
  for (let i = 0; i <= steps; i++) if (holdsPoint(r, { x: p.x + ((q.x - p.x) * i) / steps, y: p.y + ((q.y - p.y) * i) / steps })) return true
  return false
}

const byKey = (fields: readonly PlacedField[]) => Object.fromEntries(fields.map((f) => [f.key, f]))

const middleOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

describe("designator and value are fields of the placed part, not body text (design.md §5.2; plan.md phase 5)", () => {
  it("every definition that drew {ref} or {value} as body text gives them up as fields, one per key, in one generic pass", () => {
    const converted: string[] = []
    const offenders: string[] = []
    for (const def of allDefs()) {
      const drew = def.body.filter((s) => s.type === "text" && FIELD_TEXT.test(s.text))
      if (!drew.length) continue
      converted.push(def.id)
      const keys = fieldTemplates(def).map((t) => t.key)
      const still = bodyWithoutFields(def).filter((s) => s.type === "text" && FIELD_TEXT.test(s.text))
      const wanted = [...new Set(drew.flatMap((s) => (s.type === "text" ? [...s.text.matchAll(/\{(ref|value)\}/g)].map((m) => m[1]) : [])))].sort()
      if (still.length || [...keys].sort().join() !== wanted.join() || new Set(keys).size !== keys.length) offenders.push(`${def.id}: fields ${keys.join("+")}, wanted ${wanted.join("+")}, still drawn ${still.length}`)
    }
    expect.soft(converted.length, "the catalogue still has definitions drawing {ref} or {value}").toBeGreaterThan(100)
    expect.soft(offenders, "every one of them converted").toEqual([])
  })

  it("a field keeps the text's look: the size and the muted value of the body text it replaces", () => {
    const resistor = getDef("resistor")!
    const templates = Object.fromEntries(fieldTemplates(resistor).map((t) => [t.key, t]))
    expect.soft(templates.ref, "the designator, full ink").toMatchObject({ text: "{ref}", size: 0.35, muted: false })
    expect.soft(templates.value, "the value, muted").toMatchObject({ text: "{value}", size: 0.3, muted: true })
  })

  it("a field reads the part's props: an empty value draws no field", () => {
    const fields = placedFields(part("R1", "resistor", 0, 0, { props: { ref: "R1", value: "4.7 kΩ" } }), GRID)
    expect.soft(fields.map((f) => [f.key, f.text]), "R1 and its value").toEqual([
      ["ref", "R1"],
      ["value", "4.7 kΩ"],
    ])
    expect.soft(placedFields(part("R1", "resistor", 0, 0, { props: { ref: "R1", value: "" } }), GRID).map((f) => f.key), "no value, no field").toEqual(["ref"])
  })
})

describe("fields are autoplaced where KiCad puts them: the first of right, top, left, bottom with the fewest pins (design.md §5.2, §13.3; KiCad autoplace_fields.cpp:322–433 at 07ed5d7; ГОСТ 2.702-2011 §5.3.11: right of or above the symbol)", () => {
  const sides: [string, string, PlacedObject["rotation"], FieldSide][] = [
    ["a resistor lying", "resistor", 0, "top"],
    ["a resistor turned a quarter", "resistor", 90, "right"],
    ["a resistor turned a half", "resistor", 180, "top"],
    ["a resistor turned three quarters", "resistor", 270, "right"],
    ["an NPN transistor (pins left, top, bottom)", "npn", 0, "right"],
    ["a 74HC595 (nine pins right, five left, one on top and one at the bottom: top comes before bottom)", "hc595", 0, "top"],
    ["a ground symbol (one pin on top)", "ground", 0, "right"],
  ]
  for (const [name, def, rotation, side] of sides) {
    it(`${name}: ${side}`, () => {
      expect(autoplaceSide(getDef(def)!, { rotation: rotation ?? 0, mirror: false })).toBe(side)
    })
  }

  it("a mirrored transistor has its base on the right, so its fields go to the left, the side with no pins (pins counted in the placed orientation, autoplace_fields.cpp pinsOnSide)", () => {
    expect(autoplaceSide(getDef("npn")!, { rotation: 0, mirror: true })).toBe("left")
  })

  it("on the chosen side the designator comes first, the value after it, stacked one above the other (KiCad: fields placed in order down the field box)", () => {
    const f = byKey(placedFields(part("R1", "resistor", 0, 0, { props: { ref: "R1", value: "1 kΩ" } }), GRID))
    expect.soft(f.ref.side, "both above").toBe("top")
    expect.soft(f.value.side, "both above").toBe("top")
    expect.soft(f.ref.box.y + f.ref.box.h <= f.value.box.y + 1e-6, "the designator above the value").toBe(true)
    expect.soft(Math.abs(middleOf(f.ref.box).x - c(2)) < 1e-6 && Math.abs(middleOf(f.value.box).x - c(2)) < 1e-6, "centred over the body (top: centre-justified)").toBe(true)
  })

  it("on the right side the fields are left-justified against the body, on the left right-justified (KiCad justifyField: the side's opposite)", () => {
    const right = byKey(placedFields(part("R1", "resistor", 0, 0, { rotation: 90, props: { ref: "R1", value: "1 kΩ" } }), GRID))
    expect.soft(right.ref.anchor, "right side").toBe("start")
    expect.soft(Math.abs(right.ref.box.x - right.value.box.x) < 1e-6, "both start at one x").toBe(true)
    const left = byKey(placedFields(part("Q1", "npn", 0, 0, { mirror: true, props: { ref: "Q1", value: "BC547" } }), GRID))
    expect.soft(left.ref.anchor, "left side").toBe("end")
    expect.soft(Math.abs(left.ref.box.x + left.ref.box.w - (left.value.box.x + left.value.box.w)) < 1e-6, "both end at one x").toBe(true)
  })

  it("in every orientation of every definition, an autoplaced field lies beside the body and never over it, over a pin or a lead, or over the other field", () => {
    const offenders: string[] = []
    for (const def of allDefs()) {
      if (!fieldTemplates(def).length) continue
      for (const rotation of allowedRotations(def)) {
        for (const mirror of [false, true]) {
          const o = part("X1", def.id, 0, 0, { rotation, mirror, props: { ref: "X1", value: "100 kΩ" } })
          const f = footprints(o, GRID)
          const fields = placedFields(o, GRID)
          const where = `${def.id} ${rotation}°${mirror ? " mirrored" : ""}`
          for (const field of fields) {
            if (f && f.contour.some((q) => strictlyOverlap(field.box, q.box))) offenders.push(`${where}: ${field.key} over the body`)
            if (objectPins(o, GRID).some((p) => holdsPoint(field.box, p.point))) offenders.push(`${where}: ${field.key} over a pin`)
            if (f && f.leads.some((lead) => crossesSegment(field.box, lead))) offenders.push(`${where}: ${field.key} over a lead`)
          }
          if (fields.length === 2 && strictlyOverlap(fields[0].box, fields[1].box)) offenders.push(`${where}: the two fields overlap`)
        }
      }
    }
    expect(offenders.slice(0, 40)).toEqual([])
  })

  it("an autoplaced field stays close: the stack's near edge lies within half a cell of the body on a side without pins (KiCad: HPADDING 25 mil, VPADDING 15 mil on a 100 mil cell)", () => {
    const f = byKey(placedFields(part("R1", "resistor", 0, 0, { props: { ref: "R1", value: "1 kΩ" } }), GRID))
    const body = footprints(part("R1", "resistor", 0, 0), GRID)!.body.box
    const gap = body.y - (f.value.box.y + f.value.box.h)
    expect.soft(gap >= -1e-6, "above the body, not on it").toBe(true)
    expect.soft(gap <= c(0.5), "and within half a cell of it").toBe(true)
  })

  it("autoplacing is a function of the part alone: the same part placed anywhere gets the same fields relative to it", () => {
    const at = (x: number, y: number) => placedFields(part("R1", "resistor", x, y, { props: { ref: "R1", value: "1 kΩ" } }), GRID).map((f) => ({ ...f, box: { ...f.box, x: f.box.x - c(x), y: f.box.y - c(y) }, at: { x: f.at.x - c(x), y: f.at.y - c(y) } }))
    expect(at(37, -12)).toEqual(at(0, 0))
  })
})

describe("fields move by hand, and keep where they were put (design.md §5.2; KiCad: a moved field is no longer autoplaced)", () => {
  const r1 = part("R1", "resistor", 0, 0, { props: { ref: "R1", value: "1 kΩ" } })

  it("a field moved by hand is where it was dropped and says so", () => {
    const before = byKey(placedFields(r1, GRID)).ref
    const moved = withFieldMoved(r1, "ref", c(3), c(-1), GRID)
    const after = byKey(placedFields(moved, GRID)).ref
    expect.soft(after.at, "three cells right, one up").toEqual({ x: before.at.x + c(3), y: before.at.y - c(1) })
    expect.soft(after.moved, "marked as moved").toBe(true)
    expect.soft(byKey(placedFields(moved, GRID)).value.at, "the other field stays autoplaced").toEqual(byKey(placedFields(r1, GRID)).value.at)
  })

  it("the moved field is saved with the part: through a file and a live room", () => {
    const doc: Schematic = { objects: [withFieldMoved(r1, "ref", c(3), c(-1), GRID)], wires: [], parts: {} }
    const want = byKey(placedFields(doc.objects[0], GRID)).ref.at
    const reopened = upgraded(JSON.parse(JSON.stringify(stamped(doc)))).doc
    expect.soft(byKey(placedFields(reopened.objects[0], GRID)).ref.at, "saved and opened").toEqual(want)
    expect.soft(byKey(placedFields(join(split(doc)).objects[0], GRID)).ref.at, "through a room").toEqual(want)
  })

  it("the moved field is copied with the part (design.md §6.6)", () => {
    const doc: Schematic = { objects: [withFieldMoved(r1, "ref", c(3), c(-1), GRID)], wires: [], parts: {} }
    const clip = clipOf(doc, new Set(["R1"]))!
    const pasted = pastedInto(doc, clip, c(10), 0, () => "R1c", () => "w1")
    const copy = pasted.objects.find((o) => o.id === "R1c")!
    expect(byKey(placedFields(copy, GRID)).ref.at).toEqual({ x: byKey(placedFields(doc.objects[0], GRID)).ref.at.x + c(10), y: byKey(placedFields(doc.objects[0], GRID)).ref.at.y })
  })

  it("a turn or a mirror places an autoplaced field again: a lying resistor's fields above go to its right when it stands up (KiCad SCH_SYMBOL::Rotate, then AutoplaceFields while AUTOPLACE_AUTO)", () => {
    const doc: Schematic = { objects: [r1], wires: [], parts: {} }
    const turned = turnedSelection(doc, new Set(["R1"]), 2, GRID)
    expect.soft(turned.objects[0].rotation, "set up: a quarter turn").toBe(90)
    expect.soft(turned.objects[0].fieldAt, "nothing written by the turn").toBeUndefined()
    expect.soft(byKey(placedFields(turned.objects[0], GRID)).ref.side, "turned a quarter: right").toBe("right")
    const flipped = flipSelection({ objects: [part("Q1", "npn", 0, 0, { props: { ref: "Q1", value: "BC547" } })], wires: [], parts: {} }, new Set(["Q1"]), "horizontal", GRID)
    expect.soft(byKey(placedFields(flipped.objects[0], GRID)).ref.side, "a transistor mirrored: left").toBe("left")
  })

  it("a field moved by hand turns with its part, and still reads left to right or bottom to top (KiCad: a manually placed field rotates with the symbol)", () => {
    const moved = withFieldMoved(r1, "ref", 0, c(-2), GRID)
    const doc: Schematic = { objects: [moved], wires: [], parts: {} }
    const turned = turnedSelection(doc, new Set(["R1"]), 2, GRID).objects[0]
    expect.soft(turned.rotation, "set up: a quarter turn").toBe(90)
    const body = footprints(turned, GRID)!.body.box
    const ref = byKey(placedFields(turned, GRID)).ref
    expect.soft(ref.moved, "still a moved field").toBe(true)
    expect.soft(middleOf(ref.box).x > body.x + body.w, "the field above the lying part is to the right of the standing one").toBe(true)
    expect.soft([0, -90].includes(ref.angle), "readable").toBe(true)
  })

  it("a document with no moved field is opened unchanged: autoplaced fields are derived, never written into it", () => {
    for (const example of examples.slice(0, 12)) {
      const doc = example.build(GRID)
      expect.soft(doc.objects.filter((o) => o.fieldAt).map((o) => o.id), `${example.id}: nothing stored`).toEqual([])
    }
  })
})

describe("fields never block (design.md §5.1, §5.2)", () => {
  it("a part may stand where another part's field is: the field is moved, not the part (the overlap is the checker's, checker.test.ts)", () => {
    const a = part("R1", "resistor", 0, 0, { props: { ref: "R1", value: "1 kΩ" } })
    const b = part("R2", "resistor", 0, -1)
    const s = { objects: [a, b], routes: routesOf([a, b], []), grid: GRID }
    expect.soft(placedFields(a, GRID).some((f) => strictlyOverlap(f.box, footprints(b, GRID)!.body.box)), "set up: R2's body over R1's fields").toBe(true)
    expect.soft(intersects(footprints(b, GRID)!.body.box, footprints(a, GRID)!.body.box), "set up: the bodies apart").toBe(false)
    expect(placementCheck(s, [b])(0, 0)).toBe(false)
  })
})
