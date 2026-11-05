import type { Point } from "./geometry"
import type { Schematic } from "./types"
import type { Wiring } from "./wire-edits"

export const NO_CONNECT = "no-connect"

export type CheckKind = "dangling-end" | "unconnected-pin" | "four-way" | "wire-through-body" | "field-on-wire" | "field-on-body" | "fields-overlap" | "parallel-too-close"

export const CHECK_KINDS: readonly CheckKind[] = ["dangling-end", "unconnected-pin", "four-way", "wire-through-body", "field-on-wire", "field-on-body", "fields-overlap", "parallel-too-close"]

export type Finding = { kind: CheckKind; at: Point; objects: readonly string[]; segments: readonly string[]; text: string }

export function checked(_doc: Schematic, _wiring?: Wiring): readonly Finding[] {
  throw new Error("phase 5: the checker is not built yet")
}
