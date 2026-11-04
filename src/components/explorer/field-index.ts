import { getDef, getMeta } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"

// What is on the field, as rows of the explorer, and the field's search: a part by its designator,
// its name, the value it is set to, or one of its pins ("U1 PA5", "D13", "VCC").
//
// Every word typed must match (AND), nothing fuzzy: R1 is not R10, and a slip of a letter finds
// nothing rather than the wrong part. A value matches as a number, however it is spelt: 220, 220Ω,
// 220R and 0.22k are one value; 4k7 is 4.7 kΩ.

export type FieldGroup = "boards" | "chips" | "parts" | "rails"

export const GROUP_LABEL: Record<FieldGroup, string> = { boards: "Boards", chips: "Chips", parts: "Parts", rails: "Ground and rails" }
const GROUP_ORDER: FieldGroup[] = ["boards", "chips", "parts", "rails"]

/** Symbols that are wiring, not parts: a junction is a node of its wires, and lists nothing a student looks for. */
const NOT_LISTED = new Set(["junction"])
/** Ground and supply symbols: on the bench by the dozen, listed last. */
const RAILS = new Set(["ground", "supply"])

/** One object on the field as a row: its designator, what it is, the value it is set to. */
export type FieldEntry = {
  id: string
  ref: string
  name: string
  defId: string
  group: FieldGroup
  /** The value shown beside the name: "220 Ω", "10 µF". */
  value?: string
  /** Every quantity the object is set to, as numbers, for a search by value. */
  numbers: number[]
}

/** A search hit: an object, or one pin of it. */
export type FieldHit = { kind: "object"; object: string; score: number } | { kind: "pin"; object: string; pin: string; label: string; score: number }

const groupOf = (defId: string, category: string | undefined): FieldGroup =>
  RAILS.has(defId) ? "rails" : category === "boards" ? "boards" : category === "mcus" || category === "ics" ? "chips" : "parts"

/** "R2" before "R10": designators compare by their letters, then by their number. */
export function compareRefs(a: string, b: string): number {
  const pa = /^([^\d]*)(\d*)(.*)$/.exec(a)!
  const pb = /^([^\d]*)(\d*)(.*)$/.exec(b)!
  return pa[1].localeCompare(pb[1]) || (Number(pa[2] || 0) - Number(pb[2] || 0)) || pa[3].localeCompare(pb[3])
}

export function fieldEntry(o: PlacedObject): FieldEntry {
  const def = getDef(o.def)
  const meta = def ?? getMeta(o.def)
  const props = { ...def?.defaults, ...o.props }
  const quantities = def?.fields?.filter((f) => f.type === "quantity") ?? []
  const numbers = quantities.map((f) => valueNumber(props[f.key] ?? "")).filter((n) => Number.isFinite(n))
  // The part's own value first (a resistance, an LED's colour), else its first quantity.
  const main = def?.fields?.find((f) => f.key === "value")
  const shown = main?.type === "select" ? main.options.find((x) => x.value === props.value)?.label : main ? props.value : quantities.find((f) => props[f.key]) && props[quantities.find((f) => props[f.key])!.key]
  return {
    id: o.id,
    ref: o.props?.ref ?? "",
    name: meta?.name ?? o.def,
    defId: o.def,
    group: groupOf(o.def, meta?.category),
    value: shown || props.value || undefined,
    numbers,
  }
}

/** Objects as rows, by group (boards, chips, parts), then by designator. */
export function fieldEntries(objects: readonly PlacedObject[]): FieldEntry[] {
  return objects.filter((o) => !NOT_LISTED.has(o.def)).map(fieldEntry).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || compareRefs(a.ref || a.name, b.ref || b.name))
}

const PREFIX: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, r: 1, R: 1 }

/**
 * A value as a number, in any of the spellings on a part or a schematic: "4.7 kΩ", "220R", "4k7",
 * "100nF", "0.1u". NaN for text that is not a value. Units are ignored: 10 µF and 10 µH are both 1e-5.
 */
export function valueNumber(text: string): number {
  const t = text.trim().replace(/\s+/g, "")
  // RKM code: the prefix letter stands for the decimal point ("4k7", "2R2", "1M5").
  const rkm = /^(\d+)([pnuµμmkKMGrR])(\d+)[a-zA-ZΩω]*$/.exec(t)
  if (rkm) return Number(`${rkm[1]}.${rkm[3]}`) * PREFIX[rkm[2]]
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))([pnuµμmkKMGrR])?(?:Ω|ω|ohms?|[a-zA-Z]{0,3})$/.exec(t)
  if (!m) return NaN
  // "m" alone after a number is milli; "M" is mega. "R" is the ohm's place, not a prefix.
  return Number(m[1]) * (m[2] ? PREFIX[m[2]] : 1)
}

const sameNumber = (a: number, b: number) => a === b || Math.abs(a - b) <= Math.abs(b) * 1e-9

/** A word typed into the search: lower case, and as a number when it is a value. */
type Token = { text: string; number: number; designator: boolean }

const tokenize = (query: string): Token[] =>
  query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => ({ text, number: /^[-+.\d]/.test(text) ? valueNumber(text) : NaN, designator: /^[a-z]+\d+$/.test(text) }))

const SCORE = { REF: 100, REF_PREFIX: 80, PIN: 70, PIN_PREFIX: 45, NAME_WORD: 50, NAME: 30, VALUE: 40 } as const

/** How well a word matches the object itself (designator, name, value); 0: not at all. */
function objectScore(t: Token, e: FieldEntry): number {
  const ref = e.ref.toLowerCase()
  if (ref === t.text) return SCORE.REF
  // A whole designator asks for that part: R1 does not find R10.
  if (!t.designator && ref.startsWith(t.text)) return SCORE.REF_PREFIX
  if (Number.isFinite(t.number) && e.numbers.some((n) => sameNumber(n, t.number))) return SCORE.VALUE
  const name = e.name.toLowerCase()
  const at = name.indexOf(t.text)
  if (at === 0 || (at > 0 && !/[a-z0-9]/.test(name[at - 1]))) return SCORE.NAME_WORD
  if (at > 0 && t.text.length >= 3) return SCORE.NAME
  return 0
}

/** The names a pin goes by: its printed label, the MCU pin behind it, the board's signal name. */
function pinNames(pin: { id: string; label: string; mcu?: string; signal?: string }): string[] {
  return [pin.label, pin.mcu, pin.signal, pin.id].filter((n): n is string => !!n).map((n) => n.toLowerCase())
}

/** How well a word matches a pin; a prefix only from two letters, or "g" would find every GND. */
function pinScore(t: Token, names: string[]): number {
  if (names.includes(t.text)) return SCORE.PIN
  if (t.text.length >= 2 && !t.designator && names.some((n) => n.startsWith(t.text))) return SCORE.PIN_PREFIX
  return 0
}

/**
 * Objects and pins that match every word of `query`, best first. A word may name the object
 * ("U1") and another its pin ("PA5"); a hit on a pin needs at least one word that names the pin.
 */
export function searchField(objects: readonly PlacedObject[], query: string, entries: readonly FieldEntry[] = fieldEntries(objects)): FieldHit[] {
  const tokens = tokenize(query)
  if (!tokens.length) return []
  const byId = new Map(objects.map((o) => [o.id, o]))
  const objectHits: FieldHit[] = []
  const pinHits: FieldHit[] = []
  for (const e of entries) {
    const own = tokens.map((t) => objectScore(t, e))
    if (own.every((s) => s > 0)) {
      objectHits.push({ kind: "object", object: e.id, score: own.reduce((a, b) => a + b, 0) })
      continue
    }
    const def = getDef(byId.get(e.id)?.def ?? "")
    if (!def) continue
    for (const pin of def.pins) {
      if (pin.kind === "nc") continue
      const names = pinNames(pin)
      let total = 0
      let onPin = false
      for (let i = 0; i < tokens.length; i++) {
        const p = pinScore(tokens[i], names)
        const s = Math.max(own[i], p)
        if (!s) {
          total = 0
          break
        }
        if (p >= own[i]) onPin = true
        total += s
      }
      if (total && onPin) pinHits.push({ kind: "pin", object: e.id, pin: pin.id, label: pin.label || pin.mcu || pin.id, score: total })
    }
  }
  const order = new Map(entries.map((e, i) => [e.id, i]))
  const byScore = (a: FieldHit, b: FieldHit) => b.score - a.score || order.get(a.object)! - order.get(b.object)!
  return [...objectHits.sort(byScore), ...pinHits.sort(byScore)]
}
