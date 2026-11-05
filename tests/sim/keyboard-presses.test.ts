import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { alternatives, matches, type KeyPress, type Keys } from "@/lib/keys"
import { keymapFor } from "@/lib/keymap"
import type { Platform } from "@/lib/platform"

type Recorded = [key: string, code: string, keyCode: number, modifiers: string, outcome?: "prevented" | "open"]
type Row = { key: Recorded | null; reactions: string[]; pointer?: string[] }
type Fixture = {
  machines: Record<string, string[]>
  browsers: Record<string, { userAgent: string; platform: string; uaDataPlatform: string | null; maxTouchPoints: number }>
  presses: Record<string, Record<string, Partial<Record<"cancel" | "pass", Row>>>>
  layouts: Record<string, Record<string, Recorded>>
}

const DATA: Fixture = JSON.parse(readFileSync(new URL("../data/keyboard-platforms/presses.json", import.meta.url), "utf8"))
const LAYOUTS: Record<string, Record<string, string[]>> = JSON.parse(readFileSync(new URL("../data/keyboard-layouts/layouts.json", import.meta.url), "utf8"))

const platformOf = (machine: string): Platform => (machine.startsWith("macOS") ? "apple" : machine.startsWith("Windows") ? "windows" : "linux")

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

function decide(recorded: Recorded, platform: Platform): string[] {
  const fired = Object.entries(keymapFor(platform)).filter(([, keys]) => alternatives(keys as Keys).some((s) => matches(pressOf(recorded), s, platform)))
  return fired.map(([name]) => name).sort()
}

const BY_PRESS: Record<string, Partial<Record<Platform, string[]>> & { all?: string[] }> = {
  "mod-z": { all: ["undo"] },
  "mod-shift-z": { all: ["redo"] },
  "mod-y": { all: ["redo"] },
  "mod-a": { all: ["selectAll"] },
  "mod-s": { all: ["save"] },
  "mod-o": { all: ["open"] },
  "mod-shift-o": { all: ["projects"] },
  "mod-d": { all: ["duplicate"] },
  "mod-shift-d": { all: ["disassembly"] },
  "mod-j": { all: ["code"] },
  "mod-b": { all: ["sidebar"] },
  "mod-equal": { all: ["zoomIn"] },
  "mod-minus": { all: ["zoomOut"] },
  "mod-0": { all: ["zoomReset"] },
  f5: { all: ["continue"] },
  "mod-shift-f5": { all: ["restart"] },
  f9: { all: ["toggleBreakpoint"] },
  f10: { all: ["stepOver"] },
  "mod-f10": { all: ["runToCursor"] },
  f11: { all: ["stepInto"] },
  "shift-f11": { all: ["stepOut"] },
  "alt-f11": { all: ["stepInstruction"] },
  backspace: { all: ["remove"] },
  delete: { all: ["deleteFile", "remove"] },
  "mod-backspace": { apple: ["deleteFile"], all: [] },
  "alt-backspace": { all: [] },
  escape: { all: ["deselect"] },
  "ctrl-z": { all: [] },
  "ctrl-a": { all: [] },
  "ctrl-j": { all: [] },
  "ctrl-b": { all: [] },
  "ctrl-meta-z": { all: [] },
  "meta-z": { all: [] },
  "meta-b": { all: [] },
}

const machines = Object.keys(DATA.presses)

describe("real presses of emul's shortcuts on Windows, Linux and macOS", () => {
  it("were recorded from Safari, Chrome and Firefox on macOS 15 and 26, Chrome, Edge and Firefox on Windows, and Chrome and Firefox on Linux", () => {
    expect.soft(machines.sort(), "machines").toEqual([
      "Linux chrome", "Linux firefox", "Linux firefox-rfp",
      "Windows chrome", "Windows edge", "Windows firefox",
      "macOS 15 chrome", "macOS 15 firefox", "macOS 15 safari", "macOS 26 chrome", "macOS 26 firefox", "macOS 26 safari",
    ])
  })

  it("fire the shortcut each press means on its own platform, Cmd on a Mac and Ctrl elsewhere, and nothing for Control on a Mac or Windows, Super or Meta elsewhere", () => {
    const wrong: string[] = []
    let checked = 0
    for (const machine of machines) {
      const platform = platformOf(machine)
      for (const [id, modes] of Object.entries(DATA.presses[machine])) {
        const key = modes.cancel?.key
        const want = BY_PRESS[id]
        if (!key || !want) continue
        checked++
        const expected = [...(want[platform] ?? want.all ?? [])].sort()
        const got = decide(key, platform)
        if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${machine} ${id} ${JSON.stringify(key)}: [${got}] instead of [${expected}]`)
      }
    }
    expect.soft(checked, "presses checked").toBeGreaterThan(150)
    expect.soft(wrong, "presses that fired the wrong shortcut").toEqual([])
  })

  it("reach the page, and once it cancels them the browser does nothing of its own: no reload, no full screen, no dialog, no new tab, no zoom (a bar sliding in above the page only changes its height)", () => {
    const leaked: string[] = []
    for (const machine of machines) {
      for (const [id, modes] of Object.entries(DATA.presses[machine])) {
        const row = modes.cancel
        if (!row || !(id in BY_PRESS)) continue
        if (!row.key) leaked.push(`${machine} ${id}: never reached the page`)
        else if (row.key[4] !== "prevented" || row.reactions.some((r) => r !== "toolbar")) leaked.push(`${machine} ${id}: ${row.reactions.join(",")}`)
      }
    }
    const macOSShowsTheDesktop = ["15", "26"].flatMap((v) => ["chrome", "firefox", "safari"].map((b) => `macOS ${v} ${b} f11: never reached the page`))
    const safariOpensAFile = ["15", "26"].map((v) => `macOS ${v} safari mod-o: never reached the page`)
    expect.soft(leaked.sort(), "cancelled presses the browser acted on anyway: only F11 on a Mac (Show Desktop) and Safari's Command-O").toEqual([...macOSShowsTheDesktop, ...safariOpensAFile].sort())
  })

  it("show the browser's own action for the same keys when the page lets them through, so each cancel above is a real one", () => {
    const acted = (machine: string, id: string) => (DATA.presses[machine]?.[id]?.pass?.reactions.length ?? 0) > 0
    for (const system of ["Windows", "Linux"]) {
      const browsers = machines.filter((m) => m.startsWith(system) && !m.endsWith("rfp"))
      for (const id of ["f5", "f10", "f11", "mod-s", "mod-o", "mod-d", "mod-j", "mod-equal", "mod-minus", "mod-shift-d", "mod-shift-o"]) {
        expect.soft(browsers.some((m) => acted(m, id)), `${system} ${id}`).toBe(true)
      }
    }
  })
})

const LAYOUT_OF: Record<string, string> = { ru: "ru", ua: "ua", de: "de", fr: "fr", "us-dvorak": "us:dvorak", gr: "gr" }
const INTENT: Record<string, string[]> = {
  "Ctrl+Z": ["undo"], "Ctrl+Shift+Z": ["redo"], "Ctrl+Y": ["redo"], "Ctrl+A": ["selectAll"], "Ctrl+D": ["duplicate"], "Ctrl+Shift+D": ["disassembly"],
  "Ctrl+Shift+O": ["projects"], "Ctrl+J": ["code"], "Ctrl+B": ["sidebar"], "Ctrl+0": ["zoomReset"], "Ctrl+=": ["zoomIn"], "Ctrl+-": ["zoomOut"],
  M: ["measure"], O: ["scope"], L: ["logic"], R: ["rotate"], "Shift+R": ["rotateBack"], X: ["flipHorizontal"], Y: ["flipVertical"], C: [], "Ctrl+O": ["open"], "Ctrl+S": ["save"],
}
const layoutGroups = Object.entries(DATA.layouts).map(([name, presses]) => {
  const [machine, layout] = name.split("|")
  return { machine, layout, presses }
})

describe("real layouts on Linux, switched with setxkbmap on a real X server", () => {
  it("type what libxkbcommon's model of each layout says, in Chrome and in Firefox", () => {
    const differ: string[] = []
    for (const { machine, layout, presses } of layoutGroups.filter((g) => !g.machine.endsWith("rfp"))) {
      const model = LAYOUTS[LAYOUT_OF[layout]]
      for (const [label, [key, code, , modifiers]] of Object.entries(presses)) {
        const want = model[code]?.[modifiers.includes("s") ? 1 : 0]
        if (key !== want) differ.push(`${machine} ${layout} ${label} ${code}: ${JSON.stringify(key)}, model ${JSON.stringify(want)}`)
      }
    }
    expect.soft(differ, "presses that differ from the model").toEqual([])
  })

  it("were recorded in full: every shortcut on all six layouts in all three browsers", () => {
    const incomplete = layoutGroups.filter((g) => Object.keys(g.presses).sort().join() !== Object.keys(INTENT).sort().join()).map((g) => `${g.machine} ${g.layout}`)
    expect.soft(layoutGroups.length, "layout runs").toBe(18)
    expect.soft(incomplete, "layout runs missing a press").toEqual([])
  })

  it("fire what each key means on every layout, in both browsers", () => {
    const wrong: string[] = []
    for (const { machine, layout, presses } of layoutGroups.filter((g) => !g.machine.endsWith("rfp"))) {
      for (const [label, recorded] of Object.entries(presses)) {
        const got = decide(recorded, "linux").filter((name) => name !== "deleteFile")
        if (JSON.stringify(got) !== JSON.stringify([...INTENT[label]].sort())) wrong.push(`${machine} ${layout} ${label} ${JSON.stringify(recorded)}: [${got}]`)
      }
    }
    expect.soft(wrong, "presses that fired the wrong shortcut").toEqual([])
  })

  it("lose a non-Latin letter's place under Firefox's resistFingerprinting, so only digits and symbols still work there", () => {
    const ru = DATA.layouts["Linux firefox-rfp|ru"]
    expect.soft(ru["Ctrl+Z"].slice(0, 3), "Ctrl+Я arrives without its code and keyCode").toEqual(["я", "", 0])
    expect.soft(decide(ru["Ctrl+Z"], "linux"), "so it undoes nothing").toEqual([])
    expect.soft(decide(ru["Ctrl+0"], "linux"), "Ctrl+0 still resets the zoom").toEqual(["zoomReset"])
    const fr = DATA.layouts["Linux firefox-rfp|fr"]
    expect.soft(decide(fr["Ctrl+Z"], "linux"), "AZERTY's Z, typed as z, still undoes").toEqual(["undo"])
  })
})
