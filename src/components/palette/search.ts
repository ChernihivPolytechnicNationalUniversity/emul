import { CATEGORIES, categoryLabel, isPaletteCategory } from "@/schematic/categories"
import { familyOf } from "@/schematic/families"
import type { ComponentDef } from "@/schematic/types"

// The palette's search: every word typed must match somewhere in a part (its name, a keyword, its
// group, its description); a part ranks by how well each word matched and where. An exact name
// beats a name's start, which beats a word's start inside it, which beats letters buried in a word.
// A keyword counts a little less than the name and a description much less, so a part never loses
// to one that only mentions the word in passing. A typo is forgiven only when nothing matches as
// typed. Equal matches keep the palette's own order: group first, then the part's place in it.

export type SearchHit = {
  def: ComponentDef
  score: number
  /** Matched spans of the part's name, [start, end) in its characters, sorted and merged. */
  ranges: [number, number][]
  /** The keyword that found the part when its name did not, to show why it is in the list. */
  matched?: string
  /** Found only after a typo in the query was forgiven. */
  corrected: boolean
}

const EXACT = 100
const PREFIX = 80
const WORD = 70
const WORD_START = 60
const INSIDE = 40
const SCATTERED = 15
const TYPO = 30
/** A query that is a part's whole name puts that part first, whatever else matches. */
const WHOLE_NAME = 200
/** A keyword of several words typed in full ("power supply") counts as a phrase, not as words found apart. */
const WHOLE_KEYWORD = 80

const NAME = 1
const KEYWORD = 0.8
const GROUP = 0.5
const DESCRIPTION = 0.3

const CHAR_MAP: Record<string, string> = { "×": "x", "²": "2", "³": "3", "µ": "u", "μ": "u", "–": "-", "—": "-", "’": "'" }

/** Lower case with the symbols a part name uses spelled as typed; one character for one, so an index into the result is an index into the original. */
export function normalize(text: string): string {
  let out = ""
  for (const ch of text) {
    const mapped = CHAR_MAP[ch] ?? ch.toLowerCase()
    out += mapped.length === ch.length ? mapped : ch
  }
  return out
}

const isAlnum = (c: string | undefined) => c !== undefined && /[a-z0-9]/.test(c)

/** Letters and digits only, with where each came from in the text. */
function compact(text: string): { text: string; at: number[] } {
  let out = ""
  const at: number[] = []
  for (let i = 0; i < text.length; i++)
    if (isAlnum(text[i])) {
      out += text[i]
      at.push(i)
    }
  return { text: out, at }
}

type Field = { text: string; compact: { text: string; at: number[] }; weight: number; inside: boolean; scattered: boolean }
type Match = { score: number; range?: [number, number][] }

function field(text: string, weight: number, inside: boolean, scattered = false): Field {
  const norm = normalize(text)
  return { text: norm, compact: compact(norm), weight, inside, scattered }
}

/** The best way `token` sits in `f`, unweighted, with the span it covers. */
function matchField(token: string, f: Field): Match {
  const text = f.text
  const n = token.length
  if (text === token) return { score: EXACT, range: [[0, n]] }
  if (text.startsWith(token)) return { score: PREFIX, range: [[0, n]] }
  let best: Match = { score: 0 }
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    if (isAlnum(text[at - 1]) && isAlnum(token[0])) {
      if (f.inside && best.score < INSIDE) best = { score: INSIDE, range: [[at, at + n]] }
      continue
    }
    const whole = !isAlnum(text[at + n]) || !isAlnum(token[n - 1])
    const score = whole ? WORD : WORD_START
    if (score > best.score) best = { score, range: [[at, at + n]] }
    if (whole) break
  }
  if (best.score >= WORD_START) return best
  // The same letters without the punctuation and spaces: "ky040" for "KY-040", "blackpill" for "Black Pill".
  const c = compact(token).text
  if (c.length > 1 && (f.inside || c.length === f.compact.text.length)) {
    const at = f.compact.text.indexOf(c)
    if (at >= 0) {
      const score = at === 0 ? (c.length === f.compact.text.length ? EXACT : PREFIX) : INSIDE
      if (score > best.score) best = { score, range: [[f.compact.at[at], f.compact.at[at + c.length - 1] + 1]] }
    }
  }
  if (best.score === 0 && f.scattered) return scattered(token, text)
  return best
}

/** The token's letters in order, starting at a word and not spread too far: "ldr" for "LED driver". */
function scattered(token: string, text: string): Match {
  if (token.length < 3) return { score: 0 }
  for (let start = text.indexOf(token[0]); start >= 0; start = text.indexOf(token[0], start + 1)) {
    if (isAlnum(text[start - 1])) continue
    const range: [number, number][] = []
    let i = start
    for (const ch of token) {
      const at = text.indexOf(ch, i)
      if (at < 0) return { score: 0 }
      const last = range[range.length - 1]
      if (last && last[1] === at) last[1] = at + 1
      else range.push([at, at + 1])
      i = at + 1
    }
    if (i - start <= token.length * 2.5) return { score: SCATTERED, range }
  }
  return { score: 0 }
}

/** Damerau–Levenshtein distance, stopping early past 1. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (i === a.length && i === b.length) return true
  const rest = (x: number, y: number) => a.slice(x) === b.slice(y)
  return rest(i + 1, i + 1) || rest(i + 1, i) || rest(i, i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(i + 2, i + 2))
}

/** A typo forgiven: one letter wrong, missing, extra or swapped in a word of the name or a keyword, for words of five letters or more. */
function matchTypo(token: string, f: Field): Match {
  if (token.length < 5 || f.weight < KEYWORD) return { score: 0 }
  for (const m of f.text.matchAll(/[a-z0-9]+/g))
    if (m[0].length >= 5 && withinOneEdit(token, m[0])) return { score: TYPO, range: [[m.index, m.index + m[0].length]] }
  return { score: 0 }
}

type Entry = { def: ComponentDef; order: number; group: number; name: Field; keywords: Field[]; rest: Field[] }

const entries = new WeakMap<readonly ComponentDef[], Entry[]>()
const GROUP_ORDER = new Map<string, number>(CATEGORIES.map((c, i) => [c.id, i]))

function index(defs: readonly ComponentDef[]): Entry[] {
  let list = entries.get(defs)
  if (!list) {
    list = defs.map((def, order) => ({
      def,
      order,
      group: GROUP_ORDER.get(def.category) ?? CATEGORIES.length,
      name: field(def.name, NAME, true, true),
      // A family's name finds each of its variants, as a keyword would.
      keywords: [...(def.keywords ?? []), ...[familyOf(def.id)?.name ?? []].flat()].map((k) => field(k, KEYWORD, true)),
      rest: [
        ...(isPaletteCategory(def.category) ? [field(categoryLabel(def.category), GROUP, false)] : []),
        ...(def.description ? [field(def.description, DESCRIPTION, false)] : []),
      ],
    }))
    entries.set(defs, list)
  }
  return list
}

function merge(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

function score(entry: Entry, tokens: string[], whole: string, match: (token: string, f: Field) => Match): SearchHit | undefined {
  let total = 0
  const ranges: [number, number][] = []
  let matched: string | undefined
  for (const token of tokens) {
    const byName = match(token, entry.name)
    let best = byName.score * NAME
    let keyword: number | undefined
    entry.keywords.forEach((f, i) => {
      const s = match(token, f).score * KEYWORD
      if (s > best) [best, keyword] = [s, i]
    })
    for (const f of entry.rest) best = Math.max(best, match(token, f).score * f.weight)
    if (best === 0) return undefined
    total += best
    if (byName.range) ranges.push(...byName.range)
    if (keyword !== undefined && byName.score === 0 && matched === undefined) matched = entry.def.keywords?.[keyword]
  }
  if (entry.name.text === whole) total += WHOLE_NAME
  else if (tokens.length > 1 && entry.keywords.some((k) => k.text === whole)) total += WHOLE_KEYWORD
  return { def: entry.def, score: total, ranges: merge(ranges), matched, corrected: false }
}

/** Where the words of `query` sit in `text`, for a label that is not a part's own name (a family's). */
export function highlight(text: string, query: string): [number, number][] {
  const f = field(text, NAME, true)
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean)
  return merge(tokens.flatMap((t) => matchField(t, f).range ?? []))
}

/** Parts that match every word of `query`, best first; none for a blank query. */
export function searchParts(defs: readonly ComponentDef[], query: string): SearchHit[] {
  const whole = normalize(query).trim().replace(/\s+/g, " ")
  if (!whole) return []
  const tokens = whole.split(" ")
  const list = index(defs)
  const run = (match: (token: string, f: Field) => Match, corrected: boolean) =>
    list
      .map((e) => {
        const hit = score(e, tokens, whole, match)
        return hit && { hit: { ...hit, corrected }, e }
      })
      .filter((x) => x !== undefined)
      .sort((a, b) => b.hit.score - a.hit.score || a.e.group - b.e.group || a.e.order - b.e.order)
      .map((x) => x.hit)
  const exact = run(matchField, false)
  if (exact.length > 0) return exact
  return run((token, f) => {
    const m = matchField(token, f)
    return m.score > 0 ? m : matchTypo(token, f)
  }, true)
}

/** What a student may look for among the parts that is a tool of the simulator instead. */
export type ToolHint = { name: string; where: string; shortcut?: string }

const TOOLS: (ToolHint & { words: string[] })[] = [
  { name: "Oscilloscope", where: "Simulate → Oscilloscope", shortcut: "O", words: ["oscilloscope", "scope", "waveform"] },
  { name: "Logic analyser", where: "Simulate → Logic analyser", shortcut: "L", words: ["logic analyser", "logic analyzer", "analyser", "analyzer"] },
  { name: "Probe", where: "Simulate → Probe two points", shortcut: "M", words: ["probe"] },
]

/** Tools the query names, so the palette can point to them rather than come back empty. */
export function toolHints(query: string): ToolHint[] {
  const q = normalize(query).trim().replace(/\s+/g, " ")
  if (q.length < 3) return []
  return TOOLS.filter((t) => t.words.some((w) => w.startsWith(q) || q.includes(w))).map(({ name, where, shortcut }) => ({ name, where, shortcut }))
}

/** A GitHub issue asking for a part the palette lacks, its title filled in with what was searched for. */
export function requestPartUrl(query: string): string {
  const title = `Part request: ${query.trim()}`
  const body = `**Part:** ${query.trim()}\n**Datasheet link:** \n**What it is for (lab, project):** \n`
  return `https://github.com/ChernihivPolytechnicNationalUniversity/emul/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}
