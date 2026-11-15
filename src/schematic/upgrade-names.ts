import { getDef } from "./registry"
import type { PinRef, PlacedObject } from "./types"

export const nameOf = (o: PlacedObject) => o.props?.ref || getDef(o.def)?.name || o.def

export const listed = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`)

export const cells = (n: number) => `${n} cell${n === 1 ? "" : "s"}`

export const refOf = (key: string): PinRef => ({ object: key.slice(0, key.indexOf(":")), pin: key.slice(key.indexOf(":") + 1) })

export function pinName(key: string, objects: ReadonlyMap<string, PlacedObject>) {
  const { object, pin } = refOf(key)
  const o = objects.get(object)
  return `${o ? nameOf(o) : object} ${pin}`
}
