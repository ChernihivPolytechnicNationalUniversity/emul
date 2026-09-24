/** How breakpoints read in the views, and where they land in an image. */
import type { DebugInfo } from "./info"
import type { BreakpointSpec } from "./protocol"

export function breakpointLabel(b: BreakpointSpec): string {
  switch (b.kind) {
    case "line":
      return `${b.path.split("/").pop()}:${b.line}`
    case "function":
      return `${b.name}()`
    case "address":
      return `0x${b.address.toString(16).padStart(8, "0")}`
  }
}

/** Where a breakpoint lands in the image, as the core will resolve it: a line may move to the next one with code. */
export function breakpointPlace(info: DebugInfo | null, b: BreakpointSpec): { ok: boolean; line?: number } {
  if (!info) return { ok: false }
  if (b.kind === "line") {
    const r = info.lines.resolve(b.path, b.line)
    return r && r.addrs.length ? { ok: true, line: r.line } : { ok: false }
  }
  if (b.kind === "function") return { ok: info.symbols.some((s) => s.type === "func" && (s.name === b.name || info.functions.some((f) => f.name === b.name && f.low === s.value))) }
  return { ok: info.inImage(b.address) }
}
