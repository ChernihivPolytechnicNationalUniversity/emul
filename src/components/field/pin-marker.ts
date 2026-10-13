import { cn } from "@/lib/utils"
import { switchContacts } from "@/schematic/printed-text"
import type { ComponentDef, PinKind } from "@/schematic/types"

export const SWITCH_CONTACT_CELLS = 0.12
const SAME_POINT_CELLS = 1e-3

const onSwitchContacts = new WeakMap<ComponentDef, ReadonlySet<string>>()

export function pinsOnSwitchContacts(def: ComponentDef): ReadonlySet<string> {
  const cached = onSwitchContacts.get(def)
  if (cached) return cached
  const contacts = def.parts.flatMap((part) => (part.type === "switch" ? switchContacts(part).slice(0, part.throws ? 3 : 2) : []))
  const found = new Set(def.pins.filter((pin) => contacts.some((c) => Math.hypot(c.x - pin.x, c.y - pin.y) < SAME_POINT_CELLS)).map((pin) => pin.id))
  onSwitchContacts.set(def, found)
  return found
}

const PIN_FILL: Record<PinKind, string> = {
  power: "fill-red-500",
  gnd: "fill-neutral-700 dark:fill-neutral-300",
  analog: "fill-amber-500",
  digital: "fill-background",
  node: "fill-foreground",
  nc: "fill-muted",
}

export const hollowMarkerHidden = (def: ComponentDef | undefined, kind: PinKind, connected: boolean, contact: boolean) =>
  connected && !contact && kind === "digital" && !def?.pinsAreSockets

export type PinMarker = { radiusCells: number; fill?: string; stroke?: string; className: string; strokeWidth: number }

export function pinMarker(def: ComponentDef | undefined, kind: PinKind, live: boolean, contact: boolean, color: string | undefined): PinMarker | null {
  if (hollowMarkerHidden(def, kind, live, contact)) return null
  const filled = !!color && (contact || kind === "node")
  return {
    radiusCells: contact ? 0.26 : kind === "nc" ? 0.14 : 0.2,
    fill: filled ? color : undefined,
    stroke: color,
    className: cn(
      "transition-[r] group-hover/pin:stroke-primary",
      !color && "stroke-foreground/60",
      !color && live && !contact && "stroke-primary",
      !filled && (contact ? "fill-foreground" : PIN_FILL[kind]),
    ),
    strokeWidth: live ? 2 : 1,
  }
}
