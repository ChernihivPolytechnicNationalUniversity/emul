import { describe, expect, it } from "vitest"
import { allDefs } from "@/schematic/registry"
import { hasDatasheet } from "@/schematic/datasheets"
import { formatNumber, type KindId, type Level } from "@/schematic/characteristics"
import type { ComponentDef } from "@/schematic/types"

/**
 * How much each part says about itself: characteristics, modelled and not-modelled claims, each
 * between a floor (enough to know the part) and a ceiling (what the Part tab shows without becoming
 * a wall). Numbers from the 2026-11-04 study (datasheet front pages carry 4–9 headline numbers, a
 * board's spec table about 12, Wokwi describes a board in about 13 rows; working memory about 4
 * chunks, Cowan 2001). A board's claims about its on-board chips (`part`) are not counted: they fold.
 */

type Range = readonly [min: number, max: number]
type Limits = { characteristics: Range; modelled: Range; notModelled: Range; required?: readonly KindId[] }

const DATASHEET: Limits = { characteristics: [4, 8], modelled: [3, 12], notModelled: [2, 10] }
const BY_CATEGORY: Partial<Record<string, Limits>> = {
  boards: { characteristics: [6, 8], modelled: [6, 12], notModelled: [4, 10], required: ["clock", "flash", "ram", "ioLevel", "input", "ioPins"] },
  mcus: { characteristics: [6, 8], modelled: [6, 12], notModelled: [3, 10], required: ["supply", "clock", "flash", "ram", "ioPins", "pinCurrent", "temperature"] },
  ics: { characteristics: [4, 8], modelled: [4, 12], notModelled: [3, 10] },
  displays: { characteristics: [4, 8], modelled: [4, 12], notModelled: [3, 10] },
}
/** A part that is not one product (an ideal source, a generic resistor): no numbers of its own. */
const NO_DATASHEET: Limits = { characteristics: [0, 0], modelled: [1, 6], notModelled: [1, 6] }
/** Nothing to leave out of a node. */
const NOTHING_LEFT_OUT = new Set(["ground", "junction"])

/**
 * Parts not yet within their limits. The list only shrinks: a part brought within its limits comes
 * off it (the test fails until it does), and no part may join it.
 */
const PENDING = new Set<string>([
  // MCUs
  "atmega328p", "atmega328p-au", "pic16f627", "pic16f627-04", "pic16f627a", "pic16f628", "pic16f628-04", "pic16f628a", "pic16f648a", "pic16lf627", "pic16lf627a", "pic16lf628", "pic16lf628a", "pic16lf648a",
  "stm32f401cc", "stm32f401ce", "stm32f405rg", "stm32f407vg", "stm32f411ce", "stm32f429zi", "stm32f746ig",
  // addressable LEDs
  "led-matrix-8x8", "led-ring-12", "led-ring-16", "led-ring-24", "led-stick-8", "sk6812", "sk6812rgbw", "ws2801", "ws2805", "ws2811", "ws2812", "ws2812-6pin", "ws2812a", "ws2812b", "ws2812c", "ws2812d", "ws2812e",
  "ws2812s", "ws2813", "ws2813b", "ws2813b-rgbw", "ws2814", "ws2814b", "ws2815", "ws2815b", "ws2815b-4pin", "ws2816", "ws2818", "ws2913", "ws2914", "ws2915", "ws2916", "ws2916a-rgbw",
])

const num = (l: Level | undefined) => (typeof l === "number" ? l : undefined)

/** What is wrong with a part's record against its limits; empty when it is within them. */
function problems(def: ComponentDef): string[] {
  const record = def.datasheet
  if (!record) return ["no datasheet record"]
  const sheet = hasDatasheet(record) ? record : undefined
  const limits = sheet ? (BY_CATEGORY[def.category] ?? DATASHEET) : NO_DATASHEET
  const own = (claims: readonly { part?: string }[]) => (def.category === "boards" ? claims.filter((c) => !c.part) : claims)
  const out: string[] = []
  const check = (what: string, n: number, [lo, hi]: Range, floor = lo) => {
    if (n < floor || n > hi) out.push(`${what} ${n}, wants ${lo}–${hi}`)
  }
  const rows = sheet?.characteristics ?? []
  check("characteristics", rows.length, limits.characteristics)
  check("modelled", own(record.modelled).length, limits.modelled)
  check("not modelled", own(record.notModelled).length, limits.notModelled, NOTHING_LEFT_OUT.has(def.id) ? 0 : limits.notModelled[0])
  for (const kind of limits.required ?? []) if (!rows.some((c) => c.kind === kind)) out.push(`no ${kind}`)

  // A board's card and its characteristics are one truth.
  const board = def.board
  if (board && rows.length) {
    const top = (kind: KindId) => {
      const v = rows.find((c) => c.kind === kind)?.value
      return v && (num(v.max) ?? num(v.typ) ?? num(v.min))
    }
    const clock = top("clock")
    if (clock !== undefined && Math.abs(clock - board.mhz * 1e6) > 1) out.push(`card says ${board.mhz} MHz, clock ${clock / 1e6} MHz`)
    const level = top("ioLevel")
    if (level !== undefined && Math.abs(level - board.volts) > 1e-6) out.push(`card says ${board.volts} V, logic level ${level} V`)
    const memory = [top("flash"), top("ram")].map((b) => (b === undefined ? "?" : formatNumber(b, "memory"))).join(" / ")
    if (board.memory && memory !== board.memory) out.push(`card says ${board.memory}, characteristics ${memory}`)
    // Everything the card says is on the board is either modelled or said not to be.
    const said = [...record.modelled, ...record.notModelled].map((c) => `${c.part ?? ""} ${c.what}`.toLowerCase()).join(" | ")
    for (const item of board.onBoard) {
      const words = item.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w))
      if (words.length && !words.some((w) => said.includes(w))) out.push(`on board "${item}" is in neither list`)
    }
  }
  return out
}

describe("each part says enough about itself, and not too much", () => {
  it("is within its limits, or still on the pending list", () => {
    for (const def of allDefs()) {
      const wrong = problems(def)
      if (PENDING.has(def.id)) continue
      expect.soft(wrong, `${def.id} (${def.category})`).toEqual([])
    }
  })

  it("comes off the pending list once within its limits (the list only shrinks)", () => {
    const ids = new Set(allDefs().map((d) => d.id))
    for (const id of PENDING) {
      expect.soft(ids.has(id), `PENDING names ${id}, which is no part`).toBe(true)
      const def = allDefs().find((d) => d.id === id)
      if (def) expect.soft(problems(def).length, `${id} is within its limits now: take it off PENDING`).toBeGreaterThan(0)
    }
  })
})
