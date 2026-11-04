export type KeyPress = Pick<KeyboardEvent, "key"> & {
  isComposing?: boolean
  keyCode?: number
}

const IME_PROCESSING = 229
const NOT_A_KEY = new Set(["Process", "Unidentified", "Dead"])

export function composing(e: Pick<KeyPress, "key" | "isComposing" | "keyCode">): boolean {
  return !!e.isComposing || e.keyCode === IME_PROCESSING || NOT_A_KEY.has(e.key)
}

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(["text", "search", "url", "tel", "email", "password", "number", "date", "datetime-local", "month", "week", "time"])

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
