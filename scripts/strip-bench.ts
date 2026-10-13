import { readFileSync } from "node:fs"
import { HSI_HZ, isGpio, parseRate, readCsv, readSigrokSession, SLOT_SECONDS, STRIP_LABELS, decodeStripBench, type Capture } from "./lib/strip-bench"

const USAGE = `usage: pnpm strip-bench <capture.sr | capture.csv> [--rate 1m] D0=P21-27 D1=P19-1 …

Decodes a capture of open746-strip-bench.elf on the Open746I-C: for every analyser channel,
the MCU pad that drove the strip pin it was clipped to, against that pin's silkscreen name.`

let failed = 0
let passed = 0
function expect(what: string, got: string, want: string) {
  const ok = got === want
  if (ok) passed++
  else failed++
  console.log(`${ok ? "✓" : "✗"} ${what}: ${got}${ok ? "" : `  (want ${want})`}`)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const args = process.argv.slice(2)
const rateAt = args.indexOf("--rate")
const rate = rateAt >= 0 ? parseRate(args[rateAt + 1] ?? "") : null
if (rateAt >= 0 && rate === null) fail(`--rate wants a samplerate such as 1m or 500k, not "${args[rateAt + 1] ?? ""}"`)
const rest = args.filter((_, i) => rateAt < 0 || (i !== rateAt && i !== rateAt + 1))
const file = rest.find((a) => !a.includes("="))
const pairs = rest.filter((a) => a.includes("="))
if (!file || !pairs.length) fail(USAGE)

const leads = new Map<string, string>()
for (const pair of pairs) {
  const [channel, pin] = pair.split("=").map((s) => s.trim())
  const label = STRIP_LABELS.get(pin?.toUpperCase() ?? "")
  if (!channel || !pin || label === undefined) fail(`${pair}: want CHANNEL=PIN with a pin of P18–P21, such as D0=P21-27`)
  if (!isGpio(label)) fail(`${pair}: ${pin.toUpperCase()} is ${label}, not an I/O — keep the analyser's leads off it`)
  if ([...leads.values()].includes(pin.toUpperCase())) fail(`${pair}: ${pin.toUpperCase()} is mapped twice`)
  leads.set(channel, pin.toUpperCase())
}

async function load(path: string): Promise<Capture> {
  const bytes = readFileSync(path)
  if (/\.csv$/i.test(path)) return readCsv(bytes.toString("utf8"), rate)
  return readSigrokSession(new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer))
}

const capture = await load(file).catch((e: Error) => fail(`${file}: ${e.message}`))
const present = new Set(capture.channels.map((c) => c.name.toLowerCase()))
const absent = [...leads.keys()].filter((channel) => !present.has(channel.toLowerCase()))
if (absent.length) fail(`${file} has no channel ${absent.join(", ")}; it has ${capture.channels.map((c) => c.name).join(", ")}`)

console.log(`${file}: ${capture.channels.length} channels, ${(capture.end - capture.start).toFixed(3)} s`)
const report = decodeStripBench(capture, leads)
if (report.problem) fail(report.problem)
console.log(`${report.cycles} complete cycles, slot ${(report.slotSeconds * 1e3).toFixed(4)} ms → HSI ${((HSI_HZ * SLOT_SECONDS) / report.slotSeconds / 1e6).toFixed(3)} MHz\n`)
for (const r of report.readings) {
  expect(`${r.channel} on ${r.pin} (${r.label})`, r.found, r.want)
  if (!r.ok || r.label !== r.found) console.log(`    ${r.detail}`)
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
