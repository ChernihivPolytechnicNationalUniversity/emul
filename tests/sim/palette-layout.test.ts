import { describe, expect, it } from "vitest"
import { paletteModeOf, sizeClassOf } from "@/hooks/use-size-class"
import { clampWidth, DOCK } from "@/components/palette/dock-width"

const mode = (w: number, h: number) => paletteModeOf(sizeClassOf(w, h))

describe("the palette on each screen", () => {
  it("rises from the bottom on a phone held upright", () => {
    expect(mode(390, 844)).toBe("bottom-sheet")
    expect(mode(360, 640)).toBe("bottom-sheet")
  })

  it("comes from the side on a phone on its side, or a laptop zoomed to 200 %", () => {
    expect(mode(844, 390)).toBe("side-sheet")
    expect(mode(640, 360)).toBe("side-sheet")
  })

  it("is a column of group icons on a tablet held upright", () => {
    expect(mode(768, 1024)).toBe("rail")
    expect(mode(600, 900)).toBe("rail")
  })

  it("docks beside the field on a laptop and wider", () => {
    expect(mode(1024, 768)).toBe("dock")
    expect(mode(1440, 900)).toBe("dock")
    expect(mode(2560, 1440)).toBe("dock")
  })
})

describe("the docked palette's width", () => {
  it("stays between its narrowest and widest, wider allowed on a wide screen", () => {
    expect(clampWidth(100, "large")).toBe(DOCK.min)
    expect(clampWidth(1000, "large")).toBe(DOCK.max.large)
    expect(clampWidth(1000, "xl")).toBe(DOCK.max.xl)
    expect(clampWidth(300, "expanded")).toBe(300)
  })
})
