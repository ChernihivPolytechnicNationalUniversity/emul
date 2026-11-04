/** LED colours: CSS colour and typical forward voltage. */
export const LED_COLORS: Record<string, { css: string; vf: number; vr: number }> = {
  red: { css: "#ef4444", vf: 1.9, vr: 15 },
  green: { css: "#22c55e", vf: 2.1, vr: 15 },
  blue: { css: "#3b82f6", vf: 3.0, vr: 5 },
  yellow: { css: "#eab308", vf: 2.0, vr: 15 },
  white: { css: "#f5f5f5", vf: 3.0, vr: 5 },
}
