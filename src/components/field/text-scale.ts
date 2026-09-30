export const TEXT_SCALES = [0.75, 1, 1.25, 1.5, 2] as const
export const DEFAULT_TEXT_SCALE = 1

const KEY = "emul.field.text-scale"

const isTextScale = (value: number) => (TEXT_SCALES as readonly number[]).includes(value)

export function savedTextScale(): number {
  try {
    const saved = Number(localStorage.getItem(KEY))
    return isTextScale(saved) ? saved : DEFAULT_TEXT_SCALE
  } catch {
    return DEFAULT_TEXT_SCALE
  }
}

export function saveTextScale(scale: number): boolean {
  try {
    localStorage.setItem(KEY, String(scale))
    return true
  } catch {
    return false
  }
}
