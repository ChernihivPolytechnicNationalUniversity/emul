import { readFileSync } from "node:fs"
import vm from "node:vm"
import { describe, expect, it } from "vitest"
import { alternatives, matches, matchesAny, type KeyPress, type Keys, type Shortcut } from "@/lib/keys"
import { keymapFor } from "@/lib/keymap"
import { detectPlatform, type Platform, type PlatformHints } from "@/lib/platform"

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
  })

  it("delete on the field with the delete key a Mac has (Backspace) and with Fn+Delete, and leave Command-Delete to text", () => {
    const mac = keymapFor("apple").remove
    expect.soft(matchesAny(named("Backspace"), mac, "apple"), "delete").toBeTruthy()
    expect.soft(matchesAny(named("Delete"), mac, "apple"), "Fn+Delete, forward delete").toBeTruthy()
    expect.soft(matchesAny(named("Backspace", { metaKey: true }), mac, "apple"), "⌘⌫").toBeFalsy()
  })

})
