import { describe, expect, it } from "vitest"
import {
  boundsOf,
  boxCorners,
  KNOCKOUT_OPACITY,
  labelFrame,
  labelKnockout,
  labelOrigin,
  MAX_PIN_LABEL_CELLS,
  numbersItsPins,
  PIN_LABEL_CELLS,
  pinNumberPlacement,
  pinLabelById,
  pinLabels,
  type Box,
  type PinLabel,
} from "@/components/field/pin-label"
import { flipped, orientPin, UPRIGHT, type Orientation, type Point } from "@/schematic/geometry"
import { getDef, registry } from "@/schematic/registry"
import type { ComponentDef, Rotation } from "@/schematic/types"

const def = (id: string) => getDef(id)!
const board = def("open746i-c")

const ROTATIONS: Rotation[] = [0, 45, 90, 135, 180, 225, 270, 315]
const ORIENTATIONS: Orientation[] = ROTATIONS.flatMap((rotation) => [{ rotation, mirror: false }, { rotation, mirror: true }])
const SIZES = [PIN_LABEL_CELLS, 0.6, MAX_PIN_LABEL_CELLS]
const BOARD_PINS = 40

const labelOf = (d: ComponentDef, pin: string, orientation: Orientation = UPRIGHT) => pinLabelById(pinLabels(d, orientation)).get(pin)!
const pinsOf = (d: ComponentDef, connector: string) => d.pins.filter((p) => p.connector === connector && p.label).map((p) => p.id)

function footprint(d: ComponentDef, label: PinLabel, orientation: Orientation, size: number): Point[] {
  const pin = orientPin(d.pins.find((p) => p.id === label.id)!, d, orientation)
  return boxCorners(labelKnockout(label.text, label.anchor, size).solid, labelFrame(label, size)).map((p) => ({ x: pin.x + p.x, y: pin.y + p.y }))
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6

function separated(a: readonly Point[], b: readonly Point[]) {
  for (const shape of [a, b])
    for (let i = 0; i < shape.length; i++) {
      const p = shape[i]
      const q = shape[(i + 1) % shape.length]
      const axis = { x: p.y - q.y, y: q.x - p.x }
      const project = (points: readonly Point[]) => points.map((r) => r.x * axis.x + r.y * axis.y)
      const pa = project(a)
      const pb = project(b)
      if (Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6) return true
    }
  return false
}

describe("a wire never covers a pin name", () => {
  it("a name beside its pin stays where it was, level, on its own side", () => {
    const right = labelOf(board, "CN2-1")
    expect(labelOrigin(right, PIN_LABEL_CELLS)).toEqual({ x: 0.45, y: 0 })
    expect(right).toMatchObject({ angle: 0, anchor: "start", run: "across" })
    const left = labelOf(board, "CN1-1")
    expect(labelOrigin(left, PIN_LABEL_CELLS)).toEqual({ x: -0.45, y: 0 })
    expect(left).toMatchObject({ angle: 0, anchor: "end", run: "across" })
  })

  it("the padding before the name equals the padding after it", () => {
    for (const advance of [0.55, 0.6]) {
      for (const anchor of ["start", "end", "middle"] as const) {
        const { text, solid, rise, fall } = labelKnockout("MOSI", anchor, PIN_LABEL_CELLS, advance)
        expect(text.w).toBeCloseTo(4 * advance * PIN_LABEL_CELLS)
        const before = anchor === "middle" ? text.x - solid.x : text.x - rise.x
        const after = anchor === "middle" ? solid.x + solid.w - (text.x + text.w) : fall.x + fall.w - (text.x + text.w)
        expect(before).toBeCloseTo(after)
      }
    }
  })

  it("the ground fades in before the name and out after it, along the way the name runs", () => {
    const along = labelKnockout("MISO", "start", PIN_LABEL_CELLS)
    expect(along.axis).toBe("x")
    expect(along.rise.w).toBeGreaterThan(0)
    expect(along.rise.x + along.rise.w).toBeCloseTo(along.solid.x)
    expect(along.fall.x).toBeCloseTo(along.solid.x + along.solid.w)
    expect(along.solid.x).toBeLessThan(along.text.x)
    expect(along.solid.x + along.solid.w).toBeGreaterThan(along.text.x + along.text.w)
    const across = labelKnockout("CK", "middle", PIN_LABEL_CELLS)
    expect(across.axis).toBe("y")
    expect(across.rise.y + across.rise.h).toBeCloseTo(across.solid.y)
    expect(across.fall.y).toBeCloseTo(across.solid.y + across.solid.h)
    expect(across.solid.x + across.solid.w / 2).toBeCloseTo(0)
  })

  it("a passing wire stays faintly visible under the name", () => {
    expect(KNOCKOUT_OPACITY).toBeLessThan(1)
    expect(KNOCKOUT_OPACITY).toBeGreaterThan(0.5)
  })

  it("the solid part stops short of the pin's own marker at every size a name is drawn", () => {
    const marker: Box = { x: -0.2, y: -0.2, w: 0.4, h: 0.4 }
    for (const pin of ["CN2-1", "CN1-1", "VCP-TX", "P6-1", "P12-1"]) {
      const label = labelOf(board, pin)
      for (const size of SIZES) {
        const solid = boundsOf(boxCorners(labelKnockout(label.text, label.anchor, size).solid, labelFrame(label, size)))
        expect(overlap(solid, marker), `${pin} at ${size}`).toBe(false)
      }
    }
  })

  it("the knockout grows with the text", () => {
    const one = labelKnockout("MOSI", "start", 0.4)
    const two = labelKnockout("MOSI", "start", 0.8)
    expect(two.solid.w).toBeCloseTo(one.solid.w * 2)
    expect(two.rise.w).toBeCloseTo(one.rise.w * 2)
    expect(two.solid.h).toBeCloseTo(one.solid.h * 2)
  })

  it("a header name is knocked out in its shroud's colour, a board name in the board's, a part's in the field's", () => {
    expect(labelOf(board, "P1-6").ground).toBe("connector")
    expect(labelOf(board, "P5-9").ground).toBe("connector")
    expect(labelOf(board, "P6-3").ground).toBe("connector")
    expect(labelOf(board, "VCP-TX").ground).toBe("board")
    const chip = def("stm32f746ig")
    expect(labelOf(chip, chip.pins.find((p) => p.label)!.id).ground).toBe("board")
    expect(labelOf(def("led"), "1").ground).toBe("field")
  })
})

describe("names that would run into each other turn to run along their pins", () => {
  it("a row of header names on the top edge turns upright and reads from the bottom up", () => {
    for (const pin of pinsOf(board, "P6")) expect(labelOf(board, pin), pin).toMatchObject({ run: "along", angle: -90, anchor: "start" })
  })

  it("on the bottom edge it reads from the bottom up too, ending at the pin", () => {
    const outer = pinsOf(board, "P12").filter((id) => Number(id.split("-")[1]) % 2 === 1)
    for (const pin of outer) expect(labelOf(board, pin), pin).toMatchObject({ run: "along", angle: -90, anchor: "end" })
  })

  it("a name with room to spare stays level", () => {
    for (const pin of ["VCP-TX", "VCP-RX", "5VDC"]) expect(labelOf(board, pin), pin).toMatchObject({ run: "across", angle: 0, anchor: "middle" })
  })

  it("a header turns as a whole, never half its names", () => {
    for (const connector of ["P6", "P3", "P10", "P12", "P15"]) {
      const runs = new Set(pinsOf(board, connector).map((pin) => `${labelOf(board, pin).run}|${labelOf(board, pin).dir.y}`))
      expect(runs.size, connector).toBeLessThanOrEqual(2)
      expect([...runs].every((run) => run.startsWith("along")), connector).toBe(true)
    }
  })

  it("a name beside its pin never turns: a row of those already has a line each", () => {
    for (const pin of [...pinsOf(board, "CN2"), ...pinsOf(board, "P2")]) expect(labelOf(board, pin).run, pin).toBe("across")
  })

  it("turned with R, the board's left header becomes a top row and its names turn upright", () => {
    const turned: Orientation = { rotation: 90, mirror: false }
    for (const pin of pinsOf(board, "P2")) expect(labelOf(board, pin, turned), pin).toMatchObject({ run: "along", angle: -90 })
    for (const pin of pinsOf(board, "P6")) expect(labelOf(board, pin, turned).run, pin).toBe("across")
  })

  it("turned upside down, the names are not: they still read from the bottom up", () => {
    const upsideDown: Orientation = { rotation: 180, mirror: false }
    for (const pin of pinsOf(board, "P6")) expect(labelOf(board, pin, upsideDown), pin).toMatchObject({ run: "along", angle: -90, anchor: "end" })
    expect(labelOf(board, "CN2-1", upsideDown)).toMatchObject({ angle: 0, anchor: "end" })
  })

  it("mirrored, a name is never written backwards: it keeps its angle and moves to the other side of its pin", () => {
    const mirrored = flipped(UPRIGHT, "horizontal")
    expect(labelOf(board, "CN2-1", mirrored)).toMatchObject({ angle: 0, anchor: "end", dir: { x: -1, y: 0 } })
    expect(labelOf(board, "CN1-1", mirrored)).toMatchObject({ angle: 0, anchor: "start", dir: { x: 1, y: 0 } })
    for (const pin of pinsOf(board, "P6")) expect(labelOf(board, pin, flipped(UPRIGHT, "vertical")), pin).toMatchObject({ angle: -90, anchor: "end" })
  })

  it("on a diagonal a crowded row runs along its pins, one line apart", () => {
    const diagonal: Orientation = { rotation: 45, mirror: false }
    const labels = pinsOf(board, "P13").map((pin) => labelOf(board, pin, diagonal))
    expect(labels.every((label) => label.run === "along" && Math.abs(label.angle) === 45)).toBe(true)
  })

  it("no name is ever drawn upside down, in any orientation of any part", () => {
    for (const d of registry)
      for (const orientation of ORIENTATIONS)
        for (const label of pinLabels(d, orientation)) {
          expect(label.angle, `${d.id} ${label.id}`).toBeGreaterThanOrEqual(-90)
          expect(label.angle, `${d.id} ${label.id}`).toBeLessThan(90)
        }
  })

  it("no two names of a part overlap in any orientation; on a board or a chip, not even at the largest size", () => {
    const clashes: string[] = []
    const dense = (d: ComponentDef) => d.pins.length >= BOARD_PINS
    for (const d of registry) {
      for (const orientation of ORIENTATIONS) {
        const labels = pinLabels(d, orientation)
        for (const size of dense(d) ? SIZES : SIZES.filter((size) => size < MAX_PIN_LABEL_CELLS)) {
          const boxes = labels.map((label) => footprint(d, label, orientation, size))
          for (let i = 0; i < boxes.length; i++)
            for (let j = i + 1; j < boxes.length; j++)
              if (!separated(boxes[i], boxes[j])) clashes.push(`${d.id} ${orientation.rotation}${orientation.mirror ? "m" : ""} @${size}: ${labels[i].id}/${labels[j].id}`)
        }
      }
    }
    expect(clashes.slice(0, 20)).toEqual([])
  })
})

describe("a part whose pins have no names shows their numbers while it is selected, so its orientation can be seen", () => {
  it("a resistor, a capacitor, a crystal or a transformer numbers its pins; a board, a chip or a one-pin symbol does not", () => {
    for (const id of ["resistor", "capacitor", "crystal", "transformer"]) expect(numbersItsPins(def(id)), id).toBe(true)
    for (const id of ["open746i-c", "stm32f746ig", "led", "ground", "supply"]) expect(numbersItsPins(def(id)), id).toBe(false)
  })

  it("mirrored left to right, pin 1 of a resistor moves from the left end to the right one and its number with it", () => {
    const resistor = def("resistor")
    const at = (orientation: Orientation) => {
      const pin = orientPin(resistor.pins.find((p) => p.id === "1")!, resistor, orientation)
      const origin = labelOrigin(pinNumberPlacement(pin), PIN_LABEL_CELLS)
      return pin.x + origin.x
    }
    expect(at(UPRIGHT)).toBeLessThan(resistor.width / 2)
    expect(at(flipped(UPRIGHT, "horizontal"))).toBeGreaterThan(resistor.width / 2)
  })
})

