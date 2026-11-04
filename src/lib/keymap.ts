import { alternatives, shortcutLabel, type Keys, type Shortcut } from "./keys"
import { currentPlatform, type Platform } from "./platform"

type PerPlatform = { readonly default: Keys } & { readonly [P in Platform]?: Keys }
type Entry = Keys | PerPlatform

const REDO_BY_Z = { key: "z", mod: true, shift: true, repeats: true } as const satisfies Shortcut
const REDO_BY_Y = { key: "y", mod: true, repeats: true } as const satisfies Shortcut
const DELETE = { key: "Delete" } as const satisfies Shortcut
const BACKSPACE = { key: "Backspace" } as const satisfies Shortcut

const BINDINGS = {
  undo: { key: "z", mod: true, repeats: true },
  redo: { default: [REDO_BY_Z, REDO_BY_Y], windows: [REDO_BY_Y, REDO_BY_Z], apple: [REDO_BY_Z, REDO_BY_Y] },
  cut: { key: "x", mod: true },
  copy: { key: "c", mod: true },
  paste: { key: "v", mod: true },
  duplicate: { key: "d", mod: true },
  selectAll: { key: "a", mod: true },
  deselect: { key: "Escape" },
  remove: { default: [DELETE, BACKSPACE], apple: [BACKSPACE, DELETE], chromeos: [BACKSPACE, DELETE] },
  rotate: { key: "r", repeats: true },
  rotateBack: { key: "r", shift: true, repeats: true },
  flipHorizontal: { key: "x" },
  flipVertical: { key: "y" },
  measure: { key: "m" },
  scope: { key: "o" },
  logic: { key: "l" },
  code: { key: "j", mod: true },
  sidebar: { key: "b", mod: true },
  zoomIn: [
    { key: "+", mod: true, shift: "either", repeats: true },
    { key: "=", mod: true, shift: "either", repeats: true },
  ],
  zoomOut: { key: "-", mod: true, shift: "either", repeats: true },
  zoomReset: { key: "0", mod: true, shift: "either" },
  save: { key: "s", mod: true },
  open: { key: "o", mod: true },
  projects: { key: "o", mod: true, shift: true },
  disassembly: { key: "d", mod: true, shift: true },
  continue: { key: "F5" },
  restart: { key: "F5", mod: true, shift: true },
  toggleBreakpoint: { key: "F9" },
  runToCursor: { key: "F10", mod: true },
  stepOver: { key: "F10", repeats: true },
  stepInto: { key: "F11", repeats: true },
  stepOut: { key: "F11", shift: true, repeats: true },
  stepInstruction: { key: "F11", alt: true, repeats: true },
} as const satisfies Record<string, Entry>

type Bindings = typeof BINDINGS
export type Keymap = { readonly [K in keyof Bindings]: Bindings[K] extends PerPlatform ? Keys : Bindings[K] }

const perPlatform = (entry: Entry): entry is PerPlatform => "default" in entry

export function keymapFor(platform: Platform): Keymap {
  return Object.fromEntries(Object.entries(BINDINGS).map(([name, entry]) => [name, perPlatform(entry) ? (entry[platform] ?? entry.default) : entry])) as Keymap
}

export const KEYMAP = keymapFor(currentPlatform())

export const labelFor = (keys: Keys) => shortcutLabel(alternatives(keys)[0])

