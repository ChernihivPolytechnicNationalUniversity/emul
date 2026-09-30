import { describe, expect, it } from "vitest"
import { hollowMarkerHidden } from "@/components/field/pin-marker"
import { selectionOutline } from "@/components/field/selection-geometry"
import { trimRouteEnds } from "@/schematic/geometry"
import { getDef, registry } from "@/schematic/registry"

const def = (id: string) => getDef(id)!
const subpaths = (d: string) => d.split(/(?=M)/).filter((s) => s.trim())

describe("the selection follows the symbol", () => {
  it("a board is outlined by its housing alone, not by its headers and silkscreen", () => {
    const outline = selectionOutline(def("open746i-c"))
    expect(subpaths(outline.strokes)).toHaveLength(1)
    expect(outline.hollow).toBe("")
  })

  it("a resistor's leads and body are traced and its hollow body is filled evenly with the plate", () => {
    const outline = selectionOutline(def("resistor"))
    expect(subpaths(outline.strokes)).toHaveLength(3)
    expect(subpaths(outline.hollow)).toHaveLength(1)
    expect(outline.hollow).toMatch(/Z\s*$/)
  })

  it("a crystal's plates, leads and quartz are traced and its designator and value are not", () => {
    const outline = selectionOutline(def("crystal"))
    expect(subpaths(outline.strokes)).toHaveLength(5)
    expect(subpaths(outline.hollow)).toHaveLength(1)
  })

  it("a filled body is not filled again, so the plate adds nothing over what the part fills", () => {
    const led = selectionOutline(def("led"))
    const filled = def("led").body.filter((s) => s.type !== "text" && s.fill && s.fill !== "none" && s.fill !== "grip").length
    expect(filled).toBeGreaterThan(0)
    expect(subpaths(led.hollow).length).toBeLessThan(subpaths(led.strokes).length)
  })

  it("a junction, whose body is only a grip, is outlined by its node", () => {
    const outline = selectionOutline(def("junction"))
    expect(subpaths(outline.strokes)).toHaveLength(1)
  })
})

describe("a wire's casing stops short of its ends", () => {
  const route = [
    { x: 0, y: 0 },
    { x: 24, y: 0 },
    { x: 24, y: 48 },
  ]

  it("both ends move in along their own segment and the corners stay", () => {
    expect(trimRouteEnds(route, 6)).toEqual([
      { x: 6, y: 0 },
      { x: 24, y: 0 },
      { x: 24, y: 42 },
    ])
  })

  it("a segment shorter than twice the trim is cut at its middle, never past it", () => {
    const short = trimRouteEnds([{ x: 0, y: 0 }, { x: 8, y: 0 }], 6)
    expect(short).toEqual([{ x: 4, y: 0 }, { x: 4, y: 0 }])
  })

  it("nothing to trim leaves the route as it is", () => {
    expect(trimRouteEnds(route, 0)).toEqual(route)
  })
})

describe("a connected pin keeps its marker only where it is a socket", () => {
  it("a part's lead runs straight into its wire", () => {
    expect(hollowMarkerHidden(def("resistor"), "digital", true, false)).toBe(true)
  })

  it("a board's header pin stays a visible socket with a wire in it", () => {
    for (const id of ["open746i-c", "nucleo-f429zi", "lcd7-f", "lx-lcbst"]) expect(hollowMarkerHidden(def(id), "digital", true, false)).toBe(false)
  })

  it("an open pin, a touching pin and the filled markers are never hidden", () => {
    const resistor = def("resistor")
    expect(hollowMarkerHidden(resistor, "digital", false, false)).toBe(false)
    expect(hollowMarkerHidden(resistor, "digital", true, true)).toBe(false)
    for (const kind of ["power", "gnd", "analog", "node", "nc"] as const) expect(hollowMarkerHidden(resistor, kind, true, false)).toBe(false)
  })

  it("every board is a socket board", () => {
    const boards = registry.filter((d) => d.category === "Boards")
    expect(boards.length).toBeGreaterThan(0)
    for (const board of boards) expect(board.pinsAreSockets).toBe(true)
  })
})
