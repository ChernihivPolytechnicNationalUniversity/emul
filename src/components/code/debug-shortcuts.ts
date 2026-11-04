import type { Shortcut } from "@/lib/keys"
import { KEYMAP } from "@/lib/keymap"
import type { DebugKey } from "./Editor"

export const DEBUG_SHORTCUTS: Readonly<Record<DebugKey, Shortcut>> = {
  continue: KEYMAP.continue,
  restart: KEYMAP.restart,
  toggleBreakpoint: KEYMAP.toggleBreakpoint,
  runToCursor: KEYMAP.runToCursor,
  stepOver: KEYMAP.stepOver,
  stepInto: KEYMAP.stepInto,
  stepOut: KEYMAP.stepOut,
  stepInstruction: KEYMAP.stepInstruction,
}
