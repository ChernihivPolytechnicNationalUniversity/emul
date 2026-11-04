import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { allDefs } from "@/schematic/registry"
import { DOCS, hasDatasheet } from "@/schematic/datasheets"
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
  "open746i-c", "nucleo-f429zi", "stm32f4-discovery", "olimex-stm32-h405", "netduino-plus-2", "weact-blackpill-f411",
  "weact-blackpill-f401ce", "weact-blackpill-f401cc", "arduino-uno", "arduino-nano", "stm32f746ig", "stm32f429zi",
  "stm32f407vg", "stm32f405rg", "stm32f411ce", "stm32f401ce", "stm32f401cc", "atmega328p",
  "atmega328p-au", "pic16f627", "pic16f627-04", "pic16f628", "pic16f628-04", "pic16lf627",
  "pic16lf628", "pic16f627a", "pic16f628a", "pic16f648a", "pic16lf627a", "pic16lf628a",
  "pic16lf648a", "resonator", "eeprom-24c", "hc595", "hct595", "ne555",
  "opamp-lm358", "opamp-lm741", "opamp-tl072", "opamp-mcp6002", "opamp-lmv358", "lcd7-f",
  "buzzer-cem-1203-42", "buzzer-at-1224-twt-5v-2", "buzzer-cmt-0904-83t", "buzzer-tmb12a05", "buzzer-sdc1610m5-01", "buzzer-cmi-9650c-030",
  "buzzer-pkm13epyh4000-a0", "buzzer-pkm17epp-2002-b0", "buzzer-pkb24spch3601-b0", "ws2812b", "ws2812", "ws2812-6pin",
  "ws2812s", "ws2812a", "ws2812c", "ws2812d", "ws2812e", "sk6812",
  "sk6812rgbw", "ws2813", "ws2813b", "ws2813b-rgbw", "ws2815", "ws2815b",
  "ws2815b-4pin", "ws2816", "ws2916", "ws2916a-rgbw", "led-stick-8", "led-ring-12",
  "led-ring-16", "led-ring-24", "led-matrix-8x8", "ws2811", "ws2913", "ws2818",
  "ws2814", "ws2814b", "ws2805", "ws2914", "ws2915", "ws2801",
  "lx-lcbst", "tp4056", "dw03", "mt3608", "ncp1117", "lp2985",
  "voltmeter", "ammeter", "polyfuse", "rgb-led", "seven-segment-ca", "seven-segment-cc",
  "seven-segment-4-ca", "seven-segment-4-cc", "keypad-4x4", "encoder-ec11", "ky-040", "servo-sg90",
  "lcd-1602", "lcd-1602-i2c", "oled-ssd1306-i2c", "oled-ssd1306-i2c-32", "oled-ssd1306-spi",
])
const PENDING_MAX = 107

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
      expect.soft(doc.url, key).toMatch(/^https:\/\//)
      if (doc.archive) expect.soft(doc.archive, key).toMatch(/^https:\/\/web\.archive\.org\//)
      expect.soft(doc.checked, key).toMatch(ISO_DAY)
      expect.soft(doc.id.trim(), key).not.toBe("")
    }
    const used = new Set<string>()
    for (const def of allDefs()) {
      const record = def.datasheet
      if (!hasDatasheet(record)) continue
      for (const key of record.docs) {
        used.add(key)
        expect.soft(DOCS[key], `${def.id} cites ${key}, which DOCS does not list`).toBeDefined()
      }
      const cites = [...record.specs.map((s) => s.cite), ...record.modelled.map((c) => c.cite), ...record.notModelled.map((c) => c.cite)]
      for (const cite of cites) if (cite?.doc) expect.soft(record.docs, `${def.id} cites ${cite.doc} without listing it`).toContain(cite.doc)
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

  it("hold the on-board chips' not-modelled lists, one source for the card and the model", () => {
    const notModelled = (id: string) => (allDefs().find((d) => d.id === id)?.datasheet?.notModelled ?? []).map((c) => c.what)
    // Checked once the board's record is written (a pending board has none to hold them yet).
    const boards: [string, string[]][] = [
      ["stm32f4-discovery", [...LIS, ...CS43L22, ...MP45DT02]],
      ["netduino-plus-2", ENC28J60],
    ]
    for (const [board, lists] of boards) if (!PENDING.has(board)) for (const what of lists) expect.soft(notModelled(board), what).toContain(what)
  })
})
