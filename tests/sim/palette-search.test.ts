import { describe, expect, it } from "vitest"
import { registry } from "@/schematic/registry"
import { searchParts, toolHints } from "@/components/palette/search"

// What a student types, and what the palette must answer. The queries come from the palette audit:
// a part's own name, the word a datasheet or a lab sheet uses, the silkscreen on a board, a typo.

const ids = (query: string) => searchParts(registry, query).map((h) => h.def.id)
const first = (query: string) => ids(query)[0]

describe("palette search finds", () => {
  it.each([
    ["led", "led"],
    ["LED", "led"],
    ["resistor", "resistor"],
    ["pot", "potentiometer"],
    ["rheostat", "potentiometer"],
    ["trimmer", "potentiometer"],
    ["button", "pushbutton"],
    ["tactile", "pushbutton"],
    ["gnd", "ground"],
    ["vcc", "supply"],
    ["5v", "supply"],
    ["555", "ne555"],
    ["timer 555", "ne555"],
    ["pic16lf628a", "pic16lf628a"],
    ["PIC16F628A", "pic16f628a"],
    ["lcd i2c", "lcd-1602-i2c"],
    ["i2c lcd", "lcd-1602-i2c"],
    ["MB1137", "nucleo-f429zi"],
    ["MB997", "stm32f4-discovery"],
    ["f429", "nucleo-f429zi"],
    ["blackpill", "weact-blackpill-f411"],
    ["black pill", "weact-blackpill-f411"],
    ["neopixel", "ws2812b"],
    ["ws2812 strip", "led-stick-8"],
    ["ky040", "ky-040"],
    ["electrolytic", "capacitor-polarized"],
    ["mosfet", "nmos"],
    ["transistor", "npn"],
    ["multimeter", "voltmeter"],
    ["uart", "serial-terminal"],
    ["crystal", "crystal"],
    ["quartz", "crystal"],
    ["shift register", "hc595"],
    ["74hc595", "hc595"],
    ["op amp", "opamp-generic"],
    ["7 segment", "seven-segment-ca"],
    ["fuse", "polyfuse"],
    ["charger", "tp4056"],
    ["boost", "mt3608"],
  ])("%s → %s", (query, id) => {
    expect(first(query)).toBe(id)
  })

  it("a regulator by what it does", () => {
    for (const q of ["regulator", "ldo", "voltage regulator"]) expect(ids(q).slice(0, 2).sort(), q).toEqual(["lp2985", "ncp1117"])
  })

  it("a sounder by any of its names", () => {
    for (const q of ["speaker", "piezo", "buzzer", "beeper"]) expect(registry.find((d) => d.id === first(q))?.category, q).toBe("sound")
  })

  it("every STM32 board and chip by the family's name, the boards first", () => {
    const stm32 = registry.filter((d) => d.id.startsWith("stm32f") || (d.category === "boards" && !d.id.startsWith("arduino")))
    const found = ids("stm32")
    expect(found.slice(0, stm32.length).sort()).toEqual(stm32.map((d) => d.id).sort())
  })

  it("the board before its chip when both carry the number", () => {
    const found = ids("f429")
    expect(found.indexOf("nucleo-f429zi")).toBeLessThan(found.indexOf("stm32f429zi"))
  })

  it("a part whatever the case, spacing or punctuation", () => {
    expect(first("ky 040")).toBe("ky-040")
    expect(first("128x64")).toBe("oled-ssd1306-i2c")
    expect(first("128×64")).toBe("oled-ssd1306-i2c")
    expect(first("  Resistor  ")).toBe("resistor")
  })

  it("nothing for nonsense, and no part for an empty query", () => {
    expect(ids("qqzzxx")).toEqual([])
    expect(ids("")).toEqual([])
    expect(ids("   ")).toEqual([])
  })

  it("only parts that match every word", () => {
    for (const h of searchParts(registry, "oled spi")) expect(h.def.id).toBe("oled-ssd1306-spi")
  })
})

describe("a typo", () => {
  it.each([
    ["ressistor", "resistor"],
    ["resistr", "resistor"],
    ["capasitor", "capacitor"],
    ["potentiometr", "potentiometer"],
    ["transfromer", "transformer"],
  ])("%s → %s", (query, id) => {
    expect(first(query)).toBe(id)
  })

  it("is forgiven only when nothing matches as typed", () => {
    // "lad" is one edit from "led", but "ladder" or any word holding it would match as typed first;
    // a short word is never corrected: too many parts are one edit away.
    expect(ids("lad")).toEqual([])
    const hits = searchParts(registry, "ressistor")
    expect(hits[0].corrected).toBe(true)
    expect(searchParts(registry, "resistor")[0].corrected).toBe(false)
  })
})

describe("every part", () => {
  it("comes first for its own name", () => {
    for (const def of registry) expect.soft(first(def.name), `"${def.name}"`).toBe(def.id)
  })

  it("is found by each of its keywords, behind only parts that carry the same word", () => {
    const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
    const owns = (id: string, k: string) => {
      const d = registry.find((x) => x.id === id)!
      return fold(d.name).includes(fold(k)) || (d.keywords ?? []).some((w) => fold(w).includes(fold(k)))
    }
    for (const def of registry)
      for (const k of def.keywords ?? []) {
        const found = ids(k)
        const at = found.indexOf(def.id)
        expect.soft(at, `${def.id}: "${k}" does not find it`).toBeGreaterThanOrEqual(0)
        const ahead = found.slice(0, Math.max(at, 0)).filter((id) => !owns(id, k))
        expect.soft(ahead, `${def.id}: "${k}" ranks parts without it first`).toEqual([])
      }
  })
})

describe("a hit", () => {
  it("marks the matched letters of the name", () => {
    const hit = searchParts(registry, "pot")[0]
    expect(hit.ranges).toEqual([[0, 3]])
    const lcd = searchParts(registry, "lcd i2c")[0]
    expect(lcd.ranges.map(([a, b]) => lcd.def.name.slice(a, b))).toEqual(["LCD", "I²C"])
  })

  it("names the keyword that found it when the name does not say", () => {
    expect(searchParts(registry, "rheostat")[0].matched).toBe("rheostat")
    expect(searchParts(registry, "MB1137")[0].matched).toBe("MB1137")
    expect(searchParts(registry, "resistor")[0].matched).toBeUndefined()
    expect(searchParts(registry, "lcd i2c")[0].matched).toBeUndefined()
  })
})

describe("tools that are not parts", () => {
  it("point to where they live", () => {
    expect(toolHints("oscilloscope").map((t) => t.where)).toEqual(["Simulate → Oscilloscope"])
    expect(toolHints("scope").map((t) => t.where)).toEqual(["Simulate → Oscilloscope"])
    expect(toolHints("logic analyzer").map((t) => t.where)).toEqual(["Simulate → Logic analyser"])
    expect(toolHints("resistor")).toEqual([])
  })
})
