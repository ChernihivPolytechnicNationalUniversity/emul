import type { ComponentDef } from "@/schematic/types"

/** A chip's package pins by number, when they can be drawn as a DIP: every pin numbered 1…n, an even few. A board's headers are not a package. */
export function packagePins(def: ComponentDef) {
  const numbered = def.pins.filter((p) => p.connectorPin !== undefined && !p.connector)
  const n = numbered.length
  const byNumber = new Map(numbered.map((p) => [p.connectorPin!, p]))
  const drawable = n >= 3 && n <= 28 && n % 2 === 0 && byNumber.size === n && [...byNumber.keys()].every((k) => k >= 1 && k <= n)
  return drawable ? byNumber : null
}

export const hasPinout = (def: ComponentDef) => packagePins(def) !== null
