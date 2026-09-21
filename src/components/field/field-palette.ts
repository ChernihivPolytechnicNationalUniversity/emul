import * as React from "react"
import type { Fill, PinKind } from "@/schematic/types"

export type Paint = { fill: string | null; stroke: string | null }

export type FieldPalette = {
  theme: string
  body: Record<Fill, Paint>
  pinMark: Record<PinKind, string>
  symbolStroke: string
  mutedStroke: string
  text: { plain: string; muted: string; inverse: string; mono: string; sans: string }
}

const TOKENS = [
  "--card",
  "--muted",
  "--foreground",
  "--secondary",
  "--border",
  "--muted-foreground",
  "--background",
  "--font-mono",
  "--font-sans",
  "--color-red-500",
  "--color-amber-500",
  "--color-neutral-700",
  "--color-neutral-300",
] as const

type Token = (typeof TOKENS)[number]

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
  const background = token("--background")
  const gnd = token(theme === "dark" ? "--color-neutral-300" : "--color-neutral-700")

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
      power: token("--color-red-500"),
      gnd,
      analog: token("--color-amber-500"),
      digital: withAlpha(foreground, 0.7),
      node: foreground,
      nc: withAlpha(mutedForeground, 0.4),
    },
    symbolStroke: foreground,
    mutedStroke: mutedForeground,
    text: {
      plain: foreground,
      muted: mutedForeground,
      inverse: background,
      mono: token("--font-mono"),
      sans: token("--font-sans"),
    },
  }
}

const readTheme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light")
const serverTheme = () => "light"

function watchTheme(listener: () => void) {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}

export function useThemeName() {
  return React.useSyncExternalStore(watchTheme, readTheme, serverTheme)
}
