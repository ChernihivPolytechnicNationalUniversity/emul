import { describe, expect, it } from "vitest"
import { registry, getDef } from "@/schematic/registry"
import { FAMILIES, familyOf } from "@/schematic/families"
import { keptProps } from "@/schematic/use-schematic"
import { hitEntries, paletteGroups } from "@/components/palette/items"
import { searchParts } from "@/components/palette/search"

const rows = (query: string) => hitEntries(searchParts(registry, query))

describe("the palette's rows", () => {
  it("show a family once, where its first part stood, placing its first variant", () => {
    const entries = paletteGroups.flatMap((g) => g.entries)
    for (const f of FAMILIES) {
      const mine = entries.filter((e) => e.family?.id === f.id)
      expect.soft(mine, f.id).toHaveLength(1)
      expect.soft(mine[0]?.def.id, f.id).toBe(f.variants[0][0])
      expect.soft(mine[0]?.name, f.id).toBe(f.name)
    }
    expect(entries.length).toBe(registry.filter((d) => !familyOf(d.id)).length + FAMILIES.length)
  })

  it("say what a family holds", () => {
    const row = (id: string) => paletteGroups.flatMap((g) => g.entries).find((e) => e.key === id)
    expect(row("pic16f62x")?.hint).toBe("12 variants")
    expect(row("74hc595")?.hint).toBe("HC · HCT")
    expect(row("bjt")?.hint).toBe("NPN · PNP")
    expect(row("resistor")?.hint).toBeUndefined()
  })
})

describe("a search", () => {
  it("shows a family as one row that places the variant asked for", () => {
    const [row, ...rest] = rows("pic16lf628a")
    expect(row.key).toBe("pic16f62x")
    expect(row.def.id).toBe("pic16lf628a")
    expect(row.hint).toBe("PIC16LF628A")
    expect(rest.some((r) => r.family?.id === "pic16f62x")).toBe(false)
  })

  it("finds a family by its own name", () => {
    expect(rows("black pill")[0].key).toBe("weact-blackpill")
    expect(rows("bjt")[0].key).toBe("bjt")
    expect(rows("pnp")[0].def.id).toBe("pnp")
    expect(rows("buzzer").filter((r) => r.family?.id === "buzzer")).toHaveLength(1)
  })

  it("leaves a part of its own as its own row", () => {
    expect(rows("resistor")[0]).toMatchObject({ key: "resistor", name: "Resistor" })
  })
})

describe("switching a variant", () => {
  it("keeps the designator and drops choices the new variant does not offer", () => {
    const sk6812 = getDef("sk6812")!
    expect(keptProps({ ref: "LED3", value: "WS2812B-V5", fault: "ok" }, getDef("ws2812b"), sk6812)).toEqual({ ref: "LED3", fault: "ok" })
    // SK6812 comes in one revision: no "Part" to pick, so its own default stands.
    expect(keptProps({ ref: "LED3", value: "SK6812" }, getDef("sk6812rgbw"), sk6812)).toEqual({ ref: "LED3" })
    expect(keptProps({ ref: "LED3", value: "WS2812B-V5" }, getDef("ws2812b"), getDef("ws2812")!)).toEqual({ ref: "LED3" })
  })

  it("keeps a chip's firmware", () => {
    const props = { ref: "U1", firmware: "blink.hex", firmwareData: "AAAA" }
    expect(keptProps(props, getDef("pic16f628a"), getDef("pic16f648a")!)).toEqual(props)
  })

  it("keeps a setting both variants start alike, not a part number", () => {
    const npn = getDef("npn")!
    const pnp = getDef("pnp")!
    const partKey = npn.fields!.find((f) => f.label === "Part")!.key
    const gainKey = npn.fields!.find((f) => f.label.startsWith("Current gain"))!.key
    expect(npn.defaults?.[partKey]).not.toBe(pnp.defaults?.[partKey])
    expect(keptProps({ ref: "Q1", [partKey]: "2N2222", [gainKey]: "150" }, npn, pnp)).toEqual({ ref: "Q1", [gainKey]: "150" })
  })

  it("drops what only the old variant had", () => {
    const generic = getDef("opamp-generic")!
    const lm358 = getDef("opamp-lm358")!
    const keys = Object.keys(generic.defaults ?? {})
    expect(keys.length).toBeGreaterThan(0)
    expect(keptProps({ ref: "U2", ...generic.defaults }, generic, lm358)).toEqual({ ref: "U2" })
  })
})
