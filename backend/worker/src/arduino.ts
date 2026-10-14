import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { SourceFile } from "emul-shared/source"

/**
 * Arduino sketches, built the way the Arduino IDE builds them (arduino-builder with
 * ArduinoCore-avr 1.8.6's platform.txt): the sketch's .ino files joined into one C++ file
 * after `#include <Arduino.h>`, with prototypes for its functions so one may be called above its
 * definition, and `#line` marks so the compiler's messages point into the .ino files; the
 * libraries it #includes found by header, each with the libraries it #includes in turn.
 */

export const ARDUINO_ROOT = process.env.ARDUINO_ROOT ?? "/opt/arduino"
export const INO = /\.(ino|pde)$/i

/** What ArduinoCore-avr 1.8.6 defines for the Nano (boards.txt: nano.build.*), IDE 1.8.19. */
export const ARDUINO_DEFINES = ["-DARDUINO=10819", "-DARDUINO_AVR_NANO", "-DARDUINO_ARCH_AVR"]
/** The Nano's variant: the standard pins plus A6/A7. */
export const VARIANT = "eightanaloginputs"

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "sizeof", "do", "else", "defined"])

/** The text with comments, strings, character literals and preprocessor lines blanked (same length, newlines kept). */
function blank(text: string): string {
  const out = text.split("")
  const n = out.length
  const space = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "
  }
  let i = 0
  let lineStart = true
  while (i < n) {
    const c = text[i]
    if (lineStart && c === "#") {
      // A directive, with its continuation lines.
      let end = i
      while (end < n && !(text[end] === "\n" && text[end - 1] !== "\\")) end++
      space(i, end)
      i = end
      continue
    }
    if (c === "\n") {
      lineStart = true
      i++
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++
      continue
    }
    lineStart = false
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i)
      const stop = end < 0 ? n : end
      space(i, stop)
      i = stop
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      const stop = end < 0 ? n : end + 2
      space(i, stop)
      i = stop
    } else if (c === '"' || c === "'") {
      let end = i + 1
      while (end < n && text[end] !== c && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1
      const stop = Math.min(n, end + 1)
      space(i, stop)
      i = stop
    } else i++
  }
  return out.join("")
}

type Definition = { prototype: string; offset: number }

/** Function definitions at file scope: their prototypes, and where each starts. */
export function functionDefinitions(text: string): Definition[] {
  const code = blank(text)
  const found: Definition[] = []
  let depth = 0
  // Where the current top-level declaration began: after the last `;`, `}` or `{` at depth 0.
  let start = 0
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c === "{") {
      if (depth === 0) {
        const head = code.slice(start, i)
        const m = /^\s*([\s\S]*?)\b([A-Za-z_]\w*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(const\s*)?$/.exec(head)
        if (m && !KEYWORDS.has(m[2]) && /[A-Za-z_]/.test(m[1]) && !/\b(template|class|struct|union|enum|namespace|typedef)\b|[=:]\s*$/.test(m[1]) && !m[3].includes("=")) {
          const ret = m[1].replace(/\s+/g, " ").trim()
          const lead = text.slice(start, i).search(/\S/)
          found.push({ prototype: `${ret} ${m[2]}(${m[3].replace(/\s+/g, " ").trim()})${m[4] ? " const" : ""};`, offset: start + Math.max(0, lead) })
        }
      }
      depth++
    } else if (c === "}") {
      depth = Math.max(0, depth - 1)
      if (depth === 0) start = i + 1
    } else if (c === ";" && depth === 0) start = i + 1
  }
  return found
}

/** The sketch as the one C++ file the IDE compiles. */
export function sketchToCpp(files: SourceFile[]): string {
  const sketch = files.filter((f) => INO.test(f.path))
  // The file with setup() first (the IDE's main .ino is named after the folder), the rest by name.
  sketch.sort((a, b) => Number(/\bvoid\s+setup\s*\(/.test(b.content)) - Number(/\bvoid\s+setup\s*\(/.test(a.content)) || a.path.localeCompare(b.path))
  const parts = sketch.map((f) => ({ path: f.path, text: f.content.endsWith("\n") ? f.content : `${f.content}\n` }))
  const defs = parts.map((p) => functionDefinitions(p.text))
  const declared = new Set<string>()
  const prototypes: string[] = []
  for (const list of defs)
    for (const d of list) {
      if (declared.has(d.prototype)) continue
      declared.add(d.prototype)
      prototypes.push(d.prototype)
    }
  const first = defs.findIndex((list) => list.length > 0)
  const out = ["#include <Arduino.h>"]
  parts.forEach((p, k) => {
    const name = JSON.stringify(p.path)
    if (k !== first) {
      out.push(`#line 1 ${name}`, p.text)
      return
    }
    const at = defs[k][0].offset
    const before = p.text.slice(0, at)
    const line = before.split("\n").length
    out.push(`#line 1 ${name}`, before, ...prototypes, `#line ${line} ${name}`, p.text.slice(at))
  })
  return out.join("\n")
}

type Library = { name: string; root: string; includes: string[]; headers: Set<string> }

async function exists(p: string) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function walk(dir: string, skip: (name: string) => boolean = () => false): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip(entry.name)) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(p, skip)))
    else out.push(p)
  }
  return out
}

/** The libraries in the image: the core's own (Wire, SPI…) and the installed ones, by header. */
async function libraries(root: string): Promise<Library[]> {
  const out: Library[] = []
  for (const base of [path.join(root, "core", "libraries"), path.join(root, "libraries")]) {
    if (!(await exists(base))) continue
    for (const name of await readdir(base)) {
      const dir = path.join(base, name)
      // 1.5 format: sources in src/; the old flat one: at the root, with utility/.
      const src = (await exists(path.join(dir, "src"))) ? path.join(dir, "src") : dir
      const includes = [src]
      if (src === dir && (await exists(path.join(dir, "utility")))) includes.push(path.join(dir, "utility"))
      const headers = new Set((await readdir(src)).filter((f) => /\.(h|hpp)$/i.test(f)))
      out.push({ name, root: src, includes, headers })
    }
  }
  return out
}

const INCLUDE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm
const includesOf = (text: string) => [...text.matchAll(INCLUDE)].map((m) => path.basename(m[1]))
const SOURCE = /\.(c|cpp|cc|S)$/

/** The libraries a set of sources #includes, and theirs, in the order found. */
export async function librariesFor(texts: string[], root = ARDUINO_ROOT): Promise<{ name: string; includes: string[]; sources: string[] }[]> {
  const all = await libraries(root)
  const picked: Library[] = []
  const queue = texts.flatMap(includesOf)
  const seen = new Set<string>()
  while (queue.length) {
    const header = queue.shift()!
    if (seen.has(header)) continue
    seen.add(header)
    const lib = all.find((l) => l.headers.has(header))
    if (!lib || picked.includes(lib)) continue
    picked.push(lib)
    for (const file of await walk(lib.root, (n) => n === "examples" || n.startsWith("."))) if (/\.(c|cpp|cc|h|hpp)$/.test(file)) queue.push(...includesOf(await readFile(file, "utf8")))
  }
  return Promise.all(
    picked.map(async (l) => ({
      name: l.name,
      includes: l.includes,
      sources: (await walk(l.root, (n) => n === "examples" || n.startsWith("."))).filter((f) => SOURCE.test(f)),
    })),
  )
}

/** The core's sources and include folders for the Nano's variant. */
export async function coreFor(root = ARDUINO_ROOT): Promise<{ includes: string[]; sources: string[] }> {
  const cores = path.join(root, "core", "cores", "arduino")
  return { includes: [cores, path.join(root, "core", "variants", VARIANT)], sources: (await readdir(cores)).filter((f) => SOURCE.test(f)).map((f) => path.join(cores, f)) }
}
