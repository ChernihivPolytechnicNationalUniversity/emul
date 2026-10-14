/**
 * The popular Arduino Nano circuits' sketches, fetched as published and built by the build
 * service's own code (backend/worker/src/build.ts) with the worker's toolchain, core and
 * libraries: `pnpm firmware-arduino` (in the emul-arduino image, firmware/arduino/Dockerfile).
 * The ELFs land in firmware/arduino/build/, not in git: Keypad is GPL-3.0 and LiquidCrystal_I2C
 * carries no licence at all, so nothing here is redistributed, only fetched. Every source is
 * pinned (a commit or a release tag); the one web page is checked against its hash.
 *
 * Sources and wiring: tests/sim/nano-popular.test.ts.
 */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const AE = "https://raw.githubusercontent.com/arduino/arduino-examples/50b66a3ce1e4e5e69cd96d3af5ca41a3383b311a/examples"
const DOCS = "https://raw.githubusercontent.com/arduino/docs-content/c220122bbfa28da3f61a7547d089524386d34a29/content"
const GH = "https://raw.githubusercontent.com"

type Source = { url: string; as: string; extract?: "first-arduino-block" | "first-pre"; sha256?: string }
type Sketch = { name: string; files: Source[] }

const SKETCHES: Sketch[] = [
  { name: "blink", files: [{ url: `${AE}/01.Basics/Blink/Blink.ino`, as: "Blink.ino" }] },
  { name: "analog-read-serial", files: [{ url: `${AE}/01.Basics/AnalogReadSerial/AnalogReadSerial.ino`, as: "AnalogReadSerial.ino" }] },
  { name: "fade", files: [{ url: `${AE}/01.Basics/Fade/Fade.ino`, as: "Fade.ino" }] },
  { name: "button", files: [{ url: `${AE}/02.Digital/Button/Button.ino`, as: "Button.ino" }] },
  { name: "debounce", files: [{ url: `${AE}/02.Digital/Debounce/Debounce.ino`, as: "Debounce.ino" }] },
  { name: "state-change", files: [{ url: `${AE}/02.Digital/StateChangeDetection/StateChangeDetection.ino`, as: "StateChangeDetection.ino" }] },
  {
    name: "tone-melody",
    files: [
      { url: `${AE}/02.Digital/toneMelody/toneMelody.ino`, as: "toneMelody.ino" },
      { url: `${AE}/02.Digital/toneMelody/pitches.h`, as: "pitches.h" },
    ],
  },
  { name: "servo-sweep", files: [{ url: `${GH}/arduino-libraries/Servo/1.2.2/examples/Sweep/Sweep.ino`, as: "Sweep.ino" }] },
  { name: "servo-knob", files: [{ url: `${GH}/arduino-libraries/Servo/1.2.2/examples/Knob/Knob.ino`, as: "Knob.ino" }] },
  { name: "lcd-hello", files: [{ url: `${GH}/arduino-libraries/LiquidCrystal/1.0.7/examples/HelloWorld/HelloWorld.ino`, as: "HelloWorld.ino" }] },
  { name: "lcd-i2c-hello", files: [{ url: `${GH}/johnrickman/LiquidCrystal_I2C/1.1.3/examples/HelloWorld/HelloWorld.pde`, as: "HelloWorld.pde" }] },
  { name: "neopixel-simple", files: [{ url: `${GH}/adafruit/Adafruit_NeoPixel/1.15.5/examples/simple/simple.ino`, as: "simple.ino" }] },
  { name: "ssd1306", files: [{ url: `${GH}/adafruit/Adafruit_SSD1306/2.5.17/examples/ssd1306_128x64_i2c/ssd1306_128x64_i2c.ino`, as: "ssd1306_128x64_i2c.ino" }] },
  { name: "keypad-hello", files: [{ url: `${GH}/Chris--A/Keypad/3.1.1/examples/HelloKeypad/HelloKeypad.ino`, as: "HelloKeypad.ino" }] },
  { name: "shiftout-hello", files: [{ url: `${DOCS}/tutorials/communication/guide-to-shift-out/guide-to-shift-out.md`, as: "ShftOut11.ino", extract: "first-arduino-block" }] },
  {
    name: "rotary-encoder",
    files: [{ url: "https://lastminuteengineers.com/rotary-encoder-arduino-tutorial/", as: "RotaryEncoder.ino", extract: "first-pre" }],
  },
]

/** LiquidCrystal_I2C has no licence, so the image does not carry it: fetched for this build only. */
const EXTRA_LIBRARIES = [{ repo: "johnrickman/LiquidCrystal_I2C", tag: "1.1.3", as: "LiquidCrystal_I2C" }]

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&amp;/g, "&")

async function fetchSource(s: Source): Promise<string> {
  const res = await fetch(s.url)
  if (!res.ok) throw new Error(`${s.url}: ${res.status}`)
  const text = await res.text()
  if (s.extract === "first-arduino-block") return /```arduino\n([\s\S]*?)```/.exec(text)![1]
  if (s.extract === "first-pre") return decode(/<pre[^>]*>([\s\S]*?)<\/pre>/.exec(text)![1])
  return text
}

const here = import.meta.dirname
const out = path.join(here, "build")
mkdirSync(out, { recursive: true })

// The image's core and libraries, plus the ones it may not carry.
const root = mkdtempSync(path.join(tmpdir(), "arduino-"))
cpSync(process.env.ARDUINO_ROOT ?? "/opt/arduino", root, { recursive: true })
for (const lib of EXTRA_LIBRARIES) execFileSync("git", ["-c", "advice.detachedHead=false", "clone", "-q", "--depth", "1", "-b", lib.tag, `https://github.com/${lib.repo}`, path.join(root, "libraries", lib.as)])
process.env.ARDUINO_ROOT = root
const { build } = await import("../../backend/worker/src/build.ts")

let failed = 0
const hashes: Record<string, string> = {}
for (const sketch of SKETCHES) {
  const files = await Promise.all(sketch.files.map(async (s) => ({ path: s.as, content: await fetchSource(s) })))
  for (const f of files) hashes[`${sketch.name}/${f.path}`] = createHash("sha256").update(f.content).digest("hex")
  const result = await build("atmega328p", files, { opt: "-Os", fcpu: 16_000_000 })
  writeFileSync(path.join(out, `${sketch.name}.log`), result.log)
  if (!result.ok) {
    failed++
    console.log(`✗ ${sketch.name}: ${result.error}\n${result.log}`)
    continue
  }
  writeFileSync(path.join(out, `${sketch.name}.elf`), result.elf!)
  for (const f of files) writeFileSync(path.join(out, `${sketch.name}.${f.path}`), f.content)
  console.log(`✓ ${sketch.name}: ${result.elf!.length} B`)
}
// What was fetched, so a drifted web page shows up as a changed hash in the test's log.
writeFileSync(path.join(out, "sources.json"), JSON.stringify(hashes, null, 2))
process.exit(failed ? 1 : 0)
