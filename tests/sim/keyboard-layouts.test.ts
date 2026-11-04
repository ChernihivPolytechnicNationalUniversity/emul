import { readFileSync } from "node:fs"
import { isExactShortcutMatch } from "lexical"
import { describe, expect, it } from "vitest"
import { alternatives, matches, type KeyPress, type Shortcut } from "@/lib/keys"
import { KEYMAP } from "@/lib/keymap"

type Layout = Record<string, string[]>
type Platform = "pc" | "mac"

const LAYOUTS: Record<string, Layout> = JSON.parse(readFileSync(new URL("../data/keyboard-layouts/layouts.json", import.meta.url), "utf8"))
const PLAIN = 0
const SHIFTED = 1
const ALT_GRAPH = 2

const SHORTCUTS = Object.entries(KEYMAP).flatMap(([name, keys]) => alternatives(keys).filter((s) => s.key.length === 1).map((s) => ({ name, shortcut: s })))
const latinLayout = (layout: Layout) => [..."abcdefghijklmnopqrstuvwxyz"].every((letter) => Object.values(layout).some((levels) => levels[PLAIN] === letter))

function virtualKey(layout: Layout, code: string): number {
  const base = layout[code][PLAIN]
  if (/^[a-z]$/.test(base)) return base.toUpperCase().charCodeAt(0)
  const place = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code)
  if (place && !/^[\x20-\x7e]$/.test(base)) return (place[1] ?? place[2]).charCodeAt(0)
  return 0
}

function press(layout: Layout, code: string, level: number, platform: Platform, mod: boolean): KeyPress {
  const altGraph = level === ALT_GRAPH
  const typed = platform === "mac" && mod && !latinLayout(layout) ? LAYOUTS.us[code][level] : layout[code][level]
  return {
    key: typed || "Unidentified",
    code,
    keyCode: virtualKey(layout, code),
    ctrlKey: (platform === "pc" && mod) || altGraph,
    metaKey: platform === "mac" && mod,
    altKey: altGraph,
    shiftKey: level === SHIFTED,
    getModifierState: (name) => name === "AltGraph" && altGraph,
  }
}

const lexicalMatches = (e: KeyPress, s: Shortcut, platform: Platform) =>
  isExactShortcutMatch(e, s.key, { ctrlKey: platform === "pc" && !!s.mod, metaKey: platform === "mac" && !!s.mod, shiftKey: s.shift === "either" ? "any" : !!s.shift, altKey: !!s.alt })

function labelledKey(layout: Layout, key: string, level: number): string | undefined {
  const found = Object.keys(layout).find((code) => layout[code][level]?.toLowerCase() === key)
  if (found) return found
  if (/^[a-z]$/.test(key) && !latinLayout(layout)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key) && level === PLAIN) return `Digit${key}`
  return undefined
}

describe("shortcuts on 22 keyboard layouts, as libxkbcommon types them", () => {
  it("decide as Lexical's isExactShortcutMatch (Meta) does for every key, Shift level and AltGr press, and differ only where it misses the labelled key", () => {
    const disagreements: string[] = []
    const beyondLexical: string[] = []
    let presses = 0
    for (const [name, layout] of Object.entries(LAYOUTS)) {
      for (const platform of ["pc", "mac"] as const) {
        for (const { name: binding, shortcut } of SHORTCUTS) {
          for (const code of Object.keys(layout)) {
            for (const level of [PLAIN, SHIFTED, ALT_GRAPH]) {
              if (!layout[code][level] || (level === ALT_GRAPH && platform === "mac")) continue
              const e = press(layout, code, level, platform, level !== ALT_GRAPH && !!shortcut.mod)
              presses++
              const ours = matches(e, shortcut)
              if (ours === lexicalMatches(e, shortcut, platform)) continue
              const labelled = level !== ALT_GRAPH && labelledKey(layout, shortcut.key, level) === code
              if (ours && labelled) beyondLexical.push(`${platform} ${name} ${binding} ${code} ${JSON.stringify(e.key)}`)
              else disagreements.push(`${platform} ${name} ${binding} ${code} ${JSON.stringify(e.key)} ours=${ours}`)
            }
          }
        }
      }
    }
    expect.soft(presses, "presses compared").toBeGreaterThan(40_000)
    expect.soft(disagreements.slice(0, 10), `${disagreements.length} disagreements`).toEqual([])
    expect.soft(beyondLexical, "labelled keys Lexical misses and the keyCode fallback reaches").toEqual(["pc ara redo KeyZ \"~\"", "pc ara disassembly KeyD \"]\""])
  })

  it("fire on the key that carries the letter, digit or symbol on every layout, and on its US place where the layout has no Latin letters", () => {
    const missed: string[] = []
    for (const [name, layout] of Object.entries(LAYOUTS)) {
      for (const { name: binding, shortcut } of SHORTCUTS) {
        const levels = shortcut.shift === "either" ? [PLAIN, SHIFTED] : [shortcut.shift ? SHIFTED : PLAIN]
        const reachable = levels.map((level) => ({ level, code: labelledKey(layout, shortcut.key, level) })).filter((p) => p.code)
        if (!reachable.length) continue
        if (!reachable.some(({ code, level }) => matches(press(layout, code!, level, "pc", !!shortcut.mod), shortcut))) missed.push(`${name} ${binding} ${shortcut.key}`)
      }
    }
    expect.soft(missed, "shortcuts that no key on the layout reaches").toEqual([])
  })

  it("never fire on a character typed with AltGr", () => {
    const fired: string[] = []
    for (const [name, layout] of Object.entries(LAYOUTS)) {
      for (const code of Object.keys(layout)) {
        if (!layout[code][ALT_GRAPH] || layout[code][ALT_GRAPH] === layout[code][PLAIN]) continue
        const e = press(layout, code, ALT_GRAPH, "pc", false)
        for (const { name: binding, shortcut } of SHORTCUTS) if (matches(e, shortcut)) fired.push(`${name} ${code} ${JSON.stringify(e.key)} ${binding}`)
      }
    }
    expect.soft(fired, "AltGr presses taken for a shortcut").toEqual([])
  })

  it("answer the keys a Russian layout sent from real Chrome and Edge on Windows", () => {
    const ru = LAYOUTS.ru
    const windows: [string, string, string, boolean, Shortcut][] = [
      ["я", "KeyZ", "Ctrl+Я", false, KEYMAP.undo],
      ["ф", "KeyA", "Ctrl+Ф", false, KEYMAP.selectAll],
      ["Я", "KeyZ", "Ctrl+Shift+Я", true, KEYMAP.redo[0]],
      ["н", "KeyY", "Ctrl+Н", false, KEYMAP.redo[1]],
      ["в", "KeyD", "Ctrl+В", false, KEYMAP.duplicate],
      ["ы", "KeyS", "Ctrl+Ы", false, KEYMAP.save],
    ]
    for (const [key, code, label, shifted, shortcut] of windows) {
      expect.soft(ru[code][shifted ? SHIFTED : PLAIN], `libxkbcommon's ${code} on ru is what Windows sent`).toBe(key)
      expect.soft(matches(press(ru, code, shifted ? SHIFTED : PLAIN, "pc", true), shortcut), label).toBe(true)
    }
  })
})
