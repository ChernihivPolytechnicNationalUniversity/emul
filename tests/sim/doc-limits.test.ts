import { describe, expect, it } from "vitest"
import { allDefs, getDef } from "@/schematic/registry"
import { hasDatasheet } from "@/schematic/datasheets"
import type { ComponentDef, DocKind, DocRecord } from "@/schematic/types"

/**
 * How many documents a part cites, of which kinds, and which comes first (the one its card links).
 * Numbers from the 2026-11-04 study: makers' document sets (ST: datasheet, reference manual,
 * errata, core manual; boards: user manual and schematic; Arduino: datasheet, schematics, pinout),
 * KiCad's one Datasheet field (docs[0]), and the Part tab, where about 8 lines is the most before
 * the list becomes a wall.
 */

type Rule = { min: number; max: number; required: readonly (readonly DocKind[])[]; first: readonly DocKind[] }

const DATASHEET_FIRST: readonly DocKind[] = ["datasheet", "catalogue"]
const SIMPLE: Rule = { min: 1, max: 3, required: [["datasheet", "catalogue"]], first: DATASHEET_FIRST }

function ruleOf(def: ComponentDef): Rule {
  if (def.category === "mcus") {
    // ST and Microchip's PIC16 publish a reference (family) manual; Microchip's AVR does not.
    const reference = def.id.startsWith("stm32") || def.id.startsWith("pic") ? [["referenceManual"] as const] : []
    return { min: 3, max: 6, required: [["datasheet"], ["errata"], ["coreManual"], ...reference], first: ["datasheet"] }
  }
  if (def.category === "boards") return { min: 3, max: 8, required: [["userManual"], ["schematic"]], first: ["userManual"] }
  if (def.category === "displays") return { min: 1, max: 5, required: [["datasheet"]], first: ["datasheet"] }
  if (def.category === "leds") {
    // A module (stick, ring, matrix) cites its own page and the LED it is made of.
    if (/^led-(stick|ring|matrix)/.test(def.id)) return { min: 2, max: 4, required: [["productPage", "userManual"], ["datasheet"]], first: ["datasheet"] }
    return { min: 1, max: 5, required: [["datasheet"]], first: ["datasheet"] }
  }
  if (def.category === "power" && def.id === "lx-lcbst") return { ...SIMPLE, max: 4 }
  return SIMPLE
}

/** Sources of a part with no datasheet: an ideal element or a tool may cite one; a generic part names the real ones it follows. */
const SOURCES: Record<"ideal" | "tool" | "generic", readonly [number, number]> = { ideal: [0, 1], tool: [0, 1], generic: [1, 4] }

/**
 * Parts whose documents are not yet within the rules. Only shrinks: a part brought within them comes
 * off (the test fails until it does), and no part joins.
 */
const PENDING = new Set<string>([])

function problems(def: ComponentDef): string[] {
  const record = def.datasheet
  if (!record) return ["no datasheet record"]
  const out: string[] = []
  if (!hasDatasheet(record)) {
    const [lo, hi] = SOURCES[record.basis]
    const n = record.sources?.length ?? 0
    if (n < lo || n > hi) out.push(`${record.basis}: ${n} sources, wants ${lo}–${hi}`)
    return out
  }
  const rule = ruleOf(def)
  const docs: readonly DocRecord[] = record.docs
  if (docs.length < rule.min || docs.length > rule.max) out.push(`${docs.length} documents, wants ${rule.min}–${rule.max}`)
  for (const anyOf of rule.required) if (!docs.some((d) => anyOf.includes(d.kind))) out.push(`no ${anyOf.join(" or ")}`)
  if (!rule.first.includes(docs[0].kind)) out.push(`first is a ${docs[0].kind}, wants ${rule.first.join(" or ")}`)
  // A board cites its MCU's datasheet: the one the board card links beside the manual.
  if (def.board) {
    const chip = getDef(def.board.mcu.toLowerCase())?.datasheet
    const chipDoc = hasDatasheet(chip) ? chip.docs[0] : undefined
    if (chipDoc && !docs.some((d) => d.key === chipDoc.key)) out.push(`no ${chipDoc.id}, its MCU's datasheet`)
  }
  return out
}

describe("each part cites the documents it needs, and no wall of them", () => {
  it("is within its rules, or still on the pending list", () => {
    for (const def of allDefs()) if (!PENDING.has(def.id)) expect.soft(problems(def), `${def.id} (${def.category})`).toEqual([])
  })

  it("comes off the pending list once within its rules (the list only shrinks)", () => {
    for (const id of PENDING) {
      const def = allDefs().find((d) => d.id === id)
      expect.soft(def, `PENDING names ${id}, which is no part`).toBeDefined()
      if (def) expect.soft(problems(def).length, `${id} is within its rules now: take it off PENDING`).toBeGreaterThan(0)
    }
  })
})
