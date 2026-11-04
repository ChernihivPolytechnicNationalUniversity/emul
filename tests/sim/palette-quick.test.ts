import { describe, expect, it } from "vitest"
import { pushRecent, toggleFavourite, readIds, RECENT_KEEP } from "@/components/palette/recents"
import { hdlCreateMatch } from "@/components/palette/search"

describe("recent parts", () => {
  it("put the last one placed first, once", () => {
    expect(pushRecent(["led", "resistor"], "resistor")).toEqual(["resistor", "led"])
    expect(pushRecent([], "led")).toEqual(["led"])
  })

  it("keep a dozen at most", () => {
    const many = Array.from({ length: RECENT_KEEP }, (_, i) => `p${i}`)
    const next = pushRecent(many, "new")
    expect(next).toHaveLength(RECENT_KEEP)
    expect(next[0]).toBe("new")
    expect(next).not.toContain(`p${RECENT_KEEP - 1}`)
  })
})

describe("favourite parts", () => {
  it("toggle in and out, new ones last", () => {
    expect(toggleFavourite(["led"], "resistor")).toEqual(["led", "resistor"])
    expect(toggleFavourite(["led", "resistor"], "led")).toEqual(["resistor"])
  })
})

describe("saved lists", () => {
  it("drop parts that no longer exist and anything that is not a list of ids", () => {
    expect(readIds('["resistor","no-such-part",3,"led"]')).toEqual(["resistor", "led"])
    expect(readIds("{}")).toEqual([])
    expect(readIds("not json")).toEqual([])
    expect(readIds(null)).toEqual([])
  })
})

describe("a search for HDL", () => {
  it("offers to create a module", () => {
    for (const q of ["vhdl", "Verilog", "hdl", "fpga", "veri"]) expect(hdlCreateMatch(q), q).toBe(true)
    for (const q of ["led", "v", "", "resistor"]) expect(hdlCreateMatch(q), q).toBe(false)
  })
})
