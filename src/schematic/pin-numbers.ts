import type { BodyShape, PinDef, Side } from "./types"

const BESIDE_STUB: Record<Side, [number, number]> = { left: [-0.5, -0.35], right: [0.5, -0.35], top: [0.35, -0.5], bottom: [0.35, 0.5] }

export const pinNumbers = (pins: readonly PinDef[]): BodyShape[] =>
  pins.flatMap((pin): BodyShape[] => {
    if (pin.connectorPin === undefined) return []
    const [dx, dy] = BESIDE_STUB[pin.side]
    const vertical = pin.side === "top" || pin.side === "bottom"
    return [{ type: "text", x: pin.x + dx, y: pin.y + dy, text: String(pin.connectorPin), size: 0.22, muted: true, anchor: vertical ? "start" : "middle" }]
  })
