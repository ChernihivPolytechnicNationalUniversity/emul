export type KeyPress = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & {
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
  defaultPrevented?: boolean
  getModifierState?: (key: string) => boolean
}

export type Shortcut = {
  key: string
  mod?: boolean
  alt?: boolean
  shift?: boolean | "either"
  repeats?: boolean
}

export type Keys = Shortcut | readonly [Shortcut, ...Shortcut[]]

export type Binding = { keys: Keys; run: () => void; when?: () => boolean }

const IME_PROCESSING = 229
const NOT_A_KEY = new Set(["Process", "Unidentified", "Dead"])
const NON_ASCII_TEXT = /^\P{ASCII}+$/u
const LATIN_SCRIPT = /\p{Script=Latin}/u
const SINGLE_DIGIT = /^[0-9]$/
const SINGLE_LETTER = /^[a-z]$/
const DIGIT_POSITION = /^(?:Digit|Numpad)([0-9])$/

export const alternatives = (keys: Keys): readonly Shortcut[] => ([] as Shortcut[]).concat(keys)

export function composing(e: Pick<KeyPress, "key" | "isComposing" | "keyCode">): boolean {
  return !!e.isComposing || e.keyCode === IME_PROCESSING || NOT_A_KEY.has(e.key)
}

const altGraph = (e: KeyPress) => !!e.getModifierState?.("AltGraph")

const ASCII_LETTER_OR_DIGIT = /^[a-z0-9]$/i

function commandLetterByKeyCode(e: KeyPress, key: string): boolean {
  if (!(e.ctrlKey || e.metaKey) || !SINGLE_LETTER.test(key) || ASCII_LETTER_OR_DIGIT.test(e.key)) return false
  const letter = key.toUpperCase()
  return e.keyCode === letter.charCodeAt(0) && e.code === `Key${letter}`
}

function typesKey(e: KeyPress, key: string): boolean {
  if (key.length > 1) return e.key === key
  if (e.key.toLowerCase() === key) return true
  if (!NON_ASCII_TEXT.test(e.key)) return commandLetterByKeyCode(e, key)
  if (SINGLE_DIGIT.test(key)) return e.code === `Digit${key}`
  if (SINGLE_LETTER.test(key)) return e.code === `Key${key.toUpperCase()}` && !LATIN_SCRIPT.test(e.key)
  return false
}

export function matches(e: KeyPress, shortcut: Shortcut): boolean {
  if (composing(e) || altGraph(e) || e.altKey !== !!shortcut.alt) return false
  if ((e.ctrlKey || e.metaKey) !== !!shortcut.mod) return false
  if (shortcut.shift !== "either" && e.shiftKey !== !!shortcut.shift) return false
  return typesKey(e, shortcut.key)
}

export function matchesAny(e: KeyPress, keys: Keys): Shortcut | undefined {
  return alternatives(keys).find((shortcut) => matches(e, shortcut))
}

export function dispatch(e: KeyPress & Pick<KeyboardEvent, "preventDefault">, bindings: readonly Binding[]): boolean {
  if (e.defaultPrevented) return false
  for (const binding of bindings) {
    const hit = matchesAny(e, binding.keys)
    if (!hit || (binding.when && !binding.when())) continue
    e.preventDefault()
    if (!e.repeat || hit.repeats) binding.run()
    return true
  }
  return false
}

export function digitPosition(e: KeyPress): string | undefined {
  if (composing(e) || altGraph(e) || e.altKey || e.ctrlKey || e.metaKey) return undefined
  return DIGIT_POSITION.exec(e.code)?.[1]
}

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(["text", "search", "url", "tel", "email", "password", "number", "date", "datetime-local", "month", "week", "time"])
const KEY_OWNERS = '[data-slot="code-panel"], [role="dialog"], [role="alertdialog"]'
const TYPEAHEAD = '[role="menu"], [role="listbox"]'

type MaybeElement = { tagName?: string; type?: string; readOnly?: boolean; isContentEditable?: boolean; closest?: (selector: string) => unknown }

const asElement = (target: EventTarget | null) => (target as MaybeElement | null)?.tagName ? (target as MaybeElement) : null
const isTextField = (element: MaybeElement) => element.tagName === "TEXTAREA" || (element.tagName === "INPUT" && TEXT_INPUT_TYPES.has(element.type ?? "text"))

export function editsText(target: EventTarget | null): boolean {
  const element = asElement(target)
  if (!element) return false
  if (element.isContentEditable) return true
  if (isTextField(element)) return !element.readOnly
  return !!element.closest?.(".monaco-editor")
}

export function ownsKeys(target: EventTarget | null): boolean {
  const element = asElement(target)
  if (!element) return false
  if (editsText(target) || isTextField(element) || element.tagName === "SELECT") return true
  return !!element.closest?.(KEY_OWNERS)
}

export function typesAhead(target: EventTarget | null): boolean {
  return !!asElement(target)?.closest?.(TYPEAHEAD)
}

export function keepsPageInPlace(e: Pick<KeyboardEvent, "key" | "target"> & Pick<KeyPress, "isComposing" | "keyCode">): boolean {
  return e.key === "Backspace" && !composing(e) && !editsText(e.target)
}

export function holdBrowserNavigationKeys(target: Pick<Window, "addEventListener" | "removeEventListener"> = window) {
  const hold = (e: KeyboardEvent) => {
    if (keepsPageInPlace(e)) e.preventDefault()
  }
  target.addEventListener("keydown", hold, { capture: true })
  return () => target.removeEventListener("keydown", hold, { capture: true })
}

export function closeMenusAfterCommands(target: Pick<Window, "addEventListener" | "removeEventListener"> = window, later: (run: () => void) => void = (run) => setTimeout(run)) {
  const close = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || !typesAhead(e.target)) return
    later(() => {
      if (e.defaultPrevented) e.target?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }))
    })
  }
  target.addEventListener("keydown", close)
  return () => target.removeEventListener("keydown", close)
}

const KEY_NAMES: Readonly<Record<string, string>> = { "-": "−", Delete: "Del", Escape: "Esc", Backspace: "⌫" }

export function isApplePlatform(platform = globalThis.navigator?.platform ?? ""): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform)
}

export function shortcutLabel(shortcut: Shortcut, apple = isApplePlatform()): string {
  const key = KEY_NAMES[shortcut.key] ?? shortcut.key.toUpperCase()
  const shift = shortcut.shift === true
  if (apple) return `${shortcut.alt ? "⌥" : ""}${shift ? "⇧" : ""}${shortcut.mod ? "⌘" : ""}${key}`
  return [shortcut.mod && "Ctrl", shortcut.alt && "Alt", shift && "Shift", key].filter(Boolean).join("+")
}
