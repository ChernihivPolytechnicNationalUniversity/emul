import { describe, expect, it } from "vitest"
import { DIR, flipped, GRID, objectPins, objectRect, objectSize, orientationOf, orientPin, pinPoint, placedText, routeAll, UPRIGHT, type Orientation, type Point } from "@/schematic/geometry"
import { examples } from "@/schematic/examples"
import { flipSelection, rotateSelection } from "@/schematic/orient"
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

describe("a part turned or mirrored in place keeps its wires out of its own body", () => {
  const crossesBody = (p: Point, q: Point, r: { x: number; y: number; w: number; h: number }) => {
    const [x0, x1, y0, y1] = [r.x + 0.5, r.x + r.w - 0.5, r.y + 0.5, r.y + r.h - 0.5]
    if (p.y === q.y) return p.y > y0 && p.y < y1 && Math.max(p.x, q.x) > x0 && Math.min(p.x, q.x) < x1
    return p.x === q.x && p.x > x0 && p.x < x1 && Math.max(p.y, q.y) > y0 && Math.min(p.y, q.y) < y1
  }
  const turnsBack = (a: Point, b: Point, c: Point) => {
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    return dot < 0 && Math.abs(cross) < 1e-6
  }

  it("the wires into a turned part lose the bends drawn for the old way round; the rest keep theirs", () => {
    const doc = examples.find((e) => e.id === "bridge")!.build(GRID)
    const r5 = doc.objects.find((o) => o.props?.ref === "R5")!
    const into = (w: (typeof doc.wires)[number]) => w.from.object === r5.id || w.to.object === r5.id
    expect(doc.wires.filter(into).some((w) => w.points)).toBe(true)
    for (const after of [flipSelection(doc, new Set([r5.id]), "horizontal", GRID), rotateSelection(doc, new Set([r5.id]), 45, GRID)]) {
      expect(after.wires.filter(into).every((w) => !w.points)).toBe(true)
      expect(after.wires.filter((w) => !into(w))).toEqual(doc.wires.filter((w) => !into(w)))
    }
  })

  const cornered = new Map([
    ["system-exam R9", "in series with L1 pin to pin, so its far end can only reach L1 back along its own body"],
    ["system-exam L1", "in series with R9 pin to pin, so its far end can only reach R9 back along its own body"],
    ["charge-boost A1", "flipped, the way round the module runs through BT1 and SW1, and crossing another part costs more"],
  ])

  it("in every example, no wire of a mirrored or half-turned part runs back through the part, doubles back or meets a pin from the side, but where the way round is blocked", () => {
    const issues: string[] = []
    for (const example of examples) {
      const doc = example.build(GRID)
      for (const part of doc.objects) {
        const def = getDef(part.def)
        if (!def || def.pins.length > 8 || (part.rotation ?? 0) % 90 !== 0) continue
        const ids = new Set([part.id])
        for (const [how, after] of [
          ["mirrored", flipSelection(doc, ids, "horizontal", GRID)],
          ["flipped", flipSelection(doc, ids, "vertical", GRID)],
          ["half-turned", rotateSelection(rotateSelection(rotateSelection(rotateSelection(doc, ids, 45, GRID), ids, 45, GRID), ids, 45, GRID), ids, 45, GRID)],
        ] as const) {
          const moved = after.objects.find((o) => o.id === part.id)!
          const wires = after.wires.filter((w) => w.from.object === part.id || w.to.object === part.id)
          const body = footprint(moved, GRID)!.box
          for (const route of routeAll(after.objects, wires, GRID)) {
            const pts = route.pts
            const name = `${example.id} ${part.props?.ref ?? part.def} ${how}`
            const known = cornered.has(`${example.id} ${part.props?.ref}`)
            for (let i = 2; i < pts.length - 1; i++) if (!known && crossesBody(pts[i - 1], pts[i], body)) issues.push(`${name}: through its body`)
            for (let i = 1; i + 1 < pts.length; i++) if (turnsBack(pts[i - 1], pts[i], pts[i + 1])) issues.push(`${name}: doubles back`)
            const w = wires.find((x) => x.id === route.id)!
            if (pts.length < 2) continue
            for (const [ref, from, to] of [[w.from, pts[0], pts[1]], [w.to, pts[pts.length - 1], pts[pts.length - 2]]] as const) {
              const pin = objectPins(after.objects.find((o) => o.id === ref.object)!, GRID).find((p) => p.pin.id === ref.pin)!.pin
              const d = DIR[pin.side]
              if ((pin.stub ?? 1) > 0 && (Math.sign(to.x - from.x) !== Math.sign(d.x) || Math.sign(to.y - from.y) !== Math.sign(d.y))) issues.push(`${name}: meets ${ref.pin} from the side`)
            }
          }
        }
      }
    }
    expect([...new Set(issues)].slice(0, 30)).toEqual([])
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
