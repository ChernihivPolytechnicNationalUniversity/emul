/**
 * The debugger's peripheral register maps, one JSON per chip (src/debug/peripherals.ts): every
 * peripheral instance the CMSIS device header declares (`#define GPIOA ((GPIO_TypeDef *)
 * GPIOA_BASE)`), its base address (the chain of `_BASE` macros), the registers of its struct
 * type with their offsets and access (`__IO`/`__I`/`__O`), and the bit-fields ST names
 * `<GROUP>_<REGISTER>_<FIELD>_Pos`/`_Msk` — the Cortex core's own blocks (SCB, NVIC, SysTick)
 * from the CMSIS core header alike. Built from the same pinned headers the worker
 * compiles against, at site build time; a regex pass is enough for headers this regular.
 *
 *   pnpm peripherals <st root> <out dir>      e.g. pnpm peripherals /tmp/st public/peripherals
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { PeripheralMap, PeripheralRegister } from "@/debug/peripherals"

const st = process.argv[2]
const out = process.argv[3]
if (!st || !out) {
  console.error("usage: pnpm peripherals <st root> <out dir>")
  process.exit(1)
}
const targetsDir = join(import.meta.dirname, "..", "backend", "worker", "targets")

const SIZES: Record<string, number> = { uint32_t: 4, int32_t: 4, uint16_t: 2, int16_t: 2, uint8_t: 1, int8_t: 1 }

/** C integer expressions of the header's macros: literals with U/L suffixes, + - * << >> | &, parentheses, names. */
function evaluate(expr: string, macros: Map<string, string>, depth = 0): number | null {
  if (depth > 32) return null
  const text = expr.replace(/\/\*.*?\*\//g, "").trim()
  const tokens = text.match(/0[xX][0-9a-fA-F]+|\d+|[A-Za-z_]\w*|<<|>>|[-+*|&()~]/g)
  if (!tokens) return null
  let i = 0
  const primary = (): number | null => {
    const t = tokens[i++]
    if (t === undefined) return null
    if (t === "(") {
      // A cast: (uint32_t) x.
      if (/^u?int\d+_t$/.test(tokens[i] ?? "") && tokens[i + 1] === ")") {
        i += 2
        return primary()
      }
      const v = or()
      i++
      return v
    }
    if (t === "~") {
      const v = primary()
      return v === null ? null : ~v >>> 0
    }
    if (/^0[xX]/.test(t)) return parseInt(t, 16)
    if (/^\d/.test(t)) return Number(t)
    if (/^[UL]+$/i.test(t)) return primary()
    const m = macros.get(t)
    return m === undefined ? null : evaluate(m, macros, depth + 1)
  }
  const suffixed = (): number | null => {
    const v = primary()
    while (tokens[i] && /^[uUlL]+$/.test(tokens[i]!)) i++
    return v
  }
  const mul = (): number | null => {
    let v = suffixed()
    while (tokens[i] === "*") {
      i++
      const w = suffixed()
      v = v === null || w === null ? null : v * w
    }
    return v
  }
  const add = (): number | null => {
    let v = mul()
    while (tokens[i] === "+" || tokens[i] === "-") {
      const op = tokens[i++]
      const w = mul()
      v = v === null || w === null ? null : op === "+" ? v + w : v - w
    }
    return v
  }
  const shift = (): number | null => {
    let v = add()
    while (tokens[i] === "<<" || tokens[i] === ">>") {
      const op = tokens[i++]
      const w = add()
      v = v === null || w === null ? null : op === "<<" ? (v * 2 ** w) % 2 ** 32 : Math.floor(v / 2 ** w)
    }
    return v
  }
  const and = (): number | null => {
    let v = shift()
    while (tokens[i] === "&") {
      i++
      const w = shift()
      v = v === null || w === null ? null : (v & w) >>> 0
    }
    return v
  }
  const or = (): number | null => {
    let v = and()
    while (tokens[i] === "|") {
      i++
      const w = and()
      v = v === null || w === null ? null : (v | w) >>> 0
    }
    return v
  }
  const v = or()
  return v === null ? null : v >>> 0
}

type Struct = { name: string; size: number; registers: PeripheralRegister[] }

/** `typedef struct { … } X_TypeDef;`, members laid out as the compiler would (natural alignment). */
function parseStructs(header: string): Map<string, Struct> {
  const structs = new Map<string, Struct>()
  for (const m of header.matchAll(/typedef\s+struct\s*\w*\s*\{([\s\S]*?)\}\s*(\w+)\s*;/g)) {
    const body = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    const registers: PeripheralRegister[] = []
    let offset = 0
    let ok = true
    for (const decl of body.split(";")) {
      const d = /^\s*((?:__IO|__I|__O|__IM|__OM|__IOM|volatile|const)\s+)*(\w+)\s+(\w+)\s*(?:\[\s*([^\]]+)\s*\])?\s*$/.exec(decl)
      if (!d) {
        if (decl.trim()) ok = false
        continue
      }
      const qualifier = d[1]?.trim() ?? ""
      const type = d[2]
      const name = d[3]
      const count = d[4] ? evaluate(d[4], new Map()) ?? 1 : 1
      const nested = structs.get(type)
      const size = SIZES[type] ?? nested?.size
      if (size === undefined) {
        ok = false
        break
      }
      const align = nested ? 4 : size
      offset = Math.ceil(offset / align) * align
      if (!/^RESERVED/i.test(name)) {
        const access = /__I\b|__IM\b/.test(qualifier) ? "r" : /__O\b|__OM\b/.test(qualifier) ? "w" : "rw"
        for (let k = 0; k < count; k++) {
          const at = offset + k * size
          const label = d[4] ? `${name}[${k}]` : name
          if (nested) for (const r of nested.registers) registers.push({ ...r, name: `${label}.${r.name}`, offset: at + r.offset })
          else registers.push({ name: label, offset: at, size, access })
        }
      }
      offset += count * size
    }
    if (ok) structs.set(m[2], { name: m[2], size: Math.ceil(offset / 4) * 4, registers })
  }
  return structs
}

function build(chip: string, family: string, device: string, core: string) {
  const file = join(st, family, "cmsis", "Include", device)
  if (!existsSync(file)) {
    console.error(`${chip}: no ${file}`)
    return
  }
  // The device header, then the core's (the SCB, NVIC and SysTick are declared there).
  const coreFile = join(st, "core", "Include", core)
  const header = readFileSync(file, "utf8") + (existsSync(coreFile) ? `\n${readFileSync(coreFile, "utf8")}` : "")
  const macros = new Map<string, string>()
  for (const m of header.matchAll(/^[ \t]*#define[ \t]+(\w+)[ \t]+([^\n]*?)[ \t]*(?:\/\*.*)?$/gm)) macros.set(m[1], m[2])
  const structs = parseStructs(header)
  const version = /@version\s+V?([\d.]+)/.exec(header)?.[1]
  const map: PeripheralMap = { chip, source: `${device}${version ? ` v${version}` : ""}`, peripherals: [], types: {} }
  for (const [name, value] of macros) {
    const m = /^\(\(\s*(\w+_Type(?:Def)?)\s*\*\s*\)\s*(\w+)\s*\)$/.exec(value.trim())
    if (!m) continue
    const s = structs.get(m[1])
    const base = evaluate(m[2], macros)
    if (!s || base === null) continue
    const group = m[1].replace(/_Type(Def)?$/, "")
    map.peripherals.push({ name, base, type: m[1], group })
    if (!map.types[m[1]]) {
      // Bit-fields: <GROUP>_<REG>_<FIELD>_Pos with its _Msk, for plain registers.
      map.types[m[1]] = {
        size: s.size,
        registers: s.registers.map((r) => {
          if (r.name.includes("[") || r.name.includes(".")) return r
          const prefix = `${group}_${r.name}_`
          const fields: { name: string; pos: number; width: number }[] = []
          for (const [macro, v] of macros) {
            if (!macro.startsWith(prefix) || !macro.endsWith("_Pos")) continue
            const field = macro.slice(prefix.length, -4)
            const pos = evaluate(v, macros)
            const mask = evaluate(macros.get(`${prefix}${field}_Msk`) ?? "", macros)
            if (pos === null || mask === null || !mask) continue
            const width = Math.round(Math.log2(Math.floor(mask / 2 ** pos) + 1))
            // ST names some fields twice (MODE0 and the older MODER0): the first stands.
            if (width > 0 && width <= 32 && !fields.some((f) => f.pos === pos && f.width === width)) fields.push({ name: field, pos, width })
          }
          fields.sort((a, b) => b.pos - a.pos)
          return fields.length ? { ...r, fields } : r
        }),
      }
    }
  }
  map.peripherals.sort((a, b) => a.base - b.base || a.name.localeCompare(b.name))
  mkdirSync(out, { recursive: true })
  const json = JSON.stringify(map)
  writeFileSync(join(out, `${chip}.json`), json)
  const fields = Object.values(map.types).reduce((n, t) => n + t.registers.reduce((k, r) => k + (r.fields?.length ?? 0), 0), 0)
  console.log(`${chip}: ${map.peripherals.length} peripherals, ${Object.keys(map.types).length} types, ${fields} fields, ${(json.length / 1024).toFixed(0)} KB from ${map.source}`)
}

for (const target of readdirSync(targetsDir)) {
  const spec = join(targetsDir, target, "target.json")
  if (!existsSync(spec)) continue
  const t = JSON.parse(readFileSync(spec, "utf8")) as { family: string; cpu: string[]; defines: string[] }
  const device = t.defines.map((d) => /^-D(STM32F\w+xx)$/.exec(d)?.[1]).find(Boolean)
  const core = t.cpu.map((c) => /^-mcpu=cortex-(m\d+)/.exec(c)?.[1]).find(Boolean) ?? "m4"
  if (device) build(target, t.family, `${device.toLowerCase()}.h`, `core_c${core}.h`)
}
