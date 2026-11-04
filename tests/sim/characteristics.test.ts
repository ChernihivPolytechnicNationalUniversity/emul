import { describe, expect, it } from "vitest"
import { allDefs } from "@/schematic/registry"
import { hasDatasheet } from "@/schematic/datasheets"
import { type Characteristic, type Condition, formatCharacteristic, formatCondition, formatValue, formatNumber, KINDS, type Level, QUANTITIES } from "@/schematic/characteristics"

/**
 * The characteristics are a closed system: the registry (KINDS, QUANTITIES) holds every label,
 * unit, glyph, visual and rule; a part's record holds only the kind, numbers, conditions and page.
 * These tests hold every record to that, and ratchet the parts still on free-text specs down to none.
 */

// Parts with a datasheet record still on the old free-text `specs`. Only shrinks: lower the max with it.
const ON_FREE_TEXT_MAX = 0

const ALLOWED_KEYS = new Set(["kind", "value", "set", "limit", "at", "per", "colour", "cite", "limitCite"])
const VALUE_KEYS = new Set(["min", "typ", "max", "sym", "release", "approx"])
const LIMIT_KEYS = new Set(["min", "max", "sym"])
const CONDITION_KEYS = new Set(["supply", "sym", "vin", "temp", "load", "freq", "distance", "path", "state"])

const records = () =>
  allDefs().flatMap((def) => (hasDatasheet(def.datasheet) ? [{ def, record: def.datasheet }] : []))

const isLevel = (l: unknown): l is Level => typeof l === "number" ? Number.isFinite(l) : !!l && typeof l === "object" && "rail" in l
const num = (l: Level | undefined) => (typeof l === "number" ? l : undefined)

describe("characteristic text (reference strings first)", () => {
  it.each<[string, string]>([
    [formatValue({ min: 2, max: 6 }, "voltage"), "2–6 V"],
    [formatValue({ min: 3.15 }, "voltage"), "≥ 3.15 V"],
    [formatValue({ max: 25e6 }, "frequency"), "≤ 25 MHz"],
    [formatValue({ max: 6e-3, sym: true }, "current"), "±6 mA"],
    [formatValue({ min: 10, max: 18, sym: true }, "voltage"), "±10–18 V"],
    [formatValue({ typ: 17e-9 }, "time"), "17 ns"],
    [formatValue({ typ: 4.3, release: 4.1 }, "voltage"), "4.3 ↘ 4.1 V"],
    [formatValue({ typ: { rail: "VCC", offset: -1.7 } }, "voltage"), "VCC − 1.7 V"],
    [formatValue({ typ: { rail: "VCC", times: 2 / 3 } }, "voltage"), "⅔ VCC"],
    [formatValue({ min: 4.5, max: 16 }, "voltage"), "4.5–16 V"],
    [formatValue({ min: -0.3, max: 4 }, "voltage"), "−0.3 to 4 V"],
    [formatNumber(400e3, "frequency"), "400 kHz"],
    [formatNumber(630e-9, "wavelength"), "630 nm"],
    [formatNumber(0x3c, "address"), "0x3C"],
    [formatNumber(32768, "memory"), "32 KB"],
    [formatNumber(224, "memory"), "224 B"],
    [formatNumber(3584, "memory"), "3.5 KB"],
    [formatNumber(196608, "memory"), "192 KB"],
    [formatNumber(1048576, "memory"), "1 MB"],
    [formatCharacteristic({ kind: "address", set: [0x3c, 0x3d], cite: { page: 1 } }), "0x3C │ 0x3D"],
    [formatCharacteristic({ kind: "address", set: [0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f], cite: { page: 1 } }), "0x20–0x27 │ 0x38–0x3F"],
    [formatCondition({ supply: 4.5 }), "4.5 V"],
    [formatCondition({ load: { ohms: 2000 } }), "→ 2 kΩ"],
    [formatCondition({ path: ["RCLK", "QA"] }), "RCLK→QA"],
  ])("%s is %s", (got, want) => expect(got).toBe(want))
})

describe("the registry", () => {
  it("labels every kind in at most two words, in a known quantity", () => {
    for (const [id, k] of Object.entries(KINDS)) {
      expect.soft(k.label.trim().split(/\s+/).length, `${id}: "${k.label}"`).toBeLessThanOrEqual(2)
      expect.soft(QUANTITIES[k.quantity], `${id}: quantity ${k.quantity}`).toBeDefined()
    }
  })

  it("keeps labels unique, so two kinds never read the same", () => {
    const labels = Object.values(KINDS).map((k) => k.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe("every characteristic", () => {
  it("holds only numbers, conditions and its page: no text, no style", () => {
    for (const { def, record } of records())
      for (const c of record.characteristics ?? []) {
        const where = `${def.id} ${c.kind}`
        for (const key of Object.keys(c)) expect.soft(ALLOWED_KEYS.has(key), `${where}: field "${key}" is not part of a characteristic`).toBe(true)
        for (const key of Object.keys(c.value ?? {})) expect.soft(VALUE_KEYS.has(key), `${where}: value field "${key}"`).toBe(true)
        for (const key of Object.keys(c.limit ?? {})) expect.soft(LIMIT_KEYS.has(key), `${where}: limit field "${key}"`).toBe(true)
        for (const cond of c.at ?? []) for (const key of Object.keys(cond)) expect.soft(CONDITION_KEYS.has(key), `${where}: condition "${key}"`).toBe(true)
      }
  })

  it("is a registered kind with a value of the shape that kind allows", () => {
    for (const { def, record } of records())
      for (const c of record.characteristics ?? []) {
        const where = `${def.id} ${c.kind}`
        const k = KINDS[c.kind] as (typeof KINDS)[keyof typeof KINDS] & { limit?: true; rail?: true; hysteresis?: true; set?: true }
        expect.soft(k, `${where}: no such kind`).toBeDefined()
        if (!k) continue
        if (k.set) {
          expect.soft(c.set?.length, `${where}: a set kind lists its alternatives`).toBeGreaterThan(0)
          expect.soft(c.value, `${where}: a set kind has no range`).toBeUndefined()
        } else {
          expect.soft(c.set, `${where}: only a set kind lists alternatives`).toBeUndefined()
          expect.soft(!!c.value || !!c.limit, `${where}: a value or a limit`).toBe(true)
        }
        const v = c.value
        if (v) {
          const levels = [v.min, v.typ, v.max].filter((l) => l !== undefined)
          expect.soft(levels.length, `${where}: at least one of min, typ, max`).toBeGreaterThan(0)
          for (const l of levels) {
            expect.soft(isLevel(l), `${where}: ${JSON.stringify(l)} is not a number or a rail level`).toBe(true)
            if (typeof l === "object") expect.soft(k.rail, `${where}: only a rail kind takes a rail level`).toBe(true)
          }
          const [lo, ty, hi] = [num(v.min), num(v.typ), num(v.max)]
          if (lo !== undefined && hi !== undefined) expect.soft(lo, `${where}: min ≤ max`).toBeLessThanOrEqual(hi)
          if (lo !== undefined && ty !== undefined) expect.soft(lo, `${where}: min ≤ typ`).toBeLessThanOrEqual(ty)
          if (ty !== undefined && hi !== undefined) expect.soft(ty, `${where}: typ ≤ max`).toBeLessThanOrEqual(hi)
          if (v.release !== undefined) {
            expect.soft(k.hysteresis, `${where}: only a hysteresis kind releases`).toBe(true)
            expect.soft(v.typ, `${where}: a release goes with the trip value (typ)`).toBeDefined()
          }
          if (v.sym) expect.soft(v.max, `${where}: ± is given by its max`).toBeDefined()
        }
        if (c.limit) {
          expect.soft(k.limit, `${where}: only a kind with a limit takes an abs max`).toBe(true)
          const lim = num(c.limit.max)
          const top = v ? (num(v.max) ?? num(v.typ)) : undefined
          if (lim !== undefined && top !== undefined) expect.soft(Math.abs(top), `${where}: the value sits inside its abs max`).toBeLessThanOrEqual(Math.abs(lim))
        }
      }
  })

  it("says where the datasheet gives it", () => {
    for (const { def, record } of records())
      for (const c of record.characteristics ?? []) {
        expect.soft(!!(c.cite.page || c.cite.at), `${def.id} ${c.kind}: page or section`).toBe(true)
        const keys = record.docs.map((d) => d.key)
        for (const cite of [c.cite, c.limitCite]) if (cite?.doc) expect.soft(keys, `${def.id} ${c.kind} cites ${cite.doc}`).toContain(cite.doc)
      }
  })

  it("names pins that the part has, in a path condition", () => {
    for (const { def, record } of records()) {
      const names = new Set(def.pins.flatMap((p) => [p.id, p.label].filter(Boolean) as string[]))
      for (const c of record.characteristics ?? [])
        for (const cond of (c.at ?? []) as Condition[])
          if ("path" in cond) for (const pin of cond.path) expect.soft(names.has(pin), `${def.id} ${c.kind}: no pin "${pin}"`).toBe(true)
    }
  })

  it("keeps a part to eight rows, one per kind and colour", () => {
    for (const { def, record } of records()) {
      const rows = record.characteristics ?? []
      expect.soft(rows.length, `${def.id}: at most 8`).toBeLessThanOrEqual(8)
      const keys = rows.map((c: Characteristic) => `${c.kind}/${c.colour ?? ""}/${JSON.stringify(c.at ?? [])}`)
      expect.soft(new Set(keys).size, `${def.id}: a kind twice under the same conditions`).toBe(keys.length)
    }
  })
})

describe("nothing left behind", () => {
  it("moves parts off free-text specs, and never back", () => {
    const left = records().filter(({ record }) => record.specs.length > 0)
    expect(left.length, `still on free text: ${left.map(({ def }) => def.id).join(", ")}`).toBeLessThanOrEqual(ON_FREE_TEXT_MAX)
    for (const { def, record } of records())
      if (record.characteristics?.length) expect.soft(record.specs, `${def.id}: drop the free-text specs it replaced`).toEqual([])
  })

  it("gives every IC its supply, every LED its forward voltage, once the part is typed", () => {
    const REQUIRED: Partial<Record<string, readonly (keyof typeof KINDS)[]>> = {
      ics: ["supply"],
      displays: ["supply"],
      leds: ["forwardVoltage"],
      mcus: ["supply"],
    }
    for (const { def, record } of records()) {
      if (!record.characteristics?.length) continue
      for (const kind of REQUIRED[def.category] ?? []) expect.soft(record.characteristics.map((c) => c.kind), `${def.id} (${def.category}) needs ${kind}`).toContain(kind)
    }
  })
})
