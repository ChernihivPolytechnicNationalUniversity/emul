import { describe, expect, it } from "vitest"
import { KNOCKOUT_OPACITY, pinLabelGround, pinLabelKnockout, pinLabelOffset } from "@/components/field/pin-label"
import { getDef } from "@/schematic/registry"

const def = (id: string) => getDef(id)!

describe("a wire never covers a pin name", () => {
  it("the name stays where it was, beside the pin on its own side", () => {
    expect(pinLabelOffset("right")).toEqual({ x: 0.45, y: 0, anchor: "start" })
    expect(pinLabelOffset("left")).toEqual({ x: -0.45, y: 0, anchor: "end" })
    expect(pinLabelOffset("top")).toEqual({ x: 0, y: -0.45, anchor: "middle" })
  })

  it("the padding before the name equals the padding after it", () => {
    for (const advance of [0.55, 0.6]) {
      for (const labelAt of ["right", "left", "top"] as const) {
        const { text, solid, rise, fall } = pinLabelKnockout("MOSI", labelAt, 1, advance)
        expect(text.w).toBeCloseTo(4 * advance * 0.3)
        const before = labelAt === "top" ? text.x - solid.x : text.x - rise.x
        const after = labelAt === "top" ? solid.x + solid.w - (text.x + text.w) : fall.x + fall.w - (text.x + text.w)
        expect(before).toBeCloseTo(after)
      }
    }
  })

  it("the ground fades in before the name and out after it, along the way the name runs", () => {
    const right = pinLabelKnockout("MISO", "right", 1)
    expect(right.axis).toBe("x")
    expect(right.rise.w).toBeGreaterThan(0)
    expect(right.rise.x + right.rise.w).toBeCloseTo(right.solid.x)
    expect(right.fall.x).toBeCloseTo(right.solid.x + right.solid.w)
    expect(right.solid.x).toBeLessThan(right.text.x)
    expect(right.solid.x + right.solid.w).toBeGreaterThan(right.text.x + right.text.w)
    const top = pinLabelKnockout("CK", "top", 1)
    expect(top.axis).toBe("y")
    expect(top.rise.y + top.rise.h).toBeCloseTo(top.solid.y)
    expect(top.fall.y).toBeCloseTo(top.solid.y + top.solid.h)
    expect(top.solid.x + top.solid.w / 2).toBeCloseTo(0)
  })

  it("a passing wire stays faintly visible under the name", () => {
    expect(KNOCKOUT_OPACITY).toBeLessThan(1)
    expect(KNOCKOUT_OPACITY).toBeGreaterThan(0.5)
  })

  it("the solid part stops short of the pin's own marker", () => {
    expect(pinLabelKnockout("MOSI", "right", 1).solid.x).toBeGreaterThan(0.2)
    const left = pinLabelKnockout("MOSI", "left", 1).solid
    expect(left.x + left.w).toBeLessThan(-0.2)
    const top = pinLabelKnockout("CK", "top", 1).solid
    expect(top.y + top.h).toBeLessThan(-0.2)
  })

  it("the knockout grows with the text boost", () => {
    const one = pinLabelKnockout("MOSI", "right", 1)
    const two = pinLabelKnockout("MOSI", "right", 2)
    expect(two.solid.w).toBeCloseTo(one.solid.w * 2)
    expect(two.rise.w).toBeCloseTo(one.rise.w * 2)
    expect(two.solid.h).toBeCloseTo(one.solid.h * 2)
  })

  it("a header name is knocked out in its shroud's colour, a board name in the board's, a part's in the field's", () => {
    const board = def("open746i-c")
    expect(pinLabelGround(board, "P1-6")).toBe("connector")
    expect(pinLabelGround(board, "P5-9")).toBe("connector")
    expect(pinLabelGround(board, "VCP-TX")).toBe("board")
    expect(pinLabelGround(def("stm32f746ig"), def("stm32f746ig").pins.find((p) => p.label)!.id)).toBe("board")
    expect(pinLabelGround(def("led"), "1")).toBe("field")
  })
})
