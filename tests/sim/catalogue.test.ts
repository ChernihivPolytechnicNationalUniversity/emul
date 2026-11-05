import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CATEGORIES, categoryLabel, isPaletteCategory } from "@/schematic/categories"
import * as icons from "@/schematic/icons"
import { getDef, allDefs } from "@/schematic/registry"
import { FAMILIES, familyOf, pinLayout, swapsFor } from "@/schematic/families"

// The palette's rules, checked for every part so that a new part cannot break them:
// a closed set of groups in a fixed order, names that fit a palette row, no clashes, English
// throughout, a known icon, and ids that saved projects keep loading by.

const NAME_BUDGET = 26
const VARIANT_BUDGET = 20
// Different parts that happen to have the same pins in the same places: not variants of one thing.
const DISTINCT = new Set(["resistor", "capacitor", "capacitor-polarized", "inductor", "led", "pushbutton", "switch", "diode", "zener", "voltmeter", "ammeter", "battery", "dc-source", "ac-source", "pulse-source"])
// Parts the palette shows with no description; the list only shrinks.
const NO_DESCRIPTION = new Set(["resistor", "potentiometer", "capacitor", "capacitor-polarized", "inductor", "diode", "zener", "led", "npn", "pnp", "pushbutton", "switch", "ground", "supply"])

const CYRILLIC = /[Ѐ-ӿ]/
const fold = (s: string) => s.toLowerCase().replace(/[\s\-_.,()"]/g, "").replace(/×/g, "x").replace(/²/g, "2")

describe("palette groups", () => {
  it("are a closed list in a fixed order, each with an English label", () => {
    expect(CATEGORIES.map((c) => c.id)).toEqual(["basics", "boards", "mcus", "leds", "displays", "input", "semis", "ics", "power", "sound", "instruments"])
    for (const c of CATEGORIES) expect(c.label).toMatch(/^[A-Z][A-Za-z &]+$/)
    expect(categoryLabel("mcus")).toBe("Microcontrollers")
  })

  it("every part sits in one of them", () => {
    for (const def of allDefs()) expect.soft(isPaletteCategory(def.category), `${def.id}: "${def.category}"`).toBe(true)
  })

  it("no group is a group of one", () => {
    for (const c of CATEGORIES) expect.soft(allDefs().filter((d) => d.category === c.id).length, c.id).toBeGreaterThanOrEqual(2)
  })

  it("the everyday parts open the palette", () => {
    const basics = allDefs().filter((d) => d.category === "basics").map((d) => d.id)
    for (const id of ["resistor", "potentiometer", "capacitor", "led", "pushbutton", "switch", "ground", "supply"]) expect(basics).toContain(id)
  })

  it("boards are ready-to-run boards and bare chips are microcontrollers", () => {
    for (const def of allDefs().filter((d) => d.category === "boards")) expect.soft(def.pinsAreSockets, def.id).toBe(true)
    for (const def of allDefs().filter((d) => d.category === "mcus")) {
      expect.soft(def.chip, def.id).toBeTruthy()
      expect.soft(def.pinsAreSockets, def.id).toBeFalsy()
    }
  })
})

describe("boards", () => {
  it("each carry a tile that says which board it is", () => {
    for (const def of allDefs()) {
      const card = def.board
      if (def.category !== "boards") {
        expect.soft(card, `${def.id} is no board: no tile`).toBeUndefined()
        continue
      }
      expect.soft(card, `${def.id}: give it a board card`).toBeDefined()
      if (!card) continue
      expect.soft(card.vendor.trim(), def.id).toBeTruthy()
      // Search finds a board by its MCU: the tile's MCU is one of its keywords.
      expect.soft(def.keywords ?? [], `${def.id}: ${card.mcu} among the keywords`).toContain(card.mcu)
      expect.soft(card.mhz, def.id).toBeGreaterThan(0)
      expect.soft(card.tags.length, `${def.id}: two tags at most`).toBeLessThanOrEqual(2)
      for (const tag of card.tags) expect.soft(tag.length, `${def.id}: "${tag}"`).toBeLessThanOrEqual(10)
      // A photo of the real board: the drawing alone does not tell a beginner which board is on the desk.
      expect.soft(existsSync(`public/boards/${card.photo}`), `${def.id}: public/boards/${card.photo}`).toBe(true)
    }
  })
})

describe("part names", () => {
  it("are unique however they are spelled", () => {
    const seen = new Map<string, string>()
    for (const def of allDefs()) {
      const key = fold(def.name)
      expect.soft(seen.get(key), `${def.id} and ${seen.get(key)} share the name "${def.name}"`).toBeUndefined()
      seen.set(key, def.id)
    }
  })

  it("fit a palette row", () => {
    // A family's row shows the family's name; a part of its own shows its name.
    for (const def of allDefs()) if (!familyOf(def.id)) expect.soft(def.name.length, `${def.id}: "${def.name}"`).toBeLessThanOrEqual(NAME_BUDGET)
    for (const f of FAMILIES) expect.soft(f.name.length, `family ${f.id}: "${f.name}"`).toBeLessThanOrEqual(NAME_BUDGET)
  })

  it("and descriptions are given", () => {
    for (const def of allDefs()) if (!NO_DESCRIPTION.has(def.id)) expect.soft(def.description?.trim(), def.id).toBeTruthy()
    for (const id of NO_DESCRIPTION) expect.soft(getDef(id)?.description, `${id} has a description now: drop it from NO_DESCRIPTION`).toBeUndefined()
  })

  it("come with the words a student searches by", () => {
    // The name alone finds a part only by its name: a "pot" or a "GND" needs saying.
    for (const def of allDefs()) expect.soft(def.keywords?.length ?? 0, `${def.id}: give it keywords`).toBeGreaterThan(0)
  })

  it("are English, like the rest of the interface", () => {
    for (const def of allDefs()) {
      const texts = [def.name, def.description ?? "", ...(def.keywords ?? []), ...(def.fields ?? []).map((f) => f.label)]
      for (const text of texts) expect.soft(CYRILLIC.test(text), `${def.id}: "${text}"`).toBe(false)
    }
  })
})

describe("part ids", () => {
  it("are unique", () => {
    expect(new Set(allDefs().map((d) => d.id)).size).toBe(allDefs().length)
  })

  it("that saved projects use keep loading", () => {
    const saved: string[] = JSON.parse(readFileSync("tests/data/catalogue-ids.json", "utf8"))
    for (const id of saved) expect.soft(getDef(id), `${id} no longer loads: keep it as a variant id or migrate it`).toBeDefined()
  })
})

describe("part icons", () => {
  it("come from the icon set", () => {
    const known = new Set<unknown>(Object.values(icons))
    for (const def of allDefs()) expect.soft(known.has(def.icon), def.id).toBe(true)
  })
})

const pinsOf = pinLayout

describe("families", () => {
  it("gather parts that exist, each in one family only", () => {
    const seen = new Set<string>()
    for (const f of FAMILIES) {
      expect.soft(f.variants.length, f.id).toBeGreaterThanOrEqual(2)
      expect.soft(getDef(f.id), `family id ${f.id} is a part id`).toBeUndefined()
      for (const [id] of f.variants) {
        expect.soft(getDef(id), `${f.id}: no part ${id}`).toBeDefined()
        expect.soft(seen.has(id), `${id} is in two families`).toBe(false)
        seen.add(id)
      }
    }
    expect(new Set(FAMILIES.map((f) => f.id)).size).toBe(FAMILIES.length)
  })

  it("tell their variants apart in a few words", () => {
    for (const f of FAMILIES) {
      const labels = f.variants.map(([, label]) => label)
      expect.soft(new Set(labels).size, `${f.id}: two variants share a label`).toBe(labels.length)
      for (const label of labels) expect.soft(label.length, `${f.id}: "${label}"`).toBeLessThanOrEqual(VARIANT_BUDGET)
    }
  })

  it("keep to one group, and offer in the inspector only swaps that leave every wire in place", () => {
    for (const f of FAMILIES) {
      const [first, ...rest] = f.variants.map(([id]) => getDef(id)!)
      for (const def of rest) expect.soft(def.category, `${f.id}: ${def.id}`).toBe(first.category)
      for (const [id] of f.variants) {
        const swaps = swapsFor(id)
        expect.soft(swaps.map(([v]) => v), `${id} swaps for itself`).toContain(id)
        for (const [other] of swaps) expect.soft(pinsOf(getDef(other)!), `${id} → ${other}`).toBe(pinsOf(getDef(id)!))
      }
    }
  })

  it("take in every part that could be one: the same pins in the same group make a family", () => {
    const loose = new Map<string, string[]>()
    for (const def of allDefs()) {
      if (familyOf(def.id) || DISTINCT.has(def.id)) continue
      const key = `${def.category} ${pinsOf(def)}`
      loose.set(key, [...(loose.get(key) ?? []), def.id])
    }
    for (const ids of loose.values()) expect.soft(ids, "variants of one part: make them a family in families.ts, or list them in DISTINCT").toHaveLength(1)
    for (const id of DISTINCT) expect.soft(familyOf(id), `${id} is in a family: drop it from DISTINCT`).toBeUndefined()
  })
})
