import { describe, expect, it, vi } from "vitest"
import { DEBUG_SHORTCUTS } from "@/components/code/debug-shortcuts"
import { alternatives, closeMenusAfterCommands, dispatch, editsText, holdBrowserNavigationKeys, keepsPageInPlace, matches, ownsKeys, shortcutLabel, typesAhead, type KeyPress, type Keys } from "@/lib/keys"
import { KEYMAP, keymapFor, labelFor } from "@/lib/keymap"
import type { Platform } from "@/lib/platform"
import { wireColorFor } from "@/schematic/wire-colors"

type Press = Partial<KeyPress> & { altGraph?: boolean }

const press = (key: string, code: string, mods: Press = {}): KeyPress => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
  getModifierState: (name: string) => name === "AltGraph" && !!mods.altGraph,
})
const ctrl = (key: string, code: string, mods: Press = {}) => press(key, code, { ctrlKey: true, ...mods })
const hits = (e: KeyPress, keys: Keys, platform: Platform = "linux") => alternatives(keys).some((s) => matches(e, s, platform))
const MAC = keymapFor("apple")

const element = (tagName: string, extra: { type?: string; readOnly?: boolean; isContentEditable?: boolean; inside?: string } = {}) =>
  ({
    tagName,
    type: extra.type,
    readOnly: !!extra.readOnly,
    isContentEditable: !!extra.isContentEditable,
    closest: (selector: string) => (extra.inside && selector.split(", ").includes(extra.inside) ? {} : null),
  }) as unknown as EventTarget

describe("a letter shortcut is the Latin letter the key types, or its place when the layout types another script there", () => {
  it("follows a Latin letter wherever the layout puts it", () => {
    expect.soft(hits(ctrl("z", "KeyZ"), KEYMAP.undo), "US: Ctrl+Z").toBe(true)
    expect.soft(hits(press("Z", "KeyZ", { metaKey: true, shiftKey: true }), MAC.redo, "apple"), "US: Cmd+Shift+Z on a Mac").toBe(true)
    expect.soft(hits(ctrl("z", "KeyW"), KEYMAP.undo), "AZERTY: the key printed Z, where US has W").toBe(true)
    expect.soft(hits(ctrl("w", "KeyZ"), KEYMAP.undo), "AZERTY: the key in US Z's place types w").toBe(false)
    expect.soft(hits(ctrl("y", "KeyZ"), KEYMAP.redo), "QWERTZ: the key printed Y, where US has Z").toBe(true)
    expect.soft(hits(ctrl("z", "Slash"), KEYMAP.undo), "Dvorak: Z on US slash").toBe(true)
  })

  it("reads a Cyrillic or Greek letter as the Latin letter of its place", () => {
    expect.soft(hits(ctrl("я", "KeyZ"), KEYMAP.undo), "ЙЦУКЕН: Ctrl+Я").toBe(true)
    expect.soft(hits(ctrl("Я", "KeyZ", { shiftKey: true }), KEYMAP.redo), "ЙЦУКЕН: Ctrl+Shift+Я").toBe(true)
    expect.soft(hits(ctrl("ф", "KeyA"), KEYMAP.selectAll), "ЙЦУКЕН: Ctrl+Ф").toBe(true)
    expect.soft(hits(ctrl("і", "KeyS"), KEYMAP.save), "Ukrainian: Ctrl+І").toBe(true)
    expect.soft(hits(press("ь", "KeyM"), KEYMAP.measure), "ЙЦУКЕН: Ь").toBe(true)
    expect.soft(hits(press("к", "KeyR"), KEYMAP.rotate), "ЙЦУКЕН: К").toBe(true)
    expect.soft(hits(ctrl("ζ", "KeyZ"), KEYMAP.undo), "Greek: Ctrl+ζ").toBe(true)
  })

  it("never lets a key's place override what it types in ASCII or in Latin script", () => {
    expect.soft(hits(ctrl(";", "KeyZ", { keyCode: 186 }), KEYMAP.undo), "Dvorak: ; is not Z").toBe(false)
    expect.soft(hits(press(";", "KeyQ"), { key: "q" }), "Greek: ; on Q is not Q").toBe(false)
    expect.soft(hits(press("ı", "KeyI"), { key: "i" }), "Turkish: dotless ı is a Latin letter of its own").toBe(false)
    expect.soft(hits(press("×", "KeyO", { ctrlKey: true, shiftKey: true }), KEYMAP.projects), "Arabic: × (Shift on O) is O, as Lexical reads it").toBe(true)
  })

  it("takes the letter from keyCode when Ctrl or Cmd makes a non-Latin layout type ASCII punctuation, as CodeMirror does", () => {
    expect.soft(hits(ctrl("]", "KeyD", { shiftKey: true, keyCode: 68 }), KEYMAP.disassembly), "Arabic: Ctrl+Shift+D types ]").toBe(true)
    expect.soft(hits(ctrl("~", "KeyZ", { shiftKey: true, keyCode: 90 }), KEYMAP.redo), "Arabic: Ctrl+Shift+Z types ~").toBe(true)
    expect.soft(hits(ctrl(":", "KeyZ", { shiftKey: true, keyCode: 186 }), KEYMAP.redo), "Dvorak: Ctrl+Shift+; is not redo").toBe(false)
    expect.soft(hits(ctrl("]", "KeyD", { keyCode: 221 }), KEYMAP.duplicate), "a keyCode that is not the letter").toBe(false)
    expect.soft(hits(ctrl("]", "BracketRight", { keyCode: 68 }), KEYMAP.duplicate), "a code that is not the letter's place").toBe(false)
    expect.soft(hits(press("]", "KeyD", { shiftKey: true, keyCode: 68 }), { key: "d", shift: true }), "only with Ctrl or Cmd").toBe(false)
  })
})

describe("a dead key on a letter's place", () => {
  it("is that place's letter, since nothing is being typed on the field (TanStack Hotkeys does the same)", () => {
    expect.soft(hits(press("Dead", "KeyR", { shiftKey: true }), KEYMAP.rotateBack), "Hebrew on a Mac: Shift+R is a dead key (Safari, Chrome)").toBe(true)
    expect.soft(hits(press("", "KeyR", { shiftKey: true, keyCode: 80 }), KEYMAP.rotateBack), "Firefox reports that dead key as an empty key").toBe(true)
    expect.soft(hits(press("Dead", "Equal"), KEYMAP.zoomIn), "a dead key elsewhere is nothing").toBe(false)
    expect.soft(hits(press("Dead", "KeyR", { altKey: true }), KEYMAP.rotate), "Option dead keys stay Option").toBe(false)
  })
})

describe("modifiers match exactly", () => {
  it("take the platform's command key, and nothing else added", () => {
    expect.soft(hits(press("a", "KeyA", { metaKey: true }), MAC.selectAll, "apple"), "Cmd+A on a Mac").toBe(true)
    expect.soft(hits(press("a", "KeyA", { metaKey: true }), KEYMAP.selectAll), "Super+A on Linux").toBe(false)
    expect.soft(hits(ctrl("a", "KeyA", { shiftKey: true }), KEYMAP.selectAll), "Ctrl+Shift+A stays the browser's").toBe(false)
    expect.soft(hits(press("M", "KeyM", { shiftKey: true }), KEYMAP.measure), "Shift+M is not M").toBe(false)
    expect.soft(hits(press("m", "KeyM", { ctrlKey: true }), KEYMAP.measure), "Ctrl+M is not M").toBe(false)
    expect.soft(hits(press("R", "KeyR", { shiftKey: true }), KEYMAP.rotateBack), "Shift+R rotates back").toBe(true)
    expect.soft(hits(press("R", "KeyR", { shiftKey: true }), KEYMAP.rotate), "and not forward").toBe(false)
    expect.soft(hits(press("Delete", "Delete"), KEYMAP.remove), "Delete deletes").toBe(true)
    expect.soft(hits(press("Backspace", "Backspace"), KEYMAP.remove), "so does Backspace").toBe(true)
    expect.soft(hits(ctrl("Backspace", "Backspace"), KEYMAP.remove), "Ctrl+Backspace does not").toBe(false)
  })

  it("never takes AltGr for a command, whether it arrives as Ctrl+Alt or as AltGraph", () => {
    expect.soft(hits(ctrl("ż", "KeyZ", { altKey: true }), KEYMAP.undo), "Polish AltGr+Z as Ctrl+Alt").toBe(false)
    expect.soft(hits(ctrl("ż", "KeyZ", { altGraph: true }), KEYMAP.undo), "Polish AltGr+Z as AltGraph").toBe(false)
    expect.soft(hits(press("µ", "KeyM", { altGraph: true }), KEYMAP.measure), "AltGr+M").toBe(false)
    expect.soft(hits(press("F11", "F11", { altKey: true }), KEYMAP.stepInstruction), "Alt+F11 when asked for").toBe(true)
    expect.soft(hits(press("F11", "F11", { altGraph: true }), KEYMAP.stepInstruction), "AltGr alone is not Alt").toBe(false)
  })
})

describe("zoom on the layouts that move = and 0", () => {
  it("reads = and - as typed, so German Shift+0 zooms in", () => {
    expect.soft(hits(ctrl("=", "Equal"), KEYMAP.zoomIn), "US: Ctrl+=").toBe(true)
    expect.soft(hits(ctrl("+", "Equal", { shiftKey: true }), KEYMAP.zoomIn), "US: Ctrl+Shift+=").toBe(true)
    expect.soft(hits(ctrl("+", "BracketRight"), KEYMAP.zoomIn), "QWERTZ: the + key").toBe(true)
    expect.soft(hits(ctrl("=", "Digit0", { shiftKey: true }), KEYMAP.zoomIn), "QWERTZ: Shift+0 types =").toBe(true)
    expect.soft(hits(ctrl("=", "Digit0", { shiftKey: true }), KEYMAP.zoomReset), "and does not reset").toBe(false)
    expect.soft(hits(ctrl("-", "Slash"), KEYMAP.zoomOut), "QWERTZ: - on US slash").toBe(true)
    expect.soft(hits(ctrl("-", "Digit6"), KEYMAP.zoomOut), "AZERTY: - on 6").toBe(true)
    expect.soft(hits(ctrl("-", "NumpadSubtract"), KEYMAP.zoomOut), "the keypad's -").toBe(true)
  })

  it("resets on a typed 0, and on the 0 key's place only where it types a non-ASCII character", () => {
    expect.soft(hits(ctrl("0", "Digit0"), KEYMAP.zoomReset), "US: Ctrl+0").toBe(true)
    expect.soft(hits(ctrl("à", "Digit0"), KEYMAP.zoomReset), "AZERTY: Ctrl+à is Ctrl+0").toBe(true)
    expect.soft(hits(ctrl("0", "Digit0", { shiftKey: true }), KEYMAP.zoomReset), "AZERTY: Ctrl+Shift types 0 and resets").toBe(true)
    expect.soft(hits(ctrl("é", "Digit0"), KEYMAP.zoomReset), "Czech: Ctrl+é is Ctrl+0").toBe(true)
    expect.soft(hits(ctrl(")", "Digit0", { shiftKey: true }), KEYMAP.zoomReset), "US: Ctrl+Shift+0 types ) and does not").toBe(false)
    expect.soft(hits(ctrl("0", "Numpad0"), KEYMAP.zoomReset), "the keypad with Num Lock on").toBe(true)
    expect.soft(hits(ctrl("Insert", "Numpad0"), KEYMAP.zoomReset), "Ctrl+Insert with Num Lock off is not Ctrl+0").toBe(false)
  })
})

describe("a key press an input method is still composing is nobody's shortcut", () => {
  it("drops it however the browser marks it", () => {
    expect.soft(hits(ctrl("z", "KeyZ", { isComposing: true }), KEYMAP.undo), "isComposing").toBe(false)
    expect.soft(hits(press("m", "KeyM", { keyCode: 229 }), KEYMAP.measure), "keyCode 229 (Safari's commit)").toBe(false)
    expect.soft(hits(press("Process", "KeyM"), KEYMAP.measure), "Process").toBe(false)
    expect.soft(wireColorFor(press("Process", "Digit1")), "no wire colour either").toBeUndefined()
  })
})

describe("wire colours", () => {
  it("are the digit row and the keypad by place, with or without Shift", () => {
    expect.soft(wireColorFor(press("2", "Digit2")), "2").toBe("red")
    expect.soft(wireColorFor(press("é", "Digit2")), "AZERTY: é on 2").toBe("red")
    expect.soft(wireColorFor(press("@", "Digit2", { shiftKey: true })), "Shift+2 paints the net").toBe("red")
    expect.soft(wireColorFor(press("End", "Numpad1")), "the keypad with Num Lock off").toBe("brown")
    expect.soft(wireColorFor(ctrl("2", "Digit2")), "Ctrl+2 is not a colour").toBeUndefined()
  })

  it("take C and M as letters, by the same rule as every other letter", () => {
    expect.soft(wireColorFor(press("c", "KeyC")), "C").toBe("cyan")
    expect.soft(wireColorFor(press("с", "KeyC")), "ЙЦУКЕН: С on C").toBe("cyan")
    expect.soft(wireColorFor(press("ь", "KeyM")), "ЙЦУКЕН: Ь on M").toBe("magenta")
    expect.soft(wireColorFor(press("c", "KeyI")), "Dvorak: C on US I").toBe("cyan")
    expect.soft(wireColorFor(press("j", "KeyC")), "Dvorak: J on US C").toBeUndefined()
  })
})

describe("repeats, conditions and keys already taken", () => {
  const event = (e: KeyPress) => Object.assign(e, { prevented: false, preventDefault() { this.prevented = true } })

  it("repeats undo while the key is held, but saves once and still keeps the browser's own Ctrl+S away", () => {
    let undos = 0
    let saves = 0
    const bindings = [
      { keys: KEYMAP.undo, run: () => undos++ },
      { keys: KEYMAP.save, run: () => saves++ },
    ]
    dispatch(event(ctrl("z", "KeyZ")), bindings)
    dispatch(event(ctrl("z", "KeyZ", { repeat: true })), bindings)
    const held = event(ctrl("s", "KeyS", { repeat: true }))
    dispatch(event(ctrl("s", "KeyS")), bindings)
    dispatch(held, bindings)
    expect.soft(undos, "undo repeats").toBe(2)
    expect.soft(saves, "save does not").toBe(1)
    expect.soft(held.prevented, "a held Ctrl+S never reaches the browser's Save page").toBe(true)
  })

  it("leaves a key alone when its command does not apply", () => {
    const e = event(press("r", "KeyR"))
    const handled = dispatch(e, [{ keys: KEYMAP.rotate, when: () => false, run: () => {} }])
    expect.soft(handled, "nothing selected, nothing rotated").toBe(false)
    expect.soft(e.prevented, "and the key's default is left alone").toBe(false)
  })

  it("does nothing with a key another handler has already taken", () => {
    let undos = 0
    const handled = dispatch(event(ctrl("z", "KeyZ", { defaultPrevented: true })), [{ keys: KEYMAP.undo, run: () => undos++ }])
    expect.soft(handled, "not handled").toBe(false)
    expect.soft(undos, "no second undo").toBe(0)
  })
})

describe("whose keys they are", () => {
  it("knows which targets edit text", () => {
    expect.soft(editsText(element("INPUT", { type: "text" })), "a text input").toBe(true)
    expect.soft(editsText(element("INPUT", { type: "number" })), "a number input").toBe(true)
    expect.soft(editsText(element("TEXTAREA")), "a textarea").toBe(true)
    expect.soft(editsText(element("DIV", { isContentEditable: true })), "contenteditable").toBe(true)
    expect.soft(editsText(element("DIV", { inside: ".monaco-editor" })), "Monaco's EditContext div").toBe(true)
    expect.soft(editsText(element("INPUT", { type: "text", readOnly: true })), "a read-only field (the share link)").toBe(false)
    expect.soft(editsText(element("INPUT", { type: "checkbox" })), "a checkbox").toBe(false)
    expect.soft(editsText(element("SELECT")), "a closed select").toBe(false)
    expect.soft(editsText(element("BUTTON")), "a button").toBe(false)
    expect.soft(editsText(null), "no target").toBe(false)
  })

  it("keeps the field's shortcuts and clipboard out of text, selects, dialogs and the code panel", () => {
    expect.soft(ownsKeys(element("INPUT", { type: "text" })), "a text input").toBe(true)
    expect.soft(ownsKeys(element("INPUT", { type: "text", readOnly: true })), "a read-only field still selects and copies its own text").toBe(true)
    expect.soft(ownsKeys(element("SELECT")), "a select types ahead").toBe(true)
    expect.soft(ownsKeys(element("BUTTON", { inside: '[role="dialog"]' })), "a dialog").toBe(true)
    expect.soft(ownsKeys(element("DIV", { inside: '[data-slot="code-panel"]' })), "the code panel").toBe(true)
    expect.soft(ownsKeys(element("INPUT", { type: "checkbox" })), "a just-ticked checkbox does not").toBe(false)
    expect.soft(ownsKeys(element("BUTTON")), "a just-clicked palette entry does not").toBe(false)
    expect.soft(ownsKeys(element("BODY")), "the page does not").toBe(false)
  })

  it("leaves Ctrl and Cmd commands working in an open menu, which types ahead on plain letters only", () => {
    expect.soft(ownsKeys(element("DIV", { inside: '[role="menu"]' })), "a menu does not take Ctrl+Z").toBe(false)
    expect.soft(typesAhead(element("DIV", { inside: '[role="menu"]' })), "but types ahead").toBe(true)
    expect.soft(typesAhead(element("DIV", { inside: '[role="listbox"]' })), "as a listbox does").toBe(true)
    expect.soft(typesAhead(element("BODY")), "the page does not").toBe(false)
  })
})

describe("Backspace never takes the page back", () => {
  it("is held everywhere text is not being edited", () => {
    const at = (target: EventTarget, ime: { isComposing?: boolean; keyCode?: number } = {}) => keepsPageInPlace({ key: "Backspace", target, ...ime })
    expect.soft(at(element("BODY")), "on the field").toBe(true)
    expect.soft(at(element("INPUT", { type: "checkbox" })), "on a checkbox").toBe(true)
    expect.soft(at(element("SELECT")), "on a closed select").toBe(true)
    expect.soft(at(element("INPUT", { type: "text", readOnly: true })), "in a read-only field").toBe(true)
    expect.soft(at(element("INPUT", { type: "text" })), "not in a text input").toBe(false)
    expect.soft(at(element("BODY"), { isComposing: true }), "not while an input method composes").toBe(false)
    expect.soft(at(element("BODY"), { keyCode: 229 }), "nor as it commits (229)").toBe(false)
    expect.soft(keepsPageInPlace({ key: "Delete", target: element("BODY") }), "Delete navigates nowhere").toBe(false)
  })

  it("listens before anything else on the page and lets the event go on to the field", () => {
    const listeners: { type: string; listener: EventListener; options: unknown }[] = []
    const target = {
      addEventListener: (type: string, listener: EventListener, options: unknown) => listeners.push({ type, listener, options }),
      removeEventListener: (type: string, listener: EventListener) => listeners.splice(listeners.findIndex((l) => l.type === type && l.listener === listener), 1),
    }
    const release = holdBrowserNavigationKeys(target as unknown as Window)
    expect.soft(listeners.map((l) => [l.type, l.options]), "one keydown listener in the capture phase").toEqual([["keydown", { capture: true }]])
    const event = { key: "Backspace", target: element("BODY"), prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
    listeners[0].listener(event as unknown as Event)
    expect.soft(event.prevented, "the browser's back is cancelled").toBe(true)
    expect.soft(event.stopped, "the field still hears the key and deletes").toBe(false)
    release()
    expect.soft(listeners.length, "released").toBe(0)
  })
})

describe("labels come from the same shortcuts", () => {
  it("print Apple's symbols on a Mac and words elsewhere", () => {
    const redoByZ = alternatives(KEYMAP.redo).find((s) => s.key === "z")!
    expect.soft(shortcutLabel(redoByZ, "apple"), "Mac redo").toBe("⇧⌘Z")
    expect.soft(shortcutLabel(redoByZ, "linux"), "Linux redo").toBe("Ctrl+Shift+Z")
    expect.soft(shortcutLabel(KEYMAP.zoomOut, "windows"), "zoom out").toBe("Ctrl+−")
    expect.soft(shortcutLabel(KEYMAP.stepInstruction, "apple"), "Mac Option+F11").toBe("⌥F11")
    expect.soft(shortcutLabel(KEYMAP.stepInstruction, "windows"), "Alt+F11").toBe("Alt+F11")
    expect.soft(shortcutLabel(KEYMAP.rotateBack, "apple"), "Shift+R on a Mac").toBe("⇧R")
    expect.soft(labelFor(KEYMAP.remove, "linux"), "a list of shortcuts is labelled by its first").toBe("Del")
  })
})

describe("a command typed with a menu open", () => {
  it("closes the menu once a handler has taken the key, as a native menu does", () => {
    vi.stubGlobal(
      "KeyboardEvent",
      class {
        type: string
        init: KeyboardEventInit
        constructor(type: string, init: KeyboardEventInit) {
          this.type = type
          this.init = init
        }
      },
    )
    const listeners: EventListener[] = []
    const target = { addEventListener: (_: string, l: EventListener) => listeners.push(l), removeEventListener: () => {} }
    closeMenusAfterCommands(target as unknown as Window, (run) => run())
    const sent: { type: string; init: KeyboardEventInit }[] = []
    const inMenu = (mods: Partial<KeyPress>, taken: boolean) => ({
      key: "z",
      code: "KeyZ",
      ctrlKey: false,
      metaKey: false,
      ...mods,
      defaultPrevented: taken,
      target: { tagName: "DIV", closest: (s: string) => (s.includes('[role="menu"]') ? {} : null), dispatchEvent: (e: { type: string; init: KeyboardEventInit }) => sent.push(e) },
    })
    listeners[0](inMenu({ ctrlKey: true }, true) as unknown as Event)
    expect.soft(sent.map((e) => [e.type, e.init.key]), "Ctrl+Z ran: the menu gets its Escape").toEqual([["keydown", "Escape"]])
    listeners[0](inMenu({ ctrlKey: true }, false) as unknown as Event)
    listeners[0](inMenu({}, true) as unknown as Event)
    expect.soft(sent.length, "nothing ran, or a plain letter the menu types ahead with: it stays open").toBe(1)
    vi.unstubAllGlobals()
  })
})

describe("the debugger's keys", () => {
  it("step again while held, and continue, restart, a breakpoint or run-to-cursor only once", () => {
    const repeating = Object.entries(DEBUG_SHORTCUTS).filter(([, s]) => s.repeats).map(([k]) => k)
    expect.soft(repeating.sort(), "repeat while held").toEqual(["stepInstruction", "stepInto", "stepOut", "stepOver"])
  })
})
