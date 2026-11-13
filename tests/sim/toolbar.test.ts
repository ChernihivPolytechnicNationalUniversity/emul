import { describe, expect, it } from "vitest"
import { alternatives, matchesAny, type KeyPress } from "@/lib/keys"
import { KEYMAP, keymapFor, labelFor } from "@/lib/keymap"
import { shortcutSections } from "@/lib/shortcut-list"
import { TOOL_GROUPS, TOOLS, WIRE_MODE_CHOICES, type ToolId } from "@/lib/tools"
import { DEFAULT_LINE_MODE, nextLineMode, type LineMode } from "@/schematic/wire-draw"

const press = (key: string, code: string, extra: Partial<KeyPress> = {}): KeyPress => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra })

describe("the main toolbar's content, as the model sets it (docs/emul-toolbar/model.md §5.5, §6)", () => {
  it("holds the six modes in three groups, in the conventional order: navigate, draw, measure", () => {
    expect.soft(TOOL_GROUPS.map((group) => group.map((tool) => tool.id)), "model §5.5").toEqual([["select", "hand"], ["wire", "join", "part"], ["probe"]])
    expect.soft(TOOLS.map((tool) => tool.id), "TOOLS is the groups flattened").toEqual(["select", "hand", "wire", "join", "part", "probe"])
  })

  it("keeps every group within Cowan's three to five chunks (constraint 4)", () => {
    for (const group of TOOL_GROUPS) expect.soft(group.length, group.map((t) => t.id).join("|")).toBeLessThanOrEqual(5)
  })

  it("gives each mode the key printed on its button, the one the field answers to (§5.3)", () => {
    const want: Record<ToolId, string> = { select: "V", hand: "H", wire: "W", join: "J", part: "A", probe: "M" }
    for (const tool of TOOLS) expect.soft(labelFor(tool.keys, "windows"), tool.id).toBe(want[tool.id])
    expect.soft(TOOLS.find((t) => t.id === "probe")!.keys, "Probe is the measure binding").toBe(KEYMAP.measure)
    expect.soft(alternatives(TOOLS.find((t) => t.id === "part")!.keys), "Add part answers to A as Quick Insert does").toContainEqual({ key: "a" })
  })

  it("names every mode in plain words and says what a press on the field does with it", () => {
    for (const tool of TOOLS) {
      expect.soft(tool.name.length, `${tool.id} has a name`).toBeGreaterThan(2)
      expect.soft(tool.hint.length, `${tool.id} has a hint for the strip`).toBeGreaterThan(10)
    }
  })

  it("never lets a mode key also mean a field command outside a wire's context", () => {
    const field = ["rotate", "rotateBack", "flipHorizontal", "flipVertical", "reroute", "scope", "logic", "zoomToSelection", "nextProblem", "undo", "redo", "selectAll", "duplicate", "find", "remove", "deselect"] as const
    for (const tool of TOOLS) {
      for (const shortcut of alternatives(tool.keys)) {
        const e = press(shortcut.key, `Key${shortcut.key.toUpperCase()}`, { shiftKey: shortcut.shift === true })
        for (const name of field) expect.soft(!!matchesAny(e, KEYMAP[name]), `${tool.id}'s ${shortcut.key} is not ${name}`).toBe(false)
      }
    }
    const ids = TOOLS.flatMap((t) => alternatives(t.keys).filter((s) => !s.mod).map((s) => s.key))
    expect.soft(new Set(ids).size, "no two modes share a plain key").toBe(ids.length)
  })

  it("answers to the key's place on a non-English layout, as every other field key does", () => {
    const wire = TOOLS.find((t) => t.id === "wire")!
    expect.soft(!!matchesAny(press("ц", "KeyW"), wire.keys), "Russian ЙЦУКЕН: Ц sits on W").toBe(true)
    const hand = TOOLS.find((t) => t.id === "hand")!
    expect.soft(!!matchesAny(press("р", "KeyH"), hand.keys), "Russian: Р sits on H").toBe(true)
  })
})

describe("the wire's three modes on the strip (model §5.2)", () => {
  it("offers the modes in the order Shift+Space steps through them, starting from the default", () => {
    const cycle: LineMode[] = [DEFAULT_LINE_MODE]
    while (cycle.length < 3) cycle.push(nextLineMode(cycle.at(-1)!))
    expect.soft(WIRE_MODE_CHOICES.map((c) => c.mode), "same order as Shift+Space").toEqual(cycle)
    expect.soft(nextLineMode(cycle[2]), "and Shift+Space wraps back to the first").toBe(cycle[0])
  })

  it("labels each mode the way the tag beside the pointer does, with a word for a screen reader", () => {
    expect.soft(WIRE_MODE_CHOICES.map((c) => c.short), "the tag's text").toEqual(["90°", "45°", "∠"])
    for (const c of WIRE_MODE_CHOICES) expect.soft(c.name.length, c.mode).toBeGreaterThan(3)
  })
})

describe("the keyboard shortcuts list (model §5.6, spec 6)", () => {
  const sections = shortcutSections("windows")
  const rows = sections.flatMap((s) => s.rows)
  const printed = rows.flatMap((r) => r.keys)

  it("lists every binding of KEYMAP, so the list cannot drift from what the app answers to", () => {
    const named = new Set(rows.map((r) => r.binding).filter(Boolean))
    const keymap = keymapFor("windows")
    for (const name of Object.keys(keymap)) expect.soft(named.has(name as keyof typeof keymap), `KEYMAP.${name}`).toBe(true)
  })

  it("lists the keys that only work inside the field and inside a wire being drawn", () => {
    for (const key of ["V", "H", "W", "J", "Shift+Space", "/", "Backspace", "Enter", "0–9", "Alt", "?"]) expect.soft(printed.some((p) => p.includes(key)), key).toBe(true)
  })

  it("prints every key in the platform's own spelling", () => {
    const mac = shortcutSections("apple").flatMap((s) => s.rows)
    expect.soft(mac.find((r) => r.binding === "undo")?.keys, "macOS undo").toEqual(["⌘Z"])
    expect.soft(rows.find((r) => r.binding === "undo")?.keys, "Windows undo").toEqual(["Ctrl+Z"])
  })

  it("groups the rows into sections with a title, none empty", () => {
    for (const s of sections) {
      expect.soft(s.title.length, "title").toBeGreaterThan(2)
      expect.soft(s.rows.length, s.title).toBeGreaterThan(0)
    }
  })

  it("opens on ? and is reachable from the field (KEYMAP.shortcuts)", () => {
    expect.soft(!!matchesAny(press("?", "Slash", { shiftKey: true }), KEYMAP.shortcuts), "Shift+/ on US types ?").toBe(true)
    expect.soft(!!matchesAny(press("?", "Comma", { shiftKey: true }), KEYMAP.shortcuts), "AZERTY types ? on Shift+,").toBe(true)
  })
})
