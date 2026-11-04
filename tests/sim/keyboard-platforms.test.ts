import { readFileSync } from "node:fs"
import vm from "node:vm"
import { describe, expect, it } from "vitest"
import { alternatives, matches, matchesAny, shortcutLabel, type KeyPress, type Keys, type Shortcut } from "@/lib/keys"
import { keymapFor, labelFor, stopUnlessAppCommand } from "@/lib/keymap"
import { detectPlatform, type Platform, type PlatformHints } from "@/lib/platform"
import { addsToSelection, opensContextMenu, primaryClick, wheelZooms } from "@/lib/pointer"

type Browser = { name: string; hints: PlatformHints & { platform: string }; is: Platform }

const CHROME = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
const SAFARI = "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
const browser = (name: string, userAgent: string, platform: string, is: Platform, extra: Partial<PlatformHints> = {}): Browser => ({ name, hints: { userAgent, platform, maxTouchPoints: 0, ...extra }, is })

const BROWSERS: Browser[] = [
  browser("Chrome on Windows", `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`, "Win32", "windows", { userAgentData: { platform: "Windows" } }),
  browser("Edge on Windows", `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME} Edg/156.0.0.0`, "Win32", "windows", { userAgentData: { platform: "Windows" }, maxTouchPoints: 10 }),
  browser("Firefox on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0", "Win32", "windows"),
  browser("Chrome on macOS", `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}`, "MacIntel", "apple", { userAgentData: { platform: "macOS" } }),
  browser("Safari on macOS", `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${SAFARI}`, "MacIntel", "apple"),
  browser("Firefox on macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0", "MacIntel", "apple"),
  browser("Chrome on Linux", `Mozilla/5.0 (X11; Linux x86_64) ${CHROME}`, "Linux x86_64", "linux", { userAgentData: { platform: "Linux" } }),
  browser("Firefox on Linux", "Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0", "Linux x86_64", "linux"),
  browser("Chrome on ChromeOS", `Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) ${CHROME}`, "Linux x86_64", "chromeos", { userAgentData: { platform: "Chrome OS" } }),
  browser("Chrome on Android", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36", "Linux armv81", "linux", { userAgentData: { platform: "Android" }, maxTouchPoints: 5 }),
  browser("Safari on iPadOS, desktop website (the default)", `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${SAFARI}`, "MacIntel", "apple", { maxTouchPoints: 5 }),
  browser("Safari on iPadOS, mobile website", "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1", "iPad", "apple", { maxTouchPoints: 5 }),
  browser("Safari on iOS", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1", "iPhone", "apple", { maxTouchPoints: 5 }),
  browser("Firefox with resistFingerprinting on macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0", "MacIntel", "apple"),
  browser("Firefox with resistFingerprinting on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0", "Win32", "windows", { maxTouchPoints: 10 }),
  browser("Firefox with resistFingerprinting on Linux", "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "Linux x86_64", "linux", { maxTouchPoints: 5 }),
  browser("nothing to go by", "", "", "linux"),
]

const MONACO_PLATFORM = readFileSync(new URL("../../node_modules/monaco-editor/esm/vs/base/common/platform.js", import.meta.url), "utf8")
  .replace(/^import .*$/m, "const getNLSLanguage = () => undefined;")
  .replace(/^export \{[^}]*\};?$/m, "")
const MONACO_MAC = 2

function monacoOperatingSystem(hints: Browser["hints"]): number {
  return vm.runInNewContext(`${MONACO_PLATFORM}\n;OS`, { navigator: { ...hints, language: "en-US" } })
}

const PLATFORMS: Platform[] = ["apple", "windows", "linux", "chromeos"]

describe("the platform", () => {
  it("is read the same way Monaco reads it, so the field and the code editor take the same command key", () => {
    for (const b of BROWSERS) {
      expect.soft(detectPlatform(b.hints), b.name).toBe(b.is)
      expect.soft(detectPlatform(b.hints) === "apple", `${b.name}: Monaco's own platform.js`).toBe(monacoOperatingSystem(b.hints) === MONACO_MAC)
    }
  })
})

type Chord = { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
const CHORDS: Chord[] = Array.from({ length: 16 }, (_, i) => ({ ctrlKey: !!(i & 1), metaKey: !!(i & 2), altKey: !!(i & 4), shiftKey: !!(i & 8) }))
const describeChord = (c: Chord) => [c.ctrlKey && "Ctrl", c.metaKey && "Meta", c.altKey && "Alt", c.shiftKey && "Shift"].filter(Boolean).join("+") || "plain"

function pressFor(shortcut: Shortcut, chord: Chord): KeyPress {
  const key = shortcut.key.length === 1 && chord.shiftKey ? shortcut.key.toUpperCase() : shortcut.key
  const code = /^[a-z]$/.test(shortcut.key) ? `Key${shortcut.key.toUpperCase()}` : /^[0-9]$/.test(shortcut.key) ? `Digit${shortcut.key}` : shortcut.key
  return { key, code, ...chord, getModifierState: () => false }
}

function commandChord(shortcut: Shortcut, platform: Platform, shift: boolean): Chord {
  const command = !!shortcut.mod
  return { ctrlKey: command && platform !== "apple", metaKey: command && platform === "apple", altKey: !!shortcut.alt, shiftKey: shift }
}

describe("a shortcut takes the platform's own command key", () => {
  it("fires on exactly the modifiers its binding names, with Cmd on a Mac and Ctrl elsewhere, and on no other of the 16 combinations", () => {
    const wrong: string[] = []
    for (const platform of PLATFORMS) {
      for (const [name, keys] of Object.entries(keymapFor(platform))) {
        for (const shortcut of alternatives(keys as Keys)) {
          const shifts = shortcut.shift === "either" ? [false, true] : [!!shortcut.shift]
          const want = new Set(shifts.map((shift) => describeChord(commandChord(shortcut, platform, shift))))
          const got = new Set(CHORDS.filter((chord) => matches(pressFor(shortcut, chord), shortcut, platform)).map(describeChord))
          if ([...want].sort().join() !== [...got].sort().join()) wrong.push(`${platform} ${name} ${shortcut.key}: fires on [${[...got]}], wants [${[...want]}]`)
        }
      }
    }
    expect.soft(wrong, "bindings that fire on other modifiers").toEqual([])
  })

  it("leaves Control on a Mac to the system's own text commands, and Windows, Super or Search to the system elsewhere", () => {
    const z = (mods: Partial<KeyPress>) => ({ key: "z", code: "KeyZ", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
    expect.soft(matchesAny(z({ metaKey: true }), keymapFor("apple").undo, "apple"), "Cmd+Z undoes on a Mac").toBeTruthy()
    expect.soft(matchesAny(z({ ctrlKey: true }), keymapFor("apple").undo, "apple"), "Ctrl+Z does not").toBeFalsy()
    expect.soft(matchesAny(z({ ctrlKey: true, metaKey: true }), keymapFor("apple").undo, "apple"), "nor does Ctrl+Cmd+Z").toBeFalsy()
    for (const platform of ["windows", "linux", "chromeos"] as const) {
      expect.soft(matchesAny(z({ ctrlKey: true }), keymapFor(platform).undo, platform), `Ctrl+Z undoes on ${platform}`).toBeTruthy()
      expect.soft(matchesAny(z({ metaKey: true }), keymapFor(platform).undo, platform), `Meta+Z does not on ${platform}`).toBeFalsy()
      expect.soft(matchesAny(z({ ctrlKey: true, metaKey: true }), keymapFor(platform).undo, platform), `nor Ctrl+Meta+Z on ${platform}`).toBeFalsy()
    }
  })
})

describe("Option on a Mac", () => {
  it("is Option even where Firefox also reports it as AltGraph, so ⌥F11 steps one instruction there too", () => {
    const optionF11 = { key: "F11", code: "F11", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, getModifierState: (m: string) => m === "AltGraph" }
    expect.soft(matchesAny(optionF11, keymapFor("apple").stepInstruction, "apple"), "Firefox on macOS").toBeTruthy()
    expect.soft(matchesAny({ ...optionF11, key: "µ", code: "KeyM" }, keymapFor("apple").measure, "apple"), "while Option+M, which types µ, is still not M").toBeFalsy()
    expect.soft(matchesAny({ ...optionF11, altKey: false }, keymapFor("linux").stepInstruction, "linux"), "AltGr on Linux is still never Alt").toBeFalsy()
  })
})

describe("each platform's own keys", () => {
  const letter = (key: string, mods: Partial<KeyPress>) => ({ key, code: `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
  const named = (key: string, mods: Partial<KeyPress> = {}) => ({ key, code: key === "Backspace" ? "Backspace" : key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

  it("redo with Shift-Command-Z first on a Mac, Ctrl+Y first on Windows, Ctrl+Shift+Z first on Linux and ChromeOS, and with both chords everywhere", () => {
    const mac = keymapFor("apple").redo
    expect.soft(matchesAny(letter("Z", { metaKey: true, shiftKey: true }), mac, "apple"), "⇧⌘Z").toBeTruthy()
    expect.soft(matchesAny(letter("y", { metaKey: true }), mac, "apple"), "⌘Y still redoes, as emul always did, so Safari never leaves the page for its History").toBeTruthy()
    for (const platform of ["windows", "linux", "chromeos"] as const) {
      const redo = keymapFor(platform).redo
      expect.soft(matchesAny(letter("y", { ctrlKey: true }), redo, platform), `Ctrl+Y on ${platform}`).toBeTruthy()
      expect.soft(matchesAny(letter("Z", { ctrlKey: true, shiftKey: true }), redo, platform), `Ctrl+Shift+Z on ${platform}`).toBeTruthy()
    }
    expect.soft(PLATFORMS.map((p) => labelFor(keymapFor(p).redo, p)), "printed").toEqual(["⇧⌘Z", "Ctrl+Y", "Ctrl+Shift+Z", "Ctrl+Shift+Z"])
  })

  it("delete on the field with the delete key a Mac has (Backspace) and with Fn+Delete, and leave Command-Delete to text", () => {
    const mac = keymapFor("apple").remove
    expect.soft(matchesAny(named("Backspace"), mac, "apple"), "delete").toBeTruthy()
    expect.soft(matchesAny(named("Delete"), mac, "apple"), "Fn+Delete, forward delete").toBeTruthy()
    expect.soft(matchesAny(named("Backspace", { metaKey: true }), mac, "apple"), "⌘⌫").toBeFalsy()
    expect.soft(PLATFORMS.map((p) => labelFor(keymapFor(p).remove, p)), "printed").toEqual(["⌫", "Del", "Del", "Backspace"])
  })

  it("delete a file with Command-Delete on a Mac as Finder does, Alt+Backspace on ChromeOS, and Delete everywhere", () => {
    expect.soft(matchesAny(named("Backspace", { metaKey: true }), keymapFor("apple").deleteFile, "apple"), "⌘⌫ on a Mac").toBeTruthy()
    expect.soft(matchesAny(named("Backspace", { altKey: true }), keymapFor("chromeos").deleteFile, "chromeos"), "Alt+Backspace on ChromeOS").toBeTruthy()
    for (const platform of PLATFORMS) expect.soft(matchesAny(named("Delete"), keymapFor(platform).deleteFile, platform), `Delete on ${platform}`).toBeTruthy()
    expect.soft(matchesAny(named("Backspace", { ctrlKey: true }), keymapFor("windows").deleteFile, "windows"), "Ctrl+Backspace deletes a word, not a file").toBeFalsy()
    expect.soft(PLATFORMS.map((p) => labelFor(keymapFor(p).deleteFile, p)), "printed").toEqual(["⌘⌫", "Del", "Del", "Alt+Backspace"])
    expect.soft(PLATFORMS.map((p) => labelFor(keymapFor(p).renameFile, p)), "rename stays F2").toEqual(["F2", "F2", "F2", "F2"])
  })
})

describe("panels that keep keys to themselves", () => {
  it("still let save, open and the projects list through to emul, so the browser's Save Page and Open File never answer them", () => {
    const stopped = (mods: Partial<KeyPress>, key = "s") => {
      let stops = 0
      stopUnlessAppCommand({ nativeEvent: { key, code: `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }, stopPropagation: () => void stops++ })
      return stops > 0
    }
    expect.soft(stopped({ ctrlKey: true }), "Ctrl+S").toBe(false)
    expect.soft(stopped({ ctrlKey: true }, "o"), "Ctrl+O").toBe(false)
    expect.soft(stopped({ ctrlKey: true, shiftKey: true }, "O"), "Ctrl+Shift+O").toBe(false)
    expect.soft(stopped({}, "m"), "a letter stays in the panel").toBe(true)
    expect.soft(stopped({ ctrlKey: true }, "z"), "so does the panel's own undo").toBe(true)
  })
})

describe("labels in each platform's own order and names", () => {
  it("print ⌃⌥⇧⌘ glyphs without separators on a Mac, and Ctrl, Alt, Shift joined by + elsewhere", () => {
    const labels = (platform: Platform) => {
      const keymap = keymapFor(platform)
      return [keymap.undo, keymap.deselect, keymap.zoomIn, keymap.zoomOut, keymap.zoomReset, keymap.stepInstruction, keymap.restart, keymap.rotateBack, keymap.code, keymap.projects].map((k) => labelFor(k, platform))
    }
    expect.soft(labels("apple"), "macOS and iPadOS").toEqual(["⌘Z", "⎋", "⌘+", "⌘−", "⌘0", "⌥F11", "⇧⌘F5", "⇧R", "⌘J", "⇧⌘O"])
    expect.soft(labels("windows"), "Windows").toEqual(["Ctrl+Z", "Esc", "Ctrl++", "Ctrl+−", "Ctrl+0", "Alt+F11", "Ctrl+Shift+F5", "Shift+R", "Ctrl+J", "Ctrl+Shift+O"])
    expect.soft(labels("linux"), "Linux").toEqual(labels("windows"))
    expect.soft(labels("chromeos"), "ChromeOS").toEqual(labels("windows"))
  })

  it("put every modifier in Apple's order when a Mac shortcut has several", () => {
    expect.soft(shortcutLabel({ key: "z", mod: true, alt: true, shift: true }, "apple"), "Option, Shift, Command").toBe("⌥⇧⌘Z")
    expect.soft(shortcutLabel({ key: "z", mod: true, alt: true, shift: true }, "windows"), "Ctrl, Alt, Shift").toBe("Ctrl+Alt+Shift+Z")
  })
})

describe("clicks and the wheel", () => {
  const click = (button: number, mods: Partial<MouseEvent> = {}) => ({ button, ctrlKey: false, metaKey: false, shiftKey: false, ...mods })

  it("open the context menu on a Mac's Control-click instead of selecting, and on a right click everywhere", () => {
    expect.soft(opensContextMenu(click(0, { ctrlKey: true }), "apple"), "Control-click on a Mac").toBe(true)
    expect.soft(primaryClick(click(0, { ctrlKey: true }), "apple"), "is not a primary click there").toBe(false)
    expect.soft(primaryClick(click(0, { ctrlKey: true }), "windows"), "Ctrl+click is one on Windows").toBe(true)
    for (const platform of PLATFORMS) expect.soft(opensContextMenu(click(2), platform), `right click on ${platform}`).toBe(true)
  })

  it("add to the selection with Command or Shift on a Mac, and with Ctrl or Shift elsewhere", () => {
    expect.soft(addsToSelection(click(0, { metaKey: true }), "apple"), "Command-click").toBe(true)
    expect.soft(addsToSelection(click(0, { ctrlKey: true }), "apple"), "not Control-click").toBe(false)
    expect.soft(addsToSelection(click(0, { ctrlKey: true }), "windows"), "Ctrl+click").toBe(true)
    expect.soft(addsToSelection(click(0, { metaKey: true }), "linux"), "not Super+click").toBe(false)
    for (const platform of PLATFORMS) expect.soft(addsToSelection(click(0, { shiftKey: true }), platform), `Shift+click on ${platform}`).toBe(true)
  })

  it("zoom with Control or Command and the wheel on a Mac, where a pinch arrives as Control, and only with Ctrl elsewhere, as VS Code does", () => {
    expect.soft(wheelZooms({ ctrlKey: true, metaKey: false }, "apple"), "pinch on a Mac").toBe(true)
    expect.soft(wheelZooms({ ctrlKey: false, metaKey: true }, "apple"), "Command+wheel").toBe(true)
    expect.soft(wheelZooms({ ctrlKey: false, metaKey: true }, "windows"), "Windows key+wheel").toBe(false)
    expect.soft(wheelZooms({ ctrlKey: true, metaKey: false }, "linux"), "Ctrl+wheel").toBe(true)
  })
})
