import type { ComponentDef, PinKind } from "@/schematic/types"

export const hollowMarkerHidden = (def: ComponentDef | undefined, kind: PinKind, connected: boolean, contact: boolean) =>
  connected && !contact && kind === "digital" && !def?.pinsAreSockets
