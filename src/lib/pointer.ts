import { currentPlatform, type Platform } from "./platform"

type Click = Pick<MouseEvent, "button" | "ctrlKey" | "metaKey" | "shiftKey">

export function opensContextMenu(e: Pick<Click, "button" | "ctrlKey">, platform: Platform = currentPlatform()): boolean {
  return e.button === 2 || (platform === "apple" && e.button === 0 && e.ctrlKey)
}

export function primaryClick(e: Pick<Click, "button" | "ctrlKey">, platform: Platform = currentPlatform()): boolean {
  return e.button === 0 && !opensContextMenu(e, platform)
}

export function addsToSelection(e: Pick<Click, "ctrlKey" | "metaKey" | "shiftKey">, platform: Platform = currentPlatform()): boolean {
  return e.shiftKey || (platform === "apple" ? e.metaKey : e.ctrlKey)
}

export function wheelZooms(e: Pick<WheelEvent, "ctrlKey" | "metaKey">, platform: Platform = currentPlatform()): boolean {
  return e.ctrlKey || (platform === "apple" && e.metaKey)
}
