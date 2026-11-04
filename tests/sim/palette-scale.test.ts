import { describe, expect, it } from "vitest"
import { catalogue, type PartMeta } from "@/schematic/registry"
import { searchParts } from "@/components/palette/search"
import { hitEntries } from "@/components/palette/items"
import { WINDOW_FROM } from "@/components/palette/VirtualRows"

/** A catalogue of 2000 parts: today's, again and again under new part numbers. */
const synthetic: PartMeta[] = Array.from({ length: 2000 }, (_, i) => {
  const m = catalogue[i % catalogue.length]
  const n = Math.floor(i / catalogue.length)
  return n === 0 ? m : { ...m, id: `${m.id}-x${n}`, name: `${m.name} X${n}`, keywords: [...(m.keywords ?? []), `PN${1000 + i}`] }
})

const QUERIES = ["r", "res", "resistor", "led", "lcd i2c", "stm32", "ws2812", "regulator 3.3", "ressistor", "PN1999", "qqzzxx"]

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

describe("the palette with 2000 parts", () => {
  // The budget is a frame: the field takes the letters at once and the results follow (useDeferredValue).
  it("searches as fast as one types: a query in less than a frame", () => {
    searchParts(synthetic, "warm the index")
    const times: number[] = []
    for (let round = 0; round < 5; round++)
      for (const q of QUERIES) {
        const t = performance.now()
        hitEntries(searchParts(synthetic, q))
        times.push(performance.now() - t)
      }
    console.log(`2000 parts: median ${median(times).toFixed(2)} ms, worst ${Math.max(...times).toFixed(2)} ms per query`)
    expect(median(times)).toBeLessThan(16)
  })

  it("finds a part by its own number among them", () => {
    expect(searchParts(synthetic, "PN1999")[0].def.id).toBe(synthetic[999].id)
  })

  it("draws a long result list in a window, a short one whole", () => {
    expect(hitEntries(searchParts(synthetic, "r")).length).toBeGreaterThan(WINDOW_FROM)
    expect(hitEntries(searchParts(catalogue, "ws2812")).length).toBeLessThan(WINDOW_FROM)
  })
})
