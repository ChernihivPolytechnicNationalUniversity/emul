import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CATEGORIES, categoryLabel, isPaletteCategory } from "@/schematic/categories"
import * as icons from "@/schematic/icons"
import { getDef, registry } from "@/schematic/registry"

// The palette's rules, checked for every part so that a new part cannot break them:
// a closed set of groups in a fixed order, names that fit a palette row, no clashes, English
// throughout, a known icon, and ids that saved projects keep loading by.

const NAME_BUDGET = 26
// Names too long for a palette row today. They become families with variants (the qualifier moves
// into the variant), and this list only shrinks: a new long name fails.
const LONG_NAMES = new Set([
  "Rotary encoder (ALPS EC11E)",
  "Rotary encoder module KY-040",
  "7-segment display, common anode",
  "7-segment display, common cathode",
  "4-digit 7-segment display, common anode",
  "4-digit 7-segment display, common cathode",
  'OLED 0.96" 128×64 I²C (SSD1306)',
  'OLED 0.91" 128×32 I²C (SSD1306)',
  'OLED 0.96" 128×64 SPI (SSD1306)',
])
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
    for (const def of registry) expect.soft(isPaletteCategory(def.category), `${def.id}: "${def.category}"`).toBe(true)
  })

  it("no group is a group of one", () => {
    for (const c of CATEGORIES) expect.soft(registry.filter((d) => d.category === c.id).length, c.id).toBeGreaterThanOrEqual(2)
  })

  it("the everyday parts open the palette", () => {
    const basics = registry.filter((d) => d.category === "basics").map((d) => d.id)
    for (const id of ["resistor", "potentiometer", "capacitor", "led", "pushbutton", "switch", "ground", "supply"]) expect(basics).toContain(id)
  })

  it("boards are ready-to-run boards and bare chips are microcontrollers", () => {
    for (const def of registry.filter((d) => d.category === "boards")) expect.soft(def.pinsAreSockets, def.id).toBe(true)
    for (const def of registry.filter((d) => d.category === "mcus")) {
      expect.soft(def.chip, def.id).toBeTruthy()
      expect.soft(def.pinsAreSockets, def.id).toBeFalsy()
    }
  })
})

describe("part names", () => {
  it("are unique however they are spelled", () => {
    const seen = new Map<string, string>()
    for (const def of registry) {
      const key = fold(def.name)
      expect.soft(seen.get(key), `${def.id} and ${seen.get(key)} share the name "${def.name}"`).toBeUndefined()
      seen.set(key, def.id)
    }
  })

  it("fit a palette row", () => {
    for (const def of registry) if (!LONG_NAMES.has(def.name)) expect.soft(def.name.length, `${def.id}: "${def.name}"`).toBeLessThanOrEqual(NAME_BUDGET)
    for (const name of LONG_NAMES) expect.soft(registry.some((d) => d.name === name), `"${name}" is gone: drop it from LONG_NAMES`).toBe(true)
  })

  it("and descriptions are given", () => {
    for (const def of registry) if (!NO_DESCRIPTION.has(def.id)) expect.soft(def.description?.trim(), def.id).toBeTruthy()
    for (const id of NO_DESCRIPTION) expect.soft(getDef(id)?.description, `${id} has a description now: drop it from NO_DESCRIPTION`).toBeUndefined()
  })

  it("come with the words a student searches by", () => {
    // The name alone finds a part only by its name: a "pot" or a "GND" needs saying.
    for (const def of registry) expect.soft(def.keywords?.length ?? 0, `${def.id}: give it keywords`).toBeGreaterThan(0)
  })

  it("are English, like the rest of the interface", () => {
    for (const def of registry) {
      const texts = [def.name, def.description ?? "", ...(def.keywords ?? []), ...(def.fields ?? []).map((f) => f.label)]
      for (const text of texts) expect.soft(CYRILLIC.test(text), `${def.id}: "${text}"`).toBe(false)
    }
  })
})

describe("part ids", () => {
  it("are unique", () => {
    expect(new Set(registry.map((d) => d.id)).size).toBe(registry.length)
  })

  it("that saved projects use keep loading", () => {
    const saved: string[] = JSON.parse(readFileSync("tests/data/catalogue-ids.json", "utf8"))
    for (const id of saved) expect.soft(getDef(id), `${id} no longer loads: keep it as a variant id or migrate it`).toBeDefined()
  })
})

describe("part icons", () => {
  it("come from the icon set", () => {
    const known = new Set<unknown>(Object.values(icons))
    for (const def of registry) expect.soft(known.has(def.icon), def.id).toBe(true)
  })
})
