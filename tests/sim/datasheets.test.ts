import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { allDefs } from "@/schematic/registry"
import { CLAIM_WORDS, hasDatasheet } from "@/schematic/datasheets"
import { DOCS } from "@/schematic/datasheets/docs"
import { NOT_MODELLED as LIS } from "@/sim/lis-accel"
import { NOT_MODELLED as CS43L22 } from "@/sim/cs43l22"
import { NOT_MODELLED as MP45DT02 } from "@/sim/mp45dt02"
import { NOT_MODELLED as ENC28J60 } from "@/sim/enc28j60"

/**
 * Parts whose datasheet record is still to be written. The list only shrinks: a new part comes
 * with its record (or `none` and why), and a record written takes its part off here. PENDING_MAX
 * is the ratchet: lower it with the list, never raise it.
 */
const PENDING = new Set<string>([
])
const PENDING_MAX = 0

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

describe("datasheet records", () => {
  it("every part has one, says why it has none, or is still pending (and the pending only shrink)", () => {
    expect(PENDING.size, "PENDING may only shrink: lower PENDING_MAX with it").toBeLessThanOrEqual(PENDING_MAX)
    for (const def of allDefs()) {
      if (PENDING.has(def.id)) expect.soft(def.datasheet, `${def.id} has a record now: take it off PENDING`).toBeUndefined()
      else expect.soft(def.datasheet, `${def.id}: write its datasheet record, or { none: why }`).toBeDefined()
    }
    const ids = new Set(allDefs().map((d) => d.id))
    for (const id of PENDING) expect.soft(ids.has(id), `PENDING names ${id}, which is no part`).toBe(true)
  })

  it("cite documents that are listed, linked over https and checked on a date", () => {
    for (const [key, doc] of Object.entries(DOCS)) {
      expect.soft(doc.key, `DOCS.${key} is keyed by its own key`).toBe(key)
      expect.soft(doc.url, key).toMatch(/^https:\/\//)
      if (doc.archive) expect.soft(doc.archive, key).toMatch(/^https:\/\/web\.archive\.org\//)
      expect.soft(doc.checked, key).toMatch(ISO_DAY)
      expect.soft(doc.id.trim(), key).not.toBe("")
    }
    const used = new Set<string>()
    for (const def of allDefs()) {
      const record = def.datasheet
      if (record && !hasDatasheet(record)) for (const doc of record.sources ?? []) used.add(doc.key)
      if (!hasDatasheet(record)) continue
      for (const doc of record.docs) {
        used.add(doc.key)
        expect.soft(DOCS[doc.key], `${def.id} cites ${doc.key}, which is not one of DOCS`).toBe(doc)
      }
      const keys = record.docs.map((d) => d.key)
      const cites = [...record.specs.map((s) => s.cite), ...record.modelled.map((c) => c.cite), ...record.notModelled.map((c) => c.cite)]
      for (const cite of cites) if (cite?.doc) expect.soft(keys, `${def.id} cites ${cite.doc} without listing it`).toContain(cite.doc)
    }
    for (const key of Object.keys(DOCS)) expect.soft(used.has(key), `${key} is cited by no part`).toBe(true)
  })

  it("give each number its page or section, a handful of them", () => {
    for (const def of allDefs()) {
      const record = def.datasheet
      if (!hasDatasheet(record)) continue
      expect.soft(record.specs.length, `${def.id}: at most 8 key numbers`).toBeLessThanOrEqual(8)
      for (const s of record.specs) expect.soft(!!(s.cite.page || s.cite.at), `${def.id} ${s.label}: where does the datasheet give it?`).toBe(true)
      expect.soft(record.maker.trim(), def.id).not.toBe("")
    }
  })

  it("say why a part has none, in a sentence", () => {
    for (const def of allDefs()) {
      const record = def.datasheet
      if (!record || hasDatasheet(record)) continue
      expect.soft(record.none.length, `${def.id}: say why there is no datasheet`).toBeGreaterThanOrEqual(15)
      expect.soft(record.none, def.id).not.toMatch(/TODO|TBD/i)
    }
  })

  it("name tests that exist, and claims that are not blank", () => {
    for (const def of allDefs()) {
      const record = def.datasheet
      if (!record) continue
      for (const c of [...record.modelled, ...record.notModelled]) {
        expect.soft(c.what.trim(), def.id).not.toBe("")
        if (c.test) expect.soft(existsSync(c.test), `${def.id}: ${c.test} does not exist`).toBe(true)
      }
    }
  })

  it("say each claim in one sentence of five words at most", () => {
    for (const def of allDefs()) {
      const record = def.datasheet
      if (!record) continue
      for (const c of [...record.modelled, ...record.notModelled]) {
        const what = c.what.trim()
        expect.soft(what.split(/\s+/).length, `${def.id}: "${what}" is over ${CLAIM_WORDS} words`).toBeLessThanOrEqual(CLAIM_WORDS)
        expect.soft(what, `${def.id}: "${what}" is more than one sentence`).not.toMatch(/[.;:!?]\s|—/)
      }
    }
  })

  it("describe each part in one sentence of five words at most", () => {
    for (const def of allDefs()) {
      const what = def.description?.trim()
      if (!what) continue
      expect.soft(what.split(/\s+/).length, `${def.id}: "${what}" is over ${CLAIM_WORDS} words`).toBeLessThanOrEqual(CLAIM_WORDS)
      expect.soft(what, `${def.id}: "${what}" is more than one sentence`).not.toMatch(/[.;:!?]\s|—|\.$/)
    }
  })

  it("keep each reference note to one sentence of five words at most, and the old model notes off parts with a record", () => {
    const recordKeys = ["Modelled", "Not modelled", "Source", "Datasheet"]
    for (const def of allDefs()) {
      for (const [key, note] of Object.entries(def.info ?? {})) {
        if (recordKeys.includes(key)) {
          expect.soft(def.datasheet, `${def.id}: "${key}" belongs in its datasheet record now`).toBeUndefined()
          if (key === "Source" || key === "Datasheet") continue
        }
        const what = note.trim()
        expect.soft(what.split(/\s+/).length, `${def.id} ${key}: "${what}" is over ${CLAIM_WORDS} words`).toBeLessThanOrEqual(CLAIM_WORDS)
        expect.soft(what, `${def.id} ${key}: "${what}" is more than one sentence`).not.toMatch(/[.;:!?]\s|—/)
      }
    }
  })

  it("hold the on-board chips' not-modelled lists, one source for the card and the model", () => {
    const notModelled = (id: string) => (allDefs().find((d) => d.id === id)?.datasheet?.notModelled ?? []).map((c) => (c.part ? `${c.part}: ${c.what}` : c.what))
    // Checked once the board's record is written (a pending board has none to hold them yet).
    const boards: [string, string[]][] = [
      ["stm32f4-discovery", [...LIS.map((w) => `LIS302DL/LIS3DSH: ${w}`), ...CS43L22.map((w) => `CS43L22: ${w}`), ...MP45DT02.map((w) => `MP45DT02: ${w}`)]],
      ["netduino-plus-2", ENC28J60.map((w) => `ENC28J60: ${w}`)],
    ]
    for (const [board, lists] of boards) if (!PENDING.has(board)) for (const what of lists) expect.soft(notModelled(board), what).toContain(what)
  })
})
