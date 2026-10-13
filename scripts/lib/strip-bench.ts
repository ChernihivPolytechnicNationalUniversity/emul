import { readZip } from "@/lib/zip"
import { open746ic } from "@/schematic/components/open746i-c"

export const SLOT_SECONDS = 1e-3
export const SYNC_SLOTS = 8
export const GAP_SLOTS = 2
export const NEVER_DRIVEN = "PA9"
export const HSI_HZ = 16e6

export const SLOT_PADS = (
  "PH12 PB12 PB13 PB14 PB15 PD8 PD9 PD10 PD11 PD12 PD13 PD14 PD15 PG2 PG3 PG4 PG5 PG6 PG7 PG8 PC6 PC7 PC8 PC9 " +
  "PA8 PA9 PA10 PA11 PA12 PA13 PH14 PH13 PI0 PH15 PI1 PI2 PA14 PI3 PC10 PA15 PC12 PC11 PD1 PD0 PD3 PD2 PD5 PD4 " +
  "PD7 PD6 PG10 PG9 PG12 PG11 PG14 PG13 PB3 PG15 PB5 PB4 PB7 PB6 PB8 PB9 PE0 PE1 PI5 PI4 PI7 PI6 " +
  "PH11 PH10 PH9 PH8 PH7 PH6 PB11 PB10 PE15 PE14 PE13 PE12 PE11 PE10 PE9 PE8 PE7 PG1 PG0 PF15 PF14 PF13 PF12 PF11 " +
  "PB2 PB1 PB0 PC5 PC4 PA7 PA6 PA5 PA4 PA3 PH5 PH4 PH3 PH2 PA2 PA1 PA0 PC3 PC2 PC1 PC0 PH0 PH1 PF9 " +
  "PF10 PF7 PF8 PF5 PF6 PF3 PF4 PF1 PF2 PI11 PF0 PI9 PI10 PC14 PC15 PI8 PC13 PE6 PE5 PE4 PE3 PE2"
).split(" ")

export const CYCLE_SLOTS = SYNC_SLOTS + GAP_SLOTS + SLOT_PADS.length + GAP_SLOTS
const SLOTS_AFTER_SYNC = CYCLE_SLOTS - SYNC_SLOTS
const SHORTEST_SYNC = (SYNC_SLOTS / 2) * SLOT_SECONDS
const LONGEST_SYNC = 2 * SYNC_SLOTS * SLOT_SECONDS
const SLOT_TOLERANCE = 0.1

const STRIPS = new Set(["P18", "P19", "P20", "P21"])
const ROWS_PER_HALF_STRIP = 18
const ROWS_PER_STRIP = 2 * ROWS_PER_HALF_STRIP
const ROWS_PER_GROUP = 4

export const isGpio = (label: string) => /^P[A-I](?:[0-9]|1[0-5])$/.test(label)

export const STRIP_LABELS: ReadonlyMap<string, string> = new Map(
  open746ic.pins.filter((p) => p.connector !== undefined && STRIPS.has(p.connector)).map((p) => [p.id, p.label]),
)

function leftStripRow(row: number): [string, string] {
  const header = row < ROWS_PER_HALF_STRIP ? "P20" : "P21"
  const outer = 2 * (row % ROWS_PER_HALF_STRIP) + 1
  return [`${header}-${outer}`, `${header}-${outer + 1}`]
}

function rightStripRow(row: number): [string, string] {
  const header = row < ROWS_PER_HALF_STRIP ? "P19" : "P18"
  const inner = ROWS_PER_STRIP - 2 * (row % ROWS_PER_HALF_STRIP)
  return [`${header}-${inner}`, `${header}-${inner - 1}`]
}

export type BenchGroup = { strip: "left" | "right"; firstRow: number; lastRow: number; leads: (string | null)[] }

export const BENCH_GROUPS: BenchGroup[] = (["left", "right"] as const).flatMap((strip) =>
  Array.from({ length: ROWS_PER_STRIP / ROWS_PER_GROUP }, (_, group) => {
    const rows = Array.from({ length: ROWS_PER_GROUP }, (_, r) => group * ROWS_PER_GROUP + r)
    const pins = rows.flatMap((row) => (strip === "left" ? leftStripRow(row) : rightStripRow(row)))
    const leads = pins.map((pin) => (isGpio(STRIP_LABELS.get(pin) ?? "") ? pin : null))
    return { strip, firstRow: rows[0]! + 1, lastRow: rows[rows.length - 1]! + 1, leads }
  }),
)

export type Channel = { name: string; initial: boolean; toggles: ArrayLike<number> }
export type Capture = { start: number; end: number; channels: Channel[] }

export type Verdict = "pad" | "low" | "high" | "mixed" | "unstable"
export type Reading = { channel: string; pin: string; label: string; verdict: Verdict; pad: string | null; detail: string; found: string; want: string; ok: boolean }
export type Report = { slotSeconds: number; syncs: number; cycles: number; readings: Reading[]; problem: string | null }

type Pulse = { rise: number; fall: number }
type CycleLevels = { sync: boolean; gaps: boolean; high: number[] }

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function levelAt(channel: Channel, time: number): boolean {
  let lo = 0
  let hi = channel.toggles.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (channel.toggles[mid]! <= time) lo = mid + 1
    else hi = mid
  }
  return lo % 2 === 1 ? !channel.initial : channel.initial
}

function completeHighPulses(channel: Channel): Pulse[] {
  const pulses: Pulse[] = []
  let high = channel.initial
  let rise: number | null = null
  for (let i = 0; i < channel.toggles.length; i++) {
    high = !high
    if (high) rise = channel.toggles[i]!
    else if (rise !== null) pulses.push({ rise, fall: channel.toggles[i]! })
  }
  return pulses
}

function findSyncs(capture: Capture): Pulse[] {
  const sightings = capture.channels
    .flatMap((channel, index) =>
      completeHighPulses(channel)
        .filter((p) => p.fall - p.rise >= SHORTEST_SYNC && p.fall - p.rise <= LONGEST_SYNC)
        .map((p) => ({ index, ...p })),
    )
    .sort((a, b) => a.fall - b.fall)
  const clusters: (typeof sightings)[] = []
  for (const sighting of sightings) {
    const last = clusters[clusters.length - 1]
    if (last && sighting.fall - last[0]!.fall < SLOT_SECONDS / 2) last.push(sighting)
    else clusters.push([sighting])
  }
  const support = (cluster: typeof sightings) => new Set(cluster.map((s) => s.index)).size
  const strongest = Math.max(0, ...clusters.map(support))
  return clusters
    .filter((cluster) => 2 * support(cluster) >= strongest)
    .map((cluster) => ({ rise: median(cluster.map((s) => s.rise)), fall: median(cluster.map((s) => s.fall)) }))
}

function measureSlot(syncs: Pulse[]): number {
  const cycle = CYCLE_SLOTS * SLOT_SECONDS
  const periods = syncs
    .slice(1)
    .map((sync, i) => sync.fall - syncs[i]!.fall)
    .filter((period) => Math.abs(period / cycle - 1) < 2 * SLOT_TOLERANCE)
  if (periods.length) return median(periods) / CYCLE_SLOTS
  return median(syncs.map((s) => s.fall - s.rise)) / SYNC_SLOTS
}

function readCycle(channel: Channel, syncEnd: number, slot: number): CycleLevels {
  const inSlot = (afterSync: number) => levelAt(channel, syncEnd + (afterSync + 0.5) * slot)
  const gapSlots = [...Array(GAP_SLOTS).keys()].flatMap((g) => [g, GAP_SLOTS + SLOT_PADS.length + g])
  return {
    sync: levelAt(channel, syncEnd - (SYNC_SLOTS / 2) * slot),
    gaps: gapSlots.some(inSlot),
    high: SLOT_PADS.flatMap((_, k) => (inSlot(GAP_SLOTS + k) ? [k] : [])),
  }
}

function describeSlots(slots: number[]) {
  const pads = slots.map((k) => SLOT_PADS[k]!)
  return pads.length > 6 ? `${pads.slice(0, 6).join(", ")} and ${pads.length - 6} more` : pads.join(", ")
}

function classify(cycles: CycleLevels[]): { verdict: Verdict; pad: string | null; detail: string } {
  const signature = (c: CycleLevels) => `${c.sync}|${c.gaps}|${c.high.join(",")}`
  if (cycles.some((c) => signature(c) !== signature(cycles[0]!))) return { verdict: "unstable", pad: null, detail: "the pattern changes from cycle to cycle: a loose lead or a floating pin" }
  const { sync, gaps, high } = cycles[0]!
  if (high.length === 1 && sync && !gaps) return { verdict: "pad", pad: SLOT_PADS[high[0]!]!, detail: `high in the sync and in slot ${high[0]! + 1} of ${SLOT_PADS.length}` }
  if (high.length === 0 && !sync && !gaps) return { verdict: "low", pad: null, detail: "low throughout" }
  if (high.length === SLOT_PADS.length && sync && gaps) return { verdict: "high", pad: null, detail: "high throughout" }
  const where = high.length ? `high in the slots of ${describeSlots(high)}` : "high in no pad's slot"
  return { verdict: "mixed", pad: null, detail: `${where}, ${sync ? "high" : "low"} in the sync${gaps ? ", high between the sync and the pads" : ""}` }
}

function verdictText(verdict: Verdict, pad: string | null) {
  if (verdict === "pad") return pad!
  if (verdict === "low") return "low throughout"
  if (verdict === "high") return "high throughout"
  return verdict
}

export function decodeStripBench(capture: Capture, leads: ReadonlyMap<string, string>): Report {
  const syncs = findSyncs(capture)
  const empty = (problem: string, slotSeconds = NaN): Report => ({ slotSeconds, syncs: syncs.length, cycles: 0, readings: [], problem })
  if (!syncs.length) return empty("no sync pulse on any channel: is the kit running, the analyser's ground on the board, and the capture at least 0.32 s long?")
  const slot = measureSlot(syncs)
  if (Math.abs(slot / SLOT_SECONDS - 1) > SLOT_TOLERANCE)
    return empty(`the slots last ${(slot * 1e3).toFixed(3)} ms, the kit makes ${SLOT_SECONDS * 1e3} ms: is the board running open746-strip-bench.elf?`, slot)
  const complete = syncs.filter((s) => s.fall + SLOTS_AFTER_SYNC * slot <= capture.end)
  if (!complete.length) return empty("no complete cycle after a sync: record at least 0.32 s (1 s is comfortable)", slot)
  const readings = [...leads].map(([name, pin]): Reading => {
    const label = STRIP_LABELS.get(pin) ?? "?"
    const channel = capture.channels.find((c) => c.name.toLowerCase() === name.toLowerCase())
    if (!channel) return { channel: name, pin, label, verdict: "low", pad: null, detail: "no such channel in the capture", found: "missing", want: label, ok: false }
    const { verdict, pad, detail } = classify(complete.map((sync) => readCycle(channel, sync.fall, slot)))
    if (label === NEVER_DRIVEN) {
      const ok = verdict !== "pad"
      return { channel: name, pin, label, verdict, pad, detail: `${detail}; the kit never drives ${NEVER_DRIVEN}`, found: ok ? "not driven" : verdictText(verdict, pad), want: "not driven", ok }
    }
    return { channel: name, pin, label, verdict, pad, detail, found: verdictText(verdict, pad), want: label, ok: verdict === "pad" && pad === label }
  })
  return { slotSeconds: slot, syncs: syncs.length, cycles: complete.length, readings, problem: null }
}

const PREFIX: Record<string, number> = { "": 1, k: 1e3, m: 1e6, g: 1e9 }

export function parseRate(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?)\s*(?:hz)?\s*$/i.exec(text)
  return match ? Number(match[1]) * PREFIX[match[2]!.toLowerCase()]! : null
}

class Toggles {
  readonly levels: boolean[]
  readonly initial: boolean[]
  readonly times: number[][]
  constructor(count: number) {
    this.levels = new Array<boolean>(count).fill(false)
    this.initial = new Array<boolean>(count).fill(false)
    this.times = Array.from({ length: count }, () => [])
  }
  first(channel: number, level: boolean) {
    this.levels[channel] = level
    this.initial[channel] = level
  }
  next(channel: number, level: boolean, time: number) {
    if (level === this.levels[channel]) return
    this.levels[channel] = level
    this.times[channel]!.push(time)
  }
  channels(names: string[]): Channel[] {
    return names.map((name, i) => ({ name, initial: this.initial[i]!, toggles: this.times[i]! }))
  }
}

function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>()
  let current = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const section = /^\[(.+)\]$/.exec(line)
    if (section) sections.set(section[1]!, (current = new Map()))
    else if (line.includes("=")) current.set(line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim())
  }
  return sections
}

const chunkNumber = (path: string) => Number(/-(\d+)$/.exec(path)?.[1] ?? 0)

export async function readSigrokSession(bytes: Uint8Array<ArrayBuffer>): Promise<Capture> {
  const entries = readZip(bytes)
  const metadataEntry = entries.find((e) => e.path === "metadata")
  if (!metadataEntry) throw new Error("not a sigrok session: no metadata inside")
  const metadata = parseIni(new TextDecoder().decode(await metadataEntry.read()))
  const device = [...metadata].find(([name, keys]) => name.startsWith("device") && keys.has("capturefile"))?.[1]
  if (!device) throw new Error("the session's metadata names no logic capture")
  const rate = parseRate(device.get("samplerate") ?? "")
  if (!rate) throw new Error(`unreadable samplerate "${device.get("samplerate")}"`)
  const unitSize = Number(device.get("unitsize") ?? 1)
  const probes = [...device].flatMap(([key, name]) => (/^probe\d+$/.test(key) ? [{ bit: Number(key.slice(5)) - 1, name }] : []))
  if (!probes.length) throw new Error("the session has no logic channels")
  const file = device.get("capturefile")!
  const chunks = entries.filter((e) => e.path === file || e.path.startsWith(`${file}-`)).sort((a, b) => chunkNumber(a.path) - chunkNumber(b.path))
  const parts = await Promise.all(chunks.map((c) => c.read()))
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    data.set(part, at)
    at += part.length
  }
  const samples = Math.floor(data.length / unitSize)
  const toggles = new Toggles(probes.length)
  const levelOf = (sample: number, bit: number) => ((data[sample * unitSize + (bit >> 3)]! >> (bit & 7)) & 1) === 1
  probes.forEach((p, i) => toggles.first(i, samples > 0 && levelOf(0, p.bit)))
  for (let s = 1; s < samples; s++) {
    let same = true
    for (let b = 0; b < unitSize && same; b++) same = data[s * unitSize + b] === data[(s - 1) * unitSize + b]
    if (same) continue
    probes.forEach((p, i) => toggles.next(i, levelOf(s, p.bit), s / rate))
  }
  return { start: 0, end: samples / rate, channels: toggles.channels(probes.map((p) => p.name)) }
}

const TIME_COLUMNS: Record<string, number> = { seconds: 1, milliseconds: 1e-3, microseconds: 1e-6, nanoseconds: 1e-9, picoseconds: 1e-12 }

function sigrokTimeUnit(rate: number | null) {
  if (rate === null) throw new Error("the CSV's time column names no unit and no samplerate tells it: pass --rate")
  if (rate > 1e6) return 1e-9
  if (rate > 1e3) return 1e-6
  if (rate > 1) return 1e-3
  return 1
}

export function readCsv(text: string, fallbackRate: number | null = null): Capture {
  let names: string[] = []
  let rate = fallbackRate
  let header: string[] | null = null
  const rows: string[][] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith(";") || line.startsWith("#")) {
      const channels = /Channels\s*\(\d+\/\d+\):\s*(.*)$/.exec(line)
      if (channels) names = channels[1]!.split(",").map((n) => n.trim())
      const sampled = /Samplerate:\s*(.*)$/.exec(line)
      if (sampled) rate = parseRate(sampled[1]!) ?? rate
      continue
    }
    const cells = line.split(",").map((c) => c.trim())
    if (header === null && !rows.length && cells.some((c) => c !== "" && Number.isNaN(Number(c)))) header = cells
    else rows.push(cells)
  }
  if (!rows.length) throw new Error("the CSV holds no samples")
  const width = rows[0]!.length
  const firstHeader = header?.[0]?.toLowerCase() ?? ""
  let timeScale: number | null = null
  if (Object.hasOwn(TIME_COLUMNS, firstHeader)) timeScale = TIME_COLUMNS[firstHeader]!
  else if (firstHeader.startsWith("time")) timeScale = /\[s\]/.test(firstHeader) ? 1 : sigrokTimeUnit(rate)
  else if (!header && names.length && width === names.length + 1) timeScale = sigrokTimeUnit(rate)
  const columns = (header ?? []).slice(timeScale === null ? 0 : 1)
  const channelCount = width - (timeScale === null ? 0 : 1)
  const channelNames = Array.from({ length: channelCount }, (_, i) => {
    const label = columns[i]
    return label && label.toLowerCase() !== "logic" ? label : (names[i] ?? `D${i}`)
  })
  if (timeScale === null && rate === null) throw new Error("the CSV has neither a time column nor a samplerate: pass --rate")
  const timeOf = (row: string[], index: number) => (timeScale === null ? index / rate! : Number(row[0]) * timeScale)
  const offset = timeScale === null ? 0 : 1
  const toggles = new Toggles(channelCount)
  rows.forEach((row, index) => {
    for (let c = 0; c < channelCount; c++) {
      const level = Number(row[offset + c]) > 0
      if (index === 0) toggles.first(c, level)
      else toggles.next(c, level, timeOf(row, index))
    }
  })
  const last = rows[rows.length - 1]!
  const end = timeOf(last, rows.length - 1) + (rate ? 1 / rate : 0)
  return { start: timeOf(rows[0]!, 0), end, channels: toggles.channels(channelNames) }
}
