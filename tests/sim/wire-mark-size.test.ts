import { describe, expect, it } from "vitest"
import { dotRadius, WIRE_PX } from "@/components/field/wire-style"
import { GRID } from "@/schematic/geometry"

const ZOOMS = [0.1, 0.25, 0.5, 1, 2, 3, 6, 10]

describe("a junction dot stays bigger than the wire it sits on at every zoom (the user, 2026-11-16, item 4)", () => {
  it("on the SVG field, where strokes scale with the view's CSS transform, the dot is a fixed world size several wires wide", () => {
    for (const zoom of ZOOMS) {
      const dotOnScreen = 2 * dotRadius(GRID, WIRE_PX) * zoom
      const wireOnScreen = WIRE_PX * zoom
      expect.soft(dotOnScreen / wireOnScreen, `zoom ${zoom}: dot diameter over wire width`).toBeGreaterThanOrEqual(4)
    }
  })

  it("on the canvas band, where the wire is a constant 2 screen px, the dot is never smaller than three wire widths", () => {
    for (const zoom of ZOOMS) {
      const wireInWorld = WIRE_PX / zoom
      const dotOnScreen = 2 * dotRadius(GRID, wireInWorld) * zoom
      expect.soft(dotOnScreen, `zoom ${zoom}: dot diameter in screen px`).toBeGreaterThanOrEqual(3 * WIRE_PX)
    }
  })
})
