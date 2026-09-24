/**
 * A board's debugger settings as a schematic file brings them: repaired rather than refused,
 * as the project's files are. What does not read as a breakpoint, an added source or a watch
 * is dropped; the rest is kept.
 */
import type { SourceFile } from "emul-shared/source"
import type { BoardDebug } from "@/schematic/types"
import type { BreakpointSpec } from "./protocol"

type Loose = Record<string, unknown>

const isObject = (v: unknown): v is Loose => !!v && typeof v === "object" && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== ""

function breakpoint(b: Loose): BreakpointSpec | null {
  const id = typeof b.id === "string" && b.id ? b.id : crypto.randomUUID()
  const enabled = b.enabled !== false
  switch (b.kind) {
    case "line":
      return text(b.path) && Number.isInteger(b.line) && (b.line as number) > 0 ? { id, kind: "line", path: b.path, line: b.line as number, enabled } : null
    case "function":
      return text(b.name) ? { id, kind: "function", name: b.name.trim(), enabled } : null
    case "address": {
      const a = b.address
      return Number.isInteger(a) && (a as number) >= 0 && (a as number) <= 0xffffffff ? { id, kind: "address", address: a as number, enabled } : null
    }
  }
  return null
}

export function normalizeDebug(raw: unknown): BoardDebug | undefined {
  if (!isObject(raw)) return undefined
  const out: BoardDebug = {}
  if (Array.isArray(raw.breakpoints)) {
    const ids = new Set<string>()
    out.breakpoints = []
    for (const b of raw.breakpoints) {
      const bp = isObject(b) ? breakpoint(b) : null
      if (!bp) continue
      // Two with one id would toggle together.
      if (ids.has(bp.id)) bp.id = crypto.randomUUID()
      ids.add(bp.id)
      out.breakpoints.push(bp)
    }
  }
  if (Array.isArray(raw.sources)) {
    // One text per path the image names; the last one given wins, as adding again replaces.
    const byPath = new Map<string, SourceFile>()
    for (const f of raw.sources) if (isObject(f) && text(f.path) && typeof f.content === "string") byPath.set(f.path, { path: f.path, content: f.content.replace(/\r\n?/g, "\n") })
    out.sources = [...byPath.values()]
  }
  if (Array.isArray(raw.watches)) out.watches = raw.watches.filter(text)
  if (typeof raw.catchFaults === "boolean") out.catchFaults = raw.catchFaults
  return out
}
