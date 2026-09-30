import { describe, expect, it } from "vitest"
import { flipped, GRID, objectRect, objectSize, orientationOf, orientPin, pinPoint, placedText, UPRIGHT, type Orientation } from "@/schematic/geometry"
import { examples } from "@/schematic/examples"
import { flipSelection } from "@/schematic/orient"
import { footprint } from "@/schematic/placement"
import { getDef, registry } from "@/schematic/registry"
import type { PlacedObject, Rotation } from "@/schematic/types"

const ROTATIONS: Rotation[] = [0, 45, 90, 135, 180, 225, 270, 315]
const ORIENTATIONS: Orientation[] = ROTATIONS.flatMap((rotation) => [{ rotation, mirror: false }, { rotation, mirror: true }])

const placed = (def: string, orientation: Orientation): PlacedObject => ({
  id: "u",
  def,
  x: 0,
  y: 0,
  ...(orientation.rotation && { rotation: orientation.rotation }),
  ...(orientation.mirror && { mirror: true }),
})

describe("a component mirrors the way schematic editors mirror", () => {
  it("mirroring twice on the same axis gives the component back", () => {
    for (const o of ORIENTATIONS) {
      expect(flipped(flipped(o, "horizontal"), "horizontal")).toEqual(o)
      expect(flipped(flipped(o, "vertical"), "vertical")).toEqual(o)
    }
  })

  it("mirroring on both axes is a half turn", () => {
    for (const o of ORIENTATIONS) expect(flipped(flipped(o, "horizontal"), "vertical")).toEqual({ rotation: (o.rotation + 180) % 360, mirror: o.mirror })
  })

  it("a component keeps its place and its box when mirrored", () => {
    for (const def of registry)
      for (const o of ORIENTATIONS)
        for (const axis of ["horizontal", "vertical"] as const) expect(objectSize(def, flipped(o, axis).rotation)).toEqual(objectSize(def, o.rotation))
  })

  it("mirrored left to right, every pin lands mirrored across the part, at any rotation", () => {
    for (const def of registry) {
      for (const o of ORIENTATIONS) {
        const box = objectSize(def, o.rotation)
        const mirrored = flipped(o, "horizontal")
        for (const raw of def.pins) {
          const before = orientPin(raw, def, o)
          const after = orientPin(raw, def, mirrored)
          expect(after.x, `${def.id} ${raw.id}`).toBeCloseTo(box.w - before.x)
          expect(after.y, `${def.id} ${raw.id}`).toBeCloseTo(before.y)
        }
      }
    }
  })

  it("mirrored top to bottom, every pin lands mirrored across the part, at any rotation", () => {
    for (const def of registry) {
      for (const o of ORIENTATIONS) {
        const box = objectSize(def, o.rotation)
        const mirrored = flipped(o, "vertical")
        for (const raw of def.pins) {
          const before = orientPin(raw, def, o)
          const after = orientPin(raw, def, mirrored)
          expect(after.x, `${def.id} ${raw.id}`).toBeCloseTo(before.x)
          expect(after.y, `${def.id} ${raw.id}`).toBeCloseTo(box.h - before.y)
        }
      }
    }
  })

  it("a wire leaves a mirrored pin the mirrored way", () => {
    const def = getDef("open746i-c")!
    const mirrored = flipped(UPRIGHT, "horizontal")
    const side = (pin: string, o: Orientation) => orientPin(def.pins.find((p) => p.id === pin)!, def, o).side
    expect(side("CN2-1", UPRIGHT)).toBe("left")
    expect(side("CN2-1", mirrored)).toBe("right")
    expect(side("P6-1", mirrored)).toBe("top")
    expect(side("P6-1", flipped(UPRIGHT, "vertical"))).toBe("bottom")
  })

  it("the netlist sees a mirrored pin where the symbol draws it", () => {
    const board = placed("open746i-c", flipped(UPRIGHT, "horizontal"))
    const rect = objectRect(board, GRID)
    const at = pinPoint(board, "CN2-1", GRID)!
    const upright = pinPoint(placed("open746i-c", UPRIGHT), "CN2-1", GRID)!
    expect(at.x).toBeCloseTo(rect.w - upright.x)
    expect(at.y).toBeCloseTo(upright.y)
  })

  it("a mirrored part takes the room of its mirrored body", () => {
    for (const id of ["resistor", "crystal", "open746i-c", "lcd7-f"]) {
      const def = getDef(id)!
      for (const o of ORIENTATIONS) {
        const a = footprint(placed(id, o), GRID)!
        const b = footprint(placed(id, flipped(o, "horizontal")), GRID)!
        const w = objectSize(def, o.rotation).w * GRID
        expect(b.box.x, `${id} ${o.rotation}${o.mirror ? "m" : ""}`).toBeCloseTo(w - (a.box.x + a.box.w))
        expect(b.box.w).toBeCloseTo(a.box.w)
        expect(b.box.y).toBeCloseTo(a.box.y)
      }
    }
  })

  it("an orientation missing from a file reads as upright and unmirrored", () => {
    expect(orientationOf({})).toEqual(UPRIGHT)
    expect(orientationOf({ rotation: 90, mirror: true })).toEqual({ rotation: 90, mirror: true })
  })
})

describe("a selection mirrors as one block, the way schematic editors mirror a block", () => {
  const bridge = examples.find((e) => e.id === "bridge")!.build(GRID)
  const everything = new Set(bridge.objects.map((o) => o.id))
  const pinsOf = (doc: typeof bridge) => new Map(doc.wires.flatMap((w) => [w.from, w.to]).map((ref) => [`${ref.object}:${ref.pin}`, pinPoint(doc.objects.find((o) => o.id === ref.object)!, ref.pin, GRID)!]))

  it("a single part mirrors where it stands", () => {
    const one = bridge.objects[0]
    const doc = flipSelection(bridge, new Set([one.id]), "horizontal", GRID)
    const after = doc.objects.find((o) => o.id === one.id)!
    expect({ x: after.x, y: after.y }).toEqual({ x: one.x, y: one.y })
    expect(after.mirror).toBe(true)
  })

  it("the whole circuit mirrors about one line, every wire still on its pins; a diagonal part within half a cell of it", () => {
    const diagonal = (key: string) => (bridge.objects.find((o) => key.startsWith(`${o.id}:`))!.rotation ?? 0) % 90 !== 0
    for (const axis of ["horizontal", "vertical"] as const) {
      const before = pinsOf(bridge)
      const after = pinsOf(flipSelection(bridge, everything, axis, GRID))
      const sum = (key: string) => (axis === "horizontal" ? after.get(key)!.x + before.get(key)!.x : after.get(key)!.y + before.get(key)!.y)
      const line = sum([...before.keys()].find((key) => !diagonal(key))!)
      for (const key of before.keys()) expect(Math.abs(sum(key) - line), `${axis} ${key}`).toBeLessThanOrEqual(diagonal(key) ? GRID / 2 + 1e-6 : 1e-6)
    }
  })

  it("mirroring the block twice gives the circuit back", () => {
    for (const axis of ["horizontal", "vertical"] as const) expect(flipSelection(flipSelection(bridge, everything, axis, GRID), everything, axis, GRID)).toEqual(bridge)
  })

  it("the bends of a wire inside the block mirror with it; a mirrored part stores only what it needs", () => {
    const withBend = { ...bridge, wires: bridge.wires.map((w, i) => (i === 0 ? { ...w, points: [{ x: GRID * 3, y: GRID * 5 }] } : w)) }
    const doc = flipSelection(withBend, everything, "vertical", GRID)
    expect(doc.wires[0].points![0].x).toBe(GRID * 3)
    expect(doc.wires[0].points![0].y).not.toBe(GRID * 5)
    const back = flipSelection(doc, everything, "vertical", GRID)
    expect(back.objects.every((o) => o.mirror === undefined)).toBe(true)
  })
})

describe("text on a mirrored or turned component stays readable", () => {
  const upright = (anchor: "start" | "middle" | "end", angle: number, o: Orientation) => placedText(anchor, angle, o)

  it("mirrored left to right, a text running from its anchor runs the other way instead of being written backwards", () => {
    const mirrored = flipped(UPRIGHT, "horizontal")
    expect(upright("start", 0, mirrored)).toEqual({ angle: 0, anchor: "end" })
    expect(upright("end", 0, mirrored)).toEqual({ angle: 0, anchor: "start" })
    expect(upright("middle", 0, mirrored)).toEqual({ angle: 0, anchor: "middle" })
  })

  it("mirrored top to bottom, a level text keeps its justification", () => {
    expect(upright("start", 0, flipped(UPRIGHT, "vertical"))).toEqual({ angle: 0, anchor: "start" })
  })

  it("turned upside down it still reads left to right, justified the other way", () => {
    expect(upright("start", 0, { rotation: 180, mirror: false })).toEqual({ angle: 0, anchor: "end" })
  })

  it("on a part standing on its side the text turns with it and reads from the bottom up, never from the top down", () => {
    expect(upright("start", 0, { rotation: 90, mirror: false })).toEqual({ angle: -90, anchor: "end" })
    expect(upright("start", 0, { rotation: 270, mirror: false })).toEqual({ angle: -90, anchor: "start" })
    expect(upright("middle", -90, { rotation: 90, mirror: false })).toEqual({ angle: 0, anchor: "middle" })
  })

  it("on a diagonal the text stays level", () => {
    for (const rotation of [45, 135, 225, 315] as Rotation[]) for (const mirror of [false, true]) expect(upright("middle", 0, { rotation, mirror }).angle).toBe(0)
  })

  it("an upright text mirrored left to right still runs up; mirrored top to bottom it runs up from the other end", () => {
    expect(upright("start", -90, flipped(UPRIGHT, "horizontal"))).toEqual({ angle: -90, anchor: "start" })
    expect(upright("start", -90, flipped(UPRIGHT, "vertical"))).toEqual({ angle: -90, anchor: "end" })
  })

  it("no text on any part ever reads upside down, sideways from the top or mirrored", () => {
    for (const def of registry)
      for (const o of ORIENTATIONS)
        for (const shape of def.body) if (shape.type === "text") expect([0, -90]).toContain(upright(shape.anchor ?? "middle", shape.rotate ?? 0, o).angle)
  })
})
