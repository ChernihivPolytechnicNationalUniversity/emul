import * as React from "react"
import type { Fill, PinKind } from "@/schematic/types"

export type Paint = { fill: string | null; stroke: string | null }

/**
 * The field's colours as the canvas needs them: resolved once per theme from the page's own
 * computed style, so the OKLCH design tokens stay the single source and dark mode keeps working.
 * The DOM layers say the same things in Tailwind classes; these are those classes, read back.
 */
export type FieldPalette = {
  theme: string
  body: Record<Fill, Paint>
  pinMark: Record<PinKind, string>
  symbolStroke: string
  mutedStroke: string
}

const TOKENS = [
  "--card",
  "--muted",
  "--foreground",
  "--secondary",
  "--border",
  "--muted-foreground",
  "--background",
] as const

type Token = (typeof TOKENS)[number]

const NEUTRAL = { light: "oklch(0.37 0 0)", dark: "oklch(0.87 0 0)" }
const RED = "oklch(0.64 0.21 25)"
const AMBER = "oklch(0.77 0.16 70)"

function withAlpha(color: string, alpha: number) {
  return `color-mix(in oklch, ${color} ${Math.round(alpha * 100)}%, transparent)`
}

export function readFieldPalette(host: Element, theme: string): FieldPalette {
  const style = getComputedStyle(host)
  const token = (name: Token) => style.getPropertyValue(name).trim() || "black"
  const card = token("--card")
  const muted = token("--muted")
  const foreground = token("--foreground")
  const secondary = token("--secondary")
  const border = token("--border")
  const mutedForeground = token("--muted-foreground")
  const neutral = theme === "dark" ? NEUTRAL.dark : NEUTRAL.light

  return {
    theme,
    body: {
      board: { fill: card, stroke: border },
      zone: { fill: muted, stroke: border },
      chip: { fill: foreground, stroke: foreground },
      connector: { fill: secondary, stroke: border },
      foreground: { fill: foreground, stroke: foreground },
      none: { fill: null, stroke: border },
      grip: { fill: null, stroke: null },
    },
    pinMark: {
      power: RED,
      gnd: neutral,
      analog: AMBER,
      digital: withAlpha(foreground, 0.7),
      node: foreground,
      nc: withAlpha(mutedForeground, 0.4),
    },
    symbolStroke: foreground,
    mutedStroke: mutedForeground,
  }
}

const readTheme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light")
const serverTheme = () => "light"

function watchTheme(listener: () => void) {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}

/**
 * Dark mode is a class on `<html>` that nothing in React owns, so a render-time read would go
 * stale the moment it changed. Watching the attribute is what keeps the canvas in the right
 * palette however the class arrives.
 */
export function useThemeName() {
  return React.useSyncExternalStore(watchTheme, readTheme, serverTheme)
}
