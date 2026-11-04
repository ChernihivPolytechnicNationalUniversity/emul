import { describe, expect, it } from "vitest"
import { catalogue } from "@/schematic/registry"
import { searchParts, similarParts } from "@/components/palette/search"
import { hitEntries } from "@/components/palette/items"
import {
  opensQuickInsert,
  panelPosition,
  pickableRows,
  PANEL_GAP,
  PANEL_MARGIN,
  QUICK_RECENT,
  QUICK_START,
  quickKey,
  quickSections,
  typed,
  type KeyLike,
  type QuickOutcome,
  type QuickState,
} from "@/components/palette/quick-insert"

// Quick Insert from the keyboard alone: open it, type, walk the rows, place, place more, close.

const key = (k: string, mods: Omit<KeyLike, "key"> = {}): KeyLike => ({ key: k, ...mods })

/** A student at the keyboard: each key either moves the panel's state or ends in a part placed or the panel closed. */
function session(recent: string[] = [], favourites: string[] = []) {
  let state: QuickState = QUICK_START
  let open = true
  const placed: { id: string; keepOpen: boolean }[] = []
  const press = (e: KeyLike): QuickOutcome => {
    if (!open) throw new Error("the panel is closed")
    const out = quickKey(state, e, pickableRows(state.query, recent, favourites))
    if (out.kind === "close") open = false
    if (out.kind === "state" || out.kind === "place") state = out.state
    if (out.kind === "place") {
      placed.push({ id: out.entry.def.id, keepOpen: out.keepOpen })
      if (!out.keepOpen) open = false
    }
    return out
  }
  return {
    type: (q: string) => void (state = typed(q)),
    press,
    placed,
    get state() {
      return state
    },
    get open() {
      return open
    },
  }
}

describe("the shortcuts that open Quick Insert", () => {
  it("are A on the bench and Ctrl+K or ⌘K", () => {
    expect(opensQuickInsert(key("a"), "field")).toBe(true)
    expect(opensQuickInsert(key("A"), "field")).toBe(true)
    expect(opensQuickInsert(key("k", { ctrlKey: true }), "field")).toBe(true)
    expect(opensQuickInsert(key("k", { metaKey: true }), "field")).toBe(true)
  })

  it("leave A to a text field, but Ctrl+K opens from one", () => {
    expect(opensQuickInsert(key("a"), "text")).toBe(false)
    expect(opensQuickInsert(key("k", { ctrlKey: true }), "text")).toBe(true)
  })

  it("leave both to the code editor, whose Ctrl+K starts its own chords", () => {
    expect(opensQuickInsert(key("a"), "code")).toBe(false)
    expect(opensQuickInsert(key("k", { ctrlKey: true }), "code")).toBe(false)
    expect(opensQuickInsert(key("k", { metaKey: true }), "code")).toBe(false)
  })

  it("leave select-all and the other chords alone", () => {
    expect(opensQuickInsert(key("a", { ctrlKey: true }), "field")).toBe(false)
    expect(opensQuickInsert(key("a", { metaKey: true }), "field")).toBe(false)
    expect(opensQuickInsert(key("A", { shiftKey: true }), "field")).toBe(false)
    expect(opensQuickInsert(key("a", { altKey: true }), "field")).toBe(false)
    expect(opensQuickInsert(key("k", { ctrlKey: true, shiftKey: true }), "field")).toBe(false)
    expect(opensQuickInsert(key("k"), "field")).toBe(false)
  })
})

describe("Quick Insert at the keyboard", () => {
  it("places the best match with Enter and closes", () => {
    const s = session()
    s.type("ne555")
    expect(s.press(key("Enter")).kind).toBe("place")
    expect(s.placed).toEqual([{ id: "ne555", keepOpen: false }])
    expect(s.open).toBe(false)
  })

  it("finds what the palette finds, in the same order", () => {
    for (const q of ["led", "lcd i2c", "stm32", "ws2812", "timer 555"]) {
      const palette = hitEntries(searchParts(catalogue, q)).map((r) => r.def.id)
      expect(palette.length, q).toBeGreaterThan(0)
      expect(pickableRows(q, [], []).map((r) => r.def.id), q).toEqual(palette)
    }
  })

  it("offers similar parts when nothing matches every word, as the palette does", () => {
    const similar = hitEntries(similarParts(catalogue, "regulator 3.3")).map((r) => r.def.id)
    expect(searchParts(catalogue, "regulator 3.3")).toEqual([])
    expect(similar.length).toBeGreaterThan(0)
    expect(pickableRows("regulator 3.3", [], []).map((r) => r.def.id)).toEqual(similar)
  })

  it("walks the rows with the arrows, round from the last to the first", () => {
    const s = session()
    s.type("led")
    const rows = pickableRows("led", [], [])
    expect(rows.length).toBeGreaterThan(2)
    s.press(key("ArrowDown"))
    s.press(key("ArrowDown"))
    expect(s.state.selected).toBe(2)
    s.press(key("ArrowUp"))
    s.press(key("ArrowUp"))
    s.press(key("ArrowUp"))
    expect(s.state.selected).toBe(rows.length - 1)
    s.press(key("ArrowDown"))
    expect(s.state.selected).toBe(0)
    s.press(key("ArrowDown"))
    s.press(key("Enter"))
    expect(s.placed[0]!.id).toBe(rows[1]!.def.id)
  })

  it("pages through a long list without wrapping", () => {
    const s = session()
    s.type("stm32")
    const n = pickableRows("stm32", [], []).length
    expect(n).toBeGreaterThan(8)
    s.press(key("PageUp"))
    expect(s.state.selected).toBe(0)
    for (let i = 0; i < 50; i++) s.press(key("PageDown"))
    expect(s.state.selected).toBe(n - 1)
  })

  it("places more with Shift+Enter and stays open for the next", () => {
    const s = session()
    s.type("resistor")
    s.press(key("Enter", { shiftKey: true }))
    s.press(key("Enter", { shiftKey: true }))
    expect(s.open).toBe(true)
    s.type("led")
    s.press(key("Enter"))
    expect(s.placed.map((p) => p.id)).toEqual(["resistor", "resistor", "led"])
    expect(s.open).toBe(false)
  })

  it("starts each new query at its best match", () => {
    const s = session()
    s.type("led")
    s.press(key("ArrowDown"))
    s.press(key("ArrowDown"))
    s.type("ne555")
    expect(s.state.selected).toBe(0)
  })

  it("clears the query with Escape, then closes", () => {
    const s = session()
    s.type("led")
    s.press(key("ArrowDown"))
    s.press(key("Escape"))
    expect(s.state).toEqual(QUICK_START)
    expect(s.open).toBe(true)
    s.press(key("Escape"))
    expect(s.open).toBe(false)
    expect(s.placed).toEqual([])
  })

  it("places nothing when nothing matches, and lets the box have the key", () => {
    const s = session()
    s.type("zzzzqqqq")
    expect(s.press(key("Enter")).kind).toBe("pass")
    expect(s.press(key("ArrowDown")).kind).toBe("state")
    expect(s.placed).toEqual([])
  })

  it("leaves typing and Ctrl+Enter to the box", () => {
    const s = session()
    s.type("led")
    for (const k of [key("l"), key("Backspace"), key("ArrowLeft"), key("Home"), key("Tab"), key("Enter", { ctrlKey: true })]) expect(s.press(k).kind, k.key).toBe("pass")
  })

  it("offers favourites, then recent parts, before anything is typed", () => {
    const s = session(["led", "resistor", "ne555"], ["resistor", "pushbutton"])
    expect(pickableRows("", ["led", "resistor", "ne555"], ["resistor", "pushbutton"]).map((r) => r.def.id)).toEqual(["resistor", "pushbutton", "led", "ne555"])
    s.press(key("ArrowDown"))
    s.press(key("ArrowDown"))
    s.press(key("Enter"))
    expect(s.placed).toEqual([{ id: "led", keepOpen: false }])
  })
})

describe("the blank query's lists", () => {
  it("list each part once, favourites first, and drop parts that are gone", () => {
    const sections = quickSections(["led", "gone-part", "resistor"], ["resistor"])
    expect(sections.map((s) => [s.label, s.entries.map((e) => e.def.id)])).toEqual([
      ["Favourites", ["resistor"]],
      ["Recent", ["led"]],
    ])
  })

  it("keep the recent list short and leave out an empty one", () => {
    const ids = catalogue.slice(0, QUICK_RECENT + 4).map((d) => d.id)
    const sections = quickSections(ids, [])
    expect(sections).toHaveLength(1)
    expect(sections[0]!.entries).toHaveLength(QUICK_RECENT)
    expect(quickSections([], [])).toEqual([])
  })
})

describe("where the panel stands", () => {
  const bench = { left: 300, top: 30, right: 1500, bottom: 900 }
  const panel = { width: 320, height: 400 }

  it("to the right of the point, a little above it, the ghost in sight", () => {
    expect(panelPosition({ x: 600, y: 300 }, panel, bench)).toEqual({ left: 600 + PANEL_GAP, top: 300 - PANEL_GAP })
  })

  it("to its left near the bench's right edge", () => {
    expect(panelPosition({ x: 1400, y: 300 }, panel, bench)).toEqual({ left: 1400 - PANEL_GAP - panel.width, top: 300 - PANEL_GAP })
  })

  it("inside the bench near its top and bottom", () => {
    expect(panelPosition({ x: 600, y: 35 }, panel, bench).top).toBe(bench.top + PANEL_MARGIN)
    expect(panelPosition({ x: 600, y: 890 }, panel, bench).top).toBe(bench.bottom - PANEL_MARGIN - panel.height)
  })

  it("inside a bench too narrow to hold it beside the point", () => {
    const narrow = { left: 0, top: 0, right: 360, bottom: 640 }
    const at = panelPosition({ x: 180, y: 300 }, panel, narrow)
    expect(at.left).toBeGreaterThanOrEqual(PANEL_MARGIN)
    expect(at.left + panel.width).toBeLessThanOrEqual(narrow.right - PANEL_MARGIN)
  })
})
