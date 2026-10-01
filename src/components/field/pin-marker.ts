import { cn } from "@/lib/utils"
import type { ComponentDef, PinKind } from "@/schematic/types"

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
