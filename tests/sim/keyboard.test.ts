import { describe, expect, it } from "vitest"
import { editsText, holdBrowserNavigationKeys, keepsPageInPlace } from "@/lib/keys"

const element = (tagName: string, extra: { type?: string; readOnly?: boolean; isContentEditable?: boolean; inside?: string } = {}) =>
  ({
    tagName,
    type: extra.type,
    readOnly: !!extra.readOnly,
    isContentEditable: !!extra.isContentEditable,
    closest: (selector: string) => (extra.inside && selector.split(", ").includes(extra.inside) ? {} : null),
  }) as unknown as EventTarget

describe("Backspace never takes the page back", () => {
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
