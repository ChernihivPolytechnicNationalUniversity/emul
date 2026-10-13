import { srgbEncode } from "@/lib/srgb"

export const GLOW_OPACITY = 0.6
export const HALO_OPACITY = 0.4
const SMALLEST_VISIBLE_OPACITY = 0.5 / 255

export const glowOf = (level: number) => srgbEncode(Math.min(1, Math.max(0, level)))
export const visible = (opacity: number) => opacity >= SMALLEST_VISIBLE_OPACITY
