import { KEYMAP } from "./keymap"
import { alternatives, type Keys } from "./keys"
import { lineModeTag, nextLineMode, DEFAULT_LINE_MODE, type LineMode } from "@/schematic/wire-draw"

const byLetterFirst = (keys: Keys): Keys => {
  const [first, ...rest] = [...alternatives(keys)].sort((a, b) => Number(!!a.mod) - Number(!!b.mod))
  return [first, ...rest]
}

export type ToolId = "select" | "hand" | "wire" | "part" | "probe"

export type ToolSpec = { readonly id: ToolId; readonly name: string; readonly keys: Keys; readonly hint: string; readonly note?: string }

export const TOOL_GROUPS: readonly (readonly ToolSpec[])[] = [
  [
    { id: "select", name: "Select", keys: KEYMAP.toolSelect, hint: "Click to select, drag to move · Shift adds · Alt drags a part off its wires" },
    { id: "hand", name: "Hand", keys: KEYMAP.toolHand, hint: "Drag to pan · Space and drag pans from any tool" },
  ],
  [
    { id: "wire", name: "Wire", keys: KEYMAP.toolWire, hint: "Click a pin or a wire to start, click to bend, click a pin to end" },
    { id: "part", name: "Add part", keys: byLetterFirst(KEYMAP.addHere), hint: "Type a part's name, Enter places it" },
  ],
  [{ id: "probe", name: "Probe", keys: KEYMAP.measure, hint: "Click two points to read the voltage between them", note: "With a wire selected or being drawn, M paints it magenta" }],
]

export const TOOLS: readonly ToolSpec[] = TOOL_GROUPS.flat()

export const toolSpec = (id: ToolId): ToolSpec => TOOLS.find((tool) => tool.id === id)!

const MODE_NAMES: Record<LineMode, string> = { "90": "Right angles", "45": "45° steps", any: "Any angle" }

const modesFrom = (first: LineMode): LineMode[] => [first, nextLineMode(first), nextLineMode(nextLineMode(first))]

export const WIRE_MODE_CHOICES: readonly { readonly mode: LineMode; readonly short: string; readonly name: string }[] = modesFrom(DEFAULT_LINE_MODE).map((mode) => ({ mode, short: lineModeTag(mode), name: MODE_NAMES[mode] }))
