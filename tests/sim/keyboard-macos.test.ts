import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { alternatives, matches, type KeyPress, type Keys } from "@/lib/keys"
import { keymapFor } from "@/lib/keymap"
import { wireColorFor } from "@/schematic/wire-colors"

type Recorded = [key: string, code: string, keyCode: number, modifiers: string]
type Fixture = { machines: Record<string, string[]>; presses: Record<string, Record<string, Recorded>> }

const DATA: Fixture = JSON.parse(readFileSync(new URL("../data/keyboard-macos/presses.json", import.meta.url), "utf8"))
const SHORTCUTS = Object.entries(keymapFor("apple")).flatMap(([name, keys]) => alternatives(keys as Keys).map((shortcut) => ({ name, shortcut })))

const pressOf = ([key, code, keyCode, modifiers]: Recorded): KeyPress => ({
  key,
  code,
  keyCode,
  shiftKey: modifiers.includes("s"),
  metaKey: modifiers.includes("m"),
  ctrlKey: modifiers.includes("c"),
  altKey: modifiers.includes("a"),
  getModifierState: (name) => name === "AltGraph" && modifiers.includes("g"),
})
const decide = (recorded: Recorded) => [...new Set(SHORTCUTS.filter(({ shortcut }) => matches(pressOf(recorded), shortcut, "apple")).map(({ name }) => name))].sort()

const INTENT: Record<string, string[]> = {
  "Cmd+Z": ["undo"], "Cmd+Shift+Z": ["redo"], "Cmd+Y": ["redo"], "Cmd+A": ["selectAll"], "Cmd+D": ["duplicate"], "Cmd+Shift+D": ["disassembly"],
  "Cmd+Shift+O": ["projects"], "Cmd+J": ["code"], "Cmd+B": ["sidebar"], "Cmd+0": ["zoomReset"], "Cmd+=": ["zoomIn"], "Cmd+-": ["zoomOut"],
  M: ["measure"], O: ["scope"], L: ["logic"], R: ["rotate"], "Shift+R": ["rotateBack"], X: ["flipHorizontal"], Y: ["flipVertical"], C: [], "Option+M": [],
  "Cmd+O": ["open"], "Cmd+S": ["save"],
}

const MACOS_READS_IT_OTHERWISE: Record<string, string[]> = {
  German: ["Cmd+="],
  SwissGerman: ["Cmd+="],
  "Turkish-QWERTY-PC": ["Cmd+="],
  Polish: ["Cmd+="],
  Bulgarian: ["Cmd+="],
  "Georgian-QWERTY": ["Cmd+=", "Cmd+-"],
}
const FIREFOX_TYPES_THE_LATIN_LAYOUT = { layout: "Georgian-QWERTY", label: "M" }

function expected(layout: string, label: string, recorded: Recorded): string[] | undefined {
  if (!(label in INTENT) || MACOS_READS_IT_OTHERWISE[layout]?.includes(label)) return undefined
  const press = pressOf(recorded)
  if (press.metaKey && /^Key/.test(press.code) && /^[a-z]$/i.test(press.key)) {
    const letter = press.key.toLowerCase()
    return [...new Set(SHORTCUTS.filter(({ shortcut: s }) => s.mod && !s.alt && (s.shift === "either" || !!s.shift === press.shiftKey) && s.key === letter).map(({ name }) => name))].sort()
  }
  return [...INTENT[label]].sort()
}

const groups = Object.entries(DATA.presses).map(([name, presses]) => {
  const [os, browser, layout] = name.split("|")
  return { os, browser, layout, presses }
})

describe("real key presses on macOS 15 and 26, in Safari, Chrome and Firefox, on 26 layouts", () => {
  it("were recorded from all three browsers on both systems", () => {
    expect.soft(Object.keys(DATA.machines).sort(), "machines").toEqual(["macOS 15 chrome", "macOS 15 firefox", "macOS 15 safari", "macOS 26 chrome", "macOS 26 firefox", "macOS 26 safari"])
    expect.soft(groups.reduce((n, g) => n + Object.keys(g.presses).length, 0), "presses").toBeGreaterThan(3500)
  })

  it("fire what the key means to macOS, the same shortcut a native Mac app would run", () => {
    const wrong: string[] = []
    let checked = 0
    for (const { os, browser, layout, presses } of groups) {
      for (const [label, recorded] of Object.entries(presses)) {
        if (browser === "firefox" && layout === FIREFOX_TYPES_THE_LATIN_LAYOUT.layout && label === FIREFOX_TYPES_THE_LATIN_LAYOUT.label) continue
        const want = expected(layout, label, recorded)
        if (!want) continue
        const got = decide(recorded)
        checked++
        if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${os} ${browser} ${layout} ${label}: ${JSON.stringify(recorded)} fired [${got}] instead of [${want}]`)
      }
    }
    expect.soft(checked, "presses checked").toBeGreaterThan(3000)
    expect.soft(wrong.slice(0, 12), `${wrong.length} presses fired the wrong shortcut`).toEqual([])
  })

  it("decide each physical press the same way in every browser", () => {
    const differing: string[] = []
    const byPress = new Map<string, Map<string, string>>()
    for (const { os, browser, layout, presses } of groups) {
      for (const [label, recorded] of Object.entries(presses)) {
        const id = `${os} ${layout} ${label}`
        if (!byPress.has(id)) byPress.set(id, new Map())
        byPress.get(id)!.set(browser, decide(recorded).join(","))
      }
    }
    for (const [id, decisions] of byPress) if (decisions.size > 1 && new Set(decisions.values()).size > 1) differing.push(`${id}: ${[...decisions].map(([b, d]) => `${b}=[${d}]`).join(" ")}`)
    expect.soft(differing, "presses decided differently between browsers").toEqual(["macOS 15 Georgian-QWERTY M: chrome=[measure] firefox=[] safari=[measure]"])
  })

  it("show what Cmd does to a non-Latin layout: the Latin letter, and the layout's own letter once Control joins in", () => {
    for (const browser of ["safari", "chrome", "firefox"]) {
      const russian = DATA.presses[`macOS 15|${browser}|Russian`]
      expect.soft(russian["Cmd+Z"][0], `${browser}: Cmd on the Я key`).toBe("z")
      expect.soft(decide(russian["Cmd+Z"]), `${browser}: Cmd+Я undoes`).toEqual(["undo"])
      expect.soft(russian["Ctrl+Cmd+Z"][0], `${browser}: Ctrl+Cmd on the Я key`).toBe("я")
    }
  })

  it("paint wires cyan on the key printed C, whatever the layout", () => {
    const missed = groups.filter((g) => g.presses.C && wireColorFor(pressOf(g.presses.C)) !== "cyan").map((g) => `${g.os} ${g.browser} ${g.layout}`)
    expect.soft(missed, "C presses that are not cyan").toEqual([])
  })
})
