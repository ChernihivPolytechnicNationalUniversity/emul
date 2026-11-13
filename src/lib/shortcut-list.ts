import { alternatives, shortcutLabel } from "./keys"
import { keymapFor, type Keymap } from "./keymap"
import type { Platform } from "./platform"

export type ShortcutRow = { readonly name: string; readonly keys: readonly string[]; readonly binding?: keyof Keymap }
export type ShortcutSection = { readonly title: string; readonly rows: readonly ShortcutRow[] }

type Entry = readonly [name: string, binding: keyof Keymap] | readonly [name: string, keys: (platform: Platform) => readonly string[]]

const SECTIONS: readonly { title: string; entries: readonly Entry[] }[] = [
  {
    title: "Tools",
    entries: [
      ["Select", "toolSelect"],
      ["Hand", "toolHand"],
      ["Pan from any tool", () => ["Space + drag", "Middle button + drag", "Scroll"]],
      ["Wire", "toolWire"],
      ["Join wires where they cross", "toolJoin"],
      ["Add part", "addHere"],
      ["Probe", "measure"],
    ],
  },
  {
    title: "While drawing a wire",
    entries: [
      ["Right angles, 45° steps, any angle", "lineMode"],
      ["Which leg goes first", () => ["/"]],
      ["Take the last corner back", (p) => [p === "apple" ? "⌫" : "Backspace"]],
      ["Finish at the last corner", (p) => [p === "apple" ? "↩" : "Enter", "Double-click"]],
      ["Colour by the resistor code", () => ["0–9", "C cyan", "M magenta"]],
      ["Stop drawing", (p) => [p === "apple" ? "⎋" : "Esc"]],
    ],
  },
  {
    title: "Selection",
    entries: [
      ["Rotate 45°", "rotate"],
      ["Rotate back", "rotateBack"],
      ["Rotate without its wires", "rotateAlone"],
      ["Rotate back without its wires", "rotateBackAlone"],
      ["Flip horizontally", "flipHorizontal"],
      ["Flip vertically", "flipVertical"],
      ["Flip horizontally without its wires", "flipHorizontalAlone"],
      ["Flip vertically without its wires", "flipVerticalAlone"],
      ["Re-route a wire", "reroute"],
      ["Paint the whole net", (p) => [p === "apple" ? "⇧0–9" : "Shift+0–9"]],
      ["Drag a part off its wires", (p) => [p === "apple" ? "⌥ + drag" : "Alt + drag"]],
      ["Add to the selection", (p) => [p === "apple" ? "⇧ + click" : "Shift + click"]],
      ["Delete", "remove"],
      ["Duplicate", "duplicate"],
      ["Cut", "cut"],
      ["Copy", "copy"],
      ["Paste", "paste"],
      ["Select all", "selectAll"],
      ["Deselect", "deselect"],
    ],
  },
  {
    title: "Edit and file",
    entries: [
      ["Undo", "undo"],
      ["Redo", "redo"],
      ["Save", "save"],
      ["Open a file", "open"],
      ["Projects", "projects"],
    ],
  },
  {
    title: "View",
    entries: [
      ["Zoom in", "zoomIn"],
      ["Zoom out", "zoomOut"],
      ["Reset the view", "zoomReset"],
      ["Everything in view", "fitAll"],
      ["The selection in view", "zoomToSelection"],
      ["Life size", "actualSize"],
      ["Find on the field", "find"],
      ["Next problem", "nextProblem"],
      ["Previous problem", "previousProblem"],
      ["Parts sidebar", "sidebar"],
      ["Code", "code"],
      ["Keyboard shortcuts", "shortcuts"],
    ],
  },
  {
    title: "Simulation",
    entries: [
      ["Oscilloscope", "scope"],
      ["Logic analyser", "logic"],
    ],
  },
  {
    title: "Code and debugging",
    entries: [
      ["Disassembly", "disassembly"],
      ["Continue", "continue"],
      ["Restart", "restart"],
      ["Toggle a breakpoint", "toggleBreakpoint"],
      ["Run to the cursor", "runToCursor"],
      ["Step over", "stepOver"],
      ["Step into", "stepInto"],
      ["Step out", "stepOut"],
      ["Step one instruction", "stepInstruction"],
      ["Rename a file", "renameFile"],
      ["Delete a file", "deleteFile"],
    ],
  },
]

export function shortcutSections(platform: Platform): ShortcutSection[] {
  const keymap = keymapFor(platform)
  return SECTIONS.map(({ title, entries }) => ({
    title,
    rows: entries.map(([name, source]) =>
      typeof source === "function"
        ? { name, keys: source(platform) }
        : { name, binding: source, keys: alternatives(keymap[source]).map((shortcut) => shortcutLabel(shortcut, platform)) },
    ),
  }))
}
